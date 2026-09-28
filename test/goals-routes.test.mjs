import assert from 'node:assert/strict';
import { cp } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { RuntimeError } from '../lib/runtime/adapter.mjs';
import { fakeRegistry, request, startApp, tempDir } from './support/harness.mjs';

const FIXTURE_VAULT = fileURLToPath(new URL('./fixtures/vault/', import.meta.url));

const status = {
  focus: { checkHealth: async () => ({ available: true }) },
  brief: { latestMetadata: async () => ({ state: 'empty' }) },
};

function agent(id, cwd, extra = {}) {
  return Object.freeze({
    id, name: id.toUpperCase(), role: 'Role', description: 'Invented.', group: 'personal', kind: 'persona',
    cwd, provider: 'claude', routines: [], ...extra,
  });
}

// A Claude adapter stand-in that records sends. `behavior.send` is a
// RuntimeError code to refuse with; otherwise the turn stays open.
function fakeAdapter() {
  let release;
  const adapter = {
    calls: [],
    behavior: {},
    turn: new Promise((resolve) => { release = resolve; }),
    release: () => release(),
    start: async () => ({}),
    state: () => ({ state: 'idle', pending: null, lastError: null, sessionId: null, costUsd: null }),
    subscribe: () => () => {},
    send(agentValue, text) {
      adapter.calls.push([agentValue.id, text]);
      if (adapter.behavior.send) return Promise.reject(new RuntimeError(adapter.behavior.send));
      return adapter.turn;
    },
  };
  return adapter;
}

// The app over a fresh copy of the fixture vault. `persona` sets the
// second-brain agent's provider (claude runs on the fake adapter; codex has
// no adapter, so the persona is listed but never started), or false to leave
// it out of the registry.
async function startGoals(t, { persona = 'claude', kind = 'persona', goals } = {}) {
  const vault = path.join(await tempDir(t), 'vault');
  await cp(FIXTURE_VAULT, vault, { recursive: true });
  const agents = persona ? [agent('second-brain', vault, { provider: persona, kind })] : [agent('cfo', '/invented')];
  const adapter = fakeAdapter();
  const app = await startApp(t, { ...status, registry: fakeRegistry(agents), adapters: { claude: adapter }, goals });
  t.after(() => adapter.release());
  return { ...app, adapter, vault };
}

