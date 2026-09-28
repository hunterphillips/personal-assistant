// Goals routes over goals.mjs (read-only) and the second-brain persona:
//   GET  /api/goals          200 goals.read()
//   POST /api/goals/propose  { kind: 'add', text } or
//                            { kind: 'edit', target, text } -> 202
//                            { ok: true, agentId } once the persona has
//                            accepted a turn carrying the proposal
// propose never writes the vault: it sends Hunter's text to the persona
// whose cwd is the vault, and the persona interviews him and writes the
// note in its own thread.
//
// propose refuses, in this order: 400 invalid_body (keys other than
// kind,text or kind,target,text; kind not add or edit; target with add, or
// not a string of 1 to 200 characters), 400 invalid_text (blank), 413
// payload_too_large (text over limits.sendTextBytes), 503 shutting_down,
// 404 no_such_agent (no second-brain persona in the registry), 409
// persona_unavailable, 404 no_such_goal (edit of an id find() does not
// know), then the adapter refusals startTurn (agent-routes.mjs) maps: 409
// busy, 503 unavailable or shutting_down, 400 invalid_text.
//
// createGoalsRoutes({ goals, hub, log, limits, shuttingDown }) returns
//   serveRead(res) -> Promise<void>
//   servePropose(req, res) -> Promise<void>
// The router (app.mjs) has already checked the method, Origin, and content
// type; servePropose reads the body itself.

import { personaFor, startTurn } from './agent-routes.mjs';
import { HttpError, readJsonBody, sendJson } from './http.mjs';

const TARGET_MAX = 200;

function addMessage(text) {
  return `New goal from the dashboard:\n\n${text}\n\n` +
    "Interview me until it is defined well enough for the vault, then write it under the vault's rules and tell me the file.";
}

function editMessage({ title, source, text: current }, text) {
  const quoted = current.split('\n').map((line) => `> ${line}`).join('\n');
  return `Edit a goal from the dashboard: "${title}" in ${source}.\n\nCurrent text:\n${quoted}\n\n` +
    `What I want changed:\n${text}\n\n` +
    "Ask me what you need, then update the note under the vault's rules and tell me the file.";
}

export function createGoalsRoutes({ goals, hub, log, limits, shuttingDown }) {
  async function serveRead(res) {
    sendJson(res, 200, await goals.read());
  }

  async function servePropose(req, res) {
    // Twice the text cap leaves room for JSON escapes around the text.
    const body = await readJsonBody(req, { limit: limits.sendTextBytes * 2 });
    const keys = isRecord(body) ? Object.keys(body).sort().join() : '';
    const validShape = (keys === 'kind,text' && body.kind === 'add') ||
      (keys === 'kind,target,text' && body.kind === 'edit' &&
        typeof body.target === 'string' && body.target !== '' && body.target.length <= TARGET_MAX);
    if (!validShape) throw new HttpError(400, 'invalid_body');
    const { text } = body;
    if (typeof text !== 'string' || text.trim() === '') throw new HttpError(400, 'invalid_text');
    if (Buffer.byteLength(text, 'utf8') > limits.sendTextBytes) throw new HttpError(413, 'payload_too_large');
    if (shuttingDown()) throw new HttpError(503, 'shutting_down');
    const { agentId } = await goals.read();
    if (!agentId) throw new HttpError(404, 'no_such_agent');
    personaFor(hub, agentId);
    let message;
    if (body.kind === 'edit') {
      const item = await goals.find(body.target);
      if (!item) throw new HttpError(404, 'no_such_goal');
      message = editMessage(item, text);
    } else {
      message = addMessage(text);
    }
    // startTurn checks shutdown and the persona again: find() awaited.
    await startTurn({ hub, log, shuttingDown }, agentId, message);
    sendJson(res, 202, { ok: true, agentId });
  }

  return { serveRead, servePropose };
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
