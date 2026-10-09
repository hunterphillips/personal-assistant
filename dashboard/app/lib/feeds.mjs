// Feeds: one folder per feed under the data root's feeds/ (config.feedsDir),
// read on demand for the Feed view. The dashboard owns every file in a feed
// folder that is edited after it is created; a producer only adds item files.
//
//   feeds/<id>/feed.json   { "version": 1, "id": "news", "name": "News",
//                            "producer": "scout", "sources": ["latent-space"],
//                            "active": true, "created": "<ISO>", "updated": "<ISO>" }
//   feeds/<id>/note.md     Hunter's instructions for the feed, as he wrote them
//   feeds/<id>/items/      one <date>.json per run (<date>-<producer>.json
//                          before version 2), append-only; feeds/README.md
//   feeds/<id>/marks.json  { "version": 1, "marks": { "<item id>":
//                            { "status": "saved" | "dismissed", "at": "<ISO>" } } }
//   feeds/<id>/suggestions.json  { "version": 1, "at": "<ISO>",
//                            "sources": [{ "id": "<source id>", "why": "..." }] }
//                          written once by the producer's suggest-sources run;
//                          the daemon removes it before the next run
//
// Folders whose names start with a dot (the producer's .run/) are not feeds.
//
// createFeeds({ dir, sources, limits, log, now }) returns:
//
//   list() -> Promise<{ feeds, problems }>
//     Never rejects. Each feed's feed.json, newest first by `created`; a
//     folder without a readable, valid feed.json is one problem sentence.
//   get(id) -> Promise<feed | null>
//   read(id) -> Promise<result>
//     Rejects FeedsError no_such_feed; never otherwise. Single-flight and
//     cached per feed by signature (feed.json, the item files' lstat,
//     marks.json's lstat, and the sources' names), as the Ideas reader.
//     result, deeply frozen:
//       { feed, readAt, problems: [sentence],
//         runs: [{ id, producer, date, since, generatedAt, read: [id],
//                  items: [{ id, title, sources: [id or name], url, summary,
//                            takeaway, insights, kept, image, status,
//                            position }] }] }
//     - Runs are the regular files named <date>.json or <date>-<producer>.json,
//       newest first by name, at most limits.feedFiles, each at most
//       limits.feedFileBytes; a file that is not a run is one problem.
//     - An item needs `id`, `title`, `url` (http or https), and `summary` as
//       non-empty strings and an id no newer item took, and either
//       `sources`, a non-empty list of non-empty strings, or the old
//       `source` string, which is split on "/" and "," and each name mapped
//       to the id of the source with that name (any case), or kept as the
//       name. `takeaway` (at most TAKEAWAY_MAX characters) and `insights`
//       (at most INSIGHTS_MAX) are strings or null: an over-long or wrong
//       value is dropped, the item kept. `kept` is false unless true;
//       `image` an http or https URL or null.
//     - `position` is the item's index in the file's `items`, from 0, which
//       a notification's feed:<run>/<index> link names; it does not shift
//       when an earlier item is dismissed or left out.
//     - Marks: a dismissed item is left out; `status` is 'saved' or 'new'.
//       An unreadable marks.json is one problem and refuses mark writes.
//   find(feedId, itemId) -> Promise<item | null>
//     The item (a dismissed one too) with `feed`, `producer`, and `date`.
//   create({ name, note }) -> Promise<feed>
//     The id is the name slugged (-2, -3, ... when taken); the feed starts
//     with the sources marked default, produced by the producer of the
//     oldest feed (DEFAULT_PRODUCER when there is none). note.md is written
//     first and feed.json last, with an empty items/.
//   update(id, { name?, sources?, active? }) -> Promise<feed>
//     `sources` are ids of registered sources, no repeats, in the given order.
//   readNote(id) -> Promise<{ text, updated }>   '' and null when missing
//   writeNote(id, text) -> Promise<{ text, updated }>
//     Refuses note_too_large over limits.feedNoteBytes.
//   mark(feedId, itemId, status) / unmark(feedId, itemId) -> Promise<result>
//     status 'saved' or 'dismissed'; answers the fresh read.
//   usedBy(sourceId) -> Promise<[feed id]>   the feeds that list the source
//   readSuggestions(id) -> Promise<{ at, sources } | null>
//     Rejects FeedsError no_such_feed. null when suggestions.json is missing,
//     and when it is not the shape above (at most SUGGESTIONS_MAX sources,
//     each `why` 1 to WHY_MAX characters, no id twice), which is logged as
//     feed_suggestions_invalid { feed, reason }. Otherwise the suggested
//     sources that are registered, active, and not already on the feed, in
//     the file's order, each { id, name, kind, role, why }.
//   clearSuggestions(id) -> Promise<void>     removes suggestions.json if there
//
// Writes share one serialized queue and replace a file atomically (0600).
// Refusals are FeedsError: invalid_body ({ detail }), unknown_source
// ({ sources }), no_such_feed, no_such_item, note_too_large, marks_invalid.

