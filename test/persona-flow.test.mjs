// End to end through the real routes, hub, and Claude adapter, with only the
// SDK's query() replaced: a message goes in, a question comes out in the
// snapshot, the answer goes back, and the answer reaches the SDK's
// canUseTool. This runs the send race and the event mapping together, which
// the route and hub unit tests can only check against stand-ins.

import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';

import { LIMITS, TIMEOUTS } from '../lib/config.mjs';
import { createClaudeAdapter } from '../lib/runtime/claude.mjs';
import { createThreadStore } from '../lib/threads.mjs';
import { fakeRegistry, request, startApp, tempDir } from './support/harness.mjs';

const status = {
  focus: { checkHealth: async () => ({ available: true }) },
  brief: { latestMetadata: async () => ({ state: 'empty' }) },
};

const QUESTION = 'Which color do you want?';
// Larger than LIMITS.requestInputBytes: a question is never cut.
const QUESTION_INPUT = Object.freeze({
  questions: [{
    question: QUESTION,
    header: 'Color',
    options: [
      { label: 'Blue', description: 'b'.repeat(LIMITS.requestInputBytes) },
      { label: 'Amber', description: 'Choose Amber' },
    ],
    multiSelect: false,
  }],
});

function post(app, path, body) {
  return request(app, 'POST', path, {
    headers: { origin: app.origin, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

// Resolves with the cfo entry of the first snapshot that satisfies `predicate`.
async function waitForPersona(app, predicate, ms = 3_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const cfo = app.hub.snapshot().agents.find((agent) => agent.id === 'cfo');
    if (predicate(cfo)) return cfo;
    if (Date.now() > deadline) throw new Error('snapshot did not arrive');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('a message, a question, an answer, and the reply flow through the real route, hub, and adapter', async (t) => {
  let decision;
  const calls = [];
  const query = (args) => {
    calls.push(args);
    return (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'session-1', apiKeySource: 'none' };
      decision = await args.options.canUseTool('AskUserQuestion', QUESTION_INPUT, { signal: new AbortController().signal });
      yield { type: 'assistant', parent_tool_use_id: null, session_id: 'session-1', message: { content: [{ type: 'text', text: 'Amber it is.' }] } };
      yield {
        type: 'result', subtype: 'success', is_error: false, session_id: 'session-1', num_turns: 1,
        total_cost_usd: 0.5, usage: { input_tokens: 10, output_tokens: 3 }, permission_denials: [],
      };
    })();
  };
  const dir = await tempDir(t);
  const store = createThreadStore({ dir: path.join(dir, 'threads'), limits: LIMITS });
  const logs = [];
  const adapter = createClaudeAdapter({
    query,
    store,
    config: { limits: LIMITS, timeouts: { ...TIMEOUTS, drainMs: 200, abortGraceMs: 100 } },
    log: (entry) => logs.push(entry),
  });
  t.after(() => adapter.close());
  const agents = [{
    id: 'cfo', name: 'CFO', role: 'Money', description: 'Invented.', group: 'work', kind: 'persona',
    cwd: path.join(dir, 'repo'), provider: 'claude', routines: [],
  }];
  const app = await startApp(t, { ...status, registry: fakeRegistry(agents), adapters: { claude: adapter }, store });
  assert.equal((await request(app, 'GET', '/api/state')).json.agents[0].state, 'idle');

  const sent = await post(app, '/api/agents/cfo/send', { text: 'Pick a color for me.' });
  assert.deepEqual([sent.status, sent.json], [202, { ok: true }]);

  const waiting = await waitForPersona(app, (cfo) => cfo.state === 'waiting' && cfo.pending);
  assert.equal(waiting.pending.kind, 'question');
  assert.equal(waiting.pending.toolName, 'AskUserQuestion');
  assert.deepEqual(waiting.pending.input, QUESTION_INPUT);
  assert.equal(waiting.pending.truncated, false);
  assert.deepEqual(waiting.lastMessage, { role: 'user', text: 'Pick a color for me.', at: waiting.lastMessage.at });
  assert.deepEqual((await request(app, 'GET', '/api/state')).json.agents[0].pending, waiting.pending);

  // A second message while the question is open is refused, not queued.
  const busy = await post(app, '/api/agents/cfo/send', { text: 'Also this' });
  assert.deepEqual([busy.status, busy.json], [409, { error: 'busy' }]);
  assert.equal(calls.length, 1);

  const answered = await post(app, '/api/agents/cfo/answer', { requestId: waiting.pending.requestId, answers: { [QUESTION]: 'Amber' } });
  assert.deepEqual([answered.status, answered.json], [200, { ok: true }]);

  const idle = await waitForPersona(app, (cfo) => cfo.state === 'idle');
  assert.equal(idle.pending, null);
  assert.equal(idle.lastError, null);
  assert.equal(idle.costUsd, 0.5);
  assert.deepEqual(idle.lastMessage, { role: 'assistant', text: 'Amber it is.', at: idle.lastMessage.at });
  assert.deepEqual(decision, { behavior: 'allow', updatedInput: { ...QUESTION_INPUT, answers: { [QUESTION]: 'Amber' } } });

  const stale = await post(app, '/api/agents/cfo/answer', { requestId: waiting.pending.requestId, answers: { [QUESTION]: 'Blue' } });
  assert.deepEqual([stale.status, stale.json], [409, { error: 'no_such_request' }]);

  const thread = await request(app, 'GET', '/api/agents/cfo/thread');
  assert.deepEqual(thread.json.messages.map(({ role, text }) => ({ role, text })), [
    { role: 'user', text: 'Pick a color for me.' },
    { role: 'assistant', text: 'Amber it is.' },
  ]);
  assert.deepEqual(await store.readPointer('cfo'), { sessionId: 'session-1', createdAt: (await store.readPointer('cfo')).createdAt });
  assert.equal(logs.some((entry) => entry.event === 'persona_turn_rejected'), false);
  assert.equal(app.logs.some((entry) => entry.event === 'persona_turn_rejected'), false);
});
