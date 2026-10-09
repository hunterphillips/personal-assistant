import assert from 'node:assert/strict';
import { chmod, cp, lstat, mkdir, readFile, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { LIMITS } from '../lib/config.mjs';
import { FeedsError, INSIGHTS_MAX, SUGGESTIONS_MAX, TAKEAWAY_MAX, WHY_MAX, createFeeds } from '../lib/feeds.mjs';
import { createSources } from '../lib/sources.mjs';
import { tempDir } from './support/harness.mjs';

// Old-shape runs (<date>-watch.json, one `source` string per item).
const FIXTURE_FEED = fileURLToPath(new URL('./fixtures/feed/', import.meta.url));
const AT = '2026-10-08T12:00:00.000Z';

// A feeds folder with the feed `news` over a fresh copy of the fixture
// runs, and an empty sources folder.
async function stores(t, { limits = LIMITS, log = () => {}, items = true, now } = {}) {
  const root = await tempDir(t);
  const dir = path.join(root, 'feeds');
  const sourcesDir = path.join(root, 'sources');
  const items_ = path.join(dir, 'news', 'items');
  await mkdir(items_, { recursive: true });
  if (items) await cp(FIXTURE_FEED, items_, { recursive: true });
  await writeFeed(dir, { id: 'news', name: 'News', created: AT });
  let feeds = null;
  const sources = createSources({ dir: sourcesDir, limits, usedBy: (id) => feeds.usedBy(id) });
  feeds = createFeeds({ dir, sources, limits, log, ...(now ? { now } : {}) });
  return { dir, items: items_, sources, feeds };
}

function writeFeed(dir, fields) {
  const feed = { version: 1, producer: 'scout', sources: [], active: true, updated: fields.created, ...fields };
  return mkdir(path.join(dir, feed.id), { recursive: true })
    .then(() => writeFile(path.join(dir, feed.id, 'feed.json'), JSON.stringify(feed)));
}

function run(items, date, entries, { name = `${date}.json`, ...extra } = {}) {
  return writeFile(path.join(items, name),
    JSON.stringify({ feed: 'news', producer: 'scout', date, since: null, generated_at: null, items: entries, ...extra }));
}

function item(id, extra = {}) {
  return { id, title: `Title ${id}`, sources: ['invented'], url: 'https://example.com/x', summary: `Summary ${id}`, ...extra };
}

test('old-shape runs read newest first, each source string mapped to names, test and source left behind', async (t) => {
  const logs = [];
  const { feeds } = await stores(t, { log: (entry) => logs.push(entry) });
  const result = await feeds.read('news');
  assert.equal(result.feed.id, 'news');
  assert.equal(result.feed.producer, 'scout');
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.runs.map((entry) => entry.id), ['2026-09-28-watch', '2026-09-21-watch']);
  const [newest] = result.runs;
  assert.deepEqual([newest.producer, newest.date, newest.since, newest.generatedAt, newest.read],
    ['watch', '2026-09-28', '2026-09-14', '2026-09-28T14:47:22-05:00', []]);
  assert.equal(newest.items.length, 8);
  assert.deepEqual(newest.items[0], {
    id: 'watch/2026-09-28/1', title: 'Town council adopts a rule for delivery robots', sources: ['Invented Gazette'],
    url: 'https://example.com/robots', summary: 'The Invented Gazette reports the town adopted a rule for delivery robots on sidewalks.',
    takeaway: null, insights: null, kept: true, image: null, status: 'new', position: 0,
  });
  // "Invented Gazette, Invented Weekly" is two sources.
  assert.deepEqual(newest.items[4].sources, ['Invented Gazette', 'Invented Weekly']);
  assert.equal(newest.items[6].kept, false);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(newest.items[0]));
  assert.deepEqual(logs, []);
});

test('old source names map to the ids of the sources with those names, in any case', async (t) => {
  const { feeds, sources } = await stores(t);
  await sources.create({ name: 'Invented Gazette', kind: 'email', sender: 'gazette@example.com' });
  await sources.create({ name: 'invented weekly', kind: 'rss', url: 'https://example.com/feed' });
  const [newest] = (await feeds.read('news')).runs;
  assert.deepEqual(newest.items[4].sources, ['invented-gazette', 'invented-weekly']);
  assert.deepEqual(newest.items[2].sources, ['Invented Letters']);
  // A source renamed later changes the mapping on the next read.
  await sources.update('invented-gazette', { name: 'The Gazette' });
  assert.deepEqual((await feeds.read('news')).runs[0].items[0].sources, ['Invented Gazette']);
});

