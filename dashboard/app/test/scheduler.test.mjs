import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';

import { LIMITS, TIMEOUTS } from '../lib/config.mjs';
import { createHub } from '../lib/hub.mjs';
import { createRoutines } from '../lib/routines.mjs';
import { RuntimeError } from '../lib/runtime/adapter.mjs';
import { createScheduler } from '../lib/scheduler.mjs';
import { fakeJobs, fakeRegistry, tempDir } from './support/harness.mjs';

const ZONE = 'America/Chicago';
// Monday 2026-10-05 06:00 CDT.
const START = '2026-10-05T11:00:00.000Z';
const MONDAY = '2026-10-05T11:30:00.000Z';

const agent = (id, extra = {}) => Object.freeze({
  id, name: id.toUpperCase(), role: 'Role', description: 'Invented.', group: 'work', kind: 'persona', cwd: '/invented', provider: 'claude', jobs: [], ...extra,
});
const AGENTS = [
  agent('cfo', { name: 'CFO', model: 'opus', effort: 'high', permission: 'full' }),
  agent('brain', { name: 'Second brain' }),
  agent('dev', { name: 'Dev', provider: 'codex' }),
];

const FIELDS = Object.freeze({ name: 'Daily drift', agent: 'cfo', instruction: 'Compute drift.', schedule: { cron: '30 6 * * 1-5' }, active: true });
const PROMPT = 'Routine "Daily drift" (a scheduled run, not the user): Compute drift.\n\nYou may ask other agents, and your reply is what this run leaves behind.';

// A runtime stand-in: send() opens a turn the test ends with finish(),
// fail(), or abort(); raise() and resolve() play a card on the open turn,
// stamped with the turn's sender and chain as the real adapter stamps it;
// say() plays a message in the thread.
function fakeRuntime(now, failing = new Set()) {
  const listeners = new Set();
  const entries = new Map();
  let nextRequest = 1;
  const entry = (id) => {
    if (!entries.has(id)) entries.set(id, { state: 'idle', pending: null, lastError: null, turn: null, from: null, chain: [] });
    return entries.get(id);
  };
  const emit = (type, agentId, fields = {}) => {
    for (const fn of [...listeners]) fn({ type, agentId, at: now().toISOString(), ...fields });
  };
  const setState = (id, state) => { entry(id).state = state; emit('thread.state', id, { state }); };
  const end = (id) => { const current = entry(id); const done = current.turn; current.turn = null; done?.(); };
  const runtime = {
    kind: 'claude',
    sent: [],
    async start(target) {
      if (failing.has(target.id)) throw new Error('invented start failure');
      entry(target.id);
      return { threadId: target.id };
    },
    state(id) {
      const current = entry(id);
      return { state: current.state, pending: current.pending, lastError: current.lastError, sessionId: null, costUsd: null, cwd: null, model: null };
    },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    send(target, text, context = {}) {
      const current = entry(target.id);
      if (current.state === 'busy' || current.state === 'waiting') return Promise.reject(new RuntimeError('busy'));
      runtime.sent.push({ id: target.id, text, context });
      const done = new Promise((resolve) => { current.turn = resolve; });
      current.from = context.from ?? null;
      current.chain = Array.isArray(context.chain) ? [...context.chain] : [];
      current.lastError = null;
      setState(target.id, 'busy');
      emit('message', target.id, { role: 'user', text, ...(context.routine ? { routine: context.routine } : {}), ...(context.from ? { from: context.from } : {}) });
      return done;
    },
    async interrupt() {},
    async close() {},
    raise(id, { kind = 'approval', toolName = 'Bash', input = { command: 'ls' } } = {}) {
      const current = entry(id);
      const requestId = `req-${nextRequest++}`;
      current.pending = { requestId, kind, toolName, input, at: now().toISOString(), from: current.from, chain: [...current.chain] };
      setState(id, 'waiting');
      emit('request', id, { requestId, kind, toolName, input, from: current.from, chain: [...current.chain] });
      return requestId;
    },
    resolve(id, requestId, outcome) {
      const current = entry(id);
      current.pending = null;
      emit('resolved', id, { requestId, outcome, from: current.from, chain: [...current.chain] });
      setState(id, 'busy');
    },
    finish(id, text = 'Done.') { emit('message', id, { role: 'assistant', text }); setState(id, 'idle'); end(id); },
    fail(id, message = 'Invented failure') { entry(id).lastError = message; emit('error', id, { message }); setState(id, 'error'); end(id); },
    abort(id) { setState(id, 'idle'); end(id); },
    say(id, fields) { emit('message', id, fields); },
  };
  return runtime;
}

