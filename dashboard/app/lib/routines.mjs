// Routines: the scheduled prompts the daemon runs itself, one file each
// under config.routinesDir (default routines/ at the repo root, beside
// registry/), plus an append-only runs log per routine under runs/. The
// daemon is the directory's only writer; the files are committed like the
// registry, the logs are not. The scheduler (scheduler.mjs) fires them;
// this module only stores.
//
//   <dir>/<id>.json
//     { "version": 1, "id": "cfo-daily-drift", "name": "Daily drift",
//       "agent": "cfo", "instruction": "...",
//       "schedule": { "cron": "30 6 * * 1-5", "text": "Weekdays at 6:30" },
//       "active": true, "created": "<ISO>", "updated": "<ISO>" }
//     `schedule.cron` is the one truth, a line schedule.mjs parseCron
//     accepts; `schedule.text` is describe()'s rendering of it, rewritten
//     on every save. `id` matches ROUTINE_ID and the file name.
//   <dir>/runs/<id>.jsonl
//     One JSON line per event, oldest first. A run is a start line
//     { run, occurrence, trigger, startedAt } and an end line { run,
//     endedAt, outcome, reply?, truncated?, detail?, cards? } sharing `run`
//     (reply is the run's text, cut and marked truncated when long; detail
//     the failure or 'interrupted', scheduler.mjs); a skipped or
//     missed occurrence is one line of its own ({ occurrence, trigger,
//     outcome: 'busy' | 'failed', detail? } or { outcome: 'missed', count,
//     from, to, capped? }). `occurrence` is the scheduled instant (null on
//     a test run), `trigger` one of schedule, catchup, test, and `outcome`
//     one of OUTCOMES. The log is kept to the newest limits.routineRunLines
//     lines.
//
// createRoutines({ dir, limits, log, now, randomUUID }) returns:
//
//   load() -> Promise<void>
//     Reads every routine file and runs log once; the server calls it
//     before the hub starts. A file that does not parse or validate is
//     logged as { event: 'routine_invalid', file, reason } and skipped,
//     never deleted. A missing directory is no routines. Never rejects for
//     a bad file; rejects when the directory cannot be listed for another
//     reason.
//   current() -> frozen [routine]       sorted by name
//   onChange(fn) -> unsubscribe         fn() after create, update, remove
//   create({ name, agent, instruction, schedule, active }) -> Promise<routine>
//     The id is a slug of the name (ROUTINE_ID), with a four-hex suffix when
//     that id is taken; `created` and `updated` are stamped; the file is
//     written atomically (temporary file beside it, mode 0600, rename; the
//     directory created 0700).
//   update(id, fields) -> Promise<routine>
//     Any of the five fields; the rest keep their values. `updated` is
//     stamped on every save, an Active toggle included.
//   remove(id) -> Promise<void>         the file and its runs log
//   removeForAgent(agentId) -> Promise<string[]>
//     Every routine of that agent, each as remove() does, in one serialized
//     step; resolves with the ids removed (none is not an error). Called
//     when the agent is deleted (agent-settings-routes.mjs).
//   appendRun(id, line) -> Promise<void>
//     Appends one line (mode 0600; runs/ created 0700) and, past
//     limits.routineRunLines lines, rewrites the log to the newest ones.
//     Appends for one routine run in call order.
//   runs(id, n) -> [run]                 the newest n, newest first, folded:
//     a start and its end line as one record, an unmatched start as a run
//     with no `endedAt`, a single line as itself
//   lastRun(id) -> run | null
//   marker(id) -> ISO | null            the newest non-null `occurrence`
//   openRuns() -> [{ id, ...start }]    every unmatched start, all routines
//
// Validation (RoutineError, `code` and a `detail` naming the field): name
// is 1 to limits.routineNameChars characters, agent matches the registry id
// pattern (whether it is a Claude agent is the route's and the scheduler's
// check), instruction is 1 to limits.routineInstructionChars characters,
// schedule is { cron } with a line parseCron accepts (invalid_schedule when
// it does not), active is a boolean; an unknown or missing field is
// invalid_body. create refuses too_many_routines at limits.routinesMax;
// update, remove, appendRun, runs, lastRun, and marker refuse
// no_such_routine for an id not loaded.

import { appendFile, mkdir, open, readdir, readFile, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, randomUUID as nodeRandomUUID } from 'node:crypto';

import { LIMITS } from './config.mjs';
import { createKeyedQueue } from './feedback.mjs';
import { AGENT_ID } from './registry.mjs';
import { describe, parseCron } from './schedule.mjs';

