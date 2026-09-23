// An isolated copy of the real Focus server, for write tests that must never
// touch Hunter's board.
//
// How the fixture is built:
//   1. Copy ui/server.mjs, ui/index.html, and every module they import
//      through relative paths (found by scanning import statements, so
//      lib/store.mjs, lib/validate.mjs, lib/status.mjs, and anything added
//      later) from the Focus checkout into a new temporary directory, keeping
//      the relative layout. store.mjs derives its root from its own location,
//      so the copy reads and commits in the temporary directory.
//   2. Write SYNTHETIC_DOC as focus.json. It is invented, not copied from the
//      real board, and is checked with the copied validator before use.
//   3. `git init`, set a local user.name/user.email, commit focus.json.
//   4. Spawn `node ui/server.mjs` with FOCUS_PORT on an ephemeral port and
//      FOCUS_ROOT pinned to the temporary directory, then wait until GET /
//      answers.
// stop() kills the process and removes the temporary directory, and only a
// directory this module created. startIsolatedFocus registers stop() with
// t.after, so cleanup runs even when a test fails.
//
// The Focus checkout defaults to ~/workspace/projects/AI/focus relative to
// this repository; FOCUS_SOURCE_DIR overrides it. When it is missing, callers
// skip.

import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { APP_ROOT } from '../../lib/config.mjs';
import { freePort } from './harness.mjs';

export const FOCUS_SOURCE_DIR = path.resolve(
  process.env.FOCUS_SOURCE_DIR ?? path.join(APP_ROOT, '..', '..', '..', 'projects', 'AI', 'focus'),
);

const ENTRY_FILES = ['ui/server.mjs', 'ui/index.html'];
const TEMP_PREFIX = 'dashboard-focus-fixture-';
const RELATIVE_IMPORT = /\bfrom\s+['"](\.{1,2}\/[^'"]+)['"]|\bimport\s*\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g;

const STAMP = '2026-01-05T09:00:00.000Z';
export const SYNTHETIC_DOC = Object.freeze({
  updated: STAMP,
  items: [
    { id: 'fixture-a', title: 'Invented task A', source: 'manual', tier: 'today', now: true, status: 'open', rank: 0, created: STAMP, updated: STAMP },
    { id: 'fixture-b', title: 'Invented task B', source: 'manual', tier: 'later', now: false, status: 'open', created: STAMP, updated: STAMP },
  ],
});

export function focusSourceAvailable() {
  return ENTRY_FILES.every((file) => existsSync(path.join(FOCUS_SOURCE_DIR, file)));
}

export async function startIsolatedFocus(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), TEMP_PREFIX));
  let child;
  const stop = async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGTERM');
      await exited;
    }
    await removeFixture(dir);
  };
  t.after(stop);

  await copyFocusSource(dir);
  await writeSyntheticDoc(dir);
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.name', 'Dashboard Fixture');
  git('config', 'user.email', 'dashboard-fixture@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  git('add', 'focus.json');
  git('commit', '-q', '-m', 'fixture: synthetic board');

  const port = await freePort();
  child = spawn(process.execPath, ['ui/server.mjs'], {
    cwd: dir,
    env: { ...process.env, FOCUS_PORT: String(port), FOCUS_ROOT: dir },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  await waitUntilServing(port, child, () => stderr);

  return {
    dir,
    origin: `http://127.0.0.1:${port}`,
    stop,
    readDoc: async () => JSON.parse(await readFile(path.join(dir, 'focus.json'), 'utf8')),
    readRaw: () => readFile(path.join(dir, 'focus.json'), 'utf8'),
    commitSubjects: () => git('log', '--format=%s').trim().split('\n'),
  };
}

async function copyFocusSource(dir) {
  const pending = [...ENTRY_FILES];
  const copied = new Set();
  while (pending.length > 0) {
    const relative = pending.pop();
    if (copied.has(relative)) continue;
    copied.add(relative);
    const source = path.join(FOCUS_SOURCE_DIR, relative);
    const destination = path.join(dir, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(source, destination);
    if (!relative.endsWith('.mjs')) continue;
    const code = await readFile(source, 'utf8');
    for (const match of code.matchAll(RELATIVE_IMPORT)) {
      const specifier = match[1] ?? match[2];
      pending.push(path.posix.normalize(path.posix.join(path.posix.dirname(relative), specifier)));
    }
  }
}

async function writeSyntheticDoc(dir) {
  const { validateFocus } = await import(pathToFileURL(path.join(dir, 'lib', 'validate.mjs')).href);
  const errors = validateFocus(structuredClone(SYNTHETIC_DOC));
  if (errors.length > 0) throw new Error(`synthetic focus.json no longer validates: ${errors.join('; ')}`);
  await writeFile(path.join(dir, 'focus.json'), `${JSON.stringify(SYNTHETIC_DOC, null, 2)}\n`);
}

async function waitUntilServing(port, child, stderr) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`isolated Focus exited: ${stderr()}`);
    if (await answers(port)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('isolated Focus did not start within 10 s');
}

function answers(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', agent: false }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
  });
}

// Removes only a fixture directory this module created.
async function removeFixture(dir) {
  const resolved = path.resolve(dir);
  const inTemp = path.dirname(resolved) === path.resolve(os.tmpdir());
  if (!inTemp || !path.basename(resolved).startsWith(TEMP_PREFIX)) {
    throw new Error(`refusing to remove ${resolved}`);
  }
  await rm(resolved, { recursive: true, force: true });
}
