// Agent settings: the three routes that write the registry (registry.mjs
// write()), so an agent is edited, created, or deleted from the interface
// and the file stays the one source of truth.
//
//   PUT    /api/agents/:id/settings  { name, role, group, description, cwd, model,
//                                      effort, accepts, pinned, permission?, newGroup? }
//                                    -> 200 { ok: true, agent, note? }
//   POST   /api/agents               { id, ...the same }
//                                    -> 201 { ok: true, agent }
//   DELETE /api/agents/:id           bodyless
//                                    -> 200 { ok: true, routines, settings }
//
// Every key but `permission` and `newGroup` is present in a body. `model`
// is null or a model id or alias; `effort` null or one of models.mjs
// EFFORTS; `permission` (optional, so a body from before the control
// existed still saves) null or one of permissions.mjs PERMISSION_LEVELS,
// where absent and null both mean the settings default and the written
// entry carries no key; `accepts` null or a list of
// agent ids, where null, an empty list, or every agent chosen all mean
// everyone and the written entry carries no `accepts` key (never null);
// `pinned` a boolean; `group` a group id; `newGroup` { id, name } adds that
// group to the registry's list when no group has the id yet (a slug that
// matches an existing group joins it), and `group` must then equal its id.
// A created agent is kind persona and provider claude; a project or system
// entry is still a hand edit. The entry is written in the schema's key
// order with its `jobs` kept, so a dashboard write reads as a small
// diff.
//
// Refusals, in this order: 400 invalid_body (a wrong shape or type), 400
// invalid_permission (a permission that is not a level), 404 no_such_agent, 409 not_editable (the agent is not a persona; the panel
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
// Delete removes a persona's registry entry and strips its id from every
// other agent's `accepts` in one write (a list left empty stays [], which
// still means no one, so nothing widens), then removes its routines and
// their runs logs (routines.removeForAgent). When Settings names it for
// the brief or quick chat, that value moves to builtins.mjs
// defaultAgentId over what is left (null when nothing is). The thread
// files and the session stay on disk, so an agent re-added with the same
// id finds its thread. The response lists the routine ids removed and
// the settings values moved ({ brief?, quickChat? }, each the new agent id
// or null). Refusals, in this order: 404 not_found without a writable
// registry, 404 no_such_agent, 409 not_agent (a project or system entry,
// a hand edit), 409 builtin (part of the dashboard; the daemon would seed
// it back), 409 busy (a turn is running or waiting on a card), 409
// registry_invalid, 503 shutting_down, then the write's refusals as
// above. A failure after the registry write (routines or settings) is
// logged as agent_delete_cleanup_error and the delete still answers 200.
//
// A changed `cwd` applies when the agent's next thread starts, because the
// adapter pins a thread's folder (runtime/claude.mjs); the response then
// carries note: 'cwd_applies_on_new_thread'. The hub picks up the change
// through registry.onChange: an edited agent lands in one snapshot
// revision, a new one in two (unavailable, then idle once its adapter has
// started).
//
// createAgentSettingsRoutes({ registry, hub, settings, routines, log, limits, shuttingDown }) returns
//   serveUpdate(req, res, id) -> Promise<void>
//   serveCreate(req, res) -> Promise<void>
//   serveDelete(req, res, id) -> Promise<void>
// `settings` and `routines` are optional; without them Delete leaves the
// settings and the routines alone.
// The router has already checked the method, Origin, and content type.

import { HttpError, readJsonBody, sendJson } from './http.mjs';
import { isEffort } from './models.mjs';
import { isPermission } from './permissions.mjs';
import { defaultAgentId } from './builtins.mjs';
import { AGENT_ID, RegistryError } from './registry.mjs';

const MODEL_MAX = 64;
const FIELDS = ['name', 'role', 'group', 'description', 'cwd', 'model', 'effort', 'accepts', 'pinned'];

