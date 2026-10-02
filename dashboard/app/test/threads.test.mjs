import assert from 'node:assert/strict';
import { appendFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import { createThreadStore, truncateUtf8 } from '../lib/threads.mjs';
import { tempDir } from './support/harness.mjs';

const LIMITS = { messageTextBytes: 64, threadCacheMessages: 5, threadCacheBytes: 4096 };
const AT = '2026-09-25T12:00:00.000Z';

async function setup(t, limits = LIMITS) {
  const root = await tempDir(t);
  const dir = path.join(root, 'threads');
  const logs = [];
  const store = createThreadStore({ dir, limits, log: (entry) => logs.push(entry) });
  return { dir, store, logs };
}

function message(text, role = 'user') {
  return { role, text, at: AT };
}

test('a pointer round-trips and leaves no temporary file behind', async (t) => {
  const { dir, store } = await setup(t);
  assert.equal(await store.readPointer('cfo'), null);
  await store.writePointer('cfo', { sessionId: 'session-1', createdAt: AT });
  assert.deepEqual(await store.readPointer('cfo'), { sessionId: 'session-1', createdAt: AT });
  await store.writePointer('cfo', { sessionId: 'session-2', createdAt: AT });
  assert.deepEqual(await store.readPointer('cfo'), { sessionId: 'session-2', createdAt: AT });
  assert.deepEqual(await readdir(dir), ['cfo.json']);
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
  assert.equal((await stat(path.join(dir, 'cfo.json'))).mode & 0o777, 0o600);
});

test('a thread directory created with a looser mode is tightened to 0700', async (t) => {
  const { dir, store } = await setup(t);
  await mkdir(dir, { recursive: true, mode: 0o755 });
  assert.equal((await stat(dir)).mode & 0o777, 0o755);
  await store.writePointer('cfo', { sessionId: 'session-1', createdAt: AT });
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
});

test('clearing a pointer removes it, and clearing a missing one is fine', async (t) => {
  const { store } = await setup(t);
  await store.clearPointer('cfo');
  await store.writePointer('cfo', { sessionId: 'session-1', createdAt: AT });
  await store.clearPointer('cfo');
  assert.equal(await store.readPointer('cfo'), null);
});

test('an invalid pointer file reads as null and is logged', async (t) => {
  const { dir, store, logs } = await setup(t);
  await store.writePointer('cfo', { sessionId: 'session-1', createdAt: AT });
  await writeFile(path.join(dir, 'cfo.json'), '{"sessionId": 42}');
  assert.equal(await store.readPointer('cfo'), null);
  assert.deepEqual(logs, [{ event: 'thread_pointer_invalid', agentId: 'cfo' }]);
});

test('an invalid pointer is refused on write', async (t) => {
  const { store } = await setup(t);
  await assert.rejects(store.writePointer('cfo', { sessionId: '', createdAt: AT }), { code: 'invalid_pointer' });
  await assert.rejects(store.writePointer('cfo', { createdAt: AT }), { code: 'invalid_pointer' });
});

test('a pointer carries the thread\'s model and effort, with or without a session', async (t) => {
  const { dir, store } = await setup(t);
  await store.writePointer('cfo', { sessionId: 'session-1', createdAt: AT, model: 'sonnet', effort: 'low' });
  assert.deepEqual(await store.readPointer('cfo'), { sessionId: 'session-1', createdAt: AT, model: 'sonnet', effort: 'low' });
  assert.deepEqual(JSON.parse(await readFile(path.join(dir, 'cfo.json'), 'utf8')), { sessionId: 'session-1', createdAt: AT, model: 'sonnet', effort: 'low' });

  // Either field alone; null is dropped from the file.
  await store.writePointer('cfo', { sessionId: 'session-1', createdAt: AT, model: 'sonnet', effort: null });
  assert.deepEqual(await store.readPointer('cfo'), { sessionId: 'session-1', createdAt: AT, model: 'sonnet' });
  assert.equal('effort' in JSON.parse(await readFile(path.join(dir, 'cfo.json'), 'utf8')), false);
  await store.writePointer('cfo', { sessionId: 'session-1', createdAt: AT, effort: 'max' });
  assert.deepEqual(await store.readPointer('cfo'), { sessionId: 'session-1', createdAt: AT, effort: 'max' });

  // A choice before any session exists.
  await store.writePointer('cfo', { sessionId: null, createdAt: AT, model: 'haiku' });
  assert.deepEqual(await store.readPointer('cfo'), { sessionId: null, createdAt: AT, model: 'haiku' });

  // Neither a session nor a choice is not a pointer; a bad choice is refused.
  await assert.rejects(store.writePointer('cfo', { sessionId: null, createdAt: AT }), { code: 'invalid_pointer' });
  await assert.rejects(store.writePointer('cfo', { sessionId: 'session-1', createdAt: AT, effort: 'extreme' }), { code: 'invalid_pointer' });
  await assert.rejects(store.writePointer('cfo', { sessionId: 'session-1', createdAt: AT, model: 'x'.repeat(65) }), { code: 'invalid_pointer' });
  await assert.rejects(store.writePointer('cfo', { sessionId: 'session-1', createdAt: AT, model: 7 }), { code: 'invalid_pointer' });

  // Clearing drops the choice with the session.
  await store.clearPointer('cfo');
  assert.equal(await store.readPointer('cfo'), null);
});

test('a stored effort that no longer validates reads as absent, and a bare choice without a session still reads', async (t) => {
  const { dir, store } = await setup(t);
  await store.writePointer('cfo', { sessionId: 'session-1', createdAt: AT });
  await writeFile(path.join(dir, 'cfo.json'), JSON.stringify({ sessionId: 'session-1', createdAt: AT, model: 'sonnet', effort: 'extreme' }));
  assert.deepEqual(await store.readPointer('cfo'), { sessionId: 'session-1', createdAt: AT, model: 'sonnet' });
  await writeFile(path.join(dir, 'cfo.json'), JSON.stringify({ sessionId: null, createdAt: AT, effort: 'extreme' }));
  assert.equal(await store.readPointer('cfo'), null);
});

test('appended messages read back in order with their extra fields', async (t) => {
  const { dir, store } = await setup(t);
  assert.deepEqual(await store.read('cfo'), []);
  await store.append('cfo', message('hello'));
  await store.append('cfo', { ...message('hi', 'assistant'), requestId: 'r1' });
  assert.deepEqual(await store.read('cfo'), [message('hello'), { ...message('hi', 'assistant'), requestId: 'r1' }]);
  assert.equal((await stat(path.join(dir, 'cfo.jsonl'))).mode & 0o777, 0o600);
});

test('a partial last line is skipped on read and does not swallow the next append', async (t) => {
  const { dir, store } = await setup(t);
  await store.append('cfo', message('one'));
  await appendFile(path.join(dir, 'cfo.jsonl'), '{"role":"assistant","te');
  assert.deepEqual(await store.read('cfo'), [message('one')]);

  const fresh = createThreadStore({ dir, limits: LIMITS });
  await fresh.append('cfo', message('two'));
  assert.deepEqual(await fresh.read('cfo'), [message('one'), message('two')]);
});

test('a cache over the message cap is rewritten with the newest messages', async (t) => {
  const { dir, store } = await setup(t);
  for (let index = 1; index <= 8; index += 1) await store.append('cfo', message(`m${index}`));
  assert.deepEqual((await store.read('cfo')).map((entry) => entry.text), ['m4', 'm5', 'm6', 'm7', 'm8']);
  const lines = (await readFile(path.join(dir, 'cfo.jsonl'), 'utf8')).trim().split('\n');
  assert.equal(lines.length, 5);
  assert.deepEqual(await readdir(dir), ['cfo.jsonl']);
});

test('a cache over the byte cap keeps the newest messages that fit', async (t) => {
  const limits = { messageTextBytes: 64, threadCacheMessages: 100, threadCacheBytes: 300 };
  const { dir, store } = await setup(t, limits);
  for (let index = 1; index <= 10; index += 1) await store.append('cfo', message(`${index}`.padStart(40, 'x')));
  const size = (await stat(path.join(dir, 'cfo.jsonl'))).size;
  assert.ok(size <= 300, `cache is ${size} bytes`);
  const texts = (await store.read('cfo')).map((entry) => entry.text.replace(/^x+/, ''));
  assert.equal(texts.at(-1), '10');
  assert.deepEqual(texts, texts.map((_, index) => String(10 - texts.length + 1 + index)));
});

test('reads return at most the byte cap from the end of the file', async (t) => {
  const { dir, store } = await setup(t, { messageTextBytes: 64, threadCacheMessages: 100, threadCacheBytes: 200 });
  const lines = Array.from({ length: 10 }, (_, index) => JSON.stringify(message(`line-${index}`))).join('\n');
  await store.append('cfo', message('seed'));
  await writeFile(path.join(dir, 'cfo.jsonl'), `${lines}\n`);
  const read = await store.read('cfo');
  assert.ok(read.length > 0 && read.length < 10);
  assert.equal(read.at(-1).text, 'line-9');
  assert.ok(Buffer.byteLength(read.map((entry) => `${JSON.stringify(entry)}\n`).join('')) <= 200);
});

test('long text is cut on a character boundary and flagged', async (t) => {
  const { store } = await setup(t);
  await store.append('cfo', message('é'.repeat(40)));
  const [entry] = await store.read('cfo');
  assert.equal(entry.truncated, true);
  assert.equal(entry.text, 'é'.repeat(32));
  assert.deepEqual(truncateUtf8('ab😀', 5), { text: 'ab', truncated: true });
  assert.deepEqual(truncateUtf8('short', 64), { text: 'short', truncated: false });
});

test('clear removes the cache, and later appends start fresh', async (t) => {
  const { store } = await setup(t);
  await store.clear('cfo');
  await store.append('cfo', message('old'));
  await store.clear('cfo');
  assert.deepEqual(await store.read('cfo'), []);
  await store.append('cfo', message('new'));
  assert.deepEqual(await store.read('cfo'), [message('new')]);
});

test('an agent id outside the registry pattern is refused before any file is touched', async (t) => {
  const { dir, store } = await setup(t);
  for (const id of ['../cfo', 'CFO', 'a', '', null, 'cfo/x', 'cfo.json']) {
    await assert.rejects(store.readPointer(id), { code: 'invalid_agent_id' });
    await assert.rejects(store.writePointer(id, { sessionId: 's', createdAt: AT }), { code: 'invalid_agent_id' });
    await assert.rejects(store.append(id, message('x')), { code: 'invalid_agent_id' });
    await assert.rejects(store.read(id), { code: 'invalid_agent_id' });
    await assert.rejects(store.clear(id), { code: 'invalid_agent_id' });
    await assert.rejects(store.clearPointer(id), { code: 'invalid_agent_id' });
  }
  await assert.rejects(readdir(dir), { code: 'ENOENT' });
});

test('a malformed message is refused', async (t) => {
  const { store } = await setup(t);
  await assert.rejects(store.append('cfo', { role: 'tool', text: 'x', at: AT }), { code: 'invalid_message' });
  await assert.rejects(store.append('cfo', { role: 'user', text: 1, at: AT }), { code: 'invalid_message' });
});

test('interleaved appends for one agent land in call order', async (t) => {
  const { store } = await setup(t, { ...LIMITS, threadCacheMessages: 100 });
  await Promise.all(Array.from({ length: 30 }, (_, index) =>
    store.append(index % 2 ? 'focus' : 'cfo', message(`m${index}`))));
  assert.deepEqual((await store.read('cfo')).map((entry) => entry.text),
    Array.from({ length: 15 }, (_, index) => `m${index * 2}`));
  assert.deepEqual((await store.read('focus')).map((entry) => entry.text),
    Array.from({ length: 15 }, (_, index) => `m${index * 2 + 1}`));
});
