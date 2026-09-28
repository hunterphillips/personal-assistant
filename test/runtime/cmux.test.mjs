import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

import { LIMITS, TIMEOUTS } from '../../lib/config.mjs';
import { createCmux, defaultSpawnSessionsList } from '../../lib/runtime/cmux.mjs';
import { tempDir } from '../support/harness.mjs';

const FIXTURES = fileURLToPath(new URL('../fixtures/cmux/', import.meta.url));
const fixture = (name) => JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8'));

const WS1 = '1F9F550D-BA32-4C4D-86E1-C4C6FBDB192F';
const WS2 = '33B8390A-D8B0-47D1-BDE5-CE1390415F37';
const SF1 = '9211C31B-34F1-47BF-88D4-C3B1D414A8B3';
const SF2 = '00223EE0-DBBE-4EB8-9D20-9330C73C8389';
const SF3 = 'FAC38F03-4197-411A-94CD-ADE92213534C';
const CLOSED = 'E03C63C2-AD4F-4625-BDAA-9E5D3B3646F7';
const CLOSED_WS = '7798011B-97D6-4743-B408-102EFE04852E';
const PASSWORD = `spike-secret-${randomBytes(12).toString('hex')}`;
const T0 = new Date('2026-09-28T12:00:00.000Z');

// Every log entry from every test lands here; the last test proves none of
// them carries the password.
const allLogs = [];
const allAnswers = [];

const rpcError = (code, message) => ({ ok: false, error: { code, message } });
const notFound = (what) => rpcError('not_found', `${what} not found`);

function defaultHandlers() {
  return {
    'workspace.list': () => ({ ok: true, result: fixture('workspace-list.json') }),
    'surface.list': ({ workspace_id: id }) => {
      if (id === WS1) return { ok: true, result: fixture('surface-list-ws1.json') };
      if (id === WS2) return { ok: true, result: fixture('surface-list-ws2.json') };
      return notFound('Workspace');
    },
    'surface.focus': ({ surface_id: surface, workspace_id: workspace }) => {
      if (workspace === WS2 && [SF2, SF3].includes(surface)) return { ok: true, result: { ...fixture('focus-ok.json'), surface_id: surface } };
      if (workspace === WS1 && surface === SF1) return { ok: true, result: { ...fixture('focus-ok.json'), surface_id: surface, workspace_id: WS1 } };
      return notFound(workspace === WS1 || workspace === WS2 ? 'Surface' : 'Workspace');
    },
    'system.identify': () => ({ ok: true, result: fixture('identify.json') }),
  };
}

