import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';

import { LIMITS, TIMEOUTS } from '../lib/config.mjs';
import { ASK_TOOL, createDelegation } from '../lib/delegation.mjs';
import { createThreadStore } from '../lib/threads.mjs';
import { fakePersonas } from './support/browser-server.mjs';
import { fakeRegistry, request, startApp, tempDir } from './support/harness.mjs';

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

// assistant asks anyone; cfo takes messages from everyone; brain only from
// the assistant; watch from cfo and brain; catchup is a project folder;
// dev is a Codex persona no adapter runs here.
const AGENTS = [
  agent('assistant', { name: 'Assistant', pinned: true }),
  agent('cfo', { name: 'CFO', role: 'Money', description: 'Drift and decisions.' }),
  agent('brain', { name: 'Second brain', accepts: ['assistant'] }),
  agent('watch', { name: 'Watch', accepts: ['cfo', 'brain'] }),
  agent('ops', { name: 'Ops' }),
  agent('catchup', { name: 'Catchup', kind: 'project' }),
  agent('dev', { name: 'Dev', provider: 'codex' }),
];

// A stand-in for the SDK's tool() and createSdkMcpServer(): the tool is
// kept as given so a test can call its handler.
const fakeSdk = async () => ({
  tool: (name, description, schema, handler) => ({ name, description, schema, handler }),
  createSdkMcpServer: ({ name, version, tools }) => ({ type: 'sdk', name, version, instance: { tools } }),
});

async function setup(t, { agents = AGENTS, seed = {}, waitMs = 2_000, limits = {}, now = () => new Date(), ids = null } = {}) {
  const dir = path.join(await tempDir(t), 'threads');
  const registry = fakeRegistry(agents);
  const store = createThreadStore({ dir, limits: { messageTextBytes: 8192, threadCacheMessages: 50, threadCacheBytes: 64 * 1024, ...limits } });
  const personas = fakePersonas(seed, store);
  let counter = 0;
  const logs = [];
  const app = await startApp(t, {
    ...status,
    registry,
    adapters: { claude: personas.adapter },
    store,
    configure: (config) => ({
      ...config,
      limits: { ...config.limits, ...limits },
      timeouts: { ...config.timeouts, delegationWaitMs: waitMs },
    }),
    delegation: (hub) => createDelegation({
      hub,
      registry,
      limits: { ...LIMITS, ...limits },
      timeouts: { ...TIMEOUTS, delegationWaitMs: waitMs },
      log: (entry) => logs.push(entry),
      now,
      randomUUID: () => (ids ? ids[counter++] : `d-${++counter}`),
      importSdk: fakeSdk,
    }),
  });
  t.after(() => personas.adapter.close());
  const thread = async (id) => (await store.read(id)).map(({ at, ...rest }) => rest);
  const lines = async (id) => (await thread(id)).filter((entry) => entry.kind === 'delegation');
  return { app, delegation: app.delegation, personas, registry, store, logs, thread, lines, hub: app.hub };
}

const settle = (ms = 120) => new Promise((resolve) => setTimeout(resolve, ms));

