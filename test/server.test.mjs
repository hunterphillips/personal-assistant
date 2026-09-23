import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { startDashboard } from '../server.mjs';
import { freePort, tempDir } from './support/harness.mjs';

const APP_DIR = fileURLToPath(new URL('..', import.meta.url));

function canConnect(port) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
}

async function testEnv(t) {
  return {
    DASHBOARD_PORT: String(await freePort()),
    DASHBOARD_FOCUS_ORIGIN: `http://127.0.0.1:${await freePort()}`,
    DASHBOARD_BRIEFS_DIR: await tempDir(t),
  };
}

test('importing the handler and entry point opens no listener', () => {
  const script = `
    await import('./lib/app.mjs');
    await import('./server.mjs');
    const listeners = process.getActiveResourcesInfo().filter((r) => r === 'TCPServerWrap');
    console.log(JSON.stringify(listeners));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: APP_DIR, encoding: 'utf8', timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '[]');
});

test('startDashboard binds loopback and close releases the port', async (t) => {
  const env = await testEnv(t);
  const dashboard = await startDashboard({ env, log: () => {} });
  const address = dashboard.server.address();
  assert.equal(address.address, '127.0.0.1');
  assert.equal(address.port, Number(env.DASHBOARD_PORT));
  assert.equal(await canConnect(address.port), true);
  await dashboard.close();
  assert.equal(dashboard.server.listening, false);
  assert.equal(await canConnect(address.port), false);
});

test('a port collision fails startup instead of choosing another port', async (t) => {
  const env = await testEnv(t);
  const blocker = http.createServer();
  await new Promise((resolve) => blocker.listen(Number(env.DASHBOARD_PORT), '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => blocker.close(resolve)));
  await assert.rejects(startDashboard({ env, log: () => {} }), { code: 'EADDRINUSE' });
});

test('invalid configuration fails startup', async () => {
  await assert.rejects(startDashboard({ env: { DASHBOARD_FOCUS_ORIGIN: 'http://example.com' } }), { name: 'ConfigError' });
});

test('close cuts lingering connections after the shutdown window', async (t) => {
  const env = await testEnv(t);
  const dashboard = await startDashboard({ env, log: () => {} });
  // Hold a connection open mid-request (headers never finish).
  const socket = net.connect(dashboard.config.port, '127.0.0.1');
  await new Promise((resolve) => socket.once('connect', resolve));
  socket.write(`GET /healthz HTTP/1.1\r\nHost: 127.0.0.1:${dashboard.config.port}\r\n`);
  socket.on('error', () => {});
  const closedSocket = new Promise((resolve) => socket.once('close', resolve));
  await dashboard.close();
  await closedSocket;
  assert.equal(await canConnect(dashboard.config.port), false);
});

test('the executable exits cleanly on SIGTERM and frees its port', async (t) => {
  const env = await testEnv(t);
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: APP_DIR, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill('SIGKILL'));
  await new Promise((resolve, reject) => {
    child.stdout.on('data', (data) => { if (String(data).includes('listening')) resolve(); });
    child.once('exit', () => reject(new Error('exited before listening')));
  });
  const response = await fetch(`http://127.0.0.1:${env.DASHBOARD_PORT}/healthz`);
  assert.equal(response.status, 200);
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
  child.kill('SIGTERM');
  assert.equal(await exited, 0);
  assert.equal(await canConnect(Number(env.DASHBOARD_PORT)), false);
});

test('the executable exits non-zero when its port is taken', async (t) => {
  const env = await testEnv(t);
  const blocker = http.createServer();
  await new Promise((resolve) => blocker.listen(Number(env.DASHBOARD_PORT), '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => blocker.close(resolve)));
  const result = await new Promise((resolve) => {
    const child = spawn(process.execPath, ['server.mjs'], { cwd: APP_DIR, env: { ...process.env, ...env } });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.once('exit', (code) => resolve({ code, stderr }));
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /port already in use/);
});
