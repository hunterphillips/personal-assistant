import assert from 'node:assert/strict';
import { test } from 'node:test';

import { RuntimeError } from '../lib/runtime/adapter.mjs';
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
  const listeners = new Set();
  const adapter = {
    calls: [],
    behavior: {},
    turn: new Promise((resolve) => { release = resolve; }),
    release: () => release(),
    start: async () => ({}),
    state: () => ({ state: 'idle', pending: null, lastError: null, sessionId: null, costUsd: null, model: adapter.choice }),
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    sendOptions: [],
    choice: null,
    send(agentValue, text, options) {
      adapter.calls.push(['send', agentValue.id, text]);
      adapter.sendOptions.push(options);
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
    setModel(agentValue, choice) {
      adapter.calls.push(['setModel', agentValue.id, choice]);
      if (adapter.behavior.setModel) return Promise.reject(new RuntimeError(adapter.behavior.setModel));
      adapter.choice = {
        id: 'model' in choice ? choice.model : adapter.choice?.id ?? null,
        effort: 'effort' in choice ? choice.effort : adapter.choice?.effort ?? null,
      };
      if (adapter.choice.id === null && adapter.choice.effort === null) adapter.choice = null;
      // As the real adapter does: the thread line is the event the hub
      // recomputes the model view on.
      const event = { type: 'message', agentId: agentValue.id, at: 'now', role: 'system', kind: 'model', model: adapter.choice?.id ?? null, effort: adapter.choice?.effort ?? null, text: 'Now on …' };
      for (const fn of listeners) fn(event);
      return Promise.resolve();
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
  const reset = await post(app, '/api/agents/cfo/new-thread');
  assert.deepEqual([reset.status, reset.json], [503, { error: 'shutting_down' }]);
  assert.deepEqual(app.adapter.calls, []);
});

test('a turn rejected after it was accepted is logged, since the 202 has gone out', async (t) => {
  const app = await startAgents(t);
  app.adapter.send = () => new Promise((_, reject) => setTimeout(() => reject(new RuntimeError('invented_late')), 5));
  const response = await post(app, '/api/agents/cfo/send', { text: 'Go' });
  assert.equal(response.status, 202);
  await new Promise((resolve) => setTimeout(resolve, 30));
  const logged = app.logs.filter((entry) => entry.event === 'persona_turn_rejected');
  assert.deepEqual(logged, [{ event: 'persona_turn_rejected', agentId: 'cfo', error: 'invented_late' }]);

  // A synchronous refusal is the reply itself, not a log line.
  app.adapter.send = () => Promise.reject(new RuntimeError('busy'));
  assert.equal((await post(app, '/api/agents/cfo/send', { text: 'Again' })).status, 409);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(app.logs.filter((entry) => entry.event === 'persona_turn_rejected').length, 1);
});

test('mutations need an exact Origin and the right content type', async (t) => {
  const app = await startAgents(t);
  assert.equal((await post(app, '/api/agents/cfo/send', { text: 'x' }, { origin: 'http://evil.example' })).status, 403);
  assert.equal((await post(app, '/api/agents/cfo/send', { text: 'x' }, { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await post(app, '/api/agents/cfo/interrupt', { a: 1 })).status, 413);
  assert.deepEqual(app.adapter.calls, []);
});

test('unknown agents are 404, other kinds are not_a_persona, and unavailable personas are persona_unavailable', async (t) => {
  const app = await startAgents(t);
  for (const action of ['send', 'answer', 'interrupt', 'new-thread']) {
    const body = action === 'send' ? { text: 'x' } : action === 'answer' ? { requestId: 'r', decision: 'deny' } : undefined;
    const unknown = await post(app, `/api/agents/nobody/${action}`, body);
    assert.deepEqual([unknown.status, unknown.json], [404, { error: 'no_such_agent' }], action);
    const other = await post(app, `/api/agents/ops/${action}`, body);
    assert.deepEqual([other.status, other.json], [409, { error: 'not_a_persona' }], `ops ${action}`);
    const unavailable = await post(app, `/api/agents/dev/${action}`, body);
    assert.deepEqual([unavailable.status, unavailable.json], [409, { error: 'persona_unavailable' }], `dev ${action}`);
  }
  assert.equal((await request(app, 'GET', '/api/agents/nobody/thread')).status, 404);
  assert.deepEqual((await request(app, 'GET', '/api/agents/ops/thread')).json, { error: 'not_a_persona' });
  assert.deepEqual((await request(app, 'GET', '/api/agents/dev/thread')).json, { error: 'persona_unavailable' });
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
  app.adapter.behavior.newThread = 'shutting_down';
  const closing = await post(app, '/api/agents/cfo/new-thread');
  assert.deepEqual([closing.status, closing.json], [503, { error: 'shutting_down' }]);
  assert.equal(app.adapter.calls.length, 4);
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

test('send hands the adapter the resolved model and effort as { model, effort }', async (t) => {
  const app = await startAgents(t, { agents: [agent('cfo', { model: 'opus' })] });
  assert.equal((await post(app, '/api/agents/cfo/send', { text: 'Hi' })).status, 202);
  assert.deepEqual(app.adapter.sendOptions, [{ model: 'opus', effort: null }]);
});

test('model records the thread\'s choice, answers the resolved pair, and validates its body', async (t) => {
  const app = await startAgents(t, { agents: [agent('cfo', { model: 'opus' }), agent('dev', { kind: 'persona', provider: 'codex' })] });
  const chosen = await post(app, '/api/agents/cfo/model', { model: 'sonnet' });
  assert.deepEqual([chosen.status, chosen.json], [200, { ok: true, model: { id: 'sonnet', effort: null, source: 'thread' } }]);
  assert.deepEqual(app.adapter.calls, [['setModel', 'cfo', { model: 'sonnet' }]]);
  // The snapshot shows the thread level once the adapter has recorded it
  // (the real adapter emits a message; the fake is read on the next commit).
  const effort = await post(app, '/api/agents/cfo/model', { effort: 'low' });
  assert.deepEqual(effort.json.model, { id: 'sonnet', effort: 'low', source: 'thread' });
  assert.deepEqual(app.adapter.calls.at(-1), ['setModel', 'cfo', { effort: 'low' }]);
  const reset = await post(app, '/api/agents/cfo/model', { model: null, effort: null });
  assert.deepEqual(reset.json.model, { id: 'opus', effort: null, source: 'agent' });

  for (const [body, code] of [[[], 'invalid_body'], [{}, 'invalid_body'], [{ text: 'x' }, 'invalid_body'], [{ model: 'sonnet', text: 'x' }, 'invalid_body'],
    [{ model: '' }, 'invalid_model'], [{ model: 7 }, 'invalid_model'], [{ model: 'x'.repeat(65) }, 'invalid_model'],
    [{ effort: 'extreme' }, 'invalid_effort'], [{ effort: 3 }, 'invalid_effort']]) {
    const response = await post(app, '/api/agents/cfo/model', body);
    assert.deepEqual([response.status, response.json], [400, { error: code }], JSON.stringify(body));
  }
  for (const [code, status] of [['busy', 409], ['shutting_down', 503], ['invalid_model', 400]]) {
    app.adapter.behavior.setModel = code;
    const response = await post(app, '/api/agents/cfo/model', { model: 'haiku' });
    assert.deepEqual([response.status, response.json], [status, { error: code }], code);
  }
  app.adapter.behavior.setModel = null;

  // A Codex persona has no per-thread choice from here.
  const codex = await post(app, '/api/agents/dev/model', { model: 'sonnet' });
  assert.deepEqual([codex.status, codex.json], [409, { error: 'persona_unavailable' }]);
  app.handler.closeStreams();
  assert.equal((await post(app, '/api/agents/cfo/model', { model: 'haiku' })).status, 503);
});
