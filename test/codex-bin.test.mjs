import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { startCodexServer, until } from './support/codex-server.mjs';
import { tempDir } from './support/harness.mjs';

const APP_DIR = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const SERVE = path.join(APP_DIR, 'bin', 'codex-serve');
const NEW = path.join(APP_DIR, 'bin', 'codex-new');

// A stand-in for the Codex CLI: prints a version, records its arguments to
// FAKE_CODEX_LOG, waits as app-server until told to stop (or, with
// FAKE_CODEX_SERVER_EXIT, exits with that status on its own after 300ms),
// and otherwise stands in for the TUI: it stays up for
// FAKE_CODEX_LINGER_MS (default 0) and exits with FAKE_CODEX_EXIT.
const FAKE_CODEX = `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (process.env.FAKE_CODEX_LOG) fs.appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify(args) + '\\n');
if (args[0] === '--version') {
  process.stdout.write('codex-cli 0.0.0-fake\\n');
} else if (args[0] === 'app-server') {
  setInterval(() => {}, 1000);
  process.on('SIGTERM', () => process.exit(0));
  if (process.env.FAKE_CODEX_SERVER_EXIT) setTimeout(() => process.exit(Number(process.env.FAKE_CODEX_SERVER_EXIT)), 300);
} else {
  setTimeout(() => process.exit(Number(process.env.FAKE_CODEX_EXIT ?? 0)), Number(process.env.FAKE_CODEX_LINGER_MS ?? 0));
}
`;

async function fixture(t) {
  const root = await tempDir(t);
  const fakeBin = path.join(root, 'fake-bin');
  const codexDir = path.join(root, 'codex');
  await fsp.mkdir(fakeBin);
  await fsp.writeFile(path.join(fakeBin, 'codex'), FAKE_CODEX, { mode: 0o755 });
  const log = path.join(root, 'codex-calls.log');
  const env = {
    ...process.env,
    PATH: `${fakeBin}:${process.env.PATH}`,
    DASHBOARD_CODEX_DIR: codexDir,
    FAKE_CODEX_LOG: log,
  };
  delete env.CMUX_WORKSPACE_ID;
  delete env.CMUX_SURFACE_ID;
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []);
  return { root, codexDir, ownerFile: path.join(codexDir, 'owner.json'), bindingsFile: path.join(codexDir, 'bindings.json'), env, calls };
}

function run(script, args, env) {
  return spawnSync(process.execPath, [script, ...args], { env, encoding: 'utf8' });
}

function runAsync(script, args, env, options = {}) {
  const child = spawn(process.execPath, [script, ...args], { env, ...options });
  const output = { stdout: '', stderr: '' };
  child.stdout.on('data', (data) => { output.stdout += data; });
  child.stderr.on('data', (data) => { output.stderr += data; });
  const exit = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal, ...output })));
  return { child, exit, output };
}

test('codex-serve refuses a live owner and an overlong socket path without starting anything', async (t) => {
  const f = await fixture(t);
  await fsp.mkdir(f.codexDir, { recursive: true });
  await fsp.writeFile(f.ownerFile, JSON.stringify({ socket: '/invented/app.sock', pid: process.pid, startedAt: 'x', codexVersion: 'y' }));
  let result = run(SERVE, [], f.env);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /already running \(pid \d+, socket \/invented\/app\.sock\)/);
  assert.deepEqual(f.calls(), []);
  assert.equal(fs.existsSync(f.ownerFile), true);

  await fsp.rm(f.ownerFile);
  result = run(SERVE, ['--socket', `/tmp/${'x'.repeat(120)}/app.sock`], f.env);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /socket path is \d+ bytes/);
  assert.match(result.stderr, /--socket/);
  assert.deepEqual(f.calls(), []);

  result = run(SERVE, ['--help'], f.env);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^usage: codex-serve/);
  result = run(SERVE, ['--bogus'], f.env);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unknown argument/);
});

