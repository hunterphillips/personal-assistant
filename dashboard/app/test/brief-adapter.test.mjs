import assert from 'node:assert/strict';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import { createBriefRoutes } from '../lib/brief-adapter.mjs';
import { MAX_BRIEF_BYTES, loadBrief } from '../lib/briefs.mjs';
import { request, startApp, tempDir } from './support/harness.mjs';
import { briefData, writeBrief, writeViewer } from './support/brief-fixtures.mjs';

function focusAvailable() {
  return {
    async checkHealth() { return { available: true }; },
    async handlePage() { throw new Error('not used'); },
    async handleApi() { throw new Error('not used'); },
  };
}

async function makeApp(t, dir) {
  return startApp(t, {
    env: { DASHBOARD_BRIEFS_DIR: dir },
    focus: focusAvailable(),
  });
}

function feedbackBody(brief, overrides = {}) {
  return {
    date: brief.date,
    revision: brief.revision,
    overall: '',
    items: brief.items.map((item) => ({ id: item.id, mark: null, note: '' })),
    ...overrides,
  };
}

async function postFeedback(app, body) {
  return request(app, 'POST', '/api/brief/feedback', {
    headers: { origin: app.origin, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('latest returns the newest brief as the overlay renders it', async (t) => {
  const dir = await tempDir(t);
  await writeBrief(dir, '2026-09-14');
  const { data } = await writeBrief(dir, '2026-09-15');
  const brief = await loadBrief(dir, '2026-09-15');
  const app = await makeApp(t, dir);
  const response = await request(app, 'GET', '/api/brief/latest');
  assert.equal(response.status, 200);
  assert.deepEqual(response.json, {
    state: 'ready', date: '2026-09-15', revision: brief.revision, title: data.title, words: data.words,
    opening: data.opening, sections: data.sections,
  });
  const byDate = await request(app, 'GET', '/api/brief/2026-09-14');
  assert.equal(byDate.status, 200);
  assert.equal(byDate.json.date, '2026-09-14');
  assert.equal(byDate.json.state, 'ready');
});

test('a newer viewer without data reports the brief missing for its date, never an older one', async (t) => {
  const dir = await tempDir(t);
  await writeBrief(dir, '2026-09-14');
  await writeViewer(dir, '2026-09-15');
  const routes = createBriefRoutes({ briefsDir: dir });
  assert.deepEqual(await routes.latestMetadata({}), { state: 'missing', date: '2026-09-15' });
  const app = await makeApp(t, dir);
  assert.deepEqual((await request(app, 'GET', '/api/brief/latest')).json,
    { state: 'missing', date: '2026-09-15', error: 'brief_not_found' });
  assert.deepEqual((await request(app, 'GET', '/api/brief/2026-09-13')).json,
    { state: 'missing', date: '2026-09-13', error: 'brief_not_found' });
});

test('malformed and oversized data report their state and date, never content', async (t) => {
  const dir = await tempDir(t);
  await writeBrief(dir, '2026-09-15', { ...briefData('2026-09-15'), sections: 'invented' });
  const routes = createBriefRoutes({ briefsDir: dir });
  const metadata = await routes.latestMetadata({});
  assert.equal(metadata.state, 'unsupported');
  assert.equal(metadata.date, '2026-09-15');
  assert.match(metadata.revision, /^[0-9a-f]{64}$/);
  const app = await makeApp(t, dir);
  const latest = await request(app, 'GET', '/api/brief/latest');
  assert.equal(latest.json.state, 'unsupported');
  assert.equal(latest.json.error, 'invalid_brief');
  assert.equal(latest.json.sections, undefined);

  const oversized = await tempDir(t);
  await writeFile(path.join(oversized, 'brief-2026-09-15.json'), Buffer.alloc(MAX_BRIEF_BYTES + 1, 0x20));
  assert.deepEqual(await createBriefRoutes({ briefsDir: oversized }).latestMetadata({}), {
    state: 'oversized', date: '2026-09-15',
  });
});

test('latest metadata reports empty, and directory read errors report unavailable', async (t) => {
  const empty = await tempDir(t);
  assert.deepEqual(await createBriefRoutes({ briefsDir: empty }).latestMetadata({}), { state: 'empty' });
  const parent = await tempDir(t);
  const routes = createBriefRoutes({ briefsDir: path.join(parent, 'missing') });
  assert.deepEqual(await routes.latestMetadata({}), { state: 'unavailable' });
  await assert.rejects(routes.handleLatest({}, {}), { name: 'HttpError', status: 503, code: 'brief_directory_unavailable' });
});

test('the viewer is no longer served', async (t) => {
  const dir = await tempDir(t);
  await writeViewer(dir, '2026-09-15');
  const app = await makeApp(t, dir);
  assert.equal((await request(app, 'GET', `/embedded/brief/2026-09-15?revision=${'a'.repeat(64)}`)).status, 404);
  assert.equal((await request(app, 'GET', '/assets/brief-bridge.js')).status, 404);
});

test('feedback saves Markdown the curator reads and JSON the overlay reads back, both private', async (t) => {
  const dir = await tempDir(t);
  await writeBrief(dir, '2026-09-15');
  const brief = await loadBrief(dir, '2026-09-15');
  const app = await makeApp(t, dir);

  const empty = await request(app, 'GET', '/api/brief/2026-09-15/feedback');
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.json, { date: '2026-09-15', revision: null, overall: '', items: [], savedAt: null });

  const value = feedbackBody(brief, {
    overall: 'Invented overall thought',
    items: [
      { id: 'opening', mark: null, note: '' },
      { id: 'needs-you-1', mark: 'approved', note: 'Line one\nline two' },
      { id: 'needs-you-2', mark: 'dismissed', note: '' },
      { id: 'money-1', mark: null, note: 'Invented note only.' },
    ],
  });
  const saved = await postFeedback(app, value);
  assert.equal(saved.status, 200);
  assert.equal(saved.json.saved, true);
  assert.equal(saved.json.date, '2026-09-15');
  assert.ok(!Number.isNaN(Date.parse(saved.json.savedAt)));

  assert.equal(await readFile(path.join(dir, 'feedback-2026-09-15.md'), 'utf8'), [
    '# Brief feedback for 2026-09-15', '', '## Overall', '', 'Invented overall thought', '',
    '## Opening', '',
    '- opening: no mark',
    '  > Invented opening: cash is fine and nothing is due before Thursday.',
    '',
    '## Needs you', '',
    '- needs-you-1: APPROVED',
    '  > An invented reply to **Sam** is owed about the lease.',
    '  - note: Line one',
    '    line two',
    '- needs-you-2: DISMISSED',
    '  > - One invented form waits for a signature.',
    '  > - Another invented form is half done.',
    '',
    '## Money', '',
    '- money-1: no mark',
    '  > Invented drift is under a point, and the [policy](https://example.com/policy) holds.',
    '  - note: Invented note only.',
    '',
  ].join('\n'));
  for (const name of ['feedback-2026-09-15.md', 'feedback-2026-09-15.json']) {
    assert.equal((await stat(path.join(dir, name))).mode & 0o777, 0o600, name);
  }

  const readBack = await request(app, 'GET', '/api/brief/2026-09-15/feedback');
  assert.deepEqual(readBack.json, { ...value, savedAt: saved.json.savedAt });
});

test('feedback is refused for invalid, missing, stale, partial, and oversized input, keeping what was saved', async (t) => {
  const dir = await tempDir(t);
  await writeBrief(dir, '2026-09-15');
  const brief = await loadBrief(dir, '2026-09-15');
  const app = await makeApp(t, dir);
  const value = feedbackBody(brief);
  assert.equal((await postFeedback(app, value)).status, 200);
  const existing = await readFile(path.join(dir, 'feedback-2026-09-15.md'), 'utf8');

  assert.equal((await postFeedback(app, { ...value, filename: 'brief-2026-09-15.json' })).status, 400);
  assert.equal((await postFeedback(app, { ...value, date: '2026-09-14' })).status, 404);
  assert.equal((await postFeedback(app, { ...value, revision: 'b'.repeat(64) })).status, 409);
  assert.equal((await postFeedback(app, { ...value, items: value.items.slice(1) })).status, 400);
  assert.equal((await postFeedback(app, { ...value, overall: 'x'.repeat(8_001) })).status, 413);
  assert.equal(await readFile(path.join(dir, 'feedback-2026-09-15.md'), 'utf8'), existing);

  // A rebuilt brief for the same date refuses a save marked against the old one.
  await writeBrief(dir, '2026-09-15', briefData('2026-09-15'));
  assert.equal((await postFeedback(app, value)).status, 409);
  assert.equal(await readFile(path.join(dir, 'feedback-2026-09-15.md'), 'utf8'), existing);
});

test('a saved feedback file that is not the writer\'s reads back as an empty draft', async (t) => {
  const dir = await tempDir(t);
  await writeBrief(dir, '2026-09-15');
  const app = await makeApp(t, dir);
  for (const text of ['not json', '{"date":"2026-09-15"}', JSON.stringify({
    date: '2026-09-14', revision: 'a'.repeat(64), overall: '', items: [], savedAt: '2026-09-15T00:00:00.000Z',
  })]) {
    await writeFile(path.join(dir, 'feedback-2026-09-15.json'), text);
    const response = await request(app, 'GET', '/api/brief/2026-09-15/feedback');
    assert.equal(response.status, 200);
    assert.equal(response.json.savedAt, null, text);
  }
  assert.equal((await request(app, 'GET', '/api/brief/2026-02-30/feedback')).status, 404);
});
