// Agent registry: loads and validates the JSON file naming the domain
// personas and project folders the daemon knows about, and polls it for
// changes so a later `app.mjs` can keep the state hub current without a
// restart. This module only loads and validates; wiring into the server and
// the state hub is a later task.
//
// Schema (config.registryPath):
//
//   {
//     "version": 1,
//     "agents": [
//       {
//         "id": "cfo",              // /^[a-z][a-z0-9-]{1,31}$/, unique
//         "name": "CFO",             // non-empty, <= 40 chars
//         "role": "Money",           // non-empty, <= 24 chars
//         "description": "...",      // non-empty, <= 300 chars
//         "group": "work",           // "work" | "personal"
//         "kind": "persona",         // "persona" | "project" | "system"
//         "cwd": "/absolute/path",   // must exist and be a directory
//         "provider": "claude",      // "claude" | "codex"; required for
//                                    // persona/project, absent for system
//         "routines": ["com.hunter.cfo.daily"] // optional, default [];
//                                    // each /^[A-Za-z0-9.-]+$/, unique
//                                    // across the whole registry
//       }
//     ]
//   }
//
// Unknown keys on an agent entry are a problem. Every validation failure is
// a problem string naming the agent's index (and id, when it has a valid
// one); all problems are collected and the whole file is rejected together.
//
// createRegistry({ path, pollMs = 5_000, log = () => {} }) returns:
//
//   current()
//     Object.freeze({ ok, agents, error, loadedAt, path }). `agents` is the
//     last successfully loaded, frozen list (each agent object frozen too);
//     it never reverts to empty just because a later read failed. `ok` is
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
//     file is expected to be written). Re-reads and validates only when
//     mtime or size changed since the last check.
//
//   stop()
//     Clears the polling interval.
//
//   onChange(fn)
//     Registers a listener called with the new current() value after every
//     load attempt, success or failure. Returns an unsubscribe function.
//
// Failure behavior: a missing file, an unreadable file, invalid JSON,
// validation problems, or a file over the 256 KiB size cap all keep the last
// good agents, set ok: false and error to a one-line message, and call
// onChange. `log({ event: 'registry_error', error })` fires once per
// distinct error message, not on every poll that repeats it. A missing file
// on the very first load reports ok: false, agents: [], error:
// 'registry_missing'.

import { statSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const MAX_BYTES = 256 * 1024;
const ID = /^[a-z][a-z0-9-]{1,31}$/;
const ROUTINE_LABEL = /^[A-Za-z0-9.-]+$/;
const GROUPS = new Set(['work', 'personal']);
const KINDS = new Set(['persona', 'project', 'system']);
const PROVIDERS = new Set(['claude', 'codex']);
const AGENT_KEYS = new Set([
  'id', 'name', 'role', 'description', 'group', 'kind', 'cwd', 'provider', 'routines',
]);

export function createRegistry({ path: registryPath, pollMs = 5_000, log = () => {} }) {
  let state = freezeState({ ok: false, agents: [], error: null, loadedAt: null, path: registryPath });
  let lastErrorLogged = null;
  let lastSeen = null; // { mtimeMs, size } of the file at the last read attempt
  let timer = null;
  const listeners = new Set();

  async function load() {
    const result = await readAndValidate(registryPath);
    if (result.ok) {
      state = freezeState({
        ok: true,
        agents: result.agents,
        error: null,
        loadedAt: new Date().toISOString(),
        path: registryPath,
      });
    } else {
      state = freezeState({
        ok: false,
        agents: state.agents,
        error: result.error,
        loadedAt: state.loadedAt,
        path: registryPath,
      });
      if (result.error !== lastErrorLogged) {
        log({ event: 'registry_error', error: result.error });
        lastErrorLogged = result.error;
      }
    }
    for (const listener of listeners) listener(state);
  }

  // Re-reads only when the file's mtime or size has changed since the last
  // check. A stat failure (including a file that has gone missing) is
  // treated as a change so the failure surfaces through load() -> current().
  async function pollOnce() {
    let stats;
    try {
      stats = await stat(registryPath);
    } catch {
      lastSeen = null;
      await load();
      return;
    }
    const seen = { mtimeMs: stats.mtimeMs, size: stats.size };
    if (lastSeen && lastSeen.mtimeMs === seen.mtimeMs && lastSeen.size === seen.size) return;
    lastSeen = seen;
    await load();
  }

  return {
    current() {
      return state;
    },
    async start() {
      await pollOnce();
      timer = setInterval(() => {
        pollOnce().catch(() => {});
      }, pollMs);
      timer.unref();
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

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'registry_invalid_json' };
  }

  const problems = [];
  const agents = validateRegistry(parsed, problems);
  if (problems.length > 0) return { ok: false, error: problems.join('; ') };
  return { ok: true, agents };
}

function validateRegistry(value, problems) {
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

  const ids = new Map(); // id -> index of first agent that claimed it
  const routineLabels = new Map(); // label -> "agent <index> (<id>)" that first claimed it
  const agents = [];
  value.agents.forEach((entry, index) => {
    const agent = validateAgent(entry, index, problems);
    if (!agent) return;

    if (ids.has(agent.id)) {
      problems.push(`agent ${index} (${agent.id}): id duplicates agent ${ids.get(agent.id)}`);
    } else {
      ids.set(agent.id, index);
    }
    for (const routineLabel of agent.routines) {
      if (routineLabels.has(routineLabel)) {
        problems.push(`agent ${index} (${agent.id}): routine "${routineLabel}" already used by ${routineLabels.get(routineLabel)}`);
      } else {
        routineLabels.set(routineLabel, `agent ${index} (${agent.id})`);
      }
    }
    agents.push(agent);
  });

  return agents.map((agent) => Object.freeze({ ...agent, routines: Object.freeze([...agent.routines]) }));
}

function validateAgent(entry, index, problems) {
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
  if (!GROUPS.has(entry.group)) {
    fail('group must be "work" or "personal"');
  }
  if (!KINDS.has(entry.kind)) {
    fail('kind must be "persona", "project", or "system"');
  }
  if (typeof entry.cwd !== 'string' || !path.isAbsolute(entry.cwd)) {
    fail('cwd must be an absolute path');
  } else if (!isDirectory(entry.cwd)) {
    fail('cwd must exist and be a directory');
  }

  if (entry.kind === 'system') {
    if (entry.provider !== undefined) fail('provider must be absent when kind is "system"');
  } else if (KINDS.has(entry.kind)) {
    if (!PROVIDERS.has(entry.provider)) fail('provider must be "claude" or "codex"');
  }

  let routines = [];
  if (entry.routines !== undefined) {
    const isValidRoutines = Array.isArray(entry.routines) &&
      entry.routines.every((item) => typeof item === 'string' && ROUTINE_LABEL.test(item));
    if (!isValidRoutines) {
      fail('routines must be an array of strings matching /^[A-Za-z0-9.-]+$/');
    } else {
      routines = entry.routines;
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
    routines,
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
  return Object.freeze({ ...state, agents: Object.freeze([...state.agents]) });
}
