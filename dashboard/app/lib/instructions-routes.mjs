// The two routes an instructions file has (feed-routes.mjs for the feed's
// criteria, brief-instructions.mjs for the brief's rules):
//   GET  .../instructions          200 instructions.read()
//   POST .../instructions/propose  { text } -> 202 { ok: true, agentId }
//                                  once the agent has accepted a turn asking
//                                  it to change the file
// propose never writes the file: the agent edits it under its own rules in
// its own thread, and the shell opens that thread. It refuses, in this
// order: 400 invalid_body (any key but text, or text not a string), 400
// invalid_text (blank), 413 payload_too_large (text over
// limits.sendTextBytes), 503 shutting_down, whatever `resolveAgent` throws
// (the brief: 409 no_brief_agent when Settings names no agent), 404
// no_such_agent (the id is not a persona in the registry), 409
// persona_unavailable, then the adapter refusals startTurn
// (agent-routes.mjs) maps: 409 busy, 503 unavailable or shutting_down, 400
// invalid_text.
//
// createInstructionsRoutes({ instructions, hub, log, limits, shuttingDown,
//                            resolveAgent, message }) returns
//   serveInstructions(res) -> Promise<void>
//   serveProposeInstructions(req, res) -> Promise<void>
// `resolveAgent()` answers the id of the agent that owns the file (it may
// be async and may throw an HttpError); `message(text)` is the turn's text.
// listedPersona(hub, agentId) is the registry-and-running check on its own,
// for a route that resolves its agent the same way.

import { personaFor, startTurn } from './agent-routes.mjs';
import { HttpError, readJsonBody, sendJson } from './http.mjs';

// The id when the registry lists it as a persona and it is running; else
// 404 no_such_agent or personaFor's 409 persona_unavailable.
export function listedPersona(hub, agentId) {
  const listed = hub.snapshot().agents.find((agent) => agent.id === agentId && agent.kind === 'persona');
  if (!listed) throw new HttpError(404, 'no_such_agent');
  personaFor(hub, agentId);
  return agentId;
}

export function createInstructionsRoutes({ instructions, hub, log, limits, shuttingDown, resolveAgent, message }) {
  async function serveInstructions(res) {
    sendJson(res, 200, await instructions.read());
  }

  async function serveProposeInstructions(req, res) {
    // Twice the text cap leaves room for JSON escapes around the text.
    const body = await readJsonBody(req, { limit: limits.sendTextBytes * 2 });
    if (!isRecord(body) || Object.keys(body).join() !== 'text' || typeof body.text !== 'string') {
      throw new HttpError(400, 'invalid_body');
    }
    const { text } = body;
    if (text.trim() === '') throw new HttpError(400, 'invalid_text');
    if (Buffer.byteLength(text, 'utf8') > limits.sendTextBytes) throw new HttpError(413, 'payload_too_large');
    if (shuttingDown()) throw new HttpError(503, 'shutting_down');
    const agentId = listedPersona(hub, await resolveAgent());
    // startTurn checks shutdown and the persona again: resolveAgent awaited.
    await startTurn({ hub, log, shuttingDown }, agentId, message(text));
    sendJson(res, 202, { ok: true, agentId });
  }

  return { serveInstructions, serveProposeInstructions };
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