import { lstat, mkdir, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';

import { atomicJson, readCapped, slug } from './sources.mjs';

export const FEED_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const TAKEAWAY_MAX = 240;
export const INSIGHTS_MAX = 2000;
export const SUGGESTIONS_MAX = 8;
export const WHY_MAX = 300;
// The producer a feed names when no feed exists to take it from: the
// built-in agent registry/builtin.json seeds for feeds.
export const DEFAULT_PRODUCER = 'scout';
const FILE_NAME = /^\d{4}-\d{2}-\d{2}(-[a-z][a-z0-9-]*)?\.json$/;
const URL_SCHEME = /^https?:\/\//i;
const MARKS = new Set(['saved', 'dismissed']);
const NAME_MAX = 40;
const ITEM_ID_MAX = 200;
const AGENT_ID = /^[a-z][a-z0-9-]{1,31}$/;
const KEY_ORDER = ['version', 'id', 'name', 'producer', 'sources', 'active', 'created', 'updated'];

export class FeedsError extends Error {
  constructor(code, detail = null) {
    super(code);
    this.name = 'FeedsError';
    this.code = code;
    this.detail = detail;
  }
}

export function createFeeds({ dir, sources, limits, log: rawLog = () => {}, now = () => new Date() }) {
  const log = (entry) => { try { rawLog(entry); } catch {} };
  const caches = new Map(); // feed id -> { signature, result, index, marks, marksWritable }
  const inFlight = new Map();
  let writing = null;

  function serialized(task) {
    const run = (writing ?? Promise.resolve()).then(task, task);
    writing = run.catch(() => {}).finally(() => { if (writing === run) writing = null; });
    return run;
  }

  const feedFile = (id) => path.join(dir, id, 'feed.json');
  const noteFile = (id) => path.join(dir, id, 'note.md');
  const itemsDir = (id) => path.join(dir, id, 'items');
  const marksFile = (id) => path.join(dir, id, 'marks.json');
  const suggestionsFile = (id) => path.join(dir, id, 'suggestions.json');

  async function folders() {
    try {
      return (await readdir(dir, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && FEED_ID.test(entry.name)).map((entry) => entry.name).sort();
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
  }

  // The feed in `id`'s feed.json, or null with a problem pushed.
  async function loadFeed(id, problems) {
    const name = `${id}/feed.json`;
    const text = await readCapped(feedFile(id), limits.sourceFileBytes, name, problems, (error) => {
      log({ event: 'feeds_read_error', path: name, error: error?.message ?? String(error) });
    });
    if (text === null) return null;
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      problems.push(`${name} is not JSON.`);
      return null;
    }
    if (!isRecord(body) || body.version !== 1 || body.id !== id || !validName(body.name) || !AGENT_ID.test(body.producer ?? '') ||
        !Array.isArray(body.sources) || !body.sources.every(nonEmpty) || typeof body.active !== 'boolean' ||
        !nonEmpty(body.created) || !nonEmpty(body.updated)) {
      problems.push(`${name} is not a feed.`);
      return null;
    }
    return ordered(body);
  }

  async function list() {
    const problems = [];
    const feeds = [];
    let ids;
    try {
      ids = await folders();
    } catch (error) {
      log({ event: 'feeds_read_error', path: dir, error: error?.message ?? String(error) });
      return { feeds: [], problems: ['The feeds directory could not be read.'] };
    }
    for (const id of ids) {
      const feed = await loadFeed(id, problems).catch(() => null);
      if (feed) feeds.push(feed);
    }
    feeds.sort((a, b) => compare(b.created, a.created) || compare(a.id, b.id));
    return deepFreeze({ feeds, problems });
  }

  async function get(id) {
    if (typeof id !== 'string' || !FEED_ID.test(id)) return null;
    return loadFeed(id, []).catch(() => null);
  }

  async function requireFeed(id) {
    const feed = await get(id);
    if (!feed) throw new FeedsError('no_such_feed');
    return feed;
  }

  async function load(id) {
    const feed = await requireFeed(id);
    const scan = await scanItems(itemsDir(id), limits, log);
    const marksStats = await statOf(marksFile(id));
    const known = await sources.list().catch(() => []);
    const byName = new Map(known.map((source) => [source.name.toLowerCase(), source.id]));
    const signature = JSON.stringify([feed, scan.state, scan.files, marksStats, [...byName]]);
    const cached = caches.get(id);
    if (cached?.signature === signature) return cached.result;

    const problems = [...scan.problems];
    let failed = scan.failed;
    const fail = (name, error) => {
      failed = true;
      log({ event: 'feeds_read_error', path: `${id}/${name}`, error: error?.message ?? String(error) });
    };
    const marksRead = await readMarks(marksFile(id), marksStats, limits.feedFileBytes, problems, fail);
    const runs = [];
    const index = new Map();
    for (const file of scan.files) {
      const text = await readCapped(path.join(itemsDir(id), file.name), limits.feedFileBytes, file.name, problems, (error) => fail(file.name, error));
      if (text === null) continue;
      const run = parseRun(text, file.name, { id, byName, marks: marksRead.value, problems, index });
      if (run) runs.push(run);
    }
    const result = deepFreeze({ feed, readAt: now().toISOString(), problems, runs });
    caches.set(id, { signature: failed ? null : signature, result, index, marks: marksRead.value, marksWritable: marksRead.writable });
    return result;
  }

  function read(id) {
    if (typeof id !== 'string' || !FEED_ID.test(id)) return Promise.reject(new FeedsError('no_such_feed'));
    if (!inFlight.has(id)) {
      const run = load(id).catch((error) => {
        if (error instanceof FeedsError) throw error;
        log({ event: 'feeds_read_error', path: id, error: error?.message ?? String(error) });
        return deepFreeze({ feed: null, readAt: now().toISOString(), problems: ['The feed could not be read.'], runs: [] });
      }).finally(() => inFlight.delete(id));
      inFlight.set(id, run);
    }
    return inFlight.get(id);
  }

  async function find(feedId, itemId) {
    await read(feedId);
    return caches.get(feedId)?.index.get(itemId) ?? null;
  }

  function create({ name, note } = {}) {
    return serialized(async () => {
      if (!validName(name)) throw invalid(`name must be 1 to ${NAME_MAX} characters on one line`);
      if (typeof note !== 'string') throw invalid('note must be a string');
      if (Buffer.byteLength(note, 'utf8') > limits.feedNoteBytes) throw new FeedsError('note_too_large');
      const taken = new Set(await folders());
      const stem = slug(name.trim(), 'feed');
      let id = stem;
      for (let suffix = 2; taken.has(id); suffix += 1) id = `${stem.slice(0, 63 - String(suffix).length)}-${suffix}`;
      const { feeds } = await list();
      const oldest = [...feeds].sort((a, b) => compare(a.created, b.created))[0];
      const defaults = (await sources.list()).filter((source) => source.default === true).map((source) => source.id);
      const at = now().toISOString();
      const feed = ordered({
        version: 1, id, name: name.trim(), producer: oldest?.producer ?? DEFAULT_PRODUCER, sources: defaults, active: true, created: at, updated: at,
      });
      await mkdir(itemsDir(id), { recursive: true, mode: 0o700 });
      await atomicJson(noteFile(id), note);
      await atomicJson(feedFile(id), feed);
      log({ event: 'feed_created', feed: id });
      return feed;
    });
  }

  function update(id, fields) {
    return serialized(async () => {
      if (!isRecord(fields) || Object.keys(fields).length === 0) throw invalid('the body names no field');
      for (const key of Object.keys(fields)) if (!['name', 'sources', 'active'].includes(key)) throw invalid(`unknown field "${key}"`);
      if ('name' in fields && !validName(fields.name)) throw invalid(`name must be 1 to ${NAME_MAX} characters on one line`);
      if ('active' in fields && typeof fields.active !== 'boolean') throw invalid('active must be true or false');
      const ids = fields.sources;
      if ('sources' in fields && (!Array.isArray(ids) || !ids.every(nonEmpty) || new Set(ids).size !== ids.length)) {
        throw invalid('sources must be a list of source ids without repeats');
      }
      const next = { ...(await requireFeed(id)) };
      if ('name' in fields) next.name = fields.name.trim();
      if ('active' in fields) next.active = fields.active;
      if ('sources' in fields) {
        const known = new Set((await sources.list()).map((source) => source.id));
        const unknown = ids.filter((source) => !known.has(source));
        if (unknown.length > 0) throw new FeedsError('unknown_source', { sources: unknown });
        next.sources = [...ids];
      }
      next.updated = now().toISOString();
      const feed = ordered(next);
      await atomicJson(feedFile(id), feed);
      return feed;
    });
  }

  async function readNote(id) {
    await requireFeed(id);
    const problems = [];
    const text = await readCapped(noteFile(id), limits.feedNoteBytes, 'note.md', problems, (error) => {
      log({ event: 'feeds_read_error', path: `${id}/note.md`, error: error?.message ?? String(error) });
    });
    if (text === null) return { text: '', updated: null };
    const stats = await lstat(noteFile(id)).catch(() => null);
    return { text, updated: stats ? stats.mtime.toISOString() : null };
  }

  function writeNote(id, text) {
    return serialized(async () => {
      if (typeof text !== 'string') throw invalid('text must be a string');
      if (Buffer.byteLength(text, 'utf8') > limits.feedNoteBytes) throw new FeedsError('note_too_large');
      await requireFeed(id);
      await atomicJson(noteFile(id), text);
      return readNote(id);
    });
  }

  function mark(feedId, itemId, status) {
    if (!MARKS.has(status)) return Promise.reject(invalid('status must be saved or dismissed'));
    return writeMark(feedId, itemId, (marks) => ({ ...marks, [itemId]: { status, at: now().toISOString() } }));
  }

  function unmark(feedId, itemId) {
    return writeMark(feedId, itemId, (marks) => {
      const next = { ...marks };
      delete next[itemId];
      return next;
    });
  }

  function writeMark(feedId, itemId, change) {
    return serialized(async () => {
      await read(feedId);
      const cache = caches.get(feedId);
      if (!cache?.marksWritable) throw new FeedsError('marks_invalid');
      if (!cache.index.has(itemId)) throw new FeedsError('no_such_item');
      await atomicJson(marksFile(feedId), { version: 1, marks: change(cache.marks) });
      return read(feedId);
    });
  }

  async function usedBy(sourceId) {
    const { feeds } = await list();
    return feeds.filter((feed) => feed.sources.includes(sourceId)).map((feed) => feed.id);
  }

  async function readSuggestions(id) {
    const feed = await requireFeed(id);
    const problems = [];
    const name = `${id}/suggestions.json`;
    const missing = (await statOf(suggestionsFile(id))).kind === 'missing';
    if (missing) return null;
    const text = await readCapped(suggestionsFile(id), limits.sourceFileBytes, name, problems, (error) => {
      log({ event: 'feeds_read_error', path: name, error: error?.message ?? String(error) });
    });
    const bad = (reason) => {
      log({ event: 'feed_suggestions_invalid', feed: id, reason });
      return null;
    };
    if (text === null) return bad(problems[0] ?? 'unreadable');
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return bad('not JSON');
    }
    const reason = suggestionsProblem(body);
    if (reason) return bad(reason);
    const known = new Map((await sources.list().catch(() => [])).map((source) => [source.id, source]));
    const listed = [];
    for (const entry of body.sources) {
      const source = known.get(entry.id);
      if (!source || source.active !== true || feed.sources.includes(entry.id)) continue;
      listed.push({ id: source.id, name: source.name, kind: source.kind, role: source.role, why: entry.why.trim() });
    }
    return deepFreeze({ at: body.at, sources: listed });
  }

  function clearSuggestions(id) {
    return serialized(async () => {
      await requireFeed(id);
      try {
        await unlink(suggestionsFile(id));
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    });
  }

  return { list, get, read, find, create, update, readNote, writeNote, mark, unmark, usedBy, readSuggestions, clearSuggestions };
}

// Why a parsed suggestions.json is not one, or null.
function suggestionsProblem(body) {
  if (!isRecord(body)) return 'not an object';
  for (const key of Object.keys(body)) if (!['version', 'at', 'sources'].includes(key)) return `unknown key "${key}"`;
  if (body.version !== 1) return 'version is not 1';
  if (!nonEmpty(body.at) || Number.isNaN(Date.parse(body.at))) return 'at is not a time';
  if (!Array.isArray(body.sources)) return 'sources is not a list';
  if (body.sources.length > SUGGESTIONS_MAX) return `more than ${SUGGESTIONS_MAX} sources`;
  const seen = new Set();
  for (const entry of body.sources) {
    if (!isRecord(entry) || Object.keys(entry).sort().join() !== 'id,why') return 'a source is not { id, why }';
    if (!nonEmpty(entry.id) || entry.id.length > 64) return 'a source id is not an id';
    if (seen.has(entry.id)) return `${entry.id} is listed twice`;
    seen.add(entry.id);
    const why = typeof entry.why === 'string' ? entry.why.trim() : '';
    if (why === '' || Array.from(why).length > WHY_MAX) return `the reason for ${entry.id} is not 1 to ${WHY_MAX} characters`;
  }
  return null;
}

// The items directory's matching entries, newest first by name, with each
// one's lstat; this is all the signature needs.
async function scanItems(dir, limits, log) {
  const problems = [];
  let entries = [];
  let state = 'ok';
  let failed = false;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    state = error.code === 'ENOENT' ? 'missing' : error.code === 'ENOTDIR' ? 'not-dir' : 'error';
    if (state === 'error') {
      failed = true;
      log({ event: 'feeds_read_error', path: dir, error: error?.message ?? String(error) });
    }
    problems.push(state === 'missing' ? 'The feed has no items folder.'
      : state === 'not-dir' ? 'The feed\'s items folder is not a folder.' : 'The feed\'s items folder could not be read.');
  }
  const names = entries.filter((entry) => FILE_NAME.test(entry.name)).map((entry) => entry.name).sort(compare).reverse();
  if (names.length > limits.feedFiles) {
    problems.push(`The feed has ${names.length} files; only the newest ${limits.feedFiles} are shown.`);
  }
  const files = [];
  for (const name of names.slice(0, limits.feedFiles)) files.push({ name, stats: await statOf(path.join(dir, name)) });
  return { state, files, problems, failed };
}

async function statOf(file) {
  try {
    const stats = await lstat(file);
    return { kind: stats.isFile() ? 'file' : 'other', mtimeMs: stats.mtimeMs, size: stats.size };
  } catch (error) {
    return { kind: error.code === 'ENOENT' || error.code === 'ENOTDIR' ? 'missing' : 'error', code: error.code ?? null };
  }
}

async function readMarks(file, stats, max, problems, fail) {
  if (stats.kind === 'missing') return { value: {}, writable: true };
  const text = await readCapped(file, max, 'marks.json', problems, (error) => fail('marks.json', error));
  if (text === null) return { value: {}, writable: false };
  try {
    const body = JSON.parse(text);
    if (!isRecord(body) || !isRecord(body.marks)) throw new Error('shape');
    const marks = {};
    for (const [id, mark] of Object.entries(body.marks)) {
      if (id === '' || id.length > ITEM_ID_MAX || !isRecord(mark) || !MARKS.has(mark.status) || typeof mark.at !== 'string') continue;
      marks[id] = { status: mark.status, at: mark.at };
    }
    return { value: marks, writable: true };
  } catch {
    problems.push('marks.json is not a feed marks file.');
    return { value: {}, writable: false };
  }
}

// One run from a file's text, or null with a problem pushed. Items that are
// not the expected shape are left out and counted; every kept item goes
// into `index`, a dismissed one too, and only the others into the run.
function parseRun(text, name, { id: feedId, byName, marks, problems, index }) {
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    problems.push(`${name} is not JSON.`);
    return null;
  }
  if (!isRecord(body) || !nonEmpty(body.producer) || !nonEmpty(body.date) || !Array.isArray(body.items)) {
    problems.push(`${name} is not a feed run.`);
    return null;
  }
  const { producer, date } = body;
  const items = [];
  let skipped = 0;
  for (const [position, entry] of body.items.entries()) {
    const sourceIds = isRecord(entry) ? itemSources(entry, byName) : null;
    if (!isRecord(entry) || !nonEmpty(entry.id) || entry.id.length > ITEM_ID_MAX || !nonEmpty(entry.title) ||
        !nonEmpty(entry.url) || !URL_SCHEME.test(entry.url) || !nonEmpty(entry.summary) || !sourceIds || index.has(entry.id)) {
      skipped += 1;
      continue;
    }
    const mark = marks[entry.id];
    const item = {
      id: entry.id,
      title: entry.title,
      sources: sourceIds,
      url: entry.url,
      summary: entry.summary,
      takeaway: capped(entry.takeaway, TAKEAWAY_MAX),
      insights: capped(entry.insights, INSIGHTS_MAX),
      kept: entry.kept === true,
      image: nonEmpty(entry.image) && URL_SCHEME.test(entry.image) ? entry.image : null,
      status: mark?.status === 'saved' ? 'saved' : 'new',
      position,
    };
    index.set(item.id, Object.freeze({ ...item, status: mark?.status ?? 'new', feed: feedId, producer, date }));
    if (mark?.status !== 'dismissed') items.push(item);
  }
  if (skipped > 0) problems.push(`${name} has ${skipped} ${skipped === 1 ? 'item' : 'items'} that could not be shown.`);
  return {
    id: name.slice(0, -'.json'.length),
    producer,
    date,
    since: nonEmpty(body.since) ? body.since : null,
    generatedAt: nonEmpty(body.generated_at) ? body.generated_at : null,
    read: Array.isArray(body.read) ? body.read.filter(nonEmpty) : [],
    items,
  };
}

// An item's sources as ids: its `sources` list, or its old `source` string
// split into names, each mapped to a source id by name or kept as written.
function itemSources(entry, byName) {
  if (Array.isArray(entry.sources)) return entry.sources.length > 0 && entry.sources.every(nonEmpty) ? [...new Set(entry.sources)] : null;
  if (!nonEmpty(entry.source)) return null;
  const names = entry.source.split(/[/,]/).map((part) => part.trim()).filter(Boolean);
  if (names.length === 0) return null;
  return [...new Set(names.map((part) => byName.get(part.toLowerCase()) ?? part))];
}

function capped(value, max) {
  return nonEmpty(value) && Array.from(value).length <= max ? value : null;
}

function ordered(value) {
  const out = {};
  for (const key of KEY_ORDER) if (key in value) out[key] = value[key];
  return out;
}

function validName(value) {
  return typeof value === 'string' && value.trim() !== '' && !/[\r\n]/.test(value) && Array.from(value.trim()).length <= NAME_MAX;
}

function invalid(detail) {
  return new FeedsError('invalid_body', { detail });
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmpty(value) {
  return typeof value === 'string' && value !== '';
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function compare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}