// A scripted cmux socket: checks the auth line, then answers JSON-RPC by
// method from `handlers`. A handler gets (params, { socket, id }) and
// returns an answer object (framed with the request id), a string (written
// raw), or null (nothing written; the handler wrote itself or never will).
// `mode` is 'password' (the verified setting), 'denied' (the default
// cmuxOnly mode, which refuses before any auth), or 'silent' (never
// answers the handshake).
async function startFakeCmux(t, { handlers = defaultHandlers(), mode = 'password', password = PASSWORD } = {}) {
  const socketPath = path.join(os.tmpdir(), `cmux-test-${randomBytes(4).toString('hex')}.sock`);
  const state = { calls: [], connections: 0, sockets: new Set(), handlers, mode };
  const closeWaiters = [];
  const server = net.createServer((socket) => {
    state.connections += 1;
    state.sockets.add(socket);
    socket.on('close', () => {
      state.sockets.delete(socket);
      if (state.sockets.size === 0) closeWaiters.splice(0).forEach((resolve) => resolve());
    });
    socket.on('error', () => {});
    if (state.mode === 'denied') {
      socket.end('ERROR: Access denied - only processes started inside cmux can connect\n');
      return;
    }
    if (state.mode === 'silent') return;
    let authed = false;
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (!authed && line.startsWith('auth ')) {
          if (line === `auth ${password}`) {
            authed = true;
            socket.write('OK: Authenticated\n');
          } else {
            socket.write('ERROR: Invalid password\n');
          }
          continue;
        }
        let request;
        try {
          request = JSON.parse(line);
        } catch {
          continue;
        }
        if (!authed) {
          socket.write(`${JSON.stringify({ id: request.id, ...rpcError('auth_required', 'Authentication required. Send auth <password> first.') })}\n`);
          continue;
        }
        state.calls.push({ method: request.method, params: request.params });
        const handler = state.handlers[request.method];
        Promise.resolve(handler ? handler(request.params ?? {}, { socket, id: request.id }) : rpcError('method_not_found', 'Unknown method'))
          .then((answer) => {
            if (answer === null || answer === undefined) return;
            if (typeof answer === 'string') socket.write(answer);
            else socket.write(`${JSON.stringify({ id: request.id, ...answer })}\n`);
          })
          .catch(() => {});
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  state.socketPath = socketPath;
  state.dropConnections = () => {
    for (const socket of state.sockets) socket.destroy();
  };
  // Resolves once every accepted socket has emitted 'close'.
  state.allClosed = () => (state.sockets.size === 0 ? Promise.resolve() : new Promise((resolve) => closeWaiters.push(resolve)));
  t.after(async () => {
    state.dropConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(socketPath, { force: true });
  });
  return state;
}

// A cmux client over the fake server, with discovery files in a temporary
// directory. `sessions` is what the fake `cmux sessions list --json` returns.
async function setup(t, {
  server, socketPathFile = true, passwordFile = true, password = PASSWORD, sessions = fixture('sessions-list.json'),
  spawnSessionsList, cli, connect, timeouts = {}, limits = {}, clock = { now: T0 },
} = {}) {
  const dir = await tempDir(t);
  const socketPathPath = path.join(dir, 'last-socket-path');
  const passwordPath = path.join(dir, 'socket-control-password');
  if (socketPathFile) await writeFile(socketPathPath, `${server?.socketPath ?? path.join(dir, 'missing.sock')}\n`);
  if (passwordFile) await writeFile(passwordPath, `${password}\n`);
  const logs = [];
  const spawnCalls = [];
  const cmux = createCmux({
    socketPathFile: socketPathPath,
    passwordFile: passwordPath,
    cli,
    connect,
    spawnSessionsList: spawnSessionsList === null ? undefined : spawnSessionsList ?? (async (options) => {
      spawnCalls.push(options);
      return typeof sessions === 'function' ? sessions() : sessions;
    }),
    log: (entry) => {
      logs.push(entry);
      allLogs.push(entry);
    },
    timeouts: { ...TIMEOUTS, cmuxRequestMs: 2_000, ...timeouts },
    limits: { ...LIMITS, ...limits },
    now: () => new Date(clock.now),
  });
  t.after(() => cmux.close());
  const record = (answer) => {
    allAnswers.push(answer);
    return answer;
  };
  return {
    cmux, logs, spawnCalls, dir, socketPathPath, passwordPath, clock,
    inventory: () => cmux.inventory().then(record),
    focus: (ids) => cmux.focus(ids).then(record),
  };
}

const methods = (server) => server.calls.map((call) => call.method);
const events = (logs, event) => logs.filter((entry) => entry.event === event);

test('a missing socket path file means cmux is not running: nothing is spawned or connected', async (t) => {
  const server = await startFakeCmux(t);
  const { inventory, focus, spawnCalls } = await setup(t, { server, socketPathFile: false });
  const answer = await inventory();
  assert.deepEqual(answer, {
    available: false, reason: 'not_running', stale: false, refreshedAt: '2026-09-28T12:00:00.000Z', workspaces: [], surfaces: [], agents: [],
  });
  assert.deepEqual(await focus({ workspaceId: WS2, surfaceId: SF2 }), { ok: false, reason: 'not_running' });
  assert.equal(spawnCalls.length, 0);
  assert.equal(server.connections, 0);
});

test('a socket path file left behind after a crash is also not running', async (t) => {
  const { inventory, spawnCalls } = await setup(t, { server: null });
  const answer = await inventory();
  assert.equal(answer.available, false);
  assert.equal(answer.reason, 'not_running');
  assert.equal(spawnCalls.length, 1, 'the sessions listing runs alongside the connect attempt');
});

test('a missing or empty password file is no_password, before any connection', async (t) => {
  const server = await startFakeCmux(t);
  const missing = await setup(t, { server, passwordFile: false });
  assert.equal((await missing.inventory()).reason, 'no_password');
  assert.deepEqual(await missing.focus({ workspaceId: WS2, surfaceId: SF2 }), { ok: false, reason: 'no_password' });
  const empty = await setup(t, { server, password: '   ' });
  assert.equal((await empty.inventory()).reason, 'no_password');
  assert.equal(server.connections, 0);
});

test('a refused password is auth_failed on every call and logged once', async (t) => {
  const server = await startFakeCmux(t);
  const { inventory, focus, logs } = await setup(t, { server, password: 'not-the-password' });
  for (let i = 0; i < 3; i += 1) {
    const answer = await inventory();
    assert.equal(answer.available, false);
    assert.equal(answer.reason, 'auth_failed');
    assert.equal(answer.stale, false);
  }
  assert.deepEqual(await focus({ workspaceId: WS2, surfaceId: SF2 }), { ok: false, reason: 'auth_failed' });
  assert.deepEqual(events(logs, 'cmux_auth_failed'), [{ event: 'cmux_auth_failed', cause: 'invalid_password' }]);
  assert.equal(server.calls.length, 0, 'no request was sent without auth');
  assert.equal(server.connections, 4, 'each call tries again so a fixed password is picked up');
});

test('the default cmuxOnly socket mode is auth_failed too, with its own cause', async (t) => {
  const server = await startFakeCmux(t, { mode: 'denied' });
  const { inventory, logs } = await setup(t, { server });
  assert.equal((await inventory()).reason, 'auth_failed');
  assert.equal((await inventory()).reason, 'auth_failed');
  assert.deepEqual(events(logs, 'cmux_auth_failed'), [{ event: 'cmux_auth_failed', cause: 'access_denied' }]);
});

test('only an ERROR: line fails the handshake; other pre-auth lines are ignored', async (t) => {
  // This server answers the auth line with chatter and a JSON error frame
  // first, then the real refusal. The client waits for the ERROR: line.
  const custom = net.createServer((socket) => {
    socket.on('error', () => {});
    socket.once('data', () => {
      socket.write('an unauthenticated notice\n{"id":"none","ok":false,"error":{"code":"auth_required","message":"Authentication required"}}\n');
      setTimeout(() => socket.end('ERROR: Authentication required\n'), 20);
    });
  });
  const socketPath = path.join(os.tmpdir(), `cmux-test-${randomBytes(4).toString('hex')}.sock`);
  await new Promise((resolve) => custom.listen(socketPath, resolve));
  t.after(async () => {
    await new Promise((resolve) => custom.close(resolve));
    await rm(socketPath, { force: true });
  });
  const { inventory, logs } = await setup(t, { server: { socketPath }, password: 'chatty' });
  const answer = await inventory();
  assert.equal(answer.reason, 'auth_failed');
  assert.deepEqual(events(logs, 'cmux_auth_failed'), [{ event: 'cmux_auth_failed', cause: 'auth_required' }]);
});

test('inventory lists workspaces, surfaces, and agents with a live flag, over one connection', async (t) => {
  const server = await startFakeCmux(t);
  const { inventory, logs, spawnCalls } = await setup(t, { server });
  const answer = await inventory();
  assert.equal(answer.available, true);
  assert.equal(answer.stale, false);
  assert.equal(answer.refreshedAt, '2026-09-28T12:00:00.000Z');
  assert.deepEqual(answer.workspaces, [
    { id: WS1, name: '~', cwd: '/Users/hunter' },
    { id: WS2, name: '…/spike/work', cwd: '/Users/hunter/workspace/spike/work' },
  ]);
  assert.deepEqual(answer.surfaces.map(({ id, workspaceId, paneId, title }) => ({ id, workspaceId, paneId, title })), [
    { id: SF1, workspaceId: WS1, paneId: 'C9E6F4FA-3675-4E1D-ADD6-E93CC8B0B233', title: '~' },
    { id: SF2, workspaceId: WS2, paneId: 'DAB1AFE6-E7DA-4AD0-A750-A17E69E869FB', title: '…/spike/work' },
    { id: SF3, workspaceId: WS2, paneId: 'DAB1AFE6-E7DA-4AD0-A750-A17E69E869FB', title: 'Terminal' },
  ]);
  assert.equal(answer.surfaces[0].cwd, '/Users/hunter');
  assert.deepEqual(answer.agents, [
    {
      sessionId: 'a9d25355-6056-4302-9146-5d905cb8cec5',
      agent: 'claude',
      state: 'running',
      cwd: '/Users/hunter/workspace/spike/work',
      workspaceId: WS2,
      surfaceId: SF2,
      startedAt: '2026-09-28T11:59:16.395Z',
      updatedAt: '2026-09-28T11:59:16.395Z',
      live: true,
    },
    {
      sessionId: '4b90ed66-849b-4595-a67b-16a67aed112c',
      agent: 'claude',
      state: 'idle',
      cwd: '/Users/hunter/workspace/eval/native-edge',
      workspaceId: CLOSED_WS,
      surfaceId: CLOSED,
      startedAt: '2026-09-15T16:54:27.119Z',
      updatedAt: '2026-09-15T16:54:51.601Z',
      live: false,
    },
  ]);
  assert.deepEqual(methods(server).sort(), ['surface.list', 'surface.list', 'workspace.list']);
  assert.deepEqual(server.calls.filter((call) => call.method === 'surface.list').map((call) => call.params).sort((a, b) => (a.workspace_id < b.workspace_id ? -1 : 1)),
    [{ workspace_id: WS1 }, { workspace_id: WS2 }]);
  assert.equal(spawnCalls.length, 1);
  assert.equal(server.connections, 1);
  // The malformed records and the non-object were skipped, each logged once.
  assert.deepEqual(events(logs, 'cmux_record_skipped').map((entry) => entry.reason).sort(), ['invalid_session_id', 'no_surface_id', 'not_an_object']);
  await inventory();
  assert.equal(events(logs, 'cmux_record_skipped').length, 3);
  assert.equal(server.connections, 1, 'the second call reused the connection');
});

test('answers are frozen: a consumer cannot change the cache', async (t) => {
  const server = await startFakeCmux(t);
  const { inventory, cmux } = await setup(t, { server });
  const answer = await inventory();
  assert.throws(() => { answer.surfaces.push({}); }, TypeError);
  assert.throws(() => { answer.agents[0].live = false; }, TypeError);
  assert.throws(() => { answer.workspaces.length = 0; }, TypeError);
  assert.equal(cmux.current().surfaces.length, 3);
});

test('a session whose surface moved to another workspace is not live', async (t) => {
  const server = await startFakeCmux(t);
  const sessions = fixture('sessions-list.json');
  sessions.sessions[0].workspace_id = WS1;
  const { inventory } = await setup(t, { server, sessions });
  const answer = await inventory();
  assert.equal(answer.agents[0].live, false);
});

test('a record with lowercase ids matches the listing without regard to case', async (t) => {
  const server = await startFakeCmux(t);
  const sessions = fixture('sessions-list.json');
  sessions.sessions[0].workspace_id = WS2.toLowerCase();
  sessions.sessions[0].surface_id = SF2.toLowerCase();
  const { inventory } = await setup(t, { server, sessions });
  const answer = await inventory();
  assert.equal(answer.agents[0].workspaceId, WS2.toLowerCase());
  assert.equal(answer.agents[0].surfaceId, SF2.toLowerCase());
  assert.equal(answer.agents[0].live, true);
});

test('refresh and current follow inventory', async (t) => {
  const server = await startFakeCmux(t);
  const { cmux } = await setup(t, { server });
  assert.equal(cmux.current(), null);
  const answer = await cmux.refresh();
  assert.equal(answer.available, true);
  assert.equal(cmux.current(), answer);
});

test('a transient failure returns the last good inventory as stale, and error with nothing cached', async (t) => {
  const server = await startFakeCmux(t);
  let broken = false;
  const { inventory, logs } = await setup(t, { server, sessions: () => (broken ? 'not json at all' : fixture('sessions-list.json')) });
  const cold = await setup(t, { server, sessions: () => 'not json at all' });
  const empty = await cold.inventory();
  assert.equal(empty.available, false);
  assert.equal(empty.reason, 'error');
  assert.equal(empty.stale, false);

  const good = await inventory();
  broken = true;
  const stale = await inventory();
  assert.equal(stale.available, true);
  assert.equal(stale.stale, true);
  assert.deepEqual(stale.agents, good.agents);
  assert.deepEqual(stale.surfaces, good.surfaces);
  broken = false;
  assert.equal((await inventory()).stale, false);
  const errors = events(logs, 'cmux_inventory_error');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].message, 'invalid JSON');
});

