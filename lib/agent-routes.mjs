// Persona routes, /api/agents/:id/:action (id matches the registry pattern):
//   POST send        { text } -> 202 { ok: true } once the adapter accepts the
//                    turn; the handler never waits for the turn itself.
//   POST answer      { requestId, answers } or { requestId, decision } -> 200
//   POST interrupt   bodyless -> 200; the abort is not awaited
//   POST new-thread  bodyless -> 200 once both thread files are cleared
//   GET  thread      { messages } from store.read(id)
// An id not in the registry is 404 no_such_agent; an agent of another kind
// is 409 not_a_persona; a persona that is not started (unavailable) is 409
// persona_unavailable. Adapter refusals (runtime/adapter.mjs) map to:
// busy 409, no_such_request 409, shutting_down 503, invalid_text 400,
// invalid_answer 400, thread_reset_failed 500. send and new-thread answer
// 503 shutting_down themselves once the app's closeStreams() has run.
//
// createAgentRoutes({ hub, store, log, limits, shuttingDown }) returns
//   match(pathname) -> route or null, in the shape app.mjs routes on
//                      ({ name: 'agent', methods, bodyless?, label, params })
//   serve(req, res, route) -> Promise<void>
// The router (app.mjs) has already checked the method, Origin, and content
// type before serve() runs; serve() reads the body itself. `shuttingDown` is
// a function answering whether closeStreams() has run.

import { AGENT_ID } from './registry.mjs';
import { HttpError, readJsonBody, sendJson } from './http.mjs';

const PREFIX = '/api/agents/';

// action -> route. `methods` lists what is allowed; anything else is 405.
const ACTIONS = new Map([
  ['send', { methods: ['POST'] }],
  ['answer', { methods: ['POST'] }],
  ['interrupt', { methods: ['POST'], bodyless: true }],
  ['new-thread', { methods: ['POST'], bodyless: true }],
  ['thread', { methods: ['GET'] }],
]);

// Adapter refusal code -> HTTP status.
const RUNTIME_STATUS = new Map([
  ['busy', 409],
  ['no_such_request', 409],
  ['shutting_down', 503],
  ['invalid_text', 400],
  ['invalid_answer', 400],
  ['thread_reset_failed', 500],
]);

const REQUEST_ID_MAX = 128;
const ACCEPTED = Symbol('accepted');

export function createAgentRoutes({ hub, store = null, log, limits, shuttingDown }) {
  function match(pathname) {
    if (!pathname.startsWith(PREFIX)) return null;
    const [id, action, ...rest] = pathname.slice(PREFIX.length).split('/');
    const route = ACTIONS.get(action);
    if (!route || rest.length !== 0 || !AGENT_ID.test(id)) return null;
    return { ...route, name: 'agent', label: `${PREFIX}:id/${action}`, params: { id, action } };
  }

  // The started persona behind a route, or the HTTP refusal.
  function personaFor(id) {
    const listed = hub.snapshot().agents.find((agent) => agent.id === id);
    if (!listed) throw new HttpError(404, 'no_such_agent');
    const persona = hub.persona(id);
    if (!persona) throw new HttpError(409, listed.kind === 'persona' ? 'persona_unavailable' : 'not_a_persona');
    return persona;
  }

  function runtimeRefusal(error) {
    const status = RUNTIME_STATUS.get(error?.code);
    return status ? new HttpError(status, error.code) : error;
  }

  // Twice the text cap leaves room for JSON escapes around the text.
  const bodyBytes = () => limits.sendTextBytes * 2;

  async function serveSend(req, res, id) {
    const body = await readJsonBody(req, { limit: bodyBytes() });
    if (!isRecord(body)) throw new HttpError(400, 'invalid_body');
    const { text } = body;
    if (typeof text !== 'string' || text.trim() === '') throw new HttpError(400, 'invalid_text');
    if (Buffer.byteLength(text, 'utf8') > limits.sendTextBytes) throw new HttpError(413, 'payload_too_large');
    if (shuttingDown()) throw new HttpError(503, 'shutting_down');
    const { agent, adapter } = personaFor(id);
    // The adapter refuses (busy, shutting_down, invalid_*) before its first
    // await, so its promise is already rejected when it refuses. Racing it
    // against an already-resolved marker tells a refusal from an accepted
    // turn without waiting for the turn. An accepted turn never rejects by
    // contract; if one does, the rejection is logged, since no reply can
    // carry it.
    const turn = adapter.send(agent, text);
    let accepted = false;
    turn.catch((error) => {
      if (accepted) log({ event: 'persona_turn_rejected', agentId: id, error: error?.code ?? error?.name ?? 'unknown' });
    });
    try {
      await Promise.race([turn, Promise.resolve(ACCEPTED)]);
    } catch (error) {
      throw runtimeRefusal(error);
    }
    accepted = true;
    sendJson(res, 202, { ok: true });
  }

  async function serveAnswer(req, res, id) {
    const body = await readJsonBody(req, { limit: bodyBytes() });
    const keys = isRecord(body) ? Object.keys(body).sort().join() : '';
    const validShape = (keys === 'answers,requestId' || keys === 'decision,requestId') &&
      typeof body.requestId === 'string' && body.requestId !== '' && body.requestId.length <= REQUEST_ID_MAX;
    if (!validShape) throw new HttpError(400, 'invalid_answer');
    const { agent, adapter } = personaFor(id);
    const answer = 'answers' in body ? { answers: body.answers } : { decision: body.decision };
    try {
      await adapter.answer(agent, body.requestId, answer);
    } catch (error) {
      throw runtimeRefusal(error);
    }
    sendJson(res, 200, { ok: true });
  }

  function serveInterrupt(res, id) {
    const { agent, adapter } = personaFor(id);
    // interrupt() waits for the turn to wind down; the reply does not.
    adapter.interrupt(agent).catch((error) => {
      log({ event: 'persona_interrupt_error', agentId: id, error: error?.name ?? 'unknown' });
    });
    sendJson(res, 200, { ok: true });
  }

  async function serveNewThread(res, id) {
    if (shuttingDown()) throw new HttpError(503, 'shutting_down');
    const { agent, adapter } = personaFor(id);
    try {
      await adapter.newThread(agent);
    } catch (error) {
      throw runtimeRefusal(error);
    }
    sendJson(res, 200, { ok: true });
  }

  async function serveThread(res, id) {
    personaFor(id);
    if (!store) throw new HttpError(500, 'internal_error');
    const messages = await store.read(id);
    sendJson(res, 200, { messages });
  }

  async function serve(req, res, route) {
    const { id, action } = route.params;
    switch (action) {
      case 'send':
        return serveSend(req, res, id);
      case 'answer':
        return serveAnswer(req, res, id);
      case 'interrupt':
        return serveInterrupt(res, id);
      case 'new-thread':
        return serveNewThread(res, id);
      case 'thread':
        return serveThread(res, id);
      default:
        throw new HttpError(404, 'not_found');
    }
  }

  return { match, serve };
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
