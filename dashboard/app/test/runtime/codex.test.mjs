import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { writeFile } from 'node:fs/promises';
import { test } from 'node:test';

import { createCodexAdapter } from '../../lib/runtime/codex.mjs';
import { startCodexServer, until } from '../support/codex-server.mjs';

const AT = '2026-09-28T12:00:00.000Z';
const TIMEOUTS = { codexPollMs: 20, codexReconnectMs: 20, codexReconnectMaxMs: 80, abortGraceMs: 500 };
const LIMITS = { codexThreads: 20, codexFrameBytes: 1024 * 1024, messageTextBytes: 64, threadCacheMessages: 200 };
const WORK = '/invented/work';

const QUESTION = {
  itemId: 'call_1',
  turnId: 'turn-1',
  questions: [{
    id: 'colour', header: 'Colour', question: 'Which colour should I use?', isOther: true, isSecret: false,
    options: [{ label: 'Amber', description: 'Use amber.' }, { label: 'Blue', description: 'Use blue.' }],
  }],
  isBlocking: false,
  autoResolutionMs: null,
};
const PERMISSIONS = {
  network: null,
  fileSystem: { read: null, write: [`${WORK}/marker.txt`], entries: [{ path: { type: 'path', path: `${WORK}/marker.txt` }, access: 'write' }] },
};

function thread(id, extra = {}) {
  return { id, cwd: WORK, name: null, preview: `Prompt for ${id}`, updatedAt: 1_790_596_000, status: { type: 'idle' }, ...extra };
}

async function setup(t, {
  threads = [], handlers, owner = true, timeouts = {}, limits = {}, loaded = null, pageSize = null, bound = () => [], connect,
} = {}) {
  const server = await startCodexServer(t, { threads, handlers, loaded, pageSize });
  if (owner) await server.writeOwner();
  const logs = [];
  const events = [];
  const adapter = createCodexAdapter({
    ownerFile: server.ownerFile,
    bound,
    log: (entry) => logs.push(entry),
    timeouts: { ...TIMEOUTS, ...timeouts },
    limits: { ...LIMITS, ...limits },
    now: () => new Date(AT),
    ...(connect ? { connect } : {}),
  });
  adapter.subscribe((event) => events.push(event));
  t.after(() => adapter.close());
  return { server, adapter, logs, events };
}

// Resolves once `count` distinct threads have been resumed and their newest
// turn read: the adapter emits `sessions` with the threadId after each.
async function connected(server, adapter, events, count) {
  if (count === 0) {
    await until(() => adapter.status().available, 2_000, 'connected');
    return;
  }
  await until(() => resumed(events).size >= count, 2_000, 'follows');
  await until(() => adapter.sessions().length >= count, 2_000, 'sessions');
}

const resumed = (events) => new Set(events.filter((event) => event.type === 'sessions' && event.threadId).map((event) => event.threadId));

const ofType = (events, type) => events.filter((event) => event.type === type);
const requestsFor = (server, method) => server.requests.filter((request) => request.method === method);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('connects, follows the loaded threads newest first, resumes each, and replays a waiting request', async (t) => {
  const { server, adapter, events } = await setup(t, {
    threads: [
      thread('older', { updatedAt: 100, name: 'Named thread' }),
      thread('busy', { updatedAt: 300, status: { type: 'active', activeFlags: [] }, turns: [{ id: 'turn-b', items: [], status: 'inProgress', startedAt: 1_790_596_000 }] }),
      thread('waiting', {
        updatedAt: 200,
        status: { type: 'active', activeFlags: ['waitingOnUserInput'] },
        waiting: { id: 2, method: 'item/tool/requestUserInput', params: QUESTION },
        turns: [{ id: 'turn-w', items: [{ type: 'agentMessage', id: 'm1', text: 'Working on it', phase: 'commentary' }], status: 'inProgress', startedAt: 1_790_596_100 }],
      }),
    ],
  });
  assert.deepEqual(adapter.status(), { available: false, reason: 'no_server' });
  await connected(server, adapter, events, 3);
  await until(() => ofType(events, 'request').length === 1, 2_000, 'replayed request');
  assert.deepEqual(adapter.status(), { available: true });

  const [initialize] = requestsFor(server, 'initialize');
  assert.deepEqual(initialize.params, { clientInfo: { name: 'personal-assistant-dashboard', version: '0.1.0' }, capabilities: { experimentalApi: true } });
  assert.deepEqual(server.notifications.map((n) => n.method), ['initialized']);
  const [list] = requestsFor(server, 'thread/loaded/list');
  assert.deepEqual(list.params, { limit: 50 });
  assert.equal(requestsFor(server, 'thread/list').length, 0);
  assert.deepEqual(requestsFor(server, 'thread/resume').map((r) => r.params).sort((a, b) => a.threadId.localeCompare(b.threadId)), [
    { threadId: 'busy', excludeTurns: true }, { threadId: 'older', excludeTurns: true }, { threadId: 'waiting', excludeTurns: true },
  ]);

  const sessions = adapter.sessions();
  assert.deepEqual(sessions.map((s) => [s.id, s.state, s.title]), [
    ['codex:busy', 'busy', 'Prompt for busy'],
    ['codex:waiting', 'waiting', 'Prompt for waiting'],
    ['codex:older', 'idle', 'Named thread'],
  ]);
  assert.deepEqual(Object.keys(sessions[0]).sort(), ['cwd', 'id', 'lastError', 'lastMessage', 'pending', 'state', 'threadId', 'title', 'updatedAt']);
  assert.equal(sessions[0].cwd, WORK);
  assert.equal(sessions[0].updatedAt, new Date(300 * 1000).toISOString());
  const waiting = sessions[1];
  assert.deepEqual(waiting.lastMessage, { role: 'assistant', text: 'Working on it', at: new Date(1_790_596_100 * 1000).toISOString() });
  assert.deepEqual(waiting.pending, {
    requestId: '2', kind: 'question', toolName: 'requestUserInput', input: { threadId: 'waiting', ...QUESTION }, at: AT, native: false,
  });
  const request = ofType(events, 'request')[0];
  assert.deepEqual(request, {
    type: 'request', agentId: 'codex:waiting', at: AT, requestId: '2', kind: 'question', toolName: 'requestUserInput',
    input: { threadId: 'waiting', ...QUESTION }, native: false,
  });
  assert.deepEqual(adapter.state('codex:waiting'), { state: 'waiting', pending: waiting.pending, lastError: null, sessionId: 'waiting', costUsd: null });
  assert.deepEqual(adapter.state('codex:none'), { state: 'idle', pending: null, lastError: null, sessionId: null, costUsd: null });

  // Later polls list again but resume nothing twice.
  await sleep(100);
  assert.ok(requestsFor(server, 'thread/loaded/list').length > 1);
  assert.equal(requestsFor(server, 'thread/resume').length, 3);
});

