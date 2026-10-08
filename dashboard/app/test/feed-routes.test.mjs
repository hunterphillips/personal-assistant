import assert from 'node:assert/strict';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { LIMITS } from '../lib/config.mjs';
import { SUGGEST_ROUTINE, discussMessage, suggestContext, suggestRoutine } from '../lib/feed-routes.mjs';
import { createRoutines } from '../lib/routines.mjs';
import { RuntimeError } from '../lib/runtime/adapter.mjs';
import { createScheduler } from '../lib/scheduler.mjs';
import { fakeRegistry, request, startApp, tempDir } from './support/harness.mjs';

// Old-shape runs (<date>-watch.json, one `source` string per item).
const FIXTURE_FEED = fileURLToPath(new URL('./fixtures/feed/', import.meta.url));
const AT = '2026-10-08T12:00:00.000Z';

const status = {
  focus: { checkHealth: async () => ({ available: true }) },
  brief: { latestMetadata: async () => ({ state: 'empty' }) },
};

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
    options: [],
    behavior: {},
    turn: new Promise((resolve) => { release = resolve; }),
    release: () => release(),
    start: async () => ({}),
    state: () => ({ state: 'idle', pending: null, lastError: null, sessionId: null, costUsd: null }),
    subscribe: () => () => {},
    send(agentValue, text, options = {}) {
      adapter.calls.push([agentValue.id, text]);
      adapter.options.push(options);
      if (adapter.behavior.send) return Promise.reject(new RuntimeError(adapter.behavior.send));
      return adapter.turn;
    },
  };
  return adapter;
}

// The app over a feed `news` (produced by scout) holding a fresh copy of
// the fixture runs. `persona` sets scout's provider (claude runs on the
// fake adapter; codex has no adapter, so it is listed but never started),
// or false to leave it out.
// `suggest` adds a routines store and a scheduler over the hub: true for
// the real scheduler on the fake adapter, or a scheduler stand-in.
async function startFeeds(t, { persona = 'claude', kind = 'persona', feeds, suggest = false } = {}) {
  const root = await tempDir(t);
  const feedsDir = path.join(root, 'feeds');
  const sourcesDir = path.join(root, 'sources');
  await mkdir(path.join(feedsDir, 'news'), { recursive: true });
  await cp(FIXTURE_FEED, path.join(feedsDir, 'news', 'items'), { recursive: true });
  await writeFile(path.join(feedsDir, 'news', 'feed.json'), JSON.stringify({
    version: 1, id: 'news', name: 'News', producer: 'scout', sources: [], active: true, created: AT, updated: AT,
  }));
  const agents = persona ? [agent('scout', { provider: persona, kind })] : [agent('cfo')];
  const adapter = fakeAdapter();
  let routines = null;
  if (suggest) {
    routines = createRoutines({ dir: path.join(root, 'routines'), limits: LIMITS });
    await routines.load();
  }
  let uuid = 0;
  const app = await startApp(t, {
    ...status,
    env: { DASHBOARD_FEEDS_DIR: feedsDir, DASHBOARD_SOURCES_DIR: sourcesDir },
    registry: fakeRegistry(agents),
    adapters: { claude: adapter },
    feeds,
    routines,
    scheduler: suggest === true ? (hub) => createScheduler({ routines, hub, randomUUID: () => `run-${++uuid}` }) : suggest || null,
  });
  t.after(() => adapter.release());
  return { ...app, adapter, feedsDir, sourcesDir };
}

