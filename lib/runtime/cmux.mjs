// cmux client: lists the terminals cmux has open and the agent sessions it
// knows about, and focuses one exact surface. It reads two files, keeps one
// authenticated socket connection, and spawns one read-only CLI verb. It
// never starts cmux, never creates or closes a surface, never sends text or
// keys, and never focuses anything it did not just see in a fresh listing.
// The protocol and verbs come from the 2026-09-28 spike (cmux 0.64.25):
// `thoughts/shared/research/2026-09-28-cmux-spike.md`.
//
// createCmux({ socketPathFile, passwordFile, spawnSessionsList, connect,
//              log, timeouts, limits, now }) returns:
//
//   inventory() -> Promise<Inventory>
//     Inventory is
//       { available, reason?, stale, refreshedAt,
//         workspaces: [{ id, name, cwd }],
//         surfaces:   [{ id, workspaceId, panelId, title, cwd }],
//         agents:     [{ sessionId, agent, state, cwd, workspaceId, surfaceId,
//                        startedAt, updatedAt, live }] }
//     Workspaces come from `workspace.list` and surfaces from one
//     `surface.list` per workspace, both over the socket. Agents come from
//     `cmux sessions list --json` (a subprocess; no socket needed): one
//     record per hook-registered session, `agent` as cmux names it
//     ('claude', 'codex', ...), `state` its `agent_lifecycle` ('running',
//     'idle', 'needsInput', ...; 'running' is also the state at an empty
//     prompt). `live` is true only when the record's surface is in the live
//     listing under the record's workspace, so the caller can say
//     "terminal closed" instead of offering focus. Records missing a string
//     session, workspace, or surface id are skipped (logged once per
//     reason as cmux_record_skipped).
//     Unavailable answers carry empty lists and one of these reasons:
//       not_running   the socket path file is missing, or nothing listens
//                     at the path it names
//       no_password   the password file is missing or empty
//       auth_failed   cmux refused the password, or its socket mode admits
//                     only processes started inside cmux
//       error         a transient failure with nothing cached
//     A transient failure (a timeout, a dropped connection, an oversize
//     frame, a failed or unparseable sessions listing) after at least one
//     good answer returns that last good answer with stale: true. The
//     three definite reasons are never served stale: when cmux is gone,
//     so are its surfaces.
//   refresh() -> Promise<Inventory>
//     The same as inventory(). It is the call the hub's 10-second poll
//     makes while the Agents view is open. The socket advertises
//     `events.stream`, but the spike recorded only the CLI's view of it,
//     not the request shape or how event frames sit beside replies on one
//     connection, so push is not implemented; when it is, refresh() is
//     where the handler lands and the poll goes away.
//   current() -> Inventory | null
//     The last answer, without I/O.
//   focus({ workspaceId, surfaceId }) -> Promise<{ ok: true, verified } |
//                                                { ok: false, reason }>
//     Both ids must be UUIDs; anything else is refused before the first
//     await with reason 'error'. Lists the workspace's surfaces afresh, and
//     unless that exact surface is there, answers not_found without
//     calling focus. Then `surface.focus` with both ids (from outside cmux
//     there is no default workspace), then `system.identify` to read the
//     focused surface back: verified is true when it is the one asked
//     for. Reasons: not_found, not_running, no_password, auth_failed,
//     error. Logged as cmux_focus (ids and outcome only).
//   close()
//     Ends the connection. A later call reconnects.
//
// Discovery, on every call: socketPathFile (cmux writes the socket path
// there on launch and deletes it on quit) and passwordFile (what cmux
// stores when automation.socketControlMode is `password`). The password is
// read, sent as the first line of a new connection, and dropped; it is
// never logged, never kept beyond the handshake, and never part of an
// error. Logs carry event names, ids, and error codes.
//
// Connection: one Unix socket, opened lazily and shared by every call. The
// first line out is `auth <password>`; the first line back is
// `OK: Authenticated`, or `ERROR: ...` for a refused password or a socket
// mode that admits only cmux's own children (both answer auth_failed;
// logged once per distinct socket, password, and cause, not per call, and
// retried on every call so a fixed setting is picked up without a restart).
// After that, requests are newline-delimited JSON-RPC {id, method, params}
// answered by id as {id, ok, result} or {id, ok: false, error: {code,
// message}}. Each request has timeouts.cmuxRequestMs to answer; a timeout
// drops the connection, since a late reply could be matched to nothing. A
// line, or an unterminated tail, over limits.cmuxFrameBytes drops the
// connection too (cmux_frame_too_large). A dropped connection fails every
// request in flight; the next call reconnects.
//
// Default dependencies (injected in tests):
//   connect(path) -> net.Socket           net.connect
//   spawnSessionsList({ signal }) -> Promise<object | string>
//     `cmux sessions list --json` with CMUX_QUIET=1, timeouts.cmuxSessionsMs,
//     a bounded maxBuffer; the parsed listing, or its text.

