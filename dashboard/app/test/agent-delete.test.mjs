import assert from 'node:assert/strict';
import { access, readdir } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import { LIMITS } from '../lib/config.mjs';
import { createRoutines } from '../lib/routines.mjs';
import { createThreadStore } from '../lib/threads.mjs';
import { fakeRegistry, fakeSettings, request, startApp, tempDir } from './support/harness.mjs';

const status = {
  focus: { checkHealth: async () => ({ available: true }) },
  brief: { latestMetadata: async () => ({ state: 'empty' }) },
};

function agent(id, extra = {}) {
  return Object.freeze({
    id, name: id.toUpperCase(), role: 'Role', description: 'Invented.', group: 'work', kind: 'persona',
    cwd: '/invented', provider: 'claude', jobs: [], ...extra,
  });
}

const AGENTS = [
  agent('guide', { builtin: true }),
  agent('assistant', { pinned: true }),
  agent('cfo', { accepts: ['scout'] }),
  agent('scout', { accepts: ['cfo', 'assistant'] }),
  agent('ops', { kind: 'system', provider: undefined }),
];

// An adapter whose state per agent is `states[id]` (idle by default).
function stateAdapter(states = {}) {
  return {
    start: async () => ({}),
    state: (id) => ({ state: states[id] ?? 'idle', pending: null, lastError: null, sessionId: null, costUsd: null }),
    subscribe: () => () => {},
    close: async () => {},
  };
}

async function setup(t, { agents = AGENTS, states = {}, settings = { brief: { agent: 'assistant' }, quickChat: { agent: 'guide' } } } = {}) {
  const dir = await tempDir(t);
  const routines = createRoutines({ dir: path.join(dir, 'routines'), limits: LIMITS, now: () => new Date('2026-10-03T12:00:00.000Z') });
  await routines.load();
  const store = createThreadStore({ dir: path.join(dir, 'threads'), limits: LIMITS });
  const registry = fakeRegistry(agents, { groups: [{ id: 'work', name: 'Work' }] });
  const settingsStore = fakeSettings(settings);
  const app = await startApp(t, {
    ...status, registry, routines, store, settings: settingsStore, adapters: { claude: stateAdapter(states) },
  });
  return { app, registry, routines, store, settings: settingsStore, dir };
}

function remove(app, id, headers = {}) {
  return request(app, 'DELETE', `/api/agents/${id}`, { headers: { origin: app.origin, ...headers } });
}

const ROUTINE = { agent: 'scout', instruction: 'Look around.', schedule: { cron: '0 7 * * *' }, active: true };

test('DELETE removes the entry, strips it from accepts, removes its routines and runs, and keeps the thread', async (t) => {
  const { app, registry, routines, store, dir } = await setup(t);
  const mine = await routines.create({ name: 'Morning look', ...ROUTINE });
  await routines.appendRun(mine.id, { run: 'r1', occurrence: null, trigger: 'test', startedAt: '2026-10-03T07:00:00.000Z' });
  const other = await routines.create({ name: 'Drift', ...ROUTINE, agent: 'cfo' });
  await store.append('scout', { role: 'user', text: 'Hello', at: '2026-10-03T08:00:00.000Z' });

  const response = await remove(app, 'scout');
  assert.equal(response.status, 200);
  assert.deepEqual(response.json, { ok: true, routines: [mine.id], settings: {} });

  const written = registry.writes.at(-1);
  assert.deepEqual(written.agents.map((entry) => entry.id), ['guide', 'assistant', 'cfo', 'ops']);
  // A list that named only the deleted agent stays empty: still no one, never everyone.
  assert.deepEqual(written.agents.find((entry) => entry.id === 'cfo').accepts, []);
  assert.deepEqual(routines.current().map((routine) => routine.id), [other.id]);
  const files = await readdir(path.join(dir, 'routines'));
  assert.equal(files.includes(`${mine.id}.json`), false);
  await assert.rejects(access(path.join(dir, 'routines', 'runs', `${mine.id}.jsonl`)), { code: 'ENOENT' });

  const state = (await request(app, 'GET', '/api/state')).json;
  assert.equal(state.agents.some((entry) => entry.id === 'scout'), false);
  assert.deepEqual(state.routines.items.map((routine) => routine.id), [other.id]);
  assert.ok(app.logs.some((entry) => entry.event === 'agent_deleted' && entry.agentId === 'scout'));

  // The thread stays on disk; the same id added again finds it.
  assert.deepEqual((await store.read('scout')).map((message) => message.text), ['Hello']);
  const created = await request(app, 'POST', '/api/agents', {
    headers: { origin: app.origin, 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'scout', name: 'Scout', role: 'Role', group: 'work', description: 'Invented.', cwd: '/invented', model: null, effort: null, accepts: null, pinned: false }),
  });
  assert.equal(created.status, 201);
  // The hub starts it through the registry change.
  await new Promise((resolve) => setTimeout(resolve, 20));
  const thread = await request(app, 'GET', '/api/agents/scout/thread');
  assert.deepEqual(thread.json.messages.map((message) => message.text), ['Hello']);
});