async function setup(t, { agents = AGENTS, limits = {}, timeouts = {}, clock = START, failing = [] } = {}) {
  let time = Date.parse(clock);
  const now = () => new Date(time);
  const dir = path.join(await tempDir(t), 'routines');
  const logs = [];
  const log = (entry) => logs.push(entry);
  const allLimits = { ...LIMITS, ...limits };
  const allTimeouts = { ...TIMEOUTS, ...timeouts };
  const routines = createRoutines({ dir, limits: allLimits, log, now });
  await routines.load();
  const runtime = fakeRuntime(now, new Set(failing));
  const threads = [];
  const store = { read: async () => [], append: async (id, message) => { threads.push([id, message]); } };
  const hub = createHub({
    registry: fakeRegistry(agents), jobs: fakeJobs(), routines, timeZone: ZONE,
    focus: { checkHealth: async () => ({ available: true }) }, brief: { latestMetadata: async () => ({ state: 'unknown' }) },
    timeouts: allTimeouts, limits: allLimits, adapters: { claude: runtime }, store, log, now,
  });
  await hub.start();
  t.after(() => hub.close());
  const timers = [];
  let uuid = 0;
  const makeScheduler = () => {
    const scheduler = createScheduler({
      routines, hub, zone: ZONE, timeouts: allTimeouts, limits: allLimits, log, now,
      setTimeout: (fn, ms) => { timers.push({ fn, ms }); return { unref() {} }; }, clearTimeout: () => {},
      randomUUID: () => `run-${++uuid}`,
    });
    t.after(() => scheduler.stop());
    return scheduler;
  };
  const scheduler = makeScheduler();
  const persona = (id) => hub.persona(id).agent;
  return {
    now, routines, runtime, hub, scheduler, makeScheduler, logs, threads, timers, persona,
    set: (iso) => { time = Date.parse(iso); },
    advance: (ms) => { time += ms; },
    view: (id) => hub.snapshot().agents.find((item) => item.id === id),
    runs: (id = 'daily-drift') => routines.runs(id),
    runLogs: () => logs.filter((entry) => entry.event === 'routine_run').map(({ ms, ...rest }) => rest),
  };
}

// Waits for the condition (the store's appends and the hub's notify are
// asynchronous), or 10 ms when there is none; gives up after two seconds.
async function settle(condition = null) {
  const deadline = Date.now() + 2_000;
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, condition ? 2 : 10));
    if (!condition || condition()) return;
    if (Date.now() > deadline) throw new Error('condition did not hold');
  }
}

