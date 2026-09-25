import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { TIMEOUTS } from '../lib/config.mjs';
import { forcedExitMs, startDashboard } from '../server.mjs';
import { freePort, tempDir } from './support/harness.mjs';
import { openEvents } from './support/sse.mjs';

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
    DASHBOARD_REGISTRY_PATH: path.join(await tempDir(t), 'agents.json'),
    DASHBOARD_LAUNCH_AGENTS_DIR: await tempDir(t),
    DASHBOARD_THREADS_DIR: path.join(await tempDir(t), 'threads'),
  };
}

async function writeRegistry(env, agents) {
  await writeFile(env.DASHBOARD_REGISTRY_PATH, JSON.stringify({ version: 1, agents }));
}

async function personaEntry(t, id = 'cfo') {
  return {
    id, name: 'CFO', role: 'Money', description: 'Invented.', group: 'work', kind: 'persona',
    cwd: await tempDir(t), provider: 'claude',
  };
}

// An adapter stand-in that records close, and the hub's unsubscribe from it,
// into `order`.
function recordingAdapter(order) {
  return {
    start: async () => ({}),
    state: () => ({ state: 'idle', pending: null, lastError: null, sessionId: null, costUsd: null }),
    subscribe: () => () => order.push('hub.close'),
    close: async () => {
      order.push('adapter.close');
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push('adapter.drained');
    },
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
  assert.deepEqual(JSON.parse(result.stdout), []);
});

test('the forced exit comes after the drain, the abort grace, and the server grace', () => {
  const orderly = TIMEOUTS.drainMs + TIMEOUTS.abortGraceMs + TIMEOUTS.shutdownMs;
  assert.equal(forcedExitMs(TIMEOUTS), orderly + 1_000);
  assert.equal(forcedExitMs(TIMEOUTS), 38_000);
  assert.equal(forcedExitMs({ drainMs: 10, abortGraceMs: 20, shutdownMs: 30 }), 1_060);
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

test('startDashboard reports a missing registry and ends event streams on close', async (t) => {
  const env = await testEnv(t);
  const dashboard = await startDashboard({ env, log: () => {} });
  t.after(() => dashboard.close());
  const app = { port: dashboard.config.port, authority: `127.0.0.1:${dashboard.config.port}` };
  const state = await (await fetch(`http://${app.authority}/api/state`)).json();
  assert.deepEqual(state.registry, { ok: false, error: 'registry_missing', loadedAt: null });
  assert.deepEqual(state.agents, []);

  const stream = await openEvents(app);
  assert.equal((await stream.next()).event, 'snapshot');
  const started = Date.now();
  await dashboard.close();
  assert.deepEqual(await stream.next(), { event: 'bye', data: {} });
  await stream.closed;
  assert.ok(Date.now() - started < dashboard.config.timeouts.shutdownMs);
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

test('shutdown ends streams, drains the adapters, then closes the hub and the server', async (t) => {
  const env = await testEnv(t);
  await writeRegistry(env, [await personaEntry(t)]);
  const order = [];
  let dashboard;
  const adapter = recordingAdapter(order);
  const drain = adapter.close;
  adapter.close = async () => {
    const response = await fetch(`http://127.0.0.1:${dashboard.config.port}/api/agents/cfo/send`, {
      method: 'POST',
      headers: { origin: `http://127.0.0.1:${dashboard.config.port}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Late' }),
    });
    order.push(`send ${response.status}`);
    order.push(`listening ${dashboard.server.listening}`);
    await drain();
  };
  dashboard = await startDashboard({ env, log: () => {}, createAdapters: () => ({ claude: adapter }) });
  const state = await (await fetch(`http://127.0.0.1:${dashboard.config.port}/api/state`)).json();
  assert.equal(state.agents[0].state, 'idle');
  await dashboard.close();
  assert.deepEqual(order, ['send 503', 'listening true', 'adapter.close', 'adapter.drained', 'hub.close']);
  assert.equal(dashboard.server.listening, false);
});

test('an API key in the environment disables the adapters and marks personas unavailable', async (t) => {
  for (const name of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY']) {
    const env = { ...await testEnv(t), [name]: 'invented-key' };
    await writeRegistry(env, [await personaEntry(t)]);
    const logs = [];
    const dashboard = await startDashboard({
      env,
      log: (entry) => logs.push(entry),
      createAdapters: () => { throw new Error('adapters must not be created'); },
    });
    t.after(() => dashboard.close());
    const state = await (await fetch(`http://127.0.0.1:${dashboard.config.port}/api/state`)).json();
    assert.deepEqual([state.agents[0].state, state.agents[0].lastError], ['unavailable', 'api_key_in_env'], name);
    assert.ok(logs.some((entry) => entry.event === 'adapters_disabled' && entry.reason === 'api_key_in_env'));
    await dashboard.close();
  }
});

test('a port collision still closes the adapters it created', async (t) => {
  const env = await testEnv(t);
  const blocker = http.createServer();
  await new Promise((resolve) => blocker.listen(Number(env.DASHBOARD_PORT), '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => blocker.close(resolve)));
  const order = [];
  await assert.rejects(
    startDashboard({ env, log: () => {}, createAdapters: () => ({ claude: recordingAdapter(order) }) }),
    { code: 'EADDRINUSE' },
  );
  assert.deepEqual(order, ['adapter.close', 'adapter.drained', 'hub.close']);
});