test('old source names also map by a source\'s aliases, trimmed and in any case, and a name wins over another\'s alias', async (t) => {
  const { feeds, sources, items } = await stores(t, { items: false });
  await run(items, '2026-10-05', [
    { ...item('a'), sources: undefined, source: 'Weekly A / Daily B' },
    { ...item('b'), sources: undefined, source: 'daily b (weekly a)' },
    { ...item('c'), sources: undefined, source: 'Weekly A' },
  ]);
  await sources.create({ name: 'Daily B', kind: 'rss', url: 'https://example.com/b.xml', aliases: ['  Weekly A  ', 'Daily B (Weekly A)'] });
  const ids = async () => (await feeds.read('news')).runs[0].items.map((entry) => entry.sources);
  assert.deepEqual(await ids(), [['daily-b'], ['daily-b'], ['daily-b']]);
  // A source named Weekly A takes that name back from the alias.
  await sources.create({ name: 'Weekly A', kind: 'rss', url: 'https://example.com/a.xml' });
  assert.deepEqual(await ids(), [['weekly-a', 'daily-b'], ['daily-b'], ['weekly-a']]);
  // An alias removed later changes the mapping on the next read.
  await sources.update('daily-b', { aliases: [] });
  assert.deepEqual(await ids(), [['weekly-a', 'daily-b'], ['daily b (weekly a)'], ['weekly-a']]);
});

test('new-shape runs carry sources, takeaway, insights, and what the run read', async (t) => {
  const { feeds, items } = await stores(t);
  await run(items, '2026-10-09', [
    item('news/2026-10-09/1', { sources: ['latent-space', 'ainews', 'latent-space'], takeaway: 'One sentence.', insights: 'A paragraph.\n\nAnother.', kept: true }),
    item('news/2026-10-09/2', { takeaway: 't'.repeat(TAKEAWAY_MAX), insights: 'i'.repeat(INSIGHTS_MAX) }),
    item('news/2026-10-09/3', { takeaway: 't'.repeat(TAKEAWAY_MAX + 1), insights: 'i'.repeat(INSIGHTS_MAX + 1) }),
    item('news/2026-10-09/4', { takeaway: 7, insights: ['x'] }),
    item('news/2026-10-09/5', { takeaway: '', insights: null }),
  ], { read: ['latent-space', 'ainews', 7, ''] });
  const result = await feeds.read('news');
  assert.deepEqual(result.problems, []);
  const [newest] = result.runs;
  assert.deepEqual([newest.id, newest.producer, newest.read], ['2026-10-09', 'scout', ['latent-space', 'ainews']]);
  assert.deepEqual(newest.items[0].sources, ['latent-space', 'ainews']);
  assert.deepEqual([newest.items[0].takeaway, newest.items[0].insights, newest.items[0].kept], ['One sentence.', 'A paragraph.\n\nAnother.', true]);
  assert.deepEqual([newest.items[1].takeaway.length, newest.items[1].insights.length], [TAKEAWAY_MAX, INSIGHTS_MAX]);
  // Over the caps or the wrong type: dropped, the item kept.
  for (const index of [2, 3, 4]) assert.deepEqual([newest.items[index].takeaway, newest.items[index].insights], [null, null], String(index));
});

test('items that are not the expected shape are left out and counted once per run', async (t) => {
  const { feeds, items } = await stores(t);
  await run(items, '2026-10-05', [
    item('news/2026-10-05/1'),
    item('news/2026-10-05/2', { url: 'ftp://example.com/x' }),
    item('news/2026-10-05/3', { summary: '' }),
    item('news/2026-10-05/1'),
    item('watch/2026-09-28/1'),
    'not an item',
    item('news/2026-10-05/7', { sources: [] }),
    item('news/2026-10-05/8', { sources: ['ok', ''] }),
    { ...item('news/2026-10-05/9'), sources: undefined, source: ' / ' },
    { ...item('news/2026-10-05/10'), sources: undefined },
  ]);
  const result = await feeds.read('news');
  // Newest first, so the newer file keeps the id it took from the older one.
  assert.deepEqual(result.problems, [
    '2026-10-05.json has 8 items that could not be shown.',
    '2026-09-28-watch.json has 1 item that could not be shown.',
  ]);
  assert.deepEqual(result.runs[0].items.map((entry) => entry.id), ['news/2026-10-05/1', 'watch/2026-09-28/1']);
  assert.equal((await feeds.find('news', 'watch/2026-09-28/1')).date, '2026-10-05');
});

