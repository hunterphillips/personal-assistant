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
// turn open until release() is called. `open` (agentId -> Set of request
// ids) makes answer() strict: once any request is listed, an id not open
// on that agent is no_such_request, and a listed one is settled with a
// resolved event (so the real hub clears its relays). raise() lists a
// request and emits it as the real adapter would.
function fakeAdapter() {
  let release;
  const listeners = new Set();
  const adapter = {
    calls: [],
    behavior: {},
    open: new Map(),
    emit(type, agentId, fields = {}) {
      for (const fn of [...listeners]) fn({ type, agentId, at: '2026-09-25T12:01:00.000Z', ...fields });
    },
    raise(agentId, request) {
      if (!adapter.open.has(agentId)) adapter.open.set(agentId, new Set());
      adapter.open.get(agentId).add(request.requestId);
      adapter.emit('request', agentId, { from: null, chain: [], ...request });
    },
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
      if (adapter.open.size === 0) return;
      const mine = adapter.open.get(agentValue.id);
      if (!mine?.has(requestId)) throw new RuntimeError('no_such_request');
      mine.delete(requestId);
      adapter.emit('resolved', agentValue.id, { requestId, outcome: 'answers' in answer ? 'answered' : answer.decision === 'allow' ? 'allowed' : 'denied' });
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
  for (const [code, status] of [['busy', 409], ['shutting_down', 503], ['invalid_text', 400], ['invalid_permission', 400]]) {
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

test('answer settles a request forwarded to the thread through its owner, and only there', async (t) => {
  const app = await startAgents(t, { agents: [agent('assistant'), agent('cfo'), agent('brain')] });
  const approval = (requestId, chain) => ({ requestId, kind: 'approval', toolName: 'Bash', input: { command: 'ls' }, from: chain[0] ?? null, chain });
  // CFO raises two requests while answering the Assistant: both are forwarded, oldest first.
  app.adapter.raise('cfo', approval('r1', ['assistant']));
  app.adapter.raise('cfo', approval('r2', ['assistant']));
  const view = (id) => app.hub.snapshot().agents.find((item) => item.id === id);
  assert.deepEqual(view('assistant').forwarded.map((item) => [item.requestId, item.agent]), [['r1', 'cfo'], ['r2', 'cfo']]);
  assert.deepEqual(view('brain').forwarded, []);

  // The Assistant's route tries its own adapter, then the owner's.
  const allowed = await post(app, '/api/agents/assistant/answer', { requestId: 'r1', decision: 'allow' });
  assert.deepEqual([allowed.status, allowed.json], [200, { ok: true }]);
  assert.deepEqual(app.adapter.calls, [
    ['answer', 'assistant', 'r1', { decision: 'allow' }],
    ['answer', 'cfo', 'r1', { decision: 'allow' }],
  ]);
  assert.deepEqual(view('assistant').forwarded.map((item) => item.requestId), ['r2']);

  // Settled once: the same id from CFO's own route, and again from the Assistant's, is stale.
  const again = await post(app, '/api/agents/cfo/answer', { requestId: 'r1', decision: 'allow' });
  assert.deepEqual([again.status, again.json], [409, { error: 'no_such_request' }]);
  assert.deepEqual((await post(app, '/api/agents/assistant/answer', { requestId: 'r1', decision: 'allow' })).status, 409);

  // CFO's second request, not the oldest, is answerable from CFO's route as before.
  app.adapter.calls.length = 0;
  assert.equal((await post(app, '/api/agents/cfo/answer', { requestId: 'r2', decision: 'deny' })).status, 200);
  assert.deepEqual(app.adapter.calls, [['answer', 'cfo', 'r2', { decision: 'deny' }]]);
  assert.deepEqual(view('assistant').forwarded, []);

  // A request forwarded to no one, and one forwarded to another thread, are not this thread's.
  app.adapter.raise('cfo', approval('r3', []));
  app.adapter.raise('cfo', approval('r4', ['assistant']));
  assert.deepEqual((await post(app, '/api/agents/assistant/answer', { requestId: 'r3', decision: 'allow' })).json, { error: 'no_such_request' });
  assert.deepEqual((await post(app, '/api/agents/brain/answer', { requestId: 'r4', decision: 'allow' })).json, { error: 'no_such_request' });

  // Once the relay is gone (New thread here), the card is stale.
  app.hub.dropRelaysTo('assistant');
  assert.deepEqual((await post(app, '/api/agents/assistant/answer', { requestId: 'r4', decision: 'allow' })).json, { error: 'no_such_request' });
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

test('send hands the adapter the resolved model, effort, and permission level', async (t) => {
  const app = await startAgents(t, { agents: [agent('cfo', { model: 'opus' }), agent('ops', { permission: 'full' })] });
  assert.equal((await post(app, '/api/agents/cfo/send', { text: 'Hi' })).status, 202);
  assert.deepEqual(app.adapter.sendOptions, [{ model: 'opus', effort: null, permission: 'ask' }]);
  const ops = fakeAdapter();
  t.after(() => ops.release());
  // Another app, so the second turn is not refused by the first fake's held turn.
  const second = await startApp(t, { ...status, registry: fakeRegistry([agent('ops', { permission: 'full' })]), adapters: { claude: ops }, store: { read: async () => [] } });
  assert.equal((await post(second, '/api/agents/ops/send', { text: 'Hi' })).status, 202);
  assert.deepEqual(ops.sendOptions, [{ model: null, effort: null, permission: 'full' }]);

  // A persona that is not Claude's gets null, which the adapter reads as ask.
  const codex = fakeAdapter();
  t.after(() => codex.release());
  const third = await startApp(t, { ...status, registry: fakeRegistry([agent('dev', { provider: 'codex', permission: 'full' })]), adapters: { codex }, store: { read: async () => [] } });
  assert.equal((await post(third, '/api/agents/dev/send', { text: 'Hi' })).status, 202);
  assert.deepEqual(codex.sendOptions, [{ model: null, effort: null, permission: null }]);
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

// --- agent settings and New agent --------------------------------------------

function put(app, path, body, headers = {}) {
  return request(app, 'PUT', path, {
    headers: { origin: app.origin, 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

function settingsBody(overrides = {}) {
  return {
    name: 'CFO', role: 'Money', group: 'work', description: 'Invented.', cwd: '/invented', model: null, effort: null, accepts: null, pinned: false,
    ...overrides,
  };
}

async function startEditable(t, agents = [agent('cfo'), agent('assistant', { pinned: true }), agent('ops', { kind: 'system', provider: undefined }), agent('dev', { kind: 'persona', provider: 'codex' })]) {
  const registry = fakeRegistry(agents, { groups: [{ id: 'work', name: 'Work' }] });
  const adapter = fakeAdapter();
  const app = await startApp(t, { ...status, registry, adapters: { claude: adapter }, store: { read: async () => [] } });
  t.after(() => adapter.release());
  return { ...app, registry, adapter };
}

test('settings PUT rewrites the entry in schema order, keeps routines, omits accepts for everyone, and answers the stored agent', async (t) => {
  const app = await startEditable(t, [agent('cfo', { routines: ['com.hunter.cfo.daily'] }), agent('assistant', { pinned: true })]);
  const response = await put(app, '/api/agents/cfo/settings', settingsBody({
    name: 'Money desk', role: 'Finance', description: 'The money picture.', model: 'sonnet', effort: 'low', accepts: ['assistant'], pinned: true,
  }));
  assert.equal(response.status, 200);
  assert.equal(response.json.ok, true);
  assert.equal(response.json.note, undefined);
  assert.deepEqual(response.json.agent, {
    id: 'cfo', name: 'Money desk', role: 'Finance', description: 'The money picture.', group: 'work', kind: 'persona', cwd: '/invented',
    provider: 'claude', model: 'sonnet', effort: 'low', accepts: ['assistant'], pinned: true, routines: ['com.hunter.cfo.daily'],
  });
  assert.deepEqual(Object.keys(app.registry.writes[0].agents[0]), ['id', 'name', 'role', 'description', 'group', 'kind', 'cwd', 'provider', 'model', 'effort', 'accepts', 'routines', 'pinned']);

  // The snapshot follows in one revision, with the agent level visible.
  const { agents } = (await request(app, 'GET', '/api/state')).json;
  const cfo = agents.find((a) => a.id === 'cfo');
  assert.deepEqual([cfo.name, cfo.pinned, cfo.accepts], ['Money desk', true, ['assistant']]);
  assert.deepEqual(cfo.model, { id: 'sonnet', effort: 'low', source: 'agent', default: { id: 'sonnet', effort: 'low' }, agent: { id: 'sonnet', effort: 'low' } });

  // Everyone, as null or as an empty list, writes no accepts key.
  for (const accepts of [null, []]) {
    const again = await put(app, '/api/agents/cfo/settings', settingsBody({ accepts }));
    assert.equal(again.status, 200);
    assert.equal('accepts' in app.registry.writes.at(-1).agents[0], false);
    assert.equal('accepts' in again.json.agent, false);
  }
});

test('settings PUT writes permission after effort when set, none for null or absent, refuses a bad level, and POST creates with none', async (t) => {
  const app = await startEditable(t);
  const full = await put(app, '/api/agents/cfo/settings', settingsBody({ model: 'sonnet', effort: 'low', accepts: ['assistant'], permission: 'full' }));
  assert.equal(full.status, 200);
  assert.equal(full.json.agent.permission, 'full');
  assert.deepEqual(Object.keys(app.registry.writes.at(-1).agents[0]), ['id', 'name', 'role', 'description', 'group', 'kind', 'cwd', 'provider', 'model', 'effort', 'permission', 'accepts']);
  const cfo = (await request(app, 'GET', '/api/state')).json.agents.find((a) => a.id === 'cfo');
  assert.deepEqual(cfo.permission, { level: 'full', source: 'agent', agent: 'full', default: 'ask' });

  const cleared = await put(app, '/api/agents/cfo/settings', settingsBody({ permission: null }));
  assert.equal(cleared.status, 200);
  assert.equal('permission' in app.registry.writes.at(-1).agents[0], false);
  const absent = await put(app, '/api/agents/cfo/settings', settingsBody({ permission: 'auto' }));
  assert.equal(absent.json.agent.permission, 'auto');
  const older = await put(app, '/api/agents/cfo/settings', settingsBody());
  assert.equal(older.status, 200, 'a body from before the control still saves');
  assert.equal('permission' in app.registry.writes.at(-1).agents[0], false);

  const writes = app.registry.writes.length;
  for (const bad of ['bypass', 'Ask', '', 3]) {
    const refused = await put(app, '/api/agents/cfo/settings', settingsBody({ permission: bad }));
    assert.deepEqual([refused.status, refused.json], [400, { error: 'invalid_permission' }], JSON.stringify(bad));
  }
  assert.equal(app.registry.writes.length, writes);

  const created = await post(app, '/api/agents', { id: 'scout', ...settingsBody({ name: 'Scout', role: 'Files', description: 'Reads my files.', cwd: '/invented/scout' }) });
  assert.equal(created.status, 201);
  assert.equal('permission' in created.json.agent, false);
  const withLevel = await post(app, '/api/agents', { id: 'scribe', ...settingsBody({ name: 'Scribe', role: 'Drafts', description: 'Drafts.', cwd: '/invented/scribe', permission: 'auto' }) });
  assert.equal(withLevel.status, 201);
  assert.equal(withLevel.json.agent.permission, 'auto');
});

test('settings PUT notes a folder change, adds a new group, and joins an existing one by id', async (t) => {
  const app = await startEditable(t);
  const moved = await put(app, '/api/agents/cfo/settings', settingsBody({ cwd: '/invented/elsewhere' }));
  assert.deepEqual([moved.status, moved.json.note, moved.json.agent.cwd], [200, 'cwd_applies_on_new_thread', '/invented/elsewhere']);

  const grouped = await put(app, '/api/agents/cfo/settings', settingsBody({ cwd: '/invented/elsewhere', group: 'family', newGroup: { id: 'family', name: 'Family' } }));
  assert.equal(grouped.status, 200);
  assert.equal(grouped.json.note, undefined);
  assert.deepEqual(app.registry.current().groups, [{ id: 'work', name: 'Work' }, { id: 'family', name: 'Family' }]);
  assert.deepEqual((await request(app, 'GET', '/api/state')).json.groups, [{ id: 'work', name: 'Work' }, { id: 'family', name: 'Family' }]);

  const joined = await put(app, '/api/agents/cfo/settings', settingsBody({ cwd: '/invented/elsewhere', group: 'work', newGroup: { id: 'work', name: 'Work again' } }));
  assert.equal(joined.status, 200);
  assert.deepEqual(app.registry.current().groups.map((g) => g.name), ['Work', 'Family'], 'a matching slug joins the group, no rename');
});

test('settings PUT refuses bad shapes, unknown and non-persona agents, validator problems, and an unloadable registry', async (t) => {
  const app = await startEditable(t);
  for (const body of [[], {}, settingsBody({ extra: 1 }), settingsBody({ pinned: 'yes' }), settingsBody({ model: '' }), settingsBody({ effort: 'extreme' }),
    settingsBody({ accepts: 'assistant' }), settingsBody({ group: 'x', newGroup: { id: 'y', name: 'Y' } }), (() => { const b = settingsBody(); delete b.role; return b; })()]) {
    const response = await put(app, '/api/agents/cfo/settings', body);
    assert.deepEqual([response.status, response.json], [400, { error: 'invalid_body' }], JSON.stringify(body));
  }
  assert.deepEqual((await put(app, '/api/agents/nobody/settings', settingsBody())).json, { error: 'no_such_agent' });
  assert.deepEqual((await put(app, '/api/agents/ops/settings', settingsBody())).json, { error: 'not_editable' });
  assert.equal((await put(app, '/api/agents/ops/settings', settingsBody())).status, 409);
  assert.equal((await put(app, '/api/agents/cfo/settings', settingsBody(), { origin: 'http://evil.example' })).status, 403);
  assert.equal((await request(app, 'POST', '/api/agents/cfo/settings', { headers: { origin: app.origin } })).status, 405);

  const blank = await put(app, '/api/agents/cfo/settings', settingsBody({ name: '', cwd: 'relative/path' }));
  assert.equal(blank.status, 400);
  assert.equal(blank.json.error, 'invalid_registry');
  assert.deepEqual(blank.json.problems, [
    'agent 0 (cfo): name must be a non-empty string of at most 40 characters',
    'agent 0 (cfo): cwd must be an absolute path',
  ]);
  // The cross-checks run once the entry's own fields pass.
  assert.deepEqual((await put(app, '/api/agents/cfo/settings', settingsBody({ accepts: ['cfo', 'nobody'] }))).json.problems, [
    'agent 0 (cfo): accepts must not name the agent itself',
    'agent 0 (cfo): accepts names no agent "nobody"',
  ]);
  assert.equal(app.registry.writes.length, 0);

  app.registry.set({ ok: false, error: 'agent 1 (x): role must be a non-empty string of at most 24 characters' });
  const broken = await put(app, '/api/agents/cfo/settings', settingsBody());
  assert.deepEqual([broken.status, broken.json], [409, { error: 'registry_invalid', problems: ['agent 1 (x): role must be a non-empty string of at most 24 characters'] }]);

  app.registry.set({ ok: true, error: null });
  app.handler.closeStreams();
  assert.deepEqual((await put(app, '/api/agents/cfo/settings', settingsBody())).json, { error: 'shutting_down' });
});

test('POST /api/agents creates a Claude persona with the defaults, starts it, and refuses a duplicate id', async (t) => {
  const app = await startEditable(t);
  const body = { id: 'scout', ...settingsBody({ name: 'Scout', role: 'Files', description: 'Reads my files.', cwd: '/invented/scout' }) };
  const created = await post(app, '/api/agents', body);
  assert.equal(created.status, 201);
  assert.deepEqual(created.json, {
    ok: true,
    agent: { id: 'scout', name: 'Scout', role: 'Files', description: 'Reads my files.', group: 'work', kind: 'persona', cwd: '/invented/scout', provider: 'claude', routines: [] },
  });
  const written = app.registry.writes[0].agents.at(-1);
  assert.deepEqual(written, { id: 'scout', name: 'Scout', role: 'Files', description: 'Reads my files.', group: 'work', kind: 'persona', cwd: '/invented/scout', provider: 'claude' });

  // The hub started it through the registry change and lists it idle.
  await new Promise((resolve) => setTimeout(resolve, 20));
  const scout = (await request(app, 'GET', '/api/state')).json.agents.find((a) => a.id === 'scout');
  assert.equal(scout.state, 'idle');
  assert.deepEqual(scout.model, { id: null, effort: null, source: 'default', default: { id: null, effort: null }, agent: { id: null, effort: null } });

  assert.deepEqual((await post(app, '/api/agents', body)).json, { error: 'duplicate_id' });
  assert.equal((await post(app, '/api/agents', body)).status, 409);
  for (const bad of [{ ...body, id: 'Bad Id' }, settingsBody(), { ...body, kind: 'system' }, { ...body, provider: 'codex' }]) {
    assert.deepEqual((await post(app, '/api/agents', bad)).json, { error: 'invalid_body' }, JSON.stringify(bad));
  }
  const problems = await post(app, '/api/agents', { ...body, id: 'other', role: '' });
  assert.deepEqual([problems.status, problems.json.error, problems.json.problems.length], [400, 'invalid_registry', 1]);
  assert.equal((await post(app, '/api/agents', body, { origin: 'http://evil.example' })).status, 403);
  assert.equal((await request(app, 'GET', '/api/agents')).status, 405);
});

test('without a writable registry the settings routes are not there', async (t) => {
  const registry = { ...fakeRegistry([agent('cfo')]) };
  delete registry.write;
  const app = await startApp(t, { ...status, registry, adapters: { claude: fakeAdapter() }, store: { read: async () => [] } });
  assert.equal((await put(app, '/api/agents/cfo/settings', settingsBody())).status, 404);
  assert.equal((await post(app, '/api/agents', { id: 'x', ...settingsBody() })).status, 404);
});

test('send passes the mentioned agents through, drops ids the registry lacks, and refuses a malformed list', async (t) => {
  const app = await startAgents(t);
  const response = await post(app, '/api/agents/cfo/send', { text: 'Ask @DEV and @OPS.', mentions: ['dev', 'ops', 'nobody', 'dev'] });
  assert.equal(response.status, 202);
  assert.deepEqual(app.adapter.calls, [['send', 'cfo', 'Ask @DEV and @OPS.']]);
  assert.deepEqual(app.adapter.sendOptions, [{ model: null, effort: null, permission: 'ask', mentions: ['dev', 'ops'] }]);
  app.adapter.calls.length = 0;
  app.adapter.sendOptions.length = 0;

  // Only unknown ids: the turn starts with no mentions at all.
  assert.equal((await post(app, '/api/agents/cfo/send', { text: 'Hi', mentions: ['nobody'] })).status, 202);
  assert.deepEqual(app.adapter.sendOptions, [{ model: null, effort: null, permission: 'ask' }]);
  app.adapter.sendOptions.length = 0;

  for (const mentions of ['dev', { dev: true }, [7], ['not an id!'], Array.from({ length: 21 }, () => 'dev')]) {
    const refused = await post(app, '/api/agents/cfo/send', { text: 'Hi', mentions });
    assert.deepEqual([refused.status, refused.json], [400, { error: 'invalid_mentions' }], JSON.stringify(mentions));
  }
  assert.deepEqual(app.adapter.sendOptions, []);
});