test('a message to an agent that replies in time comes back inline, with the lines on both threads', async (t) => {
  const { delegation, personas, thread, lines, logs } = await setup(t);
  const outcome = await delegation.ask({ from: 'assistant', chain: [], to: 'cfo', message: 'Is he over on equities? Two lines.' });
  assert.deepEqual(outcome, {
    status: 'replied', delegationId: 'd-1', reply: 'Reply: Is he over on equities? Two lines.', text: 'Reply: Is he over on equities? Two lines.',
  });
  assert.deepEqual(await lines('assistant'), [
    { role: 'system', kind: 'delegation', state: 'sent', to: 'cfo', delegationId: 'd-1', text: 'Messaged CFO', summary: 'Messaged CFO' },
    {
      role: 'system', kind: 'delegation', state: 'finished', to: 'cfo', delegationId: 'd-1',
      text: 'Reply: Is he over on equities? Two lines.', summary: 'Reply: Is he over on equities?',
    },
  ]);
  // The receiver's thread shows the message as written, from the sender.
  assert.deepEqual(await thread('cfo'), [
    { role: 'user', text: 'Is he over on equities? Two lines.', from: 'assistant' },
    { role: 'assistant', text: 'Reply: Is he over on equities? Two lines.' },
  ]);
  // The adapter got the sender, the chain, the resolved model, and the prefixed prompt.
  const { context } = personas.sent[0];
  assert.equal(context.from, 'assistant');
  assert.deepEqual(context.chain, ['assistant']);
  assert.equal(context.prompt, 'From Assistant, an agent in this system (not the user): Is he over on equities? Two lines.');
  assert.ok('model' in context && 'effort' in context);
  assert.deepEqual(logs.filter((entry) => entry.event.startsWith('delegation_')).map((entry) => [entry.event, entry.status ?? entry.reason ?? null]), [
    ['delegation_sent', null], ['delegation_finished', 'finished'],
  ]);
  const finished = logs.find((entry) => entry.event === 'delegation_finished');
  assert.equal(finished.inline, true);
  assert.equal(typeof finished.waitedMs, 'number');
  assert.equal(delegation.pendingFor('assistant', null).length, 0);
});

test('refusals come in order, each as one line and nothing sent', async (t) => {
  const { delegation, personas, lines, logs } = await setup(t);
  const cases = [
    [{ from: 'assistant', to: 'nobody' }, 'unknown', 'No agent is named nobody.'],
    [{ from: 'assistant', to: 'catchup' }, 'not_an_agent', 'Catchup does not take messages.'],
    [{ from: 'assistant', to: 'dev' }, 'unavailable', 'Dev is not available.'],
    [{ from: 'cfo', to: 'brain' }, 'not_allowed', 'Second brain does not accept messages from CFO.'],
    [{ from: 'cfo', to: 'cfo' }, 'cycle', 'CFO is already in this exchange.'],
    [{ from: 'cfo', chain: ['assistant', 'brain'], to: 'watch' }, 'depth', 'This exchange is already two agents deep.'],
  ];
  for (const [ask, reason, text] of cases) {
    const outcome = await delegation.ask({ chain: [], message: 'Hello', ...ask });
    assert.deepEqual(outcome, { status: 'refused', reason, text }, reason);
    const posted = (await lines(ask.from)).at(-1);
    assert.deepEqual(posted, {
      role: 'system', kind: 'delegation', state: 'refused', reason, to: ask.to, text, summary: text,
      ...(reason === 'not_allowed' ? { from: ask.from } : {}),
    }, reason);
  }
  // A cycle through the chain, not only to oneself.
  const cycle = await delegation.ask({ from: 'brain', chain: ['assistant', 'cfo'], to: 'cfo', message: 'Back to you' });
  assert.equal(cycle.reason, 'cycle');
  assert.deepEqual(personas.sent, []);
  assert.deepEqual(logs.filter((entry) => entry.event === 'delegation_refused').map((entry) => entry.reason), [
    'unknown', 'not_an_agent', 'unavailable', 'not_allowed', 'cycle', 'depth', 'cycle',
  ]);
});

test('the chain allows two hops: the user asks A, A asks B, B asks C, C may not ask', async (t) => {
  const { delegation, personas } = await setup(t);
  const a = await delegation.ask({ from: 'assistant', chain: [], to: 'cfo', message: 'One' });
  assert.equal(a.status, 'replied');
  assert.deepEqual(personas.sent.at(-1).context.chain, ['assistant']);
  const b = await delegation.ask({ from: 'cfo', chain: ['assistant'], to: 'watch', message: 'Two' });
  assert.equal(b.status, 'replied');
  assert.deepEqual(personas.sent.at(-1).context.chain, ['assistant', 'cfo']);
  const c = await delegation.ask({ from: 'watch', chain: ['assistant', 'cfo'], to: 'ops', message: 'Three' });
  assert.deepEqual([c.status, c.reason], ['refused', 'depth']);
  assert.equal(personas.sent.length, 2);
});

