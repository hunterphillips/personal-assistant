// Codex runtime adapter: follows the threads of one shared Codex app-server
// and answers their questions and approvals from the dashboard. It owns no
// threads. Hunter drives them from their terminals (bin/codex-new); the
// server is owned by bin/codex-serve, which writes the owner file this
// adapter watches. The contract, including the refusal rule, is in
// adapter.mjs; the wire protocol was verified on Codex 0.155.1 in
// thoughts/shared/research/2026-09-28-codex-app-server-spike.md.
//
// createCodexAdapter({ ownerFile, bound, log, timeouts, limits, connect, now })
// returns:
//
//   kind: 'codex'
//   status() -> { available: true } | { available: false, reason }
//     reason 'no_server' (no live owner file), 'disconnected' (a server is
//     known but this connection is down or not yet initialized), or
//     'ws_unavailable' (the ws package is not installed; run npm ci).
//   sessions() -> [{ id, threadId, cwd, title, state, pending, lastMessage,
//                    lastError, updatedAt }]
//     The threads followed right now, newest first. `id` is
//     'codex:<threadId>'; `title` is null until the first resume brings
//     the thread's name or preview. Empty while no server is known; after a
//     connection drops the rows stay with state 'unavailable' and lastError
//     'server_gone' until the next successful list on a new connection, or
//     until the owner file goes away.
//   answer(agent, requestId, answer) -> Promise<void>
//     question:   { answers: { <question id or text>: 'text' | ['a', 'b'] } };
//                 every question must be answered.
//     approval:   { decision: 'allow' | 'deny' }.
//     Sends the JSON-RPC response with the request's original id on the
//     current connection. Rejects 'no_such_request' when the request is not
//     held (unknown, already settled, or lost with the connection),
//     'not_supported' for a request only the terminal can express (`native`
//     on the request event), and 'invalid_answer' otherwise.
//   interrupt(agent) -> Promise<void>
//     Sends turn/interrupt for the running turn; a no-op with no turn.
//   thread(agent) -> Promise<{ messages }>
//     The user and assistant messages of the last THREAD_TURNS turns, read
//     through thread/turns/list, bounded, never cached to disk. Rejects
//     'invalid_agent' for an unknown session and 'unavailable' with no
//     connection.
//   send, start, newThread -> rejected 'not_supported' before any await:
//     Codex threads take messages in their own terminal.
//   state(agentId) -> { state, pending, lastError, sessionId, costUsd }
//   refresh() -> Promise<void>
//     One poll now (the owner file, then the catalogue while connected), or
//     the poll already in flight; resolves once it has run. Never rejects.
//   subscribe(fn) -> unsubscribe
//   close() -> Promise<void>
//     Stops the poll, closes the socket, and resolves within
//     timeouts.abortGraceMs. Pending requests are left on the server, where
//     the terminal or the next connection can still answer them.
//
// Owner file. Every timeouts.codexPollMs the adapter stats `ownerFile`
// ({ socket, pid, startedAt, codexVersion }, written by bin/codex-serve). A
// missing or unreadable file, or a pid that is no longer running, means no
// server: the connection is dropped and every row removed. A file that
// appears, or names a new socket or pid, starts a connection to it (the
// old one, if any, is closed first).
//
// Connection. ws over `ws+unix://<socket>:/` with perMessageDeflate off,
// loaded on first use so a checkout without `npm ci` still starts;
// `initialize` with capabilities.experimentalApi true, then `initialized`.
// Each request to the server has timeouts.codexRpcMs to be answered.
//
// Catalogue. The threads followed are the union of (a) the ids in
// `thread/loaded/list`, the threads the server holds in memory for any
// client, and (b) the newest limits.codexThreads ids `bound()` returns (the
// threads bin/codex-new recorded in bindings.json). Nothing else is ever
// resumed: `thread/list` covers every thread in the local store, including
// ones open in other app-servers, and resuming those fails with a
// thread-store conflict. The union is re-read on every poll while connected,
// so a thread started by codex-new or the TUI appears within a poll even if
// its `thread/started` broadcast was missed; a `thread/started` still
// adopts at once. Each followed thread is resumed with excludeTurns true,
// which subscribes this connection to it and replays any request it is
// waiting on, and its newest turn is read for the last message and the
// running turn id. A thread that leaves both sets is dropped. A resume that
// fails because the thread has no rollout yet, while the thread is in the
// loaded list (a fresh thread before its first turn), keeps the row and is
// retried on later polls with a doubling wait up to codexReconnectMaxMs,
// since the server pushes nothing for a thread this connection has not
// resumed; the same failure for a thread that is only bound means the
// thread does not exist here, and that, like any other resume failure (a
// timeout, an rpc error), drops the thread for the rest of this connection,
// logged once. The next connection tries every thread afresh, so a
// transient failure never loses a bound thread for the daemon's lifetime.
// Rows are capped at limits.codexThreads:
// past that, the oldest idle unbound thread with nothing pending is evicted
// and skipped until the next connection; busy, waiting, and bound threads
// are never evicted, so the cap can be exceeded by those alone.
//
// On close the rows go 'unavailable' with lastError 'server_gone', pending
// requests are forgotten (the server replays them on the next resume), and
// a reconnect is scheduled after timeouts.codexReconnectMs, doubling to
// codexReconnectMaxMs; the reconnect lists and resumes again. A frame over
// limits.codexFrameBytes is dropped with an error event and never parsed.
// Writes are never retried: a reply that does not reach the server is
// replayed by the server on the next resume.
//
// Events, each { type, agentId, at, ... } with agentId 'codex:<threadId>':
//   thread.state { state }   'idle' | 'busy' (a turn runs) | 'waiting' (a
//                            request is open) | 'error' (the last turn failed)
//                            | 'unavailable' (the connection dropped)
//   message      { role, text, truncated? }   the user's turn text and each
//                            completed assistant message, cut to
//                            limits.messageTextBytes
//   request      { requestId, kind, toolName, input, native }
//                            kind 'question' for item/tool/requestUserInput
//                            (toolName 'requestUserInput'); kind 'approval'
//                            for item/commandExecution/requestApproval,
//                            item/fileChange/requestApproval, and
//                            item/permissions/requestApproval (toolName is
//                            the item kind) and for any other server request
//                            on a followed thread (toolName is its method).
//                            input is the request's params. native is true
//                            when allow/deny cannot express it: a command
//                            approval whose availableDecisions lack 'accept',
//                            or a method this adapter does not know.
//   resolved     { requestId, outcome }   'answered' | 'allowed' | 'denied'
//                            from here, 'external' when another client
//                            answered (serverRequest/resolved)
//   usage        { usage, costUsd: null, denials: [] }   thread/tokenUsage/updated
//   error        { message }
// and with agentId 'codex' for the connection itself:
//   sessions     { threadId? }  the set of sessions or status() changed;
//                            threadId names a thread whose row was just
//                            resumed (its metadata and last message are in)
//   error        { message } the connection closed, or a frame was dropped
//
// Logs (none carries message text, question text, tool input, or a
// server's error message): codex_server_found, codex_server_gone,
// codex_owner_unreadable, codex_owner_invalid, codex_ws_unavailable,
// codex_connect_error, codex_socket_error, codex_connected,
// codex_initialize_error, codex_disconnected, codex_catalogue,
// codex_catalogue_evicted, codex_resume_error, codex_request,
// codex_request_ignored, codex_answer, codex_interrupt, codex_frame_dropped,
// codex_frame_invalid, codex_write_error, codex_bound_error,
// codex_poll_error, runtime_listener_error.
//
// Replies. Questions: { answers: { <questionId>: { answers: [text] } } }.
// Command and file-change approvals: { decision: 'accept' | 'decline' } and
// nothing broader (never acceptForSession, never a policy amendment).
// Permissions: allow repeats the requested `permissions` with scope 'turn';
// deny is { permissions: {}, scope: 'turn' }.

