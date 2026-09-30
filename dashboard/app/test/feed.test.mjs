import assert from 'node:assert/strict';
import { chmod, cp, mkdir, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { LIMITS } from '../lib/config.mjs';
import { createFeed } from '../lib/feed.mjs';
import { createFeedInstructions } from '../lib/feed-instructions.mjs';
import { tempDir } from './support/harness.mjs';

const FIXTURE_FEED = fileURLToPath(new URL('./fixtures/feed/', import.meta.url));

// A fresh copy of the fixture store in a temp dir, so tests can change it.
async function feedCopy(t) {
  const dir = path.join(await tempDir(t), 'feed');
  await cp(FIXTURE_FEED, dir, { recursive: true });
  return dir;
}

function feedFor(dir, { limits = LIMITS, log = () => {} } = {}) {
  return createFeed({ dir, limits, log });
}

function run(dir, date, items, extra = {}) {
  return writeFile(path.join(dir, `${date}-watch.json`),
    JSON.stringify({ producer: 'watch', date, since: null, generated_at: null, items, ...extra }));
}

function item(id, extra = {}) {
  return { id, title: `Title ${id}`, source: 'Invented', url: 'https://example.com/x', summary: `Summary ${id}`, ...extra };
}

test('the fixture store reads with no problems, newest run first, items in file order', async (t) => {
  const logs = [];
  const feed = feedFor(await feedCopy(t), { log: (entry) => logs.push(entry) });
  const result = await feed.read();
  assert.equal(result.agentId, 'watch');
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.runs.map((entry) => entry.id), ['2026-09-28-watch', '2026-09-21-watch']);
  const [newest] = result.runs;
  assert.deepEqual([newest.producer, newest.date, newest.since, newest.generatedAt],
    ['watch', '2026-09-28', '2026-09-14', '2026-09-28T14:47:22-05:00']);
  assert.equal(newest.items.length, 8);
  assert.deepEqual(newest.items[0], {
    id: 'watch/2026-09-28/1', title: 'Town council adopts a rule for delivery robots', source: 'Invented Gazette',
    url: 'https://example.com/robots', summary: 'The Invented Gazette reports the town adopted a rule for delivery robots on sidewalks.',
    test: 5, kept: true, image: null,
  });
  // A missing test is null; a missing kept is false.
  assert.deepEqual([newest.items[5].test, newest.items[6].kept], [null, false]);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(newest.items[0]));
  assert.ok(!Number.isNaN(Date.parse(result.readAt)));
  assert.deepEqual(logs, []);
});

test('an unchanged store returns the same result object; a changed file reads again', async (t) => {
  const dir = await feedCopy(t);
  const feed = feedFor(dir);
  const first = await feed.read();
  assert.equal(await feed.read(), first);
  // Concurrent reads share one load.
  const [a, b] = await Promise.all([feed.read(), feed.read()]);
  assert.equal(a, b);
  const file = path.join(dir, '2026-09-21-watch.json');
  const text = await readFile(file, 'utf8');
  await writeFile(file, text.replace('A new trail opens along the creek', 'A new trail closes along the creek'));
  await utimes(file, new Date(), new Date(Date.now() + 5000));
  const second = await feed.read();
  assert.notEqual(second, first);
  assert.equal(second.runs[1].items[0].title, 'A new trail closes along the creek');
});

test('find returns the item with its run, or null', async (t) => {
  const feed = feedFor(await feedCopy(t));
  const found = await feed.find('watch/2026-09-21/2');
  assert.deepEqual(found, {
    id: 'watch/2026-09-21/2', title: 'Hand-bound notebooks, a how-to', source: 'Invented Letters',
    url: 'https://example.com/notebooks', summary: 'A step-by-step on binding a notebook with a needle and waxed thread.',
    test: 2, kept: false, image: null, producer: 'watch', date: '2026-09-21',
  });
  assert.ok(Object.isFrozen(found));
  assert.equal(await feed.find('watch/2026-09-21/9'), null);
  assert.equal(await feed.find(''), null);
});