test('accepts absent or null means everyone; present means only those named', async (t) => {
  const { delegation } = await setup(t, { agents: [...AGENTS, agent('open', { accepts: null })] });
  assert.equal((await delegation.ask({ from: 'watch', chain: [], to: 'open', message: 'Hi' })).status, 'replied');
  assert.equal((await delegation.ask({ from: 'watch', chain: [], to: 'cfo', message: 'Hi' })).status, 'replied');
  assert.equal((await delegation.ask({ from: 'assistant', chain: [], to: 'brain', message: 'Hi' })).status, 'replied');
  assert.equal((await delegation.ask({ from: 'brain', chain: [], to: 'watch', message: 'Hi' })).status, 'replied');
  assert.equal((await delegation.ask({ from: 'watch', chain: [], to: 'brain', message: 'Hi' })).reason, 'not_allowed');
});

test('a busy receiver is refused before any await, with a busy line', async (t) => {
  const { delegation, personas, lines, thread, hub } = await setup(t);
  personas.hold('cfo');
  const cfo = hub.persona('cfo');
  const open = cfo.adapter.send(cfo.agent, 'Keep working');
  const outcome = await delegation.ask({ from: 'assistant', chain: [], to: 'cfo', message: 'Quick one' });
  assert.deepEqual(outcome, { status: 'busy', delegationId: 'd-1', text: 'CFO is busy. Try again in a moment.' });
  assert.deepEqual((await lines('assistant')).map(({ state, text }) => ({ state, text })), [
    { state: 'sent', text: 'Messaged CFO' },
    { state: 'busy', text: 'CFO is busy. Try again in a moment.' },
  ]);
  assert.deepEqual(await thread('cfo'), [{ role: 'user', text: 'Keep working' }]);
  await personas.reply('cfo', 'Done.');
  await open;
});

test('a reply that is not back within the wait is pending, posts when it lands, and reaches the sender on its next own turn', async (t) => {
  const { delegation, personas, lines, logs } = await setup(t, { waitMs: 40 });
  personas.hold('cfo');
  const outcome = await delegation.ask({ from: 'assistant', chain: [], to: 'cfo', message: 'Take your time' });
  assert.deepEqual(outcome, { status: 'pending', delegationId: 'd-1', text: 'CFO is still working. The reply will arrive in this thread.' });
  assert.deepEqual((await lines('assistant')).map((line) => line.state), ['sent']);
  assert.deepEqual(delegation.pendingFor('assistant', null), []);

  await personas.reply('cfo', 'Here it is. Two sentences.');
  await settle();
  const posted = (await lines('assistant')).at(-1);
  assert.deepEqual(posted, {
    role: 'system', kind: 'delegation', state: 'finished', to: 'cfo', delegationId: 'd-1',
    text: 'Here it is. Two sentences.', summary: 'Here it is.',
  });
  const finished = logs.find((entry) => entry.event === 'delegation_finished');
  assert.equal(finished.inline, false);
  const queued = delegation.pendingFor('assistant', null);
  assert.equal(queued.length, 1);
  assert.deepEqual([queued[0].delegationId, queued[0].to, queued[0].reply], ['d-1', 'cfo', 'Here it is. Two sentences.']);

  // A hop from another agent does not drain them.
  const hop = await delegation.toolsFor({ id: 'assistant' }, { text: 'From CFO', prompt: 'From CFO: x', from: 'cfo', chain: ['cfo'], mentions: [] });
  assert.equal('prompt' in hop, false);
  assert.equal(delegation.pendingFor('assistant', null).length, 1);

  // The sender's own turn gets them before its text; rollback puts them back, commit keeps the drain.
  const own = await delegation.toolsFor({ id: 'assistant' }, { text: 'What now?', prompt: 'What now?', from: null, chain: [], mentions: [] });
  assert.equal(own.prompt, 'Replies that arrived since your last turn:\nFrom CFO (d-1): Here it is. Two sentences.\n\nWhat now?');
  assert.deepEqual(delegation.pendingFor('assistant', null), []);
  own.rollback();
  assert.equal(delegation.pendingFor('assistant', null).length, 1);
  own.commit();
  assert.equal(delegation.pendingFor('assistant', null).length, 1, 'rollback already settled this result');
  const again = await delegation.toolsFor({ id: 'assistant' }, { text: 'What now?', prompt: 'What now?', from: null, chain: [], mentions: [] });
  again.commit();
  again.rollback();
  assert.deepEqual(delegation.pendingFor('assistant', null), []);
  const after = await delegation.toolsFor({ id: 'assistant' }, { text: 'Next', prompt: 'Next', from: null, chain: [], mentions: [] });
  assert.equal('prompt' in after, false);
});