import { readFile, stat } from 'node:fs/promises';

import { LIMITS, TIMEOUTS } from '../config.mjs';
import { truncateUtf8 } from '../threads.mjs';
import { RuntimeError } from './adapter.mjs';

export const KIND = 'codex';
const ID_PREFIX = `${KIND}:`;
const THREAD_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const THREAD_TURNS = 20;
const LOADED_PAGE = 50;
const LOADED_MAX = 1_000;
const OWNER_MAX_BYTES = 4 * 1024;
const ERROR_TEXT_MAX = 500;
const TITLE_MAX_CHARS = 120;
const CLIENT_INFO = { name: 'personal-assistant-dashboard', version: '0.1.0' };

const QUESTION_METHOD = 'item/tool/requestUserInput';
const APPROVAL_METHODS = new Map([
  ['item/commandExecution/requestApproval', 'commandExecution'],
  ['item/fileChange/requestApproval', 'fileChange'],
  ['item/permissions/requestApproval', 'permissions'],
]);
const WAITING_FLAGS = new Set(['waitingOnApproval', 'waitingOnUserInput']);
// The resume error for a thread that exists in memory but has not been
// written to the thread store yet (no turn has run).
const NOT_PERSISTED = /no rollout found/i;

const NOT_SUPPORTED = 'Codex threads take messages in their own terminal, not from the dashboard.';
const NATIVE_ONLY = 'This request can only be answered in the thread\'s terminal.';
const CONNECTION_CLOSED = 'The connection to the Codex app-server closed.';
const SERVER_GONE = 'server_gone';

// Loads ws on first use so that a checkout without its dependencies still
// starts the dashboard; the adapter then reports ws_unavailable.
async function defaultConnect(socket) {
  let WebSocket;
  try {
    ({ default: WebSocket } = await import('ws'));
  } catch (error) {
    throw Object.assign(new Error('the ws package is not installed'), { code: 'ws_unavailable', cause: error });
  }
  return new WebSocket(`ws+unix://${socket}:/`, { perMessageDeflate: false });
}