test('a cache is served stale for cmuxStaleMs and then the answer is error', async (t) => {
  const server = await startFakeCmux(t);
  let broken = false;
  const { inventory, clock } = await setup(t, { server, timeouts: { cmuxStaleMs: 60_000 }, sessions: () => (broken ? 'nope' : fixture('sessions-list.json')) });
  await inventory();
  broken = true;
  clock.now = new Date(T0.getTime() + 60_000);
  assert.equal((await inventory()).stale, true, 'within the window');
  clock.now = new Date(T0.getTime() + 60_001);
  const expired = await inventory();
  assert.equal(expired.available, false);
  assert.equal(expired.reason, 'error');
  assert.equal(expired.refreshedAt, '2026-09-28T12:01:00.001Z');
  broken = false;
  assert.equal((await inventory()).stale, false);
  broken = true;
  clock.now = new Date(T0.getTime() + 90_000);
  assert.equal((await inventory()).stale, true, 'the window restarts from the new good answer');
});

test('a recurring failure after a recovery is logged again', async (t) => {
  const server = await startFakeCmux(t);
  let broken = false;
  const { inventory, logs } = await setup(t, { server, sessions: () => (broken ? 'nope' : fixture('sessions-list.json')) });
  await inventory();
  broken = true;
  await inventory();
  await inventory();
  assert.equal(events(logs, 'cmux_inventory_error').length, 1, 'once while it persists');
  broken = false;
  await inventory();
  broken = true;
  await inventory();
  assert.equal(events(logs, 'cmux_inventory_error').length, 2, 'again after a good answer');
});

