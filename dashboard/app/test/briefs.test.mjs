import assert from 'node:assert/strict';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import {
  BriefArtifactError,
  MAX_VIEWER_BYTES,
  isCalendarDate,
  loadBriefArtifact,
  parseBriefViewer,
  selectLatestBrief,
} from '../lib/briefs.mjs';
import { fixture, viewerHtml, writeViewer } from './support/brief-fixtures.mjs';
import { tempDir } from './support/harness.mjs';

test('calendar validation includes leap days and rejects malformed or impossible dates', () => {
  assert.equal(isCalendarDate('2024-02-29'), true);
  for (const value of ['2023-02-29', '2026-02-30', '2026-9-05', '2026-09-5', '../2026-09-15']) {
    assert.equal(isCalendarDate(value), false, value);
  }
});

test('selection chooses the largest exact regular viewer date and ignores lookalikes', async (t) => {
  const dir = await tempDir(t);
  await writeViewer(dir, '2024-02-29');
  await writeViewer(dir, '2026-09-14');
  await writeFile(path.join(dir, 'viewer-2026-02-30.html'), 'invalid date');
  await writeFile(path.join(dir, 'viewer-2026-9-5.html'), 'bad width');
  await writeFile(path.join(dir, 'viewer-2026-09-15.html.tmp'), 'temporary');
  await writeFile(path.join(dir, 'build-2026-12-31.py'), 'invented');
  await writeFile(path.join(dir, 'viewer-2026-12-31.md'), 'invented');
  await mkdir(path.join(dir, 'viewer-2026-12-30.html'));
  await symlink(path.join(dir, 'viewer-2026-09-14.html'), path.join(dir, 'viewer-2026-12-29.html'));
  assert.deepEqual(await selectLatestBrief(dir), { date: '2026-09-14', name: 'viewer-2026-09-14.html' });
});

test('no candidates is empty selection while directory failures reject', async (t) => {
  const dir = await tempDir(t);
  assert.equal(await selectLatestBrief(dir), null);
  await assert.rejects(selectLatestBrief(path.join(dir, 'missing')), { code: 'ENOENT' });
});

test('supported text fixture parses marker-like string content and preserves its key', async () => {
  const html = await fixture('viewer-text.html');
  const parsed = parseBriefViewer(Buffer.from(html), '2026-09-15');
  assert.equal(parsed.key, 'db-items-2026-09-15');
  assert.deepEqual(parsed.items.map(({ id, section, shape }) => ({ id, section, shape })), [
    { id: 'alpha', section: 'Needs you', shape: 'text' },
    { id: 'beta', section: 'Money', shape: 'text' },
  ]);
  assert.match(parsed.items[0].text, /; const KEY/);
});

test('supported lede and body fixture uses lede as feedback text and keeps suffix', async () => {
  const html = await fixture('viewer-lede.html');
  const parsed = parseBriefViewer(Buffer.from(html), '2026-09-11');
  assert.equal(parsed.key, 'db-items-2026-09-11-v3');
  assert.deepEqual(parsed.items[0], {
    id: 'legacy', section: 'Review', text: 'Invented legacy line.', shape: 'lede',
  });
});

test('storage key suffixes after a separator are accepted and preserved', () => {
  for (const key of ['db-items-2026-09-15-v3', 'db-items-2026-09-15.rev2', 'db-items-2026-09-15_b']) {
    const html = viewerHtml({ date: '2026-09-15', key, items: [{ sec: 'A', id: 'one', text: 'Item.' }] });
    assert.equal(parseBriefViewer(Buffer.from(html), '2026-09-15').key, key);
  }
});

test('a leading byte order mark keeps the script end at the true byte offset', () => {
  const html = viewerHtml({ date: '2026-09-15', items: [{ sec: 'A', id: 'one', text: 'Unicode café.' }] });
  const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(html)]);
  const parsed = parseBriefViewer(bytes, '2026-09-15');
  const close = Buffer.from('</script>');
  assert.equal(parsed.scriptEndByte, bytes.indexOf(close) + close.length);
  assert.equal(bytes.subarray(parsed.scriptEndByte).toString(), '\n</body>\n</html>\n');
});