test('the loaded list is followed across pages', async (t) => {
  const threads = Array.from({ length: 7 }, (_, i) => thread(`t${i}`, { updatedAt: 1_000 + i }));
  const { server, adapter, events } = await setup(t, { threads, pageSize: 3 });
  await connected(server, adapter, events, 7);
  const pages = requestsFor(server, 'thread/loaded/list').slice(0, 3);
  assert.deepEqual(pages.map((r) => r.params), [{ limit: 50 }, { limit: 50, cursor: '3' }, { limit: 50, cursor: '6' }]);
  assert.deepEqual(adapter.sessions().map((s) => s.threadId), ['t6', 't5', 't4', 't3', 't2', 't1', 't0']);
  assert.equal(requestsFor(server, 'thread/resume').length, 7);
});

test('rows are capped at codexThreads: the oldest idle unbound threads are evicted and not adopted again', async (t) => {
  const threads = Array.from({ length: 7 }, (_, i) => thread(`t${i}`, { updatedAt: 1_000 + i }));
  threads[0].status = { type: 'active', activeFlags: [] };
  const { server, adapter, events, logs } = await setup(t, { threads, limits: { codexThreads: 3 }, bound: () => ['t1'] });
  await until(() => resumed(events).size === 7, 2_000, 'follows');
  await until(() => adapter.sessions().length === 3, 2_000, 'evicted');
  // t0 is busy and t1 is bound, so the newest idle unbound thread stays.
  assert.deepEqual(adapter.sessions().map((s) => s.threadId), ['t6', 't1', 't0']);
  assert.deepEqual(logs.filter((entry) => entry.event === 'codex_catalogue_evicted'), [{ event: 'codex_catalogue_evicted', threads: 4 }]);
  await sleep(100);
  assert.equal(adapter.sessions().length, 3);
  assert.equal(requestsFor(server, 'thread/resume').length, 7);
});

test('the catalogue is loaded or bound threads only, re-read on every poll', async (t) => {
  const bound = new Set(['bound']);
  const { server, adapter, events, logs } = await setup(t, {
    threads: [thread('loaded', { updatedAt: 300 }), thread('listed', { updatedAt: 200 }), thread('bound', { updatedAt: 100 })],
    loaded: ['loaded'],
    bound: () => bound,
  });
  await connected(server, adapter, events, 2);
  // 'listed' is in thread/list only: never resumed.
  assert.deepEqual(adapter.sessions().map((s) => [s.threadId, s.title]), [['loaded', 'Prompt for loaded'], ['bound', 'Prompt for bound']]);
  assert.deepEqual(requestsFor(server, 'thread/resume').map((r) => r.params.threadId).sort(), ['bound', 'loaded']);
  assert.equal(requestsFor(server, 'thread/list').length, 0);
  assert.deepEqual(logs.filter((entry) => entry.event === 'codex_catalogue'), [{ event: 'codex_catalogue', threads: 2, added: 2, dropped: 0 }]);

  // A thread that becomes loaded later (the TUI or codex-new started it)
  // is adopted on the next poll without any notification.
  server.loaded.add('listed');
  await until(() => adapter.sessions().some((s) => s.threadId === 'listed' && s.title === 'Prompt for listed'), 2_000, 'adopted');
  assert.equal(requestsFor(server, 'thread/resume').filter((r) => r.params.threadId === 'listed').length, 1);

  // One that leaves both sets is dropped.
  server.loaded.delete('listed');
  await until(() => !adapter.sessions().some((s) => s.threadId === 'listed'), 2_000, 'dropped');
  bound.delete('bound');
  server.loaded.delete('bound');
  await until(() => adapter.sessions().length === 1, 2_000, 'unbound dropped');
  assert.deepEqual(logs.filter((entry) => entry.event === 'codex_catalogue').map((entry) => [entry.added, entry.dropped]), [[2, 0], [1, 0], [0, 1], [0, 1]]);
});