test('pending replies belong to the session the ask was made in and are capped', async (t) => {
  const ids = ['d-1', 'd-2', 'd-3', 'd-4', 'd-5', 'd-6', 'd-7'];
  const { delegation, personas } = await setup(t, { waitMs: 20, limits: { delegationPendingReplies: 3 }, ids });
  for (let i = 0; i < 4; i += 1) {
    personas.hold('cfo');
    assert.equal((await delegation.ask({ from: 'assistant', chain: [], to: 'cfo', message: `Ask ${i + 1}` })).status, 'pending');
    await personas.reply('cfo', `Reply ${i + 1}`);
    await settle(60);
  }
  assert.deepEqual(delegation.pendingFor('assistant', null).map((item) => item.reply), ['Reply 2', 'Reply 3', 'Reply 4']);
  // A new thread has a new session id: the old replies are dropped on the read.
  assert.deepEqual(delegation.pendingFor('assistant', 'session-new'), []);
  assert.deepEqual(delegation.pendingFor('assistant', null), []);
  // restorePending keeps the cap too.
  delegation.restorePending('assistant', ids.slice(0, 5).map((id) => ({ delegationId: id, from: 'assistant', to: 'cfo', sessionId: null, reply: id, at: 'x' })));
  assert.deepEqual(delegation.takePending('assistant', null).map((item) => item.reply), ['d-3', 'd-4', 'd-5']);
  assert.deepEqual(delegation.takePending('assistant', null), []);
});

test('a request on the receiver posts one waiting line to the sender, and the reply still lands', async (t) => {
  const { delegation, personas, lines, hub } = await setup(t, { waitMs: 40 });
  personas.hold('cfo');
  const outcome = await delegation.ask({ from: 'assistant', chain: [], to: 'cfo', message: 'Check the ledger' });
  assert.equal(outcome.status, 'pending');
  const requestId = personas.raise('cfo', { kind: 'approval', toolName: 'Bash', input: { command: 'ls' } });
  personas.raise('cfo', { kind: 'approval', toolName: 'Bash', input: { command: 'ls -a' } });
  await settle(40);
  assert.deepEqual((await lines('assistant')).map(({ state, text }) => ({ state, text })), [
    { state: 'sent', text: 'Messaged CFO' },
    { state: 'waiting', text: 'CFO is waiting for you.' },
  ]);
  // The card lives only in the receiver's thread: the sender's thread has no request.
  assert.equal(hub.snapshot().agents.find((a) => a.id === 'assistant').pending, null);
  assert.equal(hub.snapshot().agents.find((a) => a.id === 'cfo').pending?.kind, 'approval');
  assert.equal(requestId.startsWith('req-'), true);
  await personas.reply('cfo', 'Ledger is clean.');
  await settle();
  assert.deepEqual((await lines('assistant')).map((line) => line.state), ['sent', 'waiting', 'finished']);
});

