// Settings: the one small file the daemon owns for what the interface sets
// system-wide (config.settingsPath, default var/settings.json). Version 1:
//
//   { "version": 1,
//     "model": { "default": null, "effort": null },
//     "brief": { "agent": "assistant" } }
//
// `model.default` is a model id or alias (models.mjs) or null, and
// `model.effort` one of EFFORTS or null; null means Claude Code's own
// default, so the adapter passes nothing and a turn resolves as it did
// before this file existed. `brief.agent` is the registry id of the agent
// whose thread receives the morning brief notice (notices.mjs), or null for
// no one. No agent id appears in code: seeding at first start picks the
// first pinned Claude persona (server.mjs).
//
// createSettings({ path, log, now }) returns:
//
//   current() -> frozen { ok, settings, error, loadedAt, path }
//     `settings` is the last good document (DEFAULTS before any load, and
//     for a missing file, which is not an error: the file is created on
//     the first update). Invalid JSON, a wrong version, an unknown key, a
//     bad value, or a file over 64 KiB make ok false, keep the last good
//     settings, and log settings_error once per distinct message.
//   load() -> Promise<void>
//     Reads the file once. The server calls it at start; there is no
//     polling, since the daemon is the file's only writer.
//   update(patch) -> Promise<settings>
//     `patch` is a partial { model?: { default?, effort? }, brief?: {
//     agent? } }. Merged over current().settings, validated whole, written
//     atomically (a temporary file beside it with mode 0600, then rename;
//     the directory is created 0700), then current() changes and listeners
//     run. Rejects with SettingsError whose code is invalid_body (not an
//     object, unknown or empty keys), invalid_model, invalid_effort,
//     invalid_agent, or settings_invalid when current().ok is false: a file
//     broken by hand is repaired or deleted by its owner, never overwritten
//     by a save that would merge over the last good copy and erase the edit.
//     Whether brief.agent names a real persona is the route's check
//     (settings-routes.mjs), which has the registry.
//   seed(values) -> Promise<boolean>
//     Writes DEFAULTS merged with `values` only when the file is missing
//     and answers whether it wrote. A present file, valid or not, is left
//     alone.
//   onChange(fn) -> unsubscribe
//     fn(current()) after every successful update or seed.
//
// validatePatch(patch) -> code | null
//   The shape and value checks update() applies, for a route that wants to
//   refuse before touching the store.

import { mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

import { isEffort } from './models.mjs';
import { AGENT_ID } from './registry.mjs';

const MAX_BYTES = 64 * 1024;
const MODEL_MAX = 64;
const TOP_KEYS = new Set(['version', 'model', 'brief']);
const MODEL_KEYS = new Set(['default', 'effort']);
const BRIEF_KEYS = new Set(['agent']);

export const DEFAULTS = Object.freeze({
  version: 1,
  model: Object.freeze({ default: null, effort: null }),
  brief: Object.freeze({ agent: null }),
});

export class SettingsError extends Error {
  constructor(code, detail = null) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'SettingsError';
    this.code = code;
  }
}