export const ROUTINE_ID = /^[a-z][a-z0-9-]{1,47}$/;
export const OUTCOMES = Object.freeze(['finished', 'waiting', 'failed', 'interrupted', 'busy', 'missed']);
export const TRIGGERS = Object.freeze(['schedule', 'catchup', 'test']);
const FIELDS = Object.freeze(['name', 'agent', 'instruction', 'schedule', 'active']);
const FILE_KEYS = new Set(['version', 'id', ...FIELDS, 'created', 'updated']);
const FILE_NAME = /^([a-z][a-z0-9-]{1,47})\.json$/;
const FILE_BYTES = 64 * 1024;
const LOG_BYTES = 2 * 1024 * 1024;

export class RoutineError extends Error {
  constructor(code, detail = null) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'RoutineError';
    this.code = code;
    this.detail = detail;
  }
}

export function createRoutines({
  dir, limits = LIMITS, log = () => {}, now = () => new Date(), randomUUID = nodeRandomUUID,
}) {
  const root = path.resolve(dir);
  const runsDir = path.join(root, 'runs');
  const byId = new Map(); // id -> frozen routine
  const logs = new Map(); // id -> { lines: [parsed line], records: [folded, oldest first] }
  const listeners = new Set();
  const queue = createKeyedQueue();
  let writing = null;

  function notify() {
    for (const fn of [...listeners]) {
      try {
        fn();
      } catch (error) {
        log({ event: 'routines_listener_error', error: error?.message ?? String(error) });
      }
    }
  }

  // One routine-file write at a time, so two creates never pick one id.
  function serialized(task) {
    const run = (writing ?? Promise.resolve()).then(task, task);
    writing = run.catch(() => {}).finally(() => {
      if (writing === run) writing = null;
    });
    return run;
  }

  async function load() {
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const match = FILE_NAME.exec(entry.name);
      if (!match || !entry.isFile()) continue;
      const file = path.join(root, entry.name);
      const routine = await readRoutine(file, match[1]);
      if (!routine) continue;
      byId.set(routine.id, routine);
      logs.set(routine.id, await readLog(routine.id));
    }
  }

  async function readRoutine(file, id) {
    let parsed;
    try {
      const info = await stat(file);
      if (info.size > FILE_BYTES) {
        log({ event: 'routine_invalid', file, reason: 'too_large' });
        return null;
      }
      parsed = JSON.parse(await readFile(file, 'utf8'));
    } catch (error) {
      log({ event: 'routine_invalid', file, reason: error instanceof SyntaxError ? 'bad_json' : (error?.code ?? 'unreadable') });
      return null;
    }
    const reason = fileProblem(parsed, id);
    if (reason) {
      log({ event: 'routine_invalid', file, reason });
      return null;
    }
    return freeze(normalizeFile(parsed));
  }

  // The runs log as lines and folded records; a missing log is empty, and
  // a line that does not parse is skipped.
  async function readLog(id) {
    let text;
    try {
      const file = logPath(id);
      const info = await stat(file);
      if (info.size > LOG_BYTES) {
        log({ event: 'routine_log_invalid', routineId: id, reason: 'too_large' });
        return { lines: [], records: [] };
      }
      text = await readFile(file, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return { lines: [], records: [] };
      throw error;
    }
    const lines = [];
    for (const raw of text.split('\n')) {
      if (raw.trim() === '') continue;
      try {
        const line = JSON.parse(raw);
        if (isRecord(line)) lines.push(line);
      } catch {
        // A partial last line after a crash, or a hand edit: skipped.
      }
    }
    return { lines, records: fold(lines) };
  }

  function logPath(id) {
    return path.join(runsDir, `${id}.jsonl`);
  }

  function filePath(id) {
    return path.join(root, `${id}.json`);
  }

  async function writeRoutine(routine) {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const target = filePath(routine.id);
    const tmp = path.join(root, `.${routine.id}.${randomBytes(6).toString('hex')}.tmp`);
    const handle = await open(tmp, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(routine, null, 2)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(tmp, target);
    } catch (error) {
      await unlink(tmp).catch(() => {});
      throw error;
    }
  }

  async function rewriteLog(id, lines) {
    const target = logPath(id);
    const tmp = path.join(runsDir, `.${id}.${randomBytes(6).toString('hex')}.tmp`);
    const handle = await open(tmp, 'wx', 0o600);
    try {
      await handle.writeFile(lines.map((line) => `${JSON.stringify(line)}\n`).join(''), 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(tmp, target);
    } catch (error) {
      await unlink(tmp).catch(() => {});
      throw error;
    }
  }

  // A slug of the name that no routine has yet.
  function idFor(name) {
    let slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/, '');
    if (!/^[a-z]/.test(slug) || slug.length < 2) slug = `r-${slug}`.replace(/-+$/, '');
    if (!byId.has(slug) && ROUTINE_ID.test(slug)) return slug;
    for (let i = 0; i < 20; i += 1) {
      const candidate = `${slug.slice(0, 42)}-${suffix()}`.replace(/--+/g, '-');
      if (!byId.has(candidate) && ROUTINE_ID.test(candidate)) return candidate;
    }
    throw new RoutineError('too_many_routines', 'no free id');
  }

  function suffix() {
    return randomUUID().replace(/-/g, '').slice(0, 4);
  }

  function existing(id) {
    const routine = typeof id === 'string' ? byId.get(id) : undefined;
    if (!routine) throw new RoutineError('no_such_routine');
    return routine;
  }

  return {
    load,
    current: () => Object.freeze([...byId.values()].sort((a, b) => a.name.localeCompare(b.name))),

    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    create(fields) {
      return serialized(async () => {
        const valid = validateFields(fields, limits, { complete: true });
        if (byId.size >= limits.routinesMax) throw new RoutineError('too_many_routines');
        const at = now().toISOString();
        const routine = freeze({ version: 1, id: idFor(valid.name), ...valid, created: at, updated: at });
        await writeRoutine(routine);
        byId.set(routine.id, routine);
        logs.set(routine.id, { lines: [], records: [] });
        notify();
        return routine;
      });
    },

    update(id, fields) {
      return serialized(async () => {
        const before = existing(id);
        if (!isRecord(fields)) throw new RoutineError('invalid_body');
        for (const key of Object.keys(fields)) if (!FIELDS.includes(key)) throw new RoutineError('invalid_body', `unknown field "${key}"`);
        const merged = {};
        for (const key of FIELDS) merged[key] = key in fields ? fields[key] : before[key];
        const valid = validateFields(merged, limits, { complete: true });
        const routine = freeze({ version: 1, id, ...valid, created: before.created, updated: now().toISOString() });
        await writeRoutine(routine);
        byId.set(id, routine);
        notify();
        return routine;
      });
    },

    remove(id) {
      return serialized(async () => {
        existing(id);
        await unlink(filePath(id)).catch((error) => {
          if (error?.code !== 'ENOENT') throw error;
        });
        await unlink(logPath(id)).catch((error) => {
          if (error?.code !== 'ENOENT') throw error;
        });
        byId.delete(id);
        logs.delete(id);
        notify();
      });
    },

    removeForAgent(agentId) {
      return serialized(async () => {
        const ids = [...byId.values()].filter((routine) => routine.agent === agentId).map((routine) => routine.id);
        const removed = [];
        try {
          for (const id of ids) {
            await unlink(filePath(id)).catch((error) => {
              if (error?.code !== 'ENOENT') throw error;
            });
            await unlink(logPath(id)).catch((error) => {
              if (error?.code !== 'ENOENT') throw error;
            });
            byId.delete(id);
            logs.delete(id);
            removed.push(id);
          }
        } finally {
          // A failure part way still tells the hub about the ones gone.
          if (removed.length > 0) notify();
        }
        return removed;
      });
    },

    appendRun(id, line) {
      if (!isRecord(line)) return Promise.reject(new RoutineError('invalid_body', 'a run line must be an object'));
      return queue(id, async () => {
        existing(id);
        const entry = logs.get(id) ?? { lines: [], records: [] };
        logs.set(id, entry);
        await mkdir(runsDir, { recursive: true, mode: 0o700 });
        const clean = JSON.parse(JSON.stringify(line));
        await appendFile(logPath(id), `${JSON.stringify(clean)}\n`, { encoding: 'utf8', mode: 0o600 });
        entry.lines.push(clean);
        if (entry.lines.length > limits.routineRunLines) {
          entry.lines = entry.lines.slice(-limits.routineRunLines);
          await rewriteLog(id, entry.lines);
        }
        entry.records = fold(entry.lines);
      });
    },

    runs(id, n = Infinity) {
      existing(id);
      const records = logs.get(id)?.records ?? [];
      return records.slice(Math.max(0, records.length - n)).reverse().map((record) => ({ ...record }));
    },

    lastRun(id) {
      existing(id);
      const records = logs.get(id)?.records ?? [];
      return records.length === 0 ? null : { ...records[records.length - 1] };
    },

    marker(id) {
      existing(id);
      let newest = null;
      for (const line of logs.get(id)?.lines ?? []) {
        if (typeof line.occurrence === 'string' && (newest === null || line.occurrence > newest)) newest = line.occurrence;
      }
      return newest;
    },

    openRuns() {
      const open = [];
      for (const [id, entry] of logs) {
        for (const record of entry.records) {
          if (typeof record.run === 'string' && typeof record.startedAt === 'string' && record.endedAt === undefined) open.push({ id, ...record });
        }
      }
      return open;
    },
  };
}