test('a due occurrence fires once as a send at the agent\'s level with the routine and the prompt, and not again on the next tick', async (t) => {
  const { routines, runtime, scheduler, set, advance, runs, hub, view, runLogs } = await setup(t);
  await routines.create(FIELDS);
  await scheduler.tick();
  assert.equal(runtime.sent.length, 0, 'nothing is due at creation');
  set('2026-10-05T11:30:10.000Z');
  await scheduler.tick();
  assert.deepEqual(runtime.sent, [{
    id: 'cfo', text: 'Compute drift.',
    context: { model: 'opus', effort: 'high', permission: 'full', routine: { id: 'daily-drift', name: 'Daily drift' }, prompt: PROMPT },
  }]);
  await settle(() => runs().length === 1);
  assert.deepEqual(runs(), [{ run: 'run-1', occurrence: MONDAY, trigger: 'schedule', startedAt: '2026-10-05T11:30:10.000Z' }]);
  assert.deepEqual(hub.snapshot().routines.items[0].lastRun, runs()[0]);
  assert.equal(view('cfo').state, 'busy');
  advance(30_000);
  await scheduler.tick();
  assert.equal(runtime.sent.length, 1, 'the marker moved with the start line');
  runtime.finish('cfo', 'Drift is fine.');
  await settle(() => runs()[0]?.endedAt);
  assert.deepEqual(runs(), [{ run: 'run-1', occurrence: MONDAY, trigger: 'schedule', startedAt: '2026-10-05T11:30:10.000Z', endedAt: '2026-10-05T11:30:40.000Z', outcome: 'finished' }]);
  assert.deepEqual(runLogs(), [{ event: 'routine_run', routineId: 'daily-drift', agentId: 'cfo', trigger: 'schedule', outcome: 'finished' }]);
  assert.equal(view('cfo').needsYou, false);
  assert.equal(hub.snapshot().routines.items[0].lastRun.outcome, 'finished');
});

test('occurrences missed since the marker are one line and the latest one runs as a catch-up', async (t) => {
  const { routines, runtime, scheduler, set, runs } = await setup(t);
  await routines.create(FIELDS);
  // Wednesday 07:00 CDT: Monday and Tuesday were missed; Wednesday's is 30 minutes old.
  set('2026-10-07T12:00:00.000Z');
  await scheduler.tick();
  await settle(() => runs().length === 2);
  assert.deepEqual(runs(), [
    { run: 'run-1', occurrence: '2026-10-07T11:30:00.000Z', trigger: 'catchup', startedAt: '2026-10-07T12:00:00.000Z' },
    { outcome: 'missed', count: 2, from: START, to: '2026-10-07T11:30:00.000Z' },
  ]);
  assert.equal(runtime.sent[0].context.routine.id, 'daily-drift');
  assert.equal(routines.marker('daily-drift'), '2026-10-07T11:30:00.000Z');
});

test('a busy agent leaves a busy line, the marker moves, and the fire is not retried', async (t) => {
  const { routines, runtime, scheduler, set, advance, runs, persona, runLogs } = await setup(t);
  await routines.create(FIELDS);
  const held = runtime.send(persona('cfo'), 'Hunter is talking.');
  set('2026-10-05T11:30:10.000Z');
  await scheduler.tick();
  assert.deepEqual(runs(), [{ occurrence: MONDAY, trigger: 'schedule', outcome: 'busy' }]);
  assert.equal(runtime.sent.length, 1);
  assert.equal(routines.marker('daily-drift'), MONDAY);
  advance(30_000);
  await scheduler.tick();
  assert.equal(runs().length, 1);
  assert.deepEqual(runLogs(), [{ event: 'routine_run', routineId: 'daily-drift', agentId: 'cfo', trigger: 'schedule', outcome: 'busy' }]);
  runtime.finish('cfo');
  await held;
});

test('an agent that is not started fails the fire with agent_unavailable; a test run is refused the same way with no line', async (t) => {
  const { routines, runtime, scheduler, set, runs } = await setup(t, { failing: ['cfo'] });
  await routines.create(FIELDS);
  set('2026-10-05T11:30:10.000Z');
  assert.deepEqual(await scheduler.testRun('daily-drift'), { ok: false, reason: 'agent_unavailable' });
  assert.deepEqual(runs(), []);
  await scheduler.tick();
  assert.deepEqual(runs(), [{ occurrence: MONDAY, trigger: 'schedule', outcome: 'failed', detail: 'agent_unavailable' }]);
  assert.equal(runtime.sent.length, 0);
  assert.deepEqual(await scheduler.testRun('nobody'), { ok: false, reason: 'no_such_routine' });
});