test('a turn that ends without text after an interrupt, an error, or no result is failed; text that arrived is a reply', async (t) => {
  const { delegation, personas, lines, hub } = await setup(t, { waitMs: 40 });
  const cfo = hub.persona('cfo');

  personas.hold('cfo');
  assert.equal((await delegation.ask({ from: 'assistant', chain: [], to: 'cfo', message: 'One' })).status, 'pending');
  await cfo.adapter.interrupt(cfo.agent);
  await settle();
  assert.deepEqual((await lines('assistant')).at(-1), {
    role: 'system', kind: 'delegation', state: 'failed', to: 'cfo', delegationId: 'd-1', text: 'CFO could not answer.', summary: 'CFO could not answer.',
  });

  // An error event within the wait: failed inline.
  personas.hold('cfo');
  const failing = delegation.ask({ from: 'assistant', chain: [], to: 'cfo', message: 'Two' });
  await settle(10);
  personas.fail('cfo', 'invented failure');
  const failed = await failing;
  assert.deepEqual(failed, { status: 'failed', delegationId: 'd-2', reply: 'CFO could not answer.', text: 'CFO could not answer.' });

  // Text that arrived before the failure is the reply.
  personas.hold('cfo');
  const partial = delegation.ask({ from: 'assistant', chain: [], to: 'cfo', message: 'Three' });
  await settle(10);
  await personas.say('cfo', 'Half an answer.');
  personas.fail('cfo', 'invented failure');
  const replied = await partial;
  assert.deepEqual([replied.status, replied.reply], ['replied', 'Half an answer.']);
  assert.deepEqual((await lines('assistant')).at(-1).state, 'finished');

  // The queued entries carry what the line said.
  assert.deepEqual(delegation.pendingFor('assistant', null).map((item) => item.reply), ['CFO could not answer.']);
});

test('the receiver is followed from before the send: a reply emitted inside send() is not missed', async (t) => {
  const dir = path.join(await tempDir(t), 'threads');
  const store = createThreadStore({ dir, limits: { messageTextBytes: 8192, threadCacheMessages: 50, threadCacheBytes: 64 * 1024 } });
  const listeners = new Set();
  const at = () => new Date().toISOString();
  const seenOrder = [];
  const sync = {
    kind: 'claude',
    start: async () => ({}),
    state: () => ({ state: 'idle', pending: null, lastError: null, sessionId: 'session-1', costUsd: null, cwd: null, model: null }),
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    send(agent, text, context) {
      const emit = (type, fields) => {
        for (const fn of [...listeners]) fn({ type, agentId: agent.id, at: at(), ...fields });
      };
      emit('thread.state', { state: 'busy' });
      emit('message', { role: 'user', text, from: context.from });
      emit('message', { role: 'assistant', text: 'Immediate.' });
      emit('usage', { usage: {}, costUsd: 0.01, denials: [] });
      emit('thread.state', { state: 'idle' });
      return Promise.resolve();
    },
    close: async () => {},
  };
  const registry = fakeRegistry([agent('assistant'), agent('cfo', { name: 'CFO' })]);
  const app = await startApp(t, {
    ...status, registry, adapters: { claude: sync }, store,
    delegation: (hub) => createDelegation({
      hub, registry, limits: LIMITS, timeouts: { ...TIMEOUTS, delegationWaitMs: 500 }, randomUUID: () => 'd-1', importSdk: fakeSdk,
      log: (entry) => seenOrder.push(entry.event),
    }),
  });
  const outcome = await app.delegation.ask({ from: 'assistant', chain: [], to: 'cfo', message: 'Now' });
  assert.deepEqual([outcome.status, outcome.reply], ['replied', 'Immediate.']);
  assert.deepEqual(seenOrder, ['delegation_sent', 'delegation_finished']);
});

test('a line the store refuses is logged and returned as a sentence, never thrown', async (t) => {
  const { delegation, personas, logs } = await setup(t);
  // The store validates the sender's id; a bad one rejects notify.
  const outcome = await delegation.ask({ from: 'Not An Id', chain: [], to: 'cfo', message: 'Hi' });
  assert.deepEqual(outcome, { status: 'failed', delegationId: 'd-1', text: 'CFO could not be messaged.' });
  assert.deepEqual(personas.sent, []);
  const logged = logs.find((entry) => entry.event === 'delegation_error');
  assert.equal(logged.agentId, 'Not An Id');
  assert.equal(typeof logged.error, 'string');
});