test('codex-serve starts the app-server with the feature flags, writes owner.json, and removes it on SIGTERM', async (t) => {
  const f = await fixture(t);
  const socket = path.join(f.codexDir, 'app.sock');
  await fsp.mkdir(f.codexDir, { recursive: true });
  await fsp.writeFile(f.ownerFile, JSON.stringify({ socket, pid: spawnSync(process.execPath, ['-e', '0']).pid, startedAt: 'x', codexVersion: 'y' }));
  await fsp.writeFile(socket, 'stale');
  const { child, exit } = runAsync(SERVE, [], f.env);
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  await until(() => fs.existsSync(f.ownerFile) && fs.readFileSync(f.ownerFile, 'utf8').includes('0.0.0-fake'), 5_000, 'owner.json');
  const owner = JSON.parse(await fsp.readFile(f.ownerFile, 'utf8'));
  assert.deepEqual(Object.keys(owner).sort(), ['codexVersion', 'pid', 'socket', 'startedAt']);
  assert.equal(owner.socket, socket);
  assert.equal(owner.codexVersion, 'codex-cli 0.0.0-fake');
  assert.ok(Number.isInteger(owner.pid) && owner.pid !== child.pid);
  assert.doesNotThrow(() => process.kill(owner.pid, 0));
  assert.match(owner.startedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal((await fsp.stat(f.ownerFile)).mode & 0o777, 0o600);
  assert.equal((await fsp.stat(f.codexDir)).mode & 0o777, 0o700);
  assert.equal(fs.existsSync(socket), false);
  await until(() => f.calls().length === 2, 5_000, 'app-server call');
  assert.deepEqual(f.calls(), [
    ['--version'],
    ['app-server', '--listen', `unix://${socket}`, '-c', 'features.default_mode_request_user_input=true', '-c', 'features.request_permissions_tool=true'],
  ]);

  child.kill('SIGTERM');
  const result = await exit;
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`app-server starting on unix://${socket.replaceAll('.', '\\.')}; the dashboard will pick it up`));
  assert.equal(fs.existsSync(f.ownerFile), false);
  await until(() => { try { process.kill(owner.pid, 0); return false; } catch { return true; } }, 5_000, 'child exit');
});

test('codex-serve removes owner.json and reports the status when the app-server exits on its own', async (t) => {
  const f = await fixture(t);
  const { child, exit } = runAsync(SERVE, [], { ...f.env, FAKE_CODEX_SERVER_EXIT: '3' });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  await until(() => fs.existsSync(f.ownerFile), 5_000, 'owner.json');
  const result = await exit;
  assert.equal(result.code, 3, result.stderr);
  assert.match(result.stderr, /app-server exited with status 3/);
  assert.equal(fs.existsSync(f.ownerFile), false);
  assert.equal(fs.existsSync(path.join(f.codexDir, 'app.sock')), false);
});

test('codex-new refuses without a running owner', async (t) => {
  const f = await fixture(t);
  let result = run(NEW, ['--cwd', f.root], f.env);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no Codex app-server is running/);
  await fsp.mkdir(f.codexDir, { recursive: true });
  await fsp.writeFile(f.ownerFile, JSON.stringify({ socket: '/invented/app.sock', pid: spawnSync(process.execPath, ['-e', '0']).pid }));
  result = run(NEW, ['--cwd', f.root], f.env);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no Codex app-server is running/);
  result = run(NEW, ['--cwd', path.join(f.root, 'missing')], f.env);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--cwd must be an existing directory/);
  assert.deepEqual(f.calls(), []);
  assert.equal(fs.existsSync(f.bindingsFile), false);
});

