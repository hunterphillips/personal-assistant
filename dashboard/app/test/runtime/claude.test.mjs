import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';

import { createClaudeAdapter } from '../../lib/runtime/claude.mjs';
import { createThreadStore } from '../../lib/threads.mjs';
import { tempDir } from '../support/harness.mjs';

const AT = '2026-09-25T12:00:00.000Z';
const AGENT = Object.freeze({ id: 'cfo', cwd: '/invented/cfo', kind: 'persona', provider: 'claude' });
const LIMITS = { turnMaxTurns: 7, messageTextBytes: 64, threadCacheMessages: 50, threadCacheBytes: 64 * 1024 };
const QUESTION = 'Which color do you want?';
const QUESTION_INPUT = Object.freeze({
  questions: [{
    question: QUESTION,
    header: 'Color',
    options: [{ label: 'Blue', description: 'Choose Blue' }, { label: 'Amber', description: 'Choose Amber' }],
    multiSelect: false,
  }],
});
const BASH_INPUT = Object.freeze({ command: 'printf probe > marker.txt', description: 'Write probe text' });

const init = (sessionId = 'session-1', extra = {}) => ({
  type: 'system', subtype: 'init', session_id: sessionId, apiKeySource: 'none', ...extra,
});
const assistant = (text, parent = null) => ({
  type: 'assistant', parent_tool_use_id: parent, session_id: 'session-1', message: { content: [{ type: 'text', text }] },
});
const result = (extra = {}) => ({
  type: 'result', subtype: 'success', is_error: false, session_id: 'session-1', num_turns: 1,
  total_cost_usd: 0.25, usage: { input_tokens: 10, output_tokens: 3 }, permission_denials: [], ...extra,
});

// A query() stand-in: records each call and runs the given async generator.
function fakeQuery(generator) {
  const calls = [];
  const query = (args) => {
    calls.push(args);
    return generator(args);
  };
  query.calls = calls;
  return query;
}

const simple = () => fakeQuery(async function* () {
  yield init();
  yield assistant('Hello from the persona.');
  yield result();
});

