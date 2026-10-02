// Persona routes, /api/agents/:id/:action (id matches the registry pattern):
//   POST send        { text } -> 202 { ok: true } once the adapter accepts the
//                    turn; the handler never waits for the turn itself.
//   POST answer      { requestId, answers } or { requestId, decision } -> 200
//                    for the agent's own request, or one forwarded to this
//                    thread (hub.requestOwner names the owner after the
//                    agent's own adapter refuses no_such_request; the
//                    owner's adapter settles it). An owner no longer
//                    started is 409 no_such_request like any stale card.
//   POST interrupt   bodyless -> 200; the abort is not awaited
//   POST model       { model?, effort? } -> 200 { ok, model: { id, effort, source } }
//                    the thread's own choice for its next turns; a key
//                    present replaces that field (null inherits again), a
//                    key absent keeps it. Claude personas only: a Codex
//                    persona is 409 not_supported.
//   POST new-thread  bodyless -> 200 once both thread files are cleared
//   GET  thread      { messages } from store.read(id)
//   PUT  settings    the agent's registry entry (agent-settings-routes.mjs);
//                    POST /api/agents (serveCreate) adds one. Both need a
//                    `registry` with write(); without it they are 404.
// An id not in the registry is 404 no_such_agent; an agent of another kind
// is 409 not_a_persona; a persona that is not started (unavailable) is 409
// persona_unavailable. Adapter refusals (runtime/adapter.mjs) map to:
// busy 409, no_such_request 409, not_supported 409, shutting_down 503,
// invalid_model 400, invalid_effort 400 (model's body checks; also what the
// adapter would refuse),
// unavailable 503, invalid_text 400, invalid_answer 400,
// thread_reset_failed 500. send and new-thread answer 503 shutting_down
// themselves once the app's closeStreams() has run.
//
// Session routes, /api/sessions/:id/:action (id matches SESSION_ROUTE_ID,
// that is 'codex:<threadId>' or 'claude:<cmux session id>'), for the rows in
// the snapshot's `sessions`:
//   POST answer         as above
//   POST interrupt      as above
//   GET  thread         { messages } from adapter.thread(id), read live
//   POST open-terminal  bodyless -> 200 { ok: true, verified } once cmux has
//                       focused the session's bound terminal
// An id not in the snapshot is 404 no_such_session, as is a thread the
// adapter has dropped since the snapshot was built (its invalid_agent). A
// terminal row (a Claude session cmux registered) has no adapter, so
// answer, interrupt, and thread are 409 not_supported for it.
// open-terminal refuses 409 unbound for a row
// with no terminal record, 503 cmux_unavailable (with the snapshot's
// `reason`) while cmux cannot be reached, 409 terminal_closed when the
// bound surface is not in the last inventory, and 502 focus_failed (with
// the client's `reason`) when cmux would not focus it; it never picks a
// terminal by any other means than the recorded ids. There is no send and
// no new-thread: these threads are driven from their terminals.
//
// createAgentRoutes({ hub, store, cmux, registry, log, limits, shuttingDown }) returns
//   match(pathname) -> route or null, in the shape app.mjs routes on
//                      ({ name: 'agent', methods, bodyless?, label, params })
//   serve(req, res, route) -> Promise<void>
//   serveCreate(req, res) -> Promise<void>   POST /api/agents
// The router (app.mjs) has already checked the method, Origin, and content
// type before serve() runs; serve() reads the body itself. `shuttingDown` is
// a function answering whether closeStreams() has run.
//
// Shared with other routes that start a persona turn (goals-routes.mjs):
//   personaFor(hub, id) -> { agent, adapter } of the started persona, or
//                          throws the HttpError above (404 no_such_agent,
//                          409 not_a_persona, 409 persona_unavailable)
//   startTurn({ hub, log, shuttingDown }, id, text, { mentions }) -> Promise<void>
//     503 shutting_down once closeStreams() has run, then personaFor(id),
//     then adapter.send(agent, text, { model, effort, mentions }) with the
//     model from hub.modelFor(id) and `mentions` the registry ids the
//     message names with @ (absent when none). Resolves as soon as the adapter has
//     accepted the turn and rejects with the mapped HttpError when it
//     refuses; a turn rejected after acceptance is logged as
//     persona_turn_rejected. The caller validates `text` and sends the reply.