test('a failed sessions listing and an RPC error are both transient', async (t) => {
  const server = await startFakeCmux(t);
  const { inventory } = await setup(t, { server, sessions: () => { throw new Error('spawn cmux ENOENT'); } });
  assert.equal((await inventory()).reason, 'error');

  const errored = await startFakeCmux(t, { handlers: { ...defaultHandlers(), 'workspace.list': () => rpcError('internal', 'boom') } });
  const other = await setup(t, { server: errored });
  assert.equal((await other.inventory()).reason, 'error');
});

test('a connection that fails for another reason than an absent socket is transient and served from the cache', async (t) => {
  const server = await startFakeCmux(t);
  let refuse = false;
  const connect = (socketPath) => {
    if (refuse) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    return net.connect(socketPath);
  };
  const { inventory, logs, cmux } = await setup(t, { server, connect });
  assert.equal((await inventory()).available, true);
  cmux.close();
  await server.allClosed();
  refuse = true;
  const answer = await inventory();
  assert.equal(answer.available, true);
  assert.equal(answer.stale, true);
  assert.ok(events(logs, 'cmux_inventory_error').some((entry) => entry.code === 'connect_failed' && entry.detail === 'EACCES'));
});

test('a workspace that closes between the two listings is skipped', async (t) => {
  const handlers = defaultHandlers();
  handlers['surface.list'] = ({ workspace_id: id }) => (id === WS1 ? notFound('Workspace') : { ok: true, result: fixture('surface-list-ws2.json') });
  const server = await startFakeCmux(t, { handlers });
  const { inventory } = await setup(t, { server });
  const answer = await inventory();
  assert.equal(answer.available, true);
  assert.deepEqual(answer.surfaces.map((surface) => surface.id), [SF2, SF3]);
});

