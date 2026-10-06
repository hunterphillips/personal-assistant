import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { lstat, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
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

// Every real start runs on a fresh data root with nothing to migrate, so no
// test reaches ~/.personal-assistant or the live checkout.
async function testEnv(t) {
  return {
    PERSONAL_ASSISTANT_HOME: path.join(await tempDir(t), 'root'),
    DASHBOARD_MIGRATE_FROM: '',
    DASHBOARD_PORT: String(await freePort()),
    DASHBOARD_FOCUS_ORIGIN: `http://127.0.0.1:${await freePort()}`,
    DASHBOARD_BRIEFS_DIR: await tempDir(t),
    DASHBOARD_REGISTRY_PATH: path.join(await tempDir(t), 'agents.json'),
    // No built-in agents unless a test names a file; the seed has tests of its own.
    DASHBOARD_BUILTIN_PATH: path.join(await tempDir(t), 'builtin-missing.json'),
    DASHBOARD_LAUNCH_AGENTS_DIR: await tempDir(t),
    DASHBOARD_THREADS_DIR: path.join(await tempDir(t), 'threads'),
    DASHBOARD_CODEX_DIR: path.join(await tempDir(t), 'codex'),
    DASHBOARD_CMUX_SOCKET_PATH_FILE: path.join(await tempDir(t), 'no-cmux-socket'),
    DASHBOARD_CMUX_PASSWORD_FILE: path.join(await tempDir(t), 'no-cmux-password'),
    DASHBOARD_CMUX_CLI: path.join(await tempDir(t), 'no-cmux'),
    DASHBOARD_SETTINGS_PATH: path.join(await tempDir(t), 'settings.json'),
    DASHBOARD_NOTIFICATIONS_DIR: path.join(await tempDir(t), 'notifications'),
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

// The brief notice end to end: a notice file the run wrote, the Assistant
// as a started persona, and the thread route.
async function assistantEntry(t) {
  return {
    id: 'assistant', name: 'Assistant', role: 'Assistant', description: 'Invented.', group: 'personal', kind: 'persona',
    cwd: await tempDir(t), provider: 'claude', pinned: true,
  };
}

function idleAdapter() {
  return {
    start: async () => ({}),
    state: () => ({ state: 'idle', pending: null, lastError: null, sessionId: null, costUsd: null }),
    subscribe: () => () => {},
    close: async () => {},
  };
}

function writeNotice(env, date, fields = {}) {
  return writeFile(
    path.join(env.DASHBOARD_BRIEFS_DIR, `notice-${date}.json`),
    JSON.stringify({ date, state: 'ready', opening: `Opening for ${date}. Second sentence.`, memo: `## Money\n\nMemo ${date}.`, ...fields }),
  );
}

async function readThread(dashboard, id = 'assistant') {
  const response = await fetch(`http://127.0.0.1:${dashboard.config.port}/api/agents/${id}/thread`);
  assert.equal(response.status, 200);
  return (await response.json()).messages;
}

test('startDashboard hands the Claude adapter a tools hook that gives every turn the ask and notify tools over the real SDK', async (t) => {
  const env = await testEnv(t);
  await writeRegistry(env, [await assistantEntry(t), await personaEntry(t, 'cfo')]);
  let hook = null;
  const dashboard = await startDashboard({
    env,
    log: () => {},
    createAdapters: ({ turnTools }) => {
      hook = turnTools;
      return { claude: idleAdapter() };
    },
  });
  t.after(() => dashboard.close());
  assert.equal(typeof hook, 'function');
  const tools = await hook({ id: 'assistant' }, { text: 'Hi', prompt: 'Hi', from: null, chain: [], mentions: ['cfo'], turnId: 't-1' });
  assert.deepEqual(tools.allowedTools, ['mcp__agents__ask', 'mcp__agents__notify']);
  assert.equal(tools.mcpServers.agents.type, 'sdk');
  assert.equal(tools.mcpServers.agents.name, 'agents');
  assert.ok(tools.mcpServers.agents.instance, 'a real McpServer instance');
  assert.equal(tools.prompt, 'Hi\n\nAgents mentioned: CFO (id `cfo`)');
  assert.equal(typeof tools.commit, 'function');
  assert.equal(typeof tools.rollback, 'function');
});

test('booting with an unposted notice file posts it once into the Assistant thread', async (t) => {
  const env = await testEnv(t);
  await writeRegistry(env, [await assistantEntry(t)]);
  await writeNotice(env, '2026-09-30');
  const logs = [];
  const dashboard = await startDashboard({ env, log: (entry) => logs.push(entry), createAdapters: () => ({ claude: idleAdapter() }) });
  t.after(() => dashboard.close());

  const messages = await readThread(dashboard);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].kind, 'brief');
  assert.equal(messages[0].summary, 'Opening for 2026-09-30.');
  assert.equal(messages[0].text, '## Money\n\nMemo 2026-09-30.');
  assert.match(messages[0].at, /^\d{4}-\d{2}-\d{2}T/);
  const state = await (await fetch(`http://127.0.0.1:${dashboard.config.port}/api/state`)).json();
  assert.equal(state.agents[0].lastMessage.text, 'Opening for 2026-09-30.');
  assert.ok(logs.some((e) => e.event === 'notice_posted' && e.date === '2026-09-30'));

  // Two streams opened at once reconcile again and add nothing.
  const app = { port: dashboard.config.port, authority: `127.0.0.1:${dashboard.config.port}` };
  const [one, two] = await Promise.all([openEvents(app), openEvents(app)]);
  t.after(() => { one.close(); two.close(); });
  await Promise.all([one.next(), two.next()]);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal((await readThread(dashboard)).length, 1);
});

test('a notice written while a stream is open is posted by the timer, once; three missed dates post two', async (t) => {
  const env = await testEnv(t);
  await writeRegistry(env, [await assistantEntry(t)]);
  const dashboard = await startDashboard({
    env, log: () => {}, createAdapters: () => ({ claude: idleAdapter() }), timeouts: { noticePollMs: 30 },
  });
  t.after(() => dashboard.close());
  assert.deepEqual(await readThread(dashboard), []);

  const app = { port: dashboard.config.port, authority: `127.0.0.1:${dashboard.config.port}` };
  const stream = await openEvents(app);
  t.after(() => stream.close());
  await stream.next();
  await writeNotice(env, '2026-09-30');
  const delta = await stream.next(2_000);
  assert.equal(delta.event, 'delta');
  assert.equal(delta.data.patch.agents[0].lastMessage.text, 'Opening for 2026-09-30.');
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal((await readThread(dashboard)).length, 1);

  // The run writes a failed notice over it: real information, posted too.
  await writeNotice(env, '2026-09-30', { state: 'failed', opening: 'The morning brief did not build.', memo: undefined });
  await stream.next(2_000);
  const messages = await readThread(dashboard);
  assert.deepEqual(messages.map((m) => [m.date, m.state]), [['2026-09-30', 'ready'], ['2026-09-30', 'failed']]);
  assert.equal(messages[1].text, 'The morning brief did not build.');

  // Three dates the daemon missed: only the newest two post.
  for (const date of ['2026-10-01', '2026-10-02', '2026-10-03']) await writeNotice(env, date);
  await stream.next(2_000);
  await stream.next(2_000);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual((await readThread(dashboard)).map((m) => m.date), ['2026-09-30', '2026-09-30', '2026-10-02', '2026-10-03']);
});

test('first start seeds the settings file with the brief going to the pinned Claude persona, and a present file is kept', async (t) => {
  const env = await testEnv(t);
  await writeRegistry(env, [await personaEntry(t), await assistantEntry(t)]);
  const logs = [];
  const dashboard = await startDashboard({ env, log: (entry) => logs.push(entry), createAdapters: () => ({ claude: idleAdapter() }) });
  t.after(() => dashboard.close());
  assert.deepEqual(JSON.parse(await readFile(env.DASHBOARD_SETTINGS_PATH, 'utf8')), {
    version: 1, model: { default: null, effort: null }, brief: { agent: 'assistant' }, permission: { default: 'ask' },
    quickChat: { agent: 'assistant' },
  });
  assert.equal((await stat(env.DASHBOARD_SETTINGS_PATH)).mode & 0o777, 0o600);
  assert.deepEqual(logs.filter((e) => e.event === 'settings_seeded'), [{ event: 'settings_seeded', agent: 'assistant', quickChat: 'assistant' }]);
  const state = await (await fetch(`http://127.0.0.1:${dashboard.config.port}/api/state`)).json();
  assert.deepEqual(state.settings, { ok: true, error: null, model: { default: null, effort: null }, brief: { agent: 'assistant' }, permission: { default: 'ask' }, quickChat: { agent: 'assistant' } });
  assert.deepEqual(state.agents.find((a) => a.id === 'cfo').model, { id: null, effort: null, source: 'default', default: { id: null, effort: null }, agent: { id: null, effort: null } });
  assert.deepEqual(state.agents.find((a) => a.id === 'cfo').permission, { level: 'ask', source: 'system', agent: null, default: 'ask' });
  await dashboard.close();

  // A second start finds the file and leaves it alone, even after an edit.
  await writeFile(env.DASHBOARD_SETTINGS_PATH, JSON.stringify({ version: 1, model: { default: 'haiku', effort: 'max' }, brief: { agent: 'cfo' } }));
  const again = await startDashboard({ env, log: (entry) => logs.push(entry), createAdapters: () => ({ claude: idleAdapter() }) });
  t.after(() => again.close());
  assert.equal(logs.filter((e) => e.event === 'settings_seeded').length, 1);
  const next = await (await fetch(`http://127.0.0.1:${again.config.port}/api/state`)).json();
  assert.deepEqual(next.settings.model, { default: 'haiku', effort: 'max' });
  assert.equal(next.settings.brief.agent, 'cfo');
  assert.deepEqual(next.settings.permission, { default: 'ask' }, 'a file from before the key loads as ask');
  // A file from before quick chat gains the key once, the rest kept.
  assert.deepEqual(next.settings.quickChat, { agent: 'assistant' });
  assert.deepEqual(logs.filter((e) => e.event === 'settings_migrated'), [{ event: 'settings_migrated', quickChat: 'assistant' }]);
  assert.deepEqual(JSON.parse(await readFile(env.DASHBOARD_SETTINGS_PATH, 'utf8')), {
    version: 1, model: { default: 'haiku', effort: 'max' }, brief: { agent: 'cfo' }, permission: { default: 'ask' },
    quickChat: { agent: 'assistant' },
  });
  assert.deepEqual(next.agents.find((a) => a.id === 'cfo').model, { id: 'haiku', effort: 'max', source: 'system', default: { id: 'haiku', effort: 'max' }, agent: { id: null, effort: null } });
});

test('with no pinned Claude persona the seed names no one; an old notice from before a target is set never backfills, but a later one posts', async (t) => {
  const env = await testEnv(t);
  await writeRegistry(env, [await personaEntry(t)]);
  await writeNotice(env, '2026-09-30');
  const logs = [];
  const dashboard = await startDashboard({ env, log: (entry) => logs.push(entry), createAdapters: () => ({ claude: idleAdapter() }) });
  t.after(() => dashboard.close());
  assert.deepEqual(JSON.parse(await readFile(env.DASHBOARD_SETTINGS_PATH, 'utf8')).brief, { agent: null });
  assert.deepEqual(logs.filter((e) => e.event === 'settings_seeded'), [{ event: 'settings_seeded', agent: null, quickChat: 'cfo' }]);
  assert.ok(logs.some((e) => e.event === 'notice_skipped' && e.reason === 'no_target'));
  assert.deepEqual(await readThread(dashboard, 'cfo'), []);

  // Pointing the brief at the persona through the route does not backfill the notice from before the target was set.
  const put = await fetch(`http://127.0.0.1:${dashboard.config.port}/api/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${dashboard.config.port}` },
    body: JSON.stringify({ brief: { agent: 'cfo' } }),
  });
  assert.equal(put.status, 200);
  assert.equal((await put.json()).settings.brief.agent, 'cfo');
  assert.equal(JSON.parse(await readFile(env.DASHBOARD_SETTINGS_PATH, 'utf8')).brief.agent, 'cfo');
  const app = { port: dashboard.config.port, authority: `127.0.0.1:${dashboard.config.port}` };
  const stream = await openEvents(app);
  t.after(() => stream.close());
  await stream.next();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(await readThread(dashboard, 'cfo'), []);

  // A notice written after the target is set posts normally, on the next reconcile.
  await writeNotice(env, '2026-10-01');
  const stream2 = await openEvents(app);
  t.after(() => stream2.close());
  await stream2.next();
  await new Promise((resolve) => setTimeout(resolve, 50));
  const messages = await readThread(dashboard, 'cfo');
  assert.equal(messages.length, 1);
  assert.equal(messages[0].kind, 'brief');
  assert.equal(messages[0].date, '2026-10-01');
});

