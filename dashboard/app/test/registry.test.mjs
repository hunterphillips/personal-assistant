import assert from 'node:assert/strict';
import { rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import { createRegistry } from '../lib/registry.mjs';
import { tempDir } from './support/harness.mjs';

async function write(dir, value) {
  const file = path.join(dir, 'agents.json');
  await writeFile(file, JSON.stringify(value));
  return file;
}

// Writes to a temp file in the same directory, then renames over the target,
// the way the real registry file is expected to be replaced.
async function writeAtomic(file, value) {
  const tmp = `${file}.${Math.random().toString(16).slice(2)}.tmp`;
  await writeFile(tmp, JSON.stringify(value));
  await rename(tmp, file);
}

async function waitUntil(predicate, { timeout = 2000, interval = 10 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error('condition not met in time');
}

function baseAgent(cwd, overrides = {}) {
  return {
    id: 'cfo',
    name: 'CFO',
    role: 'Money',
    description: 'I keep the money picture.',
    group: 'work',
    kind: 'persona',
    cwd,
    provider: 'claude',
    ...overrides,
  };
}

test('a valid file loads all fields and defaults routines to []', async (t) => {
  const dir = await tempDir(t);
  const file = await write(dir, {
    version: 1,
    agents: [
      baseAgent(dir, { routines: ['com.hunter.cfo.daily'] }),
      {
        id: 'assistant',
        name: 'Assistant',
        role: 'System',
        description: 'The dashboard itself.',
        group: 'personal',
        kind: 'system',
        cwd: dir,
      },
    ],
  });
  const registry = createRegistry({ path: file, pollMs: 10_000 });
  await registry.start();
  t.after(() => registry.stop());

  const state = registry.current();
  assert.equal(state.ok, true);
  assert.equal(state.error, null);
  assert.equal(state.path, file);
  assert.match(state.loadedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(state.agents.length, 2);
  assert.deepEqual(state.agents[0].routines, ['com.hunter.cfo.daily']);
  assert.deepEqual(state.agents[1].routines, []);
  assert.equal(state.agents[1].provider, undefined);
  assert.ok(Object.isFrozen(state));
  assert.ok(Object.isFrozen(state.agents));
  assert.ok(Object.isFrozen(state.agents[0]));
});

test('duplicate id is rejected and names both agents', async (t) => {
  const dir = await tempDir(t);
  const file = await write(dir, {
    version: 1,
    agents: [
      baseAgent(dir, { id: 'cfo' }),
      baseAgent(dir, { id: 'cfo', role: 'Other' }),
    ],
  });
  const registry = createRegistry({ path: file, pollMs: 10_000 });
  await registry.start();
  t.after(() => registry.stop());

  const state = registry.current();
  assert.equal(state.ok, false);
  assert.match(state.error, /agent 1 \(cfo\)/);
  assert.match(state.error, /agent 0/);
});

test('a duplicate routine label across agents is rejected', async (t) => {
  const dir = await tempDir(t);
  const file = await write(dir, {
    version: 1,
    agents: [
      baseAgent(dir, { id: 'cfo', routines: ['com.hunter.shared'] }),
      baseAgent(dir, { id: 'focus', routines: ['com.hunter.shared'] }),
    ],
  });
  const registry = createRegistry({ path: file, pollMs: 10_000 });
  await registry.start();
  t.after(() => registry.stop());

  const state = registry.current();
  assert.equal(state.ok, false);
  assert.match(state.error, /com\.hunter\.shared/);
  assert.match(state.error, /agent 1 \(focus\)/);
});

test('a routine label starting with a hyphen is rejected', async (t) => {
  const dir = await tempDir(t);
  const file = await write(dir, {
    version: 1,
    agents: [baseAgent(dir, { routines: ['-x'] })],
  });
  const registry = createRegistry({ path: file, pollMs: 10_000 });
  await registry.start();
  t.after(() => registry.stop());

  const state = registry.current();
  assert.equal(state.ok, false);
  assert.match(state.error, /routines must be an array of strings matching/);
});

test('a missing cwd directory is rejected', async (t) => {
  const dir = await tempDir(t);
  const file = await write(dir, {
    version: 1,
    agents: [baseAgent(dir, { cwd: path.join(dir, 'does-not-exist') })],
  });
  const registry = createRegistry({ path: file, pollMs: 10_000 });
  await registry.start();
  t.after(() => registry.stop());

  const state = registry.current();
  assert.equal(state.ok, false);
  assert.match(state.error, /cwd/);
});

test('a system agent with a provider is rejected', async (t) => {
  const dir = await tempDir(t);
  const file = await write(dir, {
    version: 1,
    agents: [
      {
        id: 'assistant',
        name: 'Assistant',
        role: 'System',
        description: 'The dashboard itself.',
        group: 'personal',
        kind: 'system',
        cwd: dir,
        provider: 'claude',
      },
    ],
  });
  const registry = createRegistry({ path: file, pollMs: 10_000 });
  await registry.start();
  t.after(() => registry.stop());

  const state = registry.current();
  assert.equal(state.ok, false);
  assert.match(state.error, /provider/);
});

test('group is any slug; the groups list loads in order and rejects bad entries', async (t) => {
  const dir = await tempDir(t);
  const file = await write(dir, {
    version: 1,
    groups: [{ id: 'work', name: 'Work' }, { id: 'family', name: 'Family' }],
    agents: [baseAgent(dir, { group: 'family' }), baseAgent(dir, { id: 'ops', group: 'side-projects' })],
  });
  const registry = createRegistry({ path: file, pollMs: 10_000 });
  await registry.start();
  t.after(() => registry.stop());

  const state = registry.current();
  assert.equal(state.ok, true);
  assert.deepEqual(state.groups, [{ id: 'work', name: 'Work' }, { id: 'family', name: 'Family' }]);
  assert.ok(Object.isFrozen(state.groups) && Object.isFrozen(state.groups[0]));
  assert.deepEqual(state.agents.map((agent) => agent.group), ['family', 'side-projects']);

  const cases = [
    [{ groups: 'work' }, /groups must be an array/],
    [{ groups: [{ id: 'Work', name: 'Work' }] }, /group 0: id must match/],
    [{ groups: [{ id: 'work', name: '' }] }, /group 0: name must be/],
    [{ groups: [{ id: 'work', name: 'Work' }, { id: 'work', name: 'Again' }] }, /group 1: id duplicates group 0/],
    [{ groups: [{ id: 'work', name: 'Work', extra: 1 }] }, /group 0: unknown key "extra"/],
    [{ groups: Array.from({ length: 21 }, (_, i) => ({ id: `g${i}`, name: `G${i}` })) }, /at most 20/],
    [{ agents: [baseAgent(dir, { group: 'Not a slug' })] }, /group must match/],
  ];
  for (const [fields, pattern] of cases) {
    const bad = path.join(dir, `bad-${cases.indexOf(cases.find((c) => c[0] === fields))}.json`);
    await writeFile(bad, JSON.stringify({ version: 1, agents: [baseAgent(dir)], ...fields }));
    const badRegistry = createRegistry({ path: bad, pollMs: 10_000 });
    await badRegistry.start();
    t.after(() => badRegistry.stop());
    assert.equal(badRegistry.current().ok, false, JSON.stringify(fields));
    assert.match(badRegistry.current().error, pattern);
  }
});

test('a file without groups loads with an empty list, and a bad read keeps the last good groups', async (t) => {
  const dir = await tempDir(t);
  const file = await write(dir, { version: 1, agents: [baseAgent(dir)] });
  const registry = createRegistry({ path: file, pollMs: 10 });
  await registry.start();
  t.after(() => registry.stop());
  assert.deepEqual(registry.current().groups, []);

  await writeAtomic(file, { version: 1, groups: [{ id: 'work', name: 'Work' }], agents: [baseAgent(dir)] });
  await waitUntil(() => registry.current().groups.length === 1);
  await writeFile(file, '{ not json');
  await waitUntil(() => registry.current().ok === false);
  assert.deepEqual(registry.current().groups, [{ id: 'work', name: 'Work' }]);
});

test('pinned is kept on a persona, dropped when false, and rejected on other kinds or non-booleans', async (t) => {
  const dir = await tempDir(t);
  const file = await write(dir, {
    version: 1,
    agents: [
      baseAgent(dir, { id: 'assistant', pinned: true, routines: ['com.invented.dashboard'] }),
      baseAgent(dir, { id: 'cfo', pinned: false }),
      baseAgent(dir, { id: 'plain' }),
    ],
  });
  const registry = createRegistry({ path: file, pollMs: 10_000 });
  await registry.start();
  t.after(() => registry.stop());

  const state = registry.current();
  assert.equal(state.ok, true, state.error);
  assert.equal(state.agents[0].pinned, true);
  assert.deepEqual(state.agents[0].routines, ['com.invented.dashboard']);
  assert.equal('pinned' in state.agents[1], false);
  assert.equal('pinned' in state.agents[2], false);

  for (const [name, entry, pattern] of [
    ['project', baseAgent(dir, { kind: 'project', pinned: true }), /pinned is only for a persona/],
    ['system', { ...baseAgent(dir, { kind: 'system', pinned: true }), provider: undefined }, /pinned is only for a persona/],
    ['string', baseAgent(dir, { pinned: 'yes' }), /pinned must be true or false/],
  ]) {
    const bad = path.join(dir, `${name}.json`);
    await writeFile(bad, JSON.stringify({ version: 1, agents: [entry] }));
    const badRegistry = createRegistry({ path: bad, pollMs: 10_000 });
    await badRegistry.start();
    t.after(() => badRegistry.stop());
    assert.equal(badRegistry.current().ok, false, name);
    assert.match(badRegistry.current().error, pattern);
  }
});

test('an unknown key on an agent is rejected', async (t) => {
  const dir = await tempDir(t);
  const file = await write(dir, {
    version: 1,
    agents: [baseAgent(dir, { extra: 'nope' })],
  });
  const registry = createRegistry({ path: file, pollMs: 10_000 });
  await registry.start();
  t.after(() => registry.stop());

  const state = registry.current();
  assert.equal(state.ok, false);
  assert.match(state.error, /unknown key "extra"/);
});

test('a file over the 256 KiB cap is rejected as oversized', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'agents.json');
  await writeFile(file, JSON.stringify({ version: 1, agents: [baseAgent(dir)] }) + ' '.repeat(256 * 1024));
  const registry = createRegistry({ path: file, pollMs: 10_000 });
  await registry.start();
  t.after(() => registry.stop());

  const state = registry.current();
  assert.equal(state.ok, false);
  assert.equal(state.error, 'registry_oversized');
});

test('invalid JSON keeps the last good agents and sets error', async (t) => {
  const dir = await tempDir(t);
  const file = await write(dir, { version: 1, agents: [baseAgent(dir)] });
  const registry = createRegistry({ path: file, pollMs: 20 });
  await registry.start();
  t.after(() => registry.stop());
  assert.equal(registry.current().ok, true);
  const goodAgents = registry.current().agents;

  await writeFile(file, '{ this is not json');
  await waitUntil(() => registry.current().ok === false);

  const state = registry.current();
  assert.equal(state.ok, false);
  assert.equal(state.error, 'registry_invalid_json');
  assert.deepEqual(state.agents, goodAgents);
});

test('replacing the file with a good one via write-then-rename is picked up on the next poll', async (t) => {
  const dir = await tempDir(t);
  const file = await write(dir, { version: 1, agents: [baseAgent(dir, { id: 'cfo' })] });
  const registry = createRegistry({ path: file, pollMs: 20 });
  await registry.start();
  t.after(() => registry.stop());
  assert.deepEqual(registry.current().agents.map((a) => a.id), ['cfo']);

  await writeAtomic(file, { version: 1, agents: [baseAgent(dir, { id: 'focus', role: 'Attention' })] });
  await waitUntil(() => registry.current().agents.map((a) => a.id).join(',') === 'focus');

  const state = registry.current();
  assert.equal(state.ok, true);
  assert.equal(state.agents.length, 1);
  assert.equal(state.agents[0].id, 'focus');
});

test('a missing file at start reports registry_missing', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'nope.json');
  const registry = createRegistry({ path: file, pollMs: 10_000 });
  await registry.start();
  t.after(() => registry.stop());

  const state = registry.current();
  assert.equal(state.ok, false);
  assert.equal(state.error, 'registry_missing');
  assert.deepEqual(state.agents, []);
});