test('a card on the run posts one line; left unanswered the run ends waiting and the agent needs you until Hunter writes', async (t) => {
  const { routines, runtime, scheduler, set, advance, runs, threads, view, now } = await setup(t);
  await routines.create(FIELDS);
  set('2026-10-05T11:30:10.000Z');
  await scheduler.tick();
  const first = runtime.raise('cfo', { input: { command: 'ls' } });
  const second = runtime.raise('cfo', { kind: 'question', toolName: 'AskUserQuestion', input: { questions: [{ question: 'Sell the bond fund?', options: [] }] } });
  await settle(() => threads.length === 1);
  assert.deepEqual(threads, [['cfo', {
    role: 'system', kind: 'routine', state: 'waiting', routine: { id: 'daily-drift', name: 'Daily drift' }, agent: 'cfo', toolName: 'Bash',
    summary: 'CFO is waiting for you during Daily drift.', text: '{"command":"ls"}', at: '2026-10-05T11:30:10.000Z',
  }]]);
  assert.equal(view('cfo').lastLineAt, '2026-10-05T11:30:10.000Z');
  assert.equal(view('cfo').state, 'waiting');
  advance(60_000);
  runtime.resolve('cfo', first, 'expired');
  runtime.resolve('cfo', second, 'interrupted');
  runtime.finish('cfo');
  await settle(() => runs()[0]?.endedAt);
  assert.deepEqual(runs()[0], {
    run: 'run-1', occurrence: MONDAY, trigger: 'schedule', startedAt: '2026-10-05T11:30:10.000Z', endedAt: '2026-10-05T11:31:10.000Z', outcome: 'waiting',
    cards: [
      { agent: 'cfo', kind: 'approval', toolName: 'Bash', summary: '{"command":"ls"}', resolved: 'expired' },
      { agent: 'cfo', kind: 'question', toolName: 'AskUserQuestion', summary: 'Sell the bond fund?', resolved: 'interrupted' },
    ],
  });
  assert.equal(view('cfo').needsYou, true);
  assert.equal(threads.length, 1, 'one line per run, not per card');
  // Another agent's message does not answer; Hunter's own does.
  advance(1_000);
  runtime.say('cfo', { role: 'user', text: 'From the Assistant.', from: 'brain' });
  assert.equal(view('cfo').needsYou, true);
  advance(1_000);
  runtime.say('cfo', { role: 'user', text: 'Keep the bond fund.' });
  assert.equal(view('cfo').needsYou, false);
  assert.ok(now().toISOString() > runs()[0].endedAt);
});

test('the same card answered ends the run finished with the card listed as answered', async (t) => {
  const { routines, runtime, scheduler, set, runs, view } = await setup(t);
  await routines.create(FIELDS);
  set('2026-10-05T11:30:10.000Z');
  await scheduler.tick();
  const requestId = runtime.raise('cfo', { input: { command: 'ls' } });
  runtime.resolve('cfo', requestId, 'allowed');
  runtime.finish('cfo');
  await settle(() => runs()[0]?.endedAt);
  assert.equal(runs()[0].outcome, 'finished');
  assert.deepEqual(runs()[0].cards, [{ agent: 'cfo', kind: 'approval', toolName: 'Bash', summary: '{"command":"ls"}', resolved: 'allowed' }]);
  assert.equal(view('cfo').needsYou, false);
});

