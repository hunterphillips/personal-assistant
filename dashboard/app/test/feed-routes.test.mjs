import assert from 'node:assert/strict';
import { cp } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { discussMessage, instructionsMessage } from '../lib/feed-routes.mjs';
import { RuntimeError } from '../lib/runtime/adapter.mjs';
import { fakeRegistry, request, startApp, tempDir } from './support/harness.mjs';

const FIXTURE_FEED = fileURLToPath(new URL('./fixtures/feed/', import.meta.url));
const FIXTURE_INSTRUCTIONS = fileURLToPath(new URL('./fixtures/feed-instructions/relevance.md', import.meta.url));

const status = {
  focus: { checkHealth: async () => ({ available: true }) },
  brief: { latestMetadata: async () => ({ state: 'empty' }) },
};

function agent(id, extra = {}) {
  return Object.freeze({
    id, name: id.toUpperCase(), role: 'Role', description: 'Invented.', group: 'personal', kind: 'persona',
    cwd: '/invented', provider: 'claude', routines: [], ...extra,
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

// The app over a fresh copy of the fixture store. `persona` sets the watch
// agent's provider (claude runs on the fake adapter; codex has no adapter,
// so the persona is listed but never started), or false to leave it out.
// The criteria file is a fresh copy of the fixture unless `instructions` is
// false.
async function startFeed(t, { persona = 'claude', kind = 'persona', feed, store = true, instructions = true } = {}) {
  const root = await tempDir(t);
  const dir = path.join(root, 'feed');
  if (store) await cp(FIXTURE_FEED, dir, { recursive: true });
  const instructionsFile = path.join(root, 'relevance.md');
  if (instructions) await cp(FIXTURE_INSTRUCTIONS, instructionsFile);
  const agents = persona ? [agent('watch', { provider: persona, kind })] : [agent('cfo')];
  const adapter = fakeAdapter();
  const app = await startApp(t, {
    ...status,
    env: { DASHBOARD_FEED_DIR: dir, DASHBOARD_FEED_INSTRUCTIONS: instructionsFile },
    registry: fakeRegistry(agents),
    adapters: { claude: adapter },
    feed,
  });
  t.after(() => adapter.release());
  return { ...app, adapter, dir, instructionsFile };
}

function post(app, body, headers = {}, pathname = '/api/feed/discuss') {
  return request(app, 'POST', pathname, {
    headers: { origin: app.origin, 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

test('GET /api/feed returns the runs newest first and the persona id', async (t) => {
  const app = await startFeed(t);
  const response = await request(app, 'GET', '/api/feed');
  assert.equal(response.status, 200);
  assert.equal(response.json.agentId, 'watch');
  assert.deepEqual(response.json.problems, []);
  assert.deepEqual(response.json.runs.map((run) => run.id), ['2026-09-28-watch', '2026-09-21-watch']);
  assert.equal(response.json.runs[0].items.length, 8);
  assert.equal(response.headers['cache-control'], 'no-store');
});

test('GET /api/feed with no store is 200 with the problem and no runs', async (t) => {
  const app = await startFeed(t, { store: false });
  const response = await request(app, 'GET', '/api/feed');
  assert.deepEqual([response.status, response.json.runs, response.json.problems],
    [200, [], ['The feed directory is missing.']]);
});

test('discuss sends the item to the watch persona and answers 202 with its id', async (t) => {
  const app = await startFeed(t);
  const response = await post(app, { id: 'watch/2026-09-21/2' });
  assert.deepEqual([response.status, response.json], [202, { ok: true, agentId: 'watch' }]);
  assert.deepEqual(app.adapter.calls, [[
    'watch',
    'Discuss this feed item with me.\n\n' +
      'Hand-bound notebooks, a how-to\nInvented Letters: https://example.com/notebooks\n\n' +
      'A step-by-step on binding a notebook with a needle and waxed thread.\n\n' +
      'Read the link, then tell me what it says in a short paragraph and which of the watch criteria it passed. ' +
      'Then wait for my question.',
  ]]);
  assert.equal(app.adapter.calls[0][1], discussMessage({
    title: 'Hand-bound notebooks, a how-to', source: 'Invented Letters', url: 'https://example.com/notebooks',
    summary: 'A step-by-step on binding a notebook with a needle and waxed thread.',
  }));
});

test('discuss of an id the store does not have is 404 no_such_item', async (t) => {
  const app = await startFeed(t);
  const response = await post(app, { id: 'watch/2026-09-21/9' });
  assert.deepEqual([response.status, response.json], [404, { error: 'no_such_item' }]);
  assert.deepEqual(app.adapter.calls, []);
});

test('discuss validates the body shape', async (t) => {
  const app = await startFeed(t);
  const bodies = [[], 'x', {}, { id: '' }, { id: 7 }, { id: null }, { id: 'a'.repeat(201) }, { id: 'x', extra: 1 }, { item: 'x' }];
  for (const body of bodies) {
    const response = await post(app, body);
    assert.deepEqual([response.status, response.json], [400, { error: 'invalid_body' }], JSON.stringify(body));
  }
  // A 200-character id is well formed; it just names nothing.
  assert.equal((await post(app, { id: 'a'.repeat(200) })).status, 404);
  assert.deepEqual(app.adapter.calls, []);
});

test('discuss maps adapter refusals as send does', async (t) => {
  const app = await startFeed(t);
  for (const [code, expected] of [['busy', 409], ['unavailable', 503], ['shutting_down', 503], ['invalid_text', 400]]) {
    app.adapter.behavior.send = code;
    const response = await post(app, { id: 'watch/2026-09-28/1' });
    assert.deepEqual([response.status, response.json], [expected, { error: code }], code);
  }
});

test('a watch persona that is not started is 409 persona_unavailable', async (t) => {
  const app = await startFeed(t, { persona: 'codex' });
  const response = await post(app, { id: 'watch/2026-09-28/1' });
  assert.deepEqual([response.status, response.json], [409, { error: 'persona_unavailable' }]);
  assert.deepEqual(app.adapter.calls, []);
});

test('no watch persona in the registry is 404 no_such_agent', async (t) => {
  const app = await startFeed(t, { persona: false });
  const response = await post(app, { id: 'watch/2026-09-28/1' });
  assert.deepEqual([response.status, response.json], [404, { error: 'no_such_agent' }]);
  assert.deepEqual(app.adapter.calls, []);
});

test('a watch entry that is not a persona is 404 no_such_agent', async (t) => {
  const app = await startFeed(t, { kind: 'project' });
  const response = await post(app, { id: 'watch/2026-09-28/1' });
  assert.deepEqual([response.status, response.json], [404, { error: 'no_such_agent' }]);
  assert.deepEqual(app.adapter.calls, []);
});

test('discuss needs JSON, POST, and an exact Origin', async (t) => {
  const app = await startFeed(t);
  const body = { id: 'watch/2026-09-28/1' };
  assert.equal((await post(app, body, { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await post(app, body, { origin: 'http://evil.example' })).status, 403);
  const get = await request(app, 'GET', '/api/feed/discuss');
  assert.deepEqual([get.status, get.headers.allow], [405, 'POST']);
  assert.equal((await post(app, body, {}, '/api/feed')).status, 405);
  assert.deepEqual(app.adapter.calls, []);
});

test('discuss after closeStreams answers 503 without reaching the adapter', async (t) => {
  const app = await startFeed(t);
  app.handler.closeStreams();
  const response = await post(app, { id: 'watch/2026-09-28/1' });
  assert.deepEqual([response.status, response.json], [503, { error: 'shutting_down' }]);
  assert.deepEqual(app.adapter.calls, []);
});

test('without feed every feed route is 404', async (t) => {
  const app = await startFeed(t, { feed: null });
  const read = await request(app, 'GET', '/api/feed');
  assert.deepEqual([read.status, read.json], [404, { error: 'not_found' }]);
  const discuss = await post(app, { id: 'watch/2026-09-28/1' });
  assert.deepEqual([discuss.status, discuss.json], [404, { error: 'not_found' }]);
  const instructions = await request(app, 'GET', '/api/feed/instructions');
  assert.deepEqual([instructions.status, instructions.json], [404, { error: 'not_found' }]);
  const propose = await post(app, { text: 'Drop AINews.' }, {}, PROPOSE);
  assert.deepEqual([propose.status, propose.json], [404, { error: 'not_found' }]);
  assert.deepEqual(app.adapter.calls, []);
});

test('/feed serves the shell and /feed/ redirects to it', async (t) => {
  const app = await startFeed(t);
  const shell = await request(app, 'GET', '/feed');
  assert.equal(shell.status, 200);
  assert.match(shell.headers['content-type'], /text\/html/);
  const slash = await request(app, 'GET', '/feed/');
  assert.deepEqual([slash.status, slash.headers.location], [308, '/feed']);
});

const PROPOSE = '/api/feed/instructions/propose';

test('GET /api/feed/instructions returns the path, the file time, and the prose', async (t) => {
  const app = await startFeed(t);
  const response = await request(app, 'GET', '/api/feed/instructions');
  assert.equal(response.status, 200);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.json.path, 'daily-brief/watch/relevance.md');
  assert.equal(response.json.problem, null);
  assert.ok(!Number.isNaN(Date.parse(response.json.updated)));
  assert.deepEqual(response.json.blocks.map((block) => block.type), ['h', 'p', 'h', 'list', 'h', 'list']);
  assert.deepEqual(response.json.blocks[3], { type: 'list', items: ['Invented Gazette', 'Invented Letters, weekly'] });
});

test('GET /api/feed/instructions with no file is 200 with no blocks and one sentence', async (t) => {
  const app = await startFeed(t, { instructions: false });
  const response = await request(app, 'GET', '/api/feed/instructions');
  assert.deepEqual([response.status, response.json.blocks, response.json.problem],
    [200, [], 'The feed instructions file is missing.']);
});

test('propose sends the change to the watch persona and answers 202 with its id', async (t) => {
  const app = await startFeed(t);
  const response = await post(app, { text: 'Drop AINews; it repeats Latent Space.' }, {}, PROPOSE);
  assert.deepEqual([response.status, response.json], [202, { ok: true, agentId: 'watch' }]);
  assert.deepEqual(app.adapter.calls, [[
    'watch',
    "Change the feed's criteria.\n\n" +
      'The criteria are in daily-brief/watch/relevance.md, which you read every run.\n\n' +
      'What I want changed:\nDrop AINews; it repeats Latent Space.\n\n' +
      'Ask me what you need, then edit the file under its own rules, keep the\n' +
      'sender list in daily-brief/watch/contribute in step with the sources table,\n' +
      'and tell me what changed.',
  ]]);
  assert.equal(app.adapter.calls[0][1], instructionsMessage('Drop AINews; it repeats Latent Space.'));
});

test('propose validates the body, the text, and its size', async (t) => {
  const app = await startFeed(t);
  for (const body of [[], 'x', {}, { text: 7 }, { text: null }, { text: 'x', extra: 1 }, { change: 'x' }]) {
    const response = await post(app, body, {}, PROPOSE);
    assert.deepEqual([response.status, response.json], [400, { error: 'invalid_body' }], JSON.stringify(body));
  }
  for (const text of ['', '   \n ']) {
    const response = await post(app, { text }, {}, PROPOSE);
    assert.deepEqual([response.status, response.json], [400, { error: 'invalid_text' }], JSON.stringify(text));
  }
  const limit = app.config.limits.sendTextBytes;
  const over = await post(app, { text: 'a'.repeat(limit + 1) }, {}, PROPOSE);
  assert.deepEqual([over.status, over.json], [413, { error: 'payload_too_large' }]);
  assert.deepEqual(app.adapter.calls, []);
  assert.equal((await post(app, { text: 'a'.repeat(limit) }, {}, PROPOSE)).status, 202);
});

test('propose refuses without a started watch persona', async (t) => {
  for (const [options, expected] of [
    [{ persona: false }, [404, 'no_such_agent']],
    [{ kind: 'project' }, [404, 'no_such_agent']],
    [{ persona: 'codex' }, [409, 'persona_unavailable']],
  ]) {
    const app = await startFeed(t, options);
    const response = await post(app, { text: 'Drop AINews.' }, {}, PROPOSE);
    assert.deepEqual([response.status, response.json], [expected[0], { error: expected[1] }], JSON.stringify(options));
    assert.deepEqual(app.adapter.calls, []);
  }
});

test('propose maps adapter refusals as Discuss does', async (t) => {
  const app = await startFeed(t);
  for (const [code, expected] of [['busy', 409], ['unavailable', 503], ['shutting_down', 503], ['invalid_text', 400]]) {
    app.adapter.behavior.send = code;
    const response = await post(app, { text: 'Drop AINews.' }, {}, PROPOSE);
    assert.deepEqual([response.status, response.json], [expected, { error: code }], code);
  }
});

test('propose after closeStreams answers 503 without reaching the adapter', async (t) => {
  const app = await startFeed(t);
  app.handler.closeStreams();
  const response = await post(app, { text: 'Drop AINews.' }, {}, PROPOSE);
  assert.deepEqual([response.status, response.json], [503, { error: 'shutting_down' }]);
  assert.deepEqual(app.adapter.calls, []);
});

test('the instructions routes need their methods, JSON, and an exact Origin', async (t) => {
  const app = await startFeed(t);
  const body = { text: 'Drop AINews.' };
  assert.equal((await post(app, body, { 'content-type': 'text/plain' }, PROPOSE)).status, 415);
  assert.equal((await post(app, body, { origin: 'http://evil.example' }, PROPOSE)).status, 403);
  const get = await request(app, 'GET', PROPOSE);
  assert.deepEqual([get.status, get.headers.allow], [405, 'POST']);
  const postRead = await post(app, body, {}, '/api/feed/instructions');
  assert.deepEqual([postRead.status, postRead.headers.allow], [405, 'GET']);
  assert.deepEqual(app.adapter.calls, []);
});