test('a notice waits for the Assistant when its adapter fails to start, and no persona means no post', async (t) => {
  const env = await testEnv(t);
  await writeRegistry(env, [await assistantEntry(t)]);
  await writeNotice(env, '2026-09-30');
  const logs = [];
  const failing = { ...idleAdapter(), start: async () => { throw new Error('invented'); } };
  const dashboard = await startDashboard({ env, log: (entry) => logs.push(entry), createAdapters: () => ({ claude: failing }) });
  t.after(() => dashboard.close());
  // The thread route answers 409 for an unavailable persona; the store shows nothing was written.
  await assert.rejects(stat(path.join(env.DASHBOARD_THREADS_DIR, 'assistant.jsonl')), { code: 'ENOENT' });
  assert.ok(logs.some((e) => e.event === 'notice_skipped' && e.reason === 'agent_not_started'));
});

test('POST /api/agents writes the registry file as 2-space JSON, keeps an unrelated top-level key, and the agent is still listed after a restart', async (t) => {
  const env = await testEnv(t);
  const folder = await tempDir(t);
  await writeFile(env.DASHBOARD_REGISTRY_PATH, `${JSON.stringify({ version: 1, groups: [{ id: 'work', name: 'Work' }], agents: [await personaEntry(t)], note: 'hand-kept' }, null, 2)}\n`);
  const dashboard = await startDashboard({ env, log: () => {}, createAdapters: () => ({ claude: idleAdapter() }) });
  t.after(() => dashboard.close());
  const base = `http://127.0.0.1:${dashboard.config.port}`;
  const created = await fetch(`${base}/api/agents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({
      id: 'scout', name: 'Scout', role: 'Files', group: 'home', description: 'Reads my files.', cwd: folder,
      model: 'haiku', effort: null, accepts: ['cfo'], pinned: false, newGroup: { id: 'home', name: 'Home' },
    }),
  });
  assert.equal(created.status, 201);
  const text = await readFile(env.DASHBOARD_REGISTRY_PATH, 'utf8');
  assert.equal(text, `${JSON.stringify(JSON.parse(text), null, 2)}\n`);
  const parsed = JSON.parse(text);
  assert.equal(parsed.note, 'hand-kept');
  assert.deepEqual(parsed.groups, [{ id: 'work', name: 'Work' }, { id: 'home', name: 'Home' }]);
  assert.deepEqual(parsed.agents[1], {
    id: 'scout', name: 'Scout', role: 'Files', description: 'Reads my files.', group: 'home', kind: 'persona', cwd: folder, provider: 'claude', model: 'haiku', accepts: ['cfo'],
  });
  const state = await (await fetch(`${base}/api/state`)).json();
  assert.ok(state.agents.some((a) => a.id === 'scout'));
  await dashboard.close();

  const again = await startDashboard({ env, log: () => {}, createAdapters: () => ({ claude: idleAdapter() }) });
  t.after(() => again.close());
  const next = await (await fetch(`http://127.0.0.1:${again.config.port}/api/state`)).json();
  const scout = next.agents.find((a) => a.id === 'scout');
  assert.deepEqual([scout.name, scout.group, scout.accepts, scout.model.id], ['Scout', 'home', ['cfo'], 'haiku']);
  assert.deepEqual(next.groups, [{ id: 'work', name: 'Work' }, { id: 'home', name: 'Home' }]);
});

test('start seeds the built-in agents into a registry without them, lists them with a read time, and is a no-op after', async (t) => {
  const env = { ...await testEnv(t), DASHBOARD_BUILTIN_PATH: fileURLToPath(new URL('../../../registry/builtin.json', import.meta.url)) };
  await writeFile(env.DASHBOARD_REGISTRY_PATH, JSON.stringify({ version: 1, groups: [{ id: 'personal', name: 'Personal' }], agents: [await assistantEntry(t)] }));
  const logs = [];
  const dashboard = await startDashboard({ env, log: (entry) => logs.push(entry), createAdapters: () => ({ claude: idleAdapter() }) });
  t.after(() => dashboard.close());
  const file = JSON.parse(await readFile(env.DASHBOARD_REGISTRY_PATH, 'utf8'));
  assert.deepEqual(file.agents.map((entry) => entry.id), ['assistant', 'myos']);
  assert.equal(file.agents[1].cwd, path.resolve(APP_DIR, '../../agents/myos'));
  assert.deepEqual(logs.filter((e) => e.event === 'builtins_seeded'), [{ event: 'builtins_seeded', agents: ['myos'] }]);
  const state = await (await fetch(`http://127.0.0.1:${dashboard.config.port}/api/state`)).json();
  const myos = state.agents.find((entry) => entry.id === 'myos');
  assert.deepEqual([myos.name, myos.group, myos.builtin, myos.unread], ['Myos', 'personal', true, false]);
  // Quick chat starts on the built-in agent.
  assert.deepEqual(state.settings.quickChat, { agent: 'myos' });
  await dashboard.close();

  const again = await startDashboard({ env, log: (entry) => logs.push(entry), createAdapters: () => ({ claude: idleAdapter() }) });
  t.after(() => again.close());
  assert.equal(logs.filter((e) => e.event === 'builtins_seeded').length, 1);
  assert.deepEqual(JSON.parse(await readFile(env.DASHBOARD_REGISTRY_PATH, 'utf8')), file);
});

test('start seeds the built-in agents when the registry file does not exist, and routines start empty', async (t) => {
  const env = {
    ...await testEnv(t),
    DASHBOARD_BUILTIN_PATH: fileURLToPath(new URL('../../../registry/builtin.json', import.meta.url)),
    DASHBOARD_ROUTINES_DIR: path.join(await tempDir(t), 'routines'),
  };
  // No registry file on disk, as in a fresh checkout.
  const dashboard = await startDashboard({ env, log: () => {}, createAdapters: () => ({ claude: idleAdapter() }) });
  t.after(() => dashboard.close());
  const state = await (await fetch(`http://127.0.0.1:${dashboard.config.port}/api/state`)).json();
  assert.ok(state.agents.find((entry) => entry.id === 'myos'), 'the built-in agent is listed');
  assert.deepEqual(state.routines.items, []);
  const file = JSON.parse(await readFile(env.DASHBOARD_REGISTRY_PATH, 'utf8'));
  assert.deepEqual(file.agents.map((entry) => entry.id), ['myos']);
});

// The data root: the lock, the migration from a checkout, and the variable.

// A checkout holding a little of every kind of data, all invented.
async function fixtureCheckout(dir) {
  const repo = path.join(dir, 'checkout');
  const files = {
    'registry/agents.json': `${JSON.stringify({ version: 1, agents: [{
      id: 'fixture', name: 'Fixture', role: 'Invented', description: 'Invented.', group: 'work', kind: 'persona',
      cwd: dir, provider: 'claude',
    }] })}\n`,
    'dashboard/app/var/settings.json': `${JSON.stringify({ version: 1, model: { default: 'haiku', effort: null }, brief: { agent: null } })}\n`,
    'feed/items/2026-10-01-watch.json': '{"invented":true}\n',
    'daily-brief/briefs/build.py': 'print("code")\n',
    'daily-brief/briefs/notice-2026-10-01.json': '{"invented":true}\n',
  };
  for (const [rel, body] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(repo, rel)), { recursive: true });
    await writeFile(path.join(repo, rel), body);
  }
  return repo;
}