test('DELETE moves the brief and quick chat off the agent: to the built-in, else the pinned, else the first Claude agent', async (t) => {
  const { app, settings } = await setup(t, { settings: { brief: { agent: 'cfo' }, quickChat: { agent: 'cfo' } } });
  const moved = await remove(app, 'cfo');
  assert.equal(moved.status, 200);
  assert.deepEqual(moved.json.settings, { brief: 'guide', quickChat: 'guide' });
  assert.deepEqual([settings.current().settings.brief.agent, settings.current().settings.quickChat.agent], ['guide', 'guide']);

  // With no built-in, the pinned one; with none, the first Claude agent; with none (a Codex agent is not one), no one.
  const second = await setup(t, { agents: [agent('assistant', { pinned: true }), agent('cfo'), agent('scout'), agent('dev', { provider: 'codex' })], settings: { brief: { agent: 'assistant' }, quickChat: { agent: 'scout' } } });
  assert.deepEqual((await remove(second.app, 'assistant')).json.settings, { brief: 'cfo' });
  assert.deepEqual((await remove(second.app, 'scout')).json.settings, { quickChat: 'cfo' });
  assert.deepEqual((await remove(second.app, 'cfo')).json.settings, { brief: null, quickChat: null });
  assert.deepEqual(second.settings.current().settings.brief, { agent: null });
});

test('DELETE refuses a built-in, a busy or waiting agent, another kind, and an unknown id, and changes nothing', async (t) => {
  const { app, registry } = await setup(t, { states: { cfo: 'busy', assistant: 'waiting' } });
  assert.deepEqual([(await remove(app, 'guide')).status, (await remove(app, 'guide')).json], [409, { error: 'builtin' }]);
  assert.deepEqual((await remove(app, 'cfo')).json, { error: 'busy' });
  assert.deepEqual((await remove(app, 'assistant')).json, { error: 'busy' });
  assert.deepEqual([(await remove(app, 'ops')).status, (await remove(app, 'ops')).json], [409, { error: 'not_agent' }]);
  assert.deepEqual([(await remove(app, 'nobody')).status, (await remove(app, 'nobody')).json], [404, { error: 'no_such_agent' }]);
  assert.equal(registry.writes.length, 0);

  // Bodyless, with an exact Origin; the trailing-action form is not a route.
  assert.equal((await remove(app, 'scout', { origin: 'http://evil.example' })).status, 403);
  const withBody = await request(app, 'DELETE', '/api/agents/scout', { headers: { origin: app.origin, 'content-type': 'application/json', 'content-length': '2' }, body: '{}' });
  assert.deepEqual([withBody.status, withBody.json], [413, { error: 'payload_too_large' }]);
  assert.equal((await request(app, 'GET', '/api/agents/scout')).status, 405);

  registry.set({ ok: false, error: 'agent 1 (x): role must be a non-empty string of at most 24 characters' });
  assert.deepEqual((await remove(app, 'scout')).json.error, 'registry_invalid');
  registry.set({ ok: true, error: null });
  app.handler.closeStreams();
  assert.deepEqual((await remove(app, 'scout')).json, { error: 'shutting_down' });
  assert.equal(registry.writes.length, 0);
});

test('a settings PUT on a built-in keeps the flag, and the snapshot carries it', async (t) => {
  const { app, registry } = await setup(t);
  const response = await request(app, 'PUT', '/api/agents/guide/settings', {
    headers: { origin: app.origin, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Guide', role: 'Guide', group: 'work', description: 'Renamed.', cwd: '/invented', model: null, effort: null, accepts: null, pinned: false }),
  });
  assert.equal(response.status, 200);
  assert.equal(response.json.agent.builtin, true);
  assert.equal(Object.keys(registry.writes.at(-1).agents[0]).at(-1), 'builtin');
  const state = (await request(app, 'GET', '/api/state')).json;
  assert.equal(state.agents.find((entry) => entry.id === 'guide').builtin, true);
  assert.equal('builtin' in state.agents.find((entry) => entry.id === 'cfo'), false);
});

test('without a writable registry DELETE is not there', async (t) => {
  const registry = { ...fakeRegistry([agent('cfo')]) };
  delete registry.write;
  const app = await startApp(t, { ...status, registry, adapters: { claude: stateAdapter() }, store: { read: async () => [] } });
  assert.equal((await remove(app, 'cfo')).status, 404);
});
