// Request router and policy: Host/Origin checks, common headers, method
// handling, body limits, and the dashboard's own routes. Route bodies for
// Focus and the Daily Brief live in the injected `focus` and `brief` objects
// (see focus-proxy.mjs and brief-adapter.mjs for their contracts); dashboard
// state comes from the injected `hub` (hub.mjs).
//
// createApp({ config, focus, brief, hub, log }) returns a (req, res) handler
// and opens nothing; server.mjs owns listening. The handler also carries
// closeStreams(), which ends every open event stream for shutdown.
//
// Event stream (GET /api/events), Server-Sent Events:
//   - On connect the hub's status is refreshed (bounded by
//     timeouts.statusMs), then `event: snapshot` carries the whole snapshot
//     with `id:` set to its revision.
//   - Each hub change is `event: delta` with `id: <revision>` and data
//     { revision, patch }. There is no replay and Last-Event-ID is ignored: a
//     client that sees a revision gap refetches GET /api/state.
//   - A comment line `: ping` every timeouts.heartbeatMs keeps proxies from
//     closing an idle stream.
//   - Backpressure: when a write returns false, later deltas and pings are
//     dropped until `drain`; if any delta was dropped, one `event: reload`
//     (data {}) follows so the client refetches the snapshot. At most one
//     delta is ever buffered beyond the socket.
//   - closeStreams() sends `event: bye` (data {}) and ends each stream; new
//     streams after that get 503 shutting_down.
//   - At most limits.eventStreams streams at once; the next gets 503
//     too_many_streams with Retry-After: 5.
//   - While any stream is open, one shared unref'd interval refreshes the
//     hub's status every timeouts.statusPollMs.
//   - A stream is logged once, when it closes, as event stream_closed.

import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';

import { ASSETS } from './assets.mjs';
import { isCalendarDate } from './hub.mjs';
import {
  HttpError,
  SHELL_CSP,
  applyCommonHeaders,
  declaredLengthExceeds,
  isJsonContentType,
  limitRequestBody,
  readJsonBody,
  redirect,
  sendBody,
  sendError,
  sendJson,
  setContentSecurityPolicy,
} from './http.mjs';

const SAFE_PATH = /^\/[A-Za-z0-9._~\-/]*$/;
const ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const REVISION = /^[0-9a-f]{64}$/;

const READ = ['GET', 'HEAD'];

// Exact-path routes. `methods` lists what is allowed; anything else is 405.
const EXACT_ROUTES = new Map([
  ['/', { name: 'shell', methods: READ }],
  ...['/focus', '/brief', '/routines', '/agents', '/goals'].flatMap((view) => [
    [view, { name: 'shell', methods: READ }],
    [`${view}/`, { name: 'slash-redirect', methods: READ }],
  ]),
  ['/healthz', { name: 'healthz', methods: READ }],
  // Kept for one release while the shell moves to /api/events.
  ['/api/dashboard/status', { name: 'status', methods: ['GET'] }],
  ['/api/state', { name: 'state', methods: ['GET'] }],
  ['/api/events', { name: 'events', methods: ['GET'] }],
  ['/api/routines/refresh', { name: 'routines-refresh', methods: ['POST'], bodyless: true }],
  ['/embedded/focus', { name: 'focus-page', methods: ['GET'] }],
  ['/api/focus', { name: 'focus-api', methods: ['GET', 'PUT'] }],
  // Focus's own status and scan controls, called by its page at these
  // absolute paths and forwarded to the same upstream path. The POSTs carry
  // no body, so they need Origin but not a JSON content type.
  ['/api/status', { name: 'focus-control', methods: ['GET'] }],
  ['/api/pause', { name: 'focus-control', methods: ['POST'], bodyless: true }],
  ['/api/resume', { name: 'focus-control', methods: ['POST'], bodyless: true }],
  ['/api/refresh', { name: 'focus-control', methods: ['POST'], bodyless: true }],
  ['/api/brief/latest', { name: 'brief-latest', methods: ['GET'] }],
  ['/api/brief/feedback', { name: 'brief-feedback', methods: ['POST'] }],
]);

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// Focus controls after which the routines view is refreshed.
const ROUTINE_CONTROLS = new Set(['/api/pause', '/api/resume']);

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-store',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
};