test('an item\'s position is its index in the run file, unchanged when an earlier post is dismissed or left out', async (t) => {
  const { feeds, items } = await stores(t, { items: false });
  await run(items, '2026-10-05', [item('a'), 'not an item', item('b'), item('c')]);
  assert.deepEqual((await feeds.read('news')).runs[0].items.map((entry) => [entry.id, entry.position]), [['a', 0], ['b', 2], ['c', 3]]);
  const dismissed = await feeds.mark('news', 'a', 'dismissed');
  assert.deepEqual(dismissed.runs[0].items.map((entry) => [entry.id, entry.position]), [['b', 2], ['c', 3]]);
  assert.equal((await feeds.find('news', 'a')).position, 0);
});

test('an item keeps an http or https image and gets null for anything else', async (t) => {
  const { feeds, items } = await stores(t, { items: false });
  await run(items, '2026-10-05', [
    item('a', { image: 'https://example.com/a.jpg' }), item('b', { image: 'http://example.com/b.png' }),
    item('c', { image: '/images/c.png' }), item('d', { image: 42 }), item('e', { image: 'javascript:alert(1)' }), item('f'),
  ]);
  const result = await feeds.read('news');
  assert.deepEqual(result.runs[0].items.map((entry) => entry.image), ['https://example.com/a.jpg', 'http://example.com/b.png', null, null, null, null]);
});

test('files that are not runs are skipped with one problem each', async (t) => {
  const { feeds, items } = await stores(t);
  await writeFile(path.join(items, '2026-09-30.json'), '{not json');
  await writeFile(path.join(items, '2026-09-29-watch.json'), JSON.stringify({ producer: 'watch', items: [] }));
  await writeFile(path.join(items, '2026-09-27.json'), JSON.stringify([]));
  await writeFile(path.join(items, 'notes.txt'), 'ignored');
  await writeFile(path.join(items, '2026-09-26-Watch.json'), '{}');
  await mkdir(path.join(items, '2026-09-25.json'));
  await symlink(path.join(items, '2026-09-21-watch.json'), path.join(items, '2026-09-24.json'));
  const result = await feeds.read('news');
  assert.deepEqual(result.runs.map((entry) => entry.id), ['2026-09-28-watch', '2026-09-21-watch']);
  assert.deepEqual(result.problems, [
    '2026-09-30.json is not JSON.',
    '2026-09-29-watch.json is not a feed run.',
    '2026-09-27.json is not a feed run.',
    '2026-09-25.json is not a regular file.',
    '2026-09-24.json is not a regular file.',
  ]);
});

test('an unchanged feed returns the same result object; a changed file reads again', async (t) => {
  const { feeds, items } = await stores(t);
  const first = await feeds.read('news');
  assert.equal(await feeds.read('news'), first);
  const [a, b] = await Promise.all([feeds.read('news'), feeds.read('news')]);
  assert.equal(a, b);
  const file = path.join(items, '2026-09-21-watch.json');
  await writeFile(file, (await readFile(file, 'utf8')).replace('A new trail opens along the creek', 'A new trail closes along the creek'));
  await utimes(file, new Date(), new Date(Date.now() + 5000));
  const second = await feeds.read('news');
  assert.notEqual(second, first);
  assert.equal(second.runs[1].items[0].title, 'A new trail closes along the creek');
});

test('a file over the cap and more files than the limit are each one problem', async (t) => {
  const { feeds, items } = await stores(t, { limits: { ...LIMITS, feedFileBytes: 1024, feedFiles: 1 } });
  await run(items, '2026-10-05', [item('x')]);
  const result = await feeds.read('news');
  assert.deepEqual(result.runs.map((entry) => entry.id), ['2026-10-05']);
  assert.deepEqual(result.problems, ['The feed has 3 files; only the newest 1 are shown.']);
  const big = await stores(t, { limits: { ...LIMITS, feedFileBytes: 1024 } });
  assert.deepEqual((await big.feeds.read('news')).problems, ['2026-09-28-watch.json is larger than 1 KiB.']);
});

