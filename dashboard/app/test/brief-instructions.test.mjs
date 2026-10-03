import assert from 'node:assert/strict';
import { cp, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createBriefInstructions, instructionsMessage } from '../lib/brief-instructions.mjs';
import { LIMITS } from '../lib/config.mjs';
import { RuntimeError } from '../lib/runtime/adapter.mjs';
import { fakeRegistry, fakeSettings, request, startApp, tempDir } from './support/harness.mjs';

const FIXTURE = fileURLToPath(new URL('./fixtures/brief-instructions/curator.md', import.meta.url));
const READ = '/api/brief/instructions';
const PROPOSE = '/api/brief/instructions/propose';

const status = {
  focus: { checkHealth: async () => ({ available: true }) },
  brief: { latestMetadata: async () => ({ state: 'empty' }) },
};

const BLOCKS = [
  { type: 'h', text: 'Invented brief rules' },
  { type: 'p', text: 'What the invented brief says each morning. Written as rules the curator applies, not as topics.' },
  { type: 'h', text: 'The memo' },
  { type: 'list', ordered: true, items: ['Nothing he already knows.', 'One item per story, read cold.'] },
  { type: 'h', text: 'Sections' },
  { type: 'list', ordered: false, items: ['Needs you', 'Today'] },
];

function agent(id, extra = {}) {
  return Object.freeze({
    id, name: id.toUpperCase(), role: 'Role', description: 'Invented.', group: 'personal', kind: 'persona',
    cwd: '/invented', provider: 'claude', jobs: [], ...extra,
  });
}

// A Claude adapter stand-in that records sends. `behavior.send` is a
// RuntimeError code to refuse with; otherwise the turn stays open.
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
      adapter.calls.push([agentValue.id, text]);
      if (adapter.behavior.send) return Promise.reject(new RuntimeError(adapter.behavior.send));
      return adapter.turn;
    },
  };
  return adapter;
}

// The app with the rules file a fresh copy of the fixture (unless `file` is
// false), Settings naming `target` as the brief's agent, and `agents` in
// the registry (the assistant on the fake Claude adapter by default).
async function startBrief(t, { file = true, target = 'assistant', agents = [agent('assistant')], briefInstructions } = {}) {
  const instructionsFile = path.join(await tempDir(t), 'curator.md');
  if (file) await cp(FIXTURE, instructionsFile);
  const adapter = fakeAdapter();
  const app = await startApp(t, {
    ...status,
    env: { DASHBOARD_BRIEF_INSTRUCTIONS: instructionsFile },
    registry: fakeRegistry(agents),
    adapters: { claude: adapter },
    settings: fakeSettings({ brief: { agent: target } }),
    briefInstructions,
  });
  t.after(() => adapter.release());
  return { ...app, adapter, instructionsFile };
}

