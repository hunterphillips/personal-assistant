// Agent settings: the two routes that write the registry (registry.mjs
// write()), so an agent is edited or created from the interface and the
// file stays the one source of truth.
//
//   PUT  /api/agents/:id/settings  { name, role, group, description, cwd, model,
//                                    effort, accepts, pinned, newGroup? }
//                                  -> 200 { ok: true, agent, note? }
//   POST /api/agents               { id, ...the same }
//                                  -> 201 { ok: true, agent }
//
// Every key is present in a body. `model` is null or a model id or alias;
// `effort` null or one of models.mjs EFFORTS; `accepts` null or a list of
// agent ids, where null, an empty list, or every agent chosen all mean
// everyone and the written entry carries no `accepts` key (never null);
// `pinned` a boolean; `group` a group id; `newGroup` { id, name } adds that
// group to the registry's list when no group has the id yet (a slug that
// matches an existing group joins it), and `group` must then equal its id.
// A created agent is kind persona and provider claude; a project or system
// entry is still a hand edit. The entry is written in the schema's key
// order with its `routines` kept, so a dashboard write reads as a small
// diff.
//
// Refusals, in this order: 400 invalid_body (a wrong shape or type), 404
// no_such_agent, 409 not_editable (the agent is not a persona; the panel
// shows those read-only), 409 duplicate_id (create), 409 registry_invalid
// with { error, problems } while the file on disk does not load (fix or
// delete it by hand; a save would merge over the last good copy), 503
// shutting_down, 400 invalid_registry with { error, problems } when the
// registry validator refuses the result (its strings name the field and
// the rule; the only error body in the app that carries detail, since the
// form shows the reason), then 500 registry_write_failed (logged as
// registry_write_error). Body cap limits.agentBodyBytes (413
// payload_too_large).
//
// A changed `cwd` applies when the agent's next thread starts, because the
// adapter pins a thread's folder (runtime/claude.mjs); the response then
// carries note: 'cwd_applies_on_new_thread'. The hub picks up the change
// through registry.onChange: an edited agent lands in one snapshot
// revision, a new one in two (unavailable, then idle once its adapter has
// started).
//
// createAgentSettingsRoutes({ registry, hub, log, limits, shuttingDown }) returns
//   serveUpdate(req, res, id) -> Promise<void>
//   serveCreate(req, res) -> Promise<void>
// The router has already checked the method, Origin, and content type.

import { HttpError, readJsonBody, sendJson } from './http.mjs';
import { isEffort } from './models.mjs';
import { AGENT_ID, RegistryError } from './registry.mjs';

const MODEL_MAX = 64;
const FIELDS = ['name', 'role', 'group', 'description', 'cwd', 'model', 'effort', 'accepts', 'pinned'];

export function createAgentSettingsRoutes({ registry, hub, log = () => {}, limits, shuttingDown }) {
  const canWrite = () => Boolean(registry) && typeof registry.write === 'function';

  async function serveUpdate(req, res, id) {
    if (!canWrite()) throw new HttpError(404, 'not_found');
    const body = await readJsonBody(req, { limit: limits.agentBodyBytes });
    if (!validBody(body, false)) throw new HttpError(400, 'invalid_body');
    const listed = hub.snapshot().agents.find((agent) => agent.id === id);
    if (!listed) throw new HttpError(404, 'no_such_agent');
    if (listed.kind !== 'persona') throw new HttpError(409, 'not_editable');
    refuseUnloadable();
    if (shuttingDown()) throw new HttpError(503, 'shutting_down');

    const result = await write((document) => {
      const agents = Array.isArray(document.agents) ? document.agents : [];
      const index = agents.findIndex((entry) => entry && typeof entry === 'object' && entry.id === id);
      if (index === -1) throw new HttpError(404, 'no_such_agent');
      const existing = agents[index];
      const next = [...agents];
      next[index] = entryFor({ ...existing, ...fieldsOf(body), id, kind: existing.kind, provider: existing.provider });
      return { ...document, groups: groupsWith(document, body.newGroup), agents: next };
    });
    const agent = result.agents.find((entry) => entry.id === id) ?? null;
    const reply = { ok: true, agent };
    if (listed.cwd !== null && agent && agent.cwd !== listed.cwd) reply.note = 'cwd_applies_on_new_thread';
    sendJson(res, 200, reply);
  }

  async function serveCreate(req, res) {
    if (!canWrite()) throw new HttpError(404, 'not_found');
    const body = await readJsonBody(req, { limit: limits.agentBodyBytes });
    if (!validBody(body, true)) throw new HttpError(400, 'invalid_body');
    if (hub.snapshot().agents.some((agent) => agent.id === body.id)) throw new HttpError(409, 'duplicate_id');
    refuseUnloadable();
    if (shuttingDown()) throw new HttpError(503, 'shutting_down');

    const result = await write((document) => {
      const agents = Array.isArray(document.agents) ? document.agents : [];
      if (agents.some((entry) => entry && typeof entry === 'object' && entry.id === body.id)) throw new HttpError(409, 'duplicate_id');
      const entry = entryFor({ ...fieldsOf(body), id: body.id, kind: 'persona', provider: 'claude' });
      return { ...document, groups: groupsWith(document, body.newGroup), agents: [...agents, entry] };
    });
    sendJson(res, 201, { ok: true, agent: result.agents.find((entry) => entry.id === body.id) ?? null });
  }

  // A file that does not load is repaired by hand first; a missing file is
  // created by the first valid write.
  function refuseUnloadable() {
    const current = registry.current();
    if (!current.ok && current.error !== 'registry_missing') {
      throw new HttpError(409, 'registry_invalid', { problems: [current.error] });
    }
  }

  async function write(mutate) {
    try {
      return await registry.write(mutate);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      if (error instanceof RegistryError) {
        if (error.code === 'invalid_registry') throw new HttpError(400, error.code, { problems: error.problems });
        throw new HttpError(409, 'registry_invalid', { problems: error.code === 'registry_invalid_json' ? ['registry_invalid_json'] : error.problems });
      }
      log({ event: 'registry_write_error', error: error?.message ?? String(error) });
      throw new HttpError(500, 'registry_write_failed');
    }
  }

  return { serveUpdate, serveCreate };
}

