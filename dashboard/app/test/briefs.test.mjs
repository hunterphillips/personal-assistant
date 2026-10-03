import assert from 'node:assert/strict';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import {
  BriefArtifactError,
  MAX_BRIEF_BYTES,
  isCalendarDate,
  loadBrief,
  selectLatestBrief,
  validateBriefData,
} from '../lib/briefs.mjs';
import { briefData, fixtureBrief, writeBrief, writeViewer } from './support/brief-fixtures.mjs';
import { tempDir } from './support/harness.mjs';

test('calendar validation includes leap days and rejects malformed or impossible dates', () => {
  assert.equal(isCalendarDate('2024-02-29'), true);
  for (const value of ['2023-02-29', '2026-02-30', '2026-9-05', '2026-09-5', '../2026-09-15']) {
    assert.equal(isCalendarDate(value), false, value);
  }
});

test('selection takes the newest date across data and viewers and ignores lookalikes', async (t) => {
  const dir = await tempDir(t);
  await writeBrief(dir, '2024-02-29');
  await writeBrief(dir, '2026-09-14');
  await writeFile(path.join(dir, 'brief-2026-02-30.json'), '{}');
  await writeFile(path.join(dir, 'brief-2026-9-5.json'), '{}');
  await writeFile(path.join(dir, '.brief-2026-12-31.json.tmp'), '{}');
  await writeFile(path.join(dir, 'brief-2026-12-31.md'), 'invented');
  await writeFile(path.join(dir, 'feedback-2026-12-31.json'), '{}');
  await writeFile(path.join(dir, 'notice-2026-12-31.json'), '{}');
  await mkdir(path.join(dir, 'brief-2026-12-30.json'));
  await symlink(path.join(dir, 'brief-2026-09-14.json'), path.join(dir, 'brief-2026-12-29.json'));
  assert.deepEqual(await selectLatestBrief(dir), { date: '2026-09-14', hasData: true });

  // A newer viewer with no data is the newest brief, reported without data.
  await writeViewer(dir, '2026-09-15');
  assert.deepEqual(await selectLatestBrief(dir), { date: '2026-09-15', hasData: false });
  await writeBrief(dir, '2026-09-15');
  assert.deepEqual(await selectLatestBrief(dir), { date: '2026-09-15', hasData: true });
});

test('no candidates is empty selection while directory failures reject', async (t) => {
  const dir = await tempDir(t);
  assert.equal(await selectLatestBrief(dir), null);
  await assert.rejects(selectLatestBrief(path.join(dir, 'missing')), { code: 'ENOENT' });
});

test('the invented fixture loads with every item in reading order under its section label', async (t) => {
  const dir = await tempDir(t);
  const { data } = await writeBrief(dir, '2026-09-15');
  const brief = await loadBrief(dir, '2026-09-15');
  assert.match(brief.revision, /^[0-9a-f]{64}$/);
  assert.equal(brief.title, data.title);
  assert.match(brief.title, /Invented/);
  assert.deepEqual(brief.opening, data.opening);
  assert.deepEqual(brief.sections, data.sections);
  assert.deepEqual(brief.items.map(({ id, section }) => [id, section]), [
    ['opening', 'Opening'], ['needs-you-1', 'Needs you'], ['needs-you-2', 'Needs you'], ['money-1', 'Money'],
  ]);
});

test('a brief with no opening loads with a null opening', async (t) => {
  const dir = await tempDir(t);
  await writeBrief(dir, '2026-09-15', briefData('2026-09-15', { opening: null }));
  const brief = await loadBrief(dir, '2026-09-15');
  assert.equal(brief.opening, null);
  assert.deepEqual(brief.items.map((item) => item.id), ['invented-1']);
});

