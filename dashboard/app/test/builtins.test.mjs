import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { defaultAgentId, seedBuiltins } from '../lib/builtins.mjs';
import { fakeRegistry, tempDir } from './support/harness.mjs';

// The committed file the daemon seeds from.
const BUILTIN_FILE = fileURLToPath(new URL('../../../registry/builtin.json', import.meta.url));

function agent(id, extra = {}) {
  return Object.freeze({
    id, name: id.toUpperCase(), role: 'Role', description: 'Invented.', group: 'work', kind: 'persona',
    cwd: '/invented', provider: 'claude', jobs: [], ...extra,
  });
}

const GROUPS = [{ id: 'work', name: 'Work' }, { id: 'personal', name: 'Personal' }];

test('the committed file seeds Myos and Scout once, in key order, with their folders under the repository', async (t) => {
  const registry = fakeRegistry([agent('assistant', { pinned: true })], { groups: GROUPS });
  const logs = [];
  const added = await seedBuiltins({ registry, file: BUILTIN_FILE, root: '/invented/repo', log: (entry) => logs.push(entry) });
  assert.deepEqual(added, ['myos', 'scout']);
  assert.deepEqual(logs, [{ event: 'builtins_seeded', agents: ['myos', 'scout'] }]);
  const [written, scout] = registry.writes[0].agents.slice(-2);
  assert.deepEqual(Object.keys(written), ['id', 'name', 'role', 'description', 'group', 'kind', 'cwd', 'provider', 'builtin']);
  assert.deepEqual([written.name, written.group, written.cwd, written.builtin], ['Myos', 'personal', '/invented/repo/agents/myos', true]);
  assert.deepEqual(Object.keys(scout), ['id', 'name', 'role', 'description', 'group', 'kind', 'cwd', 'provider', 'jobs', 'builtin']);
  assert.deepEqual([scout.name, scout.role, scout.group, scout.cwd, scout.jobs, scout.builtin],
    ['Scout', 'Feeds', 'personal', '/invented/repo/agents/scout', ['com.personal-assistant.feeds'], true]);
  const myos = registry.current().agents.find((entry) => entry.id === 'myos');
  assert.equal(myos.builtin, true);
  // Quick chat and the brief still fall to Myos, the first built-in.
  assert.equal(defaultAgentId(registry.current().agents), 'myos');

  // Present: nothing written, nothing logged.
  assert.deepEqual(await seedBuiltins({ registry, file: BUILTIN_FILE, root: '/invented/repo', log: (entry) => logs.push(entry) }), []);
  assert.equal(registry.writes.length, 1);
  assert.equal(logs.length, 1);
});

test('a group the registry does not list falls back to the first group; no groups keeps it', async (t) => {
  const registry = fakeRegistry([agent('cfo')], { groups: [{ id: 'work', name: 'Work' }] });
  await seedBuiltins({ registry, file: BUILTIN_FILE, root: '/invented/repo' });
  assert.equal(registry.current().agents.find((entry) => entry.id === 'myos').group, 'work');

  const bare = fakeRegistry([agent('cfo')]);
  await seedBuiltins({ registry: bare, file: BUILTIN_FILE, root: '/invented/repo' });
  assert.equal(bare.current().agents.find((entry) => entry.id === 'myos').group, 'personal');
});

test('a missing registry is seeded with the built-ins alone', async () => {
  const missing = fakeRegistry([], { ok: false, error: 'registry_missing' });
  const logs = [];
  assert.deepEqual(await seedBuiltins({ registry: missing, file: BUILTIN_FILE, root: '/invented/repo', log: (entry) => logs.push(entry) }), ['myos', 'scout']);
  assert.equal(missing.writes.length, 1);
  assert.deepEqual(missing.writes[0].agents.map((entry) => entry.id), ['myos', 'scout']);
  assert.deepEqual(logs, [{ event: 'builtins_seeded', agents: ['myos', 'scout'] }]);
});