export function createCodexAdapter({
  ownerFile, bound = () => [], log = () => {}, timeouts = TIMEOUTS, limits = LIMITS, connect = defaultConnect,
  now = () => new Date(),
}) {
  const pollMs = timeouts.codexPollMs ?? TIMEOUTS.codexPollMs;
  const reconnectMs = timeouts.codexReconnectMs ?? TIMEOUTS.codexReconnectMs;
  const reconnectMaxMs = timeouts.codexReconnectMaxMs ?? TIMEOUTS.codexReconnectMaxMs;
  const abortGraceMs = timeouts.abortGraceMs ?? TIMEOUTS.abortGraceMs;
  const rpcMs = timeouts.codexRpcMs ?? TIMEOUTS.codexRpcMs;
  const maxThreads = limits.codexThreads ?? LIMITS.codexThreads;
  const frameBytes = limits.codexFrameBytes ?? LIMITS.codexFrameBytes;
  const messageBytes = limits.messageTextBytes ?? LIMITS.messageTextBytes;
  const threadMessages = limits.threadCacheMessages ?? LIMITS.threadCacheMessages;

  const listeners = new Set();
  // threadId -> entry (see newEntry).
  const threads = new Map();
  // Threads whose resume failed on the current connection; not resumed
  // again until the next one.
  const failed = new Set();
  // Threads evicted over the cap; skipped until the next connection.
  let evicted = new Set();
  let owner = null; // { socket, pid, startedAt, codexVersion } while a live server is known
  let ownerSeen = null; // the owner file's last signature
  let conn = null; // the live connection (see attach)
  let opening = false; // a connect() is in flight
  let wsUnavailable = false;
  let backoff = reconnectMs;
  let reconnectTimer = null;
  let polling = null;
  let tickInFlight = null;
  let closing = false;

  function emit(type, agentId, fields = {}) {
    const event = { type, agentId, at: now().toISOString(), ...fields };
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch (error) {
        log({ event: 'runtime_listener_error', error: error?.message ?? String(error) });
      }
    }
  }

  function status() {
    if (conn?.ready) return { available: true };
    if (wsUnavailable) return { available: false, reason: 'ws_unavailable' };
    if (!owner) return { available: false, reason: 'no_server' };
    return { available: false, reason: 'disconnected' };
  }

  // ---- poll -----------------------------------------------------------------

  // One poll: the owner file, then the catalogue while connected. Never two
  // at once; a slow one is skipped over by the interval.
  async function tick() {
    if (closing) return;
    await pollOwner();
    if (closing || !conn?.ready) return;
    await refresh(conn);
  }

  async function pollOwner() {
    let seen;
    try {
      const stats = await stat(ownerFile);
      seen = { mtimeMs: stats.mtimeMs, size: stats.size };
    } catch {
      seen = { missing: true };
    }
    if (closing) return;
    const changed = !sameSignature(ownerSeen, seen);
    ownerSeen = seen;
    let next = owner;
    if (changed) next = seen.missing ? null : await readOwner();
    if (closing) return;
    if (next && !processAlive(next.pid)) next = null;
    if (next && owner && next.socket === owner.socket && next.pid === owner.pid) return;
    if (!next && !owner) return;
    if (owner) {
      log({ event: 'codex_server_gone', socket: owner.socket, pid: owner.pid });
      owner = null;
      await dropConnection();
      if (closing) return;
      clearRows();
    }
    if (next) {
      owner = next;
      log({ event: 'codex_server_found', socket: owner.socket, pid: owner.pid, codexVersion: owner.codexVersion });
      backoff = reconnectMs;
      emit('sessions', KIND);
      openConnection();
    }
  }

  async function readOwner() {
    let raw;
    try {
      raw = await readFile(ownerFile, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') log({ event: 'codex_owner_unreadable', error: error?.code ?? 'unknown' });
      return null;
    }
    if (Buffer.byteLength(raw, 'utf8') > OWNER_MAX_BYTES) {
      log({ event: 'codex_owner_invalid', reason: 'oversized' });
      return null;
    }
    let value;
    try {
      value = JSON.parse(raw);
    } catch {
      log({ event: 'codex_owner_invalid', reason: 'json' });
      return null;
    }
    if (!isRecord(value) || typeof value.socket !== 'string' || !value.socket.startsWith('/') ||
        !Number.isInteger(value.pid) || value.pid <= 0) {
      log({ event: 'codex_owner_invalid', reason: 'shape' });
      return null;
    }
    return {
      socket: value.socket,
      pid: value.pid,
      startedAt: typeof value.startedAt === 'string' ? value.startedAt : null,
      codexVersion: typeof value.codexVersion === 'string' ? value.codexVersion : null,
    };
  }

  // Forgets every row: the server is gone, so nothing is followed.
  function clearRows() {
    threads.clear();
    evicted = new Set();
    emit('sessions', KIND);
  }

  // ---- connection -----------------------------------------------------------

  function openConnection() {
    if (closing || !owner || conn || opening || wsUnavailable) return;
    opening = true;
    const socket = owner.socket;
    Promise.resolve().then(() => connect(socket)).then((ws) => {
      opening = false;
      if (closing || !owner || owner.socket !== socket || conn) {
        ws.terminate?.();
        return;
      }
      attach(ws, socket);
    }, (error) => {
      opening = false;
      if (closing) return;
      if (error?.code === 'ws_unavailable') {
        wsUnavailable = true;
        log({ event: 'codex_ws_unavailable' });
        emit('sessions', KIND);
        return;
      }
      log({ event: 'codex_connect_error', error: error?.code ?? 'unknown' });
      scheduleReconnect();
    });
  }

  function attach(ws, socket) {
    const c = { ws, socket, nextId: 1, calls: new Map(), ready: false, closed: null, refreshing: null, loaded: new Set() };
    c.closed = new Promise((resolve) => ws.once('close', resolve));
    conn = c;
    failed.clear();
    ws.on('open', () => initialize(c));
    ws.on('message', (data) => onMessage(c, data));
    ws.on('error', (error) => {
      if (conn === c) log({ event: 'codex_socket_error', error: error?.code ?? 'unknown' });
    });
    ws.once('close', () => onClose(c));
  }

  async function initialize(c) {
    try {
      await request(c, 'initialize', { clientInfo: CLIENT_INFO, capabilities: { experimentalApi: true } });
      if (conn !== c) return;
      write(c, { jsonrpc: '2.0', method: 'initialized', params: {} });
      c.ready = true;
      backoff = reconnectMs;
      log({ event: 'codex_connected', socket: c.socket, codexVersion: owner?.codexVersion ?? null });
      emit('sessions', KIND);
      await refresh(c);
    } catch (error) {
      if (conn !== c) return;
      log({ event: 'codex_initialize_error', error: codeOf(error) });
      c.ws.close();
    }
  }

  function onClose(c) {
    if (conn !== c) return;
    conn = null;
    for (const call of c.calls.values()) {
      clearTimeout(call.timer);
      call.reject(withCode(new Error('connection closed'), 'connection_closed'));
    }
    c.calls.clear();
    const wasReady = c.ready;
    evicted = new Set();
    for (const entry of threads.values()) {
      entry.state = 'unavailable';
      entry.lastError = SERVER_GONE;
      entry.pending.clear();
      entry.turnId = null;
      entry.resumed = false;
      entry.resumeAttempts = 0;
      entry.resumeAt = 0;
    }
    if (closing) return;
    emit('sessions', KIND);
    if (wasReady) {
      log({ event: 'codex_disconnected', socket: c.socket });
      emit('error', KIND, { message: CONNECTION_CLOSED });
    }
    if (owner) scheduleReconnect();
  }

  function scheduleReconnect() {
    if (closing || reconnectTimer) return;
    const wait = backoff;
    backoff = Math.min(backoff * 2, reconnectMaxMs);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (!owner || conn || closing) return;
      if (!processAlive(owner.pid)) return; // the poll will report it gone
      openConnection();
    }, wait);
    reconnectTimer.unref?.();
  }

  // Closes the live connection, if any, and resolves once its socket has
  // closed or abortGraceMs has passed.
  async function dropConnection() {
    const c = conn;
    if (!c) return;
    c.ws.close();
    await within(c.closed, abortGraceMs);
    if (conn === c) c.ws.terminate();
    await within(c.closed, abortGraceMs);
  }

  // Rejects with an Error whose `code` is 'timeout', 'rpc_error' (the
  // server's message is on `detail`, bounded), or 'connection_closed'.
  function request(c, method, params, timeoutMs = rpcMs) {
    return new Promise((resolve, reject) => {
      const id = c.nextId;
      c.nextId += 1;
      const timer = setTimeout(() => {
        c.calls.delete(id);
        reject(withCode(new Error(`${method} timed out`), 'timeout'));
      }, timeoutMs);
      timer.unref?.();
      c.calls.set(id, { resolve, reject, timer, method });
      write(c, { jsonrpc: '2.0', id, method, params });
    });
  }

  // One attempt; a failed write is logged and never retried.
  function write(c, message) {
    c.ws.send(JSON.stringify(message), (error) => {
      if (error) log({ event: 'codex_write_error', method: message.method ?? 'reply', error: error?.code ?? 'unknown' });
    });
  }

  function onMessage(c, data) {
    if (conn !== c) return;
    const size = frameSize(data);
    if (size > frameBytes) {
      log({ event: 'codex_frame_dropped', bytes: size });
      emit('error', KIND, { message: `Dropped a ${size}-byte frame from the Codex app-server; the limit is ${frameBytes} bytes.` });
      return;
    }
    let message;
    try {
      message = JSON.parse(data.toString('utf8'));
    } catch {
      log({ event: 'codex_frame_invalid' });
      return;
    }
    if (!isRecord(message)) return;
    if (message.id !== undefined && typeof message.method === 'string') {
      onServerRequest(c, message);
    } else if (message.id !== undefined) {
      const call = c.calls.get(message.id);
      if (!call) return;
      c.calls.delete(message.id);
      clearTimeout(call.timer);
      if (message.error) {
        const detail = clip(isRecord(message.error) && message.error.message != null ? message.error.message : 'error');
        call.reject(Object.assign(new Error(`${call.method} failed: ${detail}`), { code: 'rpc_error', detail }));
      } else {
        call.resolve(message.result);
      }
    } else if (typeof message.method === 'string') {
      onNotification(c, message.method, isRecord(message.params) ? message.params : {});
    }
  }

  // ---- catalogue ----------------------------------------------------------

  // Re-reads the union of loaded and bound threads on `c`, adopts the new
  // ones, drops the ones in neither set, resumes what is due, and enforces
  // the cap. One at a time per connection.
  function refresh(c) {
    if (c.refreshing) return c.refreshing;
    c.refreshing = refreshNow(c).finally(() => {
      c.refreshing = null;
    });
    return c.refreshing;
  }

  async function refreshNow(c) {
    const listedAt = Date.now();
    const loaded = await listLoaded(c);
    if (conn !== c) return;
    c.loaded = loaded;
    const boundIds = boundThreads();
    const wanted = new Set([...boundIds, ...loaded]);
    let added = 0;
    let dropped = 0;
    for (const id of wanted) {
      if (failed.has(id)) continue;
      if (evicted.has(id)) {
        if (!boundIds.has(id)) continue;
        evicted.delete(id);
      }
      if (!threads.has(id)) {
        threads.set(id, newEntry(id, now()));
        added += 1;
      }
    }
    for (const entry of [...threads.values()]) {
      // A thread adopted from thread/started after the list was asked for
      // is not in this answer yet.
      if (!wanted.has(entry.threadId) && entry.adoptedAtMs <= listedAt) {
        threads.delete(entry.threadId);
        dropped += 1;
      }
    }
    if (added > 0 || dropped > 0) {
      log({ event: 'codex_catalogue', threads: threads.size, added, dropped });
      emit('sessions', KIND);
    }
    const due = [...threads.values()].filter((entry) => !entry.resumed && entry.resumeAt <= Date.now());
    if (due.length === 0) return;
    await Promise.all(due.map((entry) => follow(c, entry)));
    if (conn === c) enforceCap();
  }

  async function listLoaded(c) {
    const ids = new Set();
    let cursor = null;
    do {
      const page = await request(c, 'thread/loaded/list', { limit: LOADED_PAGE, ...(cursor ? { cursor } : {}) });
      if (conn !== c) return ids;
      for (const id of Array.isArray(page?.data) ? page.data : []) {
        if (typeof id === 'string' && THREAD_ID.test(id)) ids.add(id);
      }
      cursor = typeof page?.nextCursor === 'string' && page.nextCursor !== '' ? page.nextCursor : null;
    } while (cursor && ids.size < LOADED_MAX);
    return ids;
  }

  // The newest maxThreads bound thread ids, in the order `bound()` gives them.
  function boundThreads() {
    const ids = new Set();
    try {
      for (const id of bound()) {
        if (typeof id !== 'string' || !THREAD_ID.test(id)) continue;
        ids.add(id);
        if (ids.size >= maxThreads) break;
      }
    } catch (error) {
      log({ event: 'codex_bound_error', error: error?.code ?? 'unknown' });
    }
    return ids;
  }

  // Resumes the thread on this connection, which subscribes to it and replays
  // any request it is waiting on, then reads its newest turn.
  async function follow(c, entry) {
    try {
      const result = await request(c, 'thread/resume', { threadId: entry.threadId, excludeTurns: true });
      if (conn !== c || threads.get(entry.threadId) !== entry) return;
      entry.resumed = true;
      entry.resumeAttempts = 0;
      entry.lastError = null;
      applyThread(entry, isRecord(result?.thread) ? result.thread : {});
      await readNewestTurn(c, entry);
      if (conn !== c || threads.get(entry.threadId) !== entry) return;
      emit('sessions', KIND, { threadId: entry.threadId });
    } catch (error) {
      if (conn !== c || threads.get(entry.threadId) !== entry) return;
      const code = codeOf(error);
      const reason = code === 'rpc_error' && NOT_PERSISTED.test(error.detail ?? '') ? 'not_persisted' : code;
      if (reason === 'not_persisted' && c.loaded.has(entry.threadId)) {
        entry.resumeAttempts += 1;
        entry.resumeAt = Date.now() + Math.min(pollMs * 2 ** entry.resumeAttempts, reconnectMaxMs);
        if (entry.resumeAttempts === 1) log({ event: 'codex_resume_error', threadId: entry.threadId, error: reason, retry: true });
        return;
      }
      // Not again on this connection; the next one starts over.
      failed.add(entry.threadId);
      threads.delete(entry.threadId);
      log({ event: 'codex_resume_error', threadId: entry.threadId, error: reason, retry: false });
      emit('sessions', KIND);
    }
  }

  async function readNewestTurn(c, entry) {
    const page = await request(c, 'thread/turns/list', {
      threadId: entry.threadId, limit: 1, sortDirection: 'desc', itemsView: 'summary',
    });
    if (conn !== c || threads.get(entry.threadId) !== entry) return;
    const turn = Array.isArray(page?.data) ? page.data[0] : null;
    if (!isRecord(turn)) return;
    if (turn.status === 'inProgress' && typeof turn.id === 'string') entry.turnId = turn.id;
    const items = Array.isArray(turn.items) ? turn.items : [];
    for (const item of items) {
      const message = messageOf(item, turn);
      if (message) entry.lastMessage = message;
    }
  }

  // Keeps the rows at maxThreads by evicting the oldest idle, unbound
  // threads with nothing pending; the rest are kept even over the cap.
  function enforceCap() {
    if (threads.size <= maxThreads) return;
    const boundIds = boundThreads();
    const candidates = [...threads.values()]
      .filter((entry) => (entry.state === 'idle' || entry.state === 'unavailable') &&
        entry.pending.size === 0 && !entry.turnId && !boundIds.has(entry.threadId))
      .sort((a, b) => (a.updatedAt ?? a.adoptedAt).localeCompare(b.updatedAt ?? b.adoptedAt));
    let count = 0;
    while (threads.size > maxThreads && candidates.length > 0) {
      const entry = candidates.shift();
      threads.delete(entry.threadId);
      evicted.add(entry.threadId);
      count += 1;
    }
    if (count > 0) {
      log({ event: 'codex_catalogue_evicted', threads: count });
      emit('sessions', KIND);
    }
  }

  function applyThread(entry, thread, { quiet = false } = {}) {
    const cwd = typeof thread.cwd === 'string' ? thread.cwd : thread.environments?.[0]?.cwd;
    if (typeof cwd === 'string') entry.cwd = cwd;
    entry.title = titleOf(thread) ?? entry.title;
    if (typeof thread.updatedAt === 'number') entry.updatedAt = isoOf(thread.updatedAt);
    const state = stateOf(thread.status);
    if (quiet) entry.state = state;
    else setState(entry, state);
  }

  function drop(entry) {
    if (threads.get(entry.threadId) !== entry) return;
    threads.delete(entry.threadId);
    emit('sessions', KIND);
  }

  function setState(entry, state) {
    if (entry.state === state) return;
    entry.state = state;
    emit('thread.state', entry.agentId, { state });
  }

  // `message` comes from messageOf(), already bounded.
  function record(entry, message) {
    entry.lastMessage = message;
    entry.updatedAt = message.at;
    emit('message', entry.agentId, message);
  }

  // ---- notifications ------------------------------------------------------

  function onNotification(c, method, params) {
    const entry = typeof params.threadId === 'string' ? threads.get(params.threadId) : null;
    switch (method) {
      case 'thread/started': {
        const thread = params.thread;
        if (!isRecord(thread) || typeof thread.id !== 'string' || !THREAD_ID.test(thread.id)) return;
        if (threads.has(thread.id) || failed.has(thread.id)) return;
        const started = newEntry(thread.id, now());
        threads.set(thread.id, started);
        c.loaded.add(thread.id);
        applyThread(started, thread, { quiet: true });
        emit('sessions', KIND);
        follow(c, started).then(() => {
          if (conn === c) enforceCap();
        });
        return;
      }
      case 'thread/status/changed':
        if (entry) setState(entry, stateOf(params.status));
        return;
      case 'turn/started':
        if (!entry) return;
        entry.turnId = typeof params.turn?.id === 'string' ? params.turn.id : null;
        entry.lastError = null;
        entry.updatedAt = now().toISOString();
        if (entry.state === 'idle' || entry.state === 'error') setState(entry, 'busy');
        return;
      case 'turn/completed': {
        if (!entry) return;
        entry.turnId = null;
        entry.updatedAt = now().toISOString();
        const turn = isRecord(params.turn) ? params.turn : {};
        if (turn.status === 'failed') {
          entry.lastError = clip(turn.error?.message ?? 'The turn failed.');
          emit('error', entry.agentId, { message: entry.lastError });
          setState(entry, 'error');
        } else {
          setState(entry, 'idle');
        }
        return;
      }
      case 'item/completed': {
        if (!entry || !isRecord(params.item)) return;
        const message = messageOf(params.item, null);
        if (message) record(entry, message);
        return;
      }
      case 'error':
        if (!entry) return;
        entry.lastError = clip(params.error?.message ?? 'The turn failed.');
        emit('error', entry.agentId, { message: entry.lastError });
        return;
      case 'thread/tokenUsage/updated':
        if (entry) emit('usage', entry.agentId, { usage: isRecord(params.tokenUsage) ? params.tokenUsage : null, costUsd: null, denials: [] });
        return;
      case 'serverRequest/resolved': {
        if (!entry || params.requestId === undefined) return;
        const requestId = String(params.requestId);
        if (!entry.pending.has(requestId)) return;
        entry.pending.delete(requestId);
        emit('resolved', entry.agentId, { requestId, outcome: 'external' });
        return;
      }
      case 'thread/archived':
      case 'thread/deleted':
        if (entry) drop(entry);
        return;
      case 'thread/closed':
        if (!entry) return;
        entry.turnId = null;
        setState(entry, 'idle');
        return;
      default:
    }
  }

  // ---- server requests ----------------------------------------------------

  function onServerRequest(c, message) {
    const { id, method } = message;
    const params = isRecord(message.params) ? message.params : {};
    const entry = typeof params.threadId === 'string' ? threads.get(params.threadId) : null;
    if (!entry) {
      log({ event: 'codex_request_ignored', method });
      return;
    }
    const requestId = String(id);
    if (entry.pending.has(requestId)) return;
    let kind = 'approval';
    let toolName = method;
    let native = true;
    if (method === QUESTION_METHOD) {
      kind = 'question';
      toolName = 'requestUserInput';
      native = false;
    } else if (APPROVAL_METHODS.has(method)) {
      toolName = APPROVAL_METHODS.get(method);
      native = toolName === 'commandExecution' &&
        Array.isArray(params.availableDecisions) && !params.availableDecisions.includes('accept');
    }
    const request = { requestId, kind, toolName, input: params, at: now().toISOString(), native };
    entry.pending.set(requestId, { request, original: id, method, toolName });
    log({ event: 'codex_request', threadId: entry.threadId, method, native });
    emit('request', entry.agentId, { requestId, kind, toolName, input: params, native });
    setState(entry, 'waiting');
  }

  function replyFor(pending, answer) {
    if (!isRecord(answer)) throw new RuntimeError('invalid_answer');
    const { request, toolName } = pending;
    if (request.kind === 'question') {
      if (!isRecord(answer.answers) || 'decision' in answer) throw new RuntimeError('invalid_answer');
      return { outcome: 'answered', result: { answers: questionAnswers(request.input, answer.answers) } };
    }
    if ('answers' in answer || (answer.decision !== 'allow' && answer.decision !== 'deny')) {
      throw new RuntimeError('invalid_answer');
    }
    const allow = answer.decision === 'allow';
    const outcome = allow ? 'allowed' : 'denied';
    if (toolName === 'permissions') {
      const permissions = allow && isRecord(request.input.permissions) ? request.input.permissions : {};
      return { outcome, result: { permissions, scope: 'turn' } };
    }
    return { outcome, result: { decision: allow ? 'accept' : 'decline' } };
  }

  async function readThread(c, entry) {
    const page = await request(c, 'thread/turns/list', {
      threadId: entry.threadId, limit: THREAD_TURNS, sortDirection: 'desc', itemsView: 'full',
    });
    const turns = (Array.isArray(page?.data) ? page.data : []).filter(isRecord).reverse();
    const messages = [];
    for (const turn of turns) {
      for (const item of Array.isArray(turn.items) ? turn.items : []) {
        const message = messageOf(item, turn);
        if (message) messages.push(message);
      }
    }
    return { messages: messages.slice(-threadMessages) };
  }

  function messageOf(item, turn) {
    if (!isRecord(item)) return null;
    let role;
    let text;
    if (item.type === 'userMessage') {
      role = 'user';
      text = (Array.isArray(item.content) ? item.content : [])
        .filter((part) => isRecord(part) && part.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text)
        .join('\n');
    } else if (item.type === 'agentMessage') {
      role = 'assistant';
      text = typeof item.text === 'string' ? item.text : '';
    } else {
      return null;
    }
    if (text.trim() === '') return null;
    const bounded = truncateUtf8(text, messageBytes);
    const seconds = role === 'user' ? turn?.startedAt : turn?.completedAt ?? turn?.startedAt;
    const at = typeof seconds === 'number' ? isoOf(seconds) : now().toISOString();
    return { role, text: bounded.text, at, ...(bounded.truncated ? { truncated: true } : {}) };
  }

  function entryOf(agent) {
    const id = typeof agent === 'string' ? agent : agent?.id;
    if (typeof id !== 'string' || !id.startsWith(ID_PREFIX)) return null;
    return threads.get(id.slice(ID_PREFIX.length)) ?? null;
  }

  function runTick() {
    if (tickInFlight) return;
    tickInFlight = tick().catch((error) => {
      log({ event: 'codex_poll_error', error: codeOf(error) });
    }).finally(() => {
      tickInFlight = null;
    });
  }

  polling = setInterval(runTick, pollMs);
  polling.unref?.();
  runTick();

  return {
    kind: KIND,

    status,

    refresh() {
      runTick();
      return tickInFlight ?? Promise.resolve();
    },

    sessions() {
      return [...threads.values()]
        .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
        .map((entry) => ({
          id: entry.agentId,
          threadId: entry.threadId,
          cwd: entry.cwd,
          title: entry.title,
          state: entry.state,
          pending: oldestRequest(entry),
          lastMessage: entry.lastMessage ? { ...entry.lastMessage } : null,
          lastError: entry.lastError,
          updatedAt: entry.updatedAt,
        }));
    },

    start() {
      return Promise.reject(new RuntimeError('not_supported', { message: NOT_SUPPORTED }));
    },

    send() {
      return Promise.reject(new RuntimeError('not_supported', { message: NOT_SUPPORTED }));
    },

    newThread() {
      return Promise.reject(new RuntimeError('not_supported', { message: NOT_SUPPORTED }));
    },

    async answer(agent, requestId, answer) {
      const entry = entryOf(agent);
      const pending = entry?.pending.get(requestId);
      if (!pending || !conn?.ready) throw new RuntimeError('no_such_request');
      if (pending.request.native) throw new RuntimeError('not_supported', { message: NATIVE_ONLY });
      const { outcome, result } = replyFor(pending, answer);
      entry.pending.delete(requestId);
      write(conn, { jsonrpc: '2.0', id: pending.original, result });
      log({ event: 'codex_answer', threadId: entry.threadId, method: pending.method, outcome });
      emit('resolved', entry.agentId, { requestId, outcome });
      if (entry.pending.size === 0 && entry.state === 'waiting') setState(entry, 'busy');
    },

    interrupt(agent) {
      const entry = entryOf(agent);
      if (!entry || !entry.turnId || !conn?.ready) return Promise.resolve();
      log({ event: 'codex_interrupt', threadId: entry.threadId });
      return request(conn, 'turn/interrupt', { threadId: entry.threadId, turnId: entry.turnId }).then(() => {});
    },

    thread(agent) {
      const entry = entryOf(agent);
      if (!entry) return Promise.reject(new RuntimeError('invalid_agent'));
      if (!conn?.ready) return Promise.reject(new RuntimeError('unavailable'));
      return readThread(conn, entry);
    },

    state(agentId) {
      const entry = entryOf(agentId);
      if (!entry) return { state: 'idle', pending: null, lastError: null, sessionId: null, costUsd: null };
      return { state: entry.state, pending: oldestRequest(entry), lastError: entry.lastError, sessionId: entry.threadId, costUsd: null };
    },

    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    async close() {
      closing = true;
      clearInterval(polling);
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
      await dropConnection();
      threads.clear();
    },
  };

  function oldestRequest(entry) {
    const first = entry.pending.values().next().value;
    return first ? { ...first.request } : null;
  }
}

