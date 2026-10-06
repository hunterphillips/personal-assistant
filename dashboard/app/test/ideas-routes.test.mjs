import assert from 'node:assert/strict';
import { cp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { LIMITS } from '../lib/config.mjs';
import { createIdeas } from '../lib/ideas.mjs';
import { ideasRoutine, instructionsMessage, startMessage } from '../lib/ideas-routes.mjs';
import { createRoutines } from '../lib/routines.mjs';
import { createInstructions } from '../lib/instructions.mjs';
import { RuntimeError } from '../lib/runtime/adapter.mjs';
import { fakeRegistry, request, startApp, tempDir } from './support/harness.mjs';

const FIXTURE = fileURLToPath(new URL('./fixtures/ideas/', import.meta.url));

function agent(id, extra = {}) {
  return Object.freeze({
    id, name: id.toUpperCase(), role: 'Role', description: 'Invented fixture agent.', group: 'personal',
    kind: 'persona', cwd: '/invented', provider: 'claude', jobs: [], ...extra,
  });
}

function fakeAdapter() {
  let release;
  const adapter = {
    calls: [], behavior: {}, turn: new Promise((resolve) => { release = resolve; }), release: () => release(),
    start: async () => ({}), state: () => ({ state: 'idle', pending: null, lastError: null, sessionId: null, costUsd: null }),
    subscribe: () => () => {},
    send(agentValue, text, options) {
      adapter.calls.push([agentValue.id, text, options]);
      if (adapter.behavior.send) return Promise.reject(new RuntimeError(adapter.behavior.send));
      return adapter.turn;
    },
  };
  return adapter;
}

async function startIdeas(t, { agents, includeIdeas = true, routines = null } = {}) {
  const root = await tempDir(t);
  const dir = path.join(root, 'items');
  await cp(FIXTURE, dir, { recursive: true });
  const marksFile = path.join(root, 'marks.json');
  const criteria = path.join(dir, 'criteria.md');
  const ideas = includeIdeas ? createIdeas({
    dir, marksFile, limits: LIMITS, zone: 'America/Chicago', now: () => new Date('2026-10-03T12:00:00-05:00'),
  }) : null;
  const instructions = includeIdeas ? createInstructions({
    file: criteria, path: 'ideas/criteria.md', maxBytes: LIMITS.ideasFileBytes,
    label: 'Ideas', event: 'ideas_instructions_error',
  }) : null;
  const listed = agents ?? [agent('assistant', { pinned: true }), agent('myos')];
  const adapter = fakeAdapter();
  const app = await startApp(t, {
    focus: { checkHealth: async () => ({ available: true }) },
    brief: { latestMetadata: async () => ({ state: 'empty' }) },
    registry: fakeRegistry(listed), adapters: { claude: adapter }, ideas, ideasInstructions: instructions, routines,
  });
  t.after(() => adapter.release());
  return { ...app, adapter, dir, marksFile };
}

function post(app, pathname, body, headers = {}) {
  return request(app, 'POST', pathname, {
    headers: { origin: app.origin, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
}

test('GET /api/ideas returns runs and the newest listed producer', async (t) => {
  const app = await startIdeas(t);
  const response = await request(app, 'GET', '/api/ideas');
  assert.equal(response.status, 200);
  assert.equal(response.json.producer, 'myos');
  assert.deepEqual(response.json.runs.map((run) => run.id), ['2026-09-28-myos', '2026-09-21-myos']);
  assert.equal(response.json.routine, null);
});

function routine(id, agentId, name, instruction) {
  return { id, name, agent: agentId, instruction, schedule: null, active: true, nextAt: null, lastRun: null };
}

test('ideasRoutine picks the producer\'s first routine naming ideas, by instruction or name', () => {
  const items = [
    routine('assistant-ideas', 'assistant', 'Ideas', 'Run the weekly-ideas skill.'),
    routine('myos-digest', 'myos', 'Digest', 'Summarize the week.'),
    routine('myos-weekly', 'myos', 'Weekly', 'Run the weekly-IDEAS skill.'),
    routine('myos-named', 'myos', 'More Ideas', 'Something else.'),
  ];
  assert.equal(ideasRoutine(items, 'myos'), 'myos-weekly');
  assert.equal(ideasRoutine(items.filter((item) => item.id !== 'myos-weekly'), 'myos'), 'myos-named');
  assert.equal(ideasRoutine(items, 'assistant'), 'assistant-ideas');
  assert.equal(ideasRoutine([items[1]], 'myos'), null);
  assert.equal(ideasRoutine(items, 'watch'), null);
  assert.equal(ideasRoutine(items, null), null);
  assert.equal(ideasRoutine([routine('myos-x', 'myos', 'Brainstorm', 'Find good ideasmith tools.')], 'myos'), null);
});

test('GET /api/ideas names the producer\'s ideas routine', async (t) => {
  const routines = createRoutines({ dir: path.join(await tempDir(t), 'routines'), limits: LIMITS, now: () => new Date('2026-10-03T12:00:00.000Z') });
  await routines.load();
  await routines.create({ name: 'Weekly ideas', agent: 'assistant', instruction: 'Run the weekly-ideas skill.', schedule: { cron: '0 4 * * 1' }, active: true });
  await routines.create({ name: 'Weekly ideas', agent: 'myos', instruction: 'Run the weekly-ideas skill.', schedule: { cron: '0 4 * * 1' }, active: true });
  const app = await startIdeas(t, { routines });
  const response = await request(app, 'GET', '/api/ideas');
  assert.deepEqual([response.json.producer, response.json.routine], ['myos', routines.current().find((r) => r.agent === 'myos').id]);
});

test('POST /api/ideas adds verbatim text and returns the fresh store', async (t) => {
  const app = await startIdeas(t);
  const text = 'A route fixture\n  Keep this.\nExactly.';
  const response = await post(app, '/api/ideas', { text });
  assert.equal(response.status, 201);
  assert.deepEqual([response.json.idea.id, response.json.idea.text], ['a-route-fixture', '  Keep this.\nExactly.']);
  assert.equal(response.json.ideas.runs.some((run) => run.items.some((idea) => idea.id === 'a-route-fixture')), true);
});

test('add validates shape, title, and body size', async (t) => {
  const app = await startIdeas(t);
  for (const body of [{}, { text: 4 }, { text: 'x', extra: true }]) {
    const response = await post(app, '/api/ideas', body);
    assert.deepEqual([response.status, response.json], [400, { error: 'invalid_body' }]);
  }
  for (const text of ['', '   ', '  \nbody']) {
    const response = await post(app, '/api/ideas', { text });
    assert.deepEqual([response.status, response.json], [400, { error: 'invalid_text' }]);
  }
  const over = await post(app, '/api/ideas', { text: 'x'.repeat(LIMITS.ideaBodyBytes) });
  assert.deepEqual([over.status, over.json], [413, { error: 'payload_too_large' }]);
});

test('dismiss removes an idea and refuses an unknown id', async (t) => {
  const app = await startIdeas(t);
  const response = await post(app, '/api/ideas/dismiss', { id: 'fixture-agent-card' });
  assert.equal(response.status, 200);
  assert.equal(response.json.ideas.runs.some((run) => run.items.some((item) => item.id === 'fixture-agent-card')), false);
  const missing = await post(app, '/api/ideas/dismiss', { id: 'missing' });
  assert.deepEqual([missing.status, missing.json], [404, { error: 'no_such_item' }]);
});

test('save marks an idea saved, unsave clears it, and both refuse an unknown id', async (t) => {
  const app = await startIdeas(t);
  const statusOf = (response) => response.json.ideas.runs.flatMap((run) => run.items).find((item) => item.id === 'fixture-agent-card').status;
  const saved = await post(app, '/api/ideas/save', { id: 'fixture-agent-card' });
  assert.deepEqual([saved.status, statusOf(saved)], [200, 'saved']);
  assert.equal(JSON.parse(await readFile(app.marksFile, 'utf8'))['fixture-agent-card'].status, 'saved');
  const unsaved = await post(app, '/api/ideas/unsave', { id: 'fixture-agent-card' });
  assert.deepEqual([unsaved.status, statusOf(unsaved)], [200, 'new']);
  assert.deepEqual(JSON.parse(await readFile(app.marksFile, 'utf8')), {});
  for (const route of ['/api/ideas/save', '/api/ideas/unsave']) {
    const missing = await post(app, route, { id: 'missing' });
    assert.deepEqual([missing.status, missing.json], [404, { error: 'no_such_item' }]);
    const invalid = await post(app, route, { id: 'x', extra: true });
    assert.deepEqual([invalid.status, invalid.json], [400, { error: 'invalid_body' }]);
    const over = await post(app, route, { id: 'x'.repeat(LIMITS.ideaBodyBytes) });
    assert.equal(over.status, 413);
  }
});

test('save refuses a started idea and start takes a saved one', async (t) => {
  const app = await startIdeas(t);
  assert.equal((await post(app, '/api/ideas/save', { id: 'fixture-agent-card' })).status, 200);
  const started = await post(app, '/api/ideas/start', { id: 'fixture-agent-card' });
  assert.equal(started.status, 202);
  assert.equal(JSON.parse(await readFile(app.marksFile, 'utf8'))['fixture-agent-card'].status, 'taken');
  const again = await post(app, '/api/ideas/save', { id: 'fixture-agent-card' });
  assert.deepEqual([again.status, again.json], [409, { error: 'already_started' }]);
  const unsave = await post(app, '/api/ideas/unsave', { id: 'fixture-agent-card' });
  assert.deepEqual([unsave.status, unsave.json], [409, { error: 'already_started' }]);
  assert.equal(JSON.parse(await readFile(app.marksFile, 'utf8'))['fixture-agent-card'].status, 'taken');
});

test('start targets the first pinned Claude agent, sends context, then writes the mark', async (t) => {
  const app = await startIdeas(t, { agents: [agent('myos'), agent('assistant', { pinned: true })] });
  const response = await post(app, '/api/ideas/start', { id: 'fixture-agent-card' });
  assert.deepEqual([response.status, response.json.ok, response.json.agentId], [202, true, 'assistant']);
  assert.deepEqual(app.adapter.calls[0].slice(0, 2), ['assistant', startMessage()]);
  assert.deepEqual(app.adapter.calls[0][2].context,
    { view: 'ideas', label: 'Fixture agent card', detail: 'Invented fixture content for a newer run.' });
  const marks = JSON.parse(await readFile(app.marksFile, 'utf8'));
  assert.deepEqual([marks['fixture-agent-card'].status, marks['fixture-agent-card'].agent], ['taken', 'assistant']);
  assert.equal(response.json.ideas.runs[0].items[0].status, 'taken');
});

test('busy start leaves the idea new and a taken idea refuses already_started', async (t) => {
  const app = await startIdeas(t);
  app.adapter.behavior.send = 'busy';
  const busy = await post(app, '/api/ideas/start', { id: 'fixture-agent-card' });
  assert.deepEqual([busy.status, busy.json], [409, { error: 'busy' }]);
  await assert.rejects(() => readFile(app.marksFile), { code: 'ENOENT' });
  app.adapter.behavior.send = null;
  assert.equal((await post(app, '/api/ideas/start', { id: 'fixture-agent-card' })).status, 202);
  const again = await post(app, '/api/ideas/start', { id: 'fixture-agent-card' });
  assert.deepEqual([again.status, again.json], [409, { error: 'already_started' }]);
});

test('start falls back to the default agent and checks it before the item', async (t) => {
  const fallback = await startIdeas(t, { agents: [agent('myos', { builtin: true }), agent('assistant')] });
  const response = await post(fallback, '/api/ideas/start', { id: 'fixture-agent-card' });
  assert.deepEqual([response.status, response.json.agentId], [202, 'myos']);
  const missingAgent = await startIdeas(t, { agents: [] });
  const refusal = await post(missingAgent, '/api/ideas/start', { id: 'missing' });
  assert.deepEqual([refusal.status, refusal.json], [404, { error: 'no_such_agent' }]);
});

test('instructions read and propose resolves the newest producer', async (t) => {
  const app = await startIdeas(t);
  const read = await request(app, 'GET', '/api/ideas/instructions');
  assert.deepEqual([read.status, read.json.path, read.json.problem], [200, 'ideas/criteria.md', null]);
  const response = await post(app, '/api/ideas/instructions/propose', { text: 'Prefer smaller fixture tasks.' });
  assert.deepEqual([response.status, response.json], [202, { ok: true, agentId: 'myos' }]);
  assert.deepEqual(app.adapter.calls[0].slice(0, 2), ['myos', instructionsMessage('Prefer smaller fixture tasks.')]);
  assert.match(app.adapter.calls[0][1], /^Change the Ideas criteria\./);
});

test('without Ideas every route is 404 and /ideas serves the shell', async (t) => {
  const app = await startIdeas(t, { includeIdeas: false });
  for (const [method, pathname, body] of [
    ['GET', '/api/ideas'], ['POST', '/api/ideas', { text: 'x' }], ['POST', '/api/ideas/dismiss', { id: 'x' }],
    ['POST', '/api/ideas/start', { id: 'x' }], ['POST', '/api/ideas/save', { id: 'x' }],
    ['POST', '/api/ideas/unsave', { id: 'x' }], ['GET', '/api/ideas/instructions'],
    ['POST', '/api/ideas/instructions/propose', { text: 'x' }],
  ]) {
    const response = method === 'GET' ? await request(app, method, pathname) : await post(app, pathname, body);
    assert.deepEqual([response.status, response.json], [404, { error: 'not_found' }]);
  }
  assert.equal((await request(app, 'GET', '/ideas')).status, 200);
  const slash = await request(app, 'GET', '/ideas/');
  assert.deepEqual([slash.status, slash.headers.location], [308, '/ideas']);
});

test('Ideas mutations require JSON, the right method, and an exact Origin', async (t) => {
  const app = await startIdeas(t);
  assert.equal((await post(app, '/api/ideas', { text: 'x' }, { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await post(app, '/api/ideas', { text: 'x' }, { origin: 'http://evil.example' })).status, 403);
  const get = await request(app, 'GET', '/api/ideas/start');
  assert.deepEqual([get.status, get.headers.allow], [405, 'POST']);
});