export function createAgentSettingsRoutes({ registry, hub, settings = null, routines = null, log = () => {}, limits, shuttingDown }) {
  const canWrite = () => Boolean(registry) && typeof registry.write === 'function';

  async function serveUpdate(req, res, id) {
    if (!canWrite()) throw new HttpError(404, 'not_found');
    const body = await readJsonBody(req, { limit: limits.agentBodyBytes });
    if (!validBody(body, false)) throw new HttpError(400, 'invalid_body');
    if (!validPermission(body)) throw new HttpError(400, 'invalid_permission');
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
    if (!validPermission(body)) throw new HttpError(400, 'invalid_permission');
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

  async function serveDelete(req, res, id) {
    if (!canWrite()) throw new HttpError(404, 'not_found');
    const listed = hub.snapshot().agents.find((agent) => agent.id === id);
    if (!listed) throw new HttpError(404, 'no_such_agent');
    if (listed.kind !== 'persona') throw new HttpError(409, 'not_agent');
    if (listed.builtin === true) throw new HttpError(409, 'builtin');
    if (listed.state === 'busy' || listed.state === 'waiting') throw new HttpError(409, 'busy');
    refuseUnloadable();
    if (shuttingDown()) throw new HttpError(503, 'shutting_down');

    const result = await write((document) => {
      const agents = Array.isArray(document.agents) ? document.agents : [];
      const target = agents.find((entry) => entry && typeof entry === 'object' && entry.id === id);
      if (!target) throw new HttpError(404, 'no_such_agent');
      if (target.kind !== 'persona') throw new HttpError(409, 'not_agent');
      if (target.builtin === true) throw new HttpError(409, 'builtin');
      const rest = agents.filter((entry) => entry !== target).map((entry) => {
        if (!entry || typeof entry !== 'object' || !Array.isArray(entry.accepts) || !entry.accepts.includes(id)) return entry;
        return { ...entry, accepts: entry.accepts.filter((other) => other !== id) };
      });
      return { ...document, agents: rest };
    });
    log({ event: 'agent_deleted', agentId: id });

    const reply = { ok: true, routines: [], settings: {} };
    try {
      if (routines && typeof routines.removeForAgent === 'function') reply.routines = await routines.removeForAgent(id);
      if (settings) {
        const current = settings.current().settings;
        const next = defaultAgentId(result.agents, { except: id });
        const patch = {};
        if (current.brief?.agent === id) patch.brief = { agent: next };
        if (current.quickChat?.agent === id) patch.quickChat = { agent: next };
        if (Object.keys(patch).length > 0) {
          await settings.update(patch);
          for (const key of Object.keys(patch)) reply.settings[key] = patch[key].agent;
        }
      }
    } catch (error) {
      log({ event: 'agent_delete_cleanup_error', agentId: id, error: error?.message ?? String(error) });
    }
    sendJson(res, 200, reply);
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

  return { serveUpdate, serveCreate, serveDelete };
}

// The shape check; values are the registry validator's to judge.
function validBody(body, create) {
  if (!isRecord(body)) return false;
  const allowed = new Set([...FIELDS, 'permission', 'newGroup', ...(create ? ['id'] : [])]);
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

// `permission` is its own check, after the shape, so a bad level has its
// own refusal; absent and null both mean the settings default.
function validPermission(body) {
  return body.permission === undefined || body.permission === null || isPermission(body.permission);
}

function fieldsOf(body) {
  const fields = {};
  for (const key of FIELDS) fields[key] = body[key];
  fields.permission = body.permission ?? null;
  return fields;
}

// One agent entry in the schema's key order. `accepts` is written only
// when it narrows; `model`, `effort`, `permission`, and `pinned` only when
// set.
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
  if (fields.permission !== null && fields.permission !== undefined) entry.permission = fields.permission;
  if (Array.isArray(fields.accepts) && fields.accepts.length > 0) entry.accepts = [...fields.accepts];
  if (Array.isArray(fields.jobs) && fields.jobs.length > 0) entry.jobs = [...fields.jobs];
  if (fields.pinned === true) entry.pinned = true;
  // Never in a body; an edit keeps the existing entry's flag.
  if (fields.builtin === true) entry.builtin = true;
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
