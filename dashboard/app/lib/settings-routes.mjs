// The settings route over settings.mjs:
//   PUT /api/settings  { model?: { default?, effort? }, brief?: { agent? },
//                        permission?: { default? } }
//                      -> 200 { ok: true, settings }
// One request, one decision: the body is a partial patch, merged over the
// current settings by the store, and the response is the whole document as
// saved. The hub's settings listener then commits the new snapshot, so the
// page sees the change through the event stream as every client does.
//
// Refusals, in this order: 400 invalid_body (not an object, empty, or keys
// other than model.default, model.effort, brief.agent, permission.default),
// 400 invalid_model (not null or a string of 1 to 64 characters), 400
// invalid_effort (not null or one of models.mjs EFFORTS), 400 invalid_agent
// (not null or an agent id), 400 invalid_permission (not one of
// permissions.mjs PERMISSION_LEVELS; null is not allowed, the system level
// always has a value), 404 no_such_agent (brief.agent names no Claude persona in the
// registry; null is allowed and means no one), 409 settings_invalid (the
// file on disk could not be read: fix or delete it, since a save would
// overwrite the hand edit), 503 shutting_down, then 500 settings_write_failed
// when the file could not be written (logged as settings_write_error). The
// body is capped at limits.settingsBodyBytes (413 payload_too_large, from
// readJsonBody).
//
// createSettingsRoutes({ settings, hub, log, limits, shuttingDown }) returns
//   serveUpdate(req, res) -> Promise<void>
// The router (app.mjs) has already checked the method, Origin, and content
// type; serveUpdate reads the body itself.

import { HttpError, readJsonBody, sendJson } from './http.mjs';
import { SettingsError, validatePatch } from './settings.mjs';

export function createSettingsRoutes({ settings, hub, log = () => {}, limits, shuttingDown }) {
  async function serveUpdate(req, res) {
    const body = await readJsonBody(req, { limit: limits.settingsBodyBytes });
    const problem = validatePatch(body);
    if (problem) throw new HttpError(400, problem);
    const agentId = body.brief?.agent;
    if (typeof agentId === 'string') {
      const agent = hub.snapshot().agents.find((item) => item.id === agentId);
      if (!agent || agent.kind !== 'persona' || agent.provider !== 'claude') throw new HttpError(404, 'no_such_agent');
    }
    if (!settings.current().ok) throw new HttpError(409, 'settings_invalid');
    if (shuttingDown()) throw new HttpError(503, 'shutting_down');
    let saved;
    try {
      saved = await settings.update(body);
    } catch (error) {
      if (error instanceof SettingsError) {
        if (error.code === 'settings_invalid') throw new HttpError(409, error.code);
        throw new HttpError(400, error.code);
      }
      log({ event: 'settings_write_error', error: error?.message ?? String(error) });
      throw new HttpError(500, 'settings_write_failed');
    }
    sendJson(res, 200, { ok: true, settings: saved });
  }

  return { serveUpdate };
}
