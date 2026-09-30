// Feed routes over feed.mjs (read-only) and the watch persona:
//   GET  /api/feed          200 feed.read()
//   POST /api/feed/discuss  { id } -> 202 { ok: true, agentId } once the
//                           persona has accepted a turn carrying the item
// discuss never writes the store: it sends the item to the persona named by
// the feed's agentId, which reads the link and answers in its own thread;
// the shell then opens that thread.
//
// discuss refuses, in this order: 400 invalid_body (keys other than id, or
// id not a string of 1 to 200 characters), 503 shutting_down, 404
// no_such_agent (no persona with that id in the registry), 409
// persona_unavailable, 404 no_such_item, then the adapter refusals
// startTurn (agent-routes.mjs) maps: 409 busy, 503 unavailable or
// shutting_down, 400 invalid_text.
//
// createFeedRoutes({ feed, hub, log, shuttingDown }) returns
//   serveRead(res) -> Promise<void>
//   serveDiscuss(req, res) -> Promise<void>
// The router (app.mjs) has already checked the method, Origin, and content
// type; serveDiscuss reads the body itself.

import { personaFor, startTurn } from './agent-routes.mjs';
import { HttpError, readJsonBody, sendJson } from './http.mjs';

const ID_MAX = 200;
const BODY_BYTES = 1024;

export function discussMessage({ title, source, url, summary }) {
  return `Discuss this feed item with me.\n\n${title}\n${source}: ${url}\n\n${summary}\n\n` +
    'Read the link, then tell me what it says in a short paragraph and which of the watch criteria it passed. ' +
    'Then wait for my question.';
}

export function createFeedRoutes({ feed, hub, log, shuttingDown }) {
  async function serveRead(res) {
    sendJson(res, 200, await feed.read());
  }

  async function serveDiscuss(req, res) {
    const body = await readJsonBody(req, { limit: BODY_BYTES });
    const valid = isRecord(body) && Object.keys(body).join() === 'id' &&
      typeof body.id === 'string' && body.id !== '' && body.id.length <= ID_MAX;
    if (!valid) throw new HttpError(400, 'invalid_body');
    if (shuttingDown()) throw new HttpError(503, 'shutting_down');
    const { agentId } = await feed.read();
    const listed = hub.snapshot().agents.find((agent) => agent.id === agentId && agent.kind === 'persona');
    if (!listed) throw new HttpError(404, 'no_such_agent');
    personaFor(hub, agentId);
    const item = await feed.find(body.id);
    if (!item) throw new HttpError(404, 'no_such_item');
    // startTurn checks shutdown and the persona again: find() awaited.
    await startTurn({ hub, log, shuttingDown }, agentId, discussMessage(item));
    sendJson(res, 202, { ok: true, agentId });
  }

  return { serveRead, serveDiscuss };
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