test('files that are not runs are skipped with one problem each', async (t) => {
  const dir = await feedCopy(t);
  await writeFile(path.join(dir, '2026-09-30-watch.json'), '{not json');
  await writeFile(path.join(dir, '2026-09-29-watch.json'), JSON.stringify({ producer: 'watch', items: [] }));
  await writeFile(path.join(dir, '2026-09-27-watch.json'), JSON.stringify([]));
  await writeFile(path.join(dir, 'notes.txt'), 'ignored');
  await writeFile(path.join(dir, '2026-09-26-Watch.json'), '{}');
  await mkdir(path.join(dir, '2026-09-25-watch.json'));
  await symlink(path.join(dir, '2026-09-21-watch.json'), path.join(dir, '2026-09-24-watch.json'));
  const result = await feedFor(dir).read();
  assert.deepEqual(result.runs.map((entry) => entry.id), ['2026-09-28-watch', '2026-09-21-watch']);
  assert.deepEqual(result.problems, [
    '2026-09-30-watch.json is not JSON.',
    '2026-09-29-watch.json is not a feed run.',
    '2026-09-27-watch.json is not a feed run.',
    '2026-09-25-watch.json is not a regular file.',
    '2026-09-24-watch.json is not a regular file.',
  ]);
});

test('items that are not the expected shape are left out and counted once per run', async (t) => {
  const dir = await feedCopy(t);
  await run(dir, '2026-10-05', [
    item('watch/2026-10-05/1'),
    item('watch/2026-10-05/2', { url: 'ftp://example.com/x' }),
    item('watch/2026-10-05/3', { summary: '' }),
    item('watch/2026-10-05/1'),
    item('watch/2026-09-28/1'),
    'not an item',
    item('watch/2026-10-05/6', { test: 'two', kept: 'yes' }),
  ]);
  const feed = feedFor(dir);
  const result = await feed.read();
  // Newest first, so the newer file keeps the id it took from the older one,
  // and the older file's item is the one left out.
  assert.deepEqual(result.problems, [
    '2026-10-05-watch.json has 4 items that could not be shown.',
    '2026-09-28-watch.json has 1 item that could not be shown.',
  ]);
  const [newest, older] = result.runs;
  assert.deepEqual(newest.items.map((entry) => entry.id), ['watch/2026-10-05/1', 'watch/2026-09-28/1', 'watch/2026-10-05/6']);
  assert.deepEqual([newest.items[2].test, newest.items[2].kept], [null, false]);
  assert.equal(older.items.length, 7);
  assert.equal((await feed.find('watch/2026-09-28/1')).date, '2026-10-05');
});

test('an item keeps an http or https image and gets null for anything else, never skipped for it', async (t) => {
  const dir = await feedCopy(t);
  await run(dir, '2026-10-05', [
    item('watch/2026-10-05/1', { image: 'https://example.com/a.jpg' }),
    item('watch/2026-10-05/2', { image: 'http://example.com/b.png' }),
    item('watch/2026-10-05/3', { image: '/images/c.png' }),
    item('watch/2026-10-05/4', { image: '' }),
    item('watch/2026-10-05/5', { image: 42 }),
    item('watch/2026-10-05/6', { image: 'javascript:alert(1)' }),
    item('watch/2026-10-05/7'),
    item('watch/2026-10-05/8', { image: null }),
  ]);
  const feed = feedFor(dir);
  const result = await feed.read();
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.runs[0].items.map((entry) => entry.image), [
    'https://example.com/a.jpg', 'http://example.com/b.png', null, null, null, null, null, null,
  ]);
  assert.equal((await feed.find('watch/2026-10-05/1')).image, 'https://example.com/a.jpg');
});

test('a file over the cap is skipped, from its size and from its bytes', async (t) => {
  const dir = await feedCopy(t);
  // The older fixture is under 1 KiB; the newer is over it.
  const limits = { ...LIMITS, feedFileBytes: 1024 };
  const result = await feedFor(dir, { limits }).read();
  assert.deepEqual(result.runs.map((entry) => entry.id), ['2026-09-21-watch']);
  assert.deepEqual(result.problems, ['2026-09-28-watch.json is larger than 1 KiB.']);
  // A file rewritten past the cap is skipped on the next read.
  const file = path.join(dir, '2026-09-21-watch.json');
  const text = await readFile(file, 'utf8');
  await writeFile(file, text.replace('"items"', `"pad": "${'p'.repeat(1024)}", "items"`));
  const grown = await feedFor(dir, { limits: { ...limits, feedFileBytes: 1024 } }).read();
  assert.deepEqual(grown.runs, []);
});

test('more files than the limit shows the newest and says so', async (t) => {
  const dir = await feedCopy(t);
  await run(dir, '2026-10-05', [item('watch/2026-10-05/1')]);
  const result = await feedFor(dir, { limits: { ...LIMITS, feedFiles: 2 } }).read();
  assert.deepEqual(result.runs.map((entry) => entry.id), ['2026-10-05-watch', '2026-09-28-watch']);
  assert.deepEqual(result.problems, ['The feed has 3 files; only the newest 2 are shown.']);
});

