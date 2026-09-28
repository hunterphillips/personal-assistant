import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { MAX_BINDINGS, appendBinding, claimPidFile, createBindings, findBinding } from '../lib/bindings.mjs';
import { tempDir } from './support/harness.mjs';

const binding = (threadId, extra = {}) => ({
  threadId, cwd: '/invented/work', workspaceId: 'ws-1', surfaceId: 'sf-1', createdAt: '2026-09-28T12:00:00.000Z', ...extra,
});

test('appendBinding creates the file, keeps newest first, replaces a repeated thread, and caps the list', async (t) => {
  const file = path.join(await tempDir(t), 'codex', 'bindings.json');
  await assert.rejects(appendBinding(file, { threadId: 'x' }), TypeError);
  await assert.rejects(appendBinding(file, binding('bad/id')), TypeError);
  await appendBinding(file, binding('a'));
  await appendBinding(file, binding('b', { workspaceId: null, surfaceId: null }));
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), [binding('b', { workspaceId: null, surfaceId: null }), binding('a')]);
  await appendBinding(file, binding('a', { surfaceId: 'sf-2' }));
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).map((item) => [item.threadId, item.surfaceId]), [['a', 'sf-2'], ['b', null]]);
  for (let index = 0; index < MAX_BINDINGS + 5; index += 1) await appendBinding(file, binding(`t${index}`));
  const records = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(records.length, MAX_BINDINGS);
  assert.equal(records[0].threadId, `t${MAX_BINDINGS + 4}`);
});

test('createBindings polls the file and keeps the last good map through a bad write', async (t) => {
  const file = path.join(await tempDir(t), 'bindings.json');
  const logs = [];
  const bindings = createBindings({ path: file, pollMs: 10, log: (entry) => logs.push(entry) });
  const changes = [];
  bindings.onChange((current) => changes.push([...current.keys()]));
  await bindings.start();
  t.after(() => bindings.stop());
  assert.deepEqual([...bindings.current().keys()], []);
  await appendBinding(file, binding('a'));
  await until(() => bindings.current().has('a'));
  assert.deepEqual(bindings.current().get('a'), { workspaceId: 'ws-1', surfaceId: 'sf-1' });
  assert.ok(Object.isFrozen(bindings.current().get('a')));
  await writeFile(file, '{ not json');
  await until(() => logs.some((entry) => entry.event === 'bindings_error'));
  assert.deepEqual([...bindings.current().keys()], ['a']);
  assert.equal(logs.filter((entry) => entry.event === 'bindings_error').length, 1);
  await writeFile(file, JSON.stringify([binding('b'), { junk: true }, binding('b')]));
  await until(() => bindings.current().has('b'));
  assert.deepEqual([...bindings.current().keys()], ['b']);
  assert.deepEqual(changes.at(-1), ['b']);
});

async function until(predicate, ms = 2_000) {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition did not happen');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const MODULE = fileURLToPath(new URL('../lib/bindings.mjs', import.meta.url));
const threadIds = async (file) => JSON.parse(await readFile(file, 'utf8')).map((item) => item.threadId);

test('appendBinding takes turns through bindings.lock, so concurrent writers both land', async (t) => {
  const dir = path.join(await tempDir(t), 'codex');
  const file = path.join(dir, 'bindings.json');
  const lock = path.join(dir, 'bindings.lock');

  // Two interleaved calls in one process.
  await Promise.all([appendBinding(file, binding('a')), appendBinding(file, binding('b'))]);
  assert.deepEqual((await threadIds(file)).sort(), ['a', 'b']);
  assert.equal(existsSync(lock), false);
  assert.deepEqual(await findBinding(file, 'a'), binding('a'));
  assert.equal(await findBinding(file, 'nobody'), null);

  // Two processes at once.
  const script = `import { appendBinding } from ${JSON.stringify(pathToFileURL(MODULE).href)};
    await appendBinding(${JSON.stringify(file)}, { threadId: process.argv[1], cwd: '/invented/work', workspaceId: null, surfaceId: null, createdAt: 'x' });`;
  const writer = (id) => new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, id], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (data) => { stderr += data; });
    child.once('exit', (code) => resolve({ code, stderr }));
  });
  const results = await Promise.all([writer('p1'), writer('p2'), writer('p3')]);
  assert.deepEqual(results.map((r) => r.code), [0, 0, 0], results.map((r) => r.stderr).join('\n'));
  assert.deepEqual((await threadIds(file)).sort(), ['a', 'b', 'p1', 'p2', 'p3']);
  assert.equal(existsSync(lock), false);

  // A lock left by a process that is gone is taken over.
  await writeFile(lock, JSON.stringify({ pid: spawnSync(process.execPath, ['-e', '0']).pid }));
  await appendBinding(file, binding('c'));
  assert.equal((await threadIds(file))[0], 'c');
  assert.equal(existsSync(lock), false);

  // A lock held by a live process is waited on.
  await writeFile(lock, JSON.stringify({ pid: process.pid }));
  let done = false;
  const waiting = appendBinding(file, binding('d')).then(() => { done = true; });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(done, false);
  await rm(lock);
  await waiting;
  assert.equal((await threadIds(file))[0], 'd');
  assert.equal(existsSync(lock), false);
});

test('claimPidFile answers the live holder and takes over a dead or abandoned one', async (t) => {
  const file = path.join(await tempDir(t), 'marker.json');
  assert.deepEqual(await claimPidFile(file, JSON.stringify({ pid: process.pid, note: 'mine' })), { claimed: true });
  assert.deepEqual(await claimPidFile(file, JSON.stringify({ pid: process.pid })), { claimed: false, holder: { pid: process.pid, note: 'mine' } });
  await writeFile(file, JSON.stringify({ pid: spawnSync(process.execPath, ['-e', '0']).pid }));
  assert.deepEqual(await claimPidFile(file, JSON.stringify({ pid: process.pid })), { claimed: true });
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { pid: process.pid });
  // A file with no pid counts as held while it is fresh.
  await writeFile(file, 'not json');
  assert.deepEqual(await claimPidFile(file, '{}'), { claimed: false, holder: null });
});