import { AGENT_ID } from './registry.mjs';
import { createAgentSettingsRoutes } from './agent-settings-routes.mjs';
import { HttpError, readJsonBody, sendJson } from './http.mjs';
import { isEffort } from './models.mjs';

const PREFIX = '/api/agents/';
const SESSION_PREFIX = '/api/sessions/';
// The providers whose sessions are listed, then the provider's own id.
export const SESSION_ROUTE_ID = /^(?:codex|claude):[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

// action -> route. `methods` lists what is allowed; anything else is 405.
const ACTIONS = new Map([
  ['send', { methods: ['POST'] }],
  ['model', { methods: ['POST'] }],
  ['answer', { methods: ['POST'] }],
  ['interrupt', { methods: ['POST'], bodyless: true }],
  ['new-thread', { methods: ['POST'], bodyless: true }],
  ['thread', { methods: ['GET'] }],
  ['settings', { methods: ['PUT'] }],
  ['open-terminal', { methods: ['POST'], bodyless: true }],
]);
const SESSION_ACTIONS = new Set(['answer', 'interrupt', 'thread', 'open-terminal']);
const PERSONA_ACTIONS = new Set(['send', 'model', 'answer', 'interrupt', 'new-thread', 'thread', 'settings']);

// Adapter refusal code -> HTTP status.
const RUNTIME_STATUS = new Map([
  ['busy', 409],
  ['no_such_request', 409],
  ['not_supported', 409],
  ['shutting_down', 503],
  ['unavailable', 503],
  ['invalid_text', 400],
  ['invalid_answer', 400],
  ['invalid_model', 400],
  ['invalid_effort', 400],
  ['thread_reset_failed', 500],
]);

const REQUEST_ID_MAX = 128;
const MODEL_MAX = 64;
const ACCEPTED = Symbol('accepted');

export function createAgentRoutes({ hub, store = null, cmux = null, registry = null, log, limits, shuttingDown }) {
  const settingsRoutes = createAgentSettingsRoutes({ registry, hub, log, limits, shuttingDown });

  function match(pathname) {
    const session = pathname.startsWith(SESSION_PREFIX);
    const prefix = session ? SESSION_PREFIX : PREFIX;
    if (!pathname.startsWith(prefix)) return null;
    const [id, action, ...rest] = pathname.slice(prefix.length).split('/');
    const route = ACTIONS.get(action);
    if (!route || rest.length !== 0) return null;
    if (session ? !SESSION_ACTIONS.has(action) || !SESSION_ROUTE_ID.test(id) : !PERSONA_ACTIONS.has(action) || !AGENT_ID.test(id)) return null;
    return { ...route, name: 'agent', label: `${prefix}:id/${action}`, params: { id, action, session } };
  }

  const personaOf = (id) => personaFor(hub, id);

  // The listed session and its adapter behind a route, or the HTTP refusal.
  function sessionFor(id) {
    const session = hub.session(id);
    if (!session) throw new HttpError(404, 'no_such_session');
    if (!session.adapter) throw new HttpError(409, 'not_supported');
    return session;
  }

  // The listed session's row, or 404.
  function sessionRow(id) {
    const row = hub.snapshot().sessions.find((session) => session.id === id);
    if (!row) throw new HttpError(404, 'no_such_session');
    return row;
  }

  // Twice the text cap leaves room for JSON escapes around the text.
  const bodyBytes = () => limits.sendTextBytes * 2;

  async function serveSend(req, res, id) {
    const body = await readJsonBody(req, { limit: bodyBytes() });
    if (!isRecord(body)) throw new HttpError(400, 'invalid_body');
    const { text } = body;
    if (typeof text !== 'string' || text.trim() === '') throw new HttpError(400, 'invalid_text');
    if (Buffer.byteLength(text, 'utf8') > limits.sendTextBytes) throw new HttpError(413, 'payload_too_large');
    const mentions = mentionsIn(body, hub);
    await startTurn({ hub, log, shuttingDown }, id, text, mentions.length > 0 ? { mentions } : undefined);
    sendJson(res, 202, { ok: true });
  }

  // The thread's model and effort for its next turns. A key present
  // replaces that field (null inherits again); a key absent keeps it.
  async function serveModel(req, res, id) {
    if (shuttingDown()) throw new HttpError(503, 'shutting_down');
    const body = await readJsonBody(req, { limit: bodyBytes() });
    if (!isRecord(body)) throw new HttpError(400, 'invalid_body');
    const keys = Object.keys(body);
    if (keys.length === 0 || keys.some((key) => key !== 'model' && key !== 'effort')) throw new HttpError(400, 'invalid_body');
    if ('model' in body && body.model !== null && !(typeof body.model === 'string' && body.model !== '' && body.model.length <= MODEL_MAX)) {
      throw new HttpError(400, 'invalid_model');
    }
    if ('effort' in body && body.effort !== null && !isEffort(body.effort)) throw new HttpError(400, 'invalid_effort');
    const { agent, adapter } = personaOf(id);
    if (agent.provider !== 'claude' || typeof adapter.setModel !== 'function') throw new HttpError(409, 'not_supported');
    const choice = {};
    if ('model' in body) choice.model = body.model;
    if ('effort' in body) choice.effort = body.effort;
    try {
      await adapter.setModel(agent, choice);
    } catch (error) {
      throw runtimeRefusal(error);
    }
    const view = hub.snapshot().agents.find((listed) => listed.id === id)?.model ?? null;
    sendJson(res, 200, { ok: true, model: view ? { id: view.id, effort: view.effort, source: view.source } : null });
  }

  async function serveAnswer(req, res, id, target, forwarded = false) {
    const body = await readJsonBody(req, { limit: bodyBytes() });
    const keys = isRecord(body) ? Object.keys(body).sort().join() : '';
    const validShape = (keys === 'answers,requestId' || keys === 'decision,requestId') &&
      typeof body.requestId === 'string' && body.requestId !== '' && body.requestId.length <= REQUEST_ID_MAX;
    if (!validShape) throw new HttpError(400, 'invalid_answer');
    const { agent, adapter } = target(id);
    const answer = 'answers' in body ? { answers: body.answers } : { decision: body.decision };
    try {
      await adapter.answer(agent, body.requestId, answer);
    } catch (error) {
      // Not this agent's: a card forwarded to its thread is answered
      // through the owner's adapter, which settles it for both threads.
      const owner = forwarded && error?.code === 'no_such_request' ? hub.requestOwner(id, body.requestId) : null;
      if (!owner) throw runtimeRefusal(error);
      const persona = hub.persona(owner);
      if (!persona) throw new HttpError(409, 'no_such_request');
      try {
        await persona.adapter.answer(persona.agent, body.requestId, answer);
      } catch (ownerError) {
        throw runtimeRefusal(ownerError);
      }
    }
    sendJson(res, 200, { ok: true });
  }

  function serveInterrupt(res, id, target) {
    const { agent, adapter } = target(id);
    // interrupt() waits for the turn to wind down; the reply does not.
    adapter.interrupt(agent).catch((error) => {
      log({ event: 'persona_interrupt_error', agentId: id, error: error?.name ?? 'unknown' });
    });
    sendJson(res, 200, { ok: true });
  }

  async function serveNewThread(res, id) {
    if (shuttingDown()) throw new HttpError(503, 'shutting_down');
    const { agent, adapter } = personaOf(id);
    try {
      await adapter.newThread(agent);
    } catch (error) {
      throw runtimeRefusal(error);
    }
    // Cards forwarded to the old thread go with it; they stay answerable
    // in their owners' threads.
    hub.dropRelaysTo(id);
    sendJson(res, 200, { ok: true });
  }

  async function serveThread(res, id) {
    personaOf(id);
    if (!store) throw new HttpError(500, 'internal_error');
    const messages = await store.read(id);
    sendJson(res, 200, { messages });
  }

  async function serveSessionThread(res, id) {
    const { agent, adapter } = sessionFor(id);
    let thread;
    try {
      thread = await adapter.thread(agent);
    } catch (error) {
      // Listed a moment ago, dropped by the adapter since.
      if (error?.code === 'invalid_agent') throw new HttpError(404, 'no_such_session');
      throw runtimeRefusal(error);
    }
    sendJson(res, 200, { messages: Array.isArray(thread?.messages) ? thread.messages : [] });
  }

  async function serveOpenTerminal(res, id) {
    const { binding } = sessionRow(id);
    if (!binding || typeof binding.workspaceId !== 'string' || typeof binding.surfaceId !== 'string') {
      throw new HttpError(409, 'unbound');
    }
    const status = hub.snapshot().cmux;
    if (!cmux || status?.available !== true) {
      sendJson(res, 503, { error: 'cmux_unavailable', reason: status?.reason ?? 'no_client' });
      return;
    }
    if (binding.live !== true) throw new HttpError(409, 'terminal_closed');
    const result = await cmux.focus({ workspaceId: binding.workspaceId, surfaceId: binding.surfaceId });
    if (result?.ok !== true) {
      sendJson(res, 502, { error: 'focus_failed', reason: typeof result?.reason === 'string' ? result.reason : 'error' });
      return;
    }
    sendJson(res, 200, { ok: true, verified: result.verified === true });
  }

  async function serve(req, res, route) {
    const { id, action, session } = route.params;
    const target = session ? sessionFor : personaOf;
    switch (action) {
      case 'send':
        return serveSend(req, res, id);
      case 'model':
        return serveModel(req, res, id);
      case 'answer':
        return serveAnswer(req, res, id, target, !session);
      case 'interrupt':
        return serveInterrupt(res, id, target);
      case 'new-thread':
        return serveNewThread(res, id);
      case 'thread':
        return session ? serveSessionThread(res, id) : serveThread(res, id);
      case 'settings':
        return settingsRoutes.serveUpdate(req, res, id);
      case 'open-terminal':
        return serveOpenTerminal(res, id);
      default:
        throw new HttpError(404, 'not_found');
    }
  }

  return { match, serve, serveCreate: settingsRoutes.serveCreate };
}

// The started persona behind a route, or the HTTP refusal.
export function personaFor(hub, id) {
  const listed = hub.snapshot().agents.find((agent) => agent.id === id);
  if (!listed) throw new HttpError(404, 'no_such_agent');
  const persona = hub.persona(id);
  if (!persona) throw new HttpError(409, listed.kind === 'persona' ? 'persona_unavailable' : 'not_a_persona');
  return persona;
}

export async function startTurn({ hub, log, shuttingDown }, id, text, { mentions = null } = {}) {
  if (shuttingDown()) throw new HttpError(503, 'shutting_down');
  const { agent, adapter } = personaFor(hub, id);
  // The adapter refuses (busy, shutting_down, invalid_*) before its first
  // await, so its promise is already rejected when it refuses. Racing it
  // against an already-resolved marker tells a refusal from an accepted
  // turn without waiting for the turn. An accepted turn never rejects by
  // contract; if one does, the rejection is logged, since no reply can
  // carry it.
  // The hub resolves { id, effort }; the adapter takes { model, effort }.
  const resolved = typeof hub.modelFor === 'function' ? hub.modelFor(id) : null;
  const options = {
    ...(resolved ? { model: resolved.id, effort: resolved.effort } : {}),
    ...(Array.isArray(mentions) && mentions.length > 0 ? { mentions: [...mentions] } : {}),
  };
  const turn = adapter.send(agent, text, Object.keys(options).length > 0 ? options : undefined);
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
}

// The agents a message names with @, from the body's optional `mentions`:
// an array of at most MENTIONS_MAX registry ids, or 400 invalid_mentions.
// Ids the registry does not list are dropped, not refused: the client
// matched them against the snapshot it had, which may be a moment stale.
const MENTIONS_MAX = 20;
function mentionsIn(body, hub) {
  if (!('mentions' in body)) return [];
  const { mentions } = body;
  if (!Array.isArray(mentions) || mentions.length > MENTIONS_MAX) throw new HttpError(400, 'invalid_mentions');
  if (!mentions.every((id) => typeof id === 'string' && AGENT_ID.test(id))) throw new HttpError(400, 'invalid_mentions');
  const known = new Set(hub.snapshot().agents.map((agent) => agent.id));
  return [...new Set(mentions.filter((id) => known.has(id)))];
}

function runtimeRefusal(error) {
  const status = RUNTIME_STATUS.get(error?.code);
  return status ? new HttpError(status, error.code) : error;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
