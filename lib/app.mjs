// Request router and policy: Host/Origin checks, common headers, method
// handling, body limits, and the dashboard's own routes. Route bodies for
// Focus and the Daily Brief live in the injected `focus` and `brief` objects
// (see focus-proxy.mjs and brief-adapter.mjs for their contracts).
//
// createApp({ config, focus, brief, log }) returns a (req, res) handler and
// opens nothing; server.mjs owns listening.

import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';

import { ASSETS } from './assets.mjs';
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
const STATE_WORD = /^[a-z_]{1,40}$/;

const READ = ['GET', 'HEAD'];

// Exact-path routes. `methods` lists what is allowed; anything else is 405.
const EXACT_ROUTES = new Map([
  ['/', { name: 'shell', methods: READ }],
  ['/focus', { name: 'shell', methods: READ }],
  ['/brief', { name: 'shell', methods: READ }],
  ['/focus/', { name: 'slash-redirect', methods: READ }],
  ['/brief/', { name: 'slash-redirect', methods: READ }],
  ['/healthz', { name: 'healthz', methods: READ }],
  ['/api/status', { name: 'status', methods: ['GET'] }],
  ['/embedded/focus', { name: 'focus-page', methods: ['GET'] }],
  ['/api/focus', { name: 'focus-api', methods: ['GET', 'PUT'] }],
  ['/api/brief/latest', { name: 'brief-latest', methods: ['GET'] }],
  ['/api/brief/feedback', { name: 'brief-feedback', methods: ['POST'] }],
]);

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function defaultLog(entry) {
  process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), ...entry })}\n`);
}

export function createApp({ config, focus, brief, log = defaultLog }) {
  const allowedHosts = new Set(config.allowedHosts);
  const allowedOrigins = new Set(config.allowedOrigins);

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

  function checkMutation(req) {
    const origin = req.headers.origin;
    if (!origin || !allowedOrigins.has(origin) || new URL(origin).host !== req.headers.host.toLowerCase()) {
      throw new HttpError(403, 'forbidden_origin');
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
    const budget = config.timeouts.statusMs;
    const [focusStatus, briefStatus] = await Promise.all([
      bounded((signal) => focus.checkHealth({ signal }), budget).then(
        (result) => ({ available: result?.available === true }),
        () => ({ available: false }),
      ),
      bounded((signal) => brief.latestMetadata({ signal }), budget).then(
        summarizeBrief,
        () => ({ state: 'unavailable' }),
      ),
    ]);
    sendJson(res, 200, { focus: focusStatus, brief: briefStatus });
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

  return async function handle(req, res) {
    const started = process.hrtime.bigint();
    let label = 'unmatched';
    const elapsed = () => Math.round(Number(process.hrtime.bigint() - started) / 1e5) / 10;
    // One line per request: the status actually sent, or status 0 with an
    // event when the connection closed before a complete response went out.
    res.once('finish', () => {
      log({ method: req.method, route: label, status: res.statusCode, ms: elapsed() });
    });
    res.once('close', () => {
      if (!res.writableFinished) log({ method: req.method, route: label, status: 0, event: 'response_incomplete', ms: elapsed() });
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
      if (MUTATING.has(req.method)) checkMutation(req);

      await dispatch(req, res, route, search);
    } catch (error) {
      if (error instanceof HttpError) {
        sendError(res, error.status, error.code, { head: req.method === 'HEAD' });
      } else {
        log({ event: 'handler_error', route: label, error: error?.name ?? 'unknown' });
        sendError(res, 500, 'internal_error');
      }
    }
  };
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

function isCalendarDate(value) {
  const match = DATE.exec(value);
  if (!match) return false;
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

// Runs task(signal) and settles within `ms`, aborting the signal on timeout.
// A synchronous throw becomes a rejection.
function bounded(task, ms) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('timeout'));
    }, ms);
  });
  const work = Promise.resolve().then(() => task(controller.signal));
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

// Copies only non-content fields from brief metadata.
function summarizeBrief(metadata) {
  if (!metadata || typeof metadata.state !== 'string' || !STATE_WORD.test(metadata.state)) {
    return { state: 'unavailable' };
  }
  const summary = { state: metadata.state };
  if (typeof metadata.date === 'string' && isCalendarDate(metadata.date)) summary.date = metadata.date;
  if (typeof metadata.revision === 'string' && REVISION.test(metadata.revision)) summary.revision = metadata.revision;
  return summary;
}