test('a loaded thread with no rollout keeps its row and is resumed once it has one; a bound-only one without a rollout is dropped until the next connection', async (t) => {
  const { server, adapter, events, logs } = await setup(t, {
    threads: [thread('ok', { updatedAt: 300 }), thread('fresh', { updatedAt: 200, unpersisted: true })],
    bound: () => ['ghost'],
  });
  await connected(server, adapter, events, 1);
  await until(() => logs.filter((entry) => entry.event === 'codex_resume_error').length === 2, 2_000, 'resume errors');
  assert.deepEqual(logs.filter((entry) => entry.event === 'codex_resume_error').sort((a, b) => a.threadId.localeCompare(b.threadId)), [
    { event: 'codex_resume_error', threadId: 'fresh', error: 'not_persisted', retry: true },
    { event: 'codex_resume_error', threadId: 'ghost', error: 'not_persisted', retry: false },
  ]);
  assert.deepEqual(adapter.sessions().map((s) => [s.threadId, s.title, s.state]), [['ok', 'Prompt for ok', 'idle'], ['fresh', null, 'idle']]);

  // Retried with a growing wait, logged once.
  await until(() => requestsFor(server, 'thread/resume').filter((r) => r.params.threadId === 'fresh').length >= 3, 2_000, 'retries');
  server.threads.get('fresh').unpersisted = false;
  await until(() => adapter.sessions().some((s) => s.threadId === 'fresh' && s.title === 'Prompt for fresh'), 2_000, 'resumed');
  assert.equal(logs.filter((entry) => entry.event === 'codex_resume_error' && entry.threadId === 'fresh').length, 1);

  // The failed one is not tried again on this connection.
  await sleep(60);
  assert.equal(requestsFor(server, 'thread/resume').filter((r) => r.params.threadId === 'ghost').length, 1);
  assert.equal(logs.filter((entry) => entry.event === 'codex_resume_error' && entry.threadId === 'ghost').length, 1);

  // The next connection starts over: tried once more, logged once more.
  await server.disconnectAll();
  await until(() => server.connections.length === 2, 2_000, 'reconnect');
  await until(() => requestsFor(server, 'thread/resume').filter((r) => r.params.threadId === 'ghost').length === 2, 2_000, 'second attempt');
  await until(() => logs.filter((entry) => entry.event === 'codex_resume_error' && entry.threadId === 'ghost').length === 2, 2_000, 'logged again');
  await sleep(60);
  assert.equal(requestsFor(server, 'thread/resume').filter((r) => r.params.threadId === 'ghost').length, 2);
  assert.ok(!adapter.sessions().some((s) => s.threadId === 'ghost'));
});

test('a bound thread whose resume timed out is skipped for that connection and followed on the next', async (t) => {
  const { server, adapter, events, logs } = await setup(t, {
    threads: [thread('ok', { updatedAt: 300 }), thread('slow', { updatedAt: 200, silent: true })],
    loaded: ['ok'],
    bound: () => ['slow'],
    timeouts: { codexRpcMs: 60 },
  });
  await connected(server, adapter, events, 1);
  await until(() => logs.some((entry) => entry.event === 'codex_resume_error' && entry.threadId === 'slow'), 2_000, 'timeout');
  assert.deepEqual(logs.filter((entry) => entry.event === 'codex_resume_error'), [{ event: 'codex_resume_error', threadId: 'slow', error: 'timeout', retry: false }]);
  assert.deepEqual(adapter.sessions().map((s) => s.threadId), ['ok']);
  await sleep(100);
  assert.equal(requestsFor(server, 'thread/resume').filter((r) => r.params.threadId === 'slow').length, 1, 'not tried again on this connection');

  server.threads.get('slow').silent = false;
  await server.disconnectAll();
  await until(() => server.connections.length === 2, 2_000, 'reconnect');
  await until(() => adapter.sessions().some((s) => s.threadId === 'slow' && s.state === 'idle' && s.title === 'Prompt for slow'), 2_000, 'followed');
  assert.equal(requestsFor(server, 'thread/resume').filter((r) => r.params.threadId === 'slow').length, 2);
  assert.deepEqual(adapter.sessions().map((s) => s.threadId), ['ok', 'slow']);
});

test('a question is answered with the exact Codex reply shape, keyed by question id or text', async (t) => {
  const { server, adapter, events } = await setup(t, { threads: [thread('q', { status: { type: 'active', activeFlags: [] } })] });
  await connected(server, adapter, events, 1);
  server.ask('item/tool/requestUserInput', 0, { threadId: 'q', ...QUESTION });
  const request = await until(() => ofType(events, 'request')[0], 2_000, 'request');
  assert.equal(request.requestId, '0');
  assert.equal(adapter.state('codex:q').state, 'waiting');

  for (const bad of [null, 'Blue', { decision: 'deny' }, { answers: {} }, { answers: { size: 'L' } }, { answers: { colour: '' } }, { answers: { colour: [] } }]) {
    await assert.rejects(adapter.answer('codex:q', '0', bad), { code: 'invalid_answer' }, JSON.stringify(bad));
  }
  await assert.rejects(adapter.answer('codex:q', '1', { answers: { colour: 'Blue' } }), { code: 'no_such_request' });
  await assert.rejects(adapter.answer('codex:other', '0', { answers: { colour: 'Blue' } }), { code: 'no_such_request' });

  await adapter.answer('codex:q', '0', { answers: { 'Which colour should I use?': 'Blue' } });
  await until(() => server.replies.length === 1, 2_000, 'reply');
  assert.deepEqual(server.replies[0], { jsonrpc: '2.0', id: 0, result: { answers: { colour: { answers: ['Blue'] } } } });
  assert.deepEqual(ofType(events, 'resolved'), [{ type: 'resolved', agentId: 'codex:q', at: AT, requestId: '0', outcome: 'answered' }]);
  assert.equal(adapter.state('codex:q').state, 'busy');
  await assert.rejects(adapter.answer('codex:q', '0', { answers: { colour: 'Blue' } }), { code: 'no_such_request' });

  server.ask('item/tool/requestUserInput', 1, { threadId: 'q', ...QUESTION });
  await until(() => ofType(events, 'request').length === 2, 2_000, 'second request');
  await adapter.answer('codex:q', '1', { answers: { colour: ['Blue', 'Amber'] } });
  await until(() => server.replies.length === 2, 2_000, 'reply');
  assert.deepEqual(server.replies[1].result, { answers: { colour: { answers: ['Blue', 'Amber'] } } });
});

