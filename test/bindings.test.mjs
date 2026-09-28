import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import { MAX_BINDINGS, appendBinding, createBindings } from '../lib/bindings.mjs';
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
