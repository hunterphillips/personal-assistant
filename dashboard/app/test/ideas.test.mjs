import assert from 'node:assert/strict';
import { chmod, cp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { LIMITS } from '../lib/config.mjs';
import { IdeasError, createIdeas } from '../lib/ideas.mjs';
import { tempDir } from './support/harness.mjs';

const FIXTURE = fileURLToPath(new URL('./fixtures/ideas/', import.meta.url));

async function copy(t) {
  const root = await tempDir(t);
  const dir = path.join(root, 'items');
  await cp(FIXTURE, dir, { recursive: true });
  return { root, dir, marksFile: path.join(root, 'marks.json') };
}

function store(paths, extra = {}) {
  return createIdeas({ ...paths, limits: LIMITS, zone: 'America/Chicago', now: () => new Date('2026-10-03T12:00:00-05:00'), ...extra });
}

function item(id, extra = {}) {
  return { id, title: `Fixture ${id}`, text: 'Invented fixture content.', kind: 'agent', agents: ['assistant'], source: null, ...extra };
}

test('runs read newest first and the result is frozen', async (t) => {
  const ideas = store(await copy(t));
  const result = await ideas.read();
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.runs.map((run) => run.id), ['2026-09-28-myos', '2026-09-21-myos']);
  assert.equal(result.runs[1].items[0].status, 'new');
  assert.ok(Object.isFrozen(result.runs[0].items[0]));
  assert.equal(await ideas.read(), result);
});

test('the first store-wide id wins and dismissed ids stay out of later runs', async (t) => {
  const paths = await copy(t);
  await writeFile(paths.marksFile, JSON.stringify({ 'fixture-reading-tool': { status: 'dismissed', at: '2026-09-29T00:00:00Z' } }));
  await writeFile(path.join(paths.dir, '2026-10-01-myos.json'), JSON.stringify({
    producer: 'myos', date: '2026-10-01', items: [item('fixture-weekly-map'), item('fixture-reading-tool'), item('fixture-new')],
  }));
  const result = await store(paths).read();
  assert.deepEqual(result.runs[0].items.map((entry) => entry.id), ['fixture-new']);
  assert.equal(result.runs[1].items.some((entry) => entry.id === 'fixture-reading-tool'), false);
  assert.equal(result.runs[2].items.some((entry) => entry.id === 'fixture-weekly-map'), true);
});

test('an id outside the newest-run window still owns its first week', async (t) => {
  const paths = await copy(t);
  await writeFile(path.join(paths.dir, '2026-01-01-myos.json'), JSON.stringify({
    producer: 'myos', date: '2026-01-01', items: [item('old-owner')],
  }));
  for (let day = 1; day <= 31; day += 1) {
    const date = `2026-08-${String(day).padStart(2, '0')}`;
    await writeFile(path.join(paths.dir, `${date}-manual.json`), JSON.stringify({ producer: 'manual', date, items: [] }));
  }
  await writeFile(path.join(paths.dir, '2026-10-01-myos.json'), JSON.stringify({
    producer: 'myos', date: '2026-10-01', items: [item('old-owner'), item('shown')],
  }));
  const result = await store(paths).read();
  assert.equal(result.runs.length, LIMITS.feedFiles);
  assert.deepEqual(result.runs[0].items.map((entry) => entry.id), ['shown']);
});

test('add keeps the first line and remainder unchanged and reads it back at once', async (t) => {
  const paths = await copy(t);
  const ideas = store(paths);
  const added = await ideas.add('A Fixture Idea\n  Keep this exactly.\nAnd this.');
  assert.deepEqual([added.id, added.title, added.text, added.status],
    ['a-fixture-idea', 'A Fixture Idea', '  Keep this exactly.\nAnd this.', 'new']);
  assert.equal((await ideas.find('a-fixture-idea')).text, '  Keep this exactly.\nAnd this.');
  const written = JSON.parse(await readFile(path.join(paths.dir, '2026-09-28-manual.json'), 'utf8'));
  assert.equal(written.items[0].text, '  Keep this exactly.\nAnd this.');
});