test('a missing directory is one problem and no runs; a created one is read next time', async (t) => {
  const dir = path.join(await tempDir(t), 'feed');
  const feed = feedFor(dir);
  const first = await feed.read();
  assert.deepEqual([first.runs, first.problems], [[], ['The feed directory is missing.']]);
  await mkdir(dir);
  await run(dir, '2026-10-05', [item('watch/2026-10-05/1')]);
  const second = await feed.read();
  assert.deepEqual([second.problems, second.runs.length], [[], 1]);
});

test('an unreadable file is logged, reported, and read again next time', async (t) => {
  const dir = await feedCopy(t);
  const file = path.join(dir, '2026-09-21-watch.json');
  await chmod(file, 0o000);
  const logs = [];
  const feed = feedFor(dir, { log: (entry) => logs.push(entry) });
  const first = await feed.read();
  assert.deepEqual(first.problems, ['2026-09-21-watch.json could not be read.']);
  assert.deepEqual(first.runs.map((entry) => entry.id), ['2026-09-28-watch']);
  assert.deepEqual(logs.map((entry) => [entry.event, entry.path]), [['feed_read_error', '2026-09-21-watch.json']]);
  await chmod(file, 0o600);
  const second = await feed.read();
  assert.notEqual(second, first);
  assert.deepEqual(second.problems, []);
  assert.equal(second.runs.length, 2);
});

test('a removed run drops out of the next read', async (t) => {
  const dir = await feedCopy(t);
  const feed = feedFor(dir);
  await feed.read();
  await rm(path.join(dir, '2026-09-28-watch.json'));
  const result = await feed.read();
  assert.deepEqual(result.runs.map((entry) => entry.id), ['2026-09-21-watch']);
  assert.equal(await feed.find('watch/2026-09-28/1'), null);
});

const FIXTURE_INSTRUCTIONS = fileURLToPath(new URL('./fixtures/feed-instructions/relevance.md', import.meta.url));

async function instructionsCopy(t) {
  const file = path.join(await tempDir(t), 'relevance.md');
  await cp(FIXTURE_INSTRUCTIONS, file);
  return file;
}

test('the instructions read as the path, the file time, and prose blocks', async (t) => {
  const file = await instructionsCopy(t);
  const mtime = new Date('2026-09-25T12:00:00Z');
  await utimes(file, mtime, mtime);
  const result = await createFeedInstructions({ file, limits: LIMITS }).read();
  assert.deepEqual(result, {
    path: 'daily-brief/watch/relevance.md',
    updated: '2026-09-25T12:00:00.000Z',
    problem: null,
    blocks: [
      { type: 'h', text: 'Invented watch criteria' },
      { type: 'p', text: 'What the invented feed keeps. Written as tests, not as topics.' },
      { type: 'h', text: 'Sources' },
      { type: 'list', items: ['Invented Gazette', 'Invented Letters, weekly'] },
      { type: 'h', text: 'An item survives if' },
      { type: 'list', items: ['It changes how the garden is planted.', 'It names a trail opening nearby.'] },
    ],
  });
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.blocks[3].items));
});

test('unchanged instructions return the same object; a changed file reads again', async (t) => {
  const file = await instructionsCopy(t);
  const instructions = createFeedInstructions({ file, limits: LIMITS });
  const first = await instructions.read();
  assert.equal(await instructions.read(), first);
  await writeFile(file, 'Only one paragraph now.\n');
  await utimes(file, new Date(), new Date(Date.now() + 5000));
  const second = await instructions.read();
  assert.notEqual(second, first);
  assert.deepEqual(second.blocks, [{ type: 'p', text: 'Only one paragraph now.' }]);
});

test('missing, oversized, and non-regular instructions are empty blocks and one sentence', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'relevance.md');
  const instructions = createFeedInstructions({ file, limits: LIMITS });
  const missing = await instructions.read();
  assert.deepEqual(missing, {
    path: 'daily-brief/watch/relevance.md', updated: null, problem: 'The feed instructions file is missing.', blocks: [],
  });

  await writeFile(file, 'x'.repeat(64 * 1024 + 1));
  const large = await instructions.read();
  assert.deepEqual([large.problem, large.blocks], ['The feed instructions file is larger than 64 KiB.', []]);
  assert.equal(typeof large.updated, 'string');

  await rm(file);
  await mkdir(file);
  assert.equal((await instructions.read()).problem, 'The feed instructions file is not a regular file.');

  await rm(file, { recursive: true });
  await cp(FIXTURE_INSTRUCTIONS, path.join(dir, 'real.md'));
  await symlink(path.join(dir, 'real.md'), file);
  const linked = await instructions.read();
  assert.deepEqual([linked.problem, linked.blocks], ['The feed instructions file is not a regular file.', []]);
});