test('the shape check refuses anything but the run\'s shape, whole', async () => {
  const base = await fixtureBrief('2026-09-15');
  const section = base.sections[0];
  const cases = {
    'date differs from the name': { ...base, date: '2026-09-14' },
    'unknown key': { ...base, revision: 'x' },
    'missing key': (({ words: _words, ...rest }) => rest)(base),
    'words negative': { ...base, words: -1 },
    'title not text': { ...base, title: 3 },
    'opening with another id': { ...base, opening: { id: 'first', text: 'Invented.' } },
    'empty item text': { ...base, sections: [{ ...section, items: [{ id: 'needs-you-1', text: '  ' }] }] },
    'duplicate item id': { ...base, sections: [section, { id: 'other', label: 'Other', items: [section.items[0]] }] },
    'duplicate section id': { ...base, sections: [section, { ...section, items: [] }] },
    'item id with a slash': { ...base, sections: [{ ...section, items: [{ id: '../x', text: 'Invented.' }] }] },
    'text over 8000 characters': { ...base, sections: [{ ...section, items: [{ id: 'a-1', text: 'x'.repeat(8001) }] }] },
    'more than 20 sections': { ...base, sections: Array.from({ length: 21 }, (_, i) => ({ id: `s-${i}`, label: 'S', items: [] })) },
    'more than 40 items in a section': {
      ...base, sections: [{ ...section, items: Array.from({ length: 41 }, (_, i) => ({ id: `a-${i}`, text: 'x' })) }],
    },
    'more than 200 items': {
      ...base,
      opening: null,
      sections: Array.from({ length: 6 }, (_, s) => ({
        id: `s-${s}`, label: 'S', items: Array.from({ length: 34 }, (_, i) => ({ id: `s-${s}-${i}`, text: 'x' })),
      })),
    },
    'sections not a list': { ...base, sections: {} },
    'not an object': [base],
  };
  for (const [label, value] of Object.entries(cases)) {
    assert.throws(() => validateBriefData(value, '2026-09-15'),
      (error) => error instanceof BriefArtifactError && error.state === 'unsupported' && error.code === 'invalid_brief', label);
  }
});

test('load refuses invalid JSON, invalid dates, symlinks, directories, and files over 2 MiB', async (t) => {
  const dir = await tempDir(t);
  await writeBrief(dir, '2026-09-15');
  await symlink(path.join(dir, 'brief-2026-09-15.json'), path.join(dir, 'brief-2026-09-16.json'));
  await mkdir(path.join(dir, 'brief-2026-09-17.json'));
  await writeFile(path.join(dir, 'brief-2026-09-18.json'), Buffer.alloc(MAX_BRIEF_BYTES + 1, 0x20));
  await writeFile(path.join(dir, 'brief-2026-09-19.json'), '{"date": "2026-09-19", ');

  await assert.rejects(loadBrief(dir, '../2026-09-15'), { code: 'invalid_brief_date' });
  await assert.rejects(loadBrief(dir, '2026-09-14'), { code: 'brief_not_found' });
  await assert.rejects(loadBrief(dir, '2026-09-16'), { code: 'brief_not_found' });
  await assert.rejects(loadBrief(dir, '2026-09-17'), { code: 'brief_not_found' });
  await assert.rejects(loadBrief(dir, '2026-09-18'),
    (error) => error.state === 'oversized' && error.code === 'brief_oversized');
  await assert.rejects(loadBrief(dir, '2026-09-19'),
    (error) => error.state === 'unsupported' && error.code === 'invalid_brief' && /^[0-9a-f]{64}$/.test(error.revision));
});

test('load hashes the bytes it parses and detects a changed revision', async (t) => {
  const dir = await tempDir(t);
  await writeBrief(dir, '2026-09-15');
  const first = await loadBrief(dir, '2026-09-15');
  assert.equal((await loadBrief(dir, '2026-09-15', { expectedRevision: first.revision })).revision, first.revision);
  await writeBrief(dir, '2026-09-15', briefData('2026-09-15'));
  await assert.rejects(loadBrief(dir, '2026-09-15', { expectedRevision: first.revision }),
    (error) => error.code === 'revision_conflict' && error.revision !== first.revision);
});

test('selection and loading respect an aborted signal', async (t) => {
  const dir = await tempDir(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(selectLatestBrief(dir, { signal: controller.signal }), { name: 'AbortError' });
  await assert.rejects(loadBrief(dir, '2026-09-15', { signal: controller.signal }), { name: 'AbortError' });
});