test('every workspace answering not_found is a failed listing, not an empty one', async (t) => {
  const handlers = defaultHandlers();
  handlers['surface.list'] = () => notFound('Workspace');
  const server = await startFakeCmux(t, { handlers });
  const { inventory, logs } = await setup(t, { server });
  const answer = await inventory();
  assert.equal(answer.available, false);
  assert.equal(answer.reason, 'error');
  assert.ok(events(logs, 'cmux_inventory_error').some((entry) => entry.code === 'rpc' && entry.detail === 'all_not_found'));
});

test('a surface.list reply of the wrong shape, or for another workspace, is refused and logged once', async (t) => {
  const handlers = defaultHandlers();
  let shape = 'string';
  handlers['surface.list'] = ({ workspace_id: id }) => {
    if (shape === 'string') return { ok: true, result: { surfaces: 'nope', workspace_id: id } };
    if (shape === 'other') return { ok: true, result: { ...fixture('surface-list-ws1.json'), workspace_id: id === WS1 ? WS2 : WS1 } };
    return defaultHandlers()['surface.list']({ workspace_id: id });
  };
  const server = await startFakeCmux(t, { handlers });
  const { inventory, focus, logs } = await setup(t, { server });
  assert.equal((await inventory()).reason, 'error');
  assert.equal((await inventory()).reason, 'error');
  assert.deepEqual(events(logs, 'cmux_surface_list_shape').map((entry) => entry.problem), ['no_surfaces_array']);
  shape = 'other';
  assert.equal((await inventory()).reason, 'error');
  assert.deepEqual(await focus({ workspaceId: WS1, surfaceId: SF1 }), { ok: false, reason: 'error' });
  assert.deepEqual(events(logs, 'cmux_surface_list_shape').map((entry) => entry.problem), ['no_surfaces_array', 'other_workspace']);
  assert.ok(events(logs, 'cmux_surface_list_shape').every((entry) => isUuidLike(entry.workspaceId)));
  shape = 'good';
  assert.equal((await inventory()).available, true);
  shape = 'string';
  await inventory();
  assert.equal(events(logs, 'cmux_surface_list_shape').length, 3, 'logged again after a good reply');
});

test('focus lists the workspace afresh, focuses with both ids, reads back, and logs ids only', async (t) => {
  const server = await startFakeCmux(t);
  const { focus, logs } = await setup(t, { server });
  assert.deepEqual(await focus({ workspaceId: WS2, surfaceId: SF2 }), { ok: true, verified: true });
  assert.deepEqual(server.calls, [
    { method: 'surface.list', params: { workspace_id: WS2 } },
    { method: 'surface.focus', params: { surface_id: SF2, workspace_id: WS2 } },
    { method: 'system.identify', params: {} },
  ]);
  assert.deepEqual(events(logs, 'cmux_focus'), [
    { event: 'cmux_focus', workspaceId: WS2, surfaceId: SF2, ok: true, verified: true },
  ]);
});

test('focus reports verified false when the read-back names another surface or fails', async (t) => {
  const handlers = defaultHandlers();
  handlers['system.identify'] = () => ({ ok: true, result: fixture('identify.json') });
  const server = await startFakeCmux(t, { handlers });
  const { focus } = await setup(t, { server });
  assert.deepEqual(await focus({ workspaceId: WS2, surfaceId: SF3 }), { ok: true, verified: false });
  handlers['system.identify'] = () => rpcError('internal', 'boom');
  assert.deepEqual(await focus({ workspaceId: WS2, surfaceId: SF2 }), { ok: true, verified: false });
});

