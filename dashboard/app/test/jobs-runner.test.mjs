import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import { LIMITS, TIMEOUTS } from '../lib/config.mjs';
import { createJobRunner } from '../lib/jobs-runner.mjs';
import { tempDir } from './support/harness.mjs';

const START = '2026-10-05T12:00:10.000Z';

async function setup(t, { clock = START, limits = {}, timeouts = {} } = {}) {
  let time = Date.parse(clock);
  let uuid = 0;
  const timers = [];
  const logs = [];
  const dir = path.join(await tempDir(t), 'focus-runs');
  const now = () => new Date(time);
  const runner = createJobRunner({
    runsDir: dir, zone: 'UTC', limits: { ...LIMITS, ...limits }, timeouts: { ...TIMEOUTS, ...timeouts }, now,
    log: (entry) => logs.push(entry), randomUUID: () => `run-${++uuid}`,
    setTimeout: (fn, ms) => {
      const timer = { fn, ms, cleared: false, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (timer) => { timer.cleared = true; },
  });
  t.after(() => runner.stop());
  return { runner, dir, timers, logs, now, set: (iso) => { time = Date.parse(iso); }, advance: (ms) => { time += ms; } };
}

function scriptedJob(label, events, extra = {}) {
  return {
    label, name: extra.name ?? label, cron: () => ('cron' in extra ? extra.cron : '0 12 * * *'),
    due: extra.due ?? (() => true), paused: extra.paused ?? (() => false), timeoutMs: extra.timeoutMs ?? 1_000,
    async run(trigger, context, { signal, enqueue }) {
      events.push(['start', label, trigger, context]);
      const answer = extra.run ? await extra.run({ trigger, context, signal, enqueue }) : { outcome: 'wrote', value: label };
      events.push(['end', label]);
      return answer;
    },
    ...(extra.onBurstEnd ? { onBurstEnd: extra.onBurstEnd } : {}),
  };
}

async function settle(condition) {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition did not hold');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

test('a due job runs once, a missed burst runs in registration order, and burst results are reported once', async (t) => {
  const { runner, set } = await setup(t);
  const events = [];
  const bursts = [];
  runner.register(scriptedJob('one', events, { onBurstEnd: (results) => bursts.push(['one', results]) }));
  await runner.tick();
  assert.deepEqual(events.map((event) => event.slice(0, 3)), [['start', 'one', 'schedule'], ['end', 'one']]);
  assert.equal(runner.lastRun('one').occurrence, '2026-10-05T12:00:00.000Z');
  assert.equal(runner.lastRun('one').outcome, 'wrote');
  assert.deepEqual(bursts, [['one', [{ label: 'one', outcome: 'wrote', value: 'one' }]]]);

  set('2026-10-06T12:05:00.000Z');
  const secondEvents = [];
  // A separate runner is needed because registration closes at start only,
  // while tick-only use intentionally permits registration for focused tests.
  const other = await setup(t, { clock: '2026-10-06T12:05:00.000Z' });
  const seen = [];
  other.runner.register(scriptedJob('a', secondEvents, { onBurstEnd: (results) => seen.push(results) }));
  other.runner.register(scriptedJob('b', secondEvents));
  await other.runner.tick();
  assert.deepEqual(secondEvents.map((event) => event.slice(0, 3)), [
    ['start', 'a', 'catchup'], ['end', 'a'], ['start', 'b', 'catchup'], ['end', 'b'],
  ]);
  assert.deepEqual(seen, [[{ label: 'a', outcome: 'wrote', value: 'a' }, { label: 'b', outcome: 'wrote', value: 'b' }]]);
});

test('explicit work is FIFO ahead of due work, runs one at a time, and exclusive enqueue refuses while busy', async (t) => {
  const { runner } = await setup(t);
  const events = [];
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  runner.register(scriptedJob('manual', events, { cron: null, run: async () => { await held; return { outcome: 'no change' }; } }));
  runner.register(scriptedJob('due', events));
  assert.deepEqual(await runner.enqueue('manual', 'refresh', { source: 'test' }), { ok: true, run: 'run-1' });
  await settle(() => runner.state().running === 'manual');
  assert.deepEqual(await runner.enqueue('due', 'refresh', null, { exclusive: true }), { ok: false, reason: 'already_running' });
  const tick = runner.tick();
  release();
  await tick;
  assert.deepEqual(events.map((event) => event.slice(0, 3)), [
    ['start', 'manual', 'refresh'], ['end', 'manual'], ['start', 'due', 'schedule'], ['end', 'due'],
  ]);
  assert.equal(runner.runs('manual')[0].source, 'test');
});

test('a scheduled guard leaves the marker alone, while a guarded explicit run is dropped without a record', async (t) => {
  const { runner, advance } = await setup(t);
  const events = [];
  let allowed = false;
  runner.register(scriptedJob('guarded', events, { due: () => allowed }));
  await runner.tick();
  assert.deepEqual(runner.runs('guarded'), []);
  assert.deepEqual(await runner.enqueue('guarded', 'scan'), { ok: true, run: 'run-2' });
  await settle(() => runner.state().running === null);
  assert.deepEqual(runner.runs('guarded'), []);
  allowed = true;
  advance(2 * TIMEOUTS.focusTickMs);
  await runner.tick();
  assert.equal(runner.lastRun('guarded').trigger, 'catchup');
  assert.equal(runner.lastRun('guarded').run, 'run-3');
});

test('a job can enqueue another job while running, and an array enqueue is one ordered burst', async (t) => {
  const { runner } = await setup(t);
  const events = [];
  const bursts = [];
  runner.register(scriptedJob('first', events, {
    cron: null,
    run: async ({ enqueue }) => {
      assert.deepEqual(await enqueue('second', 'scan', { n: 1 }), { ok: true, run: 'run-3' });
      return { outcome: 'wrote' };
    },
  }));
  runner.register(scriptedJob('second', events, { cron: null, onBurstEnd: (results) => bursts.push(results) }));
  assert.deepEqual(await runner.enqueue([
    { label: 'first', trigger: 'refresh', context: null },
    { label: 'second', trigger: 'refresh', context: { n: 2 } },
  ], { exclusive: true }), { ok: true, run: 'run-1' });
  await settle(() => runner.runs('second').length === 2);
  assert.deepEqual(events.map((event) => event.slice(0, 3)), [
    ['start', 'first', 'refresh'], ['end', 'first'], ['start', 'second', 'refresh'], ['end', 'second'],
    ['start', 'second', 'scan'], ['end', 'second'],
  ]);
  assert.deepEqual(bursts, [[{ label: 'first', outcome: 'wrote' }, { label: 'second', outcome: 'wrote', value: 'second' }]]);
});

test('timeout and stop abort the signal and write their failed end line before settling', async (t) => {
  const timed = await setup(t);
  let timedSignal;
  timed.runner.register(scriptedJob('slow', [], {
    cron: null, timeoutMs: 20,
    run: ({ signal }) => new Promise((resolve) => {
      timedSignal = signal;
      signal.addEventListener('abort', () => resolve({ outcome: 'wrote' }), { once: true });
    }),
  }));
  await timed.runner.enqueue('slow', 'refresh');
  await settle(() => timed.runner.state().running === 'slow');
  await settle(() => timed.timers.some((timer) => timer.ms === 20));
  const timeout = timed.timers.find((timer) => timer.ms === 20);
  timeout.fn();
  await settle(() => timed.runner.lastRun('slow')?.endedAt);
  assert.equal(timedSignal.aborted, true);
  assert.equal(timed.runner.lastRun('slow').outcome, 'failed');
  assert.equal(timed.runner.lastRun('slow').detail, 'The job timed out.');

  const stopping = await setup(t);
  let stopSignal;
  stopping.runner.register(scriptedJob('slow', [], {
    cron: null,
    run: ({ signal }) => new Promise((resolve) => {
      stopSignal = signal;
      signal.addEventListener('abort', () => resolve({ outcome: 'wrote' }), { once: true });
    }),
  }));
  await stopping.runner.enqueue('slow', 'refresh');
  await settle(() => stopSignal !== undefined);
  await stopping.runner.stop();
  assert.equal(stopSignal.aborted, true);
  assert.equal(stopping.runner.lastRun('slow').outcome, 'failed');
  assert.equal(stopping.runner.lastRun('slow').detail, 'The daemon stopped.');
});

test('start closes open runs, trims and folds logs, arms ticks, and reloads the retained records', async (t) => {
  const first = await setup(t, { limits: { focusRunLines: 3 } });
  const events = [];
  first.runner.register(scriptedJob('job', events, { cron: null }));
  await first.runner.enqueue('job', 'refresh');
  await settle(() => first.runner.lastRun('job')?.endedAt);
  await first.runner.enqueue('job', 'refresh');
  await settle(() => first.runner.runs('job').length === 2 && first.runner.runs('job')[0]?.endedAt);
  assert.equal(first.runner.runs('job').length, 2);
  assert.equal(first.runner.runs('job').at(-1).startedAt, undefined, 'the oldest start line was trimmed');
  await first.runner.stop();

  const second = await setup(t, { limits: { focusRunLines: 3 } });
  // Reuse the first runner's directory with a new runner to exercise loading.
  const reload = createJobRunner({
    runsDir: first.dir, zone: 'UTC', limits: { ...LIMITS, focusRunLines: 3 }, timeouts: TIMEOUTS,
    now: first.now, randomUUID: () => 'reload-run',
    setTimeout: (fn, ms) => { const timer = { fn, ms, unref() {} }; second.timers.push(timer); return timer; }, clearTimeout: () => {},
  });
  reload.register(scriptedJob('job', [], { cron: null }));
  await reload.start();
  assert.equal(reload.runs('job').length, 2);
  assert.equal(second.timers.at(-1).ms, TIMEOUTS.focusTickMs);
  await reload.stop();

  const open = await setup(t, { clock: '2026-10-05T13:00:00.000Z' });
  await mkdir(open.dir, { recursive: true });
  await writeFile(path.join(open.dir, 'job.jsonl'), `${JSON.stringify({
    run: 'old-run', occurrence: null, trigger: 'refresh', startedAt: START,
  })}\n`);
  open.runner.register(scriptedJob('job', [], { cron: null }));
  await open.runner.start();
  assert.equal(open.runner.lastRun('job').outcome, 'interrupted');
  assert.equal(open.runner.lastRun('job').endedAt, '2026-10-05T13:00:00.000Z');
});

test('rows and onChange reflect starts, ends, failures, paused state, and running state', async (t) => {
  const { runner } = await setup(t);
  const changes = [];
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  runner.register(scriptedJob('health', [], {
    cron: '0 12 * * 1-5', paused: () => true,
    run: async () => { await held; return { outcome: 'rejected', detail: 'No.' }; },
  }));
  runner.onChange(() => changes.push(runner.state().running));
  const tick = runner.tick();
  await settle(() => runner.state().running === 'health');
  assert.equal(runner.rows()[0].running, true);
  assert.equal(runner.rows()[0].paused, true);
  assert.equal(runner.rows()[0].schedule.text, 'Weekdays at 12:00');
  release();
  await tick;
  assert.equal(runner.rows()[0].running, false);
  assert.equal(runner.rows()[0].outcome, 'rejected');
  assert.equal(runner.rows()[0].detail, 'No.');
  assert.equal(runner.rows()[0].lastRun, START);
  assert.equal(runner.rows()[0].failures24h, 1);
  assert.ok(Object.isFrozen(runner.rows()[0]));
  assert.deepEqual(changes, ['health', 'health', 'health', null]);
});

test('a job started by a tick that enqueues another holds the runner until it ends', async (t) => {
  const { runner } = await setup(t);
  const events = [];
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const seen = [];
  runner.register(scriptedJob('first', events, {
    run: async ({ enqueue }) => {
      await enqueue('second', 'scan', { n: 1 });
      await held;
      return { outcome: 'wrote' };
    },
  }));
  runner.register(scriptedJob('second', events, { cron: null }));
  const tick = runner.tick();
  await settle(() => events.length === 1);
  runner.onChange(() => { if (!events.some((event) => event[0] === 'end')) seen.push(runner.state().running); });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(events.map((event) => event.slice(0, 3)), [['start', 'first', 'schedule']]);
  assert.equal(runner.state().running, 'first');
  assert.deepEqual(await runner.enqueue('second', 'refresh', null, { exclusive: true }), { ok: false, reason: 'already_running' });
  release();
  await tick;
  await settle(() => runner.runs('second')[0]?.endedAt);
  assert.deepEqual(events.map((event) => event.slice(0, 3)), [
    ['start', 'first', 'schedule'], ['end', 'first'], ['start', 'second', 'scan'], ['end', 'second'],
  ]);
  assert.ok(seen.every((label) => label === 'first'));
  assert.equal(runner.runs('second').length, 1);
});

test('a job whose due check settles after stop does not start', async (t) => {
  const { runner } = await setup(t);
  const events = [];
  let answer;
  const due = new Promise((resolve) => { answer = resolve; });
  runner.register(scriptedJob('late', events, { due: () => due }));
  const tick = runner.tick();
  await new Promise((resolve) => setTimeout(resolve, 5));
  const stopping = runner.stop();
  answer(true);
  await stopping;
  await tick;
  assert.deepEqual(events, []);
  assert.deepEqual(runner.runs('late'), []);
  assert.equal(runner.state().running, null);
});
