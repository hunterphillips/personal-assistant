// The Focus vault and profile inputs use temporary folders and injected
// subprocesses; no test reads Hunter's vault or runs the real selector.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import { TIMEOUTS } from '../lib/config.mjs';
import { createProfile } from '../lib/focus/profile.mjs';
import { createVault } from '../lib/focus/vault.mjs';
import { tempDir } from './support/harness.mjs';

function persona(cwd, overrides = {}) {
  return { id: 'second-brain', kind: 'persona', cwd, ...overrides };
}

function registry(agents) {
  return { current: () => ({ ok: true, agents }) };
}

async function fixtureVault(t) {
  const root = path.join(await tempDir(t), 'vault');
  await mkdir(path.join(root, 'notes'), { recursive: true });
  await mkdir(path.join(root, 'log'), { recursive: true });
  await writeFile(path.join(root, 'notes/current-priorities.md'), 'current\n');
  await writeFile(path.join(root, 'notes/longterm-priorities.md'), `${'x'.repeat(12_100)}\n`);
  await writeFile(path.join(root, 'notes/communities.md'), [
    '- **Garden club** — `list@garden.example`',
    '  also `@garden.example`',
    '- **Book club** — `books.example.org` `list@garden.example`',
    '',
    'Outside `person@example.net`',
  ].join('\n'));
  await writeFile(path.join(root, 'notes/projects-overview.md'), 'projects\n');
  await writeFile(path.join(root, 'log/audit-2026-09.md'), 'audit\n');
  return root;
}

test('vault resolves the persona root and preserves the old context files and extraction', async (t) => {
  const root = await fixtureVault(t);
  const vault = createVault({ registry: registry([persona(root)]) });
  assert.equal(vault.root(), root);
  assert.deepEqual(vault.priorityFiles(), [
    path.join(root, 'notes/current-priorities.md'),
    path.join(root, 'notes/longterm-priorities.md'),
    path.join(root, 'notes/communities.md'),
  ]);
  const priorities = vault.readPriorities();
  assert.match(priorities, /current/);
  assert.ok(priorities.includes('x'.repeat(12_000)));
  assert.ok(!priorities.includes('x'.repeat(12_001)), 'each context block is capped at 12,000 characters');
  assert.deepEqual(vault.communitySenders(), [
    'list@garden.example', 'garden.example', 'books.example.org', 'person@example.net',
  ]);
  assert.deepEqual(vault.communityGroups(), [
    { name: 'Garden club', email: 'list@garden.example' },
    { name: 'Garden club', email: 'garden.example' },
    { name: 'Book club', email: 'books.example.org' },
    { name: null, email: 'person@example.net' },
  ]);
  assert.match(vault.readProjectState(new Date('2026-09-24T12:00:00Z')), /projects[\s\S]*audit/);
  assert.ok(Object.isFrozen(vault));
  assert.ok(Object.isFrozen(vault.communityGroups()[0]));
});

test('project state takes the injected clock when no time is given', async (t) => {
  const root = await fixtureVault(t);
  const september = createVault({ registry: registry([persona(root)]), now: () => new Date('2026-09-24T12:00:00Z') });
  assert.match(september.readProjectState(), /audit/);
  const october = createVault({ registry: registry([persona(root)]), now: () => new Date('2026-10-24T12:00:00Z') });
  assert.doesNotMatch(october.readProjectState(), /audit/);
});

test('a symlinked or FIFO context file reads as absent', { skip: process.platform === 'win32' }, async (t) => {
  const root = await fixtureVault(t);
  const outside = path.join(await tempDir(t), 'outside.md');
  await writeFile(outside, 'outside secret\n');
  await rm(path.join(root, 'notes/current-priorities.md'));
  await symlink(outside, path.join(root, 'notes/current-priorities.md'));
  await rm(path.join(root, 'notes/communities.md'));
  const fifo = spawnSync('mkfifo', [path.join(root, 'notes/communities.md')]);
  assert.equal(fifo.status, 0, String(fifo.stderr));
  const vault = createVault({ registry: registry([persona(root)]) });
  const priorities = vault.readPriorities();
  assert.doesNotMatch(priorities, /outside secret|current-priorities|communities/);
  assert.match(priorities, /longterm-priorities/);
  assert.deepEqual(vault.communitySenders(), []);
});

test('absent, non-persona, missing, and non-directory roots are unavailable', async (t) => {
  const missing = path.join(await tempDir(t), 'absent');
  const file = path.join(await tempDir(t), 'not-a-folder');
  await writeFile(file, 'x');
  for (const agents of [[], [persona(missing)], [persona(file)], [persona(await fixtureVault(t), { kind: 'command' })]]) {
    const vault = createVault({ registry: registry(agents) });
    assert.equal(vault.root(), null);
    assert.equal(vault.readPriorities(), '');
    assert.equal(vault.readProjectState(new Date()), '');
    assert.deepEqual(vault.communitySenders(), []);
    assert.deepEqual(vault.communityGroups(), []);
    assert.deepEqual(vault.priorityFiles(), []);
  }
});

test('profile runs only the selector with the Focus caller and trims output', async (t) => {
  const dir = await tempDir(t);
  await mkdir(path.join(dir, 'resolver'));
  await writeFile(path.join(dir, 'resolver/select.mjs'), 'not executed');
  const calls = [];
  const execFile = (command, args, options, callback) => {
    calls.push({ command, args, options });
    callback(null, '  selected context\n');
  };
  const profile = createProfile({ dir, execFile, timeoutMs: 4321 });
  assert.equal(await profile.read(), 'selected context');
  assert.deepEqual(calls[0], {
    command: process.execPath,
    args: [path.join(dir, 'resolver/select.mjs'), '--caller', 'focus'],
    options: { encoding: 'utf8', timeout: 4321, windowsHide: true },
  });
  assert.ok(Object.isFrozen(profile));

  await createProfile({ dir, execFile }).read();
  assert.equal(calls[1].options.timeout, TIMEOUTS.focusScanMs);
});

test('profile answers empty for a missing store, non-zero exit, and timeout', async (t) => {
  const missing = createProfile({
    dir: path.join(await tempDir(t), 'missing'),
    execFile: () => assert.fail('missing stores must not spawn'),
    timeoutMs: 10,
  });
  assert.equal(await missing.read(), '');

  const dir = await tempDir(t);
  for (const error of [Object.assign(new Error('exit 2'), { code: 2 }), Object.assign(new Error('timed out'), { killed: true })]) {
    const profile = createProfile({ dir, execFile: (_command, _args, _options, callback) => callback(error, ''), timeoutMs: 10 });
    assert.equal(await profile.read(), '');
  }
});
