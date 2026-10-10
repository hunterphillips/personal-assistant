// The Focus notes scan over a temporary vault and a fake registry; no test
// reads Hunter's vault.

import assert from 'node:assert/strict';
import { mkdir, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import { LIMITS } from '../lib/config.mjs';
import { ScanError } from '../lib/focus/candidates.mjs';
import { scan } from '../lib/focus/scans/notes.mjs';
import { createVault } from '../lib/focus/vault.mjs';
import { tempDir } from './support/harness.mjs';

const NOW = Date.parse('2026-10-10T12:00:00Z');
const HOUR = 3600_000;

function registry(agents) {
  return { current: () => ({ ok: true, agents }) };
}

function vaultAt(root) {
  return createVault({
    registry: registry([{ id: 'second-brain', kind: 'persona', cwd: root }]),
  });
}

async function note(root, relative, text, ageMs) {
  const file = path.join(root, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
  const when = new Date(NOW - ageMs);
  await utimes(file, when, when);
  return file;
}

async function fixtureVault(t) {
  const root = path.join(await tempDir(t), 'vault');
  await mkdir(root, { recursive: true });
  return root;
}

test('recent .md and .txt notes become candidates, newest first, titled by heading or file name', async (t) => {
  const root = await fixtureVault(t);
  const plan = await note(root, 'notes/garden.md', 'intro\n## Plan the garden  \nbody\n', 2 * HOUR);
  const list = await note(root, 'inbox/list.txt', 'buy seeds\n', 30 * 60_000);
  await note(root, 'notes/old.md', '# Old\n', 4 * 24 * HOUR);
  await note(root, 'notes/image.png', 'not text', HOUR);
  await note(root, '.git/HEAD.md', '# git\n', HOUR);
  await note(root, '.claude/settings.md', '# claude\n', HOUR);
  await note(root, 'notes/current-priorities.md', '# Priorities\n', HOUR);
  await note(root, 'notes/communities.md', '# Communities\n', HOUR);

  const candidates = await scan({ vault: vaultAt(root), now: () => NOW, limits: LIMITS });
  assert.deepEqual(candidates, [
    {
      title: 'list.txt', source: 'notes', external_id: list, link: null,
      meta: 'note · edited 30m ago', text: 'buy seeds\n',
    },
    {
      title: 'Plan the garden', source: 'notes', external_id: plan, link: null,
      meta: 'note · edited 2h ago', text: 'intro\n## Plan the garden  \nbody\n',
    },
  ]);
});

test('text is capped per file and in total; later notes keep their card without text', async (t) => {
  const root = await fixtureVault(t);
  for (let i = 0; i < 7; i += 1) {
    await note(root, `notes/n${i}.md`, `# Note ${i}\n${'x'.repeat(5000)}`, (i + 1) * HOUR);
  }
  const candidates = await scan({ vault: vaultAt(root), now: NOW, limits: LIMITS });
  assert.deepEqual(candidates.map((c) => c.title), [0, 1, 2, 3, 4, 5, 6].map((i) => `Note ${i}`));
  assert.deepEqual(candidates.map((c) => c.text?.length ?? null), [4000, 4000, 4000, 4000, 4000, null, null]);
  assert.equal(candidates[1].meta, 'note · edited 2h ago');
});

test('a busy vault keeps the newest notes within the candidate limit', async (t) => {
  const root = await fixtureVault(t);
  const total = LIMITS.focusCandidatesMax + 3;
  for (let i = 0; i < total; i += 1) await note(root, `log/${i}.md`, `# Day ${i}\n`, (i + 1) * 60_000);
  const candidates = await scan({ vault: vaultAt(root), now: NOW, limits: LIMITS });
  assert.equal(candidates.length, LIMITS.focusCandidatesMax);
  assert.equal(candidates[0].title, 'Day 0');
  assert.equal(candidates.at(-1).title, `Day ${LIMITS.focusCandidatesMax - 1}`);
});

test('a long heading is cut to the title limit', async (t) => {
  const root = await fixtureVault(t);
  await note(root, 'notes/long.md', `# ${'word '.repeat(60)}\n`, HOUR);
  const [candidate] = await scan({ vault: vaultAt(root), now: NOW, limits: LIMITS });
  assert.equal(candidate.title.length, 200);
});

test('no vault folder throws ScanError vault_unavailable', async (t) => {
  const missing = path.join(await tempDir(t), 'absent');
  for (const vault of [vaultAt(missing), createVault({ registry: registry([]) })]) {
    await assert.rejects(
      scan({ vault, now: NOW, limits: LIMITS }),
      (error) => error instanceof ScanError && error.code === 'vault_unavailable',
    );
  }
});
