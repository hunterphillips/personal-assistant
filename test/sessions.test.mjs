import assert from 'node:assert/strict';
import { test } from 'node:test';

import { RuntimeError } from '../lib/runtime/adapter.mjs';
import { fakeBindings, fakeCmux, fakeRegistry, request, startApp } from './support/harness.mjs';

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
    connection: { available: true },
    status: () => adapter.connection,
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

async function startSessions(t, { sessions, bindings = fakeBindings(), agents = [], cmux = null } = {}) {
  const adapter = fakeCodexAdapter(sessions ?? [
    session('t1', { state: 'waiting', pending: { requestId: '0', kind: 'question', toolName: 'requestUserInput', input: QUESTION_INPUT, at: AT, native: false }, lastMessage: { role: 'assistant', text: 'x'.repeat(300), at: AT } }),
    session('t2', { updatedAt: '2026-09-28T11:00:00.000Z' }),
  ]);
  const app = await startApp(t, { ...status, registry: fakeRegistry(agents), adapters: { codex: adapter }, bindings, cmux });
  return { ...app, adapter, bindings, cmux };
}

const WS = '1F9F550D-BA32-4C4D-86E1-C4C6FBDB192F';
const SF_OPEN = '9211C31B-34F1-47BF-88D4-C3B1D414A8B3';
const SF_CLAUDE = '00223EE0-DBBE-4EB8-9D20-9330C73C8389';
const SF_GONE = 'E03C63C2-AD4F-4625-BDAA-9E5D3B3646F7';
const CLAUDE_RUNNING = 'a9d25355-6056-4302-9146-5d905cb8cec5';
const CLAUDE_IDLE = 'b1c2d3e4-0000-4000-8000-000000000002';
const CLAUDE_GONE = 'c1c2d3e4-0000-4000-8000-000000000003';

// An inventory as cmux.mjs answers it: two live surfaces, a Claude session
// on each state cmux reports, one whose terminal closed, and a Codex agent
// record, which the hub leaves to the Codex adapter.
function inventory(extra = {}) {
  return Object.freeze({
    available: true,
    stale: false,
    refreshedAt: AT,
    workspaces: [{ id: WS, name: '~', cwd: '/invented' }],
    surfaces: [
      { id: SF_OPEN, workspaceId: WS, paneId: null, title: 'Terminal', cwd: '/invented/work' },
      { id: SF_CLAUDE, workspaceId: WS, paneId: null, title: 'Terminal', cwd: '/invented/claude' },
    ],
    agents: [
      { sessionId: CLAUDE_RUNNING, agent: 'claude', state: 'running', cwd: '/invented/claude', workspaceId: WS, surfaceId: SF_CLAUDE, startedAt: AT, updatedAt: '2026-09-28T11:30:00.000Z', live: true },
      { sessionId: CLAUDE_IDLE, agent: 'claude', state: 'idle', cwd: '/invented/claude', workspaceId: WS, surfaceId: SF_OPEN, startedAt: AT, updatedAt: '2026-09-28T13:00:00.000Z', live: true },
      { sessionId: CLAUDE_GONE, agent: 'claude', state: 'needsInput', cwd: null, workspaceId: WS, surfaceId: SF_GONE, startedAt: AT, updatedAt: null, live: false },
      { sessionId: 'codex-record', agent: 'codex', state: 'running', cwd: '/invented/work', workspaceId: WS, surfaceId: SF_OPEN, startedAt: AT, updatedAt: AT, live: true },
    ],
    ...extra,
  });
}

const UNAVAILABLE = Object.freeze({ available: false, reason: 'not_running', stale: false, refreshedAt: AT, workspaces: [], surfaces: [], agents: [] });

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
      binding: { workspaceId: 'ws-1', surfaceId: 'sf-1', live: false },
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
  assert.deepEqual(deltas[1].patch.sessions[0].binding, { workspaceId: null, surfaceId: null, live: false });
  app.adapter.list = [session('t2', { state: 'busy', pending: { requestId: '9', kind: 'approval', toolName: 'mcpServer/elicitation/request', input: {}, at: AT, native: true } })];
  app.adapter.emit({ type: 'request', agentId: 'codex:t2', at: AT, requestId: '9' });
  assert.equal(deltas.at(-1).patch.sessions[0].pending.native, true);

  // The server going away shows up as `codex` beside the unavailable rows.
  assert.deepEqual(app.hub.snapshot().codex, { available: true });
  app.adapter.list = [session('t2', { state: 'unavailable', lastError: 'server_gone' })];
  app.adapter.connection = { available: false, reason: 'disconnected' };
  app.adapter.emit({ type: 'sessions', agentId: 'codex', at: AT });
  assert.deepEqual(Object.keys(deltas.at(-1).patch).sort(), ['codex', 'sessions']);
  assert.deepEqual(deltas.at(-1).patch.codex, { available: false, reason: 'disconnected' });
  assert.deepEqual([deltas.at(-1).patch.sessions[0].state, deltas.at(-1).patch.sessions[0].lastError], ['unavailable', 'server_gone']);
  app.adapter.connection = { available: false, reason: 'Not A Word' };
  app.adapter.emit({ type: 'sessions', agentId: 'codex', at: AT });
  assert.deepEqual(deltas.at(-1).patch, { codex: { available: false, reason: 'unknown' } });
  const state = await request(app, 'GET', '/api/state');
  assert.deepEqual(state.json.codex, { available: false, reason: 'unknown' });
});

