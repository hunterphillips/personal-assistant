import assert from 'node:assert/strict';
import { test } from 'node:test';

import { RuntimeError } from '../lib/runtime/claude.mjs';
import { fakeRegistry, request, startApp } from './support/harness.mjs';

const status = {
  focus: { checkHealth: async () => ({ available: true }) },
  brief: { latestMetadata: async () => ({ state: 'empty' }) },
};

function agent(id, extra = {}) {
  return Object.freeze({
    id, name: id.toUpperCase(), role: 'Role', description: 'Invented.', group: 'work', kind: 'persona',
    cwd: '/invented', provider: 'claude', routines: [], ...extra,
  });
}

// An adapter stand-in. Each method records its call and follows `behavior`:
// a RuntimeError code to refuse with, or (for send) 'pending' to hold the
// turn open until release() is called.
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
      adapter.calls.push(['send', agentValue.id, text]);
      const code = adapter.behavior.send;
      if (code) return Promise.reject(new RuntimeError(code));
      return adapter.turn;
    },
    async answer(agentValue, requestId, answer) {
      adapter.calls.push(['answer', agentValue.id, requestId, answer]);
      if (adapter.behavior.answer) throw new RuntimeError(adapter.behavior.answer);
    },
    interrupt(agentValue) {
      adapter.calls.push(['interrupt', agentValue.id]);
      return adapter.turn; // resolves only when the turn ends
    },
    async newThread(agentValue) {
      adapter.calls.push(['newThread', agentValue.id]);
      if (adapter.behavior.newThread) throw new RuntimeError(adapter.behavior.newThread);
    },
  };
  return adapter;
}

const MESSAGES = [{ role: 'user', text: 'Hi', at: '2026-09-25T12:00:00.000Z' }, { role: 'assistant', text: 'Hello', at: '2026-09-25T12:00:01.000Z' }];

async function startAgents(t, { agents = [agent('cfo'), agent('ops', { kind: 'system', provider: undefined }), agent('dev', { kind: 'persona', provider: 'codex' })] } = {}) {
  const adapter = fakeAdapter();
  const reads = [];
  const store = { read: async (id) => { reads.push(id); return MESSAGES; } };
  const app = await startApp(t, { ...status, registry: fakeRegistry(agents), adapters: { claude: adapter }, store });
  t.after(() => adapter.release());
  return { ...app, adapter, reads };
}

