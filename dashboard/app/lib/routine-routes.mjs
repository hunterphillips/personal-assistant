// Routine routes over routines.mjs (the store) and scheduler.mjs (the test
// run):
//   GET    /api/routines            -> 200 { routines } as the snapshot lists
//                                     them (hub.mjs `routines.items`)
//   POST   /api/routines            { name, agent, instruction, schedule, active }
//                                  -> 201 { ok: true, routine }
//   PUT    /api/routines/:id        the same five keys, every one present
//                                  -> 200 { ok: true, routine }
//   DELETE /api/routines/:id        bodyless -> 200 { ok: true }
//   GET    /api/routines/:id/runs   -> 200 { runs }, the newest
//                                     limits.routineRunsShown, newest first
//   POST   /api/routines/:id/run    bodyless, or { context } (1 to
//                                     CONTEXT_MAX characters once trimmed,
//                                     added to the run's prompt) -> 202
//                                     { ok: true } once the scheduler has
//                                     started the turn now
// `schedule` in a body is a cron line (schedule.mjs parseCron); the stored
// routine carries { cron, text } with the daemon's words. `routine` in an
// answer is the snapshot's item (with nextAt and lastRun). An id in the
// path matches routines.mjs ROUTINE_ID or the route is unmatched (404).
//
// Refusals, in this order: 503 shutting_down, 400 invalid_body (a wrong
// shape, a missing or unknown key, a bad value; `detail` names it), 400
// invalid_schedule with `sentence`, the help line the form shows, 404
// no_such_agent (the agent is not in the registry), 400 not_an_agent (it
// is not a Claude persona), 404 no_such_routine, 409 too_many_routines,
// then 500 routine_write_failed (logged as routine_write_error). A test
// run answers 409 busy when the agent has a turn open and 409
// agent_unavailable when it is not started, with no line written, and 503
// not_yet when no scheduler was given (tests). Bodies are capped at
// limits.routineBodyBytes (413 payload_too_large).
//
// createRoutineRoutes({ routines, hub, scheduler, log, limits, shuttingDown })
// returns match(pathname) -> route | null in the shape app.mjs routes on
// ({ name: 'routine', methods, bodyless?, optionalBody?, label, params: { id, action } })
// and serve(req, res, route). The router has already checked the method,
// Origin, and content type before serve() runs.

import { HttpError, hasBody, readJsonBody, sendJson } from './http.mjs';
import { ROUTINE_ID, RoutineError } from './routines.mjs';

const PREFIX = '/api/routines';
const FIELDS = ['name', 'agent', 'instruction', 'schedule', 'active'];
export const CONTEXT_MAX = 2000;
export const SCHEDULE_SENTENCE = 'A schedule is five cron fields: minute, hour, day of the month, month, and day of the week. "30 6 * * 1-5" is weekdays at 6:30.';

const STORE_STATUS = new Map([
  ['invalid_body', 400],
  ['invalid_schedule', 400],
  ['no_such_routine', 404],
  ['too_many_routines', 409],
]);