test('a card on a hop, whose chain starts with the agent, is the run\'s card too', async (t) => {
  const { routines, runtime, scheduler, set, runs, threads, view, persona } = await setup(t);
  await routines.create(FIELDS);
  set('2026-10-05T11:30:10.000Z');
  await scheduler.tick();
  // CFO asks Second brain during the run; Second brain raises on its own turn.
  const hop = runtime.send(persona('brain'), 'Any notes on bonds?', { from: 'cfo', chain: ['cfo'] });
  const requestId = runtime.raise('brain', { toolName: 'Read', input: { file_path: '/vault/bonds.md' } });
  await settle(() => threads.length === 1);
  assert.deepEqual(view('cfo').forwarded.map((card) => [card.requestId, card.agent]), [[requestId, 'brain']]);
  assert.equal(threads.length, 1);
  assert.deepEqual([threads[0][0], threads[0][1].agent, threads[0][1].summary, threads[0][1].text], ['cfo', 'brain', 'Second brain is waiting for you during Daily drift.', '{"file_path":"/vault/bonds.md"}']);
  runtime.resolve('brain', requestId, 'expired');
  runtime.finish('brain', 'Nothing.');
  await hop;
  runtime.finish('cfo');
  await settle(() => runs()[0]?.endedAt);
  assert.equal(runs()[0].outcome, 'waiting');
  assert.deepEqual(runs()[0].cards, [{ agent: 'brain', kind: 'approval', toolName: 'Read', summary: '{"file_path":"/vault/bonds.md"}', resolved: 'expired' }]);
  assert.equal(view('cfo').needsYou, true);
});

test('an error on the agent\'s turn ends the run failed', async (t) => {
  const { routines, runtime, scheduler, set, runs, runLogs } = await setup(t);
  await routines.create(FIELDS);
  set('2026-10-05T11:30:10.000Z');
  await scheduler.tick();
  runtime.fail('cfo');
  await settle(() => runs()[0]?.endedAt);
  assert.equal(runs()[0].outcome, 'failed');
  assert.equal('cards' in runs()[0], false);
  assert.deepEqual(runLogs().map((entry) => entry.outcome), ['failed']);
});

test('stop() leaves an aborted turn\'s start line open, and the next start closes it as interrupted and arms the tick', async (t) => {
  const { routines, runtime, scheduler, makeScheduler, set, advance, runs, timers } = await setup(t);
  await routines.create(FIELDS);
  set('2026-10-05T11:30:10.000Z');
  await scheduler.tick();
  scheduler.stop();
  runtime.abort('cfo');
  await settle();
  assert.deepEqual(runs(), [{ run: 'run-1', occurrence: MONDAY, trigger: 'schedule', startedAt: '2026-10-05T11:30:10.000Z' }]);
  assert.deepEqual(routines.openRuns().map((open) => open.run), ['run-1']);
  advance(5 * 60_000);
  const next = makeScheduler();
  await next.start();
  assert.deepEqual(runs(), [{ run: 'run-1', occurrence: MONDAY, trigger: 'schedule', startedAt: '2026-10-05T11:30:10.000Z', endedAt: '2026-10-05T11:35:10.000Z', outcome: 'interrupted' }]);
  assert.equal(runtime.sent.length, 1, 'the occurrence already ran');
  assert.deepEqual(timers.map((timer) => timer.ms), [TIMEOUTS.routineTickMs]);
  // The timer's tick runs and re-arms.
  await timers[0].fn();
  await settle(() => timers.length === 2);
  assert.equal(timers.length, 2);
  next.stop();
});

test('an inactive routine never fires and logs nothing, and one on an agent that is not a Claude persona is skipped', async (t) => {
  const { routines, runtime, scheduler, set, logs } = await setup(t);
  await routines.create({ ...FIELDS, active: false });
  await routines.create({ ...FIELDS, name: 'Dev notes', agent: 'dev' });
  set('2026-10-07T12:00:00.000Z');
  await scheduler.tick();
  assert.equal(runtime.sent.length, 0);
  assert.deepEqual(routines.runs('daily-drift'), []);
  assert.deepEqual(routines.runs('dev-notes'), []);
  assert.equal(logs.some((entry) => String(entry.event).startsWith('routine_')), false);
});

test('an edit bumps updated, so nothing from before it is due', async (t) => {
  const { routines, runtime, scheduler, set, runs } = await setup(t);
  await routines.create(FIELDS);
  set('2026-10-05T11:30:10.000Z');
  await routines.update('daily-drift', { name: 'Morning drift' });
  await scheduler.tick();
  assert.equal(runtime.sent.length, 0);
  assert.deepEqual(runs(), []);
  set('2026-10-06T11:30:10.000Z');
  await scheduler.tick();
  await settle(() => runs().length === 1);
  assert.equal(runtime.sent.length, 1);
  assert.equal(runs()[0].occurrence, '2026-10-06T11:30:00.000Z');
  assert.equal(runtime.sent[0].context.routine.name, 'Morning drift');
});