function post(app, body, headers = {}, pathname = '/api/goals/propose') {
  return request(app, 'POST', pathname, {
    headers: { origin: app.origin, 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

test('GET /api/goals returns the vault sections and the persona id', async (t) => {
  const app = await startGoals(t);
  const response = await request(app, 'GET', '/api/goals');
  assert.equal(response.status, 200);
  assert.equal(response.json.agentId, 'second-brain');
  assert.deepEqual(response.json.problems, []);
  assert.deepEqual(response.json.sections.map((section) => section.id), ['now', 'later', 'not-now', 'long-term', 'goals']);
  const now = response.json.sections[0];
  assert.equal(now.source, 'notes/current-priorities.md');
  assert.ok(now.items.some((item) => item.id === 'now:learn-the-cello'));
  assert.equal(response.headers['cache-control'], 'no-store');
});

test('add sends the composed message to the persona and answers 202 with its id', async (t) => {
  const app = await startGoals(t);
  const response = await post(app, { kind: 'add', text: 'Run a half marathon' });
  assert.deepEqual([response.status, response.json], [202, { ok: true, agentId: 'second-brain' }]);
  assert.deepEqual(app.adapter.calls, [[
    'second-brain',
    'New goal from the dashboard:\n\nRun a half marathon\n\n' +
      "Interview me until it is defined well enough for the vault, then write it under the vault's rules and tell me the file.",
  ]]);
});

test('edit quotes the item line by line and names its title and source', async (t) => {
  const app = await startGoals(t);
  const response = await post(app, { kind: 'edit', target: 'goal:boat', text: 'Make it a canoe' });
  assert.deepEqual([response.status, response.json], [202, { ok: true, agentId: 'second-brain' }]);
  assert.deepEqual(app.adapter.calls, [[
    'second-brain',
    'Edit a goal from the dashboard: "Build a boat" in notes/goals/boat.md.\n\n' +
      'Current text:\n> # Build a boat\n> \n> **What:** a small wooden rowing boat.\n> \n> Needs a garage first.\n\n' +
      'What I want changed:\nMake it a canoe\n\n' +
      "Ask me what you need, then update the note under the vault's rules and tell me the file.",
  ]]);
});

test('edit of an id the vault does not have is 404 no_such_goal', async (t) => {
  const app = await startGoals(t);
  const response = await post(app, { kind: 'edit', target: 'goal:nothing-here', text: 'x' });
  assert.deepEqual([response.status, response.json], [404, { error: 'no_such_goal' }]);
  assert.deepEqual(app.adapter.calls, []);
});

test('propose validates the body shape', async (t) => {
  const app = await startGoals(t);
  const bodies = [
    [],
    'add',
    {},
    { text: 'x' },
    { kind: 'add' },
    { kind: 'remove', text: 'x' },
    { kind: 'add', target: 'goal:boat', text: 'x' },
    { kind: 'edit', text: 'x' },
    { kind: 'edit', target: '', text: 'x' },
    { kind: 'edit', target: 7, text: 'x' },
    { kind: 'edit', target: 'g'.repeat(201), text: 'x' },
    { kind: 'add', text: 'x', extra: 1 },
    { kind: 'edit', target: 'goal:boat', text: 'x', extra: 1 },
  ];
  for (const body of bodies) {
    const response = await post(app, body);
    assert.deepEqual([response.status, response.json], [400, { error: 'invalid_body' }], JSON.stringify(body));
  }
  // A 200-character target is well formed; it just names nothing.
  assert.equal((await post(app, { kind: 'edit', target: 'g'.repeat(200), text: 'x' })).status, 404);
  assert.deepEqual(app.adapter.calls, []);
});

test('propose refuses blank and oversize text', async (t) => {
  const app = await startGoals(t);
  for (const text of ['', '   \n', 7, null]) {
    const response = await post(app, { kind: 'add', text });
    assert.deepEqual([response.status, response.json], [400, { error: 'invalid_text' }], JSON.stringify(text));
  }
  const blankEdit = await post(app, { kind: 'edit', target: 'goal:boat', text: '  \n ' });
  assert.deepEqual([blankEdit.status, blankEdit.json], [400, { error: 'invalid_text' }]);
  const cap = app.config.limits.sendTextBytes;
  const tooLong = await post(app, { kind: 'add', text: 'a'.repeat(cap + 1) });
  assert.deepEqual([tooLong.status, tooLong.json], [413, { error: 'payload_too_large' }]);
  assert.equal((await post(app, { kind: 'add', text: 'é'.repeat(cap / 2 + 1) })).status, 413);
  assert.deepEqual(app.adapter.calls, []);
});

test('propose maps adapter refusals as send does', async (t) => {
  const app = await startGoals(t);
  for (const [code, expected] of [['busy', 409], ['unavailable', 503], ['shutting_down', 503], ['invalid_text', 400]]) {
    app.adapter.behavior.send = code;
    const response = await post(app, { kind: 'add', text: 'Again' });
    assert.deepEqual([response.status, response.json], [expected, { error: code }], code);
  }
});

test('a second-brain persona that is not started is 409 persona_unavailable', async (t) => {
  const app = await startGoals(t, { persona: 'codex' });
  const response = await post(app, { kind: 'add', text: 'x' });
  assert.deepEqual([response.status, response.json], [409, { error: 'persona_unavailable' }]);
  const edit = await post(app, { kind: 'edit', target: 'goal:boat', text: 'x' });
  assert.deepEqual([edit.status, edit.json], [409, { error: 'persona_unavailable' }]);
  assert.deepEqual(app.adapter.calls, []);
});

test('no second-brain persona in the registry is 404 no_such_agent', async (t) => {
  const app = await startGoals(t, { persona: false });
  const response = await post(app, { kind: 'add', text: 'x' });
  assert.deepEqual([response.status, response.json], [404, { error: 'no_such_agent' }]);
  assert.deepEqual(app.adapter.calls, []);
});

// The reader counts only a persona as the vault's agent, so a second-brain
// project entry is absent to Goals, not a persona of the wrong kind.
test('a second-brain entry that is not a persona is 404 no_such_agent', async (t) => {
  const app = await startGoals(t, { kind: 'project' });
  const read = await request(app, 'GET', '/api/goals');
  assert.equal(read.json.agentId, null);
  const response = await post(app, { kind: 'add', text: 'x' });
  assert.deepEqual([response.status, response.json], [404, { error: 'no_such_agent' }]);
  assert.deepEqual(app.adapter.calls, []);
});

test('propose needs JSON, POST, and an exact Origin', async (t) => {
  const app = await startGoals(t);
  const body = { kind: 'add', text: 'x' };
  assert.equal((await post(app, body, { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await post(app, body, { origin: 'http://evil.example' })).status, 403);
  const get = await request(app, 'GET', '/api/goals/propose');
  assert.deepEqual([get.status, get.headers.allow], [405, 'POST']);
  assert.equal((await post(app, body, {}, '/api/goals')).status, 405);
  assert.deepEqual(app.adapter.calls, []);
});

test('propose after closeStreams answers 503 without reaching the adapter', async (t) => {
  const app = await startGoals(t);
  app.handler.closeStreams();
  const response = await post(app, { kind: 'add', text: 'Late' });
  assert.deepEqual([response.status, response.json], [503, { error: 'shutting_down' }]);
  assert.deepEqual(app.adapter.calls, []);
});

test('without goals both routes are 404', async (t) => {
  const app = await startGoals(t, { goals: null });
  const read = await request(app, 'GET', '/api/goals');
  assert.deepEqual([read.status, read.json], [404, { error: 'not_found' }]);
  const propose = await post(app, { kind: 'add', text: 'x' });
  assert.deepEqual([propose.status, propose.json], [404, { error: 'not_found' }]);
  assert.deepEqual(app.adapter.calls, []);
});