// The shape check; values are the registry validator's to judge.
function validBody(body, create) {
  if (!isRecord(body)) return false;
  const allowed = new Set([...FIELDS, 'newGroup', ...(create ? ['id'] : [])]);
  for (const key of Object.keys(body)) if (!allowed.has(key)) return false;
  for (const key of FIELDS) if (!(key in body)) return false;
  if (create && !(typeof body.id === 'string' && AGENT_ID.test(body.id))) return false;
  for (const key of ['name', 'role', 'group', 'description', 'cwd']) if (typeof body[key] !== 'string') return false;
  if (body.model !== null && !(typeof body.model === 'string' && body.model !== '' && body.model.length <= MODEL_MAX)) return false;
  if (body.effort !== null && !isEffort(body.effort)) return false;
  if (body.accepts !== null && !(Array.isArray(body.accepts) && body.accepts.every((id) => typeof id === 'string'))) return false;
  if (typeof body.pinned !== 'boolean') return false;
  if ('newGroup' in body) {
    const group = body.newGroup;
    if (!isRecord(group) || typeof group.id !== 'string' || typeof group.name !== 'string') return false;
    if (Object.keys(group).some((key) => key !== 'id' && key !== 'name')) return false;
    if (body.group !== group.id) return false;
  }
  return true;
}

function fieldsOf(body) {
  const fields = {};
  for (const key of FIELDS) fields[key] = body[key];
  return fields;
}

// One agent entry in the schema's key order. `accepts` is written only
// when it narrows; `model`, `effort`, and `pinned` only when set.
function entryFor(fields) {
  const entry = {
    id: fields.id,
    name: fields.name,
    role: fields.role,
    description: fields.description,
    group: fields.group,
    kind: fields.kind,
    cwd: fields.cwd,
  };
  if (fields.provider !== undefined) entry.provider = fields.provider;
  if (fields.model !== null && fields.model !== undefined) entry.model = fields.model;
  if (fields.effort !== null && fields.effort !== undefined) entry.effort = fields.effort;
  if (Array.isArray(fields.accepts) && fields.accepts.length > 0) entry.accepts = [...fields.accepts];
  if (Array.isArray(fields.routines) && fields.routines.length > 0) entry.routines = [...fields.routines];
  if (fields.pinned === true) entry.pinned = true;
  return entry;
}

// The groups list with `newGroup` added when no listed group has its id.
function groupsWith(document, newGroup) {
  const groups = Array.isArray(document.groups) ? document.groups : [];
  if (!newGroup || groups.some((group) => group && typeof group === 'object' && group.id === newGroup.id)) {
    return document.groups === undefined && groups.length === 0 ? undefined : groups;
  }
  return [...groups, { id: newGroup.id, name: newGroup.name }];
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
