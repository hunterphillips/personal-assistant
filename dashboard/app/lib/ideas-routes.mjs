// Ideas routes over ideas.mjs and the criteria instructions reader.
// Mutations answer with the fresh store so the acting browser updates at
// once. Starting marks an idea only after an agent accepts the turn. The
// read names the producer and its ideas routine, which New ideas runs
// through POST /api/routines/:id/run.
//
// POST /api/ideas/refresh { week } (a Monday, YYYY-MM-DD) refreshes a week:
// 503 shutting_down, 404 no_routine, 409 busy, 409 agent_unavailable
// (from the snapshot, before anything is written), then the week's new
// ideas are retired with `replaced` marks and the routine runs with
// refreshContext as its context -> 202 { ok, replaced, ideas }. A run the
// scheduler still refuses answers its refusal with { ideas }.

import { startTurn } from './agent-routes.mjs';
import { defaultAgentId } from './builtins.mjs';
import { HttpError, readJsonBody, sendJson } from './http.mjs';
import { createInstructionsRoutes, listedPersona } from './instructions-routes.mjs';
import { CONTEXT_MAX } from './routine-routes.mjs';
import { DETAIL_MAX, LABEL_MAX } from './send-context.mjs';

const ID_MAX = 80;
const INSTRUCTIONS_PATH = 'ideas/criteria.md';
const WEEK = /^\d{4}-\d{2}-\d{2}$/;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function startMessage() {
  return 'Start on the idea above. Plan it, or hand it to the agent that owns it, and tell me what you did.';
}

export function instructionsMessage(text) {
  return 'Change the Ideas criteria.\n\n' +
    `The criteria are in ${INSTRUCTIONS_PATH}, which you read every run.\n\n` +
    `What I want changed:\n${text}\n\n` +
    'Ask me what you need, then edit the file under its own rules and tell me what changed.';
}

// The context a refresh of `week` gives the ideas routine: the week, and
// the titles of its saved ideas, which the run must not repeat.
export function refreshContext(week, titles) {
  const day = new Date(`${week}T12:00:00Z`);
  const first = `Write this run's ideas for the week of ${MONTHS[day.getUTCMonth()]} ${day.getUTCDate()} (\`week: "${week}"\` in the file).`;
  const second = titles.length > 0
    ? `These ideas of that week are saved and stay; do not repeat them: ${titles.join('; ')}.`
    : 'That week has no saved ideas.';
  return Array.from(`${first}\n${second}`).slice(0, CONTEXT_MAX).join('');
}

// The producer's ideas routine: of `items` (the snapshot's routines, in its
// order), the first of `agentId`'s whose instruction or name contains the
// word "ideas", case-insensitive. Its id, or null.
export function ideasRoutine(items, agentId) {
  const word = /\bideas\b/i;
  const found = (Array.isArray(items) ? items : []).find((routine) => routine.agent === agentId &&
    (word.test(routine.instruction ?? '') || word.test(routine.name ?? '')));
  return found ? found.id : null;
}