export function createRoutineRoutes({ routines, hub, scheduler = null, log = () => {}, limits, shuttingDown }) {
  function match(pathname) {
    if (pathname === PREFIX) return { name: 'routine', methods: ['GET', 'POST'], label: PREFIX, params: { id: null, action: 'list' } };
    if (!pathname.startsWith(`${PREFIX}/`)) return null;
    const [id, action, ...rest] = pathname.slice(PREFIX.length + 1).split('/');
    if (!ROUTINE_ID.test(id) || rest.length !== 0) return null;
    if (action === undefined) return { name: 'routine', methods: ['PUT', 'DELETE'], bodyless: ['DELETE'], label: `${PREFIX}/:id`, params: { id, action: 'one' } };
    if (action === 'runs') return { name: 'routine', methods: ['GET'], label: `${PREFIX}/:id/runs`, params: { id, action } };
    if (action === 'run') return { name: 'routine', methods: ['POST'], optionalBody: true, label: `${PREFIX}/:id/run`, params: { id, action } };
    return null;
  }

  function item(id) {
    return hub.snapshot().routines.items.find((routine) => routine.id === id) ?? null;
  }

  // The body's five fields, checked for shape here so the error names the
  // field before the store or the registry is asked.
  async function readFields(req) {
    const body = await readJsonBody(req, { limit: limits.routineBodyBytes });
    if (!isRecord(body)) throw new HttpError(400, 'invalid_body');
    const keys = Object.keys(body);
    for (const key of keys) if (!FIELDS.includes(key)) throw new HttpError(400, 'invalid_body', { detail: `unknown field "${key}"` });
    for (const key of FIELDS) if (!(key in body)) throw new HttpError(400, 'invalid_body', { detail: `missing field "${key}"` });
    if (typeof body.schedule !== 'string') throw new HttpError(400, 'invalid_body', { detail: 'schedule must be a string' });
    return { name: body.name, agent: body.agent, instruction: body.instruction, schedule: { cron: body.schedule }, active: body.active };
  }

  function checkAgent(agentId) {
    if (typeof agentId !== 'string') throw new HttpError(400, 'invalid_body', { detail: 'agent must be an agent id' });
    const agent = hub.snapshot().agents.find((listed) => listed.id === agentId);
    if (!agent) throw new HttpError(404, 'no_such_agent');
    if (agent.kind !== 'persona' || agent.provider !== 'claude') throw new HttpError(400, 'not_an_agent');
  }

  function refusal(error) {
    if (error instanceof RoutineError) {
      const status = STORE_STATUS.get(error.code);
      if (error.code === 'invalid_schedule') return new HttpError(400, error.code, { sentence: SCHEDULE_SENTENCE });
      if (status) return new HttpError(status, error.code, error.detail ? { detail: error.detail } : null);
    }
    log({ event: 'routine_write_error', error: error?.message ?? String(error) });
    return new HttpError(500, 'routine_write_failed');
  }

  async function serveCreate(req, res) {
    if (shuttingDown()) throw new HttpError(503, 'shutting_down');
    const fields = await readFields(req);
    checkAgent(fields.agent);
    let routine;
    try {
      routine = await routines.create(fields);
    } catch (error) {
      throw refusal(error);
    }
    sendJson(res, 201, { ok: true, routine: item(routine.id) ?? routine });
  }

  async function serveUpdate(req, res, id) {
    if (shuttingDown()) throw new HttpError(503, 'shutting_down');
    const fields = await readFields(req);
    checkAgent(fields.agent);
    let routine;
    try {
      routine = await routines.update(id, fields);
    } catch (error) {
      throw refusal(error);
    }
    sendJson(res, 200, { ok: true, routine: item(routine.id) ?? routine });
  }

  async function serveRemove(res, id) {
    if (shuttingDown()) throw new HttpError(503, 'shutting_down');
    try {
      await routines.remove(id);
    } catch (error) {
      throw refusal(error);
    }
    sendJson(res, 200, { ok: true });
  }

  function serveRuns(res, id) {
    if (!item(id)) throw new HttpError(404, 'no_such_routine');
    sendJson(res, 200, { runs: routines.runs(id, limits.routineRunsShown) });
  }

  // A run's optional body: { context }, trimmed, or undefined with no body.
  async function readContext(req) {
    if (!hasBody(req)) return undefined;
    const body = await readJsonBody(req, { limit: limits.routineBodyBytes });
    if (!isRecord(body) || Object.keys(body).join() !== 'context' || typeof body.context !== 'string') {
      throw new HttpError(400, 'invalid_body');
    }
    const context = body.context.trim();
    if (context === '' || Array.from(context).length > CONTEXT_MAX) throw new HttpError(400, 'invalid_body');
    return context;
  }

  async function serveRun(req, res, id) {
    if (shuttingDown()) throw new HttpError(503, 'shutting_down');
    const context = await readContext(req);
    if (!item(id)) throw new HttpError(404, 'no_such_routine');
    if (!scheduler) throw new HttpError(503, 'not_yet');
    const started = await scheduler.testRun(id, context === undefined ? {} : { context });
    if (started.ok) {
      sendJson(res, 202, { ok: true });
      return;
    }
    throw new HttpError(started.reason === 'no_such_routine' ? 404 : 409, started.reason);
  }

  async function serve(req, res, route) {
    const { id, action } = route.params;
    switch (action) {
      case 'list':
        return req.method === 'POST' ? serveCreate(req, res) : sendJson(res, 200, { routines: hub.snapshot().routines.items }, { head: req.method === 'HEAD' });
      case 'one':
        return req.method === 'PUT' ? serveUpdate(req, res, id) : serveRemove(res, id);
      case 'runs':
        return serveRuns(res, id);
      case 'run':
        return serveRun(req, res, id);
      default:
        throw new HttpError(404, 'not_found');
    }
  }

  return { match, serve };
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
