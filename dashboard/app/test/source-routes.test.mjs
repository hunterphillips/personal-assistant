import assert from 'node:assert/strict';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';

import { discoverFeed } from '../lib/discover.mjs';
import { request, startApp, tempDir } from './support/harness.mjs';

const AT = '2026-10-08T12:00:00.000Z';

const status = {
  focus: { checkHealth: async () => ({ available: true }) },
  brief: { latestMetadata: async () => ({ state: 'empty' }) },
};

// The app over empty sources and one feed, `news`, with no sources.
async function startSources(t) {
  const root = await tempDir(t);
  const feedsDir = path.join(root, 'feeds');
  const sourcesDir = path.join(root, 'sources');
  await mkdir(path.join(feedsDir, 'news', 'items'), { recursive: true });
  await writeFile(path.join(feedsDir, 'news', 'feed.json'), JSON.stringify({
    version: 1, id: 'news', name: 'News', producer: 'scout', sources: [], active: true, created: AT, updated: AT,
  }));
  const app = await startApp(t, { ...status, env: { DASHBOARD_FEEDS_DIR: feedsDir, DASHBOARD_SOURCES_DIR: sourcesDir } });
  return { ...app, feedsDir, sourcesDir };
}

function send(app, method, pathname, body, headers = {}) {
  return request(app, method, pathname, {
    headers: { origin: app.origin, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
}

test('POST /api/sources creates each kind, GET lists them by name, PUT changes one', async (t) => {
  const app = await startSources(t);
  const empty = await request(app, 'GET', '/api/sources');
  assert.deepEqual([empty.status, empty.json], [200, { sources: [], problems: [] }]);
  assert.equal(empty.headers['cache-control'], 'no-store');

  const bodies = [
    { name: 'Simon Willison', kind: 'rss', url: 'https://simonwillison.net/atom/everything/' },
    { name: 'Axios Nashville', kind: 'email', sender: 'nashville@axios.com' },
    { name: 'Priorities', kind: 'file', path: '/invented/priorities.md', default: true },
    { name: 'Projects', kind: 'folder', path: '/invented/projects', active: false },
  ];
  for (const body of bodies) {
    const response = await send(app, 'POST', '/api/sources', body);
    assert.equal(response.status, 201, body.name);
    assert.equal(response.json.ok, true);
  }
  const listed = (await request(app, 'GET', '/api/sources')).json.sources;
  assert.deepEqual(listed.map((source) => [source.id, source.kind, source.role, source.active, source.default, source.missing]), [
    ['axios-nashville', 'email', 'incoming', true, false, undefined],
    ['priorities', 'file', 'context', true, true, true],
    ['projects', 'folder', 'context', false, false, true],
    ['simon-willison', 'rss', 'incoming', true, false, undefined],
  ]);

  const updated = await send(app, 'PUT', '/api/sources/projects', { active: true, default: true, path: '/invented/other' });
  assert.equal(updated.status, 200);
  assert.deepEqual([updated.json.source.active, updated.json.source.default, updated.json.source.path], [true, true, '/invented/other']);
});

test('source refusals name the field, and a missing source is 404', async (t) => {
  const app = await startSources(t);
  for (const [body, detail] of [
    [{ name: 'X', kind: 'rss', url: 'ftp://example.com' }, 'url must be an http or https address'],
    [{ name: 'X', kind: 'email', sender: 'nope' }, 'sender must be an email address'],
    [{ name: 'X', kind: 'file', path: 'notes.md' }, 'path must be an absolute path'],
    [{ name: 'X', kind: 'youtube', url: 'https://example.com' }, 'kind must be one of rss, email, file, folder'],
  ]) {
    const response = await send(app, 'POST', '/api/sources', body);
    assert.deepEqual([response.status, response.json], [400, { error: 'invalid_body', detail }], JSON.stringify(body));
  }
  assert.deepEqual((await send(app, 'POST', '/api/sources', [])).json, { error: 'invalid_body' });
  assert.deepEqual((await send(app, 'POST', '/api/sources', '{ nope')).json, { error: 'invalid_json' });
  assert.deepEqual((await send(app, 'PUT', '/api/sources/nope', { active: true })).json, { error: 'no_such_source' });
  assert.deepEqual((await send(app, 'DELETE', '/api/sources/nope')).json, { error: 'no_such_source' });
  const big = await send(app, 'POST', '/api/sources', { name: 'X', kind: 'rss', url: `https://example.com/${'x'.repeat(app.config.limits.feedBodyBytes)}` });
  assert.deepEqual([big.status, big.json], [413, { error: 'payload_too_large' }]);
  assert.equal((await request(app, 'GET', '/api/sources/Bad_Id')).status, 404);
});

test('DELETE refuses while a feed lists the source, naming the feed, then removes it once unlisted', async (t) => {
  const app = await startSources(t);
  await send(app, 'POST', '/api/sources', { name: 'Latent Space', kind: 'rss', url: 'https://www.latent.space/feed' });
  await send(app, 'PUT', '/api/feeds/news', { sources: ['latent-space'] });
  const refused = await send(app, 'DELETE', '/api/sources/latent-space');
  assert.deepEqual([refused.status, refused.json], [409, { error: 'in_use', feeds: ['news'] }]);
  await send(app, 'PUT', '/api/feeds/news', { sources: [] });
  const removed = await send(app, 'DELETE', '/api/sources/latent-space');
  assert.deepEqual([removed.status, removed.json], [200, { ok: true }]);
  assert.deepEqual(await readdir(app.sourcesDir), []);
});

test('the source routes need their methods, JSON, an exact Origin, and a bodyless DELETE', async (t) => {
  const app = await startSources(t);
  const body = { name: 'X', kind: 'rss', url: 'https://example.com/feed' };
  assert.equal((await send(app, 'POST', '/api/sources', body, { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await send(app, 'POST', '/api/sources', body, { origin: 'http://evil.example' })).status, 403);
  assert.equal((await send(app, 'DELETE', '/api/sources/x', undefined, { origin: 'http://evil.example' })).status, 403);
  assert.equal((await request(app, 'DELETE', '/api/sources/x', { headers: { origin: app.origin, 'content-length': '1' }, body: 'x' })).status, 413);
  const get = await request(app, 'GET', '/api/sources/x');
  assert.deepEqual([get.status, get.headers.allow], [405, 'PUT, DELETE']);
  assert.deepEqual((await send(app, 'PUT', '/api/sources', body)).headers.allow, 'GET, POST');
  app.handler.closeStreams();
  assert.deepEqual((await send(app, 'POST', '/api/sources', body)).json, { error: 'shutting_down' });
  assert.equal((await request(app, 'GET', '/api/sources')).status, 200);
});

// A local site for discovery: each path answers its [content type, body]; a
// path missing from `pages` is 404, and /slow never answers.
async function fixtureSite(t, pages) {
  const held = [];
  const server = http.createServer((req, res) => {
    if (req.url === '/slow') {
      held.push(res);
      return;
    }
    if (req.url === '/moved') {
      res.writeHead(302, { location: '/feed.xml' }).end();
      return;
    }
    const page = pages[req.url];
    if (!page) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': page[0] }).end(page[1]);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => {
    for (const res of held) res.destroy();
    server.close(resolve);
  }));
  return `http://127.0.0.1:${server.address().port}`;
}

const RSS = '<?xml version="1.0"?>\n<rss version="2.0"><channel><title>Invented</title></channel></rss>';
const ATOM = '<?xml version="1.0" encoding="utf-8"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Invented</title></feed>';
const page = (head) => `<!doctype html><html><head><title>Invented</title>${head}</head><body><p>Hello.</p></body></html>`;

test('POST /api/sources/discover finds an RSS or Atom alternate link, a direct feed, or nothing', async (t) => {
  const site = await fixtureSite(t, {
    '/': ['text/html; charset=utf-8', page('<link rel="stylesheet" href="/s.css"><link rel="alternate" type="application/rss+xml" title="RSS" href="/feed.xml">')],
    '/atom': ['text/html', page("<link type='application/atom+xml' href='https://example.com/atom.xml?a=1&amp;b=2' rel='alternate'>")],
    '/plain': ['text/html', page('<link rel="alternate" hreflang="fr" href="/fr/">')],
    '/feed.xml': ['application/rss+xml', RSS],
    '/atom.xml': ['text/plain', ATOM],
  });
  const app = await startSources(t);
  const discover = (url) => send(app, 'POST', '/api/sources/discover', { url });
  assert.deepEqual([(await discover(`${site}/`)).status, (await discover(`${site}/`)).json], [200, { feed: `${site}/feed.xml` }]);
  assert.deepEqual((await discover(`${site}/atom`)).json, { feed: 'https://example.com/atom.xml?a=1&b=2' });
  assert.deepEqual((await discover(`${site}/feed.xml`)).json, { feed: `${site}/feed.xml` });
  // A feed served as text is still a feed; a redirect answers where it led.
  assert.deepEqual((await discover(`${site}/atom.xml`)).json, { feed: `${site}/atom.xml` });
  assert.deepEqual((await discover(`${site}/moved`)).json, { feed: `${site}/feed.xml` });
  assert.deepEqual((await discover(`${site}/plain`)).json, { feed: null });
  assert.deepEqual((await discover(`${site}/gone`)).json, { feed: null });
  // Nothing was written.
  assert.deepEqual(await readdir(app.sourcesDir).catch(() => []), []);
});

test('discover refuses an address that is not http or https, and a body with other keys', async (t) => {
  const app = await startSources(t);
  const detail = 'url must be an http or https address';
  for (const body of [{ url: 'ftp://example.com/feed' }, { url: 'file:///etc/passwd' }, { url: 'example.com' }, { url: 7 }, {}, { url: 'https://example.com', name: 'X' }]) {
    const response = await send(app, 'POST', '/api/sources/discover', body);
    assert.deepEqual([response.status, response.json], [400, { error: 'invalid_body', detail }], JSON.stringify(body));
  }
  assert.equal((await request(app, 'GET', '/api/sources/discover')).headers.allow, 'POST');
  assert.equal(await discoverFeed('javascript:alert(1)'), null);
});

test('discover gives up on a site that does not answer in time, and reads no further than the cap', async (t) => {
  const filler = '<meta name="x" content="' + 'x'.repeat(2048) + '">';
  const site = await fixtureSite(t, {
    '/long': ['text/html', page(filler + '<link rel="alternate" type="application/rss+xml" href="/feed.xml">')],
  });
  const started = Date.now();
  assert.equal(await discoverFeed(`${site}/slow`, { timeoutMs: 200 }), null);
  assert.ok(Date.now() - started < 2000);
  assert.equal(await discoverFeed(`${site}/long`, { maxBytes: 1024 }), null);
  assert.equal(await discoverFeed(`${site}/long`), `${site}/feed.xml`);
});

test('a source named Discover takes another id, since discover is the route', async (t) => {
  const app = await startSources(t);
  const created = await send(app, 'POST', '/api/sources', { name: 'Discover', kind: 'rss', url: 'https://example.com/feed' });
  assert.equal(created.json.source.id, 'discover-2');
});