export function defaultLog(entry) {
  process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), ...entry })}\n`);
}

export function createApp({ config, focus, brief, hub, log = defaultLog }) {
  if (!hub) throw new TypeError('createApp requires a hub');
  const allowedHosts = new Set(config.allowedHosts);
  const allowedOrigins = new Set(config.allowedOrigins);
  const streams = new Set(); // one close() per open event stream
  const streamingResponses = new WeakSet();
  let statusPoll = null;
  let shuttingDown = false;

  function matchRoute(pathname) {
    const exact = EXACT_ROUTES.get(pathname);
    if (exact) return { ...exact, label: pathname };
    if (pathname.startsWith('/assets/')) {
      const name = pathname.slice('/assets/'.length);
      if (ASSET_NAME.test(name)) return { name: 'asset', methods: READ, label: '/assets/:name', params: { name } };
    }
    if (pathname.startsWith('/embedded/brief/')) {
      const date = pathname.slice('/embedded/brief/'.length);
      if (isCalendarDate(date)) {
        return { name: 'brief-page', methods: ['GET'], label: '/embedded/brief/:date', params: { date } };
      }
    }
    return null;
  }

  // Every mutation needs an exact allowed Origin. A route that takes a body
  // needs JSON; a bodyless route refuses any body instead.
  function checkMutation(req, route) {
    const origin = req.headers.origin;
    if (!origin || !allowedOrigins.has(origin) || new URL(origin).host !== req.headers.host.toLowerCase()) {
      throw new HttpError(403, 'forbidden_origin');
    }
    if (route.bodyless) {
      if (req.headers['transfer-encoding'] !== undefined) throw new HttpError(400, 'body_not_allowed');
      if (declaredLengthExceeds(req, 0)) throw new HttpError(413, 'payload_too_large');
      return;
    }
    if (!isJsonContentType(req.headers['content-type'])) {
      throw new HttpError(415, 'unsupported_media_type');
    }
  }

  async function serveShell(req, res) {
    const html = await readFile(path.join(config.publicDir, 'index.html'));
    setContentSecurityPolicy(res, SHELL_CSP);
    sendBody(res, 200, 'text/html; charset=utf-8', html, { head: req.method === 'HEAD' });
  }

  async function serveAsset(req, res, name) {
    const asset = Object.hasOwn(ASSETS, name) ? ASSETS[name] : null;
    if (!asset) throw new HttpError(404, 'not_found');
    const file = path.join(config.publicDir, asset.file);
    const stats = await lstat(file).catch(() => null);
    if (!stats || !stats.isFile()) throw new HttpError(404, 'not_found');
    sendBody(res, 200, asset.type, await readFile(file), { head: req.method === 'HEAD' });
  }

  async function serveStatus(res) {
    await hub.refreshStatus({ signal: closedSignal(res) });
    const { focus: focusStatus, brief: briefStatus } = hub.snapshot();
    sendJson(res, 200, { focus: focusStatus, brief: briefStatus });
  }

  // The shell mounts frames only from state it has just fetched, so the
  // state route checks Focus and the brief first, as the status route does.
  async function serveState(res) {
    await hub.refreshStatus({ signal: closedSignal(res) });
    sendJson(res, 200, hub.snapshot());
  }

  function updateStatusPoll() {
    if (streams.size > 0 && !statusPoll) {
      statusPoll = setInterval(() => hub.refreshStatus(), config.timeouts.statusPollMs);
      statusPoll.unref();
    } else if (streams.size === 0 && statusPoll) {
      clearInterval(statusPoll);
      statusPoll = null;
    }
  }

  async function serveEvents(req, res) {
    if (shuttingDown) {
      sendError(res, 503, 'shutting_down');
      return;
    }
    if (streams.size >= config.limits.eventStreams) {
      sendError(res, 503, 'too_many_streams', { headers: { 'Retry-After': '5' } });
      return;
    }
    streamingResponses.add(res);
    res.writeHead(200, SSE_HEADERS);
    res.flushHeaders();

    let open = true;
    let blocked = false; // a write returned false and drain has not come
    let dropped = false; // a delta was dropped while blocked
    let unsubscribe = () => {};
    const write = (text) => {
      if (!open || res.writableEnded || res.destroyed) return;
      if (!res.write(text)) blocked = true;
    };
    const onDrain = () => {
      blocked = false;
      if (dropped) {
        dropped = false;
        write('event: reload\ndata: {}\n\n');
      }
    };
    const heartbeat = setInterval(() => {
      if (!blocked) write(': ping\n\n');
    }, config.timeouts.heartbeatMs);
    heartbeat.unref();
    const close = ({ bye = false } = {}) => {
      if (!open) return;
      if (bye) write('event: bye\ndata: {}\n\n');
      open = false;
      clearInterval(heartbeat);
      unsubscribe();
      res.off('drain', onDrain);
      streams.delete(close);
      updateStatusPoll();
      if (bye && !res.writableEnded) res.end();
    };
    res.on('drain', onDrain);
    req.once('close', () => close());
    res.once('close', () => close());
    streams.add(close);
    updateStatusPoll();

    await hub.refreshStatus({ signal: closedSignal(res) });
    if (!open) return;
    const snapshot = hub.snapshot();
    write(`id: ${snapshot.revision}\nevent: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
    unsubscribe = hub.subscribe(({ revision, patch }) => {
      if (blocked) {
        dropped = true;
        return;
      }
      write(`id: ${revision}\nevent: delta\ndata: ${JSON.stringify({ revision, patch })}\n\n`);
    });
  }

  async function serveRoutinesRefresh(res) {
    await hub.refreshRoutines();
    sendJson(res, 200, { ok: true, revision: hub.snapshot().revision });
  }

  async function serveFocusControl(req, res, path) {
    await focus.handleControl(req, res, { path });
    if (ROUTINE_CONTROLS.has(path) && res.statusCode >= 200 && res.statusCode < 300) {
      hub.refreshRoutines(); // never rejects; failures land in the snapshot
    }
  }

  async function dispatch(req, res, route, search) {
    const head = req.method === 'HEAD';
    switch (route.name) {
      case 'shell':
        return serveShell(req, res);
      case 'slash-redirect':
        return redirect(res, route.label.slice(0, -1) + search);
      case 'healthz':
        return sendJson(res, 200, { ok: true }, { head });
      case 'status':
        return serveStatus(res);
      case 'state':
        return serveState(res);
      case 'events':
        return serveEvents(req, res);
      case 'routines-refresh':
        return serveRoutinesRefresh(res);
      case 'asset':
        return serveAsset(req, res, route.params.name);
      case 'focus-page':
        return focus.handlePage(req, res);
      case 'focus-api': {
        if (req.method === 'GET') return focus.handleApi(req, res, {});
        const limit = config.limits.focusBodyBytes;
        if (declaredLengthExceeds(req, limit)) throw new HttpError(413, 'payload_too_large');
        return focus.handleApi(req, res, { body: limitRequestBody(req, limit) });
      }
      case 'focus-control':
        return serveFocusControl(req, res, route.label);
      case 'brief-latest':
        return brief.handleLatest(req, res);
      case 'brief-page': {
        const revision = new URLSearchParams(search).get('revision');
        if (!revision || !REVISION.test(revision)) throw new HttpError(400, 'invalid_revision');
        return brief.handleEmbedded(req, res, { date: route.params.date, revision });
      }
      case 'brief-feedback': {
        const body = await readJsonBody(req, { limit: config.limits.feedbackBodyBytes });
        return brief.handleFeedback(req, res, body);
      }
      default:
        throw new HttpError(404, 'not_found');
    }
  }

  async function handle(req, res) {
    const started = process.hrtime.bigint();
    let label = 'unmatched';
    const elapsed = () => Math.round(Number(process.hrtime.bigint() - started) / 1e5) / 10;
    // One line per request: the status actually sent, or status 0 with an
    // event when the connection closed before a complete response went out.
    // An event stream is logged once, when it closes, whichever way it ends.
    res.once('finish', () => {
      if (streamingResponses.has(res)) return;
      log({ method: req.method, route: label, status: res.statusCode, ms: elapsed() });
    });
    res.once('close', () => {
      if (streamingResponses.has(res)) {
        log({ method: req.method, route: 'events', status: 200, event: 'stream_closed', ms: elapsed() });
      } else if (!res.writableFinished) {
        log({ method: req.method, route: label, status: 0, event: 'response_incomplete', ms: elapsed() });
      }
    });
    applyCommonHeaders(res);

    try {
      const host = typeof req.headers.host === 'string' ? req.headers.host.toLowerCase() : '';
      if (!allowedHosts.has(host)) throw new HttpError(421, 'misdirected_request');

      const url = req.url ?? '';
      const queryAt = url.indexOf('?');
      const pathname = queryAt === -1 ? url : url.slice(0, queryAt);
      const search = queryAt === -1 ? '' : url.slice(queryAt);
      if (!isSafePath(pathname)) throw new HttpError(400, 'bad_path');

      const route = matchRoute(pathname);
      if (!route) throw new HttpError(404, 'not_found');
      label = route.label;

      if (!route.methods.includes(req.method)) {
        sendError(res, 405, 'method_not_allowed', { headers: { Allow: route.methods.join(', ') } });
        return;
      }
      if (MUTATING.has(req.method)) checkMutation(req, route);

      await dispatch(req, res, route, search);
    } catch (error) {
      if (error instanceof HttpError) {
        sendError(res, error.status, error.code, { head: req.method === 'HEAD' });
      } else {
        log({ event: 'handler_error', route: label, error: error?.name ?? 'unknown' });
        sendError(res, 500, 'internal_error');
      }
    }
  }

  // Ends every open event stream with a final `bye` and refuses new ones.
  handle.closeStreams = () => {
    shuttingDown = true;
    for (const close of [...streams]) close({ bye: true });
  };
  return handle;
}

// An AbortSignal that aborts when `res` closes before it finished.
function closedSignal(res) {
  const controller = new AbortController();
  res.once('close', () => controller.abort());
  return controller.signal;
}

// Rejects anything but plain unencoded segments: no percent-encoding, no
// backslashes, no empty or dot segments. No route needs any of those.
function isSafePath(pathname) {
  if (!SAFE_PATH.test(pathname)) return false;
  if (pathname === '/') return true;
  const segments = pathname.slice(1).split('/');
  return segments.every((segment, i) =>
    segment !== '.' && segment !== '..' && (segment !== '' || i === segments.length - 1));
}