test('stop() stops polling', async (t) => {
  const dir = await tempDir(t);
  const file = await write(dir, { version: 1, agents: [baseAgent(dir, { id: 'cfo' })] });
  const registry = createRegistry({ path: file, pollMs: 20 });
  await registry.start();
  registry.stop();
  t.after(() => registry.stop());

  await writeAtomic(file, { version: 1, agents: [baseAgent(dir, { id: 'focus', role: 'Attention' })] });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(registry.current().agents.map((a) => a.id), ['cfo']);
});

test('the same recurring error is logged once, not on every poll', async (t) => {
  const dir = await tempDir(t);
  const file = await write(dir, { version: 1, agents: [baseAgent(dir)] });
  const events = [];
  const registry = createRegistry({ path: file, pollMs: 20, log: (entry) => events.push(entry) });
  await registry.start();
  t.after(() => registry.stop());

  await writeFile(file, '{ broken one');
  await waitUntil(() => registry.current().ok === false);
  await writeFile(file, '{ broken two, different length');
  await waitUntil(() => events.length >= 1);
  // Give a couple more poll cycles a chance to fire before asserting the count.
  await new Promise((resolve) => setTimeout(resolve, 80));

  const registryErrors = events.filter((event) => event.event === 'registry_error');
  assert.equal(registryErrors.length, 1);
  assert.equal(registryErrors[0].error, 'registry_invalid_json');
});