test('sessions are the union of Codex threads and cmux Claude terminals, newest first, with bindings checked against the live surfaces', async (t) => {
  const bindings = fakeBindings(new Map([
    ['t1', Object.freeze({ workspaceId: WS, surfaceId: SF_OPEN.toLowerCase() })],
    ['t2', Object.freeze({ workspaceId: WS, surfaceId: SF_GONE })],
  ]));
  const cmux = fakeCmux(inventory());
  const app = await startSessions(t, { bindings, cmux });
  // Before the first refresh nothing is live and the snapshot says why.
  assert.deepEqual(app.hub.snapshot().cmux, { available: false, reason: 'not_refreshed' });
  assert.deepEqual(app.hub.snapshot().sessions.map((s) => [s.id, s.binding.live]), [['codex:t1', false], ['codex:t2', false]]);

  const deltas = [];
  app.hub.subscribe((delta) => deltas.push(delta));
  await app.hub.refreshSessions();
  assert.equal(cmux.refreshes, 1);
  assert.deepEqual(Object.keys(deltas.at(-1).patch).sort(), ['cmux', 'sessions']);
  const { sessions, cmux: cmuxState } = app.hub.snapshot();
  assert.deepEqual(cmuxState, { available: true });
  assert.deepEqual(sessions.map((s) => s.id), [`claude:${CLAUDE_IDLE}`, 'codex:t1', `claude:${CLAUDE_RUNNING}`, 'codex:t2', `claude:${CLAUDE_GONE}`]);
  assert.deepEqual(sessions[1].binding, { workspaceId: WS, surfaceId: SF_OPEN.toLowerCase(), live: true });
  assert.deepEqual(sessions[3].binding, { workspaceId: WS, surfaceId: SF_GONE, live: false });
  assert.deepEqual(sessions[0], {
    id: `claude:${CLAUDE_IDLE}`, provider: 'claude', kind: 'terminal', cwd: '/invented/claude', state: 'idle',
    updatedAt: '2026-09-28T13:00:00.000Z', binding: { workspaceId: WS, surfaceId: SF_OPEN, live: true },
  });
  assert.deepEqual([sessions[2].state, sessions[2].binding.live], ['busy', true]);
  assert.deepEqual(sessions[4], {
    id: `claude:${CLAUDE_GONE}`, provider: 'claude', kind: 'terminal', cwd: null, state: 'unknown', updatedAt: null,
    binding: { workspaceId: WS, surfaceId: SF_GONE, live: false },
  });
  assert.ok(sessions.every((s) => s.provider !== 'codex' || !('kind' in s)), 'Codex rows keep their shape');
  assert.ok(Object.isFrozen(sessions[0]) && Object.isFrozen(sessions[0].binding));

  // The same inventory again bumps nothing; a stale one only changes `cmux`.
  const count = deltas.length;
  await app.hub.refreshSessions();
  assert.equal(deltas.length, count);
  cmux.set(inventory({ stale: true }));
  await app.hub.refreshSessions();
  assert.deepEqual(deltas.at(-1).patch, { cmux: { available: true, stale: true } });

  // cmux gone: terminal rows go with it and no binding is live.
  cmux.set(UNAVAILABLE);
  await app.hub.refreshSessions();
  assert.deepEqual(app.hub.snapshot().cmux, { available: false, reason: 'not_running' });
  assert.deepEqual(app.hub.snapshot().sessions.map((s) => [s.id, s.binding.live]), [['codex:t1', false], ['codex:t2', false]]);
  const state = await request(app, 'GET', '/api/state');
  assert.deepEqual(state.json.cmux, { available: false, reason: 'not_running' });
});

