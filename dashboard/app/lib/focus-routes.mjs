// Native Focus board routes and the rules instructions routes.

import { defaultAgentId } from './builtins.mjs';
import { HttpError, readJsonBody, sendJson } from './http.mjs';
import { createInstructionsRoutes } from './instructions-routes.mjs';

export function instructionsMessage(text, file) {
  return 'Change the Focus rules.\n\n' +
    `The rules are in ${file}, which you read every run.\n\n` +
    `What I want changed:\n${text}\n\n` +
    'Ask me what you need, then edit the file under its own rules and tell me what changed.';
}

export function createFocusRoutes({ board, instructions, instructionsFile, hub, log, limits, shuttingDown }) {
  async function serveRead(res) {
    const value = await board.read();
    if (!value.board && !value.problem) throw new HttpError(404, 'no_board');
    sendJson(res, 200, value);
  }

  async function serveChange(req, res) {
    const body = await readJsonBody(req, { limit: limits.focusChangeBytes });
    if (!isRecord(body)) throw new HttpError(400, 'invalid_body');
    let changed;
    try {
      changed = await board.change(body);
    } catch (error) {
      throw storeError(error);
    }
    sendJson(res, 200, { board: changed });
  }

  async function serveCandidates(res) {
    sendJson(res, 200, await board.candidates());
  }

  const instructionRoutes = createInstructionsRoutes({
    instructions, hub, log, limits, shuttingDown,
    resolveAgent: () => defaultAgentId(hub.snapshot().agents),
    message: (text) => instructionsMessage(text, instructionsFile),
  });

  return { serveRead, serveChange, serveCandidates, ...instructionRoutes };
}

function storeError(error) {
  const status = {
    invalid_op: 400, invalid_field: 400, invalid_order: 400,
    no_board: 404, no_such_item: 404,
    not_open: 409, not_closed: 409, not_manual: 409, board_invalid: 409,
  }[error?.code];
  if (status) return new HttpError(status, error.code, error.field ? { field: error.field } : undefined);
  return error;
}

function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
