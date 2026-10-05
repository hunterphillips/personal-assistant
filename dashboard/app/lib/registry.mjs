// Agent registry: loads and validates the JSON file naming the agents and
// project folders the daemon knows about, and polls it for changes so the
// state hub (hub.mjs) stays current without a restart.
// server.mjs starts it; this module only loads and validates.
//
// Schema (config.registryPath):
//
//   {
//     "version": 1,
//     "groups": [                     // optional, default []; the headings
//       { "id": "work", "name": "Work" } // agents are listed under, in this
//     ],                              // order; id /^[a-z][a-z0-9-]{1,31}$/
//                                    // unique, name non-empty <= 40 chars,
//                                    // at most 20; a group an agent names
//                                    // that is not listed still works
//     "agents": [
//       {
//         "id": "cfo",              // /^[a-z][a-z0-9-]{1,31}$/, unique
//         "name": "CFO",             // non-empty, <= 40 chars
//         "role": "Money",           // non-empty, <= 24 chars
//         "description": "...",      // non-empty, <= 300 chars
//         "group": "work",           // /^[a-z][a-z0-9-]{1,31}$/; the
//                                    // heading it sits under (see groups)
//         "kind": "persona",         // "persona" | "project" | "system"
//         "cwd": "/absolute/path",   // must exist and be a directory
//         "provider": "claude",      // "claude" | "codex"; required for
//                                    // persona/project, absent for system
//         "model": "sonnet",         // optional, non-empty, <= 64 chars;
//                                    // allowed for persona/project, a
//                                    // problem when given for system
//         "effort": "high",          // optional, one of models.mjs EFFORTS;
//                                    // a problem when given for system
//         "permission": "auto",      // optional, one of permissions.mjs
//                                    // PERMISSION_LEVELS (ask, auto, full):
//                                    // the level the agent's turns run
//                                    // at; absent means the settings
//                                    // default. A problem when given for
//                                    // system; accepted and ignored on a
//                                    // project or a Codex agent, as model is
//         "accepts": ["assistant"],  // optional, persona only: who may
//                                    // message it, as registry ids (at
//                                    // most 100, each an agent in this
//                                    // file, none itself, no duplicates);
//                                    // absent or null means everyone. Read
//                                    // by delegation (design phase 3);
//                                    // nothing enforces it yet
//         "jobs": ["com.hunter.cfo.daily"], // optional, default [];
//                                    // each /^[A-Za-z0-9][A-Za-z0-9.-]*$/,
//                                    // unique across the whole registry
//         "pinned": true,            // optional; a persona listed above
//                                    // the groups; a problem on other kinds
//         "avatar": "me.png",        // optional, any kind; non-empty, <=
//                                    // 1024 chars: the agent's picture, a
//                                    // path relative to cwd or absolute,
//                                    // in place of the avatar.* lookup in
//                                    // cwd (avatars.mjs). A path that
//                                    // does not resolve falls back to
//                                    // initials, never a problem
//         "builtin": true            // optional; a persona that is part of
//                                    // the dashboard itself: the daemon
//                                    // seeds it from registry/builtin.json
//                                    // when missing (builtins.mjs) and the
//                                    // dashboard never deletes it. A
//                                    // problem on other kinds. Named
//                                    // builtin because kind "system" is
//                                    // already a provider-less entry
//       }
//     ],
//     "...": "unknown top-level keys are ignored"
//   }
//
// Unknown keys on an agent entry are a problem; unknown keys anywhere else in
// the top-level object are ignored. At most 100 agent entries; more is a
// problem. Every validation failure is a problem string naming the agent's
// index (and id, when it has a valid one); all problems are collected and
// the whole file is rejected together.
//
// The registry path is operator-owned configuration, not user input: it is
// read with `stat`/`readFile`, which follow symlinks, and its content is
// still size-capped (256 KiB, checked both from `stat` and again from the
// bytes actually read) and strictly validated before any of it is trusted.
//
// The dashboard writes this file too (agent settings and new agents,
// agent-routes.mjs), through write() below; a hand edit is still fine, and
// unknown top-level keys survive a dashboard write.
//
// createRegistry({ path, pollMs = 5_000, log = () => {} }) returns:
//
//   current()
//     Object.freeze({ ok, agents, groups, error, loadedAt, path }). `agents`
//     is the last successfully loaded, frozen list (each agent object frozen
//     too) and `groups` the frozen group list loaded with it; neither
//     reverts to empty just because a later read failed. `ok` is
//     true only when the most recent read succeeded. `error` is null on
//     success, otherwise a one-line message (validation problems joined with
//     "; "). `loadedAt` is the ISO timestamp of the last successful load, or
//     null if there has never been one.
//
//   start()
//     Loads once immediately (the returned promise resolves once that first
//     load has landed in current()), then polls the file's mtime and size
//     every `pollMs` with an unref'd setInterval (never fs.watch: it
//     silently stops reporting a file replaced by rename, which is how this
//     file is expected to be written). Re-reads and validates only when the
//     file's seen signature changes: present files compare by {mtimeMs,
//     size}, and a missing file is its own signature, so a file that stays
//     missing does not re-trigger load() or onChange on every tick, while a
//     file that appears after being missing is picked up on the next poll.
//     A poll still in flight when the interval fires is not joined by a
//     second one; that tick is skipped. Calling start() again while already
//     started is a no-op that returns the original first-load promise.
//
//   stop()
//     Clears the polling interval.
//
//   onChange(fn)
//     Registers a listener called with the new current() value after every
//     load attempt, success or failure. Returns an unsubscribe function. A
//     listener that throws is caught and reported via
//     `log({ event: 'registry_listener_error', error })`; it does not stop
//     start() from resolving or the other listeners from running.
//
//   write(mutate) -> Promise<{ agents, groups }>
//     Rewrites the file through `mutate(document)`, which receives a copy of
//     the parsed file (or { version: 1, groups: [], agents: [] } when the
//     file is missing) and returns the new document. Single-flight: a
//     second write waits for the first. Refuses RegistryError
//     'registry_invalid' (problems: [current().error]) while the file on
//     disk does not load, except when it is missing: a hand-broken file is
//     fixed by hand, never overwritten by a save merged over the last good
//     copy; a missing file is created by a mutation whose result is a valid
//     non-empty registry. Invalid JSON on disk refuses
//     'registry_invalid_json'. The candidate is validated whole; a failure
//     rejects RegistryError 'invalid_registry' with the problem list and
//     writes nothing. The candidate itself (not the validator's normalized
//     output) is written as 2-space JSON to a temporary file beside the
//     target with the target's mode (0644 for a new file), renamed over it,
//     and loaded at once, so current() and listeners update before the
//     promise resolves and the next poll does not load it a second time.
//     Resolves with the loaded { agents, groups }.
//
// validateDocument(parsed, { isDirectory } = {}) -> { ok, agents, groups, problems, error }
//   The validation load() applies, for a caller that holds a parsed
//   document (the writer, and test fakes); `isDirectory(path)` replaces the
//   file system check on cwd, so a fake registry can validate invented
//   folders while the real one keeps the rule.
//
// RegistryError: code ('registry_invalid', 'registry_invalid_json',
//   'invalid_registry') and problems (strings).
//
// Failure behavior: a missing file, an unreadable file, invalid JSON,
// validation problems, or a file over the 256 KiB size cap all keep the last
// good agents, set ok: false and error to a one-line message, and call
// onChange. `log({ event: 'registry_error', error })` fires once per
// distinct error message, not on every poll that repeats it. A missing file
// on the very first load reports ok: false, agents: [], error:
// 'registry_missing'.

