// Terminal bindings: which cmux workspace and surface a Codex thread was
// started in. bin/codex-new appends one record per thread it creates; the
// daemon reads the file so the Agents view can offer "Open terminal" for
// exactly that thread. Nothing else can tell two same-folder sessions apart.
//
// File (config.codexDir/bindings.json): a JSON array, newest first, capped
// at MAX_BINDINGS records of
//
//   { "threadId": "...", "cwd": "/absolute/path",
//     "workspaceId": "..." | null, "surfaceId": "..." | null,
//     "createdAt": "<ISO>" }
//
// appendBinding(file, binding) -> Promise<void>
//   Reads the file (a missing or unreadable one counts as empty), puts the
//   new record first, drops the oldest past the cap, creates the directory
//   (0700) if needed, and writes the whole file atomically (threads.mjs
//   atomicWrite, mode 0600). Rejects with a TypeError for a malformed
//   binding. Writers take turns through `bindings.lock` beside the file
//   (claimPidFile below): a second writer waits LOCK_RETRY_MS at a time
//   for up to LOCK_WAIT_MS, then rejects with code bindings_locked. A lock
//   left by a dead process is taken over.
//
// findBinding(file, threadId) -> Promise<record | null>
//   The record for that thread as the file holds it, or null.
//
// claimPidFile(file, content) -> Promise<{ claimed: true } |
//                                        { claimed: false, holder }>
//   Creates `file` exclusively (mode 0600) with `content`, a JSON object
//   carrying the caller's `pid`. When the file exists and its pid is
//   alive, answers the holder's parsed content. When its pid is dead, or
//   it holds no pid and is older than STALE_MS, the file is moved aside
//   and removed and the claim is retried, so two claimants racing over a
//   stale file cannot both win: only the one whose rename succeeded goes
//   on to create. Used for bindings.lock here and for bin/codex-new's
//   per-folder wait marker.
//
// createBindings({ path, pollMs, log }) -> { current, start, stop, onChange }
//   current() -> Map<threadId, { workspaceId, surfaceId }>, frozen values;
//   the last good read. start() loads once and then polls the file's mtime
//   and size every pollMs (unref'd; the file is replaced by rename, which
//   fs.watch misses), re-reading only when the signature changes; a
//   missing file is an empty map. stop() ends the poll. onChange(fn) runs
//   fn(current()) after every re-read; a throwing listener is logged as
//   bindings_listener_error. A file that cannot be parsed keeps the last
//   good map and is logged once per distinct error as bindings_error.

import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { atomicWrite } from './threads.mjs';

export const MAX_BINDINGS = 200;
const MAX_BYTES = 256 * 1024;
const THREAD_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SURFACE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const LOCK_RETRY_MS = 20;
const LOCK_WAIT_MS = 5_000;
const STALE_MS = 10_000; // a pid-less claim file older than this is abandoned

export async function appendBinding(file, binding) {
  const record = normalize(binding);
  if (!record) throw new TypeError('invalid binding');
  const dir = path.dirname(file);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const lock = path.join(dir, 'bindings.lock');
  await acquireLock(lock);
  try {
    const existing = (await readBindings(file)).records.filter((item) => item.threadId !== record.threadId);
    const records = [record, ...existing].slice(0, MAX_BINDINGS);
    await atomicWrite(dir, path.basename(file), `${JSON.stringify(records, null, 2)}\n`);
  } finally {
    await rm(lock, { force: true });
  }
}

export async function findBinding(file, threadId) {
  const { records } = await readBindings(file);
  return records.find((record) => record.threadId === threadId) ?? null;
}

