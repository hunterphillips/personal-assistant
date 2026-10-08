import assert from 'node:assert/strict';
import { chmod, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import { createBriefReads } from '../lib/brief-reads.mjs';
import { tempDir } from './support/harness.mjs';

test('a brand-new root has no file and read() answers null', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'brief-reads.json');
  const reads = createBriefReads({ file });
  await reads.load();
  assert.equal(reads.read(), null);
  await assert.rejects(readFile(file), (error) => error.code === 'ENOENT');
});

test('mark writes the date atomically, privately, and read() answers it back', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'var', 'brief-reads.json');
  const reads = createBriefReads({ file });
  await reads.load();
  await reads.mark('2026-10-07');

  assert.equal(reads.read(), '2026-10-07');
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { version: 1, read: '2026-10-07' });
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await stat(path.dirname(file))).mode & 0o777, 0o700);
});

test('a later mark replaces the earlier one with one file, no leftovers', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'brief-reads.json');
  const reads = createBriefReads({ file });
  await reads.load();
  await reads.mark('2026-10-07');
  await reads.mark('2026-10-08');

  assert.equal(reads.read(), '2026-10-08');
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { version: 1, read: '2026-10-08' });
  assert.deepEqual((await readdir(dir, { withFileTypes: true })).map((entry) => entry.name), ['brief-reads.json']);
});

test('mark refuses a date that is not a real calendar date, and refuses before load', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'brief-reads.json');
  const reads = createBriefReads({ file });
  await assert.rejects(reads.mark('2026-10-07'), /brief_reads_not_loaded/);
  await reads.load();
  await assert.rejects(reads.mark('2026-02-30'), /invalid_date/);
  await assert.rejects(reads.mark('not-a-date'), /invalid_date/);
  assert.equal(reads.read(), null);
});

test('an invalid file is logged and read as unread, never thrown', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'brief-reads.json');
  await writeFile(file, '{"read":"not a date"}\n');
  await chmod(file, 0o644);
  const logs = [];
  const reads = createBriefReads({ file, log: (entry) => logs.push(entry) });
  await reads.load();

  assert.deepEqual(logs, [{ event: 'brief_reads_invalid' }]);
  assert.equal(reads.read(), null);
});

test('malformed JSON is logged the same way', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'brief-reads.json');
  await writeFile(file, '{ not json');
  const logs = [];
  const reads = createBriefReads({ file, log: (entry) => logs.push(entry) });
  await reads.load();

  assert.deepEqual(logs, [{ event: 'brief_reads_invalid' }]);
  assert.equal(reads.read(), null);
});

test('a second load() is a no-op', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'brief-reads.json');
  await writeFile(file, '{"version":1,"read":"2026-10-05"}\n');
  const reads = createBriefReads({ file });
  await reads.load();
  await writeFile(file, '{"version":1,"read":"2026-10-06"}\n');
  await reads.load();
  assert.equal(reads.read(), '2026-10-05');
});