test('codex-new opens the TUI on the server, records the thread it starts for the cwd, and drops its connection', async (t) => {
  const f = await fixture(t);
  const server = await startCodexServer(t);
  await fsp.mkdir(f.codexDir, { recursive: true });
  await fsp.writeFile(f.ownerFile, JSON.stringify({ socket: server.socket, pid: process.pid, startedAt: 'x', codexVersion: 'y' }));
  const work = path.join(f.root, 'work');
  const elsewhere = path.join(f.root, 'elsewhere');
  await fsp.mkdir(work);
  await fsp.mkdir(elsewhere);

  // The scripted server lives in this process, so the helper runs
  // asynchronously; spawnSync would block the server's event loop.
  const first = runAsync(NEW, ['--cwd', work], { ...f.env, CMUX_WORKSPACE_ID: 'ws-7', CMUX_SURFACE_ID: 'sf-3', FAKE_CODEX_EXIT: '3', FAKE_CODEX_LINGER_MS: '2000' });
  t.after(() => { if (first.child.exitCode === null) first.child.kill('SIGKILL'); });
  await until(() => f.calls().length === 1, 5_000, 'TUI launch');
  assert.deepEqual(f.calls(), [['--remote', `unix://${server.socket}`, '-C', work]]);
  assert.deepEqual(server.requests.map((r) => r.method), ['initialize']);
  assert.deepEqual(server.requests[0].params.capabilities, { experimentalApi: true });
  assert.deepEqual(server.notifications.map((n) => n.method), ['initialized']);
  assert.equal(server.live().length, 1);

  // Another client's thread, and one with no cwd, are not this terminal's.
  server.notify('thread/started', { thread: { id: 'other-thread', cwd: elsewhere } });
  server.notify('thread/started', { thread: { id: 'bare-thread' } });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(fs.existsSync(f.bindingsFile), false);
  // The TUI's own thread reports the real path of the directory.
  server.notify('thread/started', { thread: { id: 'tui-thread-1', cwd: await fsp.realpath(work) } });
  await until(() => fs.existsSync(f.bindingsFile), 5_000, 'binding');
  let bindings = JSON.parse(await fsp.readFile(f.bindingsFile, 'utf8'));
  assert.equal(bindings.length, 1);
  assert.deepEqual({ ...bindings[0], createdAt: null }, { threadId: 'tui-thread-1', cwd: work, workspaceId: 'ws-7', surfaceId: 'sf-3', createdAt: null });
  assert.match(bindings[0].createdAt, /^\d{4}-/);
  await until(() => server.live().length === 0, 2_000, 'helper connection closed');
  assert.equal(first.child.exitCode, null, 'the TUI keeps running after the thread is recorded');
  assert.equal(server.requests.filter((r) => r.method === 'thread/start').length, 0);

  let result = await first.exit;
  assert.equal(result.code, 3, result.stderr);
  assert.match(result.stdout, /connected to unix:/);
  assert.match(result.stdout, /thread tui-thread-1 bound to this cmux terminal \(workspace ws-7, surface sf-3\)/);

  // Outside cmux the thread is still recorded, with null ids, from the
  // environment's cwd; the thread's cwd arrives through `environments`.
  const second = runAsync(NEW, [], { ...f.env, FAKE_CODEX_LINGER_MS: '2000' }, { cwd: work });
  t.after(() => { if (second.child.exitCode === null) second.child.kill('SIGKILL'); });
  await until(() => f.calls().length === 2, 5_000, 'second TUI launch');
  server.notify('thread/started', { thread: { id: 'tui-thread-2', environments: [{ cwd: work }] } });
  await until(() => fs.existsSync(f.bindingsFile) && fs.readFileSync(f.bindingsFile, 'utf8').includes('tui-thread-2'), 5_000, 'second binding');
  result = await second.exit;
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /thread tui-thread-2 recorded; this terminal is not a cmux surface, so Open terminal will be unavailable/);
  bindings = JSON.parse(await fsp.readFile(f.bindingsFile, 'utf8'));
  assert.deepEqual(bindings.map((b) => [b.threadId, b.workspaceId, b.surfaceId]), [['tui-thread-2', null, null], ['tui-thread-1', 'ws-7', 'sf-3']]);
  assert.equal(await fsp.realpath(bindings[0].cwd), await fsp.realpath(work));
  await until(() => server.live().length === 0, 2_000, 'second connection closed');
});

test('codex-new records nothing when the TUI exits before starting a thread', async (t) => {
  const f = await fixture(t);
  const server = await startCodexServer(t);
  await fsp.mkdir(f.codexDir, { recursive: true });
  await fsp.writeFile(f.ownerFile, JSON.stringify({ socket: server.socket, pid: process.pid, startedAt: 'x', codexVersion: 'y' }));
  const work = path.join(f.root, 'work');
  await fsp.mkdir(work);

  const result = await runAsync(NEW, ['--cwd', work], { ...f.env, FAKE_CODEX_EXIT: '2', FAKE_CODEX_LINGER_MS: '200' }).exit;
  assert.equal(result.code, 2, result.stderr);
  assert.match(result.stdout, /the TUI exited before starting a thread; nothing was recorded/);
  assert.equal(fs.existsSync(f.bindingsFile), false);
  assert.deepEqual(f.calls(), [['--remote', `unix://${server.socket}`, '-C', work]]);
  await until(() => server.live().length === 0, 2_000, 'helper connection closed');
});
