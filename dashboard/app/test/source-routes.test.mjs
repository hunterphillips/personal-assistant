import assert from 'node:assert/strict';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

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
