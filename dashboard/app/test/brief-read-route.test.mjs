// POST /api/brief/read (lib/app.mjs, hub.markBriefRead): marks the newest
// brief read through lib/brief-reads.mjs and clears `brief.unread` in the
// snapshot everywhere. Origin and body checks follow the other bodyless
// POST routes (lib/app.mjs's checkMutation).

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import { createBriefReads } from '../lib/brief-reads.mjs';
import { request, startApp, tempDir } from './support/harness.mjs';
import { writeBrief } from './support/brief-fixtures.mjs';

function post(app, pathName) {
  return request(app, 'POST', pathName, { headers: { origin: app.origin } });
}

async function makeApp(t, { briefsDir, briefReads } = {}) {
  const dir = briefsDir ?? path.join(await tempDir(t), 'briefs-missing');
  return startApp(t, { env: { DASHBOARD_BRIEFS_DIR: dir }, briefReads });
}

test('marks the newest brief read: writes brief-reads.json and clears unread in the snapshot', async (t) => {
  const briefsDir = await tempDir(t);
  await writeBrief(briefsDir, '2026-09-14');
  await writeBrief(briefsDir, '2026-09-15');
  const readsFile = path.join(await tempDir(t), 'brief-reads.json');
  const briefReads = createBriefReads({ file: readsFile });
  await briefReads.load();
  const app = await makeApp(t, { briefsDir, briefReads });

  await app.hub.refreshStatus();
  assert.equal(app.hub.snapshot().brief.unread, true);

  const response = await post(app, '/api/brief/read');
  assert.equal(response.status, 200);
  assert.deepEqual(response.json, { ok: true });
  assert.equal(app.hub.snapshot().brief.unread, false);
  assert.deepEqual(JSON.parse(await readFile(readsFile, 'utf8')), { version: 1, read: '2026-09-15' });
});

test('an older brief opened by its own date is never marked (the overlay only calls this for the newest)', async (t) => {
  const briefsDir = await tempDir(t);
  await writeBrief(briefsDir, '2026-09-14');
  await writeBrief(briefsDir, '2026-09-15');
  const readsFile = path.join(await tempDir(t), 'brief-reads.json');
  const briefReads = createBriefReads({ file: readsFile });
  await briefReads.load();
  const app = await makeApp(t, { briefsDir, briefReads });

  // The route itself always marks the newest, regardless of what a client
  // last viewed; there is no way to mark an older date through it.
  await post(app, '/api/brief/read');
  assert.deepEqual(JSON.parse(await readFile(readsFile, 'utf8')), { version: 1, read: '2026-09-15' });
});

test('answers ok with nothing to mark when there is no ready brief, and without briefReads configured at all', async (t) => {
  const readsFile = path.join(await tempDir(t), 'brief-reads.json');
  const briefReads = createBriefReads({ file: readsFile });
  await briefReads.load();
  const withStore = await makeApp(t, { briefReads });
  const marked = await post(withStore, '/api/brief/read');
  assert.equal(marked.status, 200);
  assert.deepEqual(marked.json, { ok: true });
  await assert.rejects(readFile(readsFile), (error) => error.code === 'ENOENT');

  const bare = await makeApp(t);
  const response = await post(bare, '/api/brief/read');
  assert.equal(response.status, 200);
  assert.deepEqual(response.json, { ok: true });
});

test('refuses a missing origin, a request with a body, and the wrong method', async (t) => {
  const app = await makeApp(t);
  const noOrigin = await request(app, 'POST', '/api/brief/read');
  assert.equal(noOrigin.status, 403);
  assert.deepEqual(noOrigin.json, { error: 'forbidden_origin' });

  const withBody = await request(app, 'POST', '/api/brief/read', {
    headers: { origin: app.origin, 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(withBody.status, 413);

  const wrongMethod = await request(app, 'GET', '/api/brief/read');
  assert.equal(wrongMethod.status, 405);
});
