// Brief instructions: the rules the Daily Brief's curator follows
// (config.briefInstructionsPath, by default daily-brief/curator.md), read on
// demand for the Brief tab as prose through instructions.mjs, and the two
// routes over them (instructions-routes.mjs):
//   GET  /api/brief/instructions          200 read()
//   POST /api/brief/instructions/propose  { text } -> 202 { ok: true, agentId }
// A change goes to the agent Settings names under "Brief goes to"
// (the snapshot's settings.brief.agent, read at request time; no agent is
// named here). With none named, propose is 409 no_brief_agent, before the
// registry and running checks; the rest of the refusals are
// instructions-routes.mjs's.
//
// createBriefInstructions({ file, limits, log }) returns { read }, as
// createInstructions does, with `path` INSTRUCTIONS_PATH, the cap
// limits.briefInstructionsBytes, the sentences naming "The brief
// instructions file", and read failures logged as
// brief_instructions_read_error.
// createBriefInstructionsRoutes({ instructions, hub, log, limits, shuttingDown })
// returns { serveInstructions, serveProposeInstructions }.

import { HttpError } from './http.mjs';
import { createInstructions } from './instructions.mjs';
import { createInstructionsRoutes } from './instructions-routes.mjs';

export const INSTRUCTIONS_PATH = 'daily-brief/curator.md';

export function createBriefInstructions({ file, limits, log }) {
  return createInstructions({
    file, path: INSTRUCTIONS_PATH, maxBytes: limits.briefInstructionsBytes, label: 'brief', event: 'brief_instructions_read_error', log,
  });
}

export function instructionsMessage(text) {
  return "Change the brief's instructions.\n\n" +
    `The rules the brief follows are in ${INSTRUCTIONS_PATH}; the run reads them every morning.\n\n` +
    `What I want changed:\n${text}\n\n` +
    'Ask me what you need, then edit the file under its own rules and tell me\n' +
    'what changed.';
}

export function createBriefInstructionsRoutes({ instructions, hub, log, limits, shuttingDown }) {
  function resolveAgent() {
    const agentId = hub.snapshot().settings?.brief?.agent ?? null;
    if (typeof agentId !== 'string' || agentId === '') throw new HttpError(409, 'no_brief_agent');
    return agentId;
  }
  return createInstructionsRoutes({ instructions, hub, log, limits, shuttingDown, resolveAgent, message: instructionsMessage });
}
