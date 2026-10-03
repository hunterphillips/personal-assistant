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

test('the committed file seeds Myos once, in key order, with the repository as its folder', async (t) => {
  const registry = fakeRegistry([agent('assistant', { pinned: true })], { groups: GROUPS });
  const logs = [];
  const added = await seedBuiltins({ registry, file: BUILTIN_FILE, root: '/invented/repo', log: (entry) => logs.push(entry) });
  assert.deepEqual(added, ['myos']);
  assert.deepEqual(logs, [{ event: 'builtins_seeded', agents: ['myos'] }]);
  const written = registry.writes[0].agents.at(-1);
  assert.deepEqual(Object.keys(written), ['id', 'name', 'role', 'description', 'group', 'kind', 'cwd', 'provider', 'builtin']);
  assert.deepEqual([written.name, written.group, written.cwd, written.builtin], ['Myos', 'personal', '/invented/repo', true]);
  const myos = registry.current().agents.find((entry) => entry.id === 'myos');
  assert.equal(myos.builtin, true);

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

test('an invalid or missing registry is skipped silently; a missing file is no built-ins; a bad file is logged', async (t) => {
  const dir = await tempDir(t);
  const logs = [];
  const log = (entry) => logs.push(entry);
  const invalid = fakeRegistry([agent('cfo')], { ok: false, error: 'registry_invalid_json' });
  assert.deepEqual(await seedBuiltins({ registry: invalid, file: BUILTIN_FILE, root: dir, log }), []);
  const missing = fakeRegistry([], { ok: false, error: 'registry_missing' });
  assert.deepEqual(await seedBuiltins({ registry: missing, file: BUILTIN_FILE, root: dir, log }), []);
  assert.equal(invalid.writes.length + missing.writes.length, 0);
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
  assert.deepEqual(parsed.agents.map((entry) => entry.id), ['myos']);
  for (const entry of parsed.agents) {
    assert.equal(entry.builtin, true);
    assert.equal('cwd' in entry, false);
  }
});