function post(app, body, headers = {}, pathname = PROPOSE) {
  return request(app, 'POST', pathname, {
    headers: { origin: app.origin, 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

test('the reader names the brief file and reads it as prose', async (t) => {
  const file = path.join(await tempDir(t), 'curator.md');
  await cp(FIXTURE, file);
  const mtime = new Date('2026-10-01T12:00:00Z');
  await utimes(file, mtime, mtime);
  const result = await createBriefInstructions({ file, limits: LIMITS }).read();
  assert.deepEqual(result, { path: 'daily-brief/curator.md', updated: '2026-10-01T12:00:00.000Z', problem: null, blocks: BLOCKS });
  assert.ok(Object.isFrozen(result));
});

test('a missing or oversized brief file is empty blocks and one sentence naming the brief', async (t) => {
  const file = path.join(await tempDir(t), 'curator.md');
  const logged = [];
  const instructions = createBriefInstructions({ file, limits: LIMITS, log: (entry) => logged.push(entry) });
  assert.deepEqual(await instructions.read(), {
    path: 'daily-brief/curator.md', updated: null, problem: 'The brief instructions file is missing.', blocks: [],
  });
  await writeFile(file, 'x'.repeat(LIMITS.briefInstructionsBytes + 1));
  const large = await instructions.read();
  assert.deepEqual([large.problem, large.blocks], ['The brief instructions file is larger than 64 KiB.', []]);
  assert.deepEqual(logged, []);
});

test('GET /api/brief/instructions returns the path, the file time, and the prose', async (t) => {
  const app = await startBrief(t);
  const response = await request(app, 'GET', READ);
  assert.equal(response.status, 200);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.json.path, 'daily-brief/curator.md');
  assert.equal(response.json.problem, null);
  assert.ok(!Number.isNaN(Date.parse(response.json.updated)));
  assert.deepEqual(response.json.blocks, BLOCKS);
});

test('GET /api/brief/instructions with no file is 200 with no blocks and one sentence', async (t) => {
  const app = await startBrief(t, { file: false });
  const response = await request(app, 'GET', READ);
  assert.deepEqual([response.status, response.json.blocks, response.json.problem],
    [200, [], 'The brief instructions file is missing.']);
});

test('propose sends the change to the agent Settings names and answers 202 with its id', async (t) => {
  const app = await startBrief(t);
  const response = await post(app, { text: 'Leave the weather out.' });
  assert.deepEqual([response.status, response.json], [202, { ok: true, agentId: 'assistant' }]);
  assert.deepEqual(app.adapter.calls, [[
    'assistant',
    "Change the brief's instructions.\n\n" +
      'The rules the brief follows are in daily-brief/curator.md; the run reads them every morning.\n\n' +
      'What I want changed:\nLeave the weather out.\n\n' +
      'Ask me what you need, then edit the file under its own rules and tell me\n' +
      'what changed.',
  ]]);
  assert.equal(app.adapter.calls[0][1], instructionsMessage('Leave the weather out.'));
});

test('propose follows the setting: another agent named there receives the change', async (t) => {
  const app = await startBrief(t, { target: 'cfo', agents: [agent('assistant'), agent('cfo')] });
  const response = await post(app, { text: 'Leave the weather out.' });
  assert.deepEqual([response.status, response.json], [202, { ok: true, agentId: 'cfo' }]);
  assert.deepEqual(app.adapter.calls.map(([id]) => id), ['cfo']);
});

test('propose validates the body, the text, and its size', async (t) => {
  const app = await startBrief(t);
  for (const body of [[], 'x', {}, { text: 7 }, { text: null }, { text: 'x', extra: 1 }, { change: 'x' }]) {
    const response = await post(app, body);
    assert.deepEqual([response.status, response.json], [400, { error: 'invalid_body' }], JSON.stringify(body));
  }
  for (const text of ['', '   \n ']) {
    const response = await post(app, { text });
    assert.deepEqual([response.status, response.json], [400, { error: 'invalid_text' }], JSON.stringify(text));
  }
  const limit = app.config.limits.sendTextBytes;
  const over = await post(app, { text: 'a'.repeat(limit + 1) });
  assert.deepEqual([over.status, over.json], [413, { error: 'payload_too_large' }]);
  assert.deepEqual(app.adapter.calls, []);
  assert.equal((await post(app, { text: 'a'.repeat(limit) })).status, 202);
});

test('propose with no agent receiving the brief is 409 no_brief_agent', async (t) => {
  const app = await startBrief(t, { target: null });
  const response = await post(app, { text: 'Leave the weather out.' });
  assert.deepEqual([response.status, response.json], [409, { error: 'no_brief_agent' }]);
  assert.deepEqual(app.adapter.calls, []);
});

test('propose refuses without a started persona under that id', async (t) => {
  for (const [options, expected] of [
    [{ agents: [agent('cfo')] }, [404, 'no_such_agent']],
    [{ agents: [agent('assistant', { kind: 'project' })] }, [404, 'no_such_agent']],
    [{ agents: [agent('assistant', { provider: 'codex' })] }, [409, 'persona_unavailable']],
  ]) {
    const app = await startBrief(t, options);
    const response = await post(app, { text: 'Leave the weather out.' });
    assert.deepEqual([response.status, response.json], [expected[0], { error: expected[1] }], JSON.stringify(options));
    assert.deepEqual(app.adapter.calls, []);
  }
});

test('propose maps adapter refusals as a send does', async (t) => {
  const app = await startBrief(t);
  for (const [code, expected] of [['busy', 409], ['unavailable', 503], ['shutting_down', 503], ['invalid_text', 400]]) {
    app.adapter.behavior.send = code;
    const response = await post(app, { text: 'Leave the weather out.' });
    assert.deepEqual([response.status, response.json], [expected, { error: code }], code);
  }
});

test('propose after closeStreams answers 503 without reaching the adapter', async (t) => {
  const app = await startBrief(t);
  app.handler.closeStreams();
  const response = await post(app, { text: 'Leave the weather out.' });
  assert.deepEqual([response.status, response.json], [503, { error: 'shutting_down' }]);
  assert.deepEqual(app.adapter.calls, []);
});

test('the brief instructions routes need their methods, JSON, and an exact Origin', async (t) => {
  const app = await startBrief(t);
  const body = { text: 'Leave the weather out.' };
  assert.equal((await post(app, body, { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await post(app, body, { origin: 'http://evil.example' })).status, 403);
  const get = await request(app, 'GET', PROPOSE);
  assert.deepEqual([get.status, get.headers.allow], [405, 'POST']);
  const postRead = await post(app, body, {}, READ);
  assert.deepEqual([postRead.status, postRead.headers.allow], [405, 'GET']);
  assert.deepEqual(app.adapter.calls, []);
});

test('without the brief instructions reader both routes are 404', async (t) => {
  const app = await startBrief(t, { briefInstructions: null });
  const read = await request(app, 'GET', READ);
  assert.deepEqual([read.status, read.json], [404, { error: 'not_found' }]);
  const propose = await post(app, { text: 'Leave the weather out.' });
  assert.deepEqual([propose.status, propose.json], [404, { error: 'not_found' }]);
});