export function createIdeasRoutes({ ideas, instructions, hub, scheduler = null, log, limits, shuttingDown }) {
  async function result() {
    const value = await ideas.read();
    const snapshot = hub.snapshot();
    const producer = await ideas.producerAgent(snapshot.agents);
    return { ...value, producer, routine: ideasRoutine(snapshot.routines?.items, producer) };
  }

  async function serveRead(res) {
    sendJson(res, 200, await result());
  }

  async function serveAdd(req, res) {
    const body = await readJsonBody(req, { limit: limits.ideaBodyBytes });
    if (!isRecord(body) || Object.keys(body).join() !== 'text' || typeof body.text !== 'string') {
      throw new HttpError(400, 'invalid_body');
    }
    if (body.text === '' || body.text.split('\n', 1)[0].trim() === '') throw new HttpError(400, 'invalid_text');
    const idea = await ideas.add(body.text);
    sendJson(res, 201, { idea, ideas: await result() });
  }

  async function serveDismiss(req, res) {
    const { id } = await idBody(req, limits);
    try { await ideas.mark(id, { status: 'dismissed' }); } catch (error) { throw storeError(error); }
    sendJson(res, 200, { ideas: await result() });
  }

  async function serveSave(req, res) {
    const { id } = await idBody(req, limits);
    try { await ideas.mark(id, { status: 'saved' }); } catch (error) { throw storeError(error); }
    sendJson(res, 200, { ideas: await result() });
  }

  async function serveUnsave(req, res) {
    const { id } = await idBody(req, limits);
    try { await ideas.unmark(id); } catch (error) { throw storeError(error); }
    sendJson(res, 200, { ideas: await result() });
  }

  async function serveStart(req, res) {
    const { id } = await idBody(req, limits);
    if (shuttingDown()) throw new HttpError(503, 'shutting_down');
    const agents = hub.snapshot().agents;
    const pinned = agents.find((agent) => agent.kind === 'persona' && agent.provider === 'claude' && agent.pinned === true);
    const agentId = listedPersona(hub, pinned?.id ?? defaultAgentId(agents));
    const item = await ideas.find(id);
    if (!item) throw new HttpError(404, 'no_such_item');
    if (item.status === 'taken') throw new HttpError(409, 'already_started');
    const context = {
      view: 'ideas', label: cut(item.title, LABEL_MAX),
      ...(item.text ? { detail: cut(item.text, DETAIL_MAX) } : {}),
    };
    await startTurn({ hub, log, shuttingDown }, agentId, startMessage(item), { context });
    await ideas.mark(id, { status: 'taken', agent: agentId });
    sendJson(res, 202, { ok: true, agentId, ideas: await result() });
  }

  async function serveRefresh(req, res) {
    if (shuttingDown()) throw new HttpError(503, 'shutting_down');
    const body = await readJsonBody(req, { limit: limits.ideaBodyBytes });
    if (!isRecord(body) || Object.keys(body).join() !== 'week' || !isMonday(body.week)) throw new HttpError(400, 'invalid_body');
    const snapshot = hub.snapshot();
    const producer = await ideas.producerAgent(snapshot.agents);
    const routineId = ideasRoutine(snapshot.routines?.items, producer);
    if (!routineId) throw new HttpError(404, 'no_routine');
    if (!scheduler) throw new HttpError(503, 'not_yet');
    const state = snapshot.agents.find((listed) => listed.id === producer)?.state ?? 'unavailable';
    if (state === 'busy' || state === 'waiting') throw new HttpError(409, 'busy');
    if (state === 'unavailable') throw new HttpError(409, 'agent_unavailable');
    let retired;
    try { retired = await ideas.replaceWeek(body.week); } catch (error) { throw storeError(error); }
    const context = refreshContext(body.week, retired.saved.map((idea) => idea.title));
    const started = await scheduler.testRun(routineId, { context });
    if (!started.ok) {
      throw new HttpError(started.reason === 'no_such_routine' ? 404 : 409, started.reason, { ideas: await result() });
    }
    sendJson(res, 202, { ok: true, replaced: retired.replaced.length, ideas: await result() });
  }

  const instructionRoutes = createInstructionsRoutes({
    instructions, hub, log, limits, shuttingDown,
    resolveAgent: () => ideas.producerAgent(hub.snapshot().agents),
    message: instructionsMessage,
  });

  return { serveRead, serveAdd, serveDismiss, serveSave, serveUnsave, serveStart, serveRefresh, ...instructionRoutes };
}

async function idBody(req, limits) {
  const body = await readJsonBody(req, { limit: limits.ideaBodyBytes });
  if (!isRecord(body) || Object.keys(body).join() !== 'id' || typeof body.id !== 'string' ||
      body.id === '' || body.id.length > ID_MAX) throw new HttpError(400, 'invalid_body');
  return body;
}

function storeError(error) {
  if (error?.code === 'no_such_item') return new HttpError(404, 'no_such_item');
  if (error?.code === 'already_started') return new HttpError(409, 'already_started');
  return error;
}

function isMonday(value) {
  if (typeof value !== 'string' || !WEEK.test(value)) return false;
  const day = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(day.getTime()) && day.toISOString().slice(0, 10) === value && day.getUTCDay() === 1;
}

function cut(value, max) { return Array.from(value).slice(0, max).join(''); }
function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
