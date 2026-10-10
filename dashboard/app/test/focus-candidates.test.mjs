// Candidate file tests cover the validation boundary, bounded forgiving reads,
// frozen results, and the atomic private-mode writer used by scan runs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { readCandidatesFile, validateCandidates, writeCandidatesFile } from '../lib/focus/candidates.mjs';

const limits = { focusCandidatesMax: 2, focusCandidateBytes: 1024 };
const candidate = (over = {}) => ({ title: 'Answer Lauren', source: 'gmail', external_id: 'thread-1', ...over });
const document = (over = {}) => ({
  scanned: '2026-10-10T12:00:00.000Z',
  signature: 'a'.repeat(64),
  candidates: [candidate()],
  ...over,
});

test('validateCandidates preserves the scanner rules and enforces the configured cap', () => {
  assert.deepEqual(validateCandidates([candidate()], limits), []);
  assert.deepEqual(validateCandidates('no', limits), ['not an array']);
  assert.deepEqual(validateCandidates([candidate(), candidate(), candidate()], limits), ['at most 2 candidates']);
  assert.deepEqual(validateCandidates([candidate({ title: '' })], limits), ['[0] bad title']);
  assert.deepEqual(validateCandidates([candidate({ title: 'x'.repeat(201) })], limits), ['[0] bad title']);
  assert.deepEqual(validateCandidates([candidate({ source: 'manual' })], limits), ['[0] bad source "manual"']);
  assert.deepEqual(validateCandidates([candidate({ external_id: '' })], limits), ['[0] bad external_id']);
  assert.deepEqual(validateCandidates([[]], limits), [
    '[0] bad title',
    '[0] bad source undefined',
    '[0] bad external_id',
  ]);
  for (const key of ['link', 'meta', 'occurs_at', 'text']) {
    assert.deepEqual(validateCandidates([candidate({ [key]: 1 })], limits), [`[0] ${key} must be string or null`]);
    assert.deepEqual(validateCandidates([candidate({ [key]: null })], limits), []);
  }
});

test('readCandidatesFile returns a frozen projection of the candidate document', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'focus-candidates-'));
  const file = path.join(dir, 'gmail.json');
  await writeFile(file, JSON.stringify(document({ extra: true })));
  const read = await readCandidatesFile(file, limits);
  assert.deepEqual(read, document());
  assert.ok(Object.isFrozen(read));
  assert.ok(Object.isFrozen(read.candidates));
  assert.ok(Object.isFrozen(read.candidates[0]));
});

test('readCandidatesFile returns null for missing, oversize, malformed, or invalid files', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'focus-candidates-bad-'));
  const file = path.join(dir, 'gmail.json');
  assert.equal(await readCandidatesFile(file, limits), null);

  await writeFile(file, 'x'.repeat(limits.focusCandidateBytes + 1));
  assert.equal(await readCandidatesFile(file, limits), null);
  await writeFile(file, '{');
  assert.equal(await readCandidatesFile(file, limits), null);

  for (const invalid of [
    document({ scanned: '' }),
    document({ signature: '' }),
    document({ candidates: [candidate({ text: 7 })] }),
  ]) {
    await writeFile(file, JSON.stringify(invalid));
    assert.equal(await readCandidatesFile(file, limits), null);
  }
});

test('readCandidatesFile accepts opaque non-empty scanned and signature strings', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'focus-candidates-envelope-'));
  const file = path.join(dir, 'gmail.json');
  const opaque = document({ scanned: 'latest scan', signature: 'signature-v1' });
  await writeFile(file, JSON.stringify(opaque));
  assert.deepEqual(await readCandidatesFile(file, limits), opaque);
});

test('writeCandidatesFile atomically writes formatted JSON with mode 0600', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'focus-candidates-write-'));
  const file = path.join(dir, 'nested', 'git.json');
  await writeCandidatesFile(file, document());
  assert.equal(await readFile(file, 'utf8'), `${JSON.stringify(document(), null, 2)}\n`);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
});