test('open-terminal focuses exactly the bound surface and refuses unbound, unavailable, closed, and failed cases', async (t) => {
  const bindings = fakeBindings(new Map([
    ['t1', Object.freeze({ workspaceId: WS, surfaceId: SF_OPEN })],
    ['t2', Object.freeze({ workspaceId: null, surfaceId: null })],
  ]));
  const cmux = fakeCmux(inventory());
  const app = await startSessions(t, { bindings, cmux });

  let response = await post(app, '/api/sessions/codex:t1/open-terminal');
  assert.deepEqual([response.status, response.json], [503, { error: 'cmux_unavailable', reason: 'not_refreshed' }]);
  await app.hub.refreshSessions();

  response = await post(app, '/api/sessions/codex:t1/open-terminal');
  assert.deepEqual([response.status, response.json], [200, { ok: true, verified: true }]);
  response = await post(app, `/api/sessions/claude:${CLAUDE_RUNNING}/open-terminal`);
  assert.deepEqual([response.status, response.json], [200, { ok: true, verified: true }]);
  assert.deepEqual(cmux.focusCalls, [{ workspaceId: WS, surfaceId: SF_OPEN }, { workspaceId: WS, surfaceId: SF_CLAUDE }]);

  cmux.focusResult = { ok: true, verified: false };
  response = await post(app, '/api/sessions/codex:t1/open-terminal');
  assert.deepEqual([response.status, response.json], [200, { ok: true, verified: false }]);
  cmux.focusResult = { ok: false, reason: 'not_found' };
  response = await post(app, '/api/sessions/codex:t1/open-terminal');
  assert.deepEqual([response.status, response.json], [502, { error: 'focus_failed', reason: 'not_found' }]);

  response = await post(app, '/api/sessions/codex:t2/open-terminal');
  assert.deepEqual([response.status, response.json], [409, { error: 'unbound' }]);
  response = await post(app, `/api/sessions/claude:${CLAUDE_GONE}/open-terminal`);
  assert.deepEqual([response.status, response.json], [409, { error: 'terminal_closed' }]);
  response = await post(app, '/api/sessions/codex:t9/open-terminal');
  assert.deepEqual([response.status, response.json], [404, { error: 'no_such_session' }]);
  assert.equal(cmux.focusCalls.length, 4, 'nothing was focused by guesswork');

  cmux.set(UNAVAILABLE);
  await app.hub.refreshSessions();
  response = await post(app, '/api/sessions/codex:t1/open-terminal');
  assert.deepEqual([response.status, response.json], [503, { error: 'cmux_unavailable', reason: 'not_running' }]);

  // The route is a bodyless POST on sessions only.
  const withBody = await post(app, '/api/sessions/codex:t1/open-terminal', {});
  assert.equal(withBody.status, 413);
  const noOrigin = await request(app, 'POST', '/api/sessions/codex:t1/open-terminal');
  assert.equal(noOrigin.status, 403);
  const wrongMethod = await request(app, 'GET', '/api/sessions/codex:t1/open-terminal');
  assert.equal(wrongMethod.status, 405);
  const persona = await request(app, 'GET', '/api/agents/dev/open-terminal');
  assert.equal(persona.status, 404);
});

test('a terminal row has no adapter: answer, interrupt, and thread are not_supported', async (t) => {
  const cmux = fakeCmux(inventory());
  const app = await startSessions(t, { cmux });
  await app.hub.refreshSessions();
  const id = `claude:${CLAUDE_RUNNING}`;
  const answered = await post(app, `/api/sessions/${id}/answer`, { requestId: '0', decision: 'allow' });
  assert.deepEqual([answered.status, answered.json], [409, { error: 'not_supported' }]);
  const interrupted = await post(app, `/api/sessions/${id}/interrupt`);
  assert.deepEqual([interrupted.status, interrupted.json], [409, { error: 'not_supported' }]);
  const thread = await request(app, 'GET', `/api/sessions/${id}/thread`);
  assert.deepEqual([thread.status, thread.json], [409, { error: 'not_supported' }]);
  assert.deepEqual(app.adapter.calls, []);
  const unknown = await request(app, 'GET', '/api/sessions/claude:nobody/thread');
  assert.deepEqual([unknown.status, unknown.json], [404, { error: 'no_such_session' }]);
  const other = await request(app, 'GET', `/api/sessions/gemini:${CLAUDE_RUNNING}/thread`);
  assert.deepEqual([other.status, other.json], [404, { error: 'not_found' }]);
});

test('POST /api/sessions/refresh refreshes the inventory and the Codex catalogue and answers the new revision', async (t) => {
  const cmux = fakeCmux(inventory());
  const app = await startSessions(t, { cmux });
  let codexRefreshes = 0;
  app.adapter.refresh = async () => { codexRefreshes += 1; };
  const before = app.hub.snapshot().revision;
  const response = await post(app, '/api/sessions/refresh');
  assert.equal(response.status, 200);
  assert.deepEqual([cmux.refreshes, codexRefreshes], [1, 1]);
  assert.ok(response.json.revision > before);
  assert.deepEqual(response.json, { ok: true, revision: app.hub.snapshot().revision });
  assert.equal(app.hub.snapshot().sessions.filter((s) => s.kind === 'terminal').length, 3);
  const again = await post(app, '/api/sessions/refresh');
  assert.deepEqual(again.json, { ok: true, revision: response.json.revision }, 'nothing changed, so no bump');
  const noOrigin = await request(app, 'POST', '/api/sessions/refresh');
  assert.equal(noOrigin.status, 403);
  const withBody = await post(app, '/api/sessions/refresh', {});
  assert.equal(withBody.status, 413);
  const wrongMethod = await request(app, 'GET', '/api/sessions/refresh');
  assert.equal(wrongMethod.status, 405);
});

test('without a Codex adapter the snapshot says so', async (t) => {
  const app = await startApp(t, { ...status, registry: fakeRegistry([]), adapters: {} });
  assert.deepEqual(app.hub.snapshot().codex, { available: false, reason: 'no_adapter' });
  assert.deepEqual(app.hub.snapshot().sessions, []);
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
