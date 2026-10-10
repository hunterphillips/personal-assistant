// Focus settings: pause state, fixed scan schedules, and the curator's model
// override. current() answers the defaults until load() has resolved; the
// server calls load() at start, and there is no polling, since the daemon is
// the file's only writer. A missing file reads as the defaults with
// `problem: null`. A file that exists but cannot be read, does not parse,
// fails validation, or is oversize reads as the defaults with `paused: true`
// and one plain-word `problem`, so a broken hand edit never silently turns
// the scans back on; the file is kept intact and update() refuses until it
// is fixed. update() atomically writes only paused/model changes and
// notifies listeners. It never schedules work or calls a model.

import { lstat, readFile } from 'node:fs/promises';

import { atomicJson, deepFreeze } from './board.mjs';
import { parseCron } from '../schedule.mjs';

const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const SCHEDULE_KEYS = ['calendar', 'gmail', 'git', 'notes', 'rejudge'];

// Kept in step with defaults/focus-settings.json, the seed copied into a new
// data root. These are also the safe in-memory value before that copy exists.
const DEFAULTS = deepFreeze({
  paused: false,
  schedules: {
    calendar: '5 * * * *', gmail: '35 * * * *', git: '15 6,10,14,18 * * *',
    notes: '45 5,7,11,15,19 * * *', rejudge: '30 5 * * *',
  },
  model: { id: null, effort: null },
  problem: null,
});

export class SettingsError extends Error {
  constructor(code) {
    super(code);
    this.name = 'SettingsError';
    this.code = code;
  }
}

export function createFocusSettings({ file, limits, log: rawLog = () => {} }) {
  const log = (entry) => { try { rawLog(entry); } catch {} };
  const listeners = new Set();
  let state = DEFAULTS;
  let writing = null;
  let loaded = false;
  let loading = null;

  function current() { return state; }

  async function loadOnce() {
    let stats;
    try { stats = await lstat(file); } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') { state = DEFAULTS; return state; }
      return fail('The Focus settings file could not be read.', error);
    }
    if (!stats.isFile()) return fail('The Focus settings path is not a regular file.');
    if (stats.size > limits.focusSettingsBytes) return fail('The Focus settings file is too large.');
    let parsed;
    try {
      const text = await readFile(file, 'utf8');
      if (Buffer.byteLength(text) > limits.focusSettingsBytes) return fail('The Focus settings file is too large.');
      parsed = JSON.parse(text);
    } catch (error) {
      return fail('The settings file could not be read, so curation is paused.', error);
    }
    const problem = validateDocument(parsed);
    if (problem) return fail(`The Focus settings file is invalid: ${problem}.`);
    state = shaped(parsed, null);
    return state;
  }

  function load() {
    if (loaded) return Promise.resolve(state);
    loading ??= loadOnce().finally(() => { loaded = true; loading = null; });
    return loading;
  }

  function fail(problem, error = null) {
    state = deepFreeze({ ...DEFAULTS, paused: true, problem });
    log({ event: 'focus_settings_error', problem, ...(error ? { error: error?.message ?? String(error) } : {}) });
    return state;
  }

  function serialized(task) {
    const run = (writing ?? Promise.resolve()).then(task, task);
    writing = run.catch(() => {}).finally(() => { if (writing === run) writing = null; });
    return run;
  }

  function update(patch) {
    return serialized(async () => {
      await load();
      if (!isRecord(patch) || Object.keys(patch).length === 0) throw new SettingsError('invalid_body');
      if (Object.hasOwn(patch, 'schedules')) throw new SettingsError('read_only');
      if (Object.keys(patch).some((key) => !['paused', 'model'].includes(key))) throw new SettingsError('invalid_body');
      if (state.problem) throw new SettingsError('settings_invalid');
      if (Object.hasOwn(patch, 'paused') && typeof patch.paused !== 'boolean') throw new SettingsError('invalid_paused');
      if (Object.hasOwn(patch, 'model')) {
        if (!isRecord(patch.model) || Object.keys(patch.model).length === 0 || Object.keys(patch.model).some((key) => !['id', 'effort'].includes(key))) {
          throw new SettingsError('invalid_model');
        }
        if (Object.hasOwn(patch.model, 'id') && !validModel(patch.model.id)) throw new SettingsError('invalid_model');
        if (Object.hasOwn(patch.model, 'effort') && !validEffort(patch.model.effort)) throw new SettingsError('invalid_effort');
      }
      const value = {
        version: 1,
        paused: patch.paused ?? state.paused,
        schedules: { ...state.schedules },
        model: { ...state.model, ...(patch.model ?? {}) },
      };
      await atomicJson(file, value);
      state = shaped(value, null);
      for (const listener of listeners) { try { listener(state); } catch (error) { log({ event: 'focus_settings_listener_error', error: error?.message ?? String(error) }); } }
      return state;
    });
  }

  function onChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  return Object.freeze({ load, current, update, onChange });
}

function validateDocument(value) {
  if (!isRecord(value)) return 'it must be an object';
  if (Object.keys(value).some((key) => !['version', 'paused', 'schedules', 'model'].includes(key))) return 'it has an unknown key';
  if (value.version !== 1) return 'version must be 1';
  if (typeof value.paused !== 'boolean') return 'paused must be true or false';
  if (!isRecord(value.schedules) || Object.keys(value.schedules).length !== SCHEDULE_KEYS.length ||
    SCHEDULE_KEYS.some((key) => !Object.hasOwn(value.schedules, key) || !parseCron(value.schedules[key]))) return 'every schedule must be a supported cron line';
  if (!isRecord(value.model) || Object.keys(value.model).some((key) => !['id', 'effort'].includes(key)) ||
    !Object.hasOwn(value.model, 'id') || !Object.hasOwn(value.model, 'effort')) return 'model must contain id and effort';
  if (!validModel(value.model.id)) return 'model.id must be null or a non-empty string';
  if (!validEffort(value.model.effort)) return 'model.effort must be null or one of low, medium, high, xhigh, max';
  return null;
}

function shaped(value, problem) {
  return deepFreeze({
    paused: value.paused,
    schedules: Object.fromEntries(SCHEDULE_KEYS.map((key) => [key, value.schedules[key]])),
    model: { id: value.model.id, effort: value.model.effort },
    problem,
  });
}

function validModel(value) { return value === null || (typeof value === 'string' && value.trim() !== ''); }
function validEffort(value) { return value === null || EFFORTS.has(value); }
function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
