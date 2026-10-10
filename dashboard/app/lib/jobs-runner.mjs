// The in-process job runner: registers scheduled jobs, catches up their most
// recent missed occurrences, serializes explicit and scheduled work, and keeps
// one folded JSON-lines run log per label. Scheduled and explicit work go
// through one queue, so exactly one job runs at a time, and it never calls an
// external service itself.
//
// createJobRunner({ runsDir, schedule, zone, limits, runLines, tickMs, onTick,
//                   log, now, setTimeout, clearTimeout, randomUUID }) returns:
//   `runLines` caps each runs log; `tickMs` is the due check's interval;
//   `onTick()`, when given, is awaited at the start of every tick, before the
//   due check reads any job's cron.
//   register(job)                 Add one job before start. A job may carry
//                                 triggerFor(trigger, context), whose answer
//                                 replaces the trigger for that run. Its
//                                 onBurstEnd(results) gets each run's answer
//                                 with its label and trigger. run(trigger,
//                                 context, { signal, enqueue, run }) gets
//                                 the run id its log lines carry.
//   start()                       Load logs, close open runs, kick the first
//                                 tick without awaiting its drain, and arm.
//   stop()                        Abort and await the running job. Later
//                                 enqueues answer { ok: false, reason: 'stopped' }.
//   tick()                        Run the latest due occurrence for each job.
//   enqueue(label, trigger, context, options?)
//                                 Queue explicit work ahead of scheduled work.
//     `label` may instead be an array of { label, trigger, context } entries;
//     the array is one burst. `{ exclusive: true }` refuses the whole enqueue
//     while any work is running or queued.
//   rows(), state(), lastRun(label), runs(label, n), onChange(fn)

import { randomBytes, randomUUID as nodeRandomUUID } from 'node:crypto';
import { appendFile, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

import { LIMITS, TIME_ZONE } from './config.mjs';
import * as defaultSchedule from './schedule.mjs';

const DAY_MS = 86_400_000;
const RUN_LINES = 200;
const TICK_MS = 30_000;
const FAILURE_OUTCOMES = new Set(['failed', 'rejected']);

export class JobRunnerError extends Error {
  constructor(code, detail = null) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'JobRunnerError';
    this.code = code;
    this.detail = detail;
  }
}

