import assert from 'node:assert/strict';
import { test } from 'node:test';

import { RuntimeError } from '../lib/runtime/adapter.mjs';
import { fakeBindings, fakeRegistry, request, startApp } from './support/harness.mjs';

const status = {
  focus: { checkHealth: async () => ({ available: true }) },
  brief: { latestMetadata: async () => ({ state: 'empty' }) },
};
const AT = '2026-09-28T12:00:00.000Z';
const QUESTION_INPUT = { threadId: 't1', questions: [{ id: 'colour', question: 'Which colour?', options: [] }] };

function session(threadId, extra = {}) {
  return {
    id: `codex:${threadId}`, threadId, cwd: '/invented/work', title: `Thread ${threadId}`, state: 'idle', pending: null,
    lastMessage: null, lastError: null, updatedAt: AT, ...extra,
  };
}

// A Codex adapter stand-in: no personas, a fixed session list, recorded
// calls, and refusals by code from `behavior`.
function fakeCodexAdapter(sessions = []) {
  const listeners = new Set();
  const adapter = {
    kind: 'codex',
    calls: [],
    behavior: {},
    list: sessions,
    sessions: () => adapter.list,
    emit: (event) => { for (const fn of listeners) fn(event); },
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    start: () => Promise.reject(new RuntimeError('not_supported', { message: 'Codex threads take messages in their own terminal.' })),
    state: () => ({ state: 'idle', pending: null, lastError: null, sessionId: null, costUsd: null }),
    async answer(agent, requestId, answer) {
      adapter.calls.push(['answer', agent.id, requestId, answer]);
      if (adapter.behavior.answer) throw new RuntimeError(adapter.behavior.answer);
    },
    async interrupt(agent) {
      adapter.calls.push(['interrupt', agent.id]);
    },
    async thread(agent) {
      adapter.calls.push(['thread', agent.id]);
      if (adapter.behavior.thread) throw new RuntimeError(adapter.behavior.thread);
      return { messages: [{ role: 'user', text: 'Hi', at: AT }] };
    },
    close: async () => {},
  };
  return adapter;
}

async function startSessions(t, { sessions, bindings = fakeBindings(), agents = [] } = {}) {
  const adapter = fakeCodexAdapter(sessions ?? [
    session('t1', { state: 'waiting', pending: { requestId: '0', kind: 'question', toolName: 'requestUserInput', input: QUESTION_INPUT, at: AT, native: false }, lastMessage: { role: 'assistant', text: 'x'.repeat(300), at: AT } }),
    session('t2', { updatedAt: '2026-09-28T11:00:00.000Z' }),
  ]);
  const app = await startApp(t, { ...status, registry: fakeRegistry(agents), adapters: { codex: adapter }, bindings });
  return { ...app, adapter, bindings };
}

function post(app, path, body) {
  const json = body === undefined ? undefined : JSON.stringify(body);
  return request(app, 'POST', path, {
    headers: { origin: app.origin, ...(json === undefined ? {} : { 'content-type': 'application/json' }) },
    body: json,
  });
}

test('the snapshot lists sessions with bindings, projected requests, and previews', async (t) => {
  const bindings = fakeBindings(new Map([['t1', Object.freeze({ workspaceId: 'ws-1', surfaceId: 'sf-1' })]]));
  const app = await startSessions(t, { bindings });
  const { sessions } = app.hub.snapshot();
  assert.deepEqual(sessions, [
    {
      id: 'codex:t1', provider: 'codex', threadId: 't1', cwd: '/invented/work', title: 'Thread t1', state: 'waiting',
      pending: { requestId: '0', kind: 'question', toolName: 'requestUserInput', input: QUESTION_INPUT, truncated: false },
      lastMessage: { role: 'assistant', text: 'x'.repeat(200), at: AT }, lastError: null, updatedAt: AT,
      binding: { workspaceId: 'ws-1', surfaceId: 'sf-1' },
    },
    {
      id: 'codex:t2', provider: 'codex', threadId: 't2', cwd: '/invented/work', title: 'Thread t2', state: 'idle',
      pending: null, lastMessage: null, lastError: null, updatedAt: '2026-09-28T11:00:00.000Z', binding: null,
    },
  ]);
  assert.ok(Object.isFrozen(sessions[0]) && Object.isFrozen(sessions[0].pending));
  const state = await request(app, 'GET', '/api/state');
  assert.deepEqual(state.json.sessions.map((s) => s.id), ['codex:t1', 'codex:t2']);
});

