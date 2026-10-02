import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createHub } from '../lib/hub.mjs';
import { RuntimeError } from '../lib/runtime/adapter.mjs';

const REVISION = 'c'.repeat(64);

function fakeRegistry(initial) {
  let current = initial ?? registryState([agent('cfo')]);
  const listeners = new Set();
  return {
    current: () => current,
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    emit(next) {
      current = next;
      for (const fn of listeners) fn(next);
    },
    listenerCount: () => listeners.size,
  };
}

function registryState(agents, { ok = true, error = null } = {}) {
  return Object.freeze({ ok, agents, error, loadedAt: ok ? '2026-09-25T12:00:00.000Z' : null, path: '/invented/agents.json' });
}

function agent(id, extra = {}) {
  return Object.freeze({
    id, name: id.toUpperCase(), role: 'Role', description: 'Invented.', group: 'work', kind: 'persona',
    cwd: '/invented', provider: 'claude', jobs: ['com.invented.job'], ...extra,
  });
}

function fakeStatus({ available = true, metadata = { state: 'ready', date: '2026-09-25', revision: REVISION } } = {}) {
  const calls = { health: 0, latest: 0 };
  const deps = {
    focus: { checkHealth: async () => { calls.health += 1; return { available: deps.available }; } },
    brief: { latestMetadata: async () => { calls.latest += 1; return deps.metadata; } },
    available,
    metadata,
    calls,
  };
  return deps;
}

function fakeJobs(result = { refreshedAt: '2026-09-25T12:00:00.000Z', focusAvailable: true, jobs: [{ label: 'com.invented.job' }] }) {
  const jobs = {
    calls: 0,
    signals: [],
    gate: null,
    async refresh({ signal } = {}) {
      jobs.calls += 1;
      jobs.signals.push(signal);
      if (jobs.gate) await jobs.gate;
      if (jobs.fail) throw new Error('invented failure');
      return result;
    },
  };
  return jobs;
}

