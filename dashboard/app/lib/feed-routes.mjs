// Feed routes over feeds.mjs and the sources store (sources.mjs):
//   GET  /api/feeds                 200 { feeds, problems }
//   POST /api/feeds                 { name, note } -> 201 { ok: true, feed }
//   GET  /api/feeds/:id             200 feeds.read(id)
//   PUT  /api/feeds/:id             { name?, sources?, active? }, at least one
//                                   -> 200 { ok: true, feed }
//   GET  /api/feeds/:id/note        200 { text, updated }
//   PUT  /api/feeds/:id/note        { text } -> 200 { ok: true, text, updated };
//                                   the dashboard writes the file, no agent turn
//   POST /api/feeds/:id/save        { id } -> 200 the fresh read, as GET /api/feeds/:id
//   POST /api/feeds/:id/unsave      { id } -> 200 the fresh read
//   POST /api/feeds/:id/dismiss     { id } -> 200 the fresh read
//   POST /api/feeds/:id/discuss     { id } -> 202 { ok: true, agentId } once
//                                   the feed's producer has accepted a turn
//                                   carrying the post
// discuss never writes: the producer reads the link and answers in its own
// thread, which the shell then opens.
//
// Refusals, in this order: 503 shutting_down (writes and discuss), 400
// invalid_json or invalid_body (a wrong shape, a missing or unknown key, a
// bad value; `detail` names it when the store does), 413
// payload_too_large (a body over limits.feedBodyBytes, a note body over
// twice limits.feedNoteBytes) or note_too_large (a note over
// limits.feedNoteBytes), 404 no_such_feed, 400 unknown_source ({ sources }),
// 409 marks_invalid (marks.json cannot be read, so it is not replaced),
// and for discuss 404 no_such_agent, 409 persona_unavailable (the producer
// is not a running persona), 404 no_such_item, then the adapter refusals
// startTurn (agent-routes.mjs) maps: 409 busy, 503 unavailable or
// shutting_down, 400 invalid_text. An id in the path that is not a feed id
// is unmatched (404 not_found).
//
// createFeedRoutes({ feeds, sources, hub, log, limits, shuttingDown }) returns
// match(pathname) -> route | null in the shape app.mjs routes on
// ({ name: 'feeds', methods, label, params: { id, action } }) and
// serve(req, res, route). The router has already checked the method,
// Origin, and content type.

import { startTurn } from './agent-routes.mjs';
import { FEED_ID } from './feeds.mjs';
import { HttpError, readJsonBody, sendJson } from './http.mjs';
import { listedPersona } from './instructions-routes.mjs';

const PREFIX = '/api/feeds';
const ITEM_ID_MAX = 200;
const MARK_ACTIONS = new Set(['save', 'unsave', 'dismiss']);

const STORE_STATUS = new Map([
  ['invalid_body', 400],
  ['unknown_source', 400],
  ['no_such_feed', 404],
  ['no_such_item', 404],
  ['note_too_large', 413],
  ['marks_invalid', 409],
]);

// The turn Discuss sends: the post, its sources by name, and the takeaway
// and insights when it has them.
export function discussMessage({ title, sources = [], url, summary, takeaway = null, insights = null }) {
  const names = sources.length > 0 ? `${sources.join(', ')}: ` : '';
  return `Discuss this feed post with me.\n\n${title}\n${names}${url}\n\n${summary}\n\n` +
    (takeaway ? `Takeaway: ${takeaway}\n\n` : '') +
    (insights ? `Insights:\n${insights}\n\n` : '') +
    'Read the link, then tell me what it says in a short paragraph and why it was picked. ' +
    'Then wait for my question.';
}

