// An isolated copy of the real Focus server, for write tests that must never
// touch Hunter's board.
//
// How the fixture is built:
//   1. Copy ui/server.mjs, ui/index.html, and every module they import
//      through relative paths (found by scanning import statements, so
//      lib/store.mjs, lib/validate.mjs, lib/status.mjs, and anything added
//      later) from the Focus checkout into a new temporary directory, keeping
//      the relative layout. store.mjs derives its root from its own location,
//      so the copy reads and commits in the temporary directory. Paths are
//      checked against the real (symlink-resolved) roots: an import that
//      normalizes outside the Focus checkout, or any symlink on the way, is
//      refused, and nothing is copied over an existing destination.
//   2. Write SYNTHETIC_DOC as focus.json. It is invented, not copied from the
//      real board, and is checked with the copied validator before use.
//   3. `git init` with no template, set a local user.name/user.email and
//      core.hooksPath to an empty directory, commit focus.json, and confirm
//      the repository's top level is the temporary directory.
//   4. Spawn `node ui/server.mjs` with FOCUS_PORT on an ephemeral port,
//      FOCUS_ROOT pinned to the temporary directory, and FOCUS_RUN_SCAN
//      pointed at a stub that exits 0, then wait until GET / answers.
// Every git invocation and the server run with an environment scrubbed of
// inherited GIT_* and FOCUS_* variables, with system and global git config
// ignored and discovery stopped at the temporary directory's parent, so no
// inherited setting can redirect git to another repository or run hooks.
// stop() kills the process and removes the temporary directory, and only a
// directory this module created. startIsolatedFocus registers stop() with
// t.after, so cleanup runs even when a test fails.
//
// The Focus checkout defaults to ~/workspace/projects/AI/focus relative to
// this repository; FOCUS_SOURCE_DIR overrides it. When it is missing, callers
// skip.

import { execFileSync, spawn } from 'node:child_process';
import { constants, existsSync } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
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

  const root = await realpath(dir);
  await copyFocusSource(root);
  await writeSyntheticDoc(root);
  const env = isolatedEnv(root);
  const git = (...args) => execFileSync('git', args, { cwd: root, env, encoding: 'utf8' });
  git('init', '-q', '--template=');
  const hooks = path.join(root, '.git', 'no-hooks');
  await mkdir(hooks);
  git('config', 'core.hooksPath', hooks);
  git('config', 'user.name', 'Dashboard Fixture');
  git('config', 'user.email', 'dashboard-fixture@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  git('add', 'focus.json');
  git('commit', '-q', '-m', 'fixture: synthetic board');
  const toplevel = git('rev-parse', '--show-toplevel').trim();
  if (toplevel !== root) throw new Error(`fixture git top level is ${toplevel}, expected ${root}`);

  const scanStub = path.join(root, '.git', 'scan-stub.sh');
  await writeFile(scanStub, '#!/bin/sh\nexit 0\n', { flag: 'wx' });
  await chmod(scanStub, 0o700);

  const port = await freePort();
  child = spawn(process.execPath, ['ui/server.mjs'], {
    cwd: root,
    env: { ...env, FOCUS_PORT: String(port), FOCUS_ROOT: root, FOCUS_RUN_SCAN: scanStub },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  await waitUntilServing(port, child, () => stderr);

  return {
    dir: root,
    git,
    origin: `http://127.0.0.1:${port}`,
    stop,
    readDoc: async () => JSON.parse(await readFile(path.join(root, 'focus.json'), 'utf8')),
    readRaw: () => readFile(path.join(root, 'focus.json'), 'utf8'),
    commitSubjects: () => git('log', '--format=%s').trim().split('\n'),
  };
}

// The parent environment minus anything that steers git or Focus.
function isolatedEnv(root) {
  const env = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!name.startsWith('GIT_') && !name.startsWith('FOCUS_')) env[name] = value;
  }
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_CEILING_DIRECTORIES: path.dirname(root),
    GIT_TERMINAL_PROMPT: '0',
  };
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

// Copies the entry files and their relative imports from the Focus checkout
// into `root` (already a real path).
async function copyFocusSource(root) {
  const sourceRoot = await realpath(FOCUS_SOURCE_DIR);
  const pending = [...ENTRY_FILES];
  const copied = new Set();
  while (pending.length > 0) {
    const relative = pending.pop();
    if (copied.has(relative)) continue;
    copied.add(relative);
    if (path.posix.isAbsolute(relative) || relative.split('/').includes('..')) {
      throw new Error(`Focus import escapes the checkout: ${relative}`);
    }
    const source = path.join(sourceRoot, relative);
    const destination = path.join(root, relative);
    if (!inside(sourceRoot, source) || !inside(root, destination)) {
      throw new Error(`Focus import escapes the checkout: ${relative}`);
    }
    const stats = await lstat(source);
    if (stats.isSymbolicLink() || !stats.isFile()) throw new Error(`Focus source is not a regular file: ${relative}`);
    if ((await realpath(source)) !== source) throw new Error(`Focus source path goes through a symlink: ${relative}`);
    await mkdir(path.dirname(destination), { recursive: true });
    if ((await realpath(path.dirname(destination))) !== path.dirname(destination)) {
      throw new Error(`fixture path goes through a symlink: ${relative}`);
    }
    await copyFile(source, destination, constants.COPYFILE_EXCL);
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