test('command and file-change approvals reply accept or decline and nothing broader', async (t) => {
  const { server, adapter, events } = await setup(t, { threads: [thread('a', { status: { type: 'active', activeFlags: [] } })] });
  await connected(server, adapter, events, 1);
  const command = { threadId: 'a', turnId: 't', itemId: 'exec-1', command: ['rm', '-rf', 'build'], cwd: WORK, reason: 'Clean', availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'], startedAtMs: 1 };
  server.ask('item/commandExecution/requestApproval', 3, command);
  const first = await until(() => ofType(events, 'request')[0], 2_000, 'request');
  assert.deepEqual([first.kind, first.toolName, first.native, first.input], ['approval', 'commandExecution', false, command]);
  for (const bad of [{ answers: { x: 'y' } }, { decision: 'acceptForSession' }, { decision: 'accept' }, {}]) {
    await assert.rejects(adapter.answer('codex:a', '3', bad), { code: 'invalid_answer' });
  }
  await adapter.answer('codex:a', '3', { decision: 'allow' });
  server.ask('item/fileChange/requestApproval', 4, { threadId: 'a', turnId: 't', itemId: 'patch-1', reason: null, grantRoot: null, startedAtMs: 2 });
  const second = await until(() => ofType(events, 'request')[1], 2_000, 'request');
  assert.deepEqual([second.kind, second.toolName, second.native], ['approval', 'fileChange', false]);
  await adapter.answer('codex:a', '4', { decision: 'deny' });
  await until(() => server.replies.length === 2, 2_000, 'replies');
  assert.deepEqual(server.replies, [
    { jsonrpc: '2.0', id: 3, result: { decision: 'accept' } },
    { jsonrpc: '2.0', id: 4, result: { decision: 'decline' } },
  ]);
  assert.deepEqual(ofType(events, 'resolved').map((e) => [e.requestId, e.outcome]), [['3', 'allowed'], ['4', 'denied']]);

  // A command approval that cannot be accepted outright is native only.
  server.ask('item/commandExecution/requestApproval', 5, { ...command, availableDecisions: ['acceptForSession', 'decline'] });
  const native = await until(() => ofType(events, 'request')[2], 2_000, 'request');
  assert.equal(native.native, true);
  await assert.rejects(adapter.answer('codex:a', '5', { decision: 'allow' }), { code: 'not_supported' });
  assert.equal(server.replies.length, 2);
  // So is a request method the adapter does not know.
  server.ask('mcpServer/elicitation/request', 6, { threadId: 'a', turnId: 't', serverName: 'x', message: 'Pick one' });
  const unknown = await until(() => ofType(events, 'request')[3], 2_000, 'request');
  assert.deepEqual([unknown.kind, unknown.toolName, unknown.native], ['approval', 'mcpServer/elicitation/request', true]);
});

test('a permission request is denied with an empty profile or granted exactly as asked, for the turn', async (t) => {
  const { server, adapter, events } = await setup(t, { threads: [thread('p', { status: { type: 'active', activeFlags: [] } })] });
  await connected(server, adapter, events, 1);
  const params = { threadId: 'p', turnId: 't', itemId: 'exec-2', cwd: WORK, reason: 'Write marker.txt?', permissions: PERMISSIONS, startedAtMs: 3 };
  server.ask('item/permissions/requestApproval', 1, params);
  await until(() => ofType(events, 'request')[0], 2_000, 'request');
  assert.deepEqual([ofType(events, 'request')[0].toolName, ofType(events, 'request')[0].native], ['permissions', false]);
  await adapter.answer('codex:p', '1', { decision: 'deny' });
  server.ask('item/permissions/requestApproval', 2, params);
  await until(() => ofType(events, 'request')[1], 2_000, 'request');
  await adapter.answer('codex:p', '2', { decision: 'allow' });
  await until(() => server.replies.length === 2, 2_000, 'replies');
  assert.deepEqual(server.replies, [
    { jsonrpc: '2.0', id: 1, result: { permissions: {}, scope: 'turn' } },
    { jsonrpc: '2.0', id: 2, result: { permissions: PERMISSIONS, scope: 'turn' } },
  ]);
});

test('replies are keyed by thread and request id', async (t) => {
  const { server, adapter, events } = await setup(t, { threads: [thread('one'), thread('two')] });
  await connected(server, adapter, events, 2);
  server.ask('item/tool/requestUserInput', 0, { threadId: 'one', ...QUESTION });
  server.ask('item/tool/requestUserInput', 0, { threadId: 'two', ...QUESTION });
  await until(() => ofType(events, 'request').length === 2, 2_000, 'requests');
  await adapter.answer('codex:two', '0', { answers: { colour: 'Amber' } });
  await until(() => server.replies.length === 1, 2_000, 'reply');
  assert.deepEqual(server.replies[0].result, { answers: { colour: { answers: ['Amber'] } } });
  assert.equal(adapter.state('codex:one').state, 'waiting');
  assert.equal(adapter.state('codex:one').pending.requestId, '0');
  assert.equal(adapter.state('codex:two').pending, null);
  assert.deepEqual(ofType(events, 'resolved').map((e) => e.agentId), ['codex:two']);
});

test('a request the server resolved elsewhere is gone: no_such_request', async (t) => {
  const { server, adapter, events } = await setup(t, { threads: [thread('r')] });
  await connected(server, adapter, events, 1);
  server.ask('item/tool/requestUserInput', 7, { threadId: 'r', ...QUESTION });
  await until(() => ofType(events, 'request')[0], 2_000, 'request');
  server.notify('serverRequest/resolved', { threadId: 'r', requestId: 7 });
  await until(() => ofType(events, 'resolved')[0], 2_000, 'resolved');
  assert.deepEqual(ofType(events, 'resolved')[0], { type: 'resolved', agentId: 'codex:r', at: AT, requestId: '7', outcome: 'external' });
  await assert.rejects(adapter.answer('codex:r', '7', { answers: { colour: 'Blue' } }), { code: 'no_such_request' });
  assert.equal(server.replies.length, 0);
});

test('notifications drive state, messages, errors, usage, and membership', async (t) => {
  const { server, adapter, events } = await setup(t, { threads: [thread('n')] });
  await connected(server, adapter, events, 1);
  const before = events.length;
  server.notify('turn/started', { threadId: 'n', turn: { id: 'turn-9', items: [], status: 'inProgress' } });
  server.notify('thread/status/changed', { threadId: 'n', status: { type: 'active', activeFlags: [] } });
  server.notify('item/completed', { threadId: 'n', turnId: 'turn-9', item: { type: 'userMessage', id: 'u', content: [{ type: 'text', text: 'Do the thing' }] } });
  server.notify('item/completed', { threadId: 'n', turnId: 'turn-9', item: { type: 'reasoning', id: 'rs', summary: [], content: [] } });
  server.notify('item/completed', { threadId: 'n', turnId: 'turn-9', item: { type: 'agentMessage', id: 'm', text: 'x'.repeat(100), phase: 'final_answer' } });
  server.notify('thread/tokenUsage/updated', { threadId: 'n', turnId: 'turn-9', tokenUsage: { total: { totalTokens: 5 }, last: { totalTokens: 5 } } });
  server.notify('thread/status/changed', { threadId: 'n', status: { type: 'idle' } });
  server.notify('turn/completed', { threadId: 'n', turn: { id: 'turn-9', items: [], status: 'completed' } });
  await until(() => ofType(events, 'thread.state').length >= 2 && ofType(events, 'usage').length === 1, 2_000, 'turn');
  const fresh = events.slice(before).filter((e) => e.type !== 'sessions');
  assert.deepEqual(fresh.map((e) => e.type), ['thread.state', 'message', 'message', 'usage', 'thread.state']);
  assert.deepEqual(fresh[0], { type: 'thread.state', agentId: 'codex:n', at: AT, state: 'busy' });
  assert.deepEqual(fresh[1], { type: 'message', agentId: 'codex:n', at: AT, role: 'user', text: 'Do the thing' });
  assert.deepEqual(fresh[2], { type: 'message', agentId: 'codex:n', at: AT, role: 'assistant', text: 'x'.repeat(64), truncated: true });
  assert.deepEqual(fresh[3], { type: 'usage', agentId: 'codex:n', at: AT, usage: { total: { totalTokens: 5 }, last: { totalTokens: 5 } }, costUsd: null, denials: [] });
  assert.deepEqual(fresh[4], { type: 'thread.state', agentId: 'codex:n', at: AT, state: 'idle' });
  assert.deepEqual(adapter.sessions()[0].lastMessage, { role: 'assistant', text: 'x'.repeat(64), at: AT, truncated: true });

  // A failed turn ends in error with the server's message.
  server.notify('turn/started', { threadId: 'n', turn: { id: 'turn-10', items: [], status: 'inProgress' } });
  server.notify('error', { threadId: 'n', turnId: 'turn-10', error: { message: 'Rate limited' }, willRetry: false });
  server.notify('turn/completed', { threadId: 'n', turn: { id: 'turn-10', items: [], status: 'failed', error: { message: 'Rate limited' } } });
  await until(() => adapter.state('codex:n').state === 'error', 2_000, 'error state');
  assert.deepEqual(ofType(events, 'error').map((e) => [e.agentId, e.message]), [['codex:n', 'Rate limited'], ['codex:n', 'Rate limited']]);
  assert.equal(adapter.sessions()[0].lastError, 'Rate limited');

  // A thread started by another client joins and is resumed at once;
  // archiving drops it.
  server.threads.set('new', thread('new', { updatedAt: 1_790_600_000 }));
  server.notify('thread/started', { thread: thread('new', { updatedAt: 1_790_600_000 }) });
  await until(() => adapter.sessions().length === 2, 2_000, 'joined');
  await until(() => requestsFor(server, 'thread/resume').some((r) => r.params.threadId === 'new'), 2_000, 'resumed');
  assert.deepEqual(adapter.sessions().map((s) => s.threadId), ['new', 'n']);
  server.loaded.delete('new');
  server.notify('thread/archived', { threadId: 'new' });
  await until(() => adapter.sessions().length === 1, 2_000, 'dropped');
  await sleep(60);
  assert.equal(adapter.sessions().length, 1);
  assert.equal(ofType(events, 'sessions').every((e) => e.agentId === 'codex'), true);
});

test('a status change to systemError without a message sets lastError turn_failed until a message arrives', async (t) => {
  const { server, adapter, events } = await setup(t, { threads: [thread('e'), thread('r', { updatedAt: 50, status: { type: 'systemError' } })] });
  await connected(server, adapter, events, 2);
  // A thread resumed while already in systemError says so at once.
  assert.deepEqual(adapter.sessions().map((s) => [s.threadId, s.state, s.lastError]), [['e', 'idle', null], ['r', 'error', 'turn_failed']]);

  server.notify('turn/started', { threadId: 'e', turn: { id: 'turn-1', items: [], status: 'inProgress' } });
  server.notify('thread/status/changed', { threadId: 'e', status: { type: 'systemError' } });
  await until(() => adapter.state('codex:e').state === 'error', 2_000, 'error state');
  assert.deepEqual(adapter.state('codex:e'), { state: 'error', pending: null, lastError: 'turn_failed', sessionId: 'e', costUsd: null });
  assert.equal(adapter.sessions().find((s) => s.threadId === 'e').lastError, 'turn_failed');

  // The server's own message, when it comes, replaces the placeholder.
  server.notify('turn/completed', { threadId: 'e', turn: { id: 'turn-1', items: [], status: 'failed', error: { message: 'Usage limit reached' } } });
  await until(() => adapter.state('codex:e').lastError === 'Usage limit reached', 2_000, 'message');
  server.notify('thread/status/changed', { threadId: 'e', status: { type: 'systemError' } });
  await sleep(20);
  assert.equal(adapter.state('codex:e').lastError, 'Usage limit reached', 'a repeated status change keeps the message');

  // The next turn clears it.
  server.notify('turn/started', { threadId: 'e', turn: { id: 'turn-2', items: [], status: 'inProgress' } });
  await until(() => adapter.state('codex:e').state === 'busy', 2_000, 'busy');
  assert.equal(adapter.state('codex:e').lastError, null);
});

test('a dropped socket keeps the rows unavailable until the reconnect lists and resumes them again', async (t) => {
  const { server, adapter, events, logs } = await setup(t, { threads: [thread('k')] });
  await connected(server, adapter, events, 1);
  await server.disconnectAll();
  await until(() => adapter.sessions()[0]?.state === 'unavailable', 2_000, 'unavailable');
  assert.deepEqual(adapter.sessions().map((s) => [s.threadId, s.state, s.lastError, s.pending]), [['k', 'unavailable', 'server_gone', null]]);
  assert.deepEqual(adapter.status(), { available: false, reason: 'disconnected' });
  assert.ok(ofType(events, 'error').some((e) => e.agentId === 'codex' && /closed/.test(e.message)));
  await assert.rejects(adapter.thread('codex:k'), { code: 'unavailable' });
  await until(() => server.connections.length === 2, 2_000, 'reconnect');
  await until(() => requestsFor(server, 'thread/resume').length === 2, 2_000, 'second resume');
  await until(() => adapter.sessions()[0]?.state === 'idle', 2_000, 'catalogue back');
  assert.deepEqual(adapter.status(), { available: true });
  assert.equal(adapter.sessions()[0].lastError, null);
  assert.equal(requestsFor(server, 'initialize').length, 2);
  assert.ok(logs.some((entry) => entry.event === 'codex_disconnected'));
  assert.ok(logs.filter((entry) => entry.event === 'codex_connected').length === 2);
});

test('a request pending across a dropped socket is replayed on re-resume and answered with its original id', async (t) => {
  const { server, adapter, events } = await setup(t, {
    threads: [thread('w', {
      status: { type: 'active', activeFlags: ['waitingOnUserInput'] },
      waiting: { id: 2, method: 'item/tool/requestUserInput', params: QUESTION },
    })],
  });
  await connected(server, adapter, events, 1);
  await until(() => ofType(events, 'request').length === 1, 2_000, 'request');
  await server.disconnectAll();
  await until(() => adapter.sessions()[0]?.state === 'unavailable', 2_000, 'unavailable');
  await assert.rejects(adapter.answer('codex:w', '2', { answers: { colour: 'Blue' } }), { code: 'no_such_request' });

  await until(() => ofType(events, 'request').length === 2, 2_000, 'replayed');
  assert.equal(ofType(events, 'request')[1].requestId, '2');
  assert.equal(adapter.state('codex:w').state, 'waiting');
  await adapter.answer('codex:w', '2', { answers: { colour: 'Blue' } });
  await until(() => server.replies.length === 1, 2_000, 'reply');
  assert.deepEqual(server.connections[0].replies, []);
  assert.deepEqual(server.connections[1].replies, [{ jsonrpc: '2.0', id: 2, result: { answers: { colour: { answers: ['Blue'] } } } }]);
});

test('an owner file that names a new pid and socket while connected moves the adapter to the new server', async (t) => {
  const { server, adapter, events } = await setup(t, { threads: [thread('old')] });
  await connected(server, adapter, events, 1);
  const next = await startCodexServer(t, { threads: [thread('fresh-server')] });
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  t.after(() => child.kill('SIGKILL'));
  await writeFile(server.ownerFile, JSON.stringify({ socket: next.socket, pid: child.pid, startedAt: AT, codexVersion: 'y' }));
  await until(() => next.connections.length === 1, 2_000, 'joined');
  await until(() => adapter.sessions().some((s) => s.threadId === 'fresh-server' && s.state === 'idle'), 2_000, 'listed');
  assert.deepEqual(adapter.sessions().map((s) => s.threadId), ['fresh-server']);
  assert.equal(server.live().length, 0);
  assert.deepEqual(adapter.status(), { available: true });
  assert.equal(requestsFor(next, 'thread/resume').length, 1);
});

test('a frame over codexFrameBytes is dropped with an error event and the connection stays up', async (t) => {
  const { server, adapter, events } = await setup(t, { threads: [thread('f')], limits: { codexFrameBytes: 512 } });
  await connected(server, adapter, events, 1);
  server.live()[0].raw(JSON.stringify({ jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { threadId: 'f', delta: 'y'.repeat(600) } }));
  const dropped = await until(() => ofType(events, 'error').find((e) => e.agentId === 'codex'), 2_000, 'drop');
  assert.match(dropped.message, /^Dropped a \d+-byte frame/);
  server.notify('thread/status/changed', { threadId: 'f', status: { type: 'active', activeFlags: [] } });
  await until(() => adapter.state('codex:f').state === 'busy', 2_000, 'still connected');
  assert.equal(server.connections.length, 1);
});

test('no owner file means no server; one that appears is picked up, and a dead pid is ignored', async (t) => {
  const { server, adapter, events, logs } = await setup(t, { threads: [thread('o')], owner: false });
  await sleep(80);
  assert.deepEqual(adapter.sessions(), []);
  assert.deepEqual(adapter.status(), { available: false, reason: 'no_server' });
  assert.equal(server.connections.length, 0);

  const dead = spawnSync(process.execPath, ['-e', '0']);
  await server.writeOwner({ pid: dead.pid });
  await sleep(80);
  assert.equal(server.connections.length, 0);
  assert.equal(logs.some((entry) => entry.event === 'codex_server_found'), false);

  await server.writeOwner();
  await connected(server, adapter, events, 1);
  assert.equal(adapter.sessions()[0].threadId, 'o');

  await server.removeOwner();
  await until(() => adapter.sessions().length === 0, 2_000, 'server gone');
  assert.deepEqual(adapter.status(), { available: false, reason: 'no_server' });
  assert.ok(logs.some((entry) => entry.event === 'codex_server_gone'));
  await until(() => server.live().length === 0, 2_000, 'socket closed');
});

test('a socket that is gone while the owner file lingers is the server gone after two failed connections', async (t) => {
  const { server, adapter, events, logs } = await setup(t, { threads: [thread('g')] });
  await connected(server, adapter, events, 1);
  const gone = () => logs.filter((entry) => entry.event === 'codex_server_gone');
  const socketErrors = () => logs.filter((entry) => entry.event === 'codex_socket_error');

  // Ctrl-C in codex-serve: the socket closes at once, the owner file
  // outlives it (here: the pid stays alive because it is this process).
  await server.close();
  await until(() => adapter.status().reason === 'no_server', 2_000, 'no_server');
  assert.deepEqual(adapter.sessions(), []);
  assert.deepEqual(gone(), [{ event: 'codex_server_gone', socket: server.socket, pid: process.pid, reason: 'socket' }]);
  assert.deepEqual(socketErrors().map((entry) => entry.error), ['ENOENT', 'ENOENT']);
  assert.equal(logs.filter((entry) => entry.event === 'codex_disconnected').length, 1);

  // The lingering file is polled but not reconnected to, and not logged again.
  await sleep(120);
  assert.equal(socketErrors().length, 2, 'no further connection attempts');
  assert.equal(gone().length, 1);
  assert.deepEqual(adapter.status(), { available: false, reason: 'no_server' });

  // The file going away is not a second "gone"; a new server is found.
  await server.removeOwner();
  await sleep(60);
  assert.equal(gone().length, 1);
  const next = await startCodexServer(t, { threads: [thread('h')] });
  await writeFile(server.ownerFile, JSON.stringify({ socket: next.socket, pid: process.pid, startedAt: AT, codexVersion: 'codex-cli 0.0.0-fake' }));
  await until(() => adapter.sessions().some((s) => s.threadId === 'h'), 2_000, 'new server followed');
  assert.deepEqual(adapter.status(), { available: true });
  assert.equal(logs.filter((entry) => entry.event === 'codex_server_found').length, 2);
});

test('ECONNREFUSED counts like ENOENT; a single failure or another error code does not', async (t) => {
  // A scripted ws: every attempt fails before open with the next code in `codes`.
  const fakeWs = (code) => {
    const ws = new EventEmitter();
    ws.terminate = () => {};
    ws.close = () => {};
    ws.send = () => {};
    setImmediate(() => {
      ws.emit('error', Object.assign(new Error(code), { code }));
      ws.emit('close');
    });
    return ws;
  };
  const attempts = [];
  const codes = ['ECONNREFUSED', 'EACCES', 'ECONNREFUSED', 'ENOENT'];
  const { adapter, logs } = await setup(t, {
    threads: [thread('c')],
    connect: async () => {
      const code = codes[Math.min(attempts.length, codes.length - 1)];
      attempts.push(code);
      return fakeWs(code);
    },
  });
  await until(() => logs.some((entry) => entry.event === 'codex_server_gone'), 2_000, 'gone');
  // The EACCES in between reset the count, so it took the third and fourth attempts.
  assert.deepEqual(attempts, ['ECONNREFUSED', 'EACCES', 'ECONNREFUSED', 'ENOENT']);
  assert.deepEqual(adapter.status(), { available: false, reason: 'no_server' });
  await sleep(100);
  assert.equal(attempts.length, 4, 'no reconnect after the server is gone');
  assert.equal(logs.filter((entry) => entry.event === 'codex_server_gone').length, 1);
});

test('a connect() that rejects with ENOENT counts the same way', async (t) => {
  const { adapter, logs } = await setup(t, {
    threads: [thread('c')],
    connect: () => Promise.reject(Object.assign(new Error('missing'), { code: 'ENOENT' })),
  });
  await until(() => logs.some((entry) => entry.event === 'codex_server_gone'), 2_000, 'gone');
  assert.equal(logs.filter((entry) => entry.event === 'codex_connect_error').length, 2);
  await sleep(100);
  assert.equal(logs.filter((entry) => entry.event === 'codex_connect_error').length, 2, 'no reconnect after the server is gone');
  assert.equal(logs.filter((entry) => entry.event === 'codex_server_gone').length, 1);
  assert.deepEqual(adapter.status(), { available: false, reason: 'no_server' });
});

test('refresh() polls the owner file and the catalogue now instead of waiting for the interval', async (t) => {
  const { server, adapter, events } = await setup(t, { threads: [thread('r1')], timeouts: { codexPollMs: 60_000 } });
  await connected(server, adapter, events, 1);
  const lists = () => requestsFor(server, 'thread/loaded/list').length;
  const before = lists();
  server.threads.set('r2', thread('r2', { updatedAt: 1_790_596_500 }));
  server.loaded.add('r2');
  await adapter.refresh();
  assert.ok(lists() > before, 'refresh listed the loaded threads');
  await connected(server, adapter, events, 2);
  assert.deepEqual(adapter.sessions().map((s) => s.threadId), ['r2', 'r1']);
  await server.removeOwner();
  await adapter.refresh();
  assert.deepEqual(adapter.status(), { available: false, reason: 'no_server' });
  assert.deepEqual(adapter.sessions(), []);
});

test('without the ws package the adapter reports ws_unavailable once and does not retry', async (t) => {
  const { server, adapter, logs } = await setup(t, {
    threads: [thread('o')],
    connect: () => Promise.reject(Object.assign(new Error('Cannot find package ws'), { code: 'ws_unavailable' })),
  });
  await until(() => adapter.status().reason === 'ws_unavailable', 2_000, 'status');
  await sleep(100);
  assert.deepEqual(adapter.status(), { available: false, reason: 'ws_unavailable' });
  assert.deepEqual(logs.filter((entry) => entry.event === 'codex_ws_unavailable'), [{ event: 'codex_ws_unavailable' }]);
  assert.equal(server.connections.length, 0);
  assert.deepEqual(adapter.sessions(), []);
});

test('send, start, and newThread are refused before any await; the message is plain', async (t) => {
  const { adapter } = await setup(t, { owner: false });
  const agent = { id: 'codex:x', cwd: WORK };
  for (const call of [() => adapter.send(agent, 'hi'), () => adapter.start(agent), () => adapter.newThread(agent)]) {
    const promise = call();
    let settled = 'pending';
    await Promise.race([promise.then(() => { settled = 'resolved'; }, () => { settled = 'rejected'; }), Promise.resolve()]);
    await Promise.resolve();
    assert.equal(settled, 'rejected');
    await assert.rejects(promise, (error) => error.code === 'not_supported' && /terminal/.test(error.message));
  }
});

test('thread() reads recent turns through thread/turns/list, bounded; interrupt() names the running turn', async (t) => {
  const turns = [
    { id: 'turn-1', status: 'completed', startedAt: 100, completedAt: 110, items: [
      { type: 'userMessage', id: 'u1', content: [{ type: 'text', text: 'First' }] },
      { type: 'commandExecution', id: 'c1', command: 'ls', status: 'completed' },
      { type: 'agentMessage', id: 'a1', text: 'Done with first', phase: 'final_answer' },
    ] },
    { id: 'turn-2', status: 'inProgress', startedAt: 200, completedAt: null, items: [
      { type: 'userMessage', id: 'u2', content: [{ type: 'text', text: 'z'.repeat(80) }] },
    ] },
  ];
  const { server, adapter, events } = await setup(t, { threads: [thread('h', { status: { type: 'active', activeFlags: [] }, turns })] });
  await connected(server, adapter, events, 1);
  await assert.rejects(adapter.thread('codex:missing'), { code: 'invalid_agent' });
  const { messages } = await adapter.thread('codex:h');
  assert.deepEqual(messages, [
    { role: 'user', text: 'First', at: new Date(100_000).toISOString() },
    { role: 'assistant', text: 'Done with first', at: new Date(110_000).toISOString() },
    { role: 'user', text: 'z'.repeat(64), at: new Date(200_000).toISOString(), truncated: true },
  ]);
  const read = requestsFor(server, 'thread/turns/list').at(-1);
  assert.deepEqual(read.params, { threadId: 'h', limit: 20, sortDirection: 'desc', itemsView: 'full' });

  await adapter.interrupt('codex:h');
  assert.deepEqual(requestsFor(server, 'turn/interrupt').map((r) => r.params), [{ threadId: 'h', turnId: 'turn-2' }]);
  server.notify('turn/completed', { threadId: 'h', turn: { id: 'turn-2', items: [], status: 'interrupted' } });
  await until(() => adapter.state('codex:h').state === 'idle', 2_000, 'idle');
  await adapter.interrupt('codex:h');
  await adapter.interrupt('codex:nobody');
  assert.equal(requestsFor(server, 'turn/interrupt').length, 1);
});

test('close() with a request pending sends no reply and leaves the request to the server', async (t) => {
  const { server, adapter, events } = await setup(t, { threads: [thread('c')] });
  await connected(server, adapter, events, 1);
  server.ask('item/tool/requestUserInput', 0, { threadId: 'c', ...QUESTION });
  await until(() => ofType(events, 'request')[0], 2_000, 'request');
  const started = Date.now();
  await adapter.close();
  assert.ok(Date.now() - started < 1_000);
  await until(() => server.live().length === 0, 2_000, 'socket closed');
  assert.equal(server.replies.length, 0);
  assert.deepEqual(adapter.sessions(), []);
  await assert.rejects(adapter.answer('codex:c', '0', { answers: { colour: 'Blue' } }), { code: 'no_such_request' });
  await assert.rejects(adapter.thread('codex:c'), { code: 'invalid_agent' });
});