test('the tool lists only the agents that take messages from the caller, with the rules, and names itself in allowedTools', async (t) => {
  const { delegation, hub } = await setup(t);
  const forAssistant = await delegation.toolsFor({ id: 'assistant' }, { text: 'x', prompt: 'x', from: null, chain: [], mentions: [] });
  assert.deepEqual(forAssistant.allowedTools, [ASK_TOOL]);
  assert.equal(ASK_TOOL, 'mcp__agents__ask');
  const server = forAssistant.mcpServers.agents;
  assert.equal(server.name, 'agents');
  const [ask] = server.instance.tools;
  assert.equal(ask.name, 'ask');
  const described = ask.description.split('\n');
  assert.equal(described[0], 'Ask another agent in this system and get its reply. The agents:');
  assert.deepEqual(described.slice(1, -1), [
    '- cfo · CFO · Money · Drift and decisions.',
    '- brain · Second brain · Role · Invented.',
    '- ops · Ops · Role · Invented.',
    '- dev · Dev · Role · Invented. (not available now)',
  ]);
  assert.match(described.at(-1), /^Agents the user mentions with @ .* then stop\.$/);
  assert.equal(ask.description.includes('assistant ·'), false, 'never the caller');
  assert.equal(ask.description.includes('catchup'), false, 'no project folders');
  assert.ok('to' in ask.schema && 'message' in ask.schema);

  const forCfo = await delegation.toolsFor({ id: 'cfo' }, { text: 'x', prompt: 'x', from: null, chain: [], mentions: [] });
  const cfoLines = forCfo.mcpServers.agents.instance.tools[0].description.split('\n').slice(1, -1);
  assert.deepEqual(cfoLines, [
    '- assistant · Assistant · Role · Invented.',
    '- watch · Watch · Role · Invented.',
    '- ops · Ops · Role · Invented.',
    '- dev · Dev · Role · Invented. (not available now)',
  ]);
  assert.equal(hub.snapshot().agents.find((a) => a.id === 'dev').state, 'unavailable');
});

test('the tool handler takes the sender from the turn, never from its arguments, and answers with sentences', async (t) => {
  const { delegation, personas, thread, lines } = await setup(t, { limits: { delegationMessageChars: 20 } });
  const tools = await delegation.toolsFor({ id: 'assistant' }, { text: 'x', prompt: 'x', from: null, chain: [], mentions: [] });
  const [ask] = tools.mcpServers.agents.instance.tools;

  const replied = await ask.handler({ to: 'cfo', message: 'Short question', from: 'brain', chain: ['brain'] });
  assert.deepEqual(replied, { content: [{ type: 'text', text: 'Reply: Short question' }] });
  assert.deepEqual((await thread('cfo'))[0], { role: 'user', text: 'Short question', from: 'assistant' });
  assert.deepEqual(personas.sent[0].context.chain, ['assistant']);

  assert.deepEqual(await ask.handler({ to: 'cfo', message: '   ' }), { content: [{ type: 'text', text: 'The message is empty.' }] });
  assert.deepEqual(await ask.handler({ to: 'cfo', message: 'x'.repeat(21) }), {
    content: [{ type: 'text', text: 'The message is too long: 20 characters at most.' }],
  });
  assert.deepEqual(await ask.handler({ to: 'catchup', message: 'Hi' }), { content: [{ type: 'text', text: 'Catchup does not take messages.' }] });
  assert.deepEqual(await ask.handler({ to: 7, message: 'Hi' }), { content: [{ type: 'text', text: 'No agent is named that.' }] });
  assert.equal((await lines('assistant')).length, 4, 'sent, finished, and two refusals; the empty and long messages post nothing');
});

