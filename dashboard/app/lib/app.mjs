// Request router and policy: Host/Origin checks, common headers, method
// handling, body limits, request logging, and the dashboard's own routes
// (shell, assets, health, status and state, jobs refresh: the launchd
// jobs the Health view lists, jobs.mjs).
// Route bodies for Focus and the Daily Brief live in the injected `focus`
// and `brief` objects (see focus-proxy.mjs and brief-adapter.mjs for their
// contracts); dashboard state comes from the injected `hub` (hub.mjs). The persona
// routes are agent-routes.mjs, the Goals routes goals-routes.mjs over the
// injected `goals` (goals.mjs), the feed routes feed-routes.mjs over the
// injected `feeds` (feeds.mjs) and `sources` (sources.mjs), the source
// routes source-routes.mjs over `sources`, the Ideas routes ideas-routes.mjs over `ideas` and `ideasInstructions`,
// the brief instructions routes brief-instructions.mjs over the injected
// `briefInstructions` (the same module's reader), the routine routes routine-routes.mjs over the injected `routines` store
// (routines.mjs) and `scheduler` (scheduler.mjs), the notification routes
// notification-routes.mjs over the injected `notifications` store
// (notifications.mjs), and the event stream is
// events.mjs; this module builds them and dispatches to them. Without
// `goals`, /api/goals and /api/goals/propose answer 404 not_found; without
// `feeds` or `sources`, /api/feeds, /api/sources, and the routes under them do; without
// `ideas` or `ideasInstructions`, /api/ideas and the routes under it do;
// without `briefInstructions` the two under /api/brief/instructions do, and
// without `routines` so does everything under /api/routines, and without
// `notifications` everything under /api/notifications.
//
// createApp({ config, focus, brief, hub, store, cmux, goals, feeds, sources, ideas, ideasInstructions,
//             briefInstructions, notices,
//             settings, registry, routines, scheduler, notifications, log })
// returns a (req, res) handler and opens nothing; server.mjs owns listening.
// `notices` (notices.mjs, optional) is handed to the event stream, which
// reconciles the brief notice on each connect and runs its timer while a
// stream is open. The handler also carries closeStreams(), which ends every
// open event stream for shutdown and makes later persona sends, goal
// proposals, new threads, sessions refreshes, and event streams answer 503
// shutting_down, and openStreams(), the count of open event streams.

import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';

import { createAgentRoutes } from './agent-routes.mjs';
import { ASSETS } from './assets.mjs';
import { createBriefInstructionsRoutes } from './brief-instructions.mjs';
import { createEvents } from './events.mjs';
import { createFeedRoutes } from './feed-routes.mjs';
import { createSourceRoutes } from './source-routes.mjs';
import { createGoalsRoutes } from './goals-routes.mjs';
import { createIdeasRoutes } from './ideas-routes.mjs';
import { createFocusRoutes } from './focus-routes.mjs';
import { createNotificationRoutes } from './notification-routes.mjs';
import { createRoutineRoutes } from './routine-routes.mjs';
import { createSettingsRoutes } from './settings-routes.mjs';
import { isCalendarDate } from './hub.mjs';
import {
  HttpError,
  SHELL_CSP,
  applyCommonHeaders,
  closedSignal,
  declaredLengthExceeds,
  hasBody,
  isJsonContentType,
  limitRequestBody,
  readJsonBody,
  redirect,
  sendBody,
  sendError,
  sendJson,
  setContentSecurityPolicy,
} from './http.mjs';

// Unreserved characters and ':', which session ids ('codex:<threadId>', 'claude:<id>') carry.
const SAFE_PATH = /^\/[A-Za-z0-9._~\-:/]*$/;
const ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const READ = ['GET', 'HEAD'];

