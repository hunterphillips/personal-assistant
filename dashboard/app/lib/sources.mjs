// Sources: the registered things a feed reads, one file each under the data
// root's sources/ (config.sourcesDir), written only by the dashboard.
//
//   sources/<id>.json
//   { "version": 1, "id": "latent-space", "name": "Latent Space",
//     "kind": "rss",                         // rss | email | file | folder
//     "url": "https://www.latent.space/feed", // rss
//     "sender": "swyx@substack.com",          // email
//     "path": "/abs/path/notes.md",           // file | folder
//     "active": true, "default": false,
//     "created": "<ISO>", "updated": "<ISO>" }
//
// A source carries only its kind's field. Its role is derived: rss and email
// are incoming (what a feed reads), file and folder are context (what a feed
// judges against). `default` marks the sources a new feed starts with.
//
// createSources({ dir, limits, log, now, usedBy }) returns:
//
//   read() -> Promise<{ sources, problems }>
//     Never rejects. Every valid file, sorted by name; each source as stored
//     plus `role` ('incoming' | 'context') and, for a file or folder,
//     `missing` (true when the path is not there or is not that kind of
//     thing; reported, never refused). A file over limits.sourceFileBytes,
//     not JSON, or not a source is left out with one problem sentence. A
//     missing directory is no sources and no problem.
//   list() -> Promise<[source]>       read().sources
//   get(id) -> Promise<source | null>
//   create(fields) -> Promise<source>
//     fields: name and kind, the kind's field, optional active (default
//     true) and default (default false). The id is the name slugged, with
//     -2, -3, ... when taken.
//   update(id, fields) -> Promise<source>
//     Any of name, active, default, and the source's kind field.
//   remove(id) -> Promise<void>
//     Refuses SourcesError in_use ({ feeds }) while `usedBy(id)` names any
//     feed.
//
// Writes share one serialized queue and replace a file atomically (0600).
// Refusals are SourcesError: invalid_body ({ detail } naming the field),
// no_such_source, in_use ({ feeds }).
//
// readCapped, atomicJson, and slug are shared with feeds.mjs.