test('onChange fires after every load attempt and can be unsubscribed', async (t) => {
  const dir = await tempDir(t);
  const file = await write(dir, { version: 1, agents: [baseAgent(dir)] });
  const registry = createRegistry({ path: file, pollMs: 20 });
  const seen = [];
  const unsubscribe = registry.onChange((state) => seen.push(state.ok));
  await registry.start();
  t.after(() => registry.stop());
  assert.deepEqual(seen, [true]);

  unsubscribe();
  await writeFile(file, 'not json');
  await waitUntil(() => registry.current().ok === false);
  assert.deepEqual(seen, [true]);
});

test('an unchanged file does not re-read or notify on later polls', async (t) => {
  const dir = await tempDir(t);
  const file = await write(dir, { version: 1, agents: [baseAgent(dir)] });
  const events = [];
  const calls = [];
  const registry = createRegistry({ path: file, pollMs: 20, log: (entry) => events.push(entry) });
  registry.onChange((state) => calls.push(state.ok));
  await registry.start();
  t.after(() => registry.stop());

  // Give a few poll cycles a chance to fire against the unchanged file.
  await new Promise((resolve) => setTimeout(resolve, 80));

  assert.equal(calls.length, 1);
  assert.equal(events.length, 0);
});

test('a missing file notifies once, then again only when the file appears', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'nope.json');
  const calls = [];
  const registry = createRegistry({ path: file, pollMs: 20 });
  registry.onChange((state) => calls.push(state.ok));
  await registry.start();
  t.after(() => registry.stop());
  assert.equal(registry.current().error, 'registry_missing');
  assert.equal(calls.length, 1);

  // Several more poll cycles against the still-missing file must not notify again.
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(calls.length, 1);

  await writeFile(file, JSON.stringify({ version: 1, agents: [baseAgent(dir)] }));
  await waitUntil(() => registry.current().ok === true);
  assert.equal(calls.length, 2);
});