test('a long reply is cut to the reply cap in the line, the tool answer, and the queued entry', async (t) => {
  const { delegation, personas, lines } = await setup(t, { waitMs: 40, limits: { delegationReplyChars: 12 } });
  personas.hold('cfo');
  const inline = delegation.ask({ from: 'assistant', chain: [], to: 'cfo', message: 'Long one' });
  await settle(10);
  await personas.reply('cfo', 'First part. Second part.');
  const outcome = await inline;
  assert.equal(outcome.reply, 'First part. ');
  assert.deepEqual((await lines('assistant')).at(-1).text, 'First part. ');
  assert.deepEqual((await lines('assistant')).at(-1).summary, 'First part.');

  personas.hold('cfo');
  assert.equal((await delegation.ask({ from: 'assistant', chain: [], to: 'cfo', message: 'Another' })).status, 'pending');
  await personas.reply('cfo', 'A very long late reply indeed.');
  await settle();
  assert.deepEqual(delegation.pendingFor('assistant', null).map((item) => item.reply), ['A very long ']);
});

test('the prompt names mentioned agents after the text, with pending replies before it', async (t) => {
  const { delegation } = await setup(t);
  const plain = await delegation.toolsFor({ id: 'assistant' }, { text: 'Ask @CFO and @Second brain', prompt: 'Ask @CFO and @Second brain', from: null, chain: [], mentions: ['cfo', 'brain', 'nobody'] });
  assert.equal(plain.prompt, 'Ask @CFO and @Second brain\n\nAgents mentioned: CFO (id `cfo`), Second brain (id `brain`), nobody (id `nobody`)');
  delegation.restorePending('assistant', [{ delegationId: 'd-9', from: 'assistant', to: 'cfo', sessionId: null, reply: 'Late.', at: 'x' }]);
  const both = await delegation.toolsFor({ id: 'assistant' }, { text: 'Next', prompt: 'Next', from: null, chain: [], mentions: ['cfo'] });
  assert.equal(both.prompt, 'Replies that arrived since your last turn:\nFrom CFO (d-9): Late.\n\nNext\n\nAgents mentioned: CFO (id `cfo`)');
  // A hop keeps the daemon's prefixed prompt as the base.
  const hop = await delegation.toolsFor({ id: 'cfo' }, { text: 'Hi', prompt: 'From Assistant, an agent in this system (not the user): Hi', from: 'assistant', chain: ['assistant'], mentions: ['watch'] });
  assert.equal(hop.prompt, 'From Assistant, an agent in this system (not the user): Hi\n\nAgents mentioned: Watch (id `watch`)');
});

test('through the routes: the user sends to A, A asks B, both threads show the exchange', async (t) => {
  const { app, personas, thread, lines } = await setup(t, {
    seed: { assistant: { delegate: { to: 'cfo', text: 'Is he over on equities?' } } },
  });
  const response = await request(app, 'POST', '/api/agents/assistant/send', {
    headers: { origin: app.origin, 'content-type': 'application/json' }, body: JSON.stringify({ text: 'Ask CFO about equities' }),
  });
  assert.equal(response.status, 202);
  await settle(300);
  assert.deepEqual(await thread('assistant'), [
    { role: 'user', text: 'Ask CFO about equities' },
    { role: 'system', kind: 'delegation', state: 'sent', to: 'cfo', delegationId: 'd-1', text: 'Messaged CFO', summary: 'Messaged CFO' },
    { role: 'system', kind: 'delegation', state: 'finished', to: 'cfo', delegationId: 'd-1', text: 'Reply: Is he over on equities?', summary: 'Reply: Is he over on equities?' },
    { role: 'assistant', text: 'Reply: Is he over on equities?' },
  ]);
  assert.deepEqual(await thread('cfo'), [
    { role: 'user', text: 'Is he over on equities?', from: 'assistant' },
    { role: 'assistant', text: 'Reply: Is he over on equities?' },
  ]);
  // The row preview is the real last message, never a delegation line.
  const views = app.hub.snapshot().agents;
  assert.equal(views.find((a) => a.id === 'assistant').lastMessage.text, 'Reply: Is he over on equities?');
  assert.equal(views.find((a) => a.id === 'cfo').lastMessage.text, 'Reply: Is he over on equities?');
  assert.equal((await lines('cfo')).length, 0);
  assert.equal(personas.sent.length, 2);
});