test('an unreadable file is logged, reported, and read again next time', async (t) => {
  const logs = [];
  const { feeds, items } = await stores(t, { log: (entry) => logs.push(entry) });
  const file = path.join(items, '2026-09-21-watch.json');
  await chmod(file, 0o000);
  const first = await feeds.read('news');
  assert.deepEqual(first.problems, ['2026-09-21-watch.json could not be read.']);
  assert.deepEqual(logs.map((entry) => [entry.event, entry.path]), [['feeds_read_error', 'news/2026-09-21-watch.json']]);
  await chmod(file, 0o600);
  const second = await feeds.read('news');
  assert.deepEqual([second.problems, second.runs.length], [[], 2]);
});

test('a feed with no items folder is one problem; an unknown feed rejects no_such_feed', async (t) => {
  const { feeds, items } = await stores(t);
  await rm(items, { recursive: true });
  const result = await feeds.read('news');
  assert.deepEqual([result.runs, result.problems], [[], ['The feed has no items folder.']]);
  await assert.rejects(feeds.read('other'), (error) => error instanceof FeedsError && error.code === 'no_such_feed');
  await assert.rejects(feeds.read('../x'), { code: 'no_such_feed' });
  assert.equal(await feeds.find('news', 'x'), null);
});

test('list answers each valid feed newest first and names the folders that are not feeds', async (t) => {
  const { feeds, dir } = await stores(t);
  await writeFeed(dir, { id: 'later', name: 'Later', created: '2026-10-09T00:00:00.000Z' });
  await writeFeed(dir, { id: 'broken', name: '', created: AT });
  await mkdir(path.join(dir, 'empty'));
  await mkdir(path.join(dir, '.run'));
  const { feeds: listed, problems } = await feeds.list();
  assert.deepEqual(listed.map((feed) => feed.id), ['later', 'news']);
  assert.deepEqual(Object.keys(listed[1]), ['version', 'id', 'name', 'producer', 'sources', 'active', 'created', 'updated']);
  assert.deepEqual(problems, ['broken/feed.json is not a feed.', 'empty/feed.json is missing.']);
  const none = createFeeds({ dir: path.join(dir, 'nowhere'), sources: { list: async () => [] }, limits: LIMITS });
  assert.deepEqual(await none.list(), { feeds: [], problems: [] });
});

test('save, dismiss, and unsave mark posts; a dismissed post leaves the read but is still found', async (t) => {
  const { feeds, dir } = await stores(t, { now: () => new Date(AT) });
  const saved = await feeds.mark('news', 'watch/2026-09-28/2', 'saved');
  assert.equal(saved.runs[0].items[1].status, 'saved');
  const dismissed = await feeds.mark('news', 'watch/2026-09-28/3', 'dismissed');
  assert.deepEqual(dismissed.runs[0].items.map((entry) => entry.id).includes('watch/2026-09-28/3'), false);
  assert.equal(dismissed.runs[0].items.length, 7);
  assert.equal((await feeds.find('news', 'watch/2026-09-28/3')).status, 'dismissed');
  assert.deepEqual(JSON.parse(await readFile(path.join(dir, 'news', 'marks.json'), 'utf8')), {
    version: 1,
    marks: { 'watch/2026-09-28/2': { status: 'saved', at: AT }, 'watch/2026-09-28/3': { status: 'dismissed', at: AT } },
  });
  assert.equal((await lstat(path.join(dir, 'news', 'marks.json'))).mode & 0o777, 0o600);
  const unsaved = await feeds.unmark('news', 'watch/2026-09-28/2');
  assert.equal(unsaved.runs[0].items[1].status, 'new');
  const undone = await feeds.unmark('news', 'watch/2026-09-28/3');
  assert.equal(undone.runs[0].items.length, 8);
  await assert.rejects(feeds.mark('news', 'nope', 'saved'), { code: 'no_such_item' });
  await assert.rejects(feeds.mark('nope', 'watch/2026-09-28/2', 'saved'), { code: 'no_such_feed' });
  await assert.rejects(feeds.mark('news', 'watch/2026-09-28/2', 'taken'), { code: 'invalid_body' });
});

test('a marks file that cannot be read is a problem and is never replaced', async (t) => {
  const { feeds, dir } = await stores(t);
  await writeFile(path.join(dir, 'news', 'marks.json'), '{ not json');
  const result = await feeds.read('news');
  assert.deepEqual(result.problems, ['marks.json is not a feed marks file.']);
  await assert.rejects(feeds.mark('news', 'watch/2026-09-28/2', 'saved'), { code: 'marks_invalid' });
  assert.equal(await readFile(path.join(dir, 'news', 'marks.json'), 'utf8'), '{ not json');
});

