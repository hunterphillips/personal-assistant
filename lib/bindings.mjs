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
//   binding.
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

import { mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { atomicWrite } from './threads.mjs';

export const MAX_BINDINGS = 200;
const MAX_BYTES = 256 * 1024;
const THREAD_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SURFACE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export async function appendBinding(file, binding) {
  const record = normalize(binding);
  if (!record) throw new TypeError('invalid binding');
  const existing = (await readBindings(file)).records.filter((item) => item.threadId !== record.threadId);
  const records = [record, ...existing].slice(0, MAX_BINDINGS);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await atomicWrite(path.dirname(file), path.basename(file), `${JSON.stringify(records, null, 2)}\n`);
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