export async function claimPidFile(file, content) {
  for (;;) {
    try {
      await writeFile(file, content, { flag: 'wx', mode: 0o600 });
      return { claimed: true };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    const holder = await readClaim(file);
    if (holder === null) continue; // gone between the two calls
    if (holder.alive) return { claimed: false, holder: holder.content };
    // Move the stale file aside before removing it: only the claimant whose
    // rename succeeds proceeds; the other sees ENOENT and claims afresh.
    const aside = `${file}.stale.${process.pid}.${randomBytes(6).toString('hex')}`;
    try {
      await rename(file, aside);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      continue;
    }
    await rm(aside, { force: true });
  }
}

// { alive, content } for a claim file, or null when it is missing. `alive`
// is true while the pid it names is running (or cannot be signalled), and
// for a pid-less file younger than STALE_MS.
async function readClaim(file) {
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  let content = null;
  try {
    content = JSON.parse(raw);
  } catch {
    content = null;
  }
  const pid = isRecord(content) ? content.pid : null;
  if (Number.isInteger(pid) && pid > 0) return { alive: pidAlive(pid), content };
  let age = 0;
  try {
    age = Date.now() - (await stat(file)).mtimeMs;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  return { alive: age < STALE_MS, content };
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function acquireLock(lock) {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    const claim = await claimPidFile(lock, `${JSON.stringify({ pid: process.pid })}\n`);
    if (claim.claimed) return;
    if (Date.now() >= deadline) {
      const error = new Error(`bindings.lock is held by pid ${claim.holder?.pid ?? 'unknown'}: ${lock}`);
      error.code = 'bindings_locked';
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
  }
}

export function createBindings({ path: file, pollMs = 3_000, log = () => {} }) {
  let current = new Map();
  let lastSeen = null;
  let lastErrorLogged = null;
  let timer = null;
  let firstLoad = null;
  let inFlight = null;
  const listeners = new Set();

  async function load() {
    const result = await readBindings(file);
    if (result.error) {
      if (result.error !== lastErrorLogged) {
        log({ event: 'bindings_error', error: result.error });
        lastErrorLogged = result.error;
      }
    } else {
      lastErrorLogged = null;
      current = new Map(result.records.map((record) => [
        record.threadId, Object.freeze({ workspaceId: record.workspaceId, surfaceId: record.surfaceId }),
      ]));
    }
    for (const listener of listeners) {
      try {
        listener(current);
      } catch (error) {
        log({ event: 'bindings_listener_error', error: error?.message ?? String(error) });
      }
    }
  }

  async function pollOnce() {
    let seen;
    try {
      const stats = await stat(file);
      seen = { mtimeMs: stats.mtimeMs, size: stats.size };
    } catch {
      seen = { missing: true };
    }
    if (sameSignature(lastSeen, seen)) return;
    lastSeen = seen;
    await load();
  }

  return {
    current() {
      return current;
    },
    async start() {
      if (timer) return firstLoad;
      firstLoad = pollOnce();
      await firstLoad;
      timer = setInterval(() => {
        if (inFlight) return;
        inFlight = pollOnce().finally(() => {
          inFlight = null;
        });
      }, pollMs);
      timer.unref();
      return firstLoad;
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

// { records } from the file, or { records: [], error } when it cannot be
// used; a missing file is simply empty.
async function readBindings(file) {
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { records: [] };
    return { records: [], error: `bindings_unreadable: ${error?.code ?? 'unknown'}` };
  }
  if (Buffer.byteLength(raw, 'utf8') > MAX_BYTES) return { records: [], error: 'bindings_oversized' };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { records: [], error: 'bindings_invalid_json' };
  }
  if (!Array.isArray(parsed)) return { records: [], error: 'bindings_not_an_array' };
  const records = [];
  const seen = new Set();
  for (const item of parsed) {
    const record = normalize(item);
    if (record && !seen.has(record.threadId)) {
      seen.add(record.threadId);
      records.push(record);
    }
  }
  return { records: records.slice(0, MAX_BINDINGS) };
}

function normalize(value) {
  if (!isRecord(value) || typeof value.threadId !== 'string' || !THREAD_ID.test(value.threadId)) return null;
  if (typeof value.cwd !== 'string' || !value.cwd.startsWith('/')) return null;
  if (!isSurfaceId(value.workspaceId) || !isSurfaceId(value.surfaceId)) return null;
  if (typeof value.createdAt !== 'string') return null;
  return {
    threadId: value.threadId,
    cwd: value.cwd,
    workspaceId: value.workspaceId ?? null,
    surfaceId: value.surfaceId ?? null,
    createdAt: value.createdAt,
  };
}

function isSurfaceId(value) {
  return value === null || value === undefined || (typeof value === 'string' && SURFACE.test(value));
}

function sameSignature(a, b) {
  if (!a || !b) return false;
  if (a.missing || b.missing) return Boolean(a.missing) === Boolean(b.missing);
  return a.mtimeMs === b.mtimeMs && a.size === b.size;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
