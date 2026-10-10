// Native Focus board, settings, refresh, and rules routes. Optional services
// leave their routes unavailable; this module never falls back to the legacy
// Focus proxy or runs a scan itself.

import { defaultAgentId } from './builtins.mjs';
import { HttpError, readJsonBody, sendJson } from './http.mjs';
import { createInstructionsRoutes } from './instructions-routes.mjs';
import { describe, parseCron } from './schedule.mjs';

const SCHEDULES = Object.freeze([
  ['calendar', 'focus.scan-calendar'], ['gmail', 'focus.scan-gmail'], ['git', 'focus.scan-git'],
  ['notes', 'focus.scan-notes'], ['rejudge', 'focus.curate'],
]);

export function instructionsMessage(text, file) {
  return 'Change the Focus rules.\n\n' +
    `The rules are in ${file}, which you read every run.\n\n` +
    `What I want changed:\n${text}\n\n` +
    'Ask me what you need, then edit the file under its own rules and tell me what changed.';
}

export function createFocusRoutes({ board = null, instructions = null, instructionsFile, settings = null, jobs = null, runner = null, hub, log, limits, shuttingDown }) {
  async function serveRead(res) {
    const value = await board.read();
    if (!value.board && !value.problem) throw new HttpError(404, 'no_board');
    sendJson(res, 200, { ...value, paused: settings?.current().paused ?? false, scanning: runner?.state().running ?? null });
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

  function settingsView() {
    const current = settings.current();
    return {
      paused: current.paused,
      schedules: SCHEDULES.map(([source, label]) => {
        const cron = current.schedules[source];
        return { source, cron, text: describe(parseCron(cron)), lastRun: runner.lastRun(label) };
      }),
      model: current.model,
    };
  }

  function serveSettings(res) {
    sendJson(res, 200, settingsView());
  }

  async function serveSettingsUpdate(req, res) {
    const body = await readJsonBody(req, { limit: limits.focusSettingsBytes });
    try {
      await settings.update(body);
    } catch (error) {
      if (error?.code === 'settings_invalid') throw new HttpError(409, 'settings_invalid');
      if (['invalid_body', 'invalid_paused', 'invalid_model', 'invalid_effort', 'read_only'].includes(error?.code)) {
        throw new HttpError(400, 'invalid_body');
      }
      throw error;
    }
    serveSettings(res);
  }

  async function serveRefresh(res) {
    if (!board || !await board.exists()) throw new HttpError(404, 'no_board');
    const answer = await jobs.refresh();
    if (!answer?.ok) throw new HttpError(409, typeof answer?.reason === 'string' ? answer.reason : 'not_started');
    sendJson(res, 202, { run: answer.run });
  }

  const instructionRoutes = instructions ? createInstructionsRoutes({
    instructions, hub, log, limits, shuttingDown,
    resolveAgent: () => defaultAgentId(hub.snapshot().agents),
    message: (text) => instructionsMessage(text, instructionsFile),
  }) : {};

  return { serveRead, serveChange, serveCandidates, serveSettings, serveSettingsUpdate, serveRefresh, ...instructionRoutes };
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
