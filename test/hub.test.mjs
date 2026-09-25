import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createHub } from '../lib/hub.mjs';

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
    cwd: '/invented', provider: 'claude', routines: ['com.invented.job'], ...extra,
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

function fakeRoutines(result = { refreshedAt: '2026-09-25T12:00:00.000Z', focusAvailable: true, routines: [{ label: 'com.invented.job' }] }) {
  const routines = {
    calls: 0,
    signals: [],
    gate: null,
    async refresh({ signal } = {}) {
      routines.calls += 1;
      routines.signals.push(signal);
      if (routines.gate) await routines.gate;
      if (routines.fail) throw new Error('invented failure');
      return result;
    },
  };
  return routines;
}

function makeHub(overrides = {}) {
  const status = overrides.status ?? fakeStatus();
  const logs = [];
  const hub = createHub({
    registry: overrides.registry ?? fakeRegistry(),
    routines: overrides.routines ?? fakeRoutines(),
    focus: status.focus,
    brief: status.brief,
    timeouts: { statusMs: 200 },
    log: (entry) => logs.push(entry),
    now: () => new Date('2026-09-25T12:00:00.000Z'),
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

test('the initial snapshot is frozen and omits agent cwd and routines', () => {
  const { hub } = makeHub();
  const snapshot = hub.snapshot();
  assert.equal(snapshot.revision, 1);
  assert.equal(snapshot.updatedAt, '2026-09-25T12:00:00.000Z');
  assert.deepEqual(snapshot.focus, { available: null });
  assert.deepEqual(snapshot.brief, { state: 'unknown' });
  assert.deepEqual(snapshot.registry, { ok: true, error: null, loadedAt: '2026-09-25T12:00:00.000Z' });
  assert.deepEqual(snapshot.agents, [
    { id: 'cfo', name: 'CFO', role: 'Role', description: 'Invented.', group: 'work', kind: 'persona', provider: 'claude' },
  ]);
  assert.deepEqual(snapshot.routines, { refreshedAt: null, focusAvailable: null, refreshing: false, error: null, items: [] });
  assert.ok(Object.isFrozen(snapshot) && Object.isFrozen(snapshot.agents[0]) && Object.isFrozen(snapshot.routines));
});

test('a registry change bumps the revision with a registry and agents patch', () => {
  const registry = fakeRegistry();
  const { hub, deltas } = makeHub({ registry });
  registry.emit(registryState([agent('cfo'), agent('ops', { kind: 'system', provider: undefined })]));
  assert.equal(hub.snapshot().revision, 2);
  assert.deepEqual(deltas.map((d) => [d.revision, Object.keys(d.patch).sort()]), [[2, ['agents', 'registry']]]);
  assert.deepEqual(deltas[0].patch.agents.map((a) => a.id), ['cfo', 'ops']);
  assert.equal('provider' in deltas[0].patch.agents[1], false);

  registry.emit(registryState([agent('cfo')], { ok: false, error: 'registry_invalid_json' }));
  assert.deepEqual(hub.snapshot().registry, { ok: false, error: 'registry_invalid_json', loadedAt: null });
  assert.equal(hub.snapshot().revision, 3);
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

test('a routines refresh bumps for refreshing and again for the result', async () => {
  const { hub, deltas } = makeHub();
  await hub.refreshRoutines();
  assert.deepEqual(deltas.map((d) => [d.revision, Object.keys(d.patch)]), [[2, ['routines']], [3, ['routines']]]);
  assert.equal(deltas[0].patch.routines.refreshing, true);
  assert.deepEqual(hub.snapshot().routines, {
    refreshedAt: '2026-09-25T12:00:00.000Z',
    focusAvailable: true,
    refreshing: false,
    error: null,
    items: [{ label: 'com.invented.job' }],
  });
});

test('concurrent routines refreshes share one call and pass the first signal through', async () => {
  const routines = fakeRoutines();
  const gate = deferred();
  routines.gate = gate.promise;
  const { hub } = makeHub({ routines });
  const controller = new AbortController();
  const both = Promise.all([hub.refreshRoutines({ signal: controller.signal }), hub.refreshRoutines()]);
  assert.equal(hub.snapshot().routines.refreshing, true);
  gate.resolve();
  await both;
  assert.equal(routines.calls, 1);
  assert.equal(routines.signals[0], controller.signal);
  await hub.refreshRoutines();
  assert.equal(routines.calls, 2);
});

test('a failed routines refresh records the error, logs it, and resolves', async () => {
  const routines = fakeRoutines();
  const { hub, logs } = makeHub({ routines });
  await hub.refreshRoutines();
  routines.fail = true;
  await hub.refreshRoutines();
  const current = hub.snapshot().routines;
  assert.equal(current.refreshing, false);
  assert.equal(current.error, 'refresh_failed');
  assert.deepEqual(current.items, [{ label: 'com.invented.job' }]);
  assert.ok(logs.some((entry) => entry.event === 'routines_error' && typeof entry.error === 'string'));
  routines.fail = false;
  await hub.refreshRoutines();
  assert.equal(hub.snapshot().routines.error, null);
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
  await hub.refreshRoutines();
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