export function createJobRunner({
  runsDir, schedule = defaultSchedule, zone = TIME_ZONE, limits = LIMITS, runLines = RUN_LINES, tickMs = TICK_MS,
  onTick = null, log = () => {},
  now = () => new Date(), setTimeout: setTimer = globalThis.setTimeout, clearTimeout: clearTimer = globalThis.clearTimeout,
  randomUUID = nodeRandomUUID,
}) {
  const root = path.resolve(runsDir);
  const jobs = [];
  const byLabel = new Map();
  const logs = new Map();
  const listeners = new Set();
  const queue = [];
  let started = false;
  let stopped = false;
  let timer = null;
  let ticking = null;
  let pumping = null;
  let running = null;
  let writeChain = Promise.resolve();

  function notify() {
    for (const fn of [...listeners]) {
      try {
        fn();
      } catch (error) {
        log({ event: 'job_runner_listener_error', error: messageOf(error) });
      }
    }
  }

  function register(job) {
    if (started) throw new JobRunnerError('already_started');
    if (!isRecord(job) || typeof job.label !== 'string' || job.label === '' || typeof job.name !== 'string'
      || typeof job.cron !== 'function' || typeof job.due !== 'function' || typeof job.run !== 'function') {
      throw new JobRunnerError('invalid_job');
    }
    if (byLabel.has(job.label)) throw new JobRunnerError('duplicate_job', job.label);
    jobs.push(job);
    byLabel.set(job.label, job);
    logs.set(job.label, { lines: [], records: [] });
  }

  function fileFor(label) {
    return path.join(root, `${label}.jsonl`);
  }

  async function loadLog(label) {
    let text;
    try {
      text = await readFile(fileFor(label), 'utf8');
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
        // A crash may leave a partial final line. Ignore it.
      }
    }
    return { lines, records: fold(lines) };
  }

  async function rewrite(label, lines) {
    const target = fileFor(label);
    const tmp = path.join(root, `.${label}.${randomBytes(6).toString('hex')}.tmp`);
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

  function append(label, line) {
    const task = writeChain.then(async () => {
      await mkdir(root, { recursive: true, mode: 0o700 });
      const clean = JSON.parse(JSON.stringify(line));
      await appendFile(fileFor(label), `${JSON.stringify(clean)}\n`, { encoding: 'utf8', mode: 0o600 });
      const entry = logs.get(label) ?? { lines: [], records: [] };
      logs.set(label, entry);
      entry.lines.push(clean);
      if (entry.lines.length > runLines) {
        entry.lines = entry.lines.slice(-runLines);
        await rewrite(label, entry.lines);
      }
      entry.records = fold(entry.lines);
      notify();
    });
    writeChain = task.catch(() => {});
    return task;
  }

  function marker(label, at) {
    let latest = null;
    for (const line of logs.get(label)?.lines ?? []) {
      if (typeof line.occurrence === 'string' && (latest === null || line.occurrence > latest)) latest = line.occurrence;
    }
    const floor = new Date(at.getTime() - limits.routineCatchupDays * DAY_MS).toISOString();
    return new Date(Math.max(Date.parse(floor), latest === null ? -Infinity : Date.parse(latest)));
  }

  function currentCron(job) {
    const line = job.cron();
    return typeof line === 'string' ? schedule.parseCron(line) : null;
  }

  function dueEntries(at) {
    const entries = [];
    for (const job of jobs) {
      const cron = currentCron(job);
      if (!cron) continue;
      const occurrence = schedule.previous(cron, at, zone);
      if (!occurrence || occurrence.getTime() <= marker(job.label, at).getTime()) continue;
      entries.push({ job, occurrence });
    }
    return entries;
  }

  async function execute(item) {
    const { job, context, occurrence, run } = item;
    const trigger = triggerOf(job, item.trigger, context);
    let allowed;
    try {
      allowed = await job.due(now(), trigger);
    } catch (error) {
      log({ event: 'job_due_error', label: job.label, error: messageOf(error) });
      allowed = false;
    }
    if (!allowed || stopped) return null;

    const startedAt = now();
    const controller = new AbortController();
    const active = { job, controller, abortDetail: null, settled: null };
    running = active;
    notify();
    const source = typeof context?.source === 'string' ? context.source : null;
    try {
      await append(job.label, {
        run, occurrence: occurrence ? occurrence.toISOString() : null, trigger, ...(source ? { source } : {}), startedAt: startedAt.toISOString(),
      });
    } catch (error) {
      if (running === active) running = null;
      notify();
      throw error;
    }

    const timeoutMs = Number.isFinite(job.timeoutMs) && job.timeoutMs >= 0 ? job.timeoutMs : null;
    const timeout = timeoutMs === null ? null : setTimer(() => {
      active.abortDetail = 'The job timed out.';
      controller.abort(new Error(active.abortDetail));
    }, timeoutMs);
    timeout?.unref?.();

    let answer;
    const nestedEnqueue = (label, nextTrigger, nextContext = null, options = {}) => enqueue(label, nextTrigger, nextContext, options);
    try {
      answer = active.abortDetail
        ? { outcome: 'failed', detail: active.abortDetail }
        : await job.run(trigger, context, { signal: controller.signal, enqueue: nestedEnqueue, run });
    } catch (error) {
      answer = { outcome: 'failed', detail: messageOf(error) };
    } finally {
      if (timeout) clearTimer(timeout);
    }
    if (active.abortDetail) answer = { ...(isRecord(answer) ? answer : {}), outcome: 'failed', detail: active.abortDetail };
    if (!isRecord(answer) || typeof answer.outcome !== 'string') answer = { outcome: 'failed', detail: 'The job did not return an outcome.' };
    const endedAt = now();
    const end = { run, endedAt: endedAt.toISOString(), ...answer };
    // A failed end line is logged, never thrown: the rest of the batch and
    // its burst end still run.
    try {
      await append(job.label, end);
      log({ event: 'job_run', label: job.label, trigger, outcome: end.outcome, ms: endedAt.getTime() - startedAt.getTime() });
    } catch (error) {
      log({ event: 'job_log_error', label: job.label, error: messageOf(error) });
    } finally {
      if (running === active) running = null;
      notify();
    }
    return { label: job.label, ...answer, trigger };
  }

  async function burstEnded(results) {
    for (const job of jobs) {
      if (typeof job.onBurstEnd !== 'function') continue;
      try {
        await job.onBurstEnd(results.map((result) => ({ ...result })));
      } catch (error) {
        log({ event: 'job_burst_error', label: job.label, error: messageOf(error) });
      }
    }
  }

  async function runBatch(items, { burst = false } = {}) {
    const results = [];
    for (const item of items) {
      if (stopped) break;
      const result = await execute(item);
      if (result) results.push(result);
    }
    if (!stopped && burst) await burstEnded(results);
    return results;
  }

  // The one place jobs start: explicit and scheduled batches share this
  // queue, so a job that enqueues another never runs beside it. `pumping` is
  // cleared in the same turn the loop sees an empty queue, so an enqueue
  // never lands behind a drain that has already finished.
  async function drainQueue() {
    try {
      while (!stopped && queue.length > 0) {
        const batch = queue.shift();
        try {
          await runBatch(batch.items, { burst: batch.burst });
        } catch (error) {
          log({ event: 'job_queue_error', error: messageOf(error) });
        }
      }
    } finally {
      pumping = null;
    }
  }

  function pump() {
    if (pumping) return pumping;
    if (stopped || queue.length === 0) return Promise.resolve();
    pumping = drainQueue();
    return pumping;
  }

  // A job may name what an occurrence means to it; its answer is the trigger
  // the guard, the start line, and the run all see.
  function triggerOf(job, trigger, context) {
    if (typeof job.triggerFor !== 'function') return trigger;
    const mapped = job.triggerFor(trigger, context);
    return typeof mapped === 'string' && mapped !== '' ? mapped : trigger;
  }

  function normalizeEnqueue(label, trigger, context) {
    const entries = Array.isArray(label) ? label : [{ label, trigger, context }];
    if (entries.length === 0) throw new JobRunnerError('invalid_enqueue');
    return entries.map((entry) => {
      if (!isRecord(entry) || typeof entry.label !== 'string' || typeof entry.trigger !== 'string') throw new JobRunnerError('invalid_enqueue');
      const job = byLabel.get(entry.label);
      if (!job) throw new JobRunnerError('no_such_job', entry.label);
      return { job, trigger: entry.trigger, context: entry.context ?? null, occurrence: null, run: randomUUID() };
    });
  }

  function enqueue(label, trigger, context = null, options = {}) {
    // For the array form, callers may pass options as the second argument.
    if (Array.isArray(label) && isRecord(trigger)) options = trigger;
    const items = normalizeEnqueue(label, trigger, context);
    if (stopped) return Promise.resolve({ ok: false, reason: 'stopped' });
    if (options.exclusive && (running || queue.length > 0 || pumping)) return Promise.resolve({ ok: false, reason: 'already_running' });
    queue.push({ items, burst: items.length > 1 });
    void pump();
    return Promise.resolve({ ok: true, run: items[0].run });
  }

  async function runTick() {
    if (stopped) return;
    await pump();
    if (stopped) return;
    if (onTick) {
      try {
        await onTick();
      } catch (error) {
        log({ event: 'job_tick_hook_error', error: messageOf(error) });
      }
      if (stopped) return;
    }
    const at = now();
    const due = dueEntries(at);
    if (due.length === 0) return;
    const many = due.length > 1;
    const items = due.map(({ job, occurrence }) => ({
      job, occurrence, context: null, run: randomUUID(),
      trigger: many || at.getTime() - occurrence.getTime() >= 2 * tickMs ? 'catchup' : 'schedule',
    }));
    queue.push({ items, burst: true });
    await pump();
  }

  function tick() {
    if (ticking) return ticking;
    ticking = runTick()
      .catch((error) => log({ event: 'job_tick_error', error: messageOf(error) }))
      .finally(() => { ticking = null; });
    return ticking;
  }

  function arm() {
    if (stopped) return;
    timer = setTimer(() => {
      timer = null;
      tick().finally(arm);
    }, tickMs);
    timer?.unref?.();
  }

  function records(label) {
    if (!byLabel.has(label)) throw new JobRunnerError('no_such_job', label);
    return logs.get(label)?.records ?? [];
  }

  function rows() {
    const at = now().getTime();
    const cutoff = at - DAY_MS;
    return Object.freeze(jobs.map((job) => {
      const cron = currentCron(job);
      const last = records(job.label).at(-1) ?? null;
      const isRunning = running?.job.label === job.label;
      let failures24h = 0;
      for (const record of records(job.label)) {
        const ended = typeof record.endedAt === 'string' ? Date.parse(record.endedAt) : NaN;
        if (ended >= cutoff && ended <= at && FAILURE_OUTCOMES.has(record.outcome)) failures24h += 1;
      }
      return freeze({
        label: job.label, name: job.name, schedule: { kind: 'cron', text: cron ? schedule.describe(cron) : '' },
        // A job with no record never ran; one whose open record has no end yet
        // is running.
        lastRun: last?.startedAt ?? last?.endedAt ?? null,
        outcome: isRunning && typeof last?.outcome !== 'string' ? 'running' : last ? last.outcome ?? null : 'never ran',
        detail: last?.detail ?? null,
        failures24h, paused: typeof job.paused === 'function' ? Boolean(job.paused()) : false,
        running: isRunning, source: 'dashboard', available: true,
      });
    }));
  }

  return {
    register,
    async start() {
      if (started) return;
      started = true;
      stopped = false;
      for (const job of jobs) logs.set(job.label, await loadLog(job.label));
      for (const job of jobs) {
        for (const record of logs.get(job.label).records) {
          if (typeof record.run === 'string' && typeof record.startedAt === 'string' && record.endedAt === undefined) {
            await append(job.label, { run: record.run, endedAt: now().toISOString(), outcome: 'interrupted' });
          }
        }
      }
      // The first tick drains in the background, so a caller that awaits
      // start() is not held behind a night's catch-up.
      void tick();
      arm();
    },
    async stop() {
      stopped = true;
      if (timer) clearTimer(timer);
      timer = null;
      queue.length = 0;
      if (running) {
        running.abortDetail = 'The daemon stopped.';
        running.controller.abort(new Error(running.abortDetail));
      }
      await Promise.all([ticking, pumping].filter(Boolean));
      await writeChain;
    },
    tick,
    enqueue,
    rows,
    state: () => freeze({ running: running?.job.label ?? null }),
    lastRun(label) {
      const record = records(label).at(-1);
      return record ? freeze({ ...record }) : null;
    },
    runs(label, n = Infinity) {
      const all = records(label);
      return Object.freeze(all.slice(Math.max(0, all.length - n)).reverse().map((record) => freeze({ ...record })));
    },
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

function fold(lines) {
  const records = [];
  const open = new Map();
  for (const line of lines) {
    if (typeof line.run === 'string') {
      const seen = open.get(line.run);
      if (seen) Object.assign(seen, line);
      else {
        const record = { ...line };
        open.set(line.run, record);
        records.push(record);
      }
    } else records.push({ ...line });
  }
  return records;
}

function messageOf(error) {
  return error?.message ?? String(error);
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