test('add makes ids unique against old files and marks', async (t) => {
  const paths = await copy(t);
  await writeFile(paths.marksFile, JSON.stringify({ 'same-title-2': { status: 'dismissed', at: '2026-09-01T00:00:00Z' } }));
  await writeFile(path.join(paths.dir, '2026-09-01-myos.json'), JSON.stringify({
    producer: 'myos', date: '2026-09-01', items: [item('same-title', { title: 'Same title' })],
  }));
  const added = await store(paths).add('Same title');
  assert.equal(added.id, 'same-title-3');
  assert.equal(added.text, '');
});

test('mark writes an atomic private marks file and refuses an unknown id', async (t) => {
  const paths = await copy(t);
  const ideas = store(paths);
  await ideas.mark('fixture-agent-card', { status: 'taken', agent: 'assistant' });
  assert.equal((await ideas.find('fixture-agent-card')).status, 'taken');
  assert.equal((await stat(paths.marksFile)).mode & 0o777, 0o600);
  await assert.rejects(() => ideas.mark('missing', { status: 'dismissed' }), (error) => error instanceof IdeasError && error.code === 'no_such_item');
});

test('a saved mark reads back as saved and the idea stays in its run when a later run repeats its id', async (t) => {
  const paths = await copy(t);
  await writeFile(paths.marksFile, JSON.stringify({ 'fixture-reading-tool': { status: 'saved', at: '2026-10-06T14:12:00.000Z' } }));
  await writeFile(path.join(paths.dir, '2026-10-05-myos.json'), JSON.stringify({
    producer: 'myos', date: '2026-10-05', items: [item('fixture-reading-tool'), item('fixture-later')],
  }));
  const ideas = store(paths);
  const result = await ideas.read();
  assert.deepEqual(result.runs.map((run) => run.id), ['2026-10-05-myos', '2026-09-28-myos', '2026-09-21-myos']);
  assert.deepEqual(result.runs[0].items.map((entry) => entry.id), ['fixture-later']);
  const saved = result.runs[2].items.find((entry) => entry.id === 'fixture-reading-tool');
  assert.equal(saved.status, 'saved');
  assert.equal((await ideas.find('fixture-reading-tool')).status, 'saved');
});

test('the marks reader drops statuses other than taken, dismissed, and saved', async (t) => {
  const paths = await copy(t);
  await writeFile(paths.marksFile, JSON.stringify({ 'fixture-reading-tool': { status: 'kept', at: '2026-10-06T14:12:00.000Z' } }));
  assert.equal((await store(paths).find('fixture-reading-tool')).status, 'new');
});

test('starting a saved idea overwrites the mark with taken', async (t) => {
  const paths = await copy(t);
  const ideas = store(paths);
  await ideas.mark('fixture-agent-card', { status: 'saved' });
  await ideas.mark('fixture-agent-card', { status: 'taken', agent: 'assistant' });
  const marks = JSON.parse(await readFile(paths.marksFile, 'utf8'));
  assert.deepEqual([marks['fixture-agent-card'].status, marks['fixture-agent-card'].agent], ['taken', 'assistant']);
});

test('unmark removes the entry atomically and refuses an unknown id', async (t) => {
  const paths = await copy(t);
  const ideas = store(paths);
  await ideas.mark('fixture-agent-card', { status: 'saved' });
  await ideas.mark('fixture-reading-tool', { status: 'saved' });
  const item = await ideas.unmark('fixture-agent-card');
  assert.equal(item.status, 'new');
  const marks = JSON.parse(await readFile(paths.marksFile, 'utf8'));
  assert.deepEqual(Object.keys(marks), ['fixture-reading-tool']);
  assert.equal((await stat(paths.marksFile)).mode & 0o777, 0o600);
  await assert.rejects(() => ideas.unmark('missing'), (error) => error instanceof IdeasError && error.code === 'no_such_item');
});

test('writes preserve a corrupt marks file', async (t) => {
  const paths = await copy(t);
  await writeFile(paths.marksFile, '{corrupt fixture marks');
  const ideas = store(paths);
  await assert.rejects(() => ideas.mark('fixture-agent-card', { status: 'dismissed' }), { code: 'marks_invalid' });
  await assert.rejects(() => ideas.add('Fixture blocked by marks'), { code: 'marks_invalid' });
  await assert.rejects(() => ideas.unmark('fixture-agent-card'), { code: 'marks_invalid' });
  assert.equal(await readFile(paths.marksFile, 'utf8'), '{corrupt fixture marks');
});