import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export const SOURCE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const SOURCE_KINDS = Object.freeze(['rss', 'email', 'file', 'folder']);
const KIND_FIELD = Object.freeze({ rss: 'url', email: 'sender', file: 'path', folder: 'path' });
const KIND_FIELDS = new Set(Object.values(KIND_FIELD));
const FILE_NAME = /^([a-z0-9][a-z0-9-]{0,63})\.json$/;
const NAME_MAX = 80;
const URL_MAX = 2048;
const PATH_MAX = 1024;
const SENDER_MAX = 254;
const EMAIL = /^[^\s@<>()",;:]+@[^\s@<>()",;:.]+(\.[^\s@<>()",;:.]+)+$/;
const KEY_ORDER = ['version', 'id', 'name', 'kind', 'url', 'sender', 'path', 'active', 'default', 'created', 'updated'];

export class SourcesError extends Error {
  constructor(code, detail = null) {
    super(code);
    this.name = 'SourcesError';
    this.code = code;
    this.detail = detail;
  }
}

export function sourceRole(kind) {
  return kind === 'rss' || kind === 'email' ? 'incoming' : 'context';
}

export function createSources({ dir, limits, log: rawLog = () => {}, now = () => new Date(), usedBy = async () => [] }) {
  const log = (entry) => { try { rawLog(entry); } catch {} };
  let writing = null;

  function serialized(task) {
    const run = (writing ?? Promise.resolve()).then(task, task);
    writing = run.catch(() => {}).finally(() => { if (writing === run) writing = null; });
    return run;
  }

  async function names() {
    try {
      return (await readdir(dir)).filter((name) => FILE_NAME.test(name)).sort();
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
  }

  // The stored source, or null with a problem pushed.
  async function load(name, problems) {
    const text = await readCapped(path.join(dir, name), limits.sourceFileBytes, name, problems, (error) => {
      log({ event: 'sources_read_error', path: name, error: error?.message ?? String(error) });
    });
    if (text === null) return null;
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      problems.push(`${name} is not JSON.`);
      return null;
    }
    const id = FILE_NAME.exec(name)[1];
    if (!isRecord(body) || body.id !== id || checkFields(body, { kind: body.kind, partial: false, stored: true }) !== null) {
      problems.push(`${name} is not a source.`);
      return null;
    }
    return body;
  }

  async function read() {
    const problems = [];
    const sources = [];
    let listed = [];
    try {
      listed = await names();
    } catch (error) {
      log({ event: 'sources_read_error', path: dir, error: error?.message ?? String(error) });
      return { sources: [], problems: ['The sources directory could not be read.'] };
    }
    for (const name of listed) {
      try {
        const stored = await load(name, problems);
        if (stored) sources.push(await shown(stored));
      } catch (error) {
        log({ event: 'sources_read_error', path: name, error: error?.message ?? String(error) });
        problems.push(`${name} could not be read.`);
      }
    }
    sources.sort((a, b) => a.name.localeCompare(b.name, 'en') || compare(a.id, b.id));
    return { sources, problems };
  }

  async function list() {
    return (await read()).sources;
  }

  async function get(id) {
    if (typeof id !== 'string' || !SOURCE_ID.test(id)) return null;
    const stored = await load(`${id}.json`, []).catch(() => null);
    return stored ? shown(stored) : null;
  }

  function create(fields) {
    return serialized(async () => {
      if (!isRecord(fields)) throw invalid('the body must be an object');
      const problem = checkFields(fields, { kind: fields.kind, partial: false });
      if (problem) throw invalid(problem);
      const taken = new Set((await names()).map((name) => FILE_NAME.exec(name)[1]));
      const stem = slug(fields.name.trim(), 'source');
      let id = stem;
      for (let suffix = 2; taken.has(id); suffix += 1) id = `${stem.slice(0, 63 - String(suffix).length)}-${suffix}`;
      const at = now().toISOString();
      const field = KIND_FIELD[fields.kind];
      const stored = ordered({
        version: 1, id, name: fields.name.trim(), kind: fields.kind, [field]: normalField(field, fields[field]),
        active: fields.active ?? true, default: fields.default ?? false, created: at, updated: at,
      });
      await atomicJson(path.join(dir, `${id}.json`), stored);
      return shown(stored);
    });
  }

  function update(id, fields) {
    return serialized(async () => {
      const current = await get(id);
      if (!current) throw new SourcesError('no_such_source');
      if (!isRecord(fields)) throw invalid('the body must be an object');
      if (Object.keys(fields).length === 0) throw invalid('the body names no field');
      const field = KIND_FIELD[current.kind];
      for (const key of Object.keys(fields)) {
        if (key === 'kind') throw invalid('kind cannot change');
        if (KIND_FIELDS.has(key) && key !== field) throw invalid(`${key} is not a field of ${current.kind} sources`);
      }
      const problem = checkFields(fields, { kind: current.kind, partial: true });
      if (problem) throw invalid(problem);
      const next = { ...stripShown(current) };
      if ('name' in fields) next.name = fields.name.trim();
      if (field in fields) next[field] = normalField(field, fields[field]);
      if ('active' in fields) next.active = fields.active;
      if ('default' in fields) next.default = fields.default;
      next.updated = now().toISOString();
      const stored = ordered(next);
      await atomicJson(path.join(dir, `${id}.json`), stored);
      return shown(stored);
    });
  }

  function remove(id) {
    return serialized(async () => {
      const current = await get(id);
      if (!current) throw new SourcesError('no_such_source');
      const feeds = await usedBy(id);
      if (feeds.length > 0) throw new SourcesError('in_use', { feeds });
      await unlink(path.join(dir, `${id}.json`));
    });
  }

  return { read, list, get, create, update, remove };
}

// null when `fields` are valid for a source of `kind`, else a sentence.
// `partial` allows any subset of the editable fields; `stored` checks a
// file's whole shape.
function checkFields(fields, { kind, partial, stored = false }) {
  const allowed = new Set(['name', 'kind', 'active', 'default', ...KIND_FIELDS,
    ...(stored ? ['version', 'id', 'created', 'updated'] : [])]);
  for (const key of Object.keys(fields)) if (!allowed.has(key)) return `unknown field "${key}"`;
  if (!partial && !SOURCE_KINDS.includes(kind)) return `kind must be one of ${SOURCE_KINDS.join(', ')}`;
  const field = KIND_FIELD[kind];
  if (!partial) {
    for (const key of ['name', field]) if (!(key in fields)) return `missing field "${key}"`;
    for (const key of KIND_FIELDS) if (key !== field && key in fields) return `${key} is not a field of ${kind} sources`;
  }
  if ('name' in fields) {
    if (typeof fields.name !== 'string' || fields.name.trim() === '' || /[\r\n]/.test(fields.name) || Array.from(fields.name.trim()).length > NAME_MAX) {
      return `name must be 1 to ${NAME_MAX} characters on one line`;
    }
  }
  if (field in fields) {
    const value = fields[field];
    if (field === 'url' && !isHttpUrl(value)) return 'url must be an http or https address';
    if (field === 'sender' && !(typeof value === 'string' && value.trim().length <= SENDER_MAX && EMAIL.test(value.trim()))) {
      return 'sender must be an email address';
    }
    if (field === 'path' && !(typeof value === 'string' && value.length <= PATH_MAX && !value.includes('\0') && path.isAbsolute(value))) {
      return 'path must be an absolute path';
    }
  }
  for (const key of ['active', 'default']) if (key in fields && typeof fields[key] !== 'boolean') return `${key} must be true or false`;
  if (stored) {
    if (fields.version !== 1) return 'version must be 1';
    for (const key of ['active', 'default']) if (!(key in fields)) return `missing field "${key}"`;
    for (const key of ['created', 'updated']) if (typeof fields[key] !== 'string') return `${key} must be a string`;
  }
  return null;
}

function normalField(field, value) {
  if (field === 'sender') return value.trim();
  if (field === 'path') return path.resolve(value);
  return value;
}

function isHttpUrl(value) {
  if (typeof value !== 'string' || value.length > URL_MAX) return false;
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname !== '';
  } catch {
    return false;
  }
}

// A stored source as answered: plus role, and missing for a path.
async function shown(stored) {
  const source = { ...stored, role: sourceRole(stored.kind) };
  if (stored.kind === 'file' || stored.kind === 'folder') {
    let stats = null;
    try { stats = await stat(stored.path); } catch {}
    const there = stats !== null && (stored.kind === 'file' ? stats.isFile() : stats.isDirectory());
    source.missing = !there;
  }
  return Object.freeze(source);
}

function stripShown(source) {
  const { role: _role, missing: _missing, ...stored } = source;
  return stored;
}

function ordered(value) {
  const out = {};
  for (const key of KEY_ORDER) if (key in value) out[key] = value[key];
  return out;
}

function invalid(detail) {
  return new SourcesError('invalid_body', { detail });
}

// The text of `file`, read without following a link, or null with a problem
// pushed; `fail(error)` is called for an unexpected error.
export async function readCapped(file, max, name, problems, fail = () => {}) {
  const tooLarge = `${name} is larger than ${Math.floor(max / 1024)} KiB.`;
  let handle;
  try {
    const stats = await lstat(file);
    if (!stats.isFile()) return pushNull(problems, `${name} is not a regular file.`);
    if (stats.size > max) return pushNull(problems, tooLarge);
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const buffer = Buffer.alloc(max + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    return length > max ? pushNull(problems, tooLarge) : buffer.subarray(0, length).toString('utf8');
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return pushNull(problems, `${name} is missing.`);
    if (error.code === 'ELOOP' || error.code === 'EISDIR') return pushNull(problems, `${name} is not a regular file.`);
    fail(error);
    return pushNull(problems, `${name} could not be read.`);
  } finally {
    await handle?.close().catch(() => {});
  }
}

// Replaces `file` with `value` as 2-space JSON (or `value` itself when it is
// a string), through a temporary file beside it, mode 0600.
export async function atomicJson(file, value) {
  const root = path.dirname(file);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const tmp = path.join(root, `.${path.basename(file)}.${randomBytes(6).toString('hex')}.tmp`);
  const handle = await open(tmp, 'wx', 0o600);
  try {
    await handle.writeFile(typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(tmp, file);
  } catch (error) {
    await unlink(tmp).catch(() => {});
    throw error;
  }
}

// A name as an id: lowercase ASCII letters, digits, and dashes, at most 64.
export function slug(name, fallback) {
  const value = name.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64).replace(/-+$/g, '');
  return value || fallback;
}

function pushNull(problems, sentence) {
  problems.push(sentence);
  return null;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function compare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}