// Exact-path routes. `methods` lists what is allowed; anything else is 405.
const EXACT_ROUTES = new Map([
  ['/', { name: 'shell', methods: READ }],
  // `/brief` is the Feed view with the brief's overlay open (shell.js), so
  // links from before the overlay still land on the brief.
  ...['/focus', '/brief', '/feed', '/agents', '/goals', '/ideas', '/health'].flatMap((view) => [
    [view, { name: 'shell', methods: READ }],
    [`${view}/`, { name: 'slash-redirect', methods: READ }],
  ]),
  // Reading became the Feed when the brief moved to the overlay.
  ['/reading', { name: 'feed-redirect', methods: READ }],
  ['/reading/', { name: 'feed-redirect', methods: READ }],
  // Kept for one release while the jobs move from Agents to Health.
  ['/routines', { name: 'health-redirect', methods: READ }],
  ['/routines/', { name: 'health-redirect', methods: READ }],
  ['/healthz', { name: 'healthz', methods: READ }],
  // Kept for one release while the shell moves to /api/events.
  ['/api/dashboard/status', { name: 'status', methods: ['GET'] }],
  ['/api/state', { name: 'state', methods: ['GET'] }],
  ['/api/events', { name: 'events', methods: ['GET'] }],
  ['/api/jobs/refresh', { name: 'jobs-refresh', methods: ['POST'], bodyless: true }],
  ['/api/sessions/refresh', { name: 'sessions-refresh', methods: ['POST'], bodyless: true }],
  ['/embedded/focus', { name: 'focus-page', methods: ['GET'] }],
  ['/api/focus', { name: 'focus-api', methods: ['GET', 'PUT'] }],
  ['/api/focus/changes', { name: 'focus-changes', methods: ['POST'] }],
  ['/api/focus/candidates', { name: 'focus-candidates', methods: ['GET'] }],
  ['/api/focus/instructions', { name: 'focus-instructions', methods: ['GET'] }],
  ['/api/focus/instructions/propose', { name: 'focus-instructions-propose', methods: ['POST'] }],
  // Focus's own status and scan controls, called by its page at these
  // absolute paths and forwarded to the same upstream path. The POSTs carry
  // no body, so they need Origin but not a JSON content type.
  ['/api/status', { name: 'focus-control', methods: ['GET'] }],
  ['/api/candidates', { name: 'focus-control', methods: ['GET'] }],
  ['/api/pause', { name: 'focus-control', methods: ['POST'], bodyless: true }],
  ['/api/resume', { name: 'focus-control', methods: ['POST'], bodyless: true }],
  ['/api/refresh', { name: 'focus-control', methods: ['POST'], bodyless: true }],
  ['/api/brief/latest', { name: 'brief-latest', methods: ['GET'] }],
  ['/api/brief/read', { name: 'brief-read', methods: ['POST'], bodyless: true }],
  ['/api/brief/feedback', { name: 'brief-feedback', methods: ['POST'] }],
  ['/api/brief/instructions', { name: 'brief-instructions', methods: ['GET'] }],
  ['/api/brief/instructions/propose', { name: 'brief-instructions-propose', methods: ['POST'] }],
  ['/api/goals', { name: 'goals', methods: ['GET'] }],
  ['/api/goals/propose', { name: 'goals-propose', methods: ['POST'] }],
  ['/api/ideas', { name: 'ideas', methods: ['GET', 'POST'] }],
  ['/api/ideas/dismiss', { name: 'ideas-dismiss', methods: ['POST'] }],
  ['/api/ideas/save', { name: 'ideas-save', methods: ['POST'] }],
  ['/api/ideas/unsave', { name: 'ideas-unsave', methods: ['POST'] }],
  ['/api/ideas/start', { name: 'ideas-start', methods: ['POST'] }],
  ['/api/ideas/refresh', { name: 'ideas-refresh', methods: ['POST'] }],
  ['/api/ideas/instructions', { name: 'ideas-instructions', methods: ['GET'] }],
  ['/api/ideas/instructions/propose', { name: 'ideas-instructions-propose', methods: ['POST'] }],
  ['/api/settings', { name: 'settings', methods: ['PUT'] }],
  ['/api/agents', { name: 'agents-create', methods: ['POST'] }],
]);

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// Focus controls after which the jobs view is refreshed.
const ROUTINE_CONTROLS = new Set(['/api/pause', '/api/resume']);