function post(app, path, body, headers = {}) {
  const json = body === undefined ? undefined : JSON.stringify(body);
  return request(app, 'POST', path, {
    headers: { origin: app.origin, ...(json === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    body: json,
  });
}

test('send answers 202 without waiting for the turn', async (t) => {
  const app = await startAgents(t);
  const response = await post(app, '/api/agents/cfo/send', { text: 'How is cash?' });
  assert.equal(response.status, 202);
  assert.deepEqual(response.json, { ok: true });
  assert.deepEqual(app.adapter.calls, [['send', 'cfo', 'How is cash?']]);
});

test('send maps adapter refusals to their statuses', async (t) => {
  const app = await startAgents(t);
  for (const [code, status] of [['busy', 409], ['shutting_down', 503], ['invalid_text', 400]]) {
    app.adapter.behavior.send = code;
    const response = await post(app, '/api/agents/cfo/send', { text: 'Again' });
    assert.deepEqual([response.status, response.json], [status, { error: code }], code);
  }
});

test('send validates its body', async (t) => {
  const app = await startAgents(t);
  for (const body of [{}, { text: '' }, { text: '   ' }, { text: 7 }]) {
    const response = await post(app, '/api/agents/cfo/send', body);
    assert.deepEqual([response.status, response.json], [400, { error: 'invalid_text' }], JSON.stringify(body));
  }
  assert.deepEqual((await post(app, '/api/agents/cfo/send', [])).json, { error: 'invalid_body' });
  const cap = app.config.limits.sendTextBytes;
  assert.equal((await post(app, '/api/agents/cfo/send', { text: 'a'.repeat(cap) })).status, 202);
  app.adapter.calls.length = 0;
  const tooLong = await post(app, '/api/agents/cfo/send', { text: 'a'.repeat(cap + 1) });
  assert.deepEqual([tooLong.status, tooLong.json], [413, { error: 'payload_too_large' }]);
  const tooBig = await post(app, '/api/agents/cfo/send', { text: 'a'.repeat(cap * 3) });
  assert.equal(tooBig.status, 413);
  assert.deepEqual(app.adapter.calls, []);
});

test('send after closeStreams answers 503 without reaching the adapter', async (t) => {
  const app = await startAgents(t);
  app.handler.closeStreams();
  const response = await post(app, '/api/agents/cfo/send', { text: 'Late' });
  assert.deepEqual([response.status, response.json], [503, { error: 'shutting_down' }]);
  assert.deepEqual(app.adapter.calls, []);
});

test('mutations need an exact Origin and the right content type', async (t) => {
  const app = await startAgents(t);
  assert.equal((await post(app, '/api/agents/cfo/send', { text: 'x' }, { origin: 'http://evil.example' })).status, 403);
  assert.equal((await post(app, '/api/agents/cfo/send', { text: 'x' }, { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await post(app, '/api/agents/cfo/interrupt', { a: 1 })).status, 413);
  assert.deepEqual(app.adapter.calls, []);
});

test('unknown agents are 404 and non-personas or unavailable personas are 409', async (t) => {
  const app = await startAgents(t);
  for (const action of ['send', 'answer', 'interrupt', 'new-thread']) {
    const body = action === 'send' ? { text: 'x' } : action === 'answer' ? { requestId: 'r', decision: 'deny' } : undefined;
    const unknown = await post(app, `/api/agents/nobody/${action}`, body);
    assert.deepEqual([unknown.status, unknown.json], [404, { error: 'no_such_agent' }], action);
    for (const id of ['ops', 'dev']) {
      const refused = await post(app, `/api/agents/${id}/${action}`, body);
      assert.deepEqual([refused.status, refused.json], [409, { error: 'not_a_persona' }], `${id} ${action}`);
    }
  }
  assert.equal((await request(app, 'GET', '/api/agents/nobody/thread')).status, 404);
  assert.equal((await request(app, 'GET', '/api/agents/ops/thread')).status, 409);
  assert.equal((await request(app, 'GET', '/api/agents/cfo/unknown')).status, 404);
  assert.equal((await request(app, 'GET', '/api/agents/Bad_Id/thread')).status, 404);
  assert.equal((await request(app, 'GET', '/api/agents/cfo/thread/extra')).status, 404);
  assert.equal((await request(app, 'GET', '/api/agents/cfo/send')).status, 405);
  assert.equal((await request(app, 'POST', '/api/agents/cfo/thread', { headers: { origin: app.origin } })).status, 405);
  assert.deepEqual(app.adapter.calls, []);
});

test('answer passes answers or a decision through and maps refusals', async (t) => {
  const app = await startAgents(t);
  const answers = { 'Pick?': 'Blue' };
  assert.equal((await post(app, '/api/agents/cfo/answer', { requestId: 'r1', answers })).status, 200);
  const denied = await post(app, '/api/agents/cfo/answer', { requestId: 'r2', decision: 'deny' });
  assert.deepEqual([denied.status, denied.json], [200, { ok: true }]);
  assert.deepEqual(app.adapter.calls, [
    ['answer', 'cfo', 'r1', { answers }],
    ['answer', 'cfo', 'r2', { decision: 'deny' }],
  ]);

  app.adapter.behavior.answer = 'no_such_request';
  const stale = await post(app, '/api/agents/cfo/answer', { requestId: 'r3', decision: 'allow' });
  assert.deepEqual([stale.status, stale.json], [409, { error: 'no_such_request' }]);
  app.adapter.behavior.answer = 'invalid_answer';
  assert.deepEqual((await post(app, '/api/agents/cfo/answer', { requestId: 'r3', decision: 'maybe' })).json, { error: 'invalid_answer' });

  app.adapter.calls.length = 0;
  for (const body of [{}, { requestId: 'r' }, { requestId: '', decision: 'deny' }, { requestId: 5, decision: 'deny' },
    { requestId: 'r', answers: {}, decision: 'deny' }, { requestId: 'r', decision: 'deny', extra: 1 }, []]) {
    const response = await post(app, '/api/agents/cfo/answer', body);
    assert.deepEqual([response.status, response.json], [400, { error: 'invalid_answer' }], JSON.stringify(body));
  }
  assert.deepEqual(app.adapter.calls, []);
});

test('interrupt answers at once while the turn winds down', async (t) => {
  const app = await startAgents(t);
  const response = await post(app, '/api/agents/cfo/interrupt');
  assert.deepEqual([response.status, response.json], [200, { ok: true }]);
  assert.deepEqual(app.adapter.calls, [['interrupt', 'cfo']]);
});

test('new-thread answers 200 and maps busy and a failed reset', async (t) => {
  const app = await startAgents(t);
  assert.deepEqual((await post(app, '/api/agents/cfo/new-thread')).json, { ok: true });
  app.adapter.behavior.newThread = 'busy';
  const busy = await post(app, '/api/agents/cfo/new-thread');
  assert.deepEqual([busy.status, busy.json], [409, { error: 'busy' }]);
  app.adapter.behavior.newThread = 'thread_reset_failed';
  const failed = await post(app, '/api/agents/cfo/new-thread');
  assert.deepEqual([failed.status, failed.json], [500, { error: 'thread_reset_failed' }]);
  assert.equal(app.adapter.calls.length, 3);
});

test('thread returns the cached messages with no-store', async (t) => {
  const app = await startAgents(t);
  const response = await request(app, 'GET', '/api/agents/cfo/thread');
  assert.equal(response.status, 200);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.deepEqual(response.json, { messages: MESSAGES });
  assert.deepEqual(app.reads.at(-1), 'cfo');
});

test('the snapshot carries persona state and null state for other kinds', async (t) => {
  const app = await startAgents(t);
  const { agents } = (await request(app, 'GET', '/api/state')).json;
  const byId = Object.fromEntries(agents.map((entry) => [entry.id, entry]));
  assert.equal(byId.cfo.state, 'idle');
  assert.deepEqual(byId.cfo.lastMessage, { role: 'assistant', text: 'Hello', at: '2026-09-25T12:00:01.000Z' });
  assert.equal(byId.ops.state, null);
  assert.deepEqual([byId.dev.state, byId.dev.lastError], ['unavailable', 'provider_unavailable']);
});