// Maps the answers the dashboard posts (keyed by question id or question
// text) to Codex's { <id>: { answers: [...] } }; every question must be
// answered with a non-empty string or a list of them.
function questionAnswers(input, given) {
  const questions = (Array.isArray(input?.questions) ? input.questions : []).filter((q) => isRecord(q) && typeof q.id === 'string');
  const byKey = new Map();
  for (const question of questions) {
    byKey.set(question.id, question.id);
    if (typeof question.question === 'string') byKey.set(question.question, question.id);
  }
  const answers = {};
  for (const [key, value] of Object.entries(given)) {
    const id = byKey.get(key);
    if (id === undefined || answers[id]) throw new RuntimeError('invalid_answer');
    let list;
    if (typeof value === 'string' && value.trim() !== '') list = [value];
    else if (Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === 'string' && item.trim() !== '')) list = value;
    else throw new RuntimeError('invalid_answer');
    answers[id] = { answers: list };
  }
  if (questions.length === 0 || questions.some((question) => !answers[question.id])) throw new RuntimeError('invalid_answer');
  return answers;
}

function newEntry(threadId, adopted) {
  return {
    threadId,
    agentId: `${ID_PREFIX}${threadId}`,
    cwd: null,
    title: null,
    state: 'idle',
    turnId: null,
    pending: new Map(),
    lastMessage: null,
    lastError: null,
    updatedAt: null,
    adoptedAt: adopted.toISOString(),
    adoptedAtMs: Date.now(),
    resumed: false,
    resumeAttempts: 0,
    resumeAt: 0,
  };
}