test('add refuses a manual run that would cross the file cap', async (t) => {
  const paths = await copy(t);
  const limits = { ...LIMITS, ideasFileBytes: 700 };
  const ideas = store(paths, { limits });
  await assert.rejects(() => ideas.add('x'.repeat(650)), { code: 'ideas_file_full' });
  await assert.rejects(() => readFile(path.join(paths.dir, '2026-09-28-manual.json')), { code: 'ENOENT' });
});

test('bad JSON, oversized files, missing fields, and a missing directory are sentences while other runs read', async (t) => {
  const paths = await copy(t);
  await writeFile(path.join(paths.dir, '2026-10-01-myos.json'), '{bad');
  await writeFile(path.join(paths.dir, '2026-10-02-myos.json'), 'x'.repeat(LIMITS.ideasFileBytes + 1));
  await writeFile(path.join(paths.dir, '2026-10-03-myos.json'), JSON.stringify({
    producer: 'myos', date: '2026-10-03', items: [{ id: 'missing-title' }],
  }));
  const result = await store(paths).read();
  assert.ok(result.runs.length > 0);
  assert.equal(result.problems.some((text) => text === '2026-10-01-myos.json is not JSON.'), true);
  assert.equal(result.problems.some((text) => text.includes('larger than 256 KiB')), true);
  assert.equal(result.problems.some((text) => text.includes('has 1 item that could not be shown')), true);
  const missing = await store({ dir: path.join(paths.root, 'gone'), marksFile: paths.marksFile }).read();
  assert.deepEqual(missing.problems, ['The ideas directory is missing.']);
});

test('unknown kinds become null and manual titles are not capped at producer length', async (t) => {
  const paths = await copy(t);
  await writeFile(path.join(paths.dir, '2026-10-01-myos.json'), JSON.stringify({
    producer: 'myos', date: '2026-10-01', items: [item('other-kind', { kind: 'other' })],
  }));
  assert.equal((await store(paths).find('other-kind')).kind, null);
  const title = 'x'.repeat(LIMITS.ideaTitleChars + 1);
  assert.equal((await store(paths).add(title)).title, title);
});

test('a missing kind and an empty producer text are invalid fields', async (t) => {
  const paths = await copy(t);
  const noKind = item('no-kind');
  delete noKind.kind;
  await writeFile(path.join(paths.dir, '2026-10-01-myos.json'), JSON.stringify({
    producer: 'myos', date: '2026-10-01', items: [noKind, item('empty-text', { text: '' })],
  }));
  const result = await store(paths).read();
  assert.deepEqual(result.runs[0].items, []);
  assert.equal(result.problems.includes('2026-10-01-myos.json has 2 items that could not be shown.'), true);
});

test('producerAgent skips manual and unknown producers and falls back', async (t) => {
  const paths = await copy(t);
  await writeFile(path.join(paths.dir, '2026-10-01-manual.json'), JSON.stringify({ producer: 'manual', date: '2026-10-01', items: [] }));
  const agents = [
    { id: 'assistant', kind: 'persona', provider: 'claude', pinned: true },
    { id: 'myos', kind: 'persona', provider: 'claude' },
  ];
  assert.equal(await store(paths).producerAgent(agents), 'myos');
  assert.equal(await store(paths).producerAgent(agents.slice(0, 1)), 'assistant');
});

test('add and mark serialize their writes', async (t) => {
  const paths = await copy(t);
  await chmod(paths.root, 0o700);
  const ideas = store(paths);
  await Promise.all([
    ideas.add('Concurrent fixture\nText'),
    ideas.mark('fixture-agent-card', { status: 'dismissed' }),
  ]);
  assert.equal(await ideas.find('concurrent-fixture') !== null, true);
  assert.equal(await ideas.find('fixture-agent-card'), null);
});

