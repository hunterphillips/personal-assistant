// Feed routes over feeds.mjs and the sources store (sources.mjs):
//   GET  /api/feeds                 200 { feeds, problems }
//   POST /api/feeds                 { name, note } -> 201 { ok: true, feed, suggesting },
//                                   then starts a suggestion run as suggest
//                                   does; one that cannot start is logged
//                                   (feed_suggest_refused) and `suggesting`
//                                   is false
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
//   GET  /api/feeds/:id/suggestions 200 { suggesting, suggestions }:
//                                   feeds.readSuggestions(id) ({ at, sources }
//                                   or null), and whether a run is in flight
//   POST /api/feeds/:id/suggest     bodyless -> 202 { ok: true, suggesting: true }
//                                   once the producer's suggest-sources run has
//                                   started
// discuss never writes: the producer reads the link and answers in its own
// thread, which the shell then opens.
//
// A suggestion run is a routine's test run (scheduler.mjs testRun): a
// detached session in the producer's folder at its permission level, its
// reply kept under the routine's Last runs, nothing in the thread. The
// routine is the producer's first whose instruction names the
// suggest-sources skill; when it has none, one is created, inactive, so it
// only runs from here (SUGGEST_ROUTINE). The run's context is
// suggestContext(id). Before it starts, the feed's suggestions.json is
// removed, since the skill writes the file once. A run is in flight from
// its start until its end line is in the routine's log.
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
// shutting_down, 400 invalid_text. suggest refuses 503 shutting_down, 404
// no_such_feed, 503 not_yet (no routines store or scheduler), 409 busy (a
// suggestion run for the feed is in flight, or the producer has a turn
// open), 409 agent_unavailable (the producer is not a started Claude
// persona), then the scheduler's own refusals. An id in the path that is
// not a feed id is unmatched (404 not_found).
//
// createFeedRoutes({ feeds, sources, hub, routines, scheduler, log, limits,
// shuttingDown }) returns
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
// The routine a producer's suggestion runs go through, created on first use.
// It is inactive, so the schedule (once a year) never fires it.
export const SUGGEST_ROUTINE = Object.freeze({
  name: 'Suggest sources',
  instruction: 'Run the suggest-sources skill for the feed the context names.',
  schedule: { cron: '0 0 1 1 *' },
  active: false,
});
const SUGGEST_SKILL = /\bsuggest-sources\b/;
// A run whose start line has not reached the log by then is taken as gone.
const START_GRACE_MS = 60_000;
const RUNS_SEARCHED = 50;

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

// The context a suggestion run for feed `id` gets.
export function suggestContext(id) {
  return `The feed id is "${id}".`;
}

// The producer's suggestion routine among `items` (routines in store
// order): the first of `agentId`'s whose instruction names the skill, or null.
export function suggestRoutine(items, agentId) {
  return (Array.isArray(items) ? items : []).find((routine) => routine.agent === agentId && SUGGEST_SKILL.test(routine.instruction ?? '')) ?? null;
}

export function createFeedRoutes({ feeds, sources, hub, routines = null, scheduler = null, log, limits, shuttingDown }) {
  const starting = new Set(); // feed ids whose run is being started
  const pending = new Map(); // feed id -> { routineId, run, at }
  let ensuring = Promise.resolve();

  function match(pathname) {
    if (pathname === PREFIX) return { name: 'feeds', methods: ['GET', 'POST'], label: PREFIX, params: { id: null, action: 'list' } };
    if (!pathname.startsWith(`${PREFIX}/`)) return null;
    const [id, action, ...rest] = pathname.slice(PREFIX.length + 1).split('/');
    if (!FEED_ID.test(id) || rest.length !== 0) return null;
    if (action === undefined) return { name: 'feeds', methods: ['GET', 'PUT'], label: `${PREFIX}/:id`, params: { id, action: 'one' } };
    if (action === 'note') return { name: 'feeds', methods: ['GET', 'PUT'], label: `${PREFIX}/:id/note`, params: { id, action } };
    if (action === 'suggestions') return { name: 'feeds', methods: ['GET'], label: `${PREFIX}/:id/suggestions`, params: { id, action } };
    if (action === 'suggest') return { name: 'feeds', methods: ['POST'], bodyless: true, label: `${PREFIX}/:id/suggest`, params: { id, action } };
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
      if (action === 'suggestions') return await serveSuggestions(res, id);
      if (action === 'suggest') return await serveSuggest(res, id);
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
    let suggesting = false;
    try {
      await startSuggest(feed);
      suggesting = true;
    } catch (error) {
      log({ event: 'feed_suggest_refused', feed: feed.id, reason: error?.code ?? error?.message ?? String(error) });
    }
    sendJson(res, 201, { ok: true, feed, suggesting });
  }

  async function serveSuggestions(res, id) {
    const suggestions = await feeds.readSuggestions(id);
    sendJson(res, 200, { suggesting: running(id), suggestions });
  }

  async function serveSuggest(res, id) {
    if (shuttingDown()) throw new HttpError(503, 'shutting_down');
    const feed = await feeds.get(id);
    if (!feed) throw new HttpError(404, 'no_such_feed');
    await startSuggest(feed);
    sendJson(res, 202, { ok: true, suggesting: true });
  }

  // Whether a suggestion run for the feed is starting or has not ended.
  function running(id) {
    if (starting.has(id)) return true;
    const entry = pending.get(id);
    if (!entry) return false;
    let record = null;
    try {
      record = routines.runs(entry.routineId, RUNS_SEARCHED).find((line) => line.run === entry.run) ?? null;
    } catch {
      pending.delete(id); // the routine was deleted
      return false;
    }
    if (record?.endedAt || (!record && Date.now() - entry.at > START_GRACE_MS)) {
      pending.delete(id);
      return false;
    }
    return true;
  }

  // The producer's suggestion routine, created when it has none; one at a time.
  function ensureRoutine(agentId) {
    const next = ensuring.then(async () => {
      const found = suggestRoutine(routines.current(), agentId);
      if (found) return found;
      const routine = await routines.create({ ...SUGGEST_ROUTINE, agent: agentId });
      log({ event: 'feed_suggest_routine_created', agentId, routineId: routine.id });
      return routine;
    });
    ensuring = next.catch(() => {});
    return next;
  }

  async function startSuggest(feed) {
    if (!routines || !scheduler) throw new HttpError(503, 'not_yet');
    if (running(feed.id)) throw new HttpError(409, 'busy');
    const producer = hub.snapshot().agents.find((agent) => agent.id === feed.producer);
    if (!producer || producer.kind !== 'persona' || producer.provider !== 'claude') throw new HttpError(409, 'agent_unavailable');
    if (producer.state === 'busy' || producer.state === 'waiting') throw new HttpError(409, 'busy');
    if (!hub.persona(feed.producer)) throw new HttpError(409, 'agent_unavailable');
    starting.add(feed.id);
    try {
      const routine = await ensureRoutine(feed.producer);
      await feeds.clearSuggestions(feed.id);
      const started = await scheduler.testRun(routine.id, { context: suggestContext(feed.id) });
      if (!started.ok) throw new HttpError(started.reason === 'no_such_routine' ? 404 : 409, started.reason);
      pending.set(feed.id, { routineId: routine.id, run: started.run, at: Date.now() });
      log({ event: 'feed_suggest_started', feed: feed.id, routineId: routine.id });
    } finally {
      starting.delete(feed.id);
    }
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