export function createFeedRoutes({ feeds, sources, hub, log, limits, shuttingDown }) {
  function match(pathname) {
    if (pathname === PREFIX) return { name: 'feeds', methods: ['GET', 'POST'], label: PREFIX, params: { id: null, action: 'list' } };
    if (!pathname.startsWith(`${PREFIX}/`)) return null;
    const [id, action, ...rest] = pathname.slice(PREFIX.length + 1).split('/');
    if (!FEED_ID.test(id) || rest.length !== 0) return null;
    if (action === undefined) return { name: 'feeds', methods: ['GET', 'PUT'], label: `${PREFIX}/:id`, params: { id, action: 'one' } };
    if (action === 'note') return { name: 'feeds', methods: ['GET', 'PUT'], label: `${PREFIX}/:id/note`, params: { id, action } };
    if (MARK_ACTIONS.has(action) || action === 'discuss') {
      return { name: 'feeds', methods: ['POST'], label: `${PREFIX}/:id/${action}`, params: { id, action } };
    }
    return null;
  }

  async function serve(req, res, route) {
    const { id, action } = route.params;
    try {
      if (action === 'list') return req.method === 'GET' ? sendJson(res, 200, await feeds.list()) : await serveCreate(req, res);
      if (action === 'one') return req.method === 'GET' ? sendJson(res, 200, await feeds.read(id)) : await serveUpdate(req, res, id);
      if (action === 'note') return req.method === 'GET' ? sendJson(res, 200, await feeds.readNote(id)) : await serveNote(req, res, id);
      if (action === 'discuss') return await serveDiscuss(req, res, id);
      return await serveMark(req, res, id, action);
    } catch (error) {
      throw storeError(error);
    }
  }

  async function serveCreate(req, res) {
    if (shuttingDown()) throw new HttpError(503, 'shutting_down');
    const body = await readJsonBody(req, { limit: limits.feedNoteBytes * 2 });
    if (!isRecord(body)) throw new HttpError(400, 'invalid_body');
    for (const key of Object.keys(body)) if (key !== 'name' && key !== 'note') throw new HttpError(400, 'invalid_body', { detail: `unknown field "${key}"` });
    for (const key of ['name', 'note']) if (!(key in body)) throw new HttpError(400, 'invalid_body', { detail: `missing field "${key}"` });
    const feed = await feeds.create({ name: body.name, note: body.note });
    sendJson(res, 201, { ok: true, feed });
  }

  async function serveUpdate(req, res, id) {
    if (shuttingDown()) throw new HttpError(503, 'shutting_down');
    const body = await readJsonBody(req, { limit: limits.feedBodyBytes });
    if (!isRecord(body)) throw new HttpError(400, 'invalid_body');
    const feed = await feeds.update(id, body);
    sendJson(res, 200, { ok: true, feed });
  }

  async function serveNote(req, res, id) {
    if (shuttingDown()) throw new HttpError(503, 'shutting_down');
    // Twice the note cap leaves room for JSON escapes around the text.
    const body = await readJsonBody(req, { limit: limits.feedNoteBytes * 2 });
    if (!isRecord(body) || Object.keys(body).join() !== 'text' || typeof body.text !== 'string') {
      throw new HttpError(400, 'invalid_body');
    }
    const note = await feeds.writeNote(id, body.text);
    sendJson(res, 200, { ok: true, ...note });
  }

  async function serveMark(req, res, id, action) {
    if (shuttingDown()) throw new HttpError(503, 'shutting_down');
    const body = await itemBody(req);
    const result = action === 'unsave'
      ? await feeds.unmark(id, body.id)
      : await feeds.mark(id, body.id, action === 'save' ? 'saved' : 'dismissed');
    sendJson(res, 200, result);
  }

  async function serveDiscuss(req, res, id) {
    const body = await itemBody(req);
    if (shuttingDown()) throw new HttpError(503, 'shutting_down');
    const feed = await feeds.get(id);
    if (!feed) throw new HttpError(404, 'no_such_feed');
    const agentId = listedPersona(hub, feed.producer);
    const item = await feeds.find(id, body.id);
    if (!item) throw new HttpError(404, 'no_such_item');
    const names = new Map((await sources.list().catch(() => [])).map((source) => [source.id, source.name]));
    // startTurn checks shutdown and the persona again: find() awaited.
    await startTurn({ hub, log, shuttingDown }, agentId, discussMessage({
      ...item, sources: item.sources.map((source) => names.get(source) ?? source),
    }));
    sendJson(res, 202, { ok: true, agentId });
  }

  async function itemBody(req) {
    const body = await readJsonBody(req, { limit: limits.feedBodyBytes });
    if (!isRecord(body) || Object.keys(body).join() !== 'id' || typeof body.id !== 'string' ||
        body.id === '' || body.id.length > ITEM_ID_MAX) throw new HttpError(400, 'invalid_body');
    return body;
  }

  return { match, serve };
}

function storeError(error) {
  const status = STORE_STATUS.get(error?.code);
  if (status && !(error instanceof HttpError)) return new HttpError(status, error.code, error.detail ?? null);
  return error;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