import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import net from 'node:net';

import { LIMITS, TIMEOUTS } from '../config.mjs';

const SESSIONS_MAX_BUFFER = 4 * 1024 * 1024;
const FILE_MAX_BYTES = 4096;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AUTH_OK = 'OK: Authenticated';
const NEWLINE = 0x0a;

export class CmuxError extends Error {
  constructor(code, detail = null, options) {
    super(detail ? `${code}: ${detail}` : code, options);
    this.name = 'CmuxError';
    this.code = code;
    this.detail = detail;
  }
}

export function createCmux({
  socketPathFile,
  passwordFile,
  spawnSessionsList,
  connect = (socketPath) => net.connect(socketPath),
  log = () => {},
  timeouts = TIMEOUTS,
  limits = LIMITS,
  now = () => new Date(),
}) {
  const requestMs = timeouts.cmuxRequestMs ?? TIMEOUTS.cmuxRequestMs;
  const sessionsMs = timeouts.cmuxSessionsMs ?? TIMEOUTS.cmuxSessionsMs;
  const frameBytes = limits.cmuxFrameBytes ?? LIMITS.cmuxFrameBytes;
  const listSessions = spawnSessionsList
    ?? ((options) => defaultSpawnSessionsList({ timeoutMs: sessionsMs, ...options }));

  const logged = new Set();
  const logOnce = (key, entry) => {
    if (logged.has(key)) return;
    logged.add(key);
    log(entry);
  };

  let conn = null;
  let lastGood = null;
  let last = null;

  async function discover() {
    const socketPath = await readTrimmed(socketPathFile);
    if (!socketPath || !socketPath.startsWith('/')) return { ok: false, reason: 'not_running' };
    const password = await readTrimmed(passwordFile);
    if (!password) return { ok: false, reason: 'no_password' };
    return { ok: true, socketPath, password };
  }

  // The password leaves this function only as the auth line; the
  // connection keeps a hash of it so a changed file is a new attempt.
  function open(socketPath, password) {
    const c = {
      socket: null,
      socketPath,
      passwordHash: hash(password),
      pending: new Map(),
      chunks: [],
      bytes: 0,
      authed: false,
      dead: false,
      ready: null,
      settleReady: null,
      readyTimer: null,
    };
    c.ready = new Promise((resolve, reject) => {
      c.settleReady = { resolve, reject };
    });
    c.ready.catch(() => {});
    c.readyTimer = setTimeout(() => fail(c, new CmuxError('timeout', 'auth')), requestMs);
    let socket;
    try {
      socket = connect(socketPath);
    } catch (error) {
      fail(c, connectError(error));
      return c;
    }
    c.socket = socket;
    socket.on('connect', () => {
      if (!c.dead) socket.write(`auth ${password}\n`);
    });
    socket.on('data', (chunk) => onData(c, chunk));
    socket.on('error', (error) => fail(c, c.authed ? new CmuxError('closed', error?.code ?? 'error') : connectError(error)));
    socket.on('close', () => fail(c, new CmuxError('closed')));
    return c;
  }

  function onData(c, chunk) {
    if (c.dead) return;
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let start = 0;
    for (;;) {
      const index = buffer.indexOf(NEWLINE, start);
      if (index === -1) break;
      const lineBytes = c.bytes + (index - start);
      if (lineBytes > frameBytes) {
        frameTooLarge(c);
        return;
      }
      const line = Buffer.concat([...c.chunks, buffer.subarray(start, index)]).toString('utf8');
      c.chunks = [];
      c.bytes = 0;
      start = index + 1;
      onLine(c, line);
      if (c.dead) return;
    }
    if (start < buffer.length) {
      const tail = buffer.subarray(start);
      c.bytes += tail.length;
      if (c.bytes > frameBytes) {
        frameTooLarge(c);
        return;
      }
      c.chunks.push(tail);
    }
  }

  function frameTooLarge(c) {
    log({ event: 'cmux_frame_too_large', limit: frameBytes });
    fail(c, new CmuxError('frame_too_large'));
  }

  function onLine(c, line) {
    if (!c.authed) {
      if (line === AUTH_OK) {
        c.authed = true;
        clearTimeout(c.readyTimer);
        c.settleReady.resolve();
        return;
      }
      const cause = /invalid password/i.test(line) ? 'invalid_password'
        : /access denied/i.test(line) ? 'access_denied'
          : /auth/i.test(line) ? 'auth_required' : null;
      if (cause) {
        logOnce(`auth:${c.socketPath}:${c.passwordHash}:${cause}`, { event: 'cmux_auth_failed', cause });
        fail(c, new CmuxError('auth_failed', cause));
      }
      return;
    }
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      return;
    }
    if (!isRecord(frame) || typeof frame.id !== 'string') return;
    const waiting = c.pending.get(frame.id);
    if (!waiting) return;
    c.pending.delete(frame.id);
    clearTimeout(waiting.timer);
    if (frame.ok === true) {
      waiting.resolve({ ok: true, result: frame.result });
    } else {
      const error = isRecord(frame.error) ? frame.error : {};
      waiting.resolve({
        ok: false,
        error: {
          code: typeof error.code === 'string' ? error.code : 'error',
          message: typeof error.message === 'string' ? error.message : '',
        },
      });
    }
  }

  function fail(c, error) {
    if (c.dead) return;
    c.dead = true;
    clearTimeout(c.readyTimer);
    c.settleReady.reject(error);
    for (const waiting of c.pending.values()) {
      clearTimeout(waiting.timer);
      waiting.reject(error);
    }
    c.pending.clear();
    c.socket?.destroy();
    if (conn === c) conn = null;
  }

  async function connection({ socketPath, password }) {
    if (conn && !conn.dead && conn.socketPath === socketPath) {
      await conn.ready;
      return conn;
    }
    if (conn) fail(conn, new CmuxError('closed', 'replaced'));
    conn = open(socketPath, password);
    const c = conn;
    await c.ready;
    return c;
  }

  function request(c, method, params) {
    return new Promise((resolve, reject) => {
      if (c.dead) {
        reject(new CmuxError('closed'));
        return;
      }
      const id = randomUUID();
      const timer = setTimeout(() => fail(c, new CmuxError('timeout', method)), requestMs);
      c.pending.set(id, { resolve, reject, timer });
      c.socket.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  async function call(discovery, method, params = {}) {
    const c = await connection(discovery);
    return request(c, method, params);
  }

  // One surface.list per workspace, in parallel. A workspace that closed
  // between the two calls is skipped; any other server error is thrown.
  async function listSurfaces(discovery) {
    const listed = await call(discovery, 'workspace.list', {});
    if (!listed.ok) throw new CmuxError('rpc', listed.error.code);
    const workspaces = parseWorkspaces(listed.result);
    const surfaces = await Promise.all(workspaces.map(async (workspace) => {
      const answer = await call(discovery, 'surface.list', { workspace_id: workspace.id });
      if (!answer.ok) {
        if (answer.error.code === 'not_found') return [];
        throw new CmuxError('rpc', answer.error.code);
      }
      return parseSurfaces(answer.result, workspace.id);
    }));
    return { workspaces, surfaces: surfaces.flat() };
  }

  async function listAgents() {
    const output = await listSessions({});
    const listing = typeof output === 'string' ? JSON.parse(output) : output;
    if (!isRecord(listing) || !Array.isArray(listing.sessions)) throw new CmuxError('sessions_invalid');
    const agents = [];
    listing.sessions.forEach((record, index) => {
      const parsed = parseSessionRecord(record);
      if (typeof parsed === 'string') {
        logOnce(`record:${parsed}`, { event: 'cmux_record_skipped', reason: parsed, index });
        return;
      }
      agents.push(parsed);
    });
    return agents;
  }

  function unavailable(reason) {
    return {
      available: false, reason, stale: false, refreshedAt: now().toISOString(), workspaces: [], surfaces: [], agents: [],
    };
  }

  function reasonOf(error) {
    if (error?.code === 'auth_failed') return 'auth_failed';
    if (error?.code === 'not_running') return 'not_running';
    return null;
  }

  async function inventory() {
    const discovery = await discover();
    if (!discovery.ok) return remember(unavailable(discovery.reason));
    let listing;
    let agents;
    try {
      [listing, agents] = await Promise.all([listSurfaces(discovery), listAgents()]);
    } catch (error) {
      const reason = reasonOf(error);
      if (reason) return remember(unavailable(reason));
      const code = error?.code ?? 'error';
      logOnce(`inventory:${code}:${error?.detail ?? ''}`, {
        event: 'cmux_inventory_error', code, detail: error?.detail ?? null, message: safeMessage(error),
      });
      return remember(lastGood ? { ...lastGood, stale: true } : unavailable('error'));
    }
    const live = new Set(listing.surfaces.map((surface) => `${surface.workspaceId}/${surface.id}`.toUpperCase()));
    const answer = {
      available: true,
      stale: false,
      refreshedAt: now().toISOString(),
      workspaces: listing.workspaces,
      surfaces: listing.surfaces,
      agents: agents.map((agent) => ({ ...agent, live: live.has(`${agent.workspaceId}/${agent.surfaceId}`.toUpperCase()) })),
    };
    lastGood = answer;
    return remember(answer);
  }

  function remember(answer) {
    last = answer;
    return answer;
  }

  async function doFocus(workspaceId, surfaceId) {
    const refused = (reason, detail = null) => {
      log({ event: 'cmux_focus', workspaceId, surfaceId, ok: false, reason, ...(detail ? { detail } : {}) });
      return { ok: false, reason };
    };
    const discovery = await discover();
    if (!discovery.ok) return refused(discovery.reason);
    try {
      const listed = await call(discovery, 'surface.list', { workspace_id: workspaceId });
      if (!listed.ok) return refused(listed.error.code === 'not_found' ? 'not_found' : 'error', listed.error.code);
      const present = parseSurfaces(listed.result, workspaceId).some((surface) => sameId(surface.id, surfaceId));
      if (!present) return refused('not_found', 'not_in_listing');
      const focused = await call(discovery, 'surface.focus', { surface_id: surfaceId, workspace_id: workspaceId });
      if (!focused.ok) return refused(focused.error.code === 'not_found' ? 'not_found' : 'error', focused.error.code);
      let verified = false;
      try {
        const identity = await call(discovery, 'system.identify', {});
        verified = identity.ok && sameId(identity.result?.focused?.surface_id, surfaceId);
      } catch {
        verified = false;
      }
      log({ event: 'cmux_focus', workspaceId, surfaceId, ok: true, verified });
      return { ok: true, verified };
    } catch (error) {
      return refused(reasonOf(error) ?? 'error', error?.code ?? 'error');
    }
  }

  return {
    inventory,
    refresh: inventory,
    current() {
      return last;
    },
    focus({ workspaceId, surfaceId } = {}) {
      if (!isUuid(workspaceId) || !isUuid(surfaceId)) return Promise.resolve({ ok: false, reason: 'error' });
      return doFocus(workspaceId, surfaceId);
    },
    close() {
      if (conn) fail(conn, new CmuxError('closed', 'client'));
    },
  };
}

function parseWorkspaces(result) {
  const items = isRecord(result) && Array.isArray(result.workspaces) ? result.workspaces : [];
  return items.filter((item) => isRecord(item) && isUuid(item.id)).map((item) => ({
    id: item.id,
    name: stringOrNull(item.title),
    cwd: stringOrNull(item.current_directory),
  }));
}

function parseSurfaces(result, workspaceId) {
  const items = isRecord(result) && Array.isArray(result.surfaces) ? result.surfaces : [];
  return items.filter((item) => isRecord(item) && isUuid(item.id)).map((item) => ({
    id: item.id,
    workspaceId,
    panelId: isUuid(item.pane_id) ? item.pane_id : null,
    title: stringOrNull(item.title),
    cwd: stringOrNull(item.requested_working_directory),
  }));
}

// A parsed agent record, or the reason it was skipped.
function parseSessionRecord(record) {
  if (!isRecord(record)) return 'not_an_object';
  if (typeof record.session_id !== 'string' || record.session_id === '') return 'no_session_id';
  if (!isUuid(record.workspace_id)) return 'no_workspace_id';
  if (!isUuid(record.surface_id)) return 'no_surface_id';
  return {
    sessionId: record.session_id,
    agent: stringOrNull(record.agent) ?? 'unknown',
    state: stringOrNull(record.agent_lifecycle) ?? 'unknown',
    cwd: stringOrNull(record.cwd),
    workspaceId: record.workspace_id,
    surfaceId: record.surface_id,
    startedAt: stringOrNull(record.started_at),
    updatedAt: stringOrNull(record.updated_at),
  };
}

export async function defaultSpawnSessionsList({ timeoutMs, run = execFile, signal, env = process.env } = {}) {
  const { stdout } = await runFile(run, 'cmux', ['sessions', 'list', '--json'], {
    timeout: timeoutMs,
    maxBuffer: SESSIONS_MAX_BUFFER,
    env: { ...env, CMUX_QUIET: '1' },
    signal,
  });
  return stdout;
}

function runFile(run, command, args, options) {
  return new Promise((resolve, reject) => {
    run(command, args, { ...options, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) {
        reject(new CmuxError('sessions_failed', error?.code ?? 'error', { cause: error }));
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

// The file's trimmed text, or null when it is missing, unreadable, empty,
// or larger than a path or password could be.
async function readTrimmed(file) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return null;
  }
  if (Buffer.byteLength(text) > FILE_MAX_BYTES) return null;
  const trimmed = text.trim();
  return trimmed === '' ? null : trimmed;
}

function connectError(error) {
  const code = error?.code ?? 'error';
  if (code === 'ENOENT' || code === 'ECONNREFUSED' || code === 'ENOTSOCK') return new CmuxError('not_running', code);
  return new CmuxError('connect_failed', code);
}

// Error text that is safe to log: our own codes, or a system error's code.
function safeMessage(error) {
  if (error instanceof CmuxError) return error.message;
  if (error instanceof SyntaxError) return 'invalid JSON';
  return error?.code ? String(error.code) : 'error';
}

function hash(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function sameId(a, b) {
  return typeof a === 'string' && typeof b === 'string' && a.toUpperCase() === b.toUpperCase();
}

function isUuid(value) {
  return typeof value === 'string' && UUID.test(value);
}

function stringOrNull(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