test('model is accepted on a persona and rejected on a system agent', async (t) => {
  const dir = await tempDir(t);
  const file = await write(dir, {
    version: 1,
    agents: [baseAgent(dir, { model: 'claude-sonnet-5' })],
  });
  const registry = createRegistry({ path: file, pollMs: 10_000 });
  await registry.start();
  t.after(() => registry.stop());

  const state = registry.current();
  assert.equal(state.ok, true);
  assert.equal(state.agents[0].model, 'claude-sonnet-5');

  const systemFile = path.join(dir, 'system.json');
  await writeFile(systemFile, JSON.stringify({
    version: 1,
    agents: [
      {
        id: 'assistant',
        name: 'Assistant',
        role: 'System',
        description: 'The dashboard itself.',
        group: 'personal',
        kind: 'system',
        cwd: dir,
        model: 'claude-sonnet-5',
      },
    ],
  }));
  const systemRegistry = createRegistry({ path: systemFile, pollMs: 10_000 });
  await systemRegistry.start();
  t.after(() => systemRegistry.stop());

  const systemState = systemRegistry.current();
  assert.equal(systemState.ok, false);
  assert.match(systemState.error, /model/);
});

test('model is absent from the frozen agent when not given', async (t) => {
  const dir = await tempDir(t);
  const file = await write(dir, { version: 1, agents: [baseAgent(dir)] });
  const registry = createRegistry({ path: file, pollMs: 10_000 });
  await registry.start();
  t.after(() => registry.stop());

  const state = registry.current();
  assert.equal(state.ok, true);
  assert.equal('model' in state.agents[0], false);
});

test('start() called twice does not arm a second poll', async (t) => {
  const dir = await tempDir(t);
  const file = await write(dir, { version: 1, agents: [baseAgent(dir)] });
  const calls = [];
  const registry = createRegistry({ path: file, pollMs: 20 });
  registry.onChange((state) => calls.push(state.ok));
  await registry.start();
  await registry.start();
  t.after(() => registry.stop());

  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(calls.length, 1);
});