test('focus of a surface missing from the fresh listing is not_found and focuses nothing', async (t) => {
  const server = await startFakeCmux(t);
  const { focus, logs } = await setup(t, { server });
  assert.deepEqual(await focus({ workspaceId: CLOSED_WS, surfaceId: CLOSED }), { ok: false, reason: 'not_found' });
  assert.deepEqual(await focus({ workspaceId: WS2, surfaceId: CLOSED }), { ok: false, reason: 'not_found' });
  // The surface exists, but not in the workspace the caller named.
  assert.deepEqual(await focus({ workspaceId: WS1, surfaceId: SF2 }), { ok: false, reason: 'not_found' });
  assert.deepEqual(methods(server), ['surface.list', 'surface.list', 'surface.list']);
  const refusals = events(logs, 'cmux_focus');
  assert.equal(refusals.length, 3);
  assert.ok(refusals.every((entry) => entry.ok === false && entry.reason === 'not_found'));
});

test('a surface that closes between the listing and the focus is not_found from cmux', async (t) => {
  const handlers = defaultHandlers();
  handlers['surface.focus'] = () => notFound('Surface');
  const server = await startFakeCmux(t, { handlers });
  const { focus } = await setup(t, { server });
  assert.deepEqual(await focus({ workspaceId: WS2, surfaceId: SF2 }), { ok: false, reason: 'not_found' });
  assert.deepEqual(methods(server), ['surface.list', 'surface.focus']);
});

test('focus with anything but two UUIDs is refused before any I/O', async (t) => {
  const server = await startFakeCmux(t);
  const { cmux, spawnCalls } = await setup(t, { server });
  for (const bad of [undefined, {}, { workspaceId: WS2 }, { workspaceId: 'workspace:2', surfaceId: SF2 }, { workspaceId: WS2, surfaceId: '../x' }]) {
    const pending = cmux.focus(bad);
    const settled = await Promise.race([pending, Promise.resolve('later')]);
    assert.deepEqual(settled, { ok: false, reason: 'error' });
  }
  assert.equal(server.connections, 0);
  assert.equal(spawnCalls.length, 0);
});

test('a request that gets no answer times out, drops the connection, and the next call reconnects', async (t) => {
  const handlers = defaultHandlers();
  let hang = true;
  handlers['workspace.list'] = () => (hang ? new Promise(() => {}) : { ok: true, result: fixture('workspace-list.json') });
  const server = await startFakeCmux(t, { handlers });
  const { inventory, logs } = await setup(t, { server, timeouts: { cmuxRequestMs: 60 } });
  const started = Date.now();
  const answer = await inventory();
  assert.ok(Date.now() - started < 1_000);
  assert.equal(answer.reason, 'error');
  await server.allClosed();
  assert.equal(server.sockets.size, 0, 'the timed-out connection was dropped');
  assert.ok(events(logs, 'cmux_inventory_error').some((entry) => entry.code === 'timeout' && entry.detail === 'workspace.list'));
  hang = false;
  assert.equal((await inventory()).available, true);
  assert.equal(server.connections, 2);
});

test('a reply that arrives after its request timed out hits a closed socket and touches nothing', async (t) => {
  const handlers = defaultHandlers();
  let late = true;
  const lateWrites = [];
  handlers['workspace.list'] = async (params, { socket, id }) => {
    if (!late) return { ok: true, result: fixture('workspace-list.json') };
    await delay(150);
    lateWrites.push(socket.destroyed);
    if (!socket.destroyed) socket.write(`${JSON.stringify({ id, ok: true, result: fixture('workspace-list.json') })}\n`);
    return null;
  };
  const server = await startFakeCmux(t, { handlers });
  const { inventory, cmux } = await setup(t, { server, timeouts: { cmuxRequestMs: 60 } });
  assert.equal((await inventory()).reason, 'error');
  await server.allClosed();
  late = false;
  const second = await inventory();
  assert.equal(second.available, true);
  assert.equal(server.connections, 2);
  await delay(200);
  assert.deepEqual(lateWrites, [true], 'the late reply found its socket already closed');
  assert.equal(cmux.current(), second);
});

test('replies out of order are matched by id', async (t) => {
  const handlers = defaultHandlers();
  handlers['surface.list'] = async ({ workspace_id: id }) => {
    if (id === WS1) {
      await delay(80);
      return { ok: true, result: fixture('surface-list-ws1.json') };
    }
    return { ok: true, result: fixture('surface-list-ws2.json') };
  };
  const server = await startFakeCmux(t, { handlers });
  const { inventory } = await setup(t, { server });
  const answer = await inventory();
  assert.deepEqual(answer.surfaces.map((surface) => [surface.id, surface.workspaceId]), [[SF1, WS1], [SF2, WS2], [SF3, WS2]]);
});