import { statSync } from 'node:fs';
import { open, readFile, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

import { isEffort } from './models.mjs';
import { isPermission } from './permissions.mjs';

const MAX_BYTES = 256 * 1024;
const MAX_AGENTS = 100;
const ID = /^[a-z][a-z0-9-]{1,31}$/;
export { ID as AGENT_ID };
const ROUTINE_LABEL = /^[A-Za-z0-9][A-Za-z0-9.-]*$/;
const MAX_GROUPS = 20;
const KINDS = new Set(['persona', 'project', 'system']);
const PROVIDERS = new Set(['claude', 'codex']);
const MAX_ACCEPTS = 100;
const AVATAR_MAX = 1024;
const AGENT_KEYS = new Set([
  'id', 'name', 'role', 'description', 'group', 'kind', 'cwd', 'provider', 'model', 'effort', 'permission', 'accepts', 'jobs', 'pinned', 'avatar', 'builtin',
]);
const GROUP_KEYS = new Set(['id', 'name']);
const EMPTY_DOCUMENT = Object.freeze({ version: 1, groups: [], agents: [] });

export class RegistryError extends Error {
  constructor(code, problems = []) {
    super(problems.length > 0 ? `${code}: ${problems.join('; ')}` : code);
    this.name = 'RegistryError';
    this.code = code;
    this.problems = problems;
  }
}

export function createRegistry({ path: registryPath, pollMs = 5_000, log = () => {} }) {
  let state = freezeState({ ok: false, agents: [], groups: [], error: null, loadedAt: null, path: registryPath });
  let lastErrorLogged = null;
  let lastSeen = null; // { mtimeMs, size } or { missing: true }, at the last read attempt
  let timer = null;
  let firstLoad = null;
  let inFlight = null;
  let writing = Promise.resolve();
  const listeners = new Set();

  async function load() {
    const result = await readAndValidate(registryPath);
    if (result.ok) {
      state = freezeState({
        ok: true,
        agents: result.agents,
        groups: result.groups,
        error: null,
        loadedAt: new Date().toISOString(),
        path: registryPath,
      });
    } else {
      state = freezeState({
        ok: false,
        agents: state.agents,
        groups: state.groups,
        error: result.error,
        loadedAt: state.loadedAt,
        path: registryPath,
      });
      if (result.error !== lastErrorLogged) {
        log({ event: 'registry_error', error: result.error });
        lastErrorLogged = result.error;
      }
    }
    for (const listener of listeners) {
      try {
        listener(state);
      } catch (error) {
        log({ event: 'registry_listener_error', error: error?.message ?? String(error) });
      }
    }
  }

  // Re-reads only when the file's seen signature has changed since the last
  // check: {mtimeMs, size} for a file that stat succeeds on, or {missing:
  // true} when it doesn't. A file that stays missing keeps the same
  // signature across polls, so it triggers load() (and thus onChange) once,
  // not on every tick; a file that later appears has a different signature
  // and is picked up on the next poll.
  async function pollOnce() {
    let seen;
    try {
      const stats = await stat(registryPath);
      seen = { mtimeMs: stats.mtimeMs, size: stats.size };
    } catch {
      seen = { missing: true };
    }
    if (seenEqual(lastSeen, seen)) return;
    lastSeen = seen;
    await load();
  }

  // One write: read, mutate, validate, replace, load. See the header.
  async function writeOnce(mutate) {
    if (!state.ok && state.error !== 'registry_missing') throw new RegistryError('registry_invalid', [state.error]);
    let raw = null;
    let mode = 0o644;
    try {
      const stats = await stat(registryPath);
      mode = stats.mode & 0o777;
      raw = await readFile(registryPath, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    let document;
    if (raw === null) {
      document = structuredClone(EMPTY_DOCUMENT);
    } else {
      try {
        document = JSON.parse(raw);
      } catch {
        throw new RegistryError('registry_invalid_json');
      }
    }
    const candidate = mutate(document);
    const result = validateDocument(candidate);
    if (!result.ok) throw new RegistryError('invalid_registry', result.problems);

    const dir = path.dirname(registryPath);
    const tmp = path.join(dir, `.${path.basename(registryPath)}.${randomBytes(6).toString('hex')}.tmp`);
    const handle = await open(tmp, 'wx', mode);
    try {
      await handle.writeFile(`${JSON.stringify(candidate, null, 2)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(tmp, registryPath);
    } catch (error) {
      await unlink(tmp).catch(() => {});
      throw error;
    }
    try {
      const stats = await stat(registryPath);
      lastSeen = { mtimeMs: stats.mtimeMs, size: stats.size };
    } catch {
      lastSeen = { missing: true };
    }
    await load();
    return { agents: state.agents, groups: state.groups };
  }

  return {
    current() {
      return state;
    },
    write(mutate) {
      const run = writing.then(() => writeOnce(mutate));
      writing = run.then(() => {}, () => {});
      return run;
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

function seenEqual(a, b) {
  if (!a || !b) return false;
  if (a.missing || b.missing) return Boolean(a.missing) === Boolean(b.missing);
  return a.mtimeMs === b.mtimeMs && a.size === b.size;
}

async function readAndValidate(registryPath) {
  let stats;
  try {
    stats = await stat(registryPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: false, error: 'registry_missing' };
    return { ok: false, error: `registry_unreadable: ${error?.code ?? error?.message ?? 'unknown'}` };
  }
  if (!stats.isFile()) return { ok: false, error: 'registry_missing' };
  if (stats.size > MAX_BYTES) return { ok: false, error: 'registry_oversized' };

  let raw;
  try {
    raw = await readFile(registryPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: false, error: 'registry_missing' };
    return { ok: false, error: `registry_unreadable: ${error?.code ?? error?.message ?? 'unknown'}` };
  }
  if (Buffer.byteLength(raw) > MAX_BYTES) return { ok: false, error: 'registry_oversized' };

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'registry_invalid_json' };
  }
  const result = validateDocument(parsed);
  return result.ok ? { ok: true, agents: result.agents, groups: result.groups } : { ok: false, error: result.error };
}

export function validateDocument(parsed, { isDirectory: checkDirectory = isDirectory } = {}) {
  const problems = [];
  const groups = validateGroups(parsed, problems);
  const agents = validateRegistry(parsed, problems, checkDirectory);
  if (problems.length > 0) return { ok: false, agents: [], groups: [], problems, error: problems.join('; ') };
  return { ok: true, agents, groups, problems: [], error: null };
}

// The optional top-level "groups" list. Missing means []; anything else
// must be an array of { id, name } with unique ids.
function validateGroups(value, problems) {
  if (!isRecord(value) || value.groups === undefined) return [];
  if (!Array.isArray(value.groups)) {
    problems.push('registry: groups must be an array');
    return [];
  }
  if (value.groups.length > MAX_GROUPS) {
    problems.push(`registry: groups must have at most ${MAX_GROUPS} entries`);
    return [];
  }
  const ids = new Map();
  const groups = [];
  value.groups.forEach((entry, index) => {
    const fail = (message) => problems.push(`group ${index}: ${message}`);
    if (!isRecord(entry)) {
      fail('must be an object');
      return;
    }
    let ok = true;
    for (const key of Object.keys(entry)) {
      if (!GROUP_KEYS.has(key)) {
        fail(`unknown key "${key}"`);
        ok = false;
      }
    }
    if (typeof entry.id !== 'string' || !ID.test(entry.id)) {
      fail('id must match /^[a-z][a-z0-9-]{1,31}$/');
      ok = false;
    } else if (ids.has(entry.id)) {
      fail(`id duplicates group ${ids.get(entry.id)}`);
      ok = false;
    } else {
      ids.set(entry.id, index);
    }
    if (typeof entry.name !== 'string' || entry.name.length === 0 || entry.name.length > 40) {
      fail('name must be a non-empty string of at most 40 characters');
      ok = false;
    }
    if (ok) groups.push(Object.freeze({ id: entry.id, name: entry.name }));
  });
  return groups;
}

function validateRegistry(value, problems, checkDirectory) {
  if (!isRecord(value)) {
    problems.push('registry: must be a JSON object');
    return [];
  }
  if (value.version !== 1) {
    problems.push('registry: version must be 1');
  }
  if (!Array.isArray(value.agents) || value.agents.length === 0) {
    problems.push('registry: agents must be a non-empty array');
    return [];
  }
  if (value.agents.length > MAX_AGENTS) {
    problems.push(`registry: agents must have at most ${MAX_AGENTS} entries`);
    return [];
  }

  const ids = new Map(); // id -> index of first agent that claimed it
  const jobLabels = new Map(); // label -> "agent <index> (<id>)" that first claimed it
  const agents = [];
  const entries = [];
  value.agents.forEach((entry, index) => {
    const agent = validateAgent(entry, index, problems, checkDirectory);
    if (!agent) return;
    entries.push([agent, index]);

    if (ids.has(agent.id)) {
      problems.push(`agent ${index} (${agent.id}): id duplicates agent ${ids.get(agent.id)}`);
    } else {
      ids.set(agent.id, index);
    }
    for (const jobLabel of agent.jobs) {
      if (jobLabels.has(jobLabel)) {
        problems.push(`agent ${index} (${agent.id}): job "${jobLabel}" already used by ${jobLabels.get(jobLabel)}`);
      } else {
        jobLabels.set(jobLabel, `agent ${index} (${agent.id})`);
      }
    }
    agents.push(agent);
  });

  // `accepts` names agents in this same file, never the agent itself.
  for (const [agent, index] of entries) {
    if (!agent.accepts) continue;
    for (const id of agent.accepts) {
      if (id === agent.id) problems.push(`agent ${index} (${agent.id}): accepts must not name the agent itself`);
      else if (!ids.has(id)) problems.push(`agent ${index} (${agent.id}): accepts names no agent "${id}"`);
    }
  }

  return agents.map((agent) => Object.freeze({
    ...agent,
    jobs: Object.freeze([...agent.jobs]),
    ...(agent.accepts ? { accepts: Object.freeze([...agent.accepts]) } : {}),
  }));
}

function validateAgent(entry, index, problems, checkDirectory = isDirectory) {
  if (!isRecord(entry)) {
    problems.push(`agent ${index}: must be an object`);
    return null;
  }

  const idLabel = typeof entry.id === 'string' && ID.test(entry.id) ? `${index} (${entry.id})` : `${index}`;
  let ok = true;
  const fail = (message) => {
    problems.push(`agent ${idLabel}: ${message}`);
    ok = false;
  };

  for (const key of Object.keys(entry)) {
    if (!AGENT_KEYS.has(key)) fail(`unknown key "${key}"`);
  }
  if (typeof entry.id !== 'string' || !ID.test(entry.id)) {
    fail('id must match /^[a-z][a-z0-9-]{1,31}$/');
  }
  if (typeof entry.name !== 'string' || entry.name.length === 0 || entry.name.length > 40) {
    fail('name must be a non-empty string of at most 40 characters');
  }
  if (typeof entry.role !== 'string' || entry.role.length === 0 || entry.role.length > 24) {
    fail('role must be a non-empty string of at most 24 characters');
  }
  if (typeof entry.description !== 'string' || entry.description.length === 0 || entry.description.length > 300) {
    fail('description must be a non-empty string of at most 300 characters');
  }
  if (typeof entry.group !== 'string' || !ID.test(entry.group)) {
    fail('group must match /^[a-z][a-z0-9-]{1,31}$/');
  }
  if (!KINDS.has(entry.kind)) {
    fail('kind must be "persona", "project", or "system"');
  }
  if (typeof entry.cwd !== 'string' || !path.isAbsolute(entry.cwd)) {
    fail('cwd must be an absolute path');
  } else if (!checkDirectory(entry.cwd)) {
    fail('cwd must exist and be a directory');
  }

  if (entry.kind === 'system') {
    if (entry.provider !== undefined) fail('provider must be absent when kind is "system"');
  } else if (KINDS.has(entry.kind)) {
    if (!PROVIDERS.has(entry.provider)) fail('provider must be "claude" or "codex"');
  }

  if (entry.model !== undefined) {
    if (entry.kind === 'system') {
      fail('model must be absent when kind is "system"');
    } else if (typeof entry.model !== 'string' || entry.model.length === 0 || entry.model.length > 64) {
      fail('model must be a non-empty string of at most 64 characters');
    }
  }

  if (entry.effort !== undefined) {
    if (entry.kind === 'system') {
      fail('effort must be absent when kind is "system"');
    } else if (!isEffort(entry.effort)) {
      fail('effort must be one of low, medium, high, xhigh, max');
    }
  }

  if (entry.permission !== undefined) {
    if (entry.kind === 'system') {
      fail('permission must be absent when kind is "system"');
    } else if (!isPermission(entry.permission)) {
      fail('permission must be one of ask, auto, full');
    }
  }

  let accepts = null;
  if (entry.accepts !== undefined && entry.accepts !== null) {
    if (entry.kind !== 'persona') {
      fail('accepts is only for a persona');
    } else if (!Array.isArray(entry.accepts) || !entry.accepts.every((id) => typeof id === 'string' && ID.test(id))) {
      fail('accepts must be an array of agent ids');
    } else if (entry.accepts.length > MAX_ACCEPTS) {
      fail(`accepts must have at most ${MAX_ACCEPTS} entries`);
    } else if (new Set(entry.accepts).size !== entry.accepts.length) {
      fail('accepts must not repeat an id');
    } else {
      accepts = [...entry.accepts];
    }
  }

  if (entry.pinned !== undefined) {
    if (typeof entry.pinned !== 'boolean') {
      fail('pinned must be true or false');
    } else if (entry.pinned && entry.kind !== 'persona') {
      fail('pinned is only for a persona');
    }
  }

  if (entry.avatar !== undefined) {
    if (typeof entry.avatar !== 'string' || entry.avatar.length === 0 || entry.avatar.length > AVATAR_MAX) {
      fail(`avatar must be a non-empty string of at most ${AVATAR_MAX} characters`);
    }
  }

  if (entry.builtin !== undefined) {
    if (typeof entry.builtin !== 'boolean') {
      fail('builtin must be true or false');
    } else if (entry.builtin && entry.kind !== 'persona') {
      fail('builtin is only for a persona');
    }
  }

  let jobs = [];
  if (entry.jobs !== undefined) {
    const isValidJobs = Array.isArray(entry.jobs) &&
      entry.jobs.every((item) => typeof item === 'string' && ROUTINE_LABEL.test(item));
    if (!isValidJobs) {
      fail('jobs must be an array of strings matching /^[A-Za-z0-9][A-Za-z0-9.-]*$/');
    } else {
      jobs = entry.jobs;
    }
  }

  if (!ok) return null;
  return {
    id: entry.id,
    name: entry.name,
    role: entry.role,
    description: entry.description,
    group: entry.group,
    kind: entry.kind,
    cwd: entry.cwd,
    ...(entry.kind === 'system' ? {} : { provider: entry.provider }),
    ...(entry.model !== undefined ? { model: entry.model } : {}),
    ...(entry.effort !== undefined ? { effort: entry.effort } : {}),
    ...(entry.permission !== undefined ? { permission: entry.permission } : {}),
    ...(accepts ? { accepts } : {}),
    ...(entry.pinned === true ? { pinned: true } : {}),
    ...(entry.avatar !== undefined ? { avatar: entry.avatar } : {}),
    ...(entry.builtin === true ? { builtin: true } : {}),
    jobs,
  };
}

function isDirectory(target) {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function freezeState(state) {
  return Object.freeze({ ...state, agents: Object.freeze([...state.agents]), groups: Object.freeze([...(state.groups ?? [])]) });
}
