import assert from 'node:assert/strict';
import { chmod, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import { RegistryError, createRegistry, validateDocument } from '../lib/registry.mjs';
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

test('a valid file loads all fields and defaults jobs to []', async (t) => {
  const dir = await tempDir(t);
  const file = await write(dir, {
    version: 1,
    agents: [
      baseAgent(dir, { jobs: ['com.hunter.cfo.daily'] }),
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
  assert.deepEqual(state.agents[0].jobs, ['com.hunter.cfo.daily']);
  assert.deepEqual(state.agents[1].jobs, []);
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

test('a duplicate job label across agents is rejected', async (t) => {
  const dir = await tempDir(t);
  const file = await write(dir, {
    version: 1,
    agents: [
      baseAgent(dir, { id: 'cfo', jobs: ['com.hunter.shared'] }),
      baseAgent(dir, { id: 'focus', jobs: ['com.hunter.shared'] }),
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

test('a job label starting with a hyphen is rejected', async (t) => {
  const dir = await tempDir(t);
  const file = await write(dir, {
    version: 1,
    agents: [baseAgent(dir, { jobs: ['-x'] })],
  });
  const registry = createRegistry({ path: file, pollMs: 10_000 });
  await registry.start();
  t.after(() => registry.stop());

  const state = registry.current();
  assert.equal(state.ok, false);
  assert.match(state.error, /jobs must be an array of strings matching/);
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
      baseAgent(dir, { id: 'assistant', pinned: true, jobs: ['com.invented.dashboard'] }),
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
  assert.deepEqual(state.agents[0].jobs, ['com.invented.dashboard']);
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

test('the old routines key is an unknown key, not an alias for jobs', async (t) => {
  const dir = await tempDir(t);
  const file = await write(dir, {
    version: 1,
    agents: [baseAgent(dir, { routines: ['com.hunter.cfo.daily'] })],
  });
  const registry = createRegistry({ path: file, pollMs: 10_000 });
  await registry.start();
  t.after(() => registry.stop());

  const state = registry.current();
  assert.equal(state.ok, false);
  assert.match(state.error, /unknown key "routines"/);
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

// --- effort, accepts, validateDocument, write -------------------------------

test('effort is accepted on a persona, must be an SDK level, and is absent for a system agent', async (t) => {
  const dir = await tempDir(t);
  const file = await write(dir, { version: 1, agents: [baseAgent(dir, { effort: 'low' })] });
  const registry = createRegistry({ path: file, pollMs: 10_000 });
  await registry.start();
  t.after(() => registry.stop());
  assert.equal(registry.current().agents[0].effort, 'low');

  const bad = createRegistry({ path: await write(dir, { version: 1, agents: [baseAgent(dir, { effort: 'extreme' })] }), pollMs: 10_000 });
  await bad.start();
  t.after(() => bad.stop());
  assert.match(bad.current().error, /effort must be one of/);

  const systemDir = await tempDir(t);
  const system = createRegistry({
    path: await write(systemDir, {
      version: 1,
      agents: [{ id: 'ops', name: 'Ops', role: 'System', description: 'x', group: 'personal', kind: 'system', cwd: systemDir, effort: 'high' }],
    }),
    pollMs: 10_000,
  });
  await system.start();
  t.after(() => system.stop());
  assert.match(system.current().error, /effort must be absent/);
});

test('permission is one of ask, auto, full on a persona, absent for a system agent, and kept but unused on a project', async (t) => {
  const dir = await tempDir(t);
  const registry = createRegistry({ path: await write(dir, { version: 1, agents: [baseAgent(dir, { permission: 'auto' })] }), pollMs: 10_000 });
  await registry.start();
  t.after(() => registry.stop());
  assert.equal(registry.current().agents[0].permission, 'auto');

  const absent = createRegistry({ path: await write(await tempDir(t), { version: 1, agents: [baseAgent(dir)] }), pollMs: 10_000 });
  await absent.start();
  t.after(() => absent.stop());
  assert.equal('permission' in absent.current().agents[0], false);

  const bad = createRegistry({ path: await write(await tempDir(t), { version: 1, agents: [baseAgent(dir, { permission: 'bypass' })] }), pollMs: 10_000 });
  await bad.start();
  t.after(() => bad.stop());
  assert.match(bad.current().error, /permission must be one of ask, auto, full/);

  const systemDir = await tempDir(t);
  const system = createRegistry({
    path: await write(systemDir, {
      version: 1,
      agents: [{ id: 'ops', name: 'Ops', role: 'System', description: 'x', group: 'personal', kind: 'system', cwd: systemDir, permission: 'ask' }],
    }),
    pollMs: 10_000,
  });
  await system.start();
  t.after(() => system.stop());
  assert.match(system.current().error, /permission must be absent/);

  const project = createRegistry({ path: await write(await tempDir(t), { version: 1, agents: [baseAgent(dir, { kind: 'project', permission: 'full' })] }), pollMs: 10_000 });
  await project.start();
  t.after(() => project.stop());
  assert.equal(project.current().ok, true);
  assert.equal(project.current().agents[0].permission, 'full');
});

test('accepts names other agents in the file; absent and null both load as everyone', async (t) => {
  const dir = await tempDir(t);
  const other = baseAgent(dir, { id: 'assistant', name: 'Assistant' });
  const file = await write(dir, { version: 1, agents: [baseAgent(dir, { accepts: ['assistant'] }), { ...other, accepts: null }] });
  const registry = createRegistry({ path: file, pollMs: 10_000 });
  await registry.start();
  t.after(() => registry.stop());
  const [cfo, assistant] = registry.current().agents;
  assert.deepEqual(cfo.accepts, ['assistant']);
  assert.equal(Object.isFrozen(cfo.accepts), true);
  assert.equal('accepts' in assistant, false);

  const cases = [
    [[baseAgent(dir, { accepts: ['nobody'] })], /accepts names no agent "nobody"/],
    [[baseAgent(dir, { accepts: ['cfo'] })], /must not name the agent itself/],
    [[baseAgent(dir, { accepts: ['assistant', 'assistant'] }), other], /must not repeat/],
    [[baseAgent(dir, { accepts: Array.from({ length: 101 }, (_, i) => `a${i}`) })], /at most 100/],
    [[baseAgent(dir, { accepts: 'assistant' }), other], /array of agent ids/],
    [[{ ...baseAgent(dir, { id: 'proj', kind: 'project', accepts: ['cfo'] }) }, baseAgent(dir)], /only for a persona/],
  ];
  for (const [agents, pattern] of cases) {
    const caseDir = await tempDir(t);
    const bad = createRegistry({ path: await write(caseDir, { version: 1, agents: agents.map((a) => ({ ...a, cwd: caseDir })) }), pollMs: 10_000 });
    await bad.start();
    t.after(() => bad.stop());
    assert.equal(bad.current().ok, false, pattern.source);
    assert.match(bad.current().error, pattern);
  }
});

test('validateDocument reports problems and takes a directory check of its own', async (t) => {
  const dir = await tempDir(t);
  const good = validateDocument({ version: 1, groups: [{ id: 'work', name: 'Work' }], agents: [baseAgent(dir)] });
  assert.equal(good.ok, true);
  assert.deepEqual(good.problems, []);
  assert.equal(good.groups[0].name, 'Work');

  const invented = validateDocument({ version: 1, agents: [baseAgent('/invented/cfo')] });
  assert.equal(invented.ok, false);
  assert.deepEqual(invented.problems, ['agent 0 (cfo): cwd must exist and be a directory']);
  const overridden = validateDocument({ version: 1, agents: [baseAgent('/invented/cfo')] }, { isDirectory: () => true });
  assert.equal(overridden.ok, true);

  const empty = validateDocument({ version: 1, agents: [] });
  assert.deepEqual(empty.problems, ['registry: agents must be a non-empty array']);
});

test('write refuses an invalid document and leaves the file byte-identical', async (t) => {
  const dir = await tempDir(t);
  const file = await write(dir, { version: 1, agents: [baseAgent(dir)], note: 'kept' });
  const before = await readFile(file);
  const registry = createRegistry({ path: file, pollMs: 10_000 });
  await registry.start();
  t.after(() => registry.stop());

  await assert.rejects(
    registry.write((document) => ({ ...document, agents: [{ ...document.agents[0], name: '' }] })),
    (error) => error instanceof RegistryError && error.code === 'invalid_registry'
      && error.problems.length === 1 && /name must be/.test(error.problems[0]),
  );
  assert.deepEqual(await readFile(file), before);
  assert.equal((await readdir(dir)).length, 1, 'no temporary file left behind');
});

test('write replaces the file atomically with the candidate as 2-space JSON, keeps its mode and unknown keys, and loads at once', async (t) => {
  const dir = await tempDir(t);
  const file = await write(dir, { version: 1, agents: [baseAgent(dir)], note: 'kept' });
  await chmod(file, 0o640);
  const registry = createRegistry({ path: file, pollMs: 20 });
  const loads = [];
  registry.onChange((state) => loads.push(state.agents.map((a) => a.name)));
  await registry.start();
  t.after(() => registry.stop());

  const result = await registry.write((document) => ({
    ...document,
    agents: [{ ...document.agents[0], name: 'Money desk', accepts: null }, baseAgent(dir, { id: 'assistant', name: 'Assistant', effort: 'high' })],
  }));
  assert.deepEqual(result.agents.map((a) => a.name), ['Money desk', 'Assistant']);
  assert.deepEqual(registry.current().agents.map((a) => a.name), ['Money desk', 'Assistant'], 'current() changed before write resolved');
  assert.deepEqual(loads, [['CFO'], ['Money desk', 'Assistant']]);

  const text = await readFile(file, 'utf8');
  assert.equal(text, `${JSON.stringify(JSON.parse(text), null, 2)}\n`, 'pretty-printed with two spaces');
  const parsed = JSON.parse(text);
  assert.equal(parsed.note, 'kept');
  assert.equal(parsed.agents[0].accepts, null, 'the candidate is written as given, not normalized');
  assert.equal((await stat(file)).mode & 0o777, 0o640);
  assert.equal((await readdir(dir)).length, 1);

  // The poll sees the write's own signature and does not load a second time.
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(loads.length, 2);
});

test('writes are single-flight: the second sees the first', async (t) => {
  const dir = await tempDir(t);
  const file = await write(dir, { version: 1, agents: [baseAgent(dir)] });
  const registry = createRegistry({ path: file, pollMs: 10_000 });
  await registry.start();
  t.after(() => registry.stop());

  const add = (id) => (document) => ({ ...document, agents: [...document.agents, baseAgent(dir, { id, name: id })] });
  const [first, second] = await Promise.all([registry.write(add('one')), registry.write(add('two'))]);
  assert.deepEqual(first.agents.map((a) => a.id), ['cfo', 'one']);
  assert.deepEqual(second.agents.map((a) => a.id), ['cfo', 'one', 'two']);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).agents.map((a) => a.id), ['cfo', 'one', 'two']);
});

test('write refuses registry_invalid while the file does not load, and registry_invalid_json for broken JSON', async (t) => {
  const dir = await tempDir(t);
  const file = await write(dir, { version: 1, agents: [baseAgent(dir)] });
  const registry = createRegistry({ path: file, pollMs: 20 });
  await registry.start();
  t.after(() => registry.stop());

  await writeAtomic(file, { version: 1, agents: [baseAgent(dir, { role: '' })] });
  await waitUntil(() => registry.current().ok === false);
  await assert.rejects(registry.write((d) => d), (error) => error.code === 'registry_invalid' && /role/.test(error.problems[0]));

  await writeFile(file, '{ not json');
  await waitUntil(() => registry.current().error === 'registry_invalid_json');
  await assert.rejects(registry.write((d) => d), { code: 'registry_invalid' });
  assert.equal(await readFile(file, 'utf8'), '{ not json', 'a hand-broken file is left alone');
});

test('a missing file is created by a mutation that yields a valid registry, and not by one that does not', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'agents.json');
  const registry = createRegistry({ path: file, pollMs: 10_000 });
  await registry.start();
  t.after(() => registry.stop());
  assert.equal(registry.current().error, 'registry_missing');

  await assert.rejects(registry.write((document) => document), { code: 'invalid_registry' });
  await assert.rejects(stat(file), { code: 'ENOENT' });

  const result = await registry.write((document) => ({ ...document, agents: [baseAgent(dir)] }));
  assert.deepEqual(result.agents.map((a) => a.id), ['cfo']);
  assert.equal(registry.current().ok, true);
  assert.equal((await stat(file)).mode & 0o777, 0o644);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { version: 1, groups: [], agents: [baseAgent(dir)] });
});

test('builtin is kept on a persona, dropped when false, and rejected on other kinds or non-booleans', async (t) => {
  const dir = await tempDir(t);
  const file = await write(dir, {
    version: 1,
    agents: [baseAgent(dir, { id: 'guide', pinned: true, builtin: true }), baseAgent(dir, { id: 'cfo', builtin: false })],
  });
  const registry = createRegistry({ path: file, pollMs: 10_000 });
  await registry.start();
  t.after(() => registry.stop());
  const state = registry.current();
  assert.equal(state.ok, true, state.error);
  assert.equal(state.agents[0].builtin, true);
  assert.equal('builtin' in state.agents[1], false);

  for (const [name, entry, pattern] of [
    ['project', baseAgent(dir, { kind: 'project', builtin: true }), /builtin is only for a persona/],
    ['string', baseAgent(dir, { builtin: 'yes' }), /builtin must be true or false/],
  ]) {
    const bad = path.join(dir, `builtin-${name}.json`);
    await writeFile(bad, JSON.stringify({ version: 1, agents: [entry] }));
    const badRegistry = createRegistry({ path: bad, pollMs: 10_000 });
    await badRegistry.start();
    t.after(() => badRegistry.stop());
    assert.equal(badRegistry.current().ok, false, name);
    assert.match(badRegistry.current().error, pattern);
  }
});