test('a frame split across two writes, with an id-less frame between, is reassembled', async (t) => {
  const handlers = defaultHandlers();
  handlers['workspace.list'] = (params, { socket, id }) => {
    const frame = JSON.stringify({ id, ok: true, result: fixture('workspace-list.json') });
    const cut = Math.floor(frame.length / 2);
    socket.write(`{"event":"workspace.changed","seq":7}\n${frame.slice(0, cut)}`);
    setTimeout(() => socket.write(`${frame.slice(cut)}\nnot json\n{"id":"nobody-waits","ok":true,"result":{}}\n`), 20);
    return null;
  };
  const server = await startFakeCmux(t, { handlers });
  const { inventory } = await setup(t, { server });
  const answer = await inventory();
  assert.equal(answer.available, true);
  assert.equal(answer.workspaces.length, 2);
  assert.equal(server.connections, 1);
});

test('two concurrent inventory calls share one connection', async (t) => {
  const server = await startFakeCmux(t);
  const { inventory, spawnCalls } = await setup(t, { server });
  const [first, second] = await Promise.all([inventory(), inventory()]);
  assert.equal(first.available, true);
  assert.equal(second.available, true);
  assert.equal(server.connections, 1);
  assert.equal(spawnCalls.length, 2);
  assert.equal(methods(server).filter((method) => method === 'workspace.list').length, 2);
});

test('close() with a request in flight fails that call and the next call reconnects', async (t) => {
  const handlers = defaultHandlers();
  let hang = true;
  handlers['workspace.list'] = () => (hang ? null : { ok: true, result: fixture('workspace-list.json') });
  const server = await startFakeCmux(t, { handlers });
  const { cmux, inventory, logs } = await setup(t, { server });
  const pending = inventory();
  while (server.calls.length === 0) await delay(5);
  cmux.close();
  const answer = await pending;
  assert.equal(answer.reason, 'error');
  assert.ok(events(logs, 'cmux_inventory_error').some((entry) => entry.code === 'closed' && entry.detail === 'client'));
  await server.allClosed();
  hang = false;
  assert.equal((await inventory()).available, true);
  assert.equal(server.connections, 2);
});

test('a server that never finishes the auth handshake times out as an error, not auth_failed', async (t) => {
  const server = await startFakeCmux(t, { mode: 'silent' });
  const { inventory, logs } = await setup(t, { server, timeouts: { cmuxRequestMs: 60 } });
  const answer = await inventory();
  assert.equal(answer.reason, 'error');
  assert.ok(events(logs, 'cmux_inventory_error').some((entry) => entry.code === 'timeout' && entry.detail === 'auth'));
  assert.equal(events(logs, 'cmux_auth_failed').length, 0);
});

test('a frame over the cap drops the connection and is logged', async (t) => {
  const handlers = defaultHandlers();
  handlers['workspace.list'] = () => `${JSON.stringify({ id: 'x', ok: true, result: { pad: 'y'.repeat(5_000) } })}\n`;
  const server = await startFakeCmux(t, { handlers });
  const { inventory, logs } = await setup(t, { server, limits: { cmuxFrameBytes: 4_096 } });
  const answer = await inventory();
  assert.equal(answer.reason, 'error');
  assert.deepEqual(events(logs, 'cmux_frame_too_large'), [{ event: 'cmux_frame_too_large', limit: 4_096 }]);
  await server.allClosed();
  assert.equal(server.sockets.size, 0);
  // An unterminated tail over the cap is cut off the same way.
  handlers['workspace.list'] = () => 'z'.repeat(5_000);
  assert.equal((await inventory()).reason, 'error');
  assert.equal(events(logs, 'cmux_frame_too_large').length, 2);
});

test('after the server drops the connection, or close(), the next call reconnects', async (t) => {
  const server = await startFakeCmux(t);
  const { cmux, inventory } = await setup(t, { server });
  assert.equal((await inventory()).available, true);
  server.dropConnections();
  await server.allClosed();
  assert.equal((await inventory()).available, true);
  assert.equal(server.connections, 2);
  cmux.close();
  cmux.close();
  await server.allClosed();
  assert.equal(server.sockets.size, 0);
  assert.equal((await inventory()).available, true);
  assert.equal(server.connections, 3);
});

test('a connection dropped mid-request fails that call as transient and serves the cache', async (t) => {
  const handlers = defaultHandlers();
  let server;
  let drop = false;
  handlers['workspace.list'] = () => {
    if (drop) {
      server.dropConnections();
      return new Promise(() => {});
    }
    return { ok: true, result: fixture('workspace-list.json') };
  };
  server = await startFakeCmux(t, { handlers });
  const { inventory, logs } = await setup(t, { server });
  await inventory();
  drop = true;
  const stale = await inventory();
  assert.equal(stale.stale, true);
  assert.ok(events(logs, 'cmux_inventory_error').some((entry) => entry.code === 'closed'));
});