test('adapter events and binding changes rebuild sessions and bump only when they differ', async (t) => {
  const app = await startSessions(t);
  const deltas = [];
  app.hub.subscribe((delta) => deltas.push(delta));
  app.adapter.emit({ type: 'thread.state', agentId: 'codex:t2', at: AT, state: 'idle' });
  assert.deepEqual(deltas, []);
  app.adapter.list = [session('t2', { state: 'busy' })];
  app.adapter.emit({ type: 'sessions', agentId: 'codex', at: AT });
  assert.equal(deltas.length, 1);
  assert.deepEqual(Object.keys(deltas[0].patch), ['sessions']);
  assert.deepEqual(deltas[0].patch.sessions.map((s) => [s.id, s.state, s.binding]), [['codex:t2', 'busy', null]]);
  app.bindings.set(new Map([['t2', Object.freeze({ workspaceId: null, surfaceId: null })]]));
  assert.equal(deltas.length, 2);
  assert.deepEqual(deltas[1].patch.sessions[0].binding, { workspaceId: null, surfaceId: null });
  app.adapter.list = [session('t2', { state: 'busy', pending: { requestId: '9', kind: 'approval', toolName: 'mcpServer/elicitation/request', input: {}, at: AT, native: true } })];
  app.adapter.emit({ type: 'request', agentId: 'codex:t2', at: AT, requestId: '9' });
  assert.equal(deltas.at(-1).patch.sessions[0].pending.native, true);
});

test('a Codex persona in the registry is unavailable as provider_unavailable', async (t) => {
  const agents = [{ id: 'dev', name: 'DEV', role: 'Role', description: 'Invented.', group: 'work', kind: 'persona', cwd: '/invented', provider: 'codex', routines: [] }];
  const app = await startSessions(t, { agents });
  const [dev] = app.hub.snapshot().agents;
  assert.deepEqual([dev.state, dev.lastError], ['unavailable', 'provider_unavailable']);
  assert.ok(app.logs.some((entry) => entry.event === 'persona_start_error' && entry.reason === 'provider_unavailable'));
});

test('answer reaches the adapter with the session id and maps its refusals', async (t) => {
  const app = await startSessions(t);
  const ok = await post(app, '/api/sessions/codex:t1/answer', { requestId: '0', answers: { colour: 'Blue' } });
  assert.deepEqual([ok.status, ok.json], [200, { ok: true }]);
  const decided = await post(app, '/api/sessions/codex:t1/answer', { requestId: '0', decision: 'deny' });
  assert.equal(decided.status, 200);
  assert.deepEqual(app.adapter.calls, [
    ['answer', 'codex:t1', '0', { answers: { colour: 'Blue' } }],
    ['answer', 'codex:t1', '0', { decision: 'deny' }],
  ]);
  for (const [code, status] of [['no_such_request', 409], ['not_supported', 409], ['invalid_answer', 400]]) {
    app.adapter.behavior.answer = code;
    const response = await post(app, '/api/sessions/codex:t1/answer', { requestId: '0', decision: 'allow' });
    assert.deepEqual([response.status, response.json], [status, { error: code }], code);
  }
  app.adapter.behavior.answer = null;
  const bad = await post(app, '/api/sessions/codex:t1/answer', { requestId: '0', decision: 'allow', answers: {} });
  assert.deepEqual([bad.status, bad.json], [400, { error: 'invalid_answer' }]);
  const missing = await post(app, '/api/sessions/codex:t9/answer', { requestId: '0', decision: 'allow' });
  assert.deepEqual([missing.status, missing.json], [404, { error: 'no_such_session' }]);
  const noOrigin = await request(app, 'POST', '/api/sessions/codex:t1/answer', {
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId: '0', decision: 'allow' }),
  });
  assert.equal(noOrigin.status, 403);
});

test('interrupt and thread go through the adapter; send and new-thread do not exist for sessions', async (t) => {
  const app = await startSessions(t);
  const interrupted = await post(app, '/api/sessions/codex:t2/interrupt');
  assert.deepEqual([interrupted.status, interrupted.json], [200, { ok: true }]);
  const thread = await request(app, 'GET', '/api/sessions/codex:t2/thread');
  assert.deepEqual([thread.status, thread.json], [200, { messages: [{ role: 'user', text: 'Hi', at: AT }] }]);
  assert.deepEqual(app.adapter.calls, [['interrupt', 'codex:t2'], ['thread', 'codex:t2']]);
  app.adapter.behavior.thread = 'unavailable';
  const down = await request(app, 'GET', '/api/sessions/codex:t2/thread');
  assert.deepEqual([down.status, down.json], [503, { error: 'unavailable' }]);
  for (const path of ['/api/sessions/codex:t2/send', '/api/sessions/codex:t2/new-thread', '/api/sessions/t2/thread', '/api/sessions/codex:t2/thread/x', '/api/sessions/codex:../thread']) {
    const response = await request(app, 'GET', path);
    assert.equal(response.status, 404, path);
    assert.notEqual(response.json?.error, 'no_such_session', path);
  }
  const wrongMethod = await request(app, 'GET', '/api/sessions/codex:t2/interrupt');
  assert.equal(wrongMethod.status, 405);
  const unlisted = await request(app, 'GET', '/api/sessions/codex:t9/thread');
  assert.deepEqual([unlisted.status, unlisted.json], [404, { error: 'no_such_session' }]);
});