test('an invalid registry is skipped silently; a missing built-ins file is none; a bad file is logged', async (t) => {
  const dir = await tempDir(t);
  const logs = [];
  const log = (entry) => logs.push(entry);
  for (const error of ['registry_invalid_json', 'registry_unreadable: EACCES', 'agents[0].cwd must be an absolute path']) {
    const invalid = fakeRegistry([agent('cfo')], { ok: false, error });
    assert.deepEqual(await seedBuiltins({ registry: invalid, file: BUILTIN_FILE, root: dir, log }), [], error);
    assert.equal(invalid.writes.length, 0, error);
  }
  assert.deepEqual(logs, []);

  const registry = fakeRegistry([agent('cfo')]);
  assert.deepEqual(await seedBuiltins({ registry, file: path.join(dir, 'none.json'), root: dir, log }), []);
  assert.deepEqual(logs, []);

  const broken = path.join(dir, 'broken.json');
  await writeFile(broken, '{ not json');
  assert.deepEqual(await seedBuiltins({ registry, file: broken, root: dir, log }), []);
  const withCwd = path.join(dir, 'with-cwd.json');
  await writeFile(withCwd, JSON.stringify({ agents: [{ ...agent('x'), cwd: '/elsewhere' }] }));
  assert.deepEqual(await seedBuiltins({ registry, file: withCwd, root: dir, log }), []);
  // An entry the registry validator refuses is logged and writes nothing.
  const refused = path.join(dir, 'refused.json');
  await writeFile(refused, JSON.stringify({ agents: [{ id: 'guide', name: '', role: 'Guide', description: 'x', group: 'work', kind: 'persona', provider: 'claude' }] }));
  assert.deepEqual(await seedBuiltins({ registry, file: refused, root: dir, log }), []);
  assert.deepEqual(logs.map((entry) => entry.event), ['builtins_error', 'builtins_error', 'builtins_seed_error']);
  assert.equal(registry.writes.length, 0);
});

test('an entry without a folder gets the repository; a folder resolves under it and is not written', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'builtin.json');
  const { cwd, jobs, ...base } = agent('x');
  await writeFile(file, JSON.stringify({ agents: [
    { ...base, id: 'plain', builtin: true },
    { ...base, id: 'foldered', folder: 'agents/foldered/', builtin: true },
  ] }));
  const registry = fakeRegistry([agent('cfo')], { groups: GROUPS });
  assert.deepEqual(await seedBuiltins({ registry, file, root: '/invented/repo' }), ['plain', 'foldered']);
  const [plain, foldered] = registry.writes[0].agents.slice(-2);
  assert.equal(plain.cwd, '/invented/repo');
  assert.equal(foldered.cwd, '/invented/repo/agents/foldered');
  assert.equal('folder' in foldered, false);
  assert.deepEqual(Object.keys(foldered), ['id', 'name', 'role', 'description', 'group', 'kind', 'cwd', 'provider', 'builtin']);
});

test('a folder that is absolute, empty, or outside the repository is logged and seeds nothing', async (t) => {
  const dir = await tempDir(t);
  const { cwd, jobs, ...base } = agent('x');
  for (const folder of ['/elsewhere', '', '..', '../outside', 'agents/../../outside', 42]) {
    const file = path.join(dir, 'builtin.json');
    await writeFile(file, JSON.stringify({ agents: [{ ...base, folder }] }));
    const registry = fakeRegistry([agent('cfo')]);
    const logs = [];
    assert.deepEqual(await seedBuiltins({ registry, file, root: '/invented/repo', log: (entry) => logs.push(entry) }), [], String(folder));
    assert.deepEqual(logs.map((entry) => entry.event), ['builtins_error'], String(folder));
    assert.equal(registry.writes.length, 0);
  }
});

test('defaultAgentId picks the built-in, else the pinned, else the first Claude persona, leaving one out', () => {
  const agents = [
    agent('dev', { provider: 'codex', builtin: true }),
    agent('ops', { kind: 'system', provider: undefined }),
    agent('cfo'),
    agent('assistant', { pinned: true }),
    agent('guide', { builtin: true }),
  ];
  assert.equal(defaultAgentId(agents), 'guide');
  assert.equal(defaultAgentId(agents, { except: 'guide' }), 'assistant');
  assert.equal(defaultAgentId(agents.filter((entry) => entry.id !== 'assistant'), { except: 'guide' }), 'cfo');
  assert.equal(defaultAgentId([agent('dev', { provider: 'codex' })]), null);
  assert.equal(defaultAgentId([]), null);
});

test('the committed file is the registry\'s shape, a valid persona once given a folder', async () => {
  const parsed = JSON.parse(await readFile(BUILTIN_FILE, 'utf8'));
  assert.deepEqual(parsed.agents.map((entry) => entry.id), ['myos', 'scout']);
  for (const entry of parsed.agents) {
    assert.equal(entry.builtin, true);
    assert.equal('cwd' in entry, false);
  }
});