test('create slugs the name, starts with the default sources and the oldest feed\'s producer, and writes the note', async (t) => {
  const { feeds, sources, dir } = await stores(t, { now: () => new Date(AT) });
  await sources.create({ name: 'Priorities', kind: 'file', path: '/invented/priorities.md', default: true });
  await sources.create({ name: 'Latent Space', kind: 'rss', url: 'https://www.latent.space/feed' });
  const feed = await feeds.create({ name: '  Café Notes ', note: 'Keep what matters.\n' });
  assert.deepEqual(feed, {
    version: 1, id: 'cafe-notes', name: 'Café Notes', producer: 'scout', sources: ['priorities'], active: true, created: AT, updated: AT,
  });
  assert.equal(await readFile(path.join(dir, 'cafe-notes', 'note.md'), 'utf8'), 'Keep what matters.\n');
  assert.deepEqual(await readdir(path.join(dir, 'cafe-notes', 'items')), []);
  assert.equal((await feeds.create({ name: 'Café notes', note: '' })).id, 'cafe-notes-2');
  assert.equal((await feeds.create({ name: '!!!', note: '' })).id, 'feed');
  for (const fields of [{ name: '', note: '' }, { name: 'x'.repeat(41), note: '' }, { name: 'a\nb', note: '' }, { name: 'Ok', note: 7 }]) {
    await assert.rejects(feeds.create(fields), { code: 'invalid_body' }, JSON.stringify(fields));
  }
  await assert.rejects(feeds.create({ name: 'Big', note: 'x'.repeat(LIMITS.feedNoteBytes + 1) }), { code: 'note_too_large' });
});

test('a new feed takes the producer the oldest feed names', async (t) => {
  const { feeds, dir } = await stores(t);
  await writeFeed(dir, { id: 'old', name: 'Old', producer: 'other', created: '2026-01-01T00:00:00.000Z' });
  assert.equal((await feeds.create({ name: 'New', note: '' })).producer, 'other');
});

test('update changes the name, the sources, and active; unknown sources are refused by id', async (t) => {
  const { feeds, sources } = await stores(t, { now: () => new Date('2026-10-09T00:00:00.000Z') });
  await sources.create({ name: 'Latent Space', kind: 'rss', url: 'https://www.latent.space/feed' });
  await sources.create({ name: 'Axios', kind: 'email', sender: 'nashville@axios.com' });
  const feed = await feeds.update('news', { name: 'The News', sources: ['axios', 'latent-space'], active: false });
  assert.deepEqual([feed.name, feed.sources, feed.active, feed.created, feed.updated],
    ['The News', ['axios', 'latent-space'], false, AT, '2026-10-09T00:00:00.000Z']);
  assert.deepEqual((await feeds.get('news')).sources, ['axios', 'latent-space']);
  await assert.rejects(feeds.update('news', { sources: ['axios', 'nope', 'gone'] }),
    (error) => error.code === 'unknown_source' && JSON.stringify(error.detail) === JSON.stringify({ sources: ['nope', 'gone'] }));
  for (const fields of [{}, { producer: 'x' }, { sources: ['axios', 'axios'] }, { sources: 'axios' }, { active: 'yes' }, { name: '' }]) {
    await assert.rejects(feeds.update('news', fields), { code: 'invalid_body' }, JSON.stringify(fields));
  }
  await assert.rejects(feeds.update('nope', { active: true }), { code: 'no_such_feed' });
  assert.deepEqual(await feeds.usedBy('axios'), ['news']);
  assert.deepEqual(await feeds.usedBy('other'), []);
});

test('the note reads and writes directly, capped at feedNoteBytes', async (t) => {
  const { feeds, dir } = await stores(t);
  assert.deepEqual(await feeds.readNote('news'), { text: '', updated: null });
  const written = await feeds.writeNote('news', 'Keep only what would change something.\n');
  assert.equal(written.text, 'Keep only what would change something.\n');
  assert.ok(!Number.isNaN(Date.parse(written.updated)));
  assert.equal(await readFile(path.join(dir, 'news', 'note.md'), 'utf8'), 'Keep only what would change something.\n');
  const limit = LIMITS.feedNoteBytes;
  assert.equal((await feeds.writeNote('news', 'x'.repeat(limit))).text.length, limit);
  await assert.rejects(feeds.writeNote('news', 'x'.repeat(limit + 1)), { code: 'note_too_large' });
  await assert.rejects(feeds.writeNote('nope', 'x'), { code: 'no_such_feed' });
  await assert.rejects(feeds.readNote('nope'), { code: 'no_such_feed' });
});