// The minimal environment of a start whose stores all default under the root.
async function rootEnv(t, home, migrateFrom = '') {
  return {
    PERSONAL_ASSISTANT_HOME: home,
    DASHBOARD_MIGRATE_FROM: migrateFrom,
    DASHBOARD_PORT: String(await freePort()),
    DASHBOARD_FOCUS_ORIGIN: `http://127.0.0.1:${await freePort()}`,
    DASHBOARD_BUILTIN_PATH: path.join(home, '..', 'builtin-missing.json'),
    DASHBOARD_LAUNCH_AGENTS_DIR: path.join(home, '..', 'launch-agents'),
    DASHBOARD_CMUX_SOCKET_PATH_FILE: path.join(home, '..', 'no-cmux-socket'),
    DASHBOARD_CMUX_PASSWORD_FILE: path.join(home, '..', 'no-cmux-password'),
    DASHBOARD_CMUX_CLI: path.join(home, '..', 'no-cmux'),
  };
}

test('a first start moves a fixture checkout into the root and touches nothing outside the temporary directory', async (t) => {
  const dir = await tempDir(t);
  const repo = await fixtureCheckout(dir);
  const home = path.join(dir, 'root');
  const env = await rootEnv(t, home, repo);
  const logs = [];
  const dashboard = await startDashboard({ env, log: (entry) => logs.push(entry), createAdapters: () => ({ claude: idleAdapter() }) });
  t.after(() => dashboard.close());

  for (const key of ['home', 'settingsPath', 'registryPath', 'routinesDir', 'notificationsDir', 'threadsDir', 'codexDir',
    'feedDir', 'feedInstructionsPath', 'ideasDir', 'ideasMarksPath', 'ideasInstructionsPath', 'briefsDir', 'migrateFrom']) {
    assert.ok(dashboard.config[key].startsWith(`${dir}${path.sep}`), key);
  }
  assert.equal(process.env.PERSONAL_ASSISTANT_HOME, home);
  const layout = JSON.parse(await readFile(path.join(home, 'layout.json'), 'utf8'));
  assert.deepEqual([layout.version, layout.migratedFrom], [1, repo]);
  assert.deepEqual(JSON.parse(await readFile(path.join(home, 'daemon.lock'), 'utf8')).pid, process.pid);
  assert.ok((await lstat(path.join(repo, 'registry/agents.json.migrated'))).isFile());
  assert.ok((await lstat(path.join(repo, 'dashboard/app/var/settings.json.migrated'))).isFile());
  assert.ok((await lstat(path.join(repo, 'feed/items.migrated'))).isDirectory());
  assert.deepEqual(await readdir(path.join(repo, 'daily-brief/briefs')), ['build.py']);
  assert.deepEqual(await readdir(path.join(home, 'feed/items')), ['2026-10-01-watch.json']);
  assert.ok((await lstat(path.join(home, 'README.md'))).isFile());
  assert.ok((await lstat(path.join(home, 'ideas/criteria.md'))).isFile(), 'the default criteria are seeded');

  const moved = logs.filter((entry) => entry.event === 'migration_moved').map((entry) => entry.key);
  assert.deepEqual(moved, ['settings', 'registry', 'feedDir', 'briefsDir']);
  assert.deepEqual(logs.find((entry) => entry.event === 'migration_done'), { event: 'migration_done', moved: 4, skipped: 17 });
  assert.deepEqual(logs.find((entry) => entry.event === 'root'), {
    event: 'root', root: home, migrateFrom: repo, version: 1, created: true, moved: 4,
  });
  const state = await (await fetch(`http://127.0.0.1:${dashboard.config.port}/api/state`)).json();
  assert.deepEqual(state.agents.map((agent) => agent.id), ['fixture']);
  assert.deepEqual(state.settings.model, { default: 'haiku', effort: null });

  // The lock goes with the daemon.
  await dashboard.close();
  await assert.rejects(lstat(path.join(home, 'daemon.lock')), { code: 'ENOENT' });
});