test('a changed password file is tried on the next call without a restart', async (t) => {
  const server = await startFakeCmux(t);
  const { inventory, passwordPath, logs } = await setup(t, { server, password: 'wrong-at-first' });
  assert.equal((await inventory()).reason, 'auth_failed');
  await writeFile(passwordPath, `${PASSWORD}\n`);
  assert.equal((await inventory()).available, true);
  // A connection already authenticated stays valid whatever the file says;
  // the file is read again only when a new connection is needed.
  await writeFile(passwordPath, 'wrong-again\n');
  assert.equal((await inventory()).available, true);
  server.dropConnections();
  await server.allClosed();
  assert.equal((await inventory()).reason, 'auth_failed');
  assert.equal(events(logs, 'cmux_auth_failed').length, 2, 'a new wrong password is a new failure');
  // The same wrong password after a good handshake is logged again too.
  await writeFile(passwordPath, `${PASSWORD}\n`);
  server.dropConnections();
  await server.allClosed();
  assert.equal((await inventory()).available, true);
  await writeFile(passwordPath, 'wrong-again\n');
  server.dropConnections();
  await server.allClosed();
  assert.equal((await inventory()).reason, 'auth_failed');
  assert.equal(events(logs, 'cmux_auth_failed').length, 3);
});

test('a missing cmux binary is logged once and is a transient failure', async (t) => {
  const server = await startFakeCmux(t);
  const dir = await tempDir(t);
  const { inventory, logs } = await setup(t, { server, spawnSessionsList: null, cli: path.join(dir, 'no-such-cmux') });
  assert.equal((await inventory()).reason, 'error');
  assert.equal((await inventory()).reason, 'error');
  assert.deepEqual(events(logs, 'cmux_cli_missing'), [{ event: 'cmux_cli_missing', path: path.join(dir, 'no-such-cmux') }]);
  assert.ok(events(logs, 'cmux_inventory_error').some((entry) => entry.code === 'sessions_failed' && entry.detail === 'ENOENT'));
});

// defaultSpawnSessionsList with a scripted execFile; the real cmux is never run.
test('defaultSpawnSessionsList runs the quiet listing at the configured path with a timeout and returns its text', async () => {
  const calls = [];
  const run = (command, args, options, callback) => {
    calls.push({ command, args, options });
    setImmediate(() => callback(null, '{"sessions":[]}', ''));
  };
  const text = await defaultSpawnSessionsList({ command: '/Applications/cmux.app/Contents/Resources/bin/cmux', timeoutMs: 123, run, env: { PATH: '/usr/bin' } });
  assert.equal(text, '{"sessions":[]}');
  assert.equal(calls[0].command, '/Applications/cmux.app/Contents/Resources/bin/cmux');
  assert.deepEqual(calls[0].args, ['sessions', 'list', '--json']);
  assert.equal(calls[0].options.timeout, 123);
  assert.ok(calls[0].options.maxBuffer > 0);
  assert.deepEqual(calls[0].options.env, { PATH: '/usr/bin', CMUX_QUIET: '1' });

  const failing = (command, args, options, callback) => setImmediate(() => callback(Object.assign(new Error('spawn cmux ENOENT'), { code: 'ENOENT' }), '', ''));
  await assert.rejects(defaultSpawnSessionsList({ timeoutMs: 1, run: failing }), (error) => {
    assert.equal(error.name, 'CmuxError');
    assert.equal(error.code, 'sessions_failed');
    assert.equal(error.detail, 'ENOENT');
    return true;
  });
});

test('a sessions listing that exits non-zero with a stderr notice fails without the notice', async () => {
  const notice = 'cmux: store /Users/someone/.cmuxterm/claude-hook-sessions.json is locked';
  const exiting = (command, args, options, callback) => setImmediate(() => callback(Object.assign(new Error('Command failed'), { code: 1 }), '', notice));
  await assert.rejects(defaultSpawnSessionsList({ timeoutMs: 1, run: exiting }), (error) => {
    assert.equal(error.code, 'sessions_failed');
    assert.equal(error.detail, 'exit 1');
    assert.ok(!error.message.includes('someone'));
    return true;
  });
});

function isUuidLike(value) {
  return typeof value === 'string' && /^[0-9A-F-]{36}$/i.test(value);
}

after(() => {
  assert.ok(allLogs.length >= 10, 'the tests logged something');
  assert.ok(allAnswers.length >= 10, 'the tests answered something');
  const leaked = allLogs.filter((entry) => JSON.stringify(entry).includes(PASSWORD));
  assert.deepEqual(leaked, [], 'a log entry carried the password');
  const answered = allAnswers.filter((entry) => JSON.stringify(entry).includes(PASSWORD));
  assert.deepEqual(answered, [], 'an answer carried the password');
  for (const wrong of ['wrong-at-first', 'wrong-again', 'not-the-password', 'chatty']) {
    assert.ok(!allLogs.some((entry) => JSON.stringify(entry).includes(wrong)), `a log entry carried ${wrong}`);
  }
});