test('a test run leaves the marker alone, is refused busy with no line while the agent is busy, and the schedule still fires after it', async (t) => {
  const { routines, runtime, scheduler, set, runs, hub } = await setup(t);
  await routines.create(FIELDS);
  set('2026-10-05T11:10:00.000Z');
  assert.deepEqual(await scheduler.testRun('daily-drift'), { ok: true });
  await settle(() => runs().length === 1);
  assert.deepEqual(runs(), [{ run: 'run-1', occurrence: null, trigger: 'test', startedAt: '2026-10-05T11:10:00.000Z' }]);
  assert.equal(routines.marker('daily-drift'), null);
  assert.deepEqual(await scheduler.testRun('daily-drift'), { ok: false, reason: 'busy' });
  assert.equal(runs().length, 1);
  assert.equal(runtime.sent.length, 1);
  runtime.finish('cfo');
  await settle(() => runs()[0]?.endedAt);
  assert.deepEqual(hub.snapshot().routines.items[0].lastRun, { run: 'run-1', occurrence: null, trigger: 'test', startedAt: '2026-10-05T11:10:00.000Z', endedAt: '2026-10-05T11:10:00.000Z', outcome: 'finished' });
  set('2026-10-05T11:30:10.000Z');
  await scheduler.tick();
  await settle(() => runs().length === 2);
  assert.equal(runtime.sent.length, 2);
  assert.deepEqual(runs()[0], { run: 'run-2', occurrence: MONDAY, trigger: 'schedule', startedAt: '2026-10-05T11:30:10.000Z' });
});

test('the marker never reaches further back than routineCatchupDays, and the missed count stops at routineMissedMax', async (t) => {
  for (const [limits, expected] of [[{}, { count: 6 }], [{ routineMissedMax: 3 }, { count: 3, capped: true }]]) {
    const { routines, runtime, scheduler, set, runs } = await setup(t, { limits, clock: '2026-10-01T12:00:00.000Z' });
    await routines.create({ ...FIELDS, name: 'Noon', schedule: { cron: '0 12 * * *' } });
    // Forty days later: only the last seven count, Nov 4 to Nov 9 missed and Nov 10 due.
    set('2026-11-10T18:00:00.000Z');
    await scheduler.tick();
    await settle(() => runs('noon').length === 2);
    assert.deepEqual(runs('noon'), [
      { run: 'run-1', occurrence: '2026-11-10T18:00:00.000Z', trigger: 'schedule', startedAt: '2026-11-10T18:00:00.000Z' },
      { outcome: 'missed', from: '2026-11-03T18:00:00.000Z', to: '2026-11-10T18:00:00.000Z', ...expected },
    ]);
    assert.equal(runtime.sent.length, 1);
    runtime.finish('cfo');
    await settle(() => runs('noon')[0]?.endedAt);
  }
});

test('a tick is single-flight and a routine removed mid-run still ends without throwing', async (t) => {
  const { routines, runtime, scheduler, set, logs } = await setup(t);
  await routines.create(FIELDS);
  set('2026-10-05T11:30:10.000Z');
  const first = scheduler.tick();
  const second = scheduler.tick();
  assert.equal(first, second);
  await first;
  assert.equal(runtime.sent.length, 1);
  await routines.remove('daily-drift');
  runtime.finish('cfo');
  await settle(() => logs.some((entry) => entry.event === 'routine_run'));
  assert.deepEqual(logs.filter((entry) => entry.event === 'routine_log_error').map((entry) => entry.error), ['no_such_routine']);
  assert.deepEqual(logs.filter((entry) => entry.event === 'routine_run').map((entry) => entry.outcome), ['finished']);
});