// Rejects once the turn's controller aborts, as the SDK does.
function untilAborted(options) {
  return new Promise((_, reject) => {
    const { signal } = options.abortController;
    if (signal.aborted) reject(new Error('aborted'));
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
}

function gate() {
  let open;
  const promise = new Promise((resolve) => { open = resolve; });
  return { promise, open };
}

async function setup(t, { query = simple(), timeouts = {}, limits = {}, turnTools = null } = {}) {
  const dir = path.join(await tempDir(t), 'threads');
  const store = createThreadStore({ dir, limits: { ...LIMITS, ...limits } });
  const logs = [];
  const adapter = createClaudeAdapter({
    query,
    store,
    config: { limits: { ...LIMITS, ...limits }, timeouts: { drainMs: 2_000, requestMaxAgeMs: 60_000, ...timeouts } },
    log: (entry) => logs.push(entry),
    now: () => new Date(AT),
    turnTools,
  });
  const events = [];
  adapter.subscribe((event) => events.push(event));
  t.after(() => adapter.close());
  return { adapter, store, events, logs, query };
}

async function waitFor(events, predicate, ms = 2_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const found = events.find(predicate);
    if (found) return found;
    if (Date.now() > deadline) throw new Error('event did not arrive');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

const states = (events) => events.filter((event) => event.type === 'thread.state').map((event) => event.state);

test('a turn emits state, messages, and usage, writes the pointer, and caches the exchange', async (t) => {
  const { adapter, store, events, query } = await setup(t);
  assert.deepEqual(await adapter.start(AGENT), { threadId: 'cfo' });
  await adapter.send(AGENT, 'How is cash?');

  assert.deepEqual(states(events), ['busy', 'idle']);
  assert.deepEqual(events.filter((event) => event.type === 'message').map(({ role, text }) => ({ role, text })), [
    { role: 'user', text: 'How is cash?' },
    { role: 'assistant', text: 'Hello from the persona.' },
  ]);
  const usage = events.find((event) => event.type === 'usage');
  assert.deepEqual(usage, {
    type: 'usage', agentId: 'cfo', at: AT, usage: { input_tokens: 10, output_tokens: 3 }, costUsd: 0.25, denials: [],
  });
  assert.deepEqual(await store.readPointer('cfo'), { sessionId: 'session-1', createdAt: AT });
  assert.deepEqual((await store.read('cfo')).map(({ role, text }) => ({ role, text })), [
    { role: 'user', text: 'How is cash?' },
    { role: 'assistant', text: 'Hello from the persona.' },
  ]);
  assert.deepEqual(adapter.state('cfo'), {
    state: 'idle', pending: null, lastError: null, sessionId: 'session-1', costUsd: 0.25, cwd: '/invented/cfo', model: null,
  });

  const { prompt, options } = query.calls[0];
  assert.equal(prompt, 'How is cash?');
  assert.equal(options.cwd, '/invented/cfo');
  assert.equal(options.permissionMode, 'default');
  assert.equal(options.maxTurns, 7);
  assert.equal(typeof options.canUseTool, 'function');
  assert.ok(options.abortController instanceof AbortController);
  assert.equal('resume' in options, false);
});

test('the cache already holds a message when its event fires', async (t) => {
  const { adapter, store } = await setup(t);
  const reads = [];
  adapter.subscribe((event) => {
    if (event.type === 'message') reads.push(store.read('cfo').then((messages) => ({ event, messages })));
  });
  await adapter.send(AGENT, 'How is cash?');
  assert.equal(reads.length, 2);
  for (const { event, messages } of await Promise.all(reads)) {
    assert.deepEqual(messages.at(-1), { role: event.role, text: event.text, at: event.at });
  }
});

test('subagent messages are skipped and long assistant text is bounded and flagged', async (t) => {
  const query = fakeQuery(async function* () {
    yield init();
    yield assistant('inner work', 'toolu_1');
    yield assistant('x'.repeat(100));
    yield result();
  });
  const { adapter, events } = await setup(t, { query });
  await adapter.send(AGENT, 'Go');
  const replies = events.filter((event) => event.type === 'message' && event.role === 'assistant');
  assert.equal(replies.length, 1);
  assert.equal(replies[0].text, 'x'.repeat(64));
  assert.equal(replies[0].truncated, true);
});

test('a stored pointer is resumed, and a new session id from init replaces it', async (t) => {
  const query = fakeQuery(async function* () {
    yield init('session-2');
    yield result({ session_id: 'session-2' });
  });
  const { adapter, store } = await setup(t, { query });
  await store.writePointer('cfo', { sessionId: 'session-0', createdAt: '2026-09-01T00:00:00.000Z' });
  await adapter.start(AGENT);
  assert.equal(adapter.state('cfo').sessionId, 'session-0');
  await adapter.send(AGENT, 'Continue');
  assert.equal(query.calls[0].options.resume, 'session-0');
  assert.deepEqual(await store.readPointer('cfo'), { sessionId: 'session-2', createdAt: AT });
  await adapter.send(AGENT, 'Again');
  assert.equal(query.calls[1].options.resume, 'session-2');
});

test('send loads the pointer itself when start was not called', async (t) => {
  const { adapter, store, query } = await setup(t);
  await store.writePointer('cfo', { sessionId: 'session-9', createdAt: AT });
  await adapter.send(AGENT, 'Hi');
  assert.equal(query.calls[0].options.resume, 'session-9');
});

test('a second send while a turn is in flight is refused synchronously', async (t) => {
  const release = gate();
  const query = fakeQuery(async function* () {
    yield init();
    await release.promise;
    yield result();
  });
  const { adapter } = await setup(t, { query });
  const first = adapter.send(AGENT, 'one');
  assert.equal(adapter.state('cfo').state, 'busy');
  const second = adapter.send(AGENT, 'two');
  await assert.rejects(second, { code: 'busy' });
  release.open();
  await first;
  assert.equal(query.calls.length, 1);
  assert.equal(adapter.state('cfo').state, 'idle');
});

test('a question round trip answers with the answers map and goes waiting, busy, idle', async (t) => {
  let decision;
  const query = fakeQuery(async function* ({ options }) {
    yield init();
    decision = await options.canUseTool('AskUserQuestion', QUESTION_INPUT, { signal: new AbortController().signal });
    yield assistant('Amber');
    yield result();
  });
  const { adapter, events } = await setup(t, { query });
  const turn = adapter.send(AGENT, 'Ask me');
  const request = await waitFor(events, (event) => event.type === 'request');
  assert.equal(request.kind, 'question');
  assert.equal(request.toolName, 'AskUserQuestion');
  assert.deepEqual(request.input, QUESTION_INPUT);
  assert.equal(adapter.state('cfo').state, 'waiting');
  assert.equal(adapter.state('cfo').pending.requestId, request.requestId);

  await adapter.answer(AGENT, request.requestId, { answers: { [QUESTION]: 'Amber' } });
  await turn;
  assert.deepEqual(decision, { behavior: 'allow', updatedInput: { ...QUESTION_INPUT, answers: { [QUESTION]: 'Amber' } } });
  assert.deepEqual(states(events), ['busy', 'waiting', 'busy', 'idle']);
  assert.equal(events.find((event) => event.type === 'resolved').outcome, 'answered');
  await assert.rejects(adapter.answer(AGENT, request.requestId, { answers: { [QUESTION]: 'Blue' } }), { code: 'no_such_request' });
});

test('multi-select answers join labels with a comma, and malformed answers are refused', async (t) => {
  let decision;
  const query = fakeQuery(async function* ({ options }) {
    yield init();
    decision = await options.canUseTool('AskUserQuestion', QUESTION_INPUT, {});
    yield result();
  });
  const { adapter, events } = await setup(t, { query });
  const turn = adapter.send(AGENT, 'Ask me');
  const { requestId } = await waitFor(events, (event) => event.type === 'request');
  for (const bad of [null, {}, { answers: { 'Another question?': 'Blue' } }, { answers: { [QUESTION]: '' } },
    { answers: { [QUESTION]: [] } }, { decision: 'allow' }]) {
    await assert.rejects(adapter.answer(AGENT, requestId, bad), { code: 'invalid_answer' });
  }
  await adapter.answer(AGENT, requestId, { answers: { [QUESTION]: ['Blue', 'Amber'] } });
  await turn;
  assert.equal(decision.updatedInput.answers[QUESTION], 'Blue, Amber');
});

test('an approval allow passes the input through and a deny sends the dashboard message', async (t) => {
  const decisions = [];
  const query = fakeQuery(async function* ({ options }) {
    yield init();
    decisions.push(await options.canUseTool('Bash', BASH_INPUT, {}));
    decisions.push(await options.canUseTool('Bash', BASH_INPUT, {}));
    yield result();
  });
  const { adapter, events } = await setup(t, { query });
  const turn = adapter.send(AGENT, 'Run it');
  const first = await waitFor(events, (event) => event.type === 'request');
  assert.equal(first.kind, 'approval');
  assert.deepEqual(first.input, BASH_INPUT);
  await assert.rejects(adapter.answer(AGENT, first.requestId, { answers: {} }), { code: 'invalid_answer' });
  await adapter.answer(AGENT, first.requestId, { decision: 'allow' });
  const second = await waitFor(events, (event) => event.type === 'request' && event.requestId !== first.requestId);
  await adapter.answer(AGENT, second.requestId, { decision: 'deny' });
  await turn;
  assert.deepEqual(decisions, [
    { behavior: 'allow', updatedInput: BASH_INPUT },
    { behavior: 'deny', message: 'Denied from the dashboard' },
  ]);
  assert.deepEqual(events.filter((event) => event.type === 'resolved').map((event) => event.outcome), ['allowed', 'denied']);
});

test('a request carries the turn\'s sender and chain, null and empty for the user\'s own turn', async (t) => {
  const query = fakeQuery(async function* ({ options }) {
    yield init();
    await options.canUseTool('Bash', BASH_INPUT, {});
    yield result();
  });
  const { adapter, events } = await setup(t, { query });
  const hop = adapter.send(AGENT, 'From Assistant: run it', { from: 'assistant', chain: ['assistant'], prompt: 'From Assistant, an agent in this system (not the user): run it' });
  const request = await waitFor(events, (event) => event.type === 'request');
  assert.deepEqual([request.from, request.chain], ['assistant', ['assistant']]);
  assert.deepEqual([adapter.state('cfo').pending.from, adapter.state('cfo').pending.chain], ['assistant', ['assistant']]);
  await adapter.answer(AGENT, request.requestId, { decision: 'allow' });
  await hop;
  const resolved = events.find((event) => event.type === 'resolved');
  assert.deepEqual([resolved.requestId, resolved.outcome, resolved.from, resolved.chain], [request.requestId, 'allowed', 'assistant', ['assistant']]);

  events.length = 0;
  const own = adapter.send(AGENT, 'Run it');
  const ownRequest = await waitFor(events, (event) => event.type === 'request');
  assert.deepEqual([ownRequest.from, ownRequest.chain], [null, []]);
  await adapter.answer(AGENT, ownRequest.requestId, { decision: 'deny' });
  await own;
  const ownResolved = events.find((event) => event.type === 'resolved');
  assert.deepEqual([ownResolved.from, ownResolved.chain], [null, []]);
});

test('an unanswered request expires as a denial and the thread stays busy until the result', async (t) => {
  let decision;
  const release = gate();
  const query = fakeQuery(async function* ({ options }) {
    yield init();
    decision = await options.canUseTool('Bash', BASH_INPUT, {});
    await release.promise;
    yield result();
  });
  const { adapter, events } = await setup(t, { query, timeouts: { requestMaxAgeMs: 20 } });
  const turn = adapter.send(AGENT, 'Run it');
  const resolved = await waitFor(events, (event) => event.type === 'resolved');
  assert.equal(resolved.outcome, 'expired');
  assert.deepEqual(decision, { behavior: 'deny', message: 'No answer within 1 second' });
  assert.equal(adapter.state('cfo').state, 'busy');
  assert.equal(adapter.state('cfo').pending, null);
  release.open();
  await turn;
  assert.deepEqual(states(events), ['busy', 'waiting', 'busy', 'idle']);
});

test('interrupt aborts the turn, resolves the pending request as interrupted, and ends idle', async (t) => {
  let decision;
  const query = fakeQuery(async function* ({ options }) {
    yield init();
    decision = await options.canUseTool('Bash', BASH_INPUT, { signal: options.abortController.signal });
    await untilAborted(options);
  });
  const { adapter, events } = await setup(t, { query });
  const turn = adapter.send(AGENT, 'Run it');
  await waitFor(events, (event) => event.type === 'request');
  await adapter.interrupt(AGENT);
  await turn;
  assert.deepEqual(decision, { behavior: 'deny', message: 'Interrupted from the dashboard' });
  assert.equal(events.find((event) => event.type === 'resolved').outcome, 'interrupted');
  assert.equal(events.some((event) => event.type === 'error'), false);
  assert.deepEqual(adapter.state('cfo'), {
    state: 'idle', pending: null, lastError: null, sessionId: 'session-1', costUsd: null, cwd: '/invented/cfo', model: null,
  });
  await adapter.interrupt(AGENT);
});

test('a stream error ends the turn in error, and the next send recovers', async (t) => {
  let calls = 0;
  const query = fakeQuery(async function* () {
    calls += 1;
    yield init();
    if (calls === 1) throw new Error('stream broke');
    yield result();
  });
  const { adapter, events } = await setup(t, { query });
  await adapter.send(AGENT, 'one');
  assert.equal(events.find((event) => event.type === 'error').message, 'stream broke');
  assert.equal(adapter.state('cfo').state, 'error');
  assert.equal(adapter.state('cfo').lastError, 'stream broke');
  await adapter.send(AGENT, 'two');
  assert.deepEqual(states(events), ['busy', 'error', 'busy', 'idle']);
  assert.equal(adapter.state('cfo').lastError, null);
});

test('a stream that fails before init while resuming, with stderr naming a missing session, says so', async (t) => {
  const query = fakeQuery(async function* ({ options }) {
    options.stderr('No conversation found with session ID: session-0\n');
    throw new Error('Claude Code process exited with code 1');
  });
  const { adapter, store, events, logs } = await setup(t, { query });
  await store.writePointer('cfo', { sessionId: 'session-0', createdAt: AT });
  await adapter.send(AGENT, 'Continue');
  const message = 'The stored session could not be resumed. Start a new thread.';
  assert.equal(events.find((event) => event.type === 'error').message, message);
  assert.equal(adapter.state('cfo').state, 'error');
  assert.equal(adapter.state('cfo').lastError, message);
  assert.ok(logs.some((entry) => entry.event === 'thread_resume_failed' && entry.agentId === 'cfo'));
  const logged = logs.find((entry) => entry.event === 'persona_turn_error');
  assert.equal(logged.cause, 'Claude Code process exited with code 1');
  assert.equal(logged.stderr, 'No conversation found with session ID: session-0\n');
  assert.equal((await store.readPointer('cfo')).sessionId, 'session-0');
});

test('a stream that fails before init for another reason keeps the pointer and asks for a retry', async (t) => {
  const query = fakeQuery(async function* ({ options }) {
    options.stderr('x'.repeat(2_100));
    options.stderr('env: node: No such file or directory\n');
    throw new Error('Claude Code process exited with code 127');
  });
  const { adapter, store, events, logs } = await setup(t, { query });
  await store.writePointer('cfo', { sessionId: 'session-0', createdAt: AT });
  await adapter.send(AGENT, 'Continue');
  const message = 'The turn could not start. Retry; if it keeps failing, start a new thread.';
  assert.equal(events.find((event) => event.type === 'error').message, message);
  assert.equal(adapter.state('cfo').lastError, message);
  assert.equal(logs.some((entry) => entry.event === 'thread_resume_failed'), false);
  const logged = logs.find((entry) => entry.event === 'persona_turn_error');
  assert.equal(logged.cause, 'Claude Code process exited with code 127');
  assert.equal(logged.stderr.length, 2_048);
  assert.ok(logged.stderr.endsWith('env: node: No such file or directory\n'));
  assert.equal((await store.readPointer('cfo')).sessionId, 'session-0');
});

test('start imports the SDK once and rejects sdk_unavailable when it cannot', async (t) => {
  const dir = path.join(await tempDir(t), 'threads');
  const store = createThreadStore({ dir, limits: LIMITS });
  const config = { limits: LIMITS, timeouts: { drainMs: 2_000, requestMaxAgeMs: 60_000 } };
  let imports = 0;
  const broken = createClaudeAdapter({
    importSdk: async () => { imports += 1; throw new Error("Cannot find package '@anthropic-ai/claude-agent-sdk'"); },
    store, config,
  });
  await assert.rejects(broken.start(AGENT), (error) => {
    assert.equal(error.name, 'RuntimeError');
    assert.equal(error.code, 'sdk_unavailable');
    assert.equal(error.cause.message, "Cannot find package '@anthropic-ai/claude-agent-sdk'");
    return true;
  });
  await assert.rejects(broken.start(AGENT), { code: 'sdk_unavailable' });
  assert.equal(imports, 2);

  const query = simple();
  const loaded = createClaudeAdapter({ importSdk: async () => { imports += 1; return { query }; }, store, config });
  t.after(() => loaded.close());
  await loaded.start(AGENT);
  await loaded.start({ ...AGENT, id: 'brain' });
  await loaded.send(AGENT, 'Hi');
  assert.equal(imports, 3);
  assert.equal(query.calls.length, 1);
  assert.equal(typeof query.calls[0].options.stderr, 'function');
});

test('a turn whose init reports an API key source is refused and aborted', async (t) => {
  let signal;
  const query = fakeQuery(async function* ({ options }) {
    signal = options.abortController.signal;
    yield init('session-1', { apiKeySource: 'ANTHROPIC_API_KEY' });
    yield assistant('This should never be shown.');
    yield result();
  });
  const { adapter, store, events, logs } = await setup(t, { query });
  await adapter.send(AGENT, 'Hi');
  const message = 'Refused: this turn would bill an API key (ANTHROPIC_API_KEY).';
  assert.equal(signal.aborted, true);
  assert.equal(events.some((event) => event.type === 'message' && event.role === 'assistant'), false);
  assert.deepEqual((await store.read('cfo')).map(({ role }) => role), ['user']);
  assert.equal(events.find((event) => event.type === 'error').message, message);
  assert.deepEqual(states(events), ['busy', 'error']);
  assert.equal(adapter.state('cfo').lastError, message);
  assert.ok(logs.some((entry) => entry.event === 'persona_api_key_refused' && entry.agentId === 'cfo' &&
    entry.source === 'ANTHROPIC_API_KEY'));
});

test('an init whose apiKeySource is oauth is accepted', async (t) => {
  const query = fakeQuery(async function* () {
    yield init('session-1', { apiKeySource: 'oauth' });
    yield assistant('Still on the subscription.');
    yield result();
  });
  const { adapter, events, logs } = await setup(t, { query });
  await adapter.send(AGENT, 'Hi');
  assert.equal(events.some((event) => event.type === 'error'), false);
  assert.equal(logs.some((entry) => entry.event === 'persona_api_key_refused'), false);
  assert.deepEqual(states(events), ['busy', 'idle']);
});

test('an interrupted turn that reports an error result while winding down still ends idle', async (t) => {
  const running = gate();
  const query = fakeQuery(async function* ({ options }) {
    yield init();
    const aborted = new Promise((resolve) => {
      options.abortController.signal.addEventListener('abort', resolve, { once: true });
    });
    running.open();
    await aborted;
    yield result({ subtype: 'error_during_execution', is_error: true, errors: ['Request was aborted.'] });
  });
  const { adapter, events } = await setup(t, { query });
  const turn = adapter.send(AGENT, 'Hi');
  await running.promise;
  await adapter.interrupt(AGENT);
  await turn;
  assert.equal(adapter.state('cfo').state, 'idle');
  assert.equal(adapter.state('cfo').lastError, null);
  assert.equal(events.some((event) => event.type === 'error'), false);
  assert.ok(events.some((event) => event.type === 'usage'));
});

test('a stream error with a pending request resolves it and goes to error without passing through busy', async (t) => {
  const query = fakeQuery(async function* ({ options }) {
    yield init();
    options.canUseTool('Bash', BASH_INPUT, {});
    throw new Error('stream broke');
  });
  const { adapter, events } = await setup(t, { query });
  await adapter.send(AGENT, 'Run it');
  assert.deepEqual(states(events), ['busy', 'waiting', 'error']);
  const tail = events.filter((event) => event.type === 'resolved' || event.type === 'error' || event.type === 'thread.state').slice(-3);
  assert.deepEqual(tail.map(({ type, outcome, state }) => outcome ?? state ?? type), ['interrupted', 'error', 'error']);
});

test('an error result still reports usage and ends in error', async (t) => {
  const query = fakeQuery(async function* () {
    yield init();
    yield result({ subtype: 'error_max_turns', is_error: true, errors: [] });
  });
  const { adapter, events } = await setup(t, { query });
  await adapter.send(AGENT, 'Loop');
  assert.ok(events.some((event) => event.type === 'usage'));
  assert.equal(events.find((event) => event.type === 'error').message, 'Turn ended: error_max_turns');
  assert.equal(adapter.state('cfo').state, 'error');
});

test('an error result before init keeps the stored pointer', async (t) => {
  const query = fakeQuery(async function* () {
    yield result({ subtype: 'error_during_execution', is_error: true, session_id: 'session-startup', errors: ['startup failed'] });
  });
  const { adapter, store } = await setup(t, { query });
  await store.writePointer('cfo', { sessionId: 'session-good', createdAt: '2026-09-01T00:00:00.000Z' });
  await adapter.start(AGENT);
  await adapter.send(AGENT, 'Hi');
  assert.equal(adapter.state('cfo').state, 'error');
  assert.equal(adapter.state('cfo').sessionId, 'session-good');
  assert.deepEqual(await store.readPointer('cfo'), { sessionId: 'session-good', createdAt: '2026-09-01T00:00:00.000Z' });
});

test('New thread is refused while busy, otherwise clears the pointer and cache and marks the boundary', async (t) => {
  const release = gate();
  let calls = 0;
  const query = fakeQuery(async function* () {
    calls += 1;
    yield init();
    if (calls === 1) await release.promise;
    yield result();
  });
  const { adapter, store, events } = await setup(t, { query });
  const turn = adapter.send(AGENT, 'Hi');
  await assert.rejects(adapter.newThread(AGENT), { code: 'busy' });
  release.open();
  await turn;
  assert.ok(await store.readPointer('cfo'));

  events.length = 0;
  const reset = adapter.newThread(AGENT);
  await assert.rejects(adapter.send(AGENT, 'during reset'), { code: 'busy' });
  await reset;
  assert.equal(await store.readPointer('cfo'), null);
  assert.deepEqual((await store.read('cfo')).map(({ role, text }) => ({ role, text })), [{ role: 'system', text: 'New thread' }]);
  assert.deepEqual(events.map(({ type, state, role, text }) => ({ type, state, role, text })), [
    { type: 'thread.state', state: 'idle', role: undefined, text: undefined },
    { type: 'message', state: undefined, role: 'system', text: 'New thread' },
  ]);
  assert.equal(adapter.state('cfo').sessionId, null);
  await adapter.send(AGENT, 'Fresh');
  assert.equal('resume' in query.calls.at(-1).options, false);
});

test('close waits for a busy turn to finish and then refuses new sends', async (t) => {
  const query = fakeQuery(async function* () {
    yield init();
    await new Promise((resolve) => setTimeout(resolve, 30));
    yield result();
  });
  const { adapter, events } = await setup(t, { query });
  const turn = adapter.send(AGENT, 'Hi');
  await adapter.close();
  await turn;
  assert.ok(events.some((event) => event.type === 'usage'));
  assert.equal(adapter.state('cfo').state, 'idle');
  await assert.rejects(adapter.send(AGENT, 'Late'), { code: 'shutting_down' });
});

test('close aborts a turn still running when the drain time runs out', async (t) => {
  const query = fakeQuery(async function* ({ options }) {
    yield init();
    await untilAborted(options);
  });
  const { adapter, events, logs } = await setup(t, { query, timeouts: { drainMs: 25 } });
  const turn = adapter.send(AGENT, 'Hi');
  const started = Date.now();
  await adapter.close();
  assert.ok(Date.now() - started >= 20);
  await turn;
  assert.equal(adapter.state('cfo').state, 'idle');
  assert.equal(events.some((event) => event.type === 'error'), false);
  assert.ok(logs.some((entry) => entry.event === 'persona_turn_aborted' && entry.agentId === 'cfo'));
});

test('close aborts a thread waiting on an answer at once instead of draining it', async (t) => {
  const query = fakeQuery(async function* ({ options }) {
    yield init();
    await options.canUseTool('Bash', BASH_INPUT, { signal: options.abortController.signal });
    await untilAborted(options);
  });
  const { adapter, events, logs } = await setup(t, { query, timeouts: { drainMs: 5_000 } });
  const turn = adapter.send(AGENT, 'Run it');
  await waitFor(events, (event) => event.type === 'request');
  const started = Date.now();
  await adapter.close();
  assert.ok(Date.now() - started < 1_000);
  await turn;
  assert.equal(events.find((event) => event.type === 'resolved').outcome, 'interrupted');
  assert.equal(adapter.state('cfo').state, 'idle');
  assert.equal(events.some((event) => event.type === 'error'), false);
  assert.ok(logs.some((entry) => entry.event === 'persona_turn_aborted' && entry.agentId === 'cfo'));
});

test('close waits only abortGraceMs from config for an aborted turn that never ends', async (t) => {
  const query = fakeQuery(async function* () {
    yield init();
    await new Promise(() => {}); // ignores the abort
  });
  const { adapter } = await setup(t, { query, timeouts: { drainMs: 20, abortGraceMs: 40 } });
  adapter.send(AGENT, 'Hi');
  const started = Date.now();
  await adapter.close();
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 55 && elapsed < 1_000, String(elapsed));
});

test('New thread is refused once close has begun, so a drain never loses the pointer', async (t) => {
  const release = gate();
  const query = fakeQuery(async function* () {
    yield init();
    await release.promise;
    yield result();
  });
  const { adapter, store } = await setup(t, { query });
  const turn = adapter.send(AGENT, 'Hi');
  await new Promise((resolve) => setTimeout(resolve, 5));
  const closing = adapter.close();
  await assert.rejects(adapter.newThread(AGENT), { code: 'shutting_down' });
  release.open();
  await turn;
  await closing;
  await assert.rejects(adapter.newThread(AGENT), { code: 'shutting_down' });
  assert.deepEqual(await store.readPointer('cfo'), { sessionId: 'session-1', createdAt: AT });
});

test('New thread reports a failed clear as thread_reset_failed', async (t) => {
  const { adapter, store } = await setup(t);
  store.clearPointer = async () => { throw new Error('EACCES: permission denied'); };
  await assert.rejects(adapter.newThread(AGENT), (error) => {
    assert.equal(error.name, 'RuntimeError');
    assert.equal(error.code, 'thread_reset_failed');
    assert.equal(error.cause.message, 'EACCES: permission denied');
    return true;
  });
  await adapter.send(AGENT, 'Still works');
});

test('a throwing listener is logged and the other listeners still run', async (t) => {
  const { adapter, events, logs } = await setup(t);
  adapter.subscribe(() => { throw new Error('listener broke'); });
  const later = [];
  adapter.subscribe((event) => later.push(event.type));
  await adapter.send(AGENT, 'Hi');
  assert.deepEqual(later, events.map((event) => event.type));
  assert.ok(logs.some((entry) => entry.event === 'runtime_listener_error' && entry.error === 'listener broke'));
  assert.equal(adapter.state('cfo').state, 'idle');
});

test('model and effort are passed only when the turn sets them, never from the agent', async (t) => {
  const { adapter, query, logs } = await setup(t);
  await adapter.send({ ...AGENT, model: 'claude-sonnet' }, 'one');
  await adapter.send(AGENT, 'two', { model: 'sonnet', effort: 'high' });
  await adapter.send(AGENT, 'three', { model: null, effort: 'low' });
  await adapter.send(AGENT, 'four', { model: 'opus' });
  assert.equal('model' in query.calls[0].options, false);
  assert.equal('effort' in query.calls[0].options, false);
  assert.equal(query.calls[1].options.model, 'sonnet');
  assert.equal(query.calls[1].options.effort, 'high');
  assert.equal('model' in query.calls[2].options, false);
  assert.equal(query.calls[2].options.effort, 'low');
  assert.equal(query.calls[3].options.model, 'opus');
  assert.equal('effort' in query.calls[3].options, false);
  assert.deepEqual(logs.filter((e) => e.event === 'persona_init').map((e) => e.effort), [null, 'high', 'low', null]);
});

test('the permission level maps onto the SDK mode; absent and null are ask; a bad level is refused before the first await', async (t) => {
  const { adapter, query, logs } = await setup(t);
  await adapter.send(AGENT, 'one');
  await adapter.send(AGENT, 'two', { permission: null });
  await adapter.send(AGENT, 'three', { permission: 'ask' });
  await adapter.send(AGENT, 'four', { permission: 'auto' });
  await adapter.send(AGENT, 'five', { permission: 'full' });
  const modes = query.calls.map(({ options }) => [options.permissionMode, options.allowDangerouslySkipPermissions]);
  assert.deepEqual(modes, [['default', undefined], ['default', undefined], ['default', undefined], ['auto', undefined], ['bypassPermissions', true]]);
  for (const { options } of query.calls.slice(0, 4)) assert.equal('allowDangerouslySkipPermissions' in options, false);
  for (const { options } of query.calls) assert.equal(typeof options.canUseTool, 'function', 'questions still come through at every level');
  assert.deepEqual(logs.filter((e) => e.event === 'persona_init').map((e) => [e.permission, e.permissionMode]), [
    ['ask', null], ['ask', null], ['ask', null], ['auto', null], ['full', null],
  ]);
  assert.equal(logs.some((e) => e.event === 'persona_permission_mismatch'), false, 'an init without a mode is not a mismatch');

  for (const bad of ['bypass', 'Ask', '', 3, {}]) {
    let rejected = null;
    const turn = adapter.send(AGENT, 'six', { permission: bad });
    turn.catch((error) => { rejected = error; });
    assert.equal(adapter.state('cfo').state, 'idle', 'refused synchronously, no turn opened');
    await turn.catch(() => {});
    assert.equal(rejected?.code, 'invalid_permission', JSON.stringify(bad));
  }
  assert.equal(query.calls.length, 5);
});

test('an init whose permissionMode differs from the level requested logs one mismatch and the turn goes on', async (t) => {
  const query = fakeQuery(async function* ({ options }) {
    yield init('session-1', { permissionMode: options.permissionMode === 'auto' ? 'default' : options.permissionMode });
    yield assistant('Fine.');
    yield result();
  });
  const { adapter, events, logs } = await setup(t, { query });
  await adapter.send(AGENT, 'one', { permission: 'auto' });
  assert.deepEqual(logs.filter((e) => e.event === 'persona_permission_mismatch'), [
    { event: 'persona_permission_mismatch', agentId: 'cfo', permission: 'auto', requested: 'auto', actual: 'default' },
  ]);
  assert.deepEqual(logs.filter((e) => e.event === 'persona_init').map((e) => e.permissionMode), ['default']);
  assert.deepEqual(states(events), ['busy', 'idle']);
  assert.equal(events.some((event) => event.type === 'error'), false);

  await adapter.send(AGENT, 'two', { permission: 'full' });
  await adapter.send(AGENT, 'three');
  assert.equal(logs.filter((e) => e.event === 'persona_permission_mismatch').length, 1, 'a mode that matches is not logged');
});

test('Full access with an init that reports an API key is refused before any tool call', async (t) => {
  let toolCalls = 0;
  let signal;
  const query = fakeQuery(async function* ({ options }) {
    signal = options.abortController.signal;
    yield init('session-1', { apiKeySource: 'ANTHROPIC_API_KEY', permissionMode: 'bypassPermissions' });
    toolCalls += 1;
    await options.canUseTool('Bash', BASH_INPUT, {});
    yield assistant('This should never be shown.');
    yield result();
  });
  const { adapter, events, logs } = await setup(t, { query });
  await adapter.send(AGENT, 'Hi', { permission: 'full' });
  assert.equal(signal.aborted, true);
  assert.equal(toolCalls, 0);
  assert.equal(events.some((event) => event.type === 'request'), false);
  assert.deepEqual(states(events), ['busy', 'error']);
  assert.equal(adapter.state('cfo').lastError, 'Refused: this turn would bill an API key (ANTHROPIC_API_KEY).');
  assert.ok(logs.some((entry) => entry.event === 'persona_api_key_refused' && entry.source === 'ANTHROPIC_API_KEY'));
  assert.equal(query.calls[0].options.permissionMode, 'bypassPermissions');
});

test('a model the CLI rejects ends the turn in error with its explanation as lastError', async (t) => {
  const explanation = "There's an issue with the selected model (not-a-model). It may not exist or you may not have access to it.";
  const query = fakeQuery(async function* () {
    yield init();
    yield result({ is_error: true, result: explanation, total_cost_usd: 0 });
  });
  const { adapter, events } = await setup(t, { query, limits: { messageTextBytes: 4_096 } });
  await adapter.send(AGENT, 'Hi', { model: 'not-a-model' });
  assert.equal(query.calls[0].options.model, 'not-a-model');
  assert.deepEqual(states(events), ['busy', 'error']);
  assert.equal(events.find((event) => event.type === 'error').message, explanation);
  assert.equal(adapter.state('cfo').lastError, explanation);
  assert.equal(adapter.state('cfo').state, 'error');
});

test('the cwd is pinned at start or first turn and moves only on New thread', async (t) => {
  const { adapter, query } = await setup(t);
  assert.equal(adapter.state('cfo').cwd, null);
  await adapter.start(AGENT);
  assert.equal(adapter.state('cfo').cwd, '/invented/cfo');
  const moved = { ...AGENT, cwd: '/invented/elsewhere' };
  await adapter.send(moved, 'one');
  assert.equal(query.calls[0].options.cwd, '/invented/cfo');
  assert.equal(query.calls[0].options.resume, undefined);
  await adapter.send(moved, 'two');
  assert.equal(query.calls[1].options.cwd, '/invented/cfo');
  assert.equal(query.calls[1].options.resume, 'session-1');
  await adapter.newThread(moved);
  assert.equal(adapter.state('cfo').cwd, '/invented/elsewhere');
  await adapter.send(moved, 'three');
  assert.equal(query.calls[2].options.cwd, '/invented/elsewhere');
  assert.equal('resume' in query.calls[2].options, false);

  // A persona never started pins on its first send.
  const other = { ...AGENT, id: 'ops', cwd: '/invented/ops' };
  await adapter.send(other, 'one');
  assert.equal(adapter.state('ops').cwd, '/invented/ops');
  assert.equal(query.calls[3].options.cwd, '/invented/ops');
});

test('invalid agents and empty text are refused before any turn starts', async (t) => {
  const { adapter, query } = await setup(t);
  await assert.rejects(adapter.send({ ...AGENT, id: '../x' }, 'Hi'), { code: 'invalid_agent' });
  await assert.rejects(adapter.send({ ...AGENT, cwd: 'relative' }, 'Hi'), { code: 'invalid_agent' });
  await assert.rejects(adapter.send(AGENT, '   '), { code: 'invalid_text' });
  await assert.rejects(adapter.answer(AGENT, 'nope', { decision: 'allow' }), { code: 'no_such_request' });
  assert.equal(query.calls.length, 0);
  assert.equal(adapter.kind, 'claude');
});

test('setModel keeps the thread\'s choice in the pointer and the entry, says so in the thread, and a key absent keeps its field', async (t) => {
  const { adapter, store, events, logs } = await setup(t);
  await adapter.start(AGENT);
  assert.equal(adapter.state('cfo').model, null);

  // A choice before any session: the pointer holds it with a null session.
  await adapter.setModel(AGENT, { model: 'sonnet' });
  assert.deepEqual(await store.readPointer('cfo'), { sessionId: null, createdAt: AT, model: 'sonnet' });
  assert.deepEqual(adapter.state('cfo').model, { id: 'sonnet', effort: null });
  assert.deepEqual(events.filter((e) => e.type === 'message').map(({ role, kind, model, effort, text }) => ({ role, kind, model, effort, text })), [
    { role: 'system', kind: 'model', model: 'sonnet', effort: null, text: 'Now on Sonnet.' },
  ]);
  assert.deepEqual(logs.filter((l) => l.event === 'persona_model'), [{ event: 'persona_model', agentId: 'cfo', model: 'sonnet', effort: null }]);

  // Effort alone keeps the model; the line names both.
  await adapter.setModel(AGENT, { effort: 'low' });
  assert.deepEqual(adapter.state('cfo').model, { id: 'sonnet', effort: 'low' });
  assert.equal(events.filter((e) => e.type === 'message').at(-1).text, 'Now on Sonnet, low effort.');

  // The session id from a turn joins the pair in the pointer, and the turn
  // runs on whatever send() is given (the hub resolves it from state().model).
  await adapter.send(AGENT, 'Hi', { model: 'sonnet', effort: 'low' });
  assert.deepEqual(await store.readPointer('cfo'), { sessionId: 'session-1', createdAt: AT, model: 'sonnet', effort: 'low' });
  const cached = (await store.read('cfo')).map(({ role, kind, text }) => ({ role, kind, text }));
  assert.deepEqual(cached.slice(0, 2), [
    { role: 'system', kind: 'model', text: 'Now on Sonnet.' },
    { role: 'system', kind: 'model', text: 'Now on Sonnet, low effort.' },
  ]);

  // Dropping the model alone leaves the effort; dropping both says so.
  await adapter.setModel(AGENT, { model: null });
  assert.deepEqual(adapter.state('cfo').model, { id: null, effort: 'low' });
  assert.equal(events.filter((e) => e.type === 'message').at(-1).text, 'Now at low effort.');
  assert.deepEqual(await store.readPointer('cfo'), { sessionId: 'session-1', createdAt: AT, effort: 'low' });
  await adapter.setModel(AGENT, { effort: null });
  assert.equal(adapter.state('cfo').model, null);
  assert.equal(events.filter((e) => e.type === 'message').at(-1).text, "Back to the agent's default.");
  assert.deepEqual(await store.readPointer('cfo'), { sessionId: 'session-1', createdAt: AT });

  // An unknown id shows as itself; a long effort name reads in lower case.
  await adapter.setModel(AGENT, { model: 'claude-x-9', effort: 'xhigh' });
  assert.equal(events.filter((e) => e.type === 'message').at(-1).text, 'Now on claude-x-9, extra high effort.');
});

test('a model chosen alone passes no effort to the turn, and the pair given to send() reaches the query', async (t) => {
  const { adapter, query } = await setup(t);
  await adapter.send(AGENT, 'Hi', { model: 'sonnet' });
  assert.equal(query.calls.at(-1).options.model, 'sonnet');
  assert.equal('effort' in query.calls.at(-1).options, false);
  await adapter.send(AGENT, 'Again', { model: 'sonnet', effort: 'low' });
  assert.equal(query.calls.at(-1).options.effort, 'low');
});

test('setModel refuses a bad choice, a busy turn, and a reset in flight, and is refused by them in turn', async (t) => {
  const release = gate();
  let calls = 0;
  const query = fakeQuery(async function* () {
    calls += 1;
    yield init();
    if (calls === 1) await release.promise;
    yield result();
  });
  const { adapter, store } = await setup(t, { query });
  await assert.rejects(adapter.setModel(AGENT, { model: '' }), { code: 'invalid_model' });
  await assert.rejects(adapter.setModel(AGENT, { model: 'x'.repeat(65) }), { code: 'invalid_model' });
  await assert.rejects(adapter.setModel(AGENT, { model: 7 }), { code: 'invalid_model' });
  await assert.rejects(adapter.setModel(AGENT, { effort: 'extreme' }), { code: 'invalid_effort' });
  await assert.rejects(adapter.setModel({ ...AGENT, id: 'Bad Id' }, { model: 'sonnet' }), { code: 'invalid_agent' });

  const turn = adapter.send(AGENT, 'Hi');
  await assert.rejects(adapter.setModel(AGENT, { model: 'sonnet' }), { code: 'busy' });
  release.open();
  await turn;

  // While setModel writes, a send and a New thread are busy; once done the
  // choice stands.
  const change = adapter.setModel(AGENT, { model: 'haiku' });
  await assert.rejects(adapter.send(AGENT, 'during change'), { code: 'busy' });
  await assert.rejects(adapter.newThread(AGENT), { code: 'busy' });
  await change;
  assert.deepEqual(adapter.state('cfo').model, { id: 'haiku', effort: null });

  // And a reset in flight refuses setModel.
  const reset = adapter.newThread(AGENT);
  await assert.rejects(adapter.setModel(AGENT, { model: 'sonnet' }), { code: 'busy' });
  await reset;
  assert.equal(adapter.state('cfo').model, null);
  assert.equal(await store.readPointer('cfo'), null);
});

test('a fresh adapter reads the thread\'s choice back from the pointer, and adopting a session keeps it', async (t) => {
  const { adapter, store } = await setup(t);
  await store.writePointer('cfo', { sessionId: 'session-0', createdAt: AT, model: 'opus', effort: 'max' });
  await adapter.start(AGENT);
  assert.deepEqual(adapter.state('cfo').model, { id: 'opus', effort: 'max' });
  await adapter.send(AGENT, 'Hi');
  // init says session-1, which replaces session-0 and keeps the pair.
  assert.deepEqual(await store.readPointer('cfo'), { sessionId: 'session-1', createdAt: AT, model: 'opus', effort: 'max' });
  assert.deepEqual(adapter.state('cfo').model, { id: 'opus', effort: 'max' });
});

test('setModel after close has begun is refused', async (t) => {
  const { adapter } = await setup(t);
  await adapter.close();
  await assert.rejects(adapter.setModel(AGENT, { model: 'sonnet' }), { code: 'shutting_down' });
});

test('send records who sent the text and whom it mentions, and the SDK gets the prompt in place of the text', async (t) => {
  const { adapter, store, events, query } = await setup(t);
  await adapter.send(AGENT, 'Should he rebalance? @CFO', {
    from: 'assistant', mentions: ['cfo', '', 7, 'brain'], prompt: 'From Assistant (not the user): Should he rebalance? @CFO',
  });
  const user = events.find((event) => event.type === 'message' && event.role === 'user');
  assert.equal(user.text, 'Should he rebalance? @CFO');
  assert.equal(user.from, 'assistant');
  assert.deepEqual(user.mentions, ['cfo', 'brain']);
  const cached = (await store.read('cfo'))[0];
  assert.equal(cached.from, 'assistant');
  assert.deepEqual(cached.mentions, ['cfo', 'brain']);
  assert.equal(query.calls[0].prompt, 'From Assistant (not the user): Should he rebalance? @CFO');

  // Without them, nothing is recorded and the text is the prompt.
  await adapter.send(AGENT, 'Plain');
  const second = events.filter((event) => event.type === 'message' && event.role === 'user')[1];
  assert.equal('from' in second, false);
  assert.equal('mentions' in second, false);
  assert.equal(query.calls[1].prompt, 'Plain');
  // A blank prompt is ignored; an empty mentions list is not recorded.
  await adapter.send(AGENT, 'Third', { prompt: '  ', mentions: [] });
  const third = events.filter((event) => event.type === 'message' && event.role === 'user')[2];
  assert.equal('mentions' in third, false);
  assert.equal(query.calls[2].prompt, 'Third');
});

// The per-turn tools hook (delegation.mjs provides the real one).

test('the tools hook adds mcpServers and allowedTools by name and cannot change anything else', async (t) => {
  const server = { type: 'sdk', name: 'agents', instance: {} };
  const seen = [];
  const turnTools = (agent, context) => {
    seen.push({ agent, context });
    return {
      mcpServers: { agents: server },
      allowedTools: ['mcp__agents__ask'],
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      canUseTool: null,
      cwd: '/elsewhere',
      resume: 'forged',
      maxTurns: 999,
    };
  };
  const { adapter, query } = await setup(t, { turnTools });
  await adapter.send(AGENT, 'How is cash? @Brain', { permission: 'auto', mentions: ['brain'], chain: ['assistant'], from: 'assistant', prompt: 'From Assistant: How is cash? @Brain' });

  assert.equal(seen.length, 1);
  assert.equal(seen[0].agent, AGENT);
  const { context } = seen[0];
  assert.equal(context.text, 'How is cash? @Brain');
  assert.equal(context.prompt, 'From Assistant: How is cash? @Brain');
  assert.equal(context.from, 'assistant');
  assert.deepEqual(context.chain, ['assistant']);
  assert.deepEqual(context.mentions, ['brain']);
  assert.match(context.turnId, /^[0-9a-f-]{36}$/);

  const { options, prompt } = query.calls[0];
  assert.equal(options.mcpServers.agents, server);
  assert.deepEqual(options.allowedTools, ['mcp__agents__ask']);
  assert.equal(options.permissionMode, 'auto', 'the level the caller passed, not the hook\'s');
  assert.equal('allowDangerouslySkipPermissions' in options, false);
  assert.equal(typeof options.canUseTool, 'function');
  assert.equal(options.cwd, '/invented/cfo');
  assert.equal('resume' in options, false);
  assert.equal(options.maxTurns, LIMITS.turnMaxTurns);
  // The adapter's prompt stands when the hook returns none.
  assert.equal(prompt, 'From Assistant: How is cash? @Brain');

  // A second turn gets a new turn id and an empty chain by default.
  await adapter.send(AGENT, 'Again');
  assert.notEqual(seen[1].context.turnId, seen[0].context.turnId);
  assert.deepEqual(seen[1].context.chain, []);
  assert.equal(seen[1].context.from, null);
  assert.equal(seen[1].context.prompt, 'Again');
});

test('the tools hook may replace the prompt the model gets; the thread keeps the text', async (t) => {
  const turnTools = () => ({ prompt: 'Replies that arrived since your last turn:\nFrom BRAIN (d-1): Three notes.\n\nWhat changed?' });
  const { adapter, store, query } = await setup(t, { turnTools });
  await adapter.send(AGENT, 'What changed?');
  assert.equal(query.calls[0].prompt, 'Replies that arrived since your last turn:\nFrom BRAIN (d-1): Three notes.\n\nWhat changed?');
  assert.equal('mcpServers' in query.calls[0].options, false);
  assert.equal('allowedTools' in query.calls[0].options, false);
  assert.equal((await store.read('cfo'))[0].text, 'What changed?');
  // A blank hook prompt is ignored.
  const blank = await setup(t, { turnTools: () => ({ prompt: '   ' }) });
  await blank.adapter.send(AGENT, 'Plain');
  assert.equal(blank.query.calls[0].prompt, 'Plain');
});

test('a tools hook that throws is logged and the turn runs without tools', async (t) => {
  const turnTools = () => { throw new Error('invented hook failure'); };
  const { adapter, events, logs, query } = await setup(t, { turnTools });
  await adapter.send(AGENT, 'How is cash?');
  assert.deepEqual(states(events), ['busy', 'idle']);
  assert.equal(query.calls.length, 1);
  assert.equal('mcpServers' in query.calls[0].options, false);
  const logged = logs.find((entry) => entry.event === 'persona_tools_error');
  assert.deepEqual(logged, { event: 'persona_tools_error', agentId: 'cfo', error: 'invented hook failure' });
  assert.equal(events.some((event) => event.type === 'error'), false);
});

test('the hook result is committed once init is seen and rolled back when the turn never starts', async (t) => {
  const settled = [];
  const tools = () => ({ commit: () => settled.push('commit'), rollback: () => settled.push('rollback') });
  const { adapter } = await setup(t, { turnTools: tools });
  await adapter.send(AGENT, 'Fine turn');
  assert.deepEqual(settled, ['commit']);

  // A stream that fails before init: rolled back, once.
  settled.length = 0;
  const failing = fakeQuery(async function* () {
    throw new Error('Claude Code process exited with code 127');
  });
  const broken = await setup(t, { query: failing, turnTools: tools });
  await broken.adapter.send(AGENT, 'Continue');
  assert.deepEqual(settled, ['rollback']);
  assert.equal(broken.events.find((event) => event.type === 'error').message, 'The turn could not start. Retry; if it keeps failing, start a new thread.');

  // A stream that fails before init while resuming: rolled back too.
  settled.length = 0;
  const resuming = fakeQuery(async function* ({ options }) {
    options.stderr('No conversation found with session ID: session-0\n');
    throw new Error('Claude Code process exited with code 1');
  });
  const resumed = await setup(t, { query: resuming, turnTools: tools });
  await resumed.store.writePointer('cfo', { sessionId: 'session-0', createdAt: AT });
  await resumed.adapter.send(AGENT, 'Continue');
  assert.deepEqual(settled, ['rollback']);

  // A turn that fails after init was committed and is not rolled back.
  settled.length = 0;
  const late = fakeQuery(async function* () {
    yield init();
    throw new Error('Claude Code process exited with code 1');
  });
  const afterInit = await setup(t, { query: late, turnTools: tools });
  await afterInit.adapter.send(AGENT, 'Go');
  assert.deepEqual(settled, ['commit']);

  // A throwing commit is logged, not raised.
  const noisy = await setup(t, { turnTools: () => ({ commit: () => { throw new Error('bad commit'); } }) });
  await noisy.adapter.send(AGENT, 'Go');
  assert.deepEqual(states(noisy.events), ['busy', 'idle']);
  assert.ok(noisy.logs.some((entry) => entry.event === 'persona_tools_error' && entry.method === 'commit'));
});
