import assert from 'node:assert/strict';
import { chmod, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import { createReads } from '../lib/reads.mjs';
import { tempDir } from './support/harness.mjs';

test('first start seeds every listed agent at now and writes a private file', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'var', 'thread-reads.json');
  const reads = createReads({ file, now: () => new Date('2026-10-03T12:00:00.000Z') });
  await reads.load(['cfo', 'watch']);

  assert.deepEqual(reads.current(), {
    cfo: '2026-10-03T12:00:00.000Z',
    watch: '2026-10-03T12:00:00.000Z',
  });
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), reads.current());
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await stat(path.dirname(file))).mode & 0o777, 0o700);
});

test('mark and ensure preserve existing reads and atomically add new ones', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'thread-reads.json');
  let instant = '2026-10-03T12:00:00.000Z';
  const reads = createReads({ file, now: () => new Date(instant) });
  await reads.load(['cfo']);
  instant = '2026-10-03T12:01:00.000Z';
  await reads.mark('cfo');
  instant = '2026-10-03T12:02:00.000Z';
  await reads.ensure(['cfo', 'watch']);

  assert.deepEqual(reads.current(), {
    cfo: '2026-10-03T12:01:00.000Z',
    watch: '2026-10-03T12:02:00.000Z',
  });
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), reads.current());
  assert.deepEqual((await readdir(dir, { withFileTypes: true })).map((entry) => entry.name), ['thread-reads.json']);
});

test('an invalid file is logged and recovered without lighting old threads', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'thread-reads.json');
  await writeFile(file, '{"cfo":"not a time"}\n');
  await chmod(file, 0o644);
  const logs = [];
  const reads = createReads({ file, log: (entry) => logs.push(entry), now: () => new Date('2026-10-03T12:00:00.000Z') });
  await reads.load(['cfo']);

  assert.deepEqual(logs, [{ event: 'thread_reads_invalid' }]);
  assert.equal(reads.readAt('cfo'), '2026-10-03T12:00:00.000Z');
  assert.equal((await stat(file)).mode & 0o777, 0o600);
});