test('a second daemon on the same root refuses with root_locked, and the root is free again after close', async (t) => {
  const home = path.join(await tempDir(t), 'root');
  const first = await startDashboard({ env: await rootEnv(t, home), log: () => {}, createAdapters: () => ({ claude: idleAdapter() }) });
  t.after(() => first.close());
  const logs = [];
  await assert.rejects(
    startDashboard({ env: await rootEnv(t, home), log: (entry) => logs.push(entry), createAdapters: () => ({ claude: idleAdapter() }) }),
    (error) => error.code === 'root_locked' && error.details.pid === process.pid &&
      error.message === `The lock ${path.join(home, 'daemon.lock')} is held by process ${process.pid}, so this daemon does not start over the same root.`,
  );
  assert.deepEqual(logs, [{ event: 'root_locked', root: home, pid: process.pid }]);
  await first.close();
  const again = await startDashboard({ env: await rootEnv(t, home), log: () => {}, createAdapters: () => ({ claude: idleAdapter() }) });
  await again.close();
});

test('a start that fails after the claim releases the lock: a taken port and a migration conflict', async (t) => {
  const dir = await tempDir(t);
  const home = path.join(dir, 'root');
  const env = await rootEnv(t, home);
  const blocker = http.createServer();
  await new Promise((resolve) => blocker.listen(Number(env.DASHBOARD_PORT), '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => blocker.close(resolve)));
  await assert.rejects(startDashboard({ env, log: () => {}, createAdapters: () => ({ claude: idleAdapter() }) }), { code: 'EADDRINUSE' });
  await assert.rejects(lstat(path.join(home, 'daemon.lock')), { code: 'ENOENT' });

  // A fresh root whose target already differs from the checkout's copy.
  const repo = await fixtureCheckout(dir);
  const conflicted = path.join(dir, 'conflicted');
  await mkdir(path.join(conflicted, 'registry'), { recursive: true });
  await writeFile(path.join(conflicted, 'registry/agents.json'), '{"version":1,"agents":[]}\n');
  const logs = [];
  await assert.rejects(
    startDashboard({ env: await rootEnv(t, conflicted, repo), log: (entry) => logs.push(entry) }),
    { code: 'migration_conflict' },
  );
  assert.equal(logs[0].event, 'migration_conflict');
  await assert.rejects(lstat(path.join(conflicted, 'daemon.lock')), { code: 'ENOENT' });
  await assert.rejects(lstat(path.join(conflicted, 'layout.json')), { code: 'ENOENT' });
  assert.ok((await lstat(path.join(repo, 'registry/agents.json'))).isFile(), 'nothing was renamed');
});

test('a second node process on a held root exits 1 with one sentence', async (t) => {
  const home = path.join(await tempDir(t), 'root');
  const env = await rootEnv(t, home);
  const first = await startDashboard({ env, log: () => {}, createAdapters: () => ({ claude: idleAdapter() }) });
  t.after(() => first.close());
  const inherited = { ...process.env };
  delete inherited.ANTHROPIC_API_KEY;
  delete inherited.OPENAI_API_KEY;
  const result = spawnSync(process.execPath, ['server.mjs'], {
    cwd: APP_DIR, encoding: 'utf8', timeout: 10_000, env: { ...inherited, ...(await rootEnv(t, home)) },
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /"event":"root_locked"/);
  assert.equal(result.stderr,
    `dashboard: The lock ${path.join(home, 'daemon.lock')} is held by process ${process.pid}, so this daemon does not start over the same root.\n`);
});