export function defaultLog(entry) {
  process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), ...entry })}\n`);
}

export function createApp({
  config, focus, brief, hub, store = null, cmux = null, goals = null, feeds = null, sources = null,
  ideas = null, ideasInstructions = null, focusBoard = null, focusInstructions = null,
  briefInstructions = null, notices = null, settings = null, registry = null, routines = null, scheduler = null, notifications = null,
  log = defaultLog,
}) {
  if (!hub) throw new TypeError('createApp requires a hub');
  const allowedHosts = new Set(config.allowedHosts);
  const allowedOrigins = new Set(config.allowedOrigins);
  let shuttingDown = false;
  const isShuttingDown = () => shuttingDown;
  const events = createEvents({ hub, notices, timeouts: config.timeouts, limits: config.limits, shuttingDown: isShuttingDown });
  const agents = createAgentRoutes({ hub, store, cmux, registry, settings, routines, log, limits: config.limits, shuttingDown: isShuttingDown });
  const goalsRoutes = goals
    ? createGoalsRoutes({ goals, hub, log, limits: config.limits, shuttingDown: isShuttingDown })
    : null;
  const settingsRoutes = settings
    ? createSettingsRoutes({ settings, hub, log, limits: config.limits, shuttingDown: isShuttingDown })
    : null;
  const feedRoutes = feeds && sources
    ? createFeedRoutes({ feeds, sources, hub, routines, scheduler, log, limits: config.limits, shuttingDown: isShuttingDown })
    : null;
  const sourceRoutes = feeds && sources
    ? createSourceRoutes({ sources, limits: config.limits, shuttingDown: isShuttingDown })
    : null;
  const ideasRoutes = ideas && ideasInstructions
    ? createIdeasRoutes({
      ideas, instructions: ideasInstructions, instructionsFile: config.ideasInstructionsPath, hub, scheduler, log, limits: config.limits, shuttingDown: isShuttingDown,
    })
    : null;
  const focusBoardRoutes = focusBoard && focusInstructions
    ? createFocusRoutes({
      board: focusBoard, instructions: focusInstructions, instructionsFile: config.focusRulesPath,
      hub, log, limits: config.limits, shuttingDown: isShuttingDown,
    })
    : null;
  const routineRoutes = routines
    ? createRoutineRoutes({ routines, hub, scheduler, log, limits: config.limits, shuttingDown: isShuttingDown })
    : null;
  const notificationRoutes = notifications
    ? createNotificationRoutes({ notifications, log, shuttingDown: isShuttingDown })
    : null;
  const briefInstructionRoutes = briefInstructions
    ? createBriefInstructionsRoutes({
      instructions: briefInstructions, hub, log, limits: config.limits, shuttingDown: isShuttingDown,
    })
    : null;

  function matchRoute(pathname) {
    const exact = EXACT_ROUTES.get(pathname);
    if (exact) return { ...exact, label: pathname };
    if (pathname.startsWith('/assets/')) {
      const name = pathname.slice('/assets/'.length);
      if (ASSET_NAME.test(name)) return { name: 'asset', methods: READ, label: '/assets/:name', params: { name } };
    }
    const agentRoute = agents.match(pathname);
    if (agentRoute) return agentRoute;
    const routineRoute = routineRoutes?.match(pathname);
    if (routineRoute) return routineRoute;
    const notificationRoute = notificationRoutes?.match(pathname);
    if (notificationRoute) return notificationRoute;
    const feedRoute = feedRoutes?.match(pathname) ?? sourceRoutes?.match(pathname);
    if (feedRoute) return feedRoute;
    // /api/brief/<date> and /api/brief/<date>/feedback; the exact routes
    // above (latest, feedback, instructions) are matched first.
    const briefMatch = /^\/api\/brief\/([^/]+)(\/feedback)?$/.exec(pathname);
    if (briefMatch && isCalendarDate(briefMatch[1])) {
      return briefMatch[2]
        ? { name: 'brief-feedback-read', methods: ['GET'], label: '/api/brief/:date/feedback', params: { date: briefMatch[1] } }
        : { name: 'brief-date', methods: ['GET'], label: '/api/brief/:date', params: { date: briefMatch[1] } };
    }
    return null;
  }

  // Every mutation needs an exact allowed Origin. A route that takes a body
  // needs JSON; a bodyless route refuses any body instead; an optionalBody
  // route needs JSON only when a body is sent.
  function checkMutation(req, route) {
    const origin = req.headers.origin;
    if (!origin || !allowedOrigins.has(origin) || new URL(origin).host !== req.headers.host.toLowerCase()) {
      throw new HttpError(403, 'forbidden_origin');
    }
    if (route.optionalBody === true && !hasBody(req)) return;
    // `bodyless` is true for the whole route, or the list of its methods
    // that take no body (a route whose PUT has one and whose DELETE has not).
    const bodyless = Array.isArray(route.bodyless) ? route.bodyless.includes(req.method) : route.bodyless === true;
    if (bodyless) {
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

  async function serveJobsRefresh(res) {
    await hub.refreshJobs();
    sendJson(res, 200, { ok: true, revision: hub.snapshot().revision });
  }

  async function serveSessionsRefresh(res) {
    if (shuttingDown) throw new HttpError(503, 'shutting_down');
    await hub.refreshSessions();
    sendJson(res, 200, { ok: true, revision: hub.snapshot().revision });
  }

  async function serveBriefRead(res) {
    await hub.markBriefRead();
    sendJson(res, 200, { ok: true });
  }

  async function serveFocusControl(req, res, path) {
    await focus.handleControl(req, res, { path });
    if (ROUTINE_CONTROLS.has(path) && res.statusCode >= 200 && res.statusCode < 300) {
      hub.refreshJobs(); // never rejects; failures land in the snapshot
    }
  }

  async function dispatch(req, res, route, search) {
    const head = req.method === 'HEAD';
    switch (route.name) {
      case 'shell':
        return serveShell(req, res);
      case 'slash-redirect':
        return redirect(res, route.label.slice(0, -1) + search);
      case 'health-redirect':
        return redirect(res, '/health' + search, 302);
      case 'feed-redirect':
        return redirect(res, '/feed' + search, 302);
      case 'healthz':
        return sendJson(res, 200, { ok: true }, { head });
      case 'status':
        return serveStatus(res);
      case 'state':
        return serveState(res);
      case 'events':
        return events.serve(req, res);
      case 'jobs-refresh':
        return serveJobsRefresh(res);
      case 'sessions-refresh':
        return serveSessionsRefresh(res);
      case 'asset':
        return serveAsset(req, res, route.params.name);
      case 'focus-page':
        return focus.handlePage(req, res);
      case 'focus-api': {
        if (req.method === 'GET') {
          if (focusBoardRoutes && await focusBoard.exists()) return focusBoardRoutes.serveRead(res);
          return focus.handleApi(req, res, {});
        }
        const limit = config.limits.focusBodyBytes;
        if (declaredLengthExceeds(req, limit)) throw new HttpError(413, 'payload_too_large');
        return focus.handleApi(req, res, { body: limitRequestBody(req, limit) });
      }
      case 'focus-control':
        return serveFocusControl(req, res, route.label);
      case 'focus-changes':
        if (!focusBoardRoutes) throw new HttpError(404, 'not_found');
        return focusBoardRoutes.serveChange(req, res);
      case 'focus-candidates':
        if (!focusBoardRoutes) throw new HttpError(404, 'not_found');
        return focusBoardRoutes.serveCandidates(res);
      case 'focus-instructions':
        if (!focusBoardRoutes) throw new HttpError(404, 'not_found');
        return focusBoardRoutes.serveInstructions(res);
      case 'focus-instructions-propose':
        if (!focusBoardRoutes) throw new HttpError(404, 'not_found');
        return focusBoardRoutes.serveProposeInstructions(req, res);
      case 'brief-latest':
        return brief.handleLatest(req, res);
      case 'brief-read':
        return serveBriefRead(res);
      case 'brief-date':
        return brief.handleBrief(req, res, { date: route.params.date });
      case 'brief-feedback-read':
        return brief.handleFeedbackRead(req, res, { date: route.params.date });
      case 'agent':
        return agents.serve(req, res, route);
      case 'agents-create':
        return agents.serveCreate(req, res);
      case 'routine':
        return routineRoutes.serve(req, res, route);
      case 'notification':
        return notificationRoutes.serve(req, res, route);
      case 'brief-feedback': {
        const body = await readJsonBody(req, { limit: config.limits.feedbackBodyBytes });
        return brief.handleFeedback(req, res, body);
      }
      case 'goals':
        if (!goalsRoutes) throw new HttpError(404, 'not_found');
        return goalsRoutes.serveRead(res);
      case 'goals-propose':
        if (!goalsRoutes) throw new HttpError(404, 'not_found');
        return goalsRoutes.servePropose(req, res);
      case 'settings':
        if (!settingsRoutes) throw new HttpError(404, 'not_found');
        return settingsRoutes.serveUpdate(req, res);
      case 'feeds':
        return feedRoutes.serve(req, res, route);
      case 'sources':
        return sourceRoutes.serve(req, res, route);
      case 'ideas':
        if (!ideasRoutes) throw new HttpError(404, 'not_found');
        return req.method === 'GET' ? ideasRoutes.serveRead(res) : ideasRoutes.serveAdd(req, res);
      case 'ideas-dismiss':
        if (!ideasRoutes) throw new HttpError(404, 'not_found');
        return ideasRoutes.serveDismiss(req, res);
      case 'ideas-save':
        if (!ideasRoutes) throw new HttpError(404, 'not_found');
        return ideasRoutes.serveSave(req, res);
      case 'ideas-unsave':
        if (!ideasRoutes) throw new HttpError(404, 'not_found');
        return ideasRoutes.serveUnsave(req, res);
      case 'ideas-start':
        if (!ideasRoutes) throw new HttpError(404, 'not_found');
        return ideasRoutes.serveStart(req, res);
      case 'ideas-refresh':
        if (!ideasRoutes) throw new HttpError(404, 'not_found');
        return ideasRoutes.serveRefresh(req, res);
      case 'ideas-instructions':
        if (!ideasRoutes) throw new HttpError(404, 'not_found');
        return ideasRoutes.serveInstructions(res);
      case 'ideas-instructions-propose':
        if (!ideasRoutes) throw new HttpError(404, 'not_found');
        return ideasRoutes.serveProposeInstructions(req, res);
      case 'brief-instructions':
        if (!briefInstructionRoutes) throw new HttpError(404, 'not_found');
        return briefInstructionRoutes.serveInstructions(res);
      case 'brief-instructions-propose':
        if (!briefInstructionRoutes) throw new HttpError(404, 'not_found');
        return briefInstructionRoutes.serveProposeInstructions(req, res);
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
      if (events.isStream(res)) return;
      log({ method: req.method, route: label, status: res.statusCode, ms: elapsed() });
    });
    res.once('close', () => {
      if (events.isStream(res)) {
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
        sendError(res, error.status, error.code, { head: req.method === 'HEAD', detail: error.detail });
      } else {
        log({ event: 'handler_error', route: label, error: error?.name ?? 'unknown' });
        sendError(res, 500, 'internal_error');
      }
    }
  }

  // Ends every open event stream with a final `bye` and refuses new ones,
  // and refuses new persona sends, goal proposals, and new threads.
  handle.closeStreams = () => {
    shuttingDown = true;
    events.closeStreams();
  };
  handle.openStreams = events.openStreams;
  return handle;
}

// Rejects anything but plain unencoded segments: no percent-encoding, no
// backslashes, no empty or dot segments. No route needs any of those. A
// colon is allowed because session routes name threads as 'codex:<id>'.
function isSafePath(pathname) {
  if (!SAFE_PATH.test(pathname)) return false;
  if (pathname === '/') return true;
  const segments = pathname.slice(1).split('/');
  return segments.every((segment, i) =>
    segment !== '.' && segment !== '..' && (segment !== '' || i === segments.length - 1));
}