// Start and end lines sharing `run` become one record; everything else is
// a record of its own, in file order.
function fold(lines) {
  const records = [];
  const open = new Map();
  for (const line of lines) {
    if (typeof line.run === 'string') {
      const seen = open.get(line.run);
      if (seen) {
        Object.assign(seen, line);
      } else {
        const record = { ...line };
        open.set(line.run, record);
        records.push(record);
      }
    } else {
      records.push({ ...line });
    }
  }
  return records;
}

// The five fields checked and normalized: a trimmed name and instruction,
// and the schedule as { cron: the normalized line, text: its words }.
export function validateFields(fields, limits = LIMITS, { complete = true } = {}) {
  if (!isRecord(fields)) throw new RoutineError('invalid_body');
  for (const key of Object.keys(fields)) if (!FIELDS.includes(key)) throw new RoutineError('invalid_body', `unknown field "${key}"`);
  if (complete) for (const key of FIELDS) if (!(key in fields)) throw new RoutineError('invalid_body', `missing field "${key}"`);
  const out = {};
  if ('name' in fields) {
    const name = typeof fields.name === 'string' ? fields.name.trim() : '';
    if (name === '' || Array.from(name).length > limits.routineNameChars) throw new RoutineError('invalid_body', `name must be 1 to ${limits.routineNameChars} characters`);
    out.name = name;
  }
  if ('agent' in fields) {
    if (typeof fields.agent !== 'string' || !AGENT_ID.test(fields.agent)) throw new RoutineError('invalid_body', 'agent must be an agent id');
    out.agent = fields.agent;
  }
  if ('instruction' in fields) {
    const instruction = typeof fields.instruction === 'string' ? fields.instruction.trim() : '';
    if (instruction === '' || Array.from(instruction).length > limits.routineInstructionChars) {
      throw new RoutineError('invalid_body', `instruction must be 1 to ${limits.routineInstructionChars} characters`);
    }
    out.instruction = instruction;
  }
  if ('schedule' in fields) {
    const schedule = fields.schedule;
    if (!isRecord(schedule) || typeof schedule.cron !== 'string') throw new RoutineError('invalid_body', 'schedule must be { cron }');
    for (const key of Object.keys(schedule)) if (key !== 'cron' && key !== 'text') throw new RoutineError('invalid_body', `unknown field "schedule.${key}"`);
    const cron = parseCron(schedule.cron);
    if (!cron) throw new RoutineError('invalid_schedule', schedule.cron);
    out.schedule = { cron: cron.line, text: describe(cron) };
  }
  if ('active' in fields) {
    if (typeof fields.active !== 'boolean') throw new RoutineError('invalid_body', 'active must be true or false');
    out.active = fields.active;
  }
  return out;
}