export function createSettings({ path: file, log = () => {}, now = () => new Date() }) {
  const settingsPath = path.resolve(file);
  const listeners = new Set();
  let state = freeze({ ok: true, settings: DEFAULTS, error: null, loadedAt: null, path: settingsPath });
  let lastErrorLogged = null;
  let writing = null;

  function fail(error) {
    state = freeze({ ...state, ok: false, error });
    if (error !== lastErrorLogged) {
      log({ event: 'settings_error', error });
      lastErrorLogged = error;
    }
  }

  function settle(settings) {
    state = freeze({ ok: true, settings, error: null, loadedAt: now().toISOString(), path: settingsPath });
    lastErrorLogged = null;
  }

  function notify() {
    for (const fn of [...listeners]) {
      try {
        fn(state);
      } catch (error) {
        log({ event: 'settings_listener_error', error: error?.message ?? String(error) });
      }
    }
  }

  async function load() {
    let info;
    try {
      info = await stat(settingsPath);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        settle(DEFAULTS);
        return;
      }
      fail(`settings_unreadable: ${error?.code ?? error?.message ?? 'unknown'}`);
      return;
    }
    if (!info.isFile()) {
      fail('settings_not_a_file');
      return;
    }
    if (info.size > MAX_BYTES) {
      fail('settings_oversized');
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(await readFile(settingsPath, 'utf8'));
    } catch (error) {
      if (error instanceof SyntaxError) fail('settings_invalid_json');
      else fail(`settings_unreadable: ${error?.code ?? error?.message ?? 'unknown'}`);
      return;
    }
    const problem = validateDocument(parsed);
    if (problem) {
      fail(`settings_invalid: ${problem}`);
      return;
    }
    settle(normalize(parsed));
  }

  // One write at a time: a second update waits for the first.
  function serialized(task) {
    const run = (writing ?? Promise.resolve()).then(task, task);
    writing = run.catch(() => {}).finally(() => {
      if (writing === run) writing = null;
    });
    return run;
  }

  async function writeDocument(settings) {
    const dir = path.dirname(settingsPath);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const tmp = path.join(dir, `.${path.basename(settingsPath)}.${randomBytes(6).toString('hex')}.tmp`);
    const handle = await open(tmp, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(settings, null, 2)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(tmp, settingsPath);
    } catch (error) {
      await unlink(tmp).catch(() => {});
      throw error;
    }
  }

  return {
    current: () => state,
    load,

    update(patch) {
      return serialized(async () => {
        const shape = validatePatch(patch);
        if (shape) throw new SettingsError(shape);
        if (!state.ok) throw new SettingsError('settings_invalid', state.error);
        const merged = merge(state.settings, patch);
        const problem = validateDocument(merged);
        if (problem) throw new SettingsError(codeFor(problem), problem);
        const settings = normalize(merged);
        await writeDocument(settings);
        settle(settings);
        notify();
        return settings;
      });
    },

    seed(values = {}) {
      return serialized(async () => {
        try {
          await stat(settingsPath);
          return false;
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
        const merged = merge(DEFAULTS, values);
        const problem = validateDocument(merged);
        if (problem) throw new SettingsError(codeFor(problem), problem);
        const settings = normalize(merged);
        await writeDocument(settings);
        settle(settings);
        notify();
        return true;
      });
    },

    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

// The shape a patch must have; values are checked by validateDocument once
// merged, so a patch's value problems carry the same codes as a file's.
export function validatePatch(patch) {
  if (!isRecord(patch) || Object.keys(patch).length === 0) return 'invalid_body';
  for (const key of Object.keys(patch)) {
    if (key !== 'model' && key !== 'brief') return 'invalid_body';
    const section = patch[key];
    if (!isRecord(section) || Object.keys(section).length === 0) return 'invalid_body';
    const allowed = key === 'model' ? MODEL_KEYS : BRIEF_KEYS;
    for (const inner of Object.keys(section)) if (!allowed.has(inner)) return 'invalid_body';
  }
  const merged = merge(DEFAULTS, patch);
  const problem = validateDocument(merged);
  return problem ? codeFor(problem) : null;
}

// A one-line problem with a whole document, or null when it is valid.
function validateDocument(value) {
  if (!isRecord(value)) return 'must be a JSON object';
  for (const key of Object.keys(value)) if (!TOP_KEYS.has(key)) return `unknown key "${key}"`;
  if (value.version !== 1) return 'version must be 1';
  if (value.model !== undefined) {
    if (!isRecord(value.model)) return 'model must be an object';
    for (const key of Object.keys(value.model)) if (!MODEL_KEYS.has(key)) return `unknown key "model.${key}"`;
    const { default: model, effort } = value.model;
    if (model !== undefined && model !== null && !(typeof model === 'string' && model.trim() !== '' && model.length <= MODEL_MAX)) {
      return 'model.default must be null or a non-empty string of at most 64 characters';
    }
    if (effort !== undefined && effort !== null && !isEffort(effort)) return 'model.effort must be null or one of low, medium, high, xhigh, max';
  }
  if (value.brief !== undefined) {
    if (!isRecord(value.brief)) return 'brief must be an object';
    for (const key of Object.keys(value.brief)) if (!BRIEF_KEYS.has(key)) return `unknown key "brief.${key}"`;
    const { agent } = value.brief;
    if (agent !== undefined && agent !== null && !(typeof agent === 'string' && AGENT_ID.test(agent))) {
      return 'brief.agent must be null or an agent id';
    }
  }
  return null;
}

function codeFor(problem) {
  if (problem.startsWith('model.default')) return 'invalid_model';
  if (problem.startsWith('model.effort')) return 'invalid_effort';
  if (problem.startsWith('brief.agent')) return 'invalid_agent';
  return 'invalid_body';
}

// Every key present, nulls kept, in a fixed order, frozen.
function normalize(value) {
  return freeze({
    version: 1,
    model: { default: value.model?.default ?? null, effort: value.model?.effort ?? null },
    brief: { agent: value.brief?.agent ?? null },
  });
}

function merge(base, patch) {
  return {
    version: 1,
    model: { ...base.model, ...(isRecord(patch?.model) ? patch.model : {}) },
    brief: { ...base.brief, ...(isRecord(patch?.brief) ? patch.brief : {}) },
  };
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function freeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
