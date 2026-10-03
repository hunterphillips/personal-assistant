// Feed routes over feed.mjs and feed-instructions.mjs (both read-only) and
// the watch persona:
//   GET  /api/feed          200 feed.read()
//   POST /api/feed/discuss  { id } -> 202 { ok: true, agentId } once the
//                           persona has accepted a turn carrying the item
//   GET  /api/feed/instructions          200 instructions.read()
//   POST /api/feed/instructions/propose  { text } -> 202 { ok: true, agentId }
//                           once the persona has accepted a turn asking it
//                           to change the criteria file
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
// propose never writes the file either: the persona edits it under its own
// rules in its own thread. Both instructions routes are
// instructions-routes.mjs's over the watch persona; propose refuses, in
// this order: 400 invalid_body (any key but text, or text not a string),
// 400 invalid_text (blank), 413 payload_too_large (text over
// limits.sendTextBytes), then as discuss from 503 shutting_down on,
// without no_such_item.
//
// createFeedRoutes({ feed, instructions, hub, log, limits, shuttingDown }) returns
//   serveRead(res) -> Promise<void>
//   serveDiscuss(req, res) -> Promise<void>
//   serveInstructions(res) -> Promise<void>
//   serveProposeInstructions(req, res) -> Promise<void>
// The router (app.mjs) has already checked the method, Origin, and content
// type; the POST routes read the body themselves.

import { startTurn } from './agent-routes.mjs';
import { INSTRUCTIONS_PATH } from './feed-instructions.mjs';
import { HttpError, readJsonBody, sendJson } from './http.mjs';
import { createInstructionsRoutes, listedPersona } from './instructions-routes.mjs';

const ID_MAX = 200;
const BODY_BYTES = 1024;

export function discussMessage({ title, source, url, summary }) {
  return `Discuss this feed item with me.\n\n${title}\n${source}: ${url}\n\n${summary}\n\n` +
    'Read the link, then tell me what it says in a short paragraph and which of the watch criteria it passed. ' +
    'Then wait for my question.';
}

export function instructionsMessage(text) {
  return "Change the feed's criteria.\n\n" +
    `The criteria are in ${INSTRUCTIONS_PATH}, which you read every run.\n\n` +
    `What I want changed:\n${text}\n\n` +
    'Ask me what you need, then edit the file under its own rules, keep the\n' +
    'sender list in daily-brief/watch/contribute in step with the sources table,\n' +
    'and tell me what changed.';
}

export function createFeedRoutes({ feed, instructions, hub, log, limits, shuttingDown }) {
  async function serveRead(res) {
    sendJson(res, 200, await feed.read());
  }

  // The persona the feed names, when the registry lists it as a persona
  // and it is running.
  async function watchPersona() {
    const { agentId } = await feed.read();
    return listedPersona(hub, agentId);
  }

  async function serveDiscuss(req, res) {
    const body = await readJsonBody(req, { limit: BODY_BYTES });
    const valid = isRecord(body) && Object.keys(body).join() === 'id' &&
      typeof body.id === 'string' && body.id !== '' && body.id.length <= ID_MAX;
    if (!valid) throw new HttpError(400, 'invalid_body');
    if (shuttingDown()) throw new HttpError(503, 'shutting_down');
    const agentId = await watchPersona();
    const item = await feed.find(body.id);
    if (!item) throw new HttpError(404, 'no_such_item');
    // startTurn checks shutdown and the persona again: find() awaited.
    await startTurn({ hub, log, shuttingDown }, agentId, discussMessage(item));
    sendJson(res, 202, { ok: true, agentId });
  }

  const { serveInstructions, serveProposeInstructions } = createInstructionsRoutes({
    instructions, hub, log, limits, shuttingDown,
    resolveAgent: async () => (await feed.read()).agentId,
    message: instructionsMessage,
  });

  return { serveRead, serveDiscuss, serveInstructions, serveProposeInstructions };
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