// Why a stored file cannot be loaded, or null.
function fileProblem(value, id) {
  if (!isRecord(value)) return 'not_an_object';
  for (const key of Object.keys(value)) if (!FILE_KEYS.has(key)) return `unknown_key:${key}`;
  if (value.version !== 1) return 'bad_version';
  if (value.id !== id) return 'id_mismatch';
  for (const key of ['created', 'updated']) {
    if (typeof value[key] !== 'string' || Number.isNaN(Date.parse(value[key]))) return `bad_${key}`;
  }
  if (!isRecord(value.schedule) || typeof value.schedule.text !== 'string' || value.schedule.text === '') return 'bad_schedule';
  try {
    validateFields({ name: value.name, agent: value.agent, instruction: value.instruction, schedule: { cron: value.schedule.cron }, active: value.active });
  } catch (error) {
    return error?.detail ?? error?.code ?? 'invalid';
  }
  return null;
}

// A loaded file in key order; the stored words are kept as written.
function normalizeFile(value) {
  const valid = validateFields({ name: value.name, agent: value.agent, instruction: value.instruction, schedule: { cron: value.schedule.cron }, active: value.active });
  return {
    version: 1,
    id: value.id,
    ...valid,
    schedule: { cron: valid.schedule.cron, text: value.schedule.text },
    created: value.created,
    updated: value.updated,
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