function stateOf(status) {
  if (!isRecord(status)) return 'idle';
  if (status.type === 'active') {
    const flags = Array.isArray(status.activeFlags) ? status.activeFlags : [];
    return flags.some((flag) => WAITING_FLAGS.has(flag)) ? 'waiting' : 'busy';
  }
  if (status.type === 'systemError') return 'error';
  return 'idle';
}

function titleOf(thread) {
  const source = typeof thread.name === 'string' && thread.name.trim() !== '' ? thread.name
    : typeof thread.preview === 'string' ? thread.preview : '';
  const line = source.split('\n').map((part) => part.trim()).find((part) => part !== '');
  if (!line) return null;
  const chars = Array.from(line);
  return chars.length > TITLE_MAX_CHARS ? `${chars.slice(0, TITLE_MAX_CHARS).join('')}…` : line;
}

function frameSize(data) {
  if (Buffer.isBuffer(data)) return data.length;
  if (Array.isArray(data)) return data.reduce((sum, part) => sum + part.length, 0);
  if (data instanceof ArrayBuffer) return data.byteLength;
  return Buffer.byteLength(String(data), 'utf8');
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function sameSignature(a, b) {
  if (!a || !b) return false;
  if (a.missing || b.missing) return Boolean(a.missing) === Boolean(b.missing);
  return a.mtimeMs === b.mtimeMs && a.size === b.size;
}

function isoOf(seconds) {
  return new Date(seconds * 1000).toISOString();
}

async function within(promise, ms) {
  let timer;
  try {
    await Promise.race([promise, new Promise((resolve) => { timer = setTimeout(resolve, ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

function withCode(error, code) {
  error.code = code;
  return error;
}

function codeOf(error) {
  return typeof error?.code === 'string' && error.code !== '' ? error.code : 'unknown';
}

function clip(text) {
  return truncateUtf8(String(text), ERROR_TEXT_MAX).text;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