test('a replaced mark hides the item and keeps its id taken; a run keeps its week', async (t) => {
  const paths = await copy(t);
  await writeFile(paths.marksFile, JSON.stringify({ 'fixture-agent-card': { status: 'replaced', at: '2026-10-01T00:00:00Z' } }));
  await writeFile(path.join(paths.dir, '2026-10-02-myos.json'), JSON.stringify({
    producer: 'myos', date: '2026-10-02', week: '2026-09-21', items: [item('fixture-later')],
  }));
  const ideas = store(paths);
  const result = await ideas.read();
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.runs.find((run) => run.id === '2026-09-28-myos').items, []);
  const later = result.runs.find((run) => run.id === '2026-10-02-myos');
  assert.equal(later.week, '2026-09-21');
  assert.equal(Object.hasOwn(result.runs.find((run) => run.id === '2026-09-21-myos'), 'week'), false);
  assert.equal(await ideas.find('fixture-agent-card'), null);
  assert.equal((await ideas.add('Fixture agent card')).id, 'fixture-agent-card-2');
});

test('a run whose week is not a non-empty string is not an ideas run', async (t) => {
  const paths = await copy(t);
  await writeFile(path.join(paths.dir, '2026-10-02-myos.json'), JSON.stringify({
    producer: 'myos', date: '2026-10-02', week: 42, items: [item('fixture-later')],
  }));
  const result = await store(paths).read();
  assert.deepEqual(result.problems, ['2026-10-02-myos.json is not an ideas run.']);
});

test('replaceWeek retires only that week\'s new ideas in one write and answers with its saved titles', async (t) => {
  const paths = await copy(t);
  await writeFile(paths.marksFile, JSON.stringify({
    'fixture-weekly-map': { status: 'saved', at: '2026-09-22T00:00:00Z' },
    'fixture-taken': { status: 'taken', at: '2026-09-22T00:00:00Z', agent: 'assistant' },
  }));
  // Week of September 21 by its date, by its week, and Hunter's own; one other week.
  await writeFile(path.join(paths.dir, '2026-09-24-myos.json'), JSON.stringify({
    producer: 'myos', date: '2026-09-24', items: [item('fixture-taken'), item('fixture-midweek')],
  }));
  await writeFile(path.join(paths.dir, '2026-10-02-myos.json'), JSON.stringify({
    producer: 'myos', date: '2026-10-02', week: '2026-09-21', items: [item('fixture-written-later')],
  }));
  await writeFile(path.join(paths.dir, '2026-09-21-manual.json'), JSON.stringify({
    producer: 'manual', date: '2026-09-21', items: [item('fixture-own', { kind: null, agents: [] })],
  }));
  const ideas = store(paths);
  const answer = await ideas.replaceWeek('2026-09-21');
  assert.deepEqual(answer.replaced.sort(), ['fixture-midweek', 'fixture-reading-tool', 'fixture-written-later']);
  assert.deepEqual(answer.saved, [{ id: 'fixture-weekly-map', title: 'Fixture weekly map' }]);
  const marks = JSON.parse(await readFile(paths.marksFile, 'utf8'));
  assert.deepEqual(Object.keys(marks).sort(), ['fixture-midweek', 'fixture-reading-tool', 'fixture-taken', 'fixture-weekly-map', 'fixture-written-later']);
  assert.equal(marks['fixture-midweek'].status, 'replaced');
  assert.equal(marks['fixture-midweek'].at, '2026-10-03T17:00:00.000Z');
  assert.equal(marks['fixture-weekly-map'].status, 'saved');
  assert.equal(marks['fixture-taken'].status, 'taken');
  const shown = (await ideas.read()).runs.flatMap((run) => run.items.map((entry) => entry.id)).sort();
  assert.deepEqual(shown, ['fixture-agent-card', 'fixture-own', 'fixture-taken', 'fixture-weekly-map']);

  assert.deepEqual(await ideas.replaceWeek('2026-08-03'), { replaced: [], saved: [] });
  await writeFile(paths.marksFile, '[');
  await assert.rejects(() => store(paths).replaceWeek('2026-09-21'), { code: 'marks_invalid' });
});

test('a run with an impossible date still reads', async (t) => {
  const paths = await copy(t);
  await writeFile(path.join(paths.dir, '2026-10-02-myos.json'), JSON.stringify({ producer: 'myos', date: '2026-13-45', items: [item('fixture-odd')] }));
  const result = await store(paths).read();
  assert.deepEqual(result.problems, []);
  assert.equal(result.runs[0].items[0].id, 'fixture-odd');
});