function writeSuggestions(dir, body) {
  return writeFile(path.join(dir, 'news', 'suggestions.json'), typeof body === 'string' ? body : JSON.stringify(body));
}

test('suggestions read the registered, active sources not on the feed, in the file\'s order', async (t) => {
  const logs = [];
  const { feeds, sources, dir } = await stores(t, { log: (entry) => logs.push(entry) });
  assert.equal(await feeds.readSuggestions('news'), null);
  await sources.create({ name: 'Latent Space', kind: 'rss', url: 'https://example.com/feed' });
  await sources.create({ name: 'Priorities', kind: 'file', path: '/invented/priorities.md' });
  await sources.create({ name: 'Old letter', kind: 'email', sender: 'old@example.com', active: false });
  await sources.create({ name: 'Garden', kind: 'rss', url: 'https://example.com/garden' });
  await feeds.update('news', { sources: ['garden'] });
  await writeSuggestions(dir, {
    version: 1, at: AT,
    sources: [
      { id: 'priorities', why: ' It names what the feed should weigh. ' },
      { id: 'gone', why: 'Deleted since.' },
      { id: 'old-letter', why: 'Inactive.' },
      { id: 'garden', why: 'Already on the feed.' },
      { id: 'latent-space', why: 'It covers the field.' },
    ],
  });
  assert.deepEqual(await feeds.readSuggestions('news'), {
    at: AT,
    sources: [
      { id: 'priorities', name: 'Priorities', kind: 'file', role: 'context', why: 'It names what the feed should weigh.' },
      { id: 'latent-space', name: 'Latent Space', kind: 'rss', role: 'incoming', why: 'It covers the field.' },
    ],
  });
  assert.deepEqual(logs, []);
  await writeSuggestions(dir, { version: 1, at: AT, sources: [] });
  assert.deepEqual(await feeds.readSuggestions('news'), { at: AT, sources: [] });
  await feeds.clearSuggestions('news');
  assert.equal(await feeds.readSuggestions('news'), null);
  await feeds.clearSuggestions('news');
  await assert.rejects(feeds.readSuggestions('nope'), { code: 'no_such_feed' });
  await assert.rejects(feeds.clearSuggestions('nope'), { code: 'no_such_feed' });
});

test('a suggestions file that is not the shape reads as none, with the reason logged', async (t) => {
  const logs = [];
  const { feeds, dir } = await stores(t, { log: (entry) => logs.push(entry) });
  const entry = (id) => ({ id, why: 'A reason.' });
  const bad = [
    'not json',
    [],
    { version: 2, at: AT, sources: [] },
    { version: 1, at: 'yesterday', sources: [] },
    { version: 1, at: AT },
    { version: 1, at: AT, sources: [], extra: true },
    { version: 1, at: AT, sources: Array.from({ length: SUGGESTIONS_MAX + 1 }, (_, i) => entry(`s${i}`)) },
    { version: 1, at: AT, sources: [entry('a'), entry('a')] },
    { version: 1, at: AT, sources: [{ id: 'a' }] },
    { version: 1, at: AT, sources: [{ id: 'a', why: '  ' }] },
    { version: 1, at: AT, sources: [{ id: 'a', why: 'x'.repeat(WHY_MAX + 1) }] },
    { version: 1, at: AT, sources: [{ id: 'a', why: 'Fine.', score: 3 }] },
    { version: 1, at: AT, sources: [{ id: '', why: 'Fine.' }] },
  ];
  for (const body of bad) {
    await writeSuggestions(dir, body);
    assert.equal(await feeds.readSuggestions('news'), null, JSON.stringify(body));
  }
  assert.equal(logs.length, bad.length);
  assert.ok(logs.every((line) => line.event === 'feed_suggestions_invalid' && line.feed === 'news' && typeof line.reason === 'string'));
  await writeSuggestions(dir, 'x'.repeat(LIMITS.sourceFileBytes + 1));
  assert.equal(await feeds.readSuggestions('news'), null);
});