function makeHub(overrides = {}) {
  const status = overrides.status ?? fakeStatus();
  const logs = [];
  const hub = createHub({
    registry: overrides.registry ?? fakeRegistry(),
    jobs: overrides.jobs ?? fakeJobs(),
    focus: status.focus,
    brief: status.brief,
    timeouts: { statusMs: 200, turnMaxMs: overrides.turnMaxMs ?? 60_000 },
    limits: { requestInputBytes: 64, previewChars: 10 },
    adapters: overrides.adapters ?? {},
    store: overrides.store ?? null,
    cmux: overrides.cmux ?? null,
    adaptersDisabled: overrides.adaptersDisabled ?? null,
    settings: overrides.settings ?? null,
    routines: overrides.routines ?? null,
    log: (entry) => logs.push(entry),
    now: () => new Date(overrides.now ?? '2026-09-25T12:00:00.000Z'),
  });
  const deltas = [];
  hub.subscribe((delta) => deltas.push(delta));
  return { hub, status, logs, deltas };
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

test('the initial snapshot is frozen, carries agent cwd and job count, and omits jobs', () => {
  const { hub } = makeHub();
  const snapshot = hub.snapshot();
  assert.equal(snapshot.revision, 1);
  assert.equal(snapshot.updatedAt, '2026-09-25T12:00:00.000Z');
  assert.deepEqual(snapshot.focus, { available: null });
  assert.deepEqual(snapshot.brief, { state: 'unknown' });
  assert.deepEqual(snapshot.registry, { ok: true, error: null, loadedAt: '2026-09-25T12:00:00.000Z' });
  assert.deepEqual(snapshot.agents, [
    {
      id: 'cfo', name: 'CFO', role: 'Role', description: 'Invented.', group: 'work', kind: 'persona', cwd: '/invented', jobs: 1,
      provider: 'claude', state: 'unavailable', pending: null, forwarded: [], needsYou: false, lastMessage: null, lastError: null, costUsd: null, lastLineAt: null,
      model: { id: null, effort: null, source: 'default', default: { id: null, effort: null }, agent: { id: null, effort: null } },
      permission: { level: 'ask', source: 'system', agent: null, default: 'ask' }, accepts: null,
    },
  ]);
  assert.deepEqual(snapshot.jobs, { refreshedAt: null, focusAvailable: null, refreshing: false, error: null, items: [] });
  assert.deepEqual(snapshot.settings, { ok: true, error: null, model: { default: null, effort: null }, brief: { agent: null }, permission: { default: 'ask' } });
  assert.deepEqual(snapshot.models.map((m) => m.id), ['fable', 'opus', 'sonnet', 'haiku']);
  assert.ok(Object.isFrozen(snapshot) && Object.isFrozen(snapshot.agents[0]) && Object.isFrozen(snapshot.jobs));
  assert.ok(Object.isFrozen(snapshot.settings) && Object.isFrozen(snapshot.models));
});

// A settings store stand-in: current() answers the given values and
// `set(patch)` changes them and notifies, as an update would.
function fakeSettingsStore(initial = {}, { ok = true, error = null } = {}) {
  const listeners = new Set();
  let settings = { version: 1, model: { default: null, effort: null, ...initial.model }, brief: { agent: null, ...initial.brief }, permission: { default: 'ask', ...initial.permission } };
  let state = { ok, error, settings };
  return {
    current: () => state,
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    set(patch, meta = {}) {
      settings = { version: 1, model: { ...settings.model, ...patch.model }, brief: { ...settings.brief, ...patch.brief }, permission: { ...settings.permission, ...patch.permission } };
      state = { ok: meta.ok ?? true, error: meta.error ?? null, settings };
      for (const fn of listeners) fn(state);
    },
    listenerCount: () => listeners.size,
  };
}

test('a Claude persona\'s model resolves agent over system, each field on its own, and names the level', () => {
  const settings = fakeSettingsStore({ model: { default: 'sonnet', effort: 'low' }, brief: { agent: 'cfo' } });
  const registry = fakeRegistry(registryState([
    agent('cfo'),
    agent('ops', { model: 'opus' }),
    agent('scribe', { provider: 'codex' }),
    agent('tool', { kind: 'system', provider: undefined }),
  ]));
  const { hub } = makeHub({ registry, settings });
  const view = (id) => hub.snapshot().agents.find((a) => a.id === id);
  assert.deepEqual(view('cfo').model, { id: 'sonnet', effort: 'low', source: 'system', default: { id: 'sonnet', effort: 'low' }, agent: { id: null, effort: null } });
  assert.deepEqual(view('ops').model, { id: 'opus', effort: 'low', source: 'agent', default: { id: 'opus', effort: 'low' }, agent: { id: 'opus', effort: null } });
  assert.equal('model' in view('scribe'), false);
  assert.equal('model' in view('tool'), false);
  assert.equal(view('scribe').accepts, null, 'a Codex persona is messageable too');
  assert.equal('accepts' in view('tool'), false);
  assert.deepEqual(hub.snapshot().settings, {
    ok: true, error: null, model: { default: 'sonnet', effort: 'low' }, brief: { agent: 'cfo' }, permission: { default: 'ask' },
  });
  assert.deepEqual(hub.modelFor('cfo'), { id: 'sonnet', effort: 'low' });
  assert.deepEqual(hub.modelFor('ops'), { id: 'opus', effort: 'low' });
  assert.deepEqual(hub.modelFor('scribe'), { id: null, effort: null });
  assert.deepEqual(hub.modelFor('nobody'), { id: null, effort: null });

  // Nothing set anywhere: Claude Code's default, and the adapter gets nulls.
  settings.set({ model: { default: null, effort: null } });
  assert.deepEqual(view('cfo').model, { id: null, effort: null, source: 'default', default: { id: null, effort: null }, agent: { id: null, effort: null } });
  assert.deepEqual(view('ops').model, { id: 'opus', effort: null, source: 'agent', default: { id: 'opus', effort: null }, agent: { id: 'opus', effort: null } });
  assert.deepEqual(hub.modelFor('cfo'), { id: null, effort: null });
});

test('a settings change commits settings and the agent views that moved, and nothing when neither did', () => {
  const settings = fakeSettingsStore();
  const { hub, deltas } = makeHub({ settings });
  settings.set({ model: { effort: 'high' } });
  assert.equal(hub.snapshot().revision, 2);
  assert.deepEqual(deltas.map((d) => Object.keys(d.patch).sort()), [['agents', 'settings']]);
  assert.deepEqual(deltas[0].patch.agents[0].model, { id: null, effort: 'high', source: 'system', default: { id: null, effort: 'high' }, agent: { id: null, effort: null } });
  assert.equal(deltas[0].patch.settings.model.effort, 'high');

  settings.set({ brief: { agent: 'cfo' } });
  assert.deepEqual(Object.keys(deltas[1].patch), ['settings']);
  assert.equal(hub.snapshot().settings.brief.agent, 'cfo');

  settings.set({ brief: { agent: 'cfo' } });
  assert.equal(deltas.length, 2);

  // An unreadable file keeps the last good values and says so.
  settings.set({}, { ok: false, error: 'settings_invalid_json' });
  assert.deepEqual(hub.snapshot().settings, {
    ok: false, error: 'settings_invalid_json', model: { default: null, effort: 'high' }, brief: { agent: 'cfo' }, permission: { default: 'ask' },
  });

  hub.close();
  assert.equal(settings.listenerCount(), 0);
});

test('a Claude persona\'s permission resolves agent over system, permissionFor carries it, and a settings change re-resolves', () => {
  const settings = fakeSettingsStore({ permission: { default: 'ask' } });
  const registry = fakeRegistry(registryState([
    agent('cfo'),
    agent('ops', { permission: 'full' }),
    agent('scribe', { provider: 'codex', permission: 'auto' }),
    agent('tool', { kind: 'system', provider: undefined }),
  ]));
  const { hub, deltas } = makeHub({ registry, settings });
  const view = (id) => hub.snapshot().agents.find((a) => a.id === id);
  assert.deepEqual(view('cfo').permission, { level: 'ask', source: 'system', agent: null, default: 'ask' });
  assert.deepEqual(view('ops').permission, { level: 'full', source: 'agent', agent: 'full', default: 'ask' });
  assert.equal('permission' in view('scribe'), false, 'a Codex persona has no level; the key is ignored');
  assert.equal('permission' in view('tool'), false);
  assert.equal(hub.snapshot().settings.permission.default, 'ask');
  assert.equal(hub.permissionFor('cfo'), 'ask');
  assert.equal(hub.permissionFor('ops'), 'full');
  assert.equal(hub.permissionFor('scribe'), null);
  assert.equal(hub.permissionFor('tool'), null);
  assert.equal(hub.permissionFor('nobody'), null);

  // The system default moves without a restart; an agent's own level holds.
  settings.set({ permission: { default: 'auto' } });
  assert.deepEqual(deltas.at(-1).patch.settings.permission, { default: 'auto' });
  assert.deepEqual(view('cfo').permission, { level: 'auto', source: 'system', agent: null, default: 'auto' });
  assert.deepEqual(view('ops').permission, { level: 'full', source: 'agent', agent: 'full', default: 'auto' });
  assert.equal(hub.permissionFor('cfo'), 'auto');
  assert.equal(hub.permissionFor('ops'), 'full');
});

test('a registry change bumps the revision with a registry and agents patch', () => {
  const registry = fakeRegistry();
  const { hub, deltas } = makeHub({ registry });
  registry.emit(registryState([agent('cfo'), agent('ops', { kind: 'system', provider: undefined })]));
  assert.equal(hub.snapshot().revision, 2);
  assert.deepEqual(deltas.map((d) => [d.revision, Object.keys(d.patch).sort()]), [[2, ['agents', 'groups', 'registry', 'routines']]]);
  assert.deepEqual(deltas[0].patch.groups, []);
  assert.deepEqual(deltas[0].patch.agents.map((a) => a.id), ['cfo', 'ops']);
  assert.equal('provider' in deltas[0].patch.agents[1], false);
  assert.equal(deltas[0].patch.agents[1].cwd, '/invented');
  // The view carries the count, never the labels.
  assert.equal(deltas[0].patch.agents[1].jobs, 1);

  // An entry with no cwd and no jobs.
  registry.emit(registryState([agent('bare', { cwd: undefined, jobs: undefined })]));
  assert.equal(hub.snapshot().agents[0].cwd, null);
  assert.equal(hub.snapshot().agents[0].jobs, 0);

  registry.emit(registryState([agent('cfo')], { ok: false, error: 'registry_invalid_json' }));
  assert.deepEqual(hub.snapshot().registry, { ok: false, error: 'registry_invalid_json', loadedAt: null });
  assert.equal(hub.snapshot().revision, 4);
});

test('the snapshot carries the registry group list and a pinned persona', () => {
  const registry = fakeRegistry();
  const { hub } = makeHub({ registry });
  const groups = Object.freeze([Object.freeze({ id: 'work', name: 'Work' }), Object.freeze({ id: 'family', name: 'Family' })]);
  registry.emit(Object.freeze({ ...registryState([agent('assistant', { pinned: true }), agent('cfo')]), groups }));
  const snapshot = hub.snapshot();
  assert.deepEqual(snapshot.groups, [{ id: 'work', name: 'Work' }, { id: 'family', name: 'Family' }]);
  assert.equal(snapshot.agents[0].pinned, true);
  assert.equal('pinned' in snapshot.agents[1], false);
  assert.ok(Object.isFrozen(snapshot.groups));
});

test('a status change bumps once with focus and brief in the patch', async () => {
  const { hub, deltas } = makeHub();
  await hub.refreshStatus();
  assert.equal(hub.snapshot().revision, 2);
  assert.deepEqual(deltas, [{
    revision: 2,
    patch: { focus: { available: true }, brief: { state: 'ready', date: '2026-09-25', revision: REVISION } },
  }]);
});

test('a quiet status refresh does not bump', async () => {
  const { hub, deltas } = makeHub();
  await hub.refreshStatus();
  await hub.refreshStatus();
  assert.equal(hub.snapshot().revision, 2);
  assert.equal(deltas.length, 1);
});

test('only the status part that changed is in the patch', async () => {
  const { hub, status, deltas } = makeHub();
  await hub.refreshStatus();
  status.available = false;
  await hub.refreshStatus();
  assert.deepEqual(deltas[1], { revision: 3, patch: { focus: { available: false } } });
});

test('status copies only non-content brief fields and reports failures as unavailable', async () => {
  const status = fakeStatus({ metadata: { state: 'ready', date: '2026-02-30', revision: 'nope', text: 'invented content' } });
  const { hub } = makeHub({ status });
  await hub.refreshStatus();
  assert.deepEqual(hub.snapshot().brief, { state: 'ready' });

  const failing = {
    focus: { checkHealth: () => { throw new Error('sync'); } },
    brief: { latestMetadata: () => Promise.reject(new Error('async')) },
  };
  const other = makeHub({ status: failing });
  await other.hub.refreshStatus();
  assert.deepEqual([other.hub.snapshot().focus, other.hub.snapshot().brief], [{ available: false }, { state: 'unavailable' }]);
});

test('concurrent status refreshes share one run', async () => {
  const { hub, status } = makeHub();
  await Promise.all([hub.refreshStatus(), hub.refreshStatus(), hub.refreshStatus()]);
  assert.deepEqual(status.calls, { health: 1, latest: 1 });
  await hub.refreshStatus();
  assert.deepEqual(status.calls, { health: 2, latest: 2 });
});

test('an aborted caller stops waiting without aborting the shared status run', async () => {
  const gate = deferred();
  const status = {
    focus: { checkHealth: async () => { await gate.promise; return { available: true }; } },
    brief: { latestMetadata: async () => ({ state: 'empty' }) },
  };
  const { hub } = makeHub({ status });
  const controller = new AbortController();
  const first = hub.refreshStatus({ signal: controller.signal });
  const second = hub.refreshStatus();
  controller.abort();
  await first;
  assert.equal(hub.snapshot().revision, 1);
  gate.resolve();
  await second;
  assert.deepEqual(hub.snapshot().focus, { available: true });
});

test('a jobs refresh bumps for refreshing and again for the result', async () => {
  const { hub, deltas } = makeHub();
  await hub.refreshJobs();
  assert.deepEqual(deltas.map((d) => [d.revision, Object.keys(d.patch)]), [[2, ['jobs']], [3, ['jobs']]]);
  assert.equal(deltas[0].patch.jobs.refreshing, true);
  assert.deepEqual(hub.snapshot().jobs, {
    refreshedAt: '2026-09-25T12:00:00.000Z',
    focusAvailable: true,
    refreshing: false,
    error: null,
    items: [{ label: 'com.invented.job' }],
  });
});

test('concurrent jobs refreshes share one call and pass the first signal through', async () => {
  const jobs = fakeJobs();
  const gate = deferred();
  jobs.gate = gate.promise;
  const { hub } = makeHub({ jobs });
  const controller = new AbortController();
  const both = Promise.all([hub.refreshJobs({ signal: controller.signal }), hub.refreshJobs()]);
  assert.equal(hub.snapshot().jobs.refreshing, true);
  gate.resolve();
  await both;
  assert.equal(jobs.calls, 1);
  assert.equal(jobs.signals[0], controller.signal);
  await hub.refreshJobs();
  assert.equal(jobs.calls, 2);
});

test('a failed jobs refresh records the error, logs it, and resolves', async () => {
  const jobs = fakeJobs();
  const { hub, logs } = makeHub({ jobs });
  await hub.refreshJobs();
  jobs.fail = true;
  await hub.refreshJobs();
  const current = hub.snapshot().jobs;
  assert.equal(current.refreshing, false);
  assert.equal(current.error, 'refresh_failed');
  assert.deepEqual(current.items, [{ label: 'com.invented.job' }]);
  assert.ok(logs.some((entry) => entry.event === 'jobs_error' && typeof entry.error === 'string'));
  jobs.fail = false;
  await hub.refreshJobs();
  assert.equal(hub.snapshot().jobs.error, null);
});

test('subscribe returns an unsubscribe and clientCount tracks live subscribers', async () => {
  const { hub } = makeHub();
  assert.equal(hub.clientCount(), 1);
  const seen = [];
  const unsubscribe = hub.subscribe((delta) => seen.push(delta.revision));
  assert.equal(hub.clientCount(), 2);
  await hub.refreshStatus();
  unsubscribe();
  assert.equal(hub.clientCount(), 1);
  await hub.refreshJobs();
  assert.deepEqual(seen, [2]);
});

test('a throwing listener is logged and the others still run', async () => {
  const { hub, logs, deltas } = makeHub();
  hub.subscribe(() => { throw new Error('invented listener failure'); });
  const after = [];
  hub.subscribe((delta) => after.push(delta.revision));
  await hub.refreshStatus();
  assert.deepEqual([deltas.length, after], [1, [2]]);
  assert.equal(logs.filter((entry) => entry.event === 'hub_listener_error').length, 1);
});

test('close drops subscribers and stops following the registry', () => {
  const registry = fakeRegistry();
  const { hub, deltas } = makeHub({ registry });
  assert.equal(registry.listenerCount(), 1);
  hub.close();
  assert.equal(hub.clientCount(), 0);
  assert.equal(registry.listenerCount(), 0);
  registry.emit(registryState([]));
  assert.equal(hub.snapshot().revision, 1);
  assert.equal(deltas.length, 0);
});

// An adapter stand-in: state() answers from `states`, emit() plays an event,
// and every start, interrupt, and unsubscribe is recorded.
function fakeAdapter(states = {}) {
  const listeners = new Set();
  const adapter = {
    calls: [],
    states,
    start: async (agent) => { adapter.calls.push(['start', agent.id]); return { threadId: agent.id }; },
    interrupt: async (agent) => { adapter.calls.push(['interrupt', agent.id]); },
    state: (id) => ({ state: 'idle', pending: null, lastError: null, sessionId: null, costUsd: null, ...adapter.states[id] }),
    subscribe(fn) {
      listeners.add(fn);
      return () => { adapter.calls.push(['unsubscribe']); listeners.delete(fn); };
    },
    emit(type, agentId, fields = {}) {
      for (const fn of [...listeners]) fn({ type, agentId, at: '2026-09-25T12:01:00.000Z', ...fields });
    },
    listenerCount: () => listeners.size,
  };
  return adapter;
}

const persona = (hub, id = 'cfo') => hub.snapshot().agents.find((entry) => entry.id === id);

test('start seeds a persona from its adapter and the last cached message', async () => {
  const adapter = fakeAdapter({ cfo: { state: 'error', lastError: 'Invented failure', costUsd: 0.5 } });
  const store = { read: async () => [{ role: 'user', text: 'first', at: 'a' }, { role: 'assistant', text: 'Invented reply text', at: 'b' }] };
  const registry = fakeRegistry(registryState([agent('cfo'), agent('ops', { kind: 'system', provider: undefined })]));
  const { hub, deltas } = makeHub({ adapters: { claude: adapter }, store, registry });
  assert.equal(persona(hub).state, 'unavailable');
  await hub.start();
  assert.deepEqual(adapter.calls, [['start', 'cfo']]);
  assert.deepEqual(persona(hub), {
    id: 'cfo', name: 'CFO', role: 'Role', description: 'Invented.', group: 'work', kind: 'persona', cwd: '/invented', jobs: 1,
    provider: 'claude', state: 'error', pending: null, forwarded: [], needsYou: false, lastMessage: { role: 'assistant', text: 'Invented r', at: 'b' },
    lastError: 'Invented failure', costUsd: 0.5, lastLineAt: null,
    model: { id: null, effort: null, source: 'default', default: { id: null, effort: null }, agent: { id: null, effort: null } },
    permission: { level: 'ask', source: 'system', agent: null, default: 'ask' }, accepts: null,
  });
  assert.equal(persona(hub, 'ops').state, null);
  assert.equal('pending' in persona(hub, 'ops'), false);
  assert.deepEqual(deltas.map((d) => Object.keys(d.patch)), [['agents']]);
  assert.equal(hub.persona('cfo').agent.cwd, '/invented');
  assert.equal(hub.persona('cfo').adapter, adapter);
  assert.equal(hub.persona('ops'), null);
  assert.equal(hub.persona('nobody'), null);
});

test('a persona whose provider has no adapter is unavailable with the reason', async () => {
  const { hub } = makeHub();
  await hub.start();
  assert.equal(persona(hub).state, 'unavailable');
  assert.equal(persona(hub).lastError, 'provider_unavailable');
  assert.equal(hub.persona('cfo'), null);

  const disabled = makeHub({ adaptersDisabled: 'api_key_in_env' });
  await disabled.hub.start();
  assert.equal(persona(disabled.hub).lastError, 'api_key_in_env');
  assert.deepEqual(disabled.hub.snapshot().codex, { available: false, reason: 'api_key_in_env' });
});

test('a persona whose adapter fails to start is unavailable and logged', async () => {
  const adapter = fakeAdapter();
  adapter.start = async () => { throw new Error('invented unreadable pointer'); };
  const { hub, logs } = makeHub({ adapters: { claude: adapter } });
  await hub.start();
  assert.deepEqual([persona(hub).state, persona(hub).lastError], ['unavailable', 'start_failed']);
  const logged = logs.find((entry) => entry.event === 'persona_start_error' && entry.agentId === 'cfo');
  assert.deepEqual([logged.reason, logged.error], ['start_failed', 'invented unreadable pointer']);
  assert.equal(hub.persona('cfo'), null);
});

test('a persona whose SDK cannot be loaded is unavailable as sdk_unavailable with the cause logged', async () => {
  const adapter = fakeAdapter();
  adapter.start = async () => {
    throw new RuntimeError('sdk_unavailable', { cause: new Error(`Cannot find package ${'x'.repeat(600)}`) });
  };
  const { hub, logs } = makeHub({ adapters: { claude: adapter } });
  await hub.start();
  assert.deepEqual([persona(hub).state, persona(hub).lastError], ['unavailable', 'sdk_unavailable']);
  const logged = logs.find((entry) => entry.event === 'persona_start_error' && entry.agentId === 'cfo');
  assert.equal(logged.reason, 'sdk_unavailable');
  assert.ok(logged.error.startsWith('Cannot find package'));
  assert.equal(logged.error.length, 500);
  assert.equal(hub.persona('cfo'), null);
});

test('adapter events map onto the persona and each bumps the revision with an agents patch', async () => {
  const adapter = fakeAdapter();
  const { hub, deltas } = makeHub({ adapters: { claude: adapter } });
  await hub.start();
  deltas.length = 0;

  adapter.states.cfo = { state: 'busy' };
  adapter.emit('thread.state', 'cfo', { state: 'busy' });
  assert.equal(persona(hub).state, 'busy');

  adapter.emit('message', 'cfo', { role: 'assistant', text: 'A long invented answer' });
  assert.deepEqual(persona(hub).lastMessage, { role: 'assistant', text: 'A long inv', at: '2026-09-25T12:01:00.000Z' });

  const input = { questions: [{ question: 'Pick?', options: [] }] };
  adapter.states.cfo = { state: 'waiting', pending: { requestId: 'r1', kind: 'question', toolName: 'AskUserQuestion', input } };
  adapter.emit('request', 'cfo', { requestId: 'r1', kind: 'question', toolName: 'AskUserQuestion', input });
  assert.deepEqual(persona(hub).pending, { requestId: 'r1', kind: 'question', toolName: 'AskUserQuestion', input, truncated: false });

  adapter.states.cfo = { state: 'waiting', pending: null };
  adapter.emit('resolved', 'cfo', { requestId: 'r1', outcome: 'answered' });
  assert.equal(persona(hub).pending, null);

  adapter.emit('usage', 'cfo', { usage: {}, costUsd: 1.25, denials: [] });
  assert.equal(persona(hub).costUsd, 1.25);

  adapter.emit('error', 'cfo', { message: 'Invented error' });
  assert.equal(persona(hub).lastError, 'Invented error');

  adapter.emit('message', 'someone-else', { role: 'user', text: 'ignored' });
  assert.equal(deltas.length, 6);
  assert.ok(deltas.every((d) => Object.keys(d.patch).join() === 'agents'));
  assert.deepEqual(deltas.map((d) => d.revision), [3, 4, 5, 6, 7, 8]);
});

// A request raised while answering a delegation: `chain[0]` is the thread
// the exchange started in, and the hub lists the card there as `forwarded`.
const relayed = (requestId, extra = {}) => ({ requestId, kind: 'approval', toolName: 'Bash', input: { command: 'ls' }, from: 'assistant', chain: ['assistant'], ...extra });
const projected = (requestId, agent = 'cfo') => ({ requestId, kind: 'approval', toolName: 'Bash', input: '{"command":"ls"}', truncated: false, agent });

async function relayHub(overrides = {}) {
  const adapter = fakeAdapter();
  const registry = fakeRegistry(registryState([agent('assistant'), agent('cfo'), agent('brain')]));
  const made = makeHub({ adapters: { claude: adapter }, registry, ...overrides });
  await made.hub.start();
  return { ...made, adapter, registry };
}

test('a request with a chain is forwarded to the thread the exchange started in, and resolved clears it', async () => {
  const { hub, adapter, deltas } = await relayHub();
  adapter.states.cfo = { state: 'waiting', pending: relayed('r1') };
  adapter.emit('thread.state', 'cfo', { state: 'waiting' });
  adapter.emit('request', 'cfo', relayed('r1'));
  // The owner's card is as before; the origin lists it with the owner's id and keeps its own state.
  assert.deepEqual(persona(hub).pending, { requestId: 'r1', kind: 'approval', toolName: 'Bash', input: '{"command":"ls"}', truncated: false });
  assert.deepEqual(persona(hub, 'assistant').forwarded, [projected('r1')]);
  assert.deepEqual([persona(hub, 'assistant').state, persona(hub, 'assistant').pending], ['idle', null]);
  assert.deepEqual(persona(hub, 'cfo').forwarded, []);
  assert.deepEqual(persona(hub, 'brain').forwarded, []);
  assert.equal(hub.requestOwner('assistant', 'r1'), 'cfo');
  assert.equal(hub.requestOwner('cfo', 'r1'), null, 'its own request');
  assert.equal(hub.requestOwner('assistant', 'nope'), null);

  // Two open relays list oldest first; a truncated input is cut on the relayed copy too.
  const long = relayed('r2', { input: { command: 'é'.repeat(100) } });
  adapter.emit('request', 'cfo', long);
  const list = persona(hub, 'assistant').forwarded;
  assert.deepEqual(list.map((item) => item.requestId), ['r1', 'r2']);
  assert.equal(list[1].truncated, true);
  assert.ok(Buffer.byteLength(list[1].input) <= 64);
  assert.equal(list[1].agent, 'cfo');

  adapter.states.cfo = { state: 'waiting', pending: relayed('r2') };
  adapter.emit('resolved', 'cfo', { requestId: 'r1', outcome: 'allowed', from: 'assistant', chain: ['assistant'] });
  assert.deepEqual(persona(hub, 'assistant').forwarded.map((item) => item.requestId), ['r2']);
  assert.equal(hub.requestOwner('assistant', 'r1'), null);
  adapter.states.cfo = { state: 'busy', pending: null };
  adapter.emit('resolved', 'cfo', { requestId: 'r2', outcome: 'interrupted', from: 'assistant', chain: ['assistant'] });
  assert.deepEqual(persona(hub, 'assistant').forwarded, []);
  assert.equal(persona(hub).pending, null);
  assert.ok(deltas.every((d) => Object.keys(d.patch).join() === 'agents'));
});

test('a relay is dropped when its owner errors, when the registry drops either side, by dropRelaysTo, and for an owner whose entry is gone', async () => {
  const { hub, adapter, registry, logs } = await relayHub();
  const raise = (id) => adapter.emit('request', 'cfo', relayed(id));

  // The owner's turn fails: its requests are dead.
  raise('r1');
  adapter.states.cfo = { state: 'error', lastError: 'Invented failure', pending: null };
  adapter.emit('thread.state', 'cfo', { state: 'error' });
  assert.deepEqual(persona(hub, 'assistant').forwarded, []);
  assert.equal(hub.requestOwner('assistant', 'r1'), null);

  // New thread on the origin clears its list; the owner's card stays.
  adapter.states.cfo = { state: 'waiting', pending: relayed('r2') };
  raise('r2');
  hub.dropRelaysTo('assistant');
  assert.deepEqual(persona(hub, 'assistant').forwarded, []);
  assert.equal(persona(hub).pending?.requestId, 'r2');
  assert.equal(hub.requestOwner('assistant', 'r2'), null);

  // A chain whose origin is no started persona is not relayed, and logged.
  adapter.emit('request', 'cfo', relayed('r3', { chain: ['ghost'] }));
  assert.deepEqual(persona(hub, 'assistant').forwarded, []);
  assert.deepEqual(logs.filter((entry) => entry.event === 'relay_dropped'), [{ event: 'relay_dropped', agentId: 'cfo', origin: 'ghost', requestId: 'r3' }]);

  // The registry drops the owner.
  raise('r4');
  assert.equal(persona(hub, 'assistant').forwarded.length, 1);
  registry.emit(registryState([agent('assistant'), agent('brain')]));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(persona(hub, 'assistant').forwarded, []);
  assert.equal(hub.requestOwner('assistant', 'r4'), null);

  // A resolved whose agent is no longer an entry still clears the origin's card, and commits.
  registry.emit(registryState([agent('assistant'), agent('cfo'), agent('brain')]));
  await new Promise((resolve) => setImmediate(resolve));
  raise('r5');
  assert.equal(persona(hub, 'assistant').forwarded.length, 1);
  const before = hub.snapshot().revision;
  adapter.emit('resolved', 'someone-else', { requestId: 'r5', outcome: 'answered', from: 'assistant', chain: ['assistant'] });
  assert.deepEqual(persona(hub, 'assistant').forwarded, []);
  assert.ok(hub.snapshot().revision > before);

  // The registry drops the origin.
  raise('r6');
  assert.equal(hub.requestOwner('assistant', 'r6'), 'cfo');
  registry.emit(registryState([agent('cfo'), agent('brain')]));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(hub.requestOwner('assistant', 'r6'), null);
});

test('a new turn clears a stale error through the adapter state', async () => {
  const adapter = fakeAdapter({ cfo: { state: 'error', lastError: 'Old failure', costUsd: 2 } });
  const { hub } = makeHub({ adapters: { claude: adapter } });
  await hub.start();
  adapter.states.cfo = { state: 'busy', lastError: null, costUsd: 2 };
  adapter.emit('thread.state', 'cfo', { state: 'busy' });
  assert.deepEqual([persona(hub).state, persona(hub).lastError, persona(hub).costUsd], ['busy', null, 2]);
});

test('approval input is shown as JSON text, cut to the limit and flagged when too long; questions stay whole', async () => {
  const adapter = fakeAdapter();
  const { hub } = makeHub({ adapters: { claude: adapter } });
  await hub.start();
  adapter.emit('request', 'cfo', { requestId: 'r1', kind: 'approval', toolName: 'Bash', input: { command: 'ls' } });
  assert.deepEqual(persona(hub).pending, {
    requestId: 'r1', kind: 'approval', toolName: 'Bash', input: '{"command":"ls"}', truncated: false,
  });
  const long = { command: 'é'.repeat(100) };
  adapter.emit('request', 'cfo', { requestId: 'r2', kind: 'approval', toolName: 'Bash', input: long });
  const pending = persona(hub).pending;
  assert.equal(pending.truncated, true);
  assert.ok(Buffer.byteLength(pending.input) <= 64);
  assert.ok(JSON.stringify(long).startsWith(pending.input));
  // A question over the cap is never cut: each question and option must
  // reach the client for it to be answerable.
  const question = {
    questions: [
      { question: 'x'.repeat(100), header: 'One', options: [{ label: 'A', description: 'y'.repeat(100) }, { label: 'B', description: 'z' }] },
      { question: 'Second?', header: 'Two', options: [{ label: 'C', description: 'w'.repeat(100) }] },
    ],
  };
  assert.ok(Buffer.byteLength(JSON.stringify(question)) > 64);
  adapter.emit('request', 'cfo', { requestId: 'r3', kind: 'question', toolName: 'AskUserQuestion', input: question });
  assert.deepEqual(persona(hub).pending, { requestId: 'r3', kind: 'question', toolName: 'AskUserQuestion', input: question, truncated: false });
  assert.notEqual(persona(hub).pending.input, question);
  assert.equal(Object.isFrozen(question), false);
});

test('a registry change starts a new persona, drops a removed one, and keeps existing state', async () => {
  const adapter = fakeAdapter({ cfo: { state: 'error', lastError: 'Kept' } });
  const registry = fakeRegistry();
  const { hub, logs } = makeHub({ adapters: { claude: adapter }, registry });
  await hub.start();
  registry.emit(registryState([agent('cfo', { name: 'Renamed' }), agent('coach')]));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(adapter.calls, [['start', 'cfo'], ['start', 'coach']]);
  assert.deepEqual([persona(hub).name, persona(hub).lastError], ['Renamed', 'Kept']);
  assert.equal(persona(hub, 'coach').state, 'idle');
  assert.ok(hub.persona('coach'));
  assert.equal(logs.some((entry) => entry.event === 'persona_cwd_changed'), false);

  // A cwd change is logged and nothing else: the pointer and state are kept.
  registry.emit(registryState([agent('cfo', { name: 'Renamed', cwd: '/invented/moved' }), agent('coach')]));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(logs.filter((entry) => entry.event === 'persona_cwd_changed'), [{ event: 'persona_cwd_changed', agentId: 'cfo' }]);
  assert.equal(hub.persona('cfo').agent.cwd, '/invented/moved');
  assert.equal(persona(hub).lastError, 'Kept');
  assert.equal(adapter.calls.length, 2);

  registry.emit(registryState([agent('coach')]));
  assert.equal(hub.persona('cfo'), null);
  assert.deepEqual(hub.snapshot().agents.map((entry) => entry.id), ['coach']);
});

test('a turn over the wall clock is interrupted, logged, and marked turn_timeout; idle clears the clock', async () => {
  const adapter = fakeAdapter();
  // The real adapter goes idle (clearing lastError) before interrupt resolves.
  adapter.interrupt = async (agent) => {
    adapter.calls.push(['interrupt', agent.id]);
    adapter.states.cfo = { state: 'idle', lastError: null };
    adapter.emit('thread.state', 'cfo', { state: 'idle' });
  };
  const { hub, logs, deltas } = makeHub({ adapters: { claude: adapter }, turnMaxMs: 20 });
  await hub.start();
  adapter.emit('thread.state', 'cfo', { state: 'busy' });
  adapter.emit('thread.state', 'cfo', { state: 'waiting' });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(adapter.calls.filter((call) => call[0] === 'interrupt'), [['interrupt', 'cfo']]);
  assert.ok(logs.some((entry) => entry.event === 'persona_turn_timeout' && entry.agentId === 'cfo'));
  assert.deepEqual([persona(hub).state, persona(hub).lastError], ['idle', 'turn_timeout']);
  assert.equal(deltas.at(-1).patch.agents[0].lastError, 'turn_timeout');

  // The next turn clears it through the adapter state, as with any error.
  adapter.states.cfo = { state: 'busy', lastError: null };
  adapter.emit('thread.state', 'cfo', { state: 'busy' });
  assert.equal(persona(hub).lastError, null);
  adapter.emit('thread.state', 'cfo', { state: 'idle' });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(adapter.calls.filter((call) => call[0] === 'interrupt').length, 1);
  hub.close();
});

test('without a cmux client the snapshot says so and refreshSessions still polls the Codex adapter', async () => {
  let refreshes = 0;
  const codex = {
    kind: 'codex', sessions: () => [], status: () => ({ available: true }), subscribe: () => () => {},
    start: () => Promise.reject(new RuntimeError('not_supported')), state: () => ({}), close: async () => {},
    refresh: async () => { refreshes += 1; },
  };
  const { hub, deltas } = makeHub({ adapters: { codex } });
  assert.deepEqual(hub.snapshot().cmux, { available: false, reason: 'no_client' });
  await hub.refreshSessions();
  assert.equal(refreshes, 1);
  assert.deepEqual(deltas, []);
});

test('refreshSessions waits for the Codex poll no longer than statusMs', async () => {
  const codex = {
    kind: 'codex', sessions: () => [], status: () => ({ available: true }), subscribe: () => () => {},
    start: () => Promise.reject(new RuntimeError('not_supported')), state: () => ({}), close: async () => {},
    refresh: () => new Promise(() => {}),
  };
  const { hub, logs } = makeHub({ adapters: { codex } });
  const started = Date.now();
  await hub.refreshSessions();
  const took = Date.now() - started;
  assert.ok(took >= 150 && took < 1_000, `took ${took}ms against a 200ms budget`);
  assert.ok(!logs.some((entry) => entry.event === 'sessions_refresh_error'));
});

test('refreshSessions is single-flight, commits only what differs, and logs a refresh that throws', async () => {
  const gate = deferred();
  let inventory = null;
  let refreshes = 0;
  const cmux = {
    current: () => inventory,
    async refresh() {
      refreshes += 1;
      await gate.promise;
      if (inventory === 'boom') throw Object.assign(new Error('boom'), { code: 'invented' });
      return inventory;
    },
    close() {},
  };
  const { hub, deltas, logs } = makeHub({ cmux });
  assert.deepEqual(hub.snapshot().cmux, { available: false, reason: 'not_refreshed' });

  inventory = { available: false, reason: 'not_running', stale: false, workspaces: [], surfaces: [], agents: [] };
  const first = hub.refreshSessions();
  const second = hub.refreshSessions();
  gate.resolve();
  await Promise.all([first, second]);
  assert.equal(refreshes, 1);
  assert.deepEqual(deltas.map((d) => d.patch), [{ cmux: { available: false, reason: 'not_running' } }]);

  await hub.refreshSessions();
  assert.equal(deltas.length, 1, 'an unchanged inventory bumps nothing');

  inventory = { available: true, stale: true, workspaces: [], surfaces: [], agents: [] };
  await hub.refreshSessions();
  assert.deepEqual(deltas.at(-1).patch, { cmux: { available: true, stale: true } });

  inventory = 'boom';
  await hub.refreshSessions();
  assert.ok(logs.some((entry) => entry.event === 'sessions_refresh_error' && entry.error === 'invented'));
  assert.equal(hub.snapshot().cmux.available, false);
});

test('close clears turn clocks and unsubscribes from the adapters without closing them', async () => {
  const adapter = fakeAdapter();
  adapter.close = async () => { adapter.calls.push(['close']); };
  const { hub } = makeHub({ adapters: { claude: adapter }, turnMaxMs: 20 });
  await hub.start();
  assert.equal(adapter.listenerCount(), 1);
  adapter.emit('thread.state', 'cfo', { state: 'busy' });
  hub.close();
  assert.equal(adapter.listenerCount(), 0);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(adapter.calls, [['start', 'cfo'], ['unsubscribe']]);
});

test('notify appends through the store with at, sets lastMessage from the summary, and bumps the revision', async () => {
  const adapter = fakeAdapter();
  const appended = [];
  const store = { read: async () => [], append: async (id, message) => { appended.push([id, message]); } };
  const { hub, deltas } = makeHub({ adapters: { claude: adapter }, store });
  await hub.start();
  const before = hub.snapshot().revision;

  const record = await hub.notify('cfo', {
    role: 'system', kind: 'brief', date: '2026-09-30', state: 'ready', summary: 'Cash is fine.', text: '## Money\n\nLong memo text.',
  });
  assert.equal(record.at, '2026-09-25T12:00:00.000Z');
  assert.deepEqual(appended, [['cfo', record]]);
  assert.equal(hub.snapshot().revision, before + 1);
  assert.deepEqual(deltas.at(-1).patch.agents[0].lastMessage, { role: 'system', text: 'Cash is fi', at: '2026-09-25T12:00:00.000Z' });

  // A given `at` is kept; a message without a summary previews its text.
  await hub.notify('cfo', { role: 'system', text: 'Plain note', at: '2026-09-25T13:00:00.000Z' });
  assert.deepEqual(persona(hub).lastMessage, { role: 'system', text: 'Plain note', at: '2026-09-25T13:00:00.000Z' });
  assert.equal(appended[1][1].at, '2026-09-25T13:00:00.000Z');
});

test('notify without a store rejects, and a store refusal propagates without a bump', async () => {
  const { hub } = makeHub();
  await assert.rejects(hub.notify('cfo', { role: 'system', text: 'x' }), { message: 'no_store' });

  const store = { read: async () => [], append: async () => { throw new Error('invalid_message'); } };
  const { hub: withStore, deltas } = makeHub({ adapters: { claude: fakeAdapter() }, store });
  await withStore.start();
  const count = deltas.length;
  await assert.rejects(withStore.notify('cfo', { role: 'system', text: 'x' }), { message: 'invalid_message' });
  assert.equal(deltas.length, count);
});

test('the last cached message previews its summary when it has one', async () => {
  const store = {
    read: async () => [{ role: 'system', kind: 'brief', summary: 'Short.', text: 'A long memo', at: 'a' }],
  };
  const { hub } = makeHub({ adapters: { claude: fakeAdapter() }, store });
  await hub.start();
  assert.deepEqual(persona(hub).lastMessage, { role: 'system', text: 'Short.', at: 'a' });
});

test('a thread\'s own choice beats the agent and system levels, field by field, and modelFor carries it', async () => {
  const settings = fakeSettingsStore({ model: { default: 'sonnet', effort: 'low' } });
  const registry = fakeRegistry(registryState([agent('cfo'), agent('ops', { model: 'opus' })]));
  let choices = { cfo: null, ops: null };
  const listeners = new Set();
  const adapter = {
    kind: 'claude',
    calls: [],
    async start() { return {}; },
    state: (id) => ({ state: 'idle', pending: null, lastError: null, sessionId: null, costUsd: null, cwd: '/invented', model: choices[id] }),
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    emit(event) { for (const fn of listeners) fn(event); },
  };
  const { hub } = makeHub({ registry, settings, adapters: { claude: adapter } });
  await hub.start();
  const view = (id) => hub.snapshot().agents.find((a) => a.id === id).model;
  assert.deepEqual(view('cfo'), { id: 'sonnet', effort: 'low', source: 'system', default: { id: 'sonnet', effort: 'low' }, agent: { id: null, effort: null } });

  // The adapter records a choice and says so with a message; the hub
  // recomputes the view on that event.
  choices = { ...choices, cfo: { id: 'haiku', effort: null } };
  adapter.emit({ type: 'message', agentId: 'cfo', at: 'a', role: 'system', kind: 'model', model: 'haiku', effort: null, text: 'Now on Haiku.' });
  assert.deepEqual(view('cfo'), { id: 'haiku', effort: 'low', source: 'thread', default: { id: 'sonnet', effort: 'low' }, agent: { id: null, effort: null } });
  assert.deepEqual(hub.modelFor('cfo'), { id: 'haiku', effort: 'low' });

  choices = { ...choices, ops: { id: null, effort: 'max' } };
  adapter.emit({ type: 'message', agentId: 'ops', at: 'a', role: 'system', kind: 'model', model: null, effort: 'max', text: 'Now at max effort.' });
  assert.deepEqual(view('ops'), { id: 'opus', effort: 'max', source: 'thread', default: { id: 'opus', effort: 'low' }, agent: { id: 'opus', effort: null } });
  assert.deepEqual(hub.modelFor('ops'), { id: 'opus', effort: 'max' });

  // The model line is bookkeeping: the row keeps the thread's real last
  // message, as the hub's lastMessage, and the view still moves.
  adapter.emit({ type: 'message', agentId: 'cfo', at: 'b', role: 'assistant', text: 'Cash is fine.' });
  assert.deepEqual(hub.snapshot().agents.find((a) => a.id === 'cfo').lastMessage, { role: 'assistant', text: 'Cash is fi', at: 'b' });
  choices = { ...choices, cfo: { id: 'sonnet', effort: null } };
  adapter.emit({ type: 'message', agentId: 'cfo', at: 'c', role: 'system', kind: 'model', model: 'sonnet', effort: null, text: 'Now on Sonnet.' });
  assert.deepEqual(hub.snapshot().agents.find((a) => a.id === 'cfo').lastMessage, { role: 'assistant', text: 'Cash is fi', at: 'b' });
  assert.deepEqual(view('cfo'), { id: 'sonnet', effort: 'low', source: 'thread', default: { id: 'sonnet', effort: 'low' }, agent: { id: null, effort: null } });

  // New thread drops the choice; the idle boundary recomputes the view.
  choices = { cfo: null, ops: null };
  adapter.emit({ type: 'thread.state', agentId: 'cfo', at: 'a', state: 'idle' });
  assert.deepEqual(view('cfo'), { id: 'sonnet', effort: 'low', source: 'system', default: { id: 'sonnet', effort: 'low' }, agent: { id: null, effort: null } });
  hub.close();
});

test('a delegation line never becomes the row preview, live or at start, and one written outside a turn sets lastLineAt', async () => {
  const adapter = fakeAdapter();
  const appended = [];
  const { hub } = makeHub({ adapters: { claude: adapter }, store: { read: async () => [], append: async (id, message) => { appended.push([id, message]); } } });
  await hub.start();
  assert.equal(persona(hub).lastLineAt, null);
  adapter.emit('message', 'cfo', { role: 'assistant', text: 'Cash is fine.' });
  const kept = { role: 'assistant', text: 'Cash is fi', at: '2026-09-25T12:01:00.000Z' };
  assert.deepEqual(persona(hub).lastMessage, kept);
  for (const line of [
    { state: 'sent', to: 'brain', delegationId: 'd-1', text: 'Messaged BRAIN', summary: 'Messaged BRAIN' },
    { state: 'waiting', to: 'brain', delegationId: 'd-1', text: 'BRAIN is waiting for you.', summary: 'BRAIN is waiting for you.' },
    { state: 'finished', to: 'brain', delegationId: 'd-1', text: 'Three notes. All current.', summary: 'Three notes.' },
    { state: 'refused', reason: 'cycle', to: 'cfo', text: 'CFO is already in this exchange.', summary: 'CFO is already in this exchange.' },
  ]) {
    adapter.emit('message', 'cfo', { role: 'system', kind: 'delegation', ...line });
    assert.deepEqual(persona(hub).lastMessage, kept, line.state);
  }
  // Through notify, the line is appended, the preview stays, and lastLineAt moves.
  await hub.notify('cfo', { role: 'system', kind: 'delegation', state: 'finished', to: 'brain', delegationId: 'd-2', text: 'Late reply.', summary: 'Late reply.', at: 'later' });
  assert.deepEqual(appended.at(-1), ['cfo', { role: 'system', kind: 'delegation', state: 'finished', to: 'brain', delegationId: 'd-2', text: 'Late reply.', summary: 'Late reply.', at: 'later' }]);
  assert.deepEqual(persona(hub).lastMessage, kept);
  assert.equal(persona(hub).lastLineAt, 'later');
  // A notice through notify is the preview, and leaves lastLineAt alone.
  await hub.notify('cfo', { role: 'system', kind: 'brief', text: 'Memo.', summary: 'Opening.', at: 'z' });
  assert.deepEqual(persona(hub).lastMessage, { role: 'system', text: 'Opening.', at: 'z' });
  assert.equal(persona(hub).lastLineAt, 'later');
  hub.close();

  const cached = makeHub({
    adapters: { claude: fakeAdapter() },
    store: { read: async () => [
      { role: 'assistant', text: 'Cash is fine.', at: 'a' },
      { role: 'system', kind: 'delegation', state: 'sent', to: 'brain', delegationId: 'd-1', text: 'Messaged BRAIN', summary: 'Messaged BRAIN', at: 'b' },
      { role: 'system', kind: 'delegation', state: 'finished', to: 'brain', delegationId: 'd-1', text: 'Three notes.', summary: 'Three notes.', at: 'c' },
    ] },
  });
  await cached.hub.start();
  assert.deepEqual(persona(cached.hub).lastMessage, { role: 'assistant', text: 'Cash is fi', at: 'a' });
  cached.hub.close();
});

test('at start, lastMessage skips bookkeeping lines at the end of the cache and keeps the brief notice and New thread', async () => {
  const cached = (messages) => makeHub({ adapters: { claude: fakeAdapter() }, store: { read: async () => messages } });
  let { hub } = cached([
    { role: 'assistant', text: 'Cash is fine.', at: 'a' },
    { role: 'system', kind: 'model', model: 'sonnet', effort: null, text: 'Now on Sonnet.', at: 'b' },
    { role: 'system', kind: 'model', model: null, effort: null, text: "Back to the agent's default.", at: 'c' },
  ]);
  await hub.start();
  assert.deepEqual(persona(hub).lastMessage, { role: 'assistant', text: 'Cash is fi', at: 'a' });
  hub.close();

  ({ hub } = cached([{ role: 'system', kind: 'model', model: 'sonnet', effort: null, text: 'Now on Sonnet.', at: 'a' }]));
  await hub.start();
  assert.equal(persona(hub).lastMessage, null);
  hub.close();

  ({ hub } = cached([
    { role: 'system', kind: 'brief', summary: 'Short.', text: 'A long memo', at: 'a' },
    { role: 'system', kind: 'model', model: 'haiku', effort: null, text: 'Now on Haiku.', at: 'b' },
  ]));
  await hub.start();
  assert.deepEqual(persona(hub).lastMessage, { role: 'system', text: 'Short.', at: 'a' });
  hub.close();

  ({ hub } = cached([{ role: 'system', text: 'New thread', at: 'a' }, { role: 'system', kind: 'model', model: 'opus', effort: null, text: 'Now on Opus.', at: 'b' }]));
  await hub.start();
  assert.deepEqual(persona(hub).lastMessage, { role: 'system', text: 'New thread', at: 'a' });
  hub.close();
});

test('lastMessage keeps the sender of a message another agent sent, on an event and from the cache', async () => {
  const adapter = fakeAdapter();
  const { hub } = makeHub({ adapters: { claude: adapter } });
  await hub.start();
  const AT1 = '2026-09-25T12:01:00.000Z';
  adapter.emit('message', 'cfo', { role: 'user', text: 'Should he rebalance?', from: 'assistant', mentions: ['brain'] });
  assert.deepEqual(persona(hub).lastMessage, { role: 'user', text: 'Should he ', at: AT1, from: 'assistant' });
  adapter.emit('message', 'cfo', { role: 'assistant', text: 'No.' });
  assert.deepEqual(persona(hub).lastMessage, { role: 'assistant', text: 'No.', at: AT1 });
  // A delegation line is bookkeeping and leaves the preview alone.
  adapter.emit('message', 'cfo', { role: 'system', kind: 'delegation', state: 'sent', to: 'brain', text: 'Messaged Second brain', summary: 'Messaged Second brain' });
  assert.deepEqual(persona(hub).lastMessage, { role: 'assistant', text: 'No.', at: AT1 });
  hub.close();

  const cached = makeHub({ adapters: { claude: fakeAdapter() }, store: { read: async () => [
    { role: 'user', text: 'From the Assistant.', at: 'a', from: 'assistant' },
    { role: 'system', kind: 'delegation', state: 'sent', to: 'brain', text: 'Messaged Second brain', summary: 'Messaged Second brain', at: 'b' },
  ] } });
  await cached.hub.start();
  assert.deepEqual(persona(cached.hub).lastMessage, { role: 'user', text: 'From the A', at: 'a', from: 'assistant' });
  cached.hub.close();
});

// A routine store stand-in: current() answers the given routines sorted by
// name, lastRun() the given run lines, and set() changes either and
// notifies, as a write would.
function fakeRoutineStore(routines = [], lastRuns = {}) {
  const listeners = new Set();
  let items = [...routines];
  let runs = { ...lastRuns };
  return {
    current: () => [...items].sort((a, b) => a.name.localeCompare(b.name)),
    lastRun: (id) => runs[id] ?? null,
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    set({ routines: next = items, lastRuns: nextRuns = runs } = {}) {
      items = [...next];
      runs = { ...nextRuns };
      for (const fn of listeners) fn();
    },
  };
}

const ROUTINE = Object.freeze({
  version: 1, id: 'daily-drift', name: 'Daily drift', agent: 'cfo', instruction: 'Compute drift.',
  schedule: { cron: '30 6 * * 1-5', text: 'Weekdays at 6:30' }, active: true, created: '2026-09-20T12:00:00.000Z', updated: '2026-09-20T12:00:00.000Z',
});

test('the snapshot lists routines in agent order with nextAt in Chicago time and the newest run, and nextAt is null when inactive or the agent is not a Claude persona', () => {
  const registry = fakeRegistry(registryState([agent('cfo'), agent('scribe', { provider: 'codex' }), agent('ops', { kind: 'system', provider: undefined })]));
  const lastRun = { run: 'r1', occurrence: '2026-09-25T11:30:00.000Z', trigger: 'schedule', startedAt: '2026-09-25T11:30:02.000Z', endedAt: '2026-09-25T11:31:00.000Z', outcome: 'finished' };
  const routines = fakeRoutineStore([
    { ...ROUTINE, id: 'weekly', name: 'Weekly review', schedule: { cron: '0 18 * * 5', text: 'Every Friday at 18:00' }, active: false },
    { ...ROUTINE, id: 'notes', name: 'Notes', agent: 'scribe' },
    { ...ROUTINE, id: 'pings', name: 'Pings', agent: 'ops' },
    ROUTINE,
  ], { 'daily-drift': lastRun });
  // Friday 2026-09-25 07:00 CDT: the next weekday 6:30 is Monday.
  const { hub } = makeHub({ registry, routines });
  const { items } = hub.snapshot().routines;
  assert.deepEqual(items.map((r) => [r.id, r.nextAt, r.lastRun]), [
    ['daily-drift', '2026-09-28T11:30:00.000Z', lastRun],
    ['weekly', null, null],
    ['notes', null, null],
    ['pings', null, null],
  ]);
  assert.deepEqual(Object.keys(items[0]), ['id', 'name', 'agent', 'instruction', 'schedule', 'active', 'created', 'updated', 'nextAt', 'lastRun']);
  assert.deepEqual(items[0].schedule, { cron: '30 6 * * 1-5', text: 'Weekdays at 6:30' });
  assert.ok(Object.isFrozen(hub.snapshot().routines) && Object.isFrozen(items[0]) && Object.isFrozen(items[0].lastRun));
});

test('a store change bumps the revision with a routines patch, and a registry change that drops the agent clears nextAt', () => {
  const registry = fakeRegistry(registryState([agent('cfo'), agent('brain')]));
  const routines = fakeRoutineStore([ROUTINE]);
  const { hub, deltas } = makeHub({ registry, routines });
  routines.set({ routines: [ROUTINE, { ...ROUTINE, id: 'brain-notes', name: 'Notes', agent: 'brain' }] });
  assert.deepEqual(deltas.map((d) => [d.revision, Object.keys(d.patch)]), [[2, ['routines']]]);
  assert.deepEqual(hub.snapshot().routines.items.map((r) => r.id), ['daily-drift', 'brain-notes']);
  // The same routines again: nothing moved, no bump.
  routines.set();
  assert.equal(deltas.length, 1);
  registry.emit(registryState([agent('brain')]));
  assert.deepEqual(deltas.at(-1).patch.routines.items.map((r) => [r.id, r.nextAt]), [['brain-notes', '2026-09-28T11:30:00.000Z'], ['daily-drift', null]]);
});

test('needsYou follows the newest run and clears on a message Hunter writes, not one from another agent or a routine', async () => {
  const adapter = fakeAdapter();
  const registry = fakeRegistry(registryState([agent('cfo'), agent('brain')]));
  const waiting = { run: 'r1', occurrence: '2026-09-25T11:30:00.000Z', trigger: 'schedule', startedAt: '2026-09-25T11:30:02.000Z', endedAt: '2026-09-25T11:31:00.000Z', outcome: 'waiting' };
  const routines = fakeRoutineStore([ROUTINE], { 'daily-drift': waiting });
  const { hub, deltas } = makeHub({ adapters: { claude: adapter }, registry, routines });
  await hub.start();
  assert.equal(persona(hub).needsYou, true);
  assert.equal(persona(hub, 'brain').needsYou, false);
  adapter.emit('message', 'cfo', { role: 'user', text: 'From the Assistant.', from: 'assistant' });
  assert.equal(persona(hub).needsYou, true);
  adapter.emit('message', 'cfo', { role: 'user', text: 'Routine "Daily drift": compute drift.', routine: { id: 'daily-drift', name: 'Daily drift' } });
  assert.equal(persona(hub).needsYou, true);
  const before = deltas.length;
  adapter.emit('message', 'cfo', { role: 'user', text: 'Looks fine, carry on.' });
  assert.equal(persona(hub).needsYou, false);
  assert.ok(deltas.length > before);
  // A run that ends waiting later than his message raises it again; runEnded() recomputes.
  routines.set({ lastRuns: { 'daily-drift': { ...waiting, run: 'r2', endedAt: '2026-09-25T12:02:00.000Z' } } });
  assert.equal(persona(hub).needsYou, true);
  routines.lastRun = () => ({ ...waiting, run: 'r3', endedAt: '2026-09-25T12:03:00.000Z', outcome: 'finished' });
  const revision = hub.snapshot().revision;
  hub.runEnded('daily-drift');
  assert.equal(persona(hub).needsYou, false);
  assert.equal(hub.snapshot().routines.items[0].lastRun.run, 'r3');
  assert.deepEqual(Object.keys(deltas.at(-1).patch).sort(), ['agents', 'routines']);
  assert.equal(hub.snapshot().revision, revision + 1);
  hub.close();
});

test('needsYou at start reads the last message Hunter wrote from the cache, skipping messages from agents and routines', async () => {
  const waiting = { run: 'r1', occurrence: '2026-09-25T11:30:00.000Z', trigger: 'schedule', startedAt: '2026-09-25T11:30:02.000Z', endedAt: '2026-09-25T11:31:00.000Z', outcome: 'waiting' };
  const routines = fakeRoutineStore([ROUTINE], { 'daily-drift': waiting });
  const answered = makeHub({ adapters: { claude: fakeAdapter() }, routines, store: { read: async () => [
    { role: 'user', text: 'Hunter wrote this.', at: '2026-09-25T11:40:00.000Z' },
    { role: 'user', text: 'Routine "Daily drift": compute drift.', at: '2026-09-25T11:50:00.000Z', routine: { id: 'daily-drift', name: 'Daily drift' } },
  ] } });
  await answered.hub.start();
  assert.equal(persona(answered.hub).needsYou, false);
  answered.hub.close();
  const unanswered = makeHub({ adapters: { claude: fakeAdapter() }, routines, store: { read: async () => [
    { role: 'user', text: 'Hunter wrote this.', at: '2026-09-25T11:20:00.000Z' },
    { role: 'user', text: 'From the Assistant.', at: '2026-09-25T11:45:00.000Z', from: 'assistant' },
    { role: 'assistant', text: 'A reply.', at: '2026-09-25T11:46:00.000Z' },
  ] } });
  await unanswered.hub.start();
  assert.equal(persona(unanswered.hub).needsYou, true);
  unanswered.hub.close();
});