function send(app, method, pathname, body, headers = {}) {
  return request(app, method, pathname, {
    headers: { origin: app.origin, 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}
const post = (app, pathname, body, headers) => send(app, 'POST', pathname, body, headers);
const put = (app, pathname, body, headers) => send(app, 'PUT', pathname, body, headers);

test('GET /api/feeds lists the feeds; GET /api/feeds/:id answers the read', async (t) => {
  const app = await startFeeds(t);
  const listed = await request(app, 'GET', '/api/feeds');
  assert.equal(listed.status, 200);
  assert.equal(listed.headers['cache-control'], 'no-store');
  assert.deepEqual(listed.json.problems, []);
  assert.deepEqual(listed.json.feeds.map((feed) => [feed.id, feed.name, feed.producer]), [['news', 'News', 'scout']]);
  const read = await request(app, 'GET', '/api/feeds/news');
  assert.equal(read.status, 200);
  assert.equal(read.json.feed.id, 'news');
  assert.deepEqual(read.json.runs.map((run) => run.id), ['2026-09-28-watch', '2026-09-21-watch']);
  assert.deepEqual(read.json.runs[0].items[0].sources, ['Invented Gazette']);
  const missing = await request(app, 'GET', '/api/feeds/other');
  assert.deepEqual([missing.status, missing.json], [404, { error: 'no_such_feed' }]);
  const unmatched = await request(app, 'GET', '/api/feeds/Not_An_Id');
  assert.deepEqual([unmatched.status, unmatched.json], [404, { error: 'not_found' }]);
});

test('the old feed routes are gone and /feed still serves the shell', async (t) => {
  const app = await startFeeds(t);
  for (const pathname of ['/api/feed', '/api/feed/discuss', '/api/feed/instructions', '/api/feed/instructions/propose']) {
    assert.equal((await request(app, 'GET', pathname)).status, 404, pathname);
  }
  const shell = await request(app, 'GET', '/feed');
  assert.equal(shell.status, 200);
  assert.match(shell.headers['content-type'], /text\/html/);
  const slash = await request(app, 'GET', '/feed/');
  assert.deepEqual([slash.status, slash.headers.location], [308, '/feed']);
});

test('POST /api/feeds creates a feed with the default sources; PUT changes it', async (t) => {
  const app = await startFeeds(t);
  await post(app, '/api/sources', { name: 'Priorities', kind: 'file', path: '/invented/priorities.md', default: true });
  await post(app, '/api/sources', { name: 'Latent Space', kind: 'rss', url: 'https://www.latent.space/feed' });
  const created = await post(app, '/api/feeds', { name: 'Work', note: 'Only what changes my week.\n' });
  assert.equal(created.status, 201);
  assert.deepEqual([created.json.ok, created.json.feed.id, created.json.feed.producer, created.json.feed.sources],
    [true, 'work', 'scout', ['priorities']]);
  assert.equal(await readFile(path.join(app.feedsDir, 'work', 'note.md'), 'utf8'), 'Only what changes my week.\n');
  assert.deepEqual((await request(app, 'GET', '/api/feeds')).json.feeds.map((feed) => feed.id).sort(), ['news', 'work']);

  const updated = await put(app, '/api/feeds/work', { sources: ['latent-space', 'priorities'], active: false });
  assert.equal(updated.status, 200);
  assert.deepEqual([updated.json.feed.sources, updated.json.feed.active], [['latent-space', 'priorities'], false]);
  const renamed = await put(app, '/api/feeds/work', { name: 'Work week' });
  assert.equal(renamed.json.feed.name, 'Work week');

  for (const [body, expected] of [
    [{ sources: ['nope'] }, [400, { error: 'unknown_source', sources: ['nope'] }]],
    [{}, [400, { error: 'invalid_body', detail: 'the body names no field' }]],
    [{ producer: 'cfo' }, [400, { error: 'invalid_body', detail: 'unknown field "producer"' }]],
    [[], [400, { error: 'invalid_body' }]],
  ]) {
    const response = await put(app, '/api/feeds/work', body);
    assert.deepEqual([response.status, response.json], expected, JSON.stringify(body));
  }
  assert.deepEqual((await put(app, '/api/feeds/nope', { active: true })).json, { error: 'no_such_feed' });
  for (const [body, detail] of [
    [{ name: 'X' }, 'missing field "note"'],
    [{ name: 'X', note: '', extra: 1 }, 'unknown field "extra"'],
    [{ name: '', note: '' }, 'name must be 1 to 40 characters on one line'],
  ]) {
    const response = await post(app, '/api/feeds', body);
    assert.deepEqual([response.status, response.json], [400, { error: 'invalid_body', detail }], JSON.stringify(body));
  }
  assert.equal((await post(app, '/api/feeds', '{ nope')).status, 400);
});

test('the note reads and writes directly, with no agent turn', async (t) => {
  const app = await startFeeds(t);
  assert.deepEqual((await request(app, 'GET', '/api/feeds/news/note')).json, { text: '', updated: null });
  const written = await put(app, '/api/feeds/news/note', { text: 'Keep what would change something.\n' });
  assert.equal(written.status, 200);
  assert.equal(written.json.ok, true);
  assert.equal(written.json.text, 'Keep what would change something.\n');
  assert.ok(!Number.isNaN(Date.parse(written.json.updated)));
  const read = await request(app, 'GET', '/api/feeds/news/note');
  assert.equal(read.json.text, 'Keep what would change something.\n');
  assert.equal(await readFile(path.join(app.feedsDir, 'news', 'note.md'), 'utf8'), 'Keep what would change something.\n');
  for (const body of [{}, { text: 7 }, { text: 'x', extra: 1 }, []]) {
    assert.deepEqual((await put(app, '/api/feeds/news/note', body)).json, { error: 'invalid_body' }, JSON.stringify(body));
  }
  const limit = app.config.limits.feedNoteBytes;
  assert.equal((await put(app, '/api/feeds/news/note', { text: 'x'.repeat(limit) })).status, 200);
  const over = await put(app, '/api/feeds/news/note', { text: 'x'.repeat(limit + 1) });
  assert.deepEqual([over.status, over.json], [413, { error: 'note_too_large' }]);
  assert.deepEqual((await put(app, '/api/feeds/nope/note', { text: 'x' })).json, { error: 'no_such_feed' });
  assert.deepEqual(app.adapter.calls, []);
});

test('save, unsave, and dismiss answer the fresh read', async (t) => {
  const app = await startFeeds(t);
  const saved = await post(app, '/api/feeds/news/save', { id: 'watch/2026-09-28/2' });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.runs[0].items[1].status, 'saved');
  const dismissed = await post(app, '/api/feeds/news/dismiss', { id: 'watch/2026-09-28/3' });
  assert.equal(dismissed.json.runs[0].items.length, 7);
  // A dismissed post stays dismissed on a fresh read.
  assert.equal((await request(app, 'GET', '/api/feeds/news')).json.runs[0].items.length, 7);
  const unsaved = await post(app, '/api/feeds/news/unsave', { id: 'watch/2026-09-28/2' });
  assert.equal(unsaved.json.runs[0].items[1].status, 'new');
  const marks = JSON.parse(await readFile(path.join(app.feedsDir, 'news', 'marks.json'), 'utf8'));
  assert.deepEqual(Object.keys(marks.marks), ['watch/2026-09-28/3']);

  assert.deepEqual((await post(app, '/api/feeds/news/save', { id: 'nope' })).json, { error: 'no_such_item' });
  assert.deepEqual((await post(app, '/api/feeds/nope/save', { id: 'watch/2026-09-28/2' })).json, { error: 'no_such_feed' });
  for (const body of [[], {}, { id: '' }, { id: 7 }, { id: 'a'.repeat(201) }, { id: 'x', extra: 1 }]) {
    const response = await post(app, '/api/feeds/news/dismiss', body);
    assert.deepEqual([response.status, response.json], [400, { error: 'invalid_body' }], JSON.stringify(body));
  }
  await writeFile(path.join(app.feedsDir, 'news', 'marks.json'), '{ broken');
  const refused = await post(app, '/api/feeds/news/save', { id: 'watch/2026-09-28/2' });
  assert.deepEqual([refused.status, refused.json], [409, { error: 'marks_invalid' }]);
});

test('discuss sends the post to the feed\'s producer with its sources by name, takeaway, and insights', async (t) => {
  const app = await startFeeds(t);
  await post(app, '/api/sources', { name: 'Invented Letters', kind: 'email', sender: 'letters@example.com' });
  await writeFile(path.join(app.feedsDir, 'news', 'items', '2026-10-09.json'), JSON.stringify({
    feed: 'news', producer: 'scout', date: '2026-10-09', items: [{
      id: 'news/2026-10-09/1', title: 'A new shape', sources: ['invented-letters', 'unregistered'], url: 'https://example.com/new',
      summary: 'What it says.', takeaway: 'One sentence.', insights: 'Why it matters.',
    }],
  }));
  const response = await post(app, '/api/feeds/news/discuss', { id: 'news/2026-10-09/1' });
  assert.deepEqual([response.status, response.json], [202, { ok: true, agentId: 'scout' }]);
  assert.deepEqual(app.adapter.calls, [[
    'scout',
    'Discuss this feed post with me.\n\n' +
      'A new shape\nInvented Letters, unregistered: https://example.com/new\n\n' +
      'What it says.\n\nTakeaway: One sentence.\n\nInsights:\nWhy it matters.\n\n' +
      'Read the link, then tell me what it says in a short paragraph and why it was picked. Then wait for my question.',
  ]]);
  // An old-shape post has neither, and its source names stay as written.
  assert.equal(discussMessage({ title: 'T', sources: ['Invented Letters'], url: 'https://example.com/x', summary: 'S.' }),
    'Discuss this feed post with me.\n\nT\nInvented Letters: https://example.com/x\n\nS.\n\n' +
    'Read the link, then tell me what it says in a short paragraph and why it was picked. Then wait for my question.');
});

test('discuss refuses in order: body, feed, producer, item, then the adapter', async (t) => {
  const app = await startFeeds(t);
  assert.deepEqual((await post(app, '/api/feeds/news/discuss', { item: 'x' })).json, { error: 'invalid_body' });
  assert.deepEqual((await post(app, '/api/feeds/nope/discuss', { id: 'watch/2026-09-28/1' })).json, { error: 'no_such_feed' });
  assert.deepEqual((await post(app, '/api/feeds/news/discuss', { id: 'watch/2026-09-28/9' })).json, { error: 'no_such_item' });
  for (const [code, expected] of [['busy', 409], ['unavailable', 503], ['shutting_down', 503], ['invalid_text', 400]]) {
    app.adapter.behavior.send = code;
    const response = await post(app, '/api/feeds/news/discuss', { id: 'watch/2026-09-28/1' });
    assert.deepEqual([response.status, response.json], [expected, { error: code }], code);
  }
  for (const [options, expected] of [
    [{ persona: false }, [404, 'no_such_agent']],
    [{ kind: 'project' }, [404, 'no_such_agent']],
    [{ persona: 'codex' }, [409, 'persona_unavailable']],
  ]) {
    const other = await startFeeds(t, options);
    const response = await post(other, '/api/feeds/news/discuss', { id: 'watch/2026-09-28/1' });
    assert.deepEqual([response.status, response.json], [expected[0], { error: expected[1] }], JSON.stringify(options));
    assert.deepEqual(other.adapter.calls, []);
  }
});

test('the feed routes need their methods, JSON, and an exact Origin', async (t) => {
  const app = await startFeeds(t);
  const body = { id: 'watch/2026-09-28/1' };
  assert.equal((await post(app, '/api/feeds/news/save', body, { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await post(app, '/api/feeds/news/save', body, { origin: 'http://evil.example' })).status, 403);
  assert.equal((await put(app, '/api/feeds/news/note', { text: 'x' }, { origin: 'http://evil.example' })).status, 403);
  assert.equal((await post(app, '/api/feeds', { name: 'X', note: '' }, { origin: 'http://evil.example' })).status, 403);
  const get = await request(app, 'GET', '/api/feeds/news/discuss');
  assert.deepEqual([get.status, get.headers.allow], [405, 'POST']);
  assert.deepEqual((await post(app, '/api/feeds/news', body)).headers.allow, 'GET, PUT');
  assert.deepEqual((await send(app, 'DELETE', '/api/feeds/news', '')).status, 405);
  assert.equal((await request(app, 'GET', '/api/feeds/news/other')).status, 404);
  assert.deepEqual(app.adapter.calls, []);
});

test('writes and discuss after closeStreams answer 503', async (t) => {
  const app = await startFeeds(t);
  app.handler.closeStreams();
  for (const [method, pathname, body] of [
    ['POST', '/api/feeds/news/discuss', { id: 'watch/2026-09-28/1' }],
    ['POST', '/api/feeds/news/save', { id: 'watch/2026-09-28/1' }],
    ['PUT', '/api/feeds/news/note', { text: 'x' }],
    ['PUT', '/api/feeds/news', { active: false }],
    ['POST', '/api/feeds', { name: 'X', note: '' }],
  ]) {
    const response = await send(app, method, pathname, body);
    assert.deepEqual([response.status, response.json], [503, { error: 'shutting_down' }], pathname);
  }
  assert.equal((await request(app, 'GET', '/api/feeds/news')).status, 200);
  assert.deepEqual(app.adapter.calls, []);
});

test('without feeds every feed and source route is 404', async (t) => {
  const app = await startFeeds(t, { feeds: null });
  for (const pathname of ['/api/feeds', '/api/feeds/news', '/api/sources']) {
    const response = await request(app, 'GET', pathname);
    assert.deepEqual([response.status, response.json], [404, { error: 'not_found' }], pathname);
  }
});

const suggestPost = (app, pathname, headers = {}) => request(app, 'POST', pathname, { headers: { origin: app.origin, ...headers } });
const settled = async (check) => {
  for (let i = 0; i < 100 && !(await check()); i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
};

test('suggestContext names the feed; suggestRoutine finds the producer\'s routine that names the skill', () => {
  assert.equal(suggestContext('garden'), 'The feed id is "garden".');
  const items = [
    { id: 'a', agent: 'myos', instruction: 'Run the suggest-sources skill.' },
    { id: 'b', agent: 'scout', instruction: 'Run the feeds.' },
    { id: 'c', agent: 'scout', instruction: SUGGEST_ROUTINE.instruction },
  ];
  assert.equal(suggestRoutine(items, 'scout').id, 'c');
  assert.equal(suggestRoutine(items, 'cfo'), null);
  assert.equal(suggestRoutine(null, 'scout'), null);
});

test('creating a feed starts a suggestion run on the producer\'s inactive Suggest sources routine; suggestions read once it ends', async (t) => {
  const app = await startFeeds(t, { suggest: true });
  await post(app, '/api/sources', { name: 'Latent Space', kind: 'rss', url: 'https://www.latent.space/feed' });
  await post(app, '/api/sources', { name: 'Priorities', kind: 'file', path: '/invented/priorities.md', default: true });
  const created = await post(app, '/api/feeds', { name: 'Garden', note: 'Stories about the garden.\n' });
  assert.deepEqual([created.status, created.json.feed.id, created.json.suggesting], [201, 'garden', true]);

  const [routine] = app.routines.current();
  assert.deepEqual([app.routines.current().length, routine.name, routine.agent, routine.instruction, routine.active],
    [1, 'Suggest sources', 'scout', SUGGEST_ROUTINE.instruction, false]);
  assert.deepEqual(app.adapter.calls, [['scout', SUGGEST_ROUTINE.instruction]]);
  assert.deepEqual(app.adapter.options[0].routine, { id: routine.id, name: 'Suggest sources' });
  assert.match(app.adapter.options[0].prompt, /Run the suggest-sources skill for the feed the context names\.\n\nThe feed id is "garden"\./);

  const during = await request(app, 'GET', '/api/feeds/garden/suggestions');
  assert.deepEqual([during.status, during.json], [200, { suggesting: true, suggestions: null }]);
  const again = await suggestPost(app, '/api/feeds/garden/suggest');
  assert.deepEqual([again.status, again.json], [409, { error: 'busy' }]);
  assert.equal(app.adapter.calls.length, 1);

  const file = path.join(app.feedsDir, 'garden', 'suggestions.json');
  await writeFile(file, JSON.stringify({
    version: 1, at: AT,
    sources: [{ id: 'latent-space', why: 'It covers the field.' }, { id: 'priorities', why: 'Already on the feed.' }],
  }));
  app.adapter.release();
  await settled(async () => (await request(app, 'GET', '/api/feeds/garden/suggestions')).json.suggesting === false);
  const after = await request(app, 'GET', '/api/feeds/garden/suggestions');
  assert.deepEqual(after.json, {
    suggesting: false,
    suggestions: { at: AT, sources: [{ id: 'latent-space', name: 'Latent Space', kind: 'rss', role: 'incoming', why: 'It covers the field.' }] },
  });
  assert.equal(app.routines.runs(routine.id, 5)[0].outcome, 'finished');

  // Suggest again: the old file is removed first and the same routine runs.
  const rerun = await suggestPost(app, '/api/feeds/garden/suggest');
  assert.deepEqual([rerun.status, rerun.json], [202, { ok: true, suggesting: true }]);
  await assert.rejects(readFile(file, 'utf8'), { code: 'ENOENT' });
  assert.equal(app.routines.current().length, 1);
  assert.equal(app.adapter.calls.length, 2);
  await settled(async () => (await request(app, 'GET', '/api/feeds/garden/suggestions')).json.suggesting === false);
  assert.deepEqual((await request(app, 'GET', '/api/feeds/garden/suggestions')).json, { suggesting: false, suggestions: null });
});

test('suggest refuses in order: shutdown, feed, no scheduler, producer, then the scheduler\'s refusal', async (t) => {
  const plain = await startFeeds(t);
  const created = await post(plain, '/api/feeds', { name: 'Garden', note: '' });
  assert.deepEqual([created.status, created.json.suggesting], [201, false]);
  assert.ok(plain.logs.some((line) => line.event === 'feed_suggest_refused' && line.feed === 'garden' && line.reason === 'not_yet'));
  assert.deepEqual((await suggestPost(plain, '/api/feeds/nope/suggest')).json, { error: 'no_such_feed' });
  assert.deepEqual((await request(plain, 'GET', '/api/feeds/nope/suggestions')).json, { error: 'no_such_feed' });
  const noScheduler = await suggestPost(plain, '/api/feeds/garden/suggest');
  assert.deepEqual([noScheduler.status, noScheduler.json], [503, { error: 'not_yet' }]);

  const missing = await startFeeds(t, { persona: false, suggest: true });
  const unavailable = await suggestPost(missing, '/api/feeds/news/suggest');
  assert.deepEqual([unavailable.status, unavailable.json], [409, { error: 'agent_unavailable' }]);
  assert.deepEqual(missing.routines.current(), []);

  const refusing = await startFeeds(t, { suggest: { testRun: async () => ({ ok: false, reason: 'busy' }), stop() {} } });
  await writeFile(path.join(refusing.feedsDir, 'news', 'suggestions.json'), '{}');
  const busy = await suggestPost(refusing, '/api/feeds/news/suggest');
  assert.deepEqual([busy.status, busy.json], [409, { error: 'busy' }]);
  assert.deepEqual((await request(refusing, 'GET', '/api/feeds/news/suggestions')).json.suggesting, false);

  refusing.handler.closeStreams();
  const closing = await suggestPost(refusing, '/api/feeds/news/suggest');
  assert.deepEqual([closing.status, closing.json], [503, { error: 'shutting_down' }]);
  assert.equal((await suggestPost(refusing, '/api/feeds/news/suggest', { 'content-type': 'application/json' })).status, 503);
  const get = await request(refusing, 'GET', '/api/feeds/news/suggest');
  assert.deepEqual([get.status, get.headers.allow], [405, 'POST']);
});
