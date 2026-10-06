// Ideas routes over ideas.mjs and the criteria instructions reader.
// Mutations answer with the fresh store so the acting browser updates at
// once. Starting marks an idea only after an agent accepts the turn. The
// read names the producer and its ideas routine, which New ideas runs
// through POST /api/routines/:id/run.

import { startTurn } from './agent-routes.mjs';
import { defaultAgentId } from './builtins.mjs';
import { HttpError, readJsonBody, sendJson } from './http.mjs';
import { createInstructionsRoutes, listedPersona } from './instructions-routes.mjs';
import { DETAIL_MAX, LABEL_MAX } from './send-context.mjs';

const ID_MAX = 80;
const INSTRUCTIONS_PATH = 'ideas/criteria.md';

export function startMessage() {
  return 'Start on the idea above. Plan it, or hand it to the agent that owns it, and tell me what you did.';
}

export function instructionsMessage(text) {
  return 'Change the Ideas criteria.\n\n' +
    `The criteria are in ${INSTRUCTIONS_PATH}, which you read every run.\n\n` +
    `What I want changed:\n${text}\n\n` +
    'Ask me what you need, then edit the file under its own rules and tell me what changed.';
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

export function createIdeasRoutes({ ideas, instructions, hub, log, limits, shuttingDown }) {
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

  const instructionRoutes = createInstructionsRoutes({
    instructions, hub, log, limits, shuttingDown,
    resolveAgent: () => ideas.producerAgent(hub.snapshot().agents),
    message: instructionsMessage,
  });

  return { serveRead, serveAdd, serveDismiss, serveStart, ...instructionRoutes };
}

async function idBody(req, limits) {
  const body = await readJsonBody(req, { limit: limits.ideaBodyBytes });
  if (!isRecord(body) || Object.keys(body).join() !== 'id' || typeof body.id !== 'string' ||
      body.id === '' || body.id.length > ID_MAX) throw new HttpError(400, 'invalid_body');
  return body;
}

function storeError(error) {
  return error?.code === 'no_such_item' ? new HttpError(404, 'no_such_item') : error;
}

function cut(value, max) { return Array.from(value).slice(0, max).join(''); }
function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