test('partial and incompatible viewers fail with explicit states', () => {
  const valid = viewerHtml({
    date: '2026-09-15',
    items: [{ sec: 'Invented', id: 'one', text: 'Item.' }],
  });
  const cases = [
    ['truncated ITEMS', valid.replace('}];\nconst KEY', '}\nconst KEY'), 'incomplete', 'truncated_items_array'],
    ['missing KEY', valid.replace(/const KEY[^\n]+\n/, ''), 'incomplete', 'missing_storage_key'],
    ['key date mismatch', valid.replace('db-items-2026-09-15', 'db-items-2026-09-14'), 'unsupported', 'storage_key_date_mismatch'],
    ['key date with trailing digit', valid.replace("'db-items-2026-09-15'", "'db-items-2026-09-150'"), 'unsupported', 'storage_key_date_mismatch'],
    ['key suffix without separator', valid.replace("'db-items-2026-09-15'", "'db-items-2026-09-15v3'"), 'unsupported', 'storage_key_date_mismatch'],
    ['second ITEMS declaration', valid.replace('let fb = {};', 'let fb = {};\nconst ITEMS = [];'), 'unsupported', 'duplicate_items_declaration'],
    ['DATA layout', valid.replace('const ITEMS', 'const DATA'), 'unsupported', 'unsupported_data_layout'],
    ['missing controls', viewerHtml({ date: '2026-09-15', items: [], controls: false }), 'unsupported', 'missing_viewer_controls'],
    ['two scripts', valid.replace('</body>', '<script>void 0;</script>\n</body>'), 'unsupported', 'incompatible_script_boundaries'],
  ];
  for (const [label, html, state, code] of cases) {
    assert.throws(() => parseBriefViewer(Buffer.from(html), '2026-09-15'),
      (error) => error instanceof BriefArtifactError && error.state === state && error.code === code, label);
  }
});

test('item validation rejects duplicate IDs, invalid fields, and more than 200 items', () => {
  const cases = [
    [{ sec: 'A', id: 'same', text: 'One' }, { sec: 'A', id: 'same', text: 'Two' }],
    [{ sec: '', id: 'one', text: 'One' }],
    [{ sec: 'A', id: 'one', lede: 'Line without body' }],
    Array.from({ length: 201 }, (_, index) => ({ sec: 'A', id: `id-${index}`, text: 'Item' })),
  ];
  for (const items of cases) {
    const html = viewerHtml({ date: '2026-09-15', items });
    assert.throws(() => parseBriefViewer(Buffer.from(html), '2026-09-15'), BriefArtifactError);
  }
});

test('load rejects invalid dates, symlinks, nonregular files, and viewers over 2 MiB', async (t) => {
  const dir = await tempDir(t);
  await writeViewer(dir, '2026-09-15');
  await symlink(path.join(dir, 'viewer-2026-09-15.html'), path.join(dir, 'viewer-2026-09-16.html'));
  await mkdir(path.join(dir, 'viewer-2026-09-17.html'));
  await writeFile(path.join(dir, 'viewer-2026-09-18.html'), Buffer.alloc(MAX_VIEWER_BYTES + 1, 0x61));

  await assert.rejects(loadBriefArtifact(dir, '../2026-09-15'), { code: 'invalid_brief_date' });
  await assert.rejects(loadBriefArtifact(dir, '2026-09-16'), { code: 'brief_not_found' });
  await assert.rejects(loadBriefArtifact(dir, '2026-09-17'), { code: 'brief_not_found' });
  await assert.rejects(loadBriefArtifact(dir, '2026-09-18'),
    (error) => error.state === 'oversized' && error.code === 'brief_oversized');
});

test('load hashes the same bytes it parses and detects a changed revision', async (t) => {
  const dir = await tempDir(t);
  await writeViewer(dir, '2026-09-15');
  const first = await loadBriefArtifact(dir, '2026-09-15');
  assert.match(first.revision, /^[0-9a-f]{64}$/);
  await writeViewer(dir, '2026-09-15', {
    items: [{ sec: 'Invented', id: 'two', text: 'Replacement.' }],
  });
  await assert.rejects(loadBriefArtifact(dir, '2026-09-15', { expectedRevision: first.revision }),
    (error) => error.code === 'revision_conflict' && error.revision !== first.revision);
});

test('selection and loading respect an aborted signal', async (t) => {
  const dir = await tempDir(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(selectLatestBrief(dir, { signal: controller.signal }), { name: 'AbortError' });
  await assert.rejects(loadBriefArtifact(dir, '2026-09-15', { signal: controller.signal }), { name: 'AbortError' });
});
