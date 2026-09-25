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

async function setup(t, { query = simple(), timeouts = {}, limits = {} } = {}) {
  const dir = path.join(await tempDir(t), 'threads');
  const store = createThreadStore({ dir, limits: { ...LIMITS, ...limits } });
  const logs = [];
  const adapter = createClaudeAdapter({
    query,
    store,
    config: { limits: { ...LIMITS, ...limits }, timeouts: { drainMs: 2_000, requestMaxAgeMs: 60_000, ...timeouts } },
    log: (entry) => logs.push(entry),
    now: () => new Date(AT),
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
  assert.deepEqual(adapter.state('cfo'), { state: 'idle', pending: null, lastError: null, sessionId: 'session-1', costUsd: 0.25 });

  const { prompt, options } = query.calls[0];
  assert.equal(prompt, 'How is cash?');
  assert.equal(options.cwd, '/invented/cfo');
  assert.equal(options.permissionMode, 'default');
  assert.equal(options.maxTurns, 7);
  assert.equal(typeof options.canUseTool, 'function');
  assert.ok(options.abortController instanceof AbortController);
  assert.equal('resume' in options, false);
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
  assert.deepEqual(adapter.state('cfo'), { state: 'idle', pending: null, lastError: null, sessionId: 'session-1', costUsd: null });
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

test('a stream that fails before init while resuming says the stored session could not be resumed', async (t) => {
  const query = fakeQuery(async function* () {
    throw new Error('No conversation found with session ID: session-0');
  });
  const { adapter, store, events, logs } = await setup(t, { query });
  await store.writePointer('cfo', { sessionId: 'session-0', createdAt: AT });
  await adapter.send(AGENT, 'Continue');
  const message = 'The stored session could not be resumed. Start a new thread.';
  assert.equal(events.find((event) => event.type === 'error').message, message);
  assert.equal(adapter.state('cfo').state, 'error');
  assert.equal(adapter.state('cfo').lastError, message);
  assert.ok(logs.some((entry) => entry.event === 'thread_resume_failed' && entry.agentId === 'cfo'));
  assert.equal((await store.readPointer('cfo')).sessionId, 'session-0');
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

test('the model option is passed only when the agent sets one', async (t) => {
  const { adapter, query } = await setup(t);
  await adapter.send(AGENT, 'one');
  await adapter.send({ ...AGENT, model: 'claude-sonnet' }, 'two');
  assert.equal('model' in query.calls[0].options, false);
  assert.equal(query.calls[1].options.model, 'claude-sonnet');
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
