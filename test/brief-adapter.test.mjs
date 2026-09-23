import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import { BRIEF_CSP, adaptViewer, createBriefRoutes } from '../lib/brief-adapter.mjs';
import { MAX_VIEWER_BYTES, loadBriefArtifact } from '../lib/briefs.mjs';
import { request, startApp, tempDir } from './support/harness.mjs';
import { viewerHtml, writeViewer } from './support/brief-fixtures.mjs';

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

function feedbackBody(artifact, overrides = {}) {
  return {
    date: artifact.date,
    revision: artifact.revision,
    overall: '',
    items: artifact.items.map((item) => ({ id: item.id, mark: null, note: '' })),
    ...overrides,
  };
}

async function postFeedback(app, body) {
  return request(app, 'POST', '/api/brief/feedback', {
    headers: { origin: app.origin, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('latest route returns ready metadata and an exact revision URL', async (t) => {
  const dir = await tempDir(t);
  await writeViewer(dir, '2026-09-14');
  await writeViewer(dir, '2026-09-15');
  const artifact = await loadBriefArtifact(dir, '2026-09-15');
  const app = await makeApp(t, dir);
  const response = await request(app, 'GET', '/api/brief/latest');
  assert.equal(response.status, 200);
  assert.deepEqual(response.json, {
    state: 'ready',
    date: '2026-09-15',
    revision: artifact.revision,
    url: `/embedded/brief/2026-09-15?revision=${artifact.revision}`,
  });
});

test('newest matching artifact reports its failure state without falling back', async (t) => {
  const dir = await tempDir(t);
  await writeViewer(dir, '2026-09-14');
  const broken = viewerHtml({ date: '2026-09-15', items: [] }).replace('const ITEMS', 'const DATA');
  await writeFile(path.join(dir, 'viewer-2026-09-15.html'), broken);
  const routes = createBriefRoutes({ briefsDir: dir });
  const metadata = await routes.latestMetadata({});
  assert.equal(metadata.state, 'unsupported');
  assert.equal(metadata.date, '2026-09-15');
  assert.match(metadata.revision, /^[0-9a-f]{64}$/);
});

test('latest metadata reports empty, incomplete, and oversized exactly', async (t) => {
  const empty = await tempDir(t);
  assert.deepEqual(await createBriefRoutes({ briefsDir: empty }).latestMetadata({}), { state: 'empty' });

  const incomplete = await tempDir(t);
  await writeFile(path.join(incomplete, 'viewer-2026-09-15.html'),
    viewerHtml({ date: '2026-09-15', items: [] }).replace(/const KEY[^\n]+\n/, ''));
  assert.equal((await createBriefRoutes({ briefsDir: incomplete }).latestMetadata({})).state, 'incomplete');

  const oversized = await tempDir(t);
  await writeFile(path.join(oversized, 'viewer-2026-09-15.html'), Buffer.alloc(MAX_VIEWER_BYTES + 1, 0x61));
  assert.deepEqual(await createBriefRoutes({ briefsDir: oversized }).latestMetadata({}), {
    state: 'oversized', date: '2026-09-15',
  });
});

test('directory read errors reject rather than masquerading as empty', async (t) => {
  const parent = await tempDir(t);
  const routes = createBriefRoutes({ briefsDir: path.join(parent, 'missing') });
  await assert.rejects(routes.latestMetadata({}), { code: 'ENOENT' });
});

test('embedded route injects config and classic bridge after the original script with child CSP', async (t) => {
  const dir = await tempDir(t);
  const { html } = await writeViewer(dir, '2026-09-15', {
    items: [{ sec: 'Invented', id: 'one', text: 'Unicode café.' }],
  });
  const artifact = await loadBriefArtifact(dir, '2026-09-15');
  const app = await makeApp(t, dir);
  const response = await request(app, 'GET', `/embedded/brief/2026-09-15?revision=${artifact.revision}`);
  assert.equal(response.status, 200);
  assert.equal(response.headers['content-security-policy'], BRIEF_CSP);
  assert.match(BRIEF_CSP, /script-src 'self' 'unsafe-inline'/);
  assert.match(BRIEF_CSP, /style-src 'self' 'unsafe-inline'/);
  assert.match(BRIEF_CSP, /connect-src 'self'/);
  assert.match(BRIEF_CSP, /frame-ancestors 'self'/);

  const originalEnd = html.indexOf('</script>') + '</script>'.length;
  const configAt = response.text.indexOf('<script id="brief-bridge-config" type="application/json">');
  const bridgeAt = response.text.indexOf('<script src="/assets/brief-bridge.js"></script>');
  assert.equal(response.text.slice(0, configAt).trimEnd(), html.slice(0, originalEnd));
  assert.ok(configAt > originalEnd);
  assert.ok(bridgeAt > configAt);
  assert.equal(response.text.slice(bridgeAt + '<script src="/assets/brief-bridge.js"></script>'.length), html.slice(originalEnd));
  assert.match(response.text, new RegExp(`"revision":"${artifact.revision}"`));
});

test('adapter JSON configuration escapes less-than characters', () => {
  const bytes = Buffer.from('<script></script></body></html>');
  const output = adaptViewer({ date: '</script>', revision: '<revision>', bytes, scriptEndByte: 17 }).toString();
  assert.match(output, /\\u003c\/script>/);
  assert.match(output, /\\u003crevision>/);
});

test('embedded route returns 404 for missing and 409 after same-date replacement or for an oversized viewer', async (t) => {
  const dir = await tempDir(t);
  await writeViewer(dir, '2026-09-15');
  const artifact = await loadBriefArtifact(dir, '2026-09-15');
  const app = await makeApp(t, dir);
  const missing = await request(app, 'GET', `/embedded/brief/2026-09-14?revision=${artifact.revision}`);
  assert.equal(missing.status, 404);
  assert.deepEqual(missing.json, { error: 'brief_not_found' });
  await writeViewer(dir, '2026-09-15', { items: [{ sec: 'New', id: 'new', text: 'Replacement.' }] });
  assert.equal((await request(app, 'GET', `/embedded/brief/2026-09-15?revision=${artifact.revision}`)).status, 409);
  await writeFile(path.join(dir, 'viewer-2026-09-13.html'), Buffer.alloc(MAX_VIEWER_BYTES + 1, 0x61));
  const oversized = await request(app, 'GET', `/embedded/brief/2026-09-13?revision=${artifact.revision}`);
  assert.equal(oversized.status, 409);
  assert.deepEqual(oversized.json, { error: 'brief_oversized' });
});

test('embedded route injects after the original script when the viewer starts with a BOM', async (t) => {
  const dir = await tempDir(t);
  const html = viewerHtml({ date: '2026-09-15', items: [{ sec: 'A', id: 'one', text: 'Unicode café.' }] });
  const original = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(html)]);
  await writeFile(path.join(dir, 'viewer-2026-09-15.html'), original);
  const artifact = await loadBriefArtifact(dir, '2026-09-15');
  const app = await makeApp(t, dir);
  const response = await request(app, 'GET', `/embedded/brief/2026-09-15?revision=${artifact.revision}`);
  assert.equal(response.status, 200);
  const adapted = Buffer.from(response.text.startsWith('\ufeff') ? response.text : `\ufeff${response.text}`);
  const close = Buffer.from('</script>');
  const originalEnd = original.indexOf(close) + close.length;
  assert.deepEqual(adapted.subarray(0, originalEnd), original.subarray(0, originalEnd));
  assert.match(adapted.subarray(originalEnd).toString(),
    /^\n<script id="brief-bridge-config" type="application\/json">[^<]*<\/script>\n<script src="\/assets\/brief-bridge.js"><\/script>\n<\/body>\n<\/html>\n$/);
});

test('feedback route saves verified Markdown and rejects invalid, missing, stale, and oversized input', async (t) => {
  const dir = await tempDir(t);
  await writeViewer(dir, '2026-09-15', {
    items: [
      { sec: 'Needs you', id: 'one', text: 'Invented text.' },
      { sec: 'Needs you', id: 'two', lede: 'Legacy invented line.', body: 'Detail.' },
    ],
  });
  const artifact = await loadBriefArtifact(dir, '2026-09-15');
  const app = await makeApp(t, dir);
  const value = feedbackBody(artifact, {
    overall: 'Overall thought',
    items: [
      { id: 'one', mark: 'approved', note: 'Line one\nline two' },
      { id: 'two', mark: 'dismissed', note: '' },
    ],
  });
  const saved = await postFeedback(app, value);
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.json, { saved: true, date: '2026-09-15' });
  assert.equal(await readFile(path.join(dir, 'feedback-2026-09-15.md'), 'utf8'), [
    '# Brief feedback — 2026-09-15', '', '## Overall', '', 'Overall thought', '',
    '## Needs you', '', '- APPROVED — Invented text.', '  - note: Line one', '    line two',
    '- DISMISSED — Legacy invented line.', '',
  ].join('\n'));

  const existing = await readFile(path.join(dir, 'feedback-2026-09-15.md'), 'utf8');
  assert.equal((await postFeedback(app, { ...value, filename: 'viewer-2026-09-15.html' })).status, 400);
  assert.equal(await readFile(path.join(dir, 'feedback-2026-09-15.md'), 'utf8'), existing);

  const missing = { ...value, date: '2026-09-14' };
  assert.equal((await postFeedback(app, missing)).status, 404);
  assert.equal((await postFeedback(app, { ...value, revision: 'b'.repeat(64) })).status, 409);
  assert.equal((await postFeedback(app, { ...value, overall: 'x'.repeat(8_001) })).status, 413);
});

test('an older tab saves its own date while a stale same-date save preserves existing feedback', async (t) => {
  const dir = await tempDir(t);
  await writeViewer(dir, '2026-09-14');
  await writeViewer(dir, '2026-09-15', { items: [{ sec: 'New', id: 'new', text: 'Newer.' }] });
  const older = await loadBriefArtifact(dir, '2026-09-14');
  const app = await makeApp(t, dir);
  assert.equal((await postFeedback(app, feedbackBody(older))).status, 200);
  assert.match(await readFile(path.join(dir, 'feedback-2026-09-14.md'), 'utf8'), /Invented item/);

  await writeFile(path.join(dir, 'feedback-2026-09-14.md'), 'keep existing');
  await writeViewer(dir, '2026-09-14', { items: [{ sec: 'Changed', id: 'other', text: 'Changed.' }] });
  assert.equal((await postFeedback(app, feedbackBody(older))).status, 409);
  assert.equal(await readFile(path.join(dir, 'feedback-2026-09-14.md'), 'utf8'), 'keep existing');
});

test('bridge is classic JavaScript and contains no content logging', async () => {
  const source = await readFile(new URL('../public/brief-bridge.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\bimport\b|\bexport\b|console\./);
  assert.doesNotMatch(source, /window\.ITEMS|window\.fb/);
  assert.match(source, /credentials:\s*'same-origin'/);
  assert.match(source, /button\.disabled = true/);
  assert.match(source, /getElementById\('overall'\)/);
});
