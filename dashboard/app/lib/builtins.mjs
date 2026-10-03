// Built-in agents: the registry entries that are part of the dashboard
// itself (registry.mjs `builtin: true`), kept as data in
// config.builtinPath (default registry/builtin.json, committed) so no agent
// id lives in code. The file is the registry's shape without `cwd`, plus an
// optional `folder` relative to the repository:
//
//   { "agents": [ { "id": "myos", "name": "Myos", "folder": "agents/myos", ..., "builtin": true } ] }
//
// seedBuiltins({ registry, file, root, log }) -> Promise<string[]>
//   At start, after registry.start() and before the hub starts: adds every
//   entry whose id the registry lacks, in one registry.write, with `cwd`
//   set to `folder` resolved against `root` (the repository the dashboard
//   lives in), or to `root` without one, and `folder` dropped; when its
//   group is not in the registry's `groups`, the first listed group's id.
//   Resolves with the ids it added (logged once as builtins_seeded). A
//   registry that is not loaded (missing or invalid: it keeps its last good
//   copy and is fixed by hand) is skipped silently, as is a missing file.
//   An unreadable or malformed file, or a write the validator refuses, is
//   logged (builtins_error, builtins_seed_error) and never fatal. A
//   deleted built-in is therefore back on the next start: the dashboard
//   refuses to delete one (agent-settings-routes.mjs).
//
// defaultAgentId(agents, { except }) -> id | null
//   The agent a setting falls to when nothing names one: the first Claude
//   persona with `builtin`, else the first pinned one, else the first one,
//   leaving out `except`. Used to seed quick chat (server.mjs) and to move
//   the brief or quick chat off an agent being deleted.

import { readFile } from 'node:fs/promises';
import path from 'node:path';

const MAX_BYTES = 64 * 1024;

export async function seedBuiltins({ registry, file, root, log = () => {} }) {
  const current = registry.current();
  if (!current?.ok) return [];
  let entries;
  try {
    entries = await readEntries(file);
  } catch (error) {
    log({ event: 'builtins_error', error: error?.message ?? String(error) });
    return [];
  }
  if (!entries) return [];
  const listed = new Set(current.agents.map((agent) => agent.id));
  if (entries.every((entry) => listed.has(entry.id))) return [];

  const added = [];
  try {
    await registry.write((document) => {
      const agents = Array.isArray(document.agents) ? document.agents : [];
      const groups = Array.isArray(document.groups) ? document.groups : [];
      const ids = new Set(agents.map((agent) => agent?.id));
      const groupIds = new Set(groups.map((group) => group?.id));
      const missing = entries.filter((entry) => !ids.has(entry.id)).map((entry) => {
        const group = groupIds.size > 0 && !groupIds.has(entry.group) ? groups[0].id : entry.group;
        const { folder, ...rest } = entry;
        return { ...rest, group, cwd: folder === undefined ? root : path.resolve(root, folder) };
      });
      added.push(...missing.map((entry) => entry.id));
      return { ...document, agents: [...agents, ...missing.map(inKeyOrder)] };
    });
  } catch (error) {
    log({ event: 'builtins_seed_error', error: error?.message ?? String(error) });
    return [];
  }
  if (added.length > 0) log({ event: 'builtins_seeded', agents: added });
  return added;
}

export function defaultAgentId(agents, { except = null } = {}) {
  const claude = (agents ?? []).filter((agent) => agent.kind === 'persona' && agent.provider === 'claude' && agent.id !== except);
  const chosen = claude.find((agent) => agent.builtin === true) ?? claude.find((agent) => agent.pinned === true) ?? claude[0] ?? null;
  return chosen ? chosen.id : null;
}

// The file's entries, or null when it is missing. Values are the registry
// validator's to judge once merged; this checks only what the seed reads.
async function readEntries(file) {
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  if (Buffer.byteLength(raw) > MAX_BYTES) throw new Error('builtins_oversized');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('builtins_invalid_json');
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.agents)) throw new Error('builtins_invalid: agents must be an array');
  for (const entry of parsed.agents) {
    if (!isRecord(entry) || typeof entry.id !== 'string') throw new Error('builtins_invalid: every agent needs an id');
    if ('cwd' in entry) throw new Error(`builtins_invalid: ${entry.id} must not name a cwd`);
    if ('folder' in entry && !isRelativeFolder(entry.folder)) {
      throw new Error(`builtins_invalid: ${entry.id} folder must be a relative path inside the repository`);
    }
  }
  return parsed.agents;
}

// The registry's key order (agent-settings-routes.mjs entryFor), so the
// seeded entry reads like a dashboard write.
const KEY_ORDER = ['id', 'name', 'role', 'description', 'group', 'kind', 'cwd', 'provider', 'model', 'effort', 'permission', 'accepts', 'jobs', 'pinned', 'builtin'];

function inKeyOrder(entry) {
  const ordered = {};
  for (const key of KEY_ORDER) if (key in entry) ordered[key] = entry[key];
  for (const key of Object.keys(entry)) if (!(key in ordered)) ordered[key] = entry[key];
  return ordered;
}

function isRelativeFolder(folder) {
  if (typeof folder !== 'string' || folder.trim() === '' || path.isAbsolute(folder)) return false;
  const normal = path.normalize(folder);
  return normal !== '.' && normal !== '..' && !normal.startsWith(`..${path.sep}`);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
