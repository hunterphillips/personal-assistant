// Ideas: producer runs plus the marks and manual ideas the dashboard writes.
// Reads never reject. Files are indexed oldest first so the first occurrence
// of an id owns it across the store, while only the newest feedFiles runs are
// returned. A run may carry `week`, the Monday it was written for; otherwise
// its week is the Monday of its `date`. add(), mark(), unmark(), and
// replaceWeek() share one serialized, atomic write queue.

import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

import { defaultAgentId } from './builtins.mjs';

const FILE_NAME = /^\d{4}-\d{2}-\d{2}-[a-z][a-z0-9-]*\.json$/;
const ID = /^[a-z0-9][a-z0-9-]{0,79}$/;
const URL = /^https?:\/\//i;
const KINDS = new Set(['workflow', 'view', 'app', 'tool', 'skill', 'plugin', 'agent']);
const MARKS = new Set(['taken', 'dismissed', 'saved', 'replaced']);
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const HIDDEN = new Set(['dismissed', 'replaced']);

export class IdeasError extends Error {
  constructor(code) {
    super(code);
    this.name = 'IdeasError';
    this.code = code;
  }
}

export function createIdeas({ dir, marksFile, limits, zone, log: rawLog = () => {}, now = () => new Date() }) {
  const log = (entry) => { try { rawLog(entry); } catch {} };
  let cache = null; // { signature, result, index, ids, marks }
  let inFlight = null;
  let writing = null;

  function serialized(task) {
    const run = (writing ?? Promise.resolve()).then(task, task);
    writing = run.catch(() => {}).finally(() => { if (writing === run) writing = null; });
    return run;
  }

  async function load() {
    const scan = await scanStore(dir, marksFile, log);
    const signature = JSON.stringify([dir, marksFile, scan.state, scan.files, scan.marksStats]);
    if (cache?.signature === signature) return cache.result;
    const problems = [...scan.problems];
    let failed = scan.failed;
    const fail = (file, error) => {
      failed = true;
      log({ event: 'ideas_read_error', path: file, error: error?.message ?? String(error) });
    };
    const marksRead = await readMarks(marksFile, scan.marksStats, limits.ideasFileBytes, problems, fail);
    const marks = marksRead.value;
    const ids = new Set();
    const index = new Map();
    const allRuns = [];
    const shownNames = new Set(scan.files.slice(-limits.feedFiles).map((file) => file.name));
    const runs = [];
    for (const file of scan.files) {
      const text = await readSource(dir, file.name, file.stats, limits.ideasFileBytes, problems, fail);
      if (text === null) continue;
      const run = parseRun(text, file.name, limits, ids, marks, problems, index);
      if (run) {
        allRuns.push(run);
        if (shownNames.has(file.name)) runs.push(run);
      }
    }
    if (scan.files.length > limits.feedFiles) {
      problems.push(`The ideas store has ${scan.files.length} files; only the newest ${limits.feedFiles} are shown.`);
    }
    const shown = runs.reverse();
    const result = deepFreeze({ readAt: new Date().toISOString(), problems, runs: shown });
    cache = { signature: failed ? null : signature, result, index, ids, marks, marksWritable: marksRead.writable, allRuns };
    return result;
  }

  async function safeLoad() {
    try { return await load(); } catch (error) {
      log({ event: 'ideas_read_error', path: null, error: error?.message ?? String(error) });
      return deepFreeze({ readAt: new Date().toISOString(), problems: ['The ideas store could not be read.'], runs: [] });
    }
  }

  function read() {
    if (!inFlight) inFlight = safeLoad().finally(() => { inFlight = null; });
    return inFlight;
  }

  async function find(id) {
    await read();
    return cache?.index.get(id) ?? null;
  }

  function mark(id, { status, agent = null }) {
    return serialized(async () => {
      await read();
      if (!cache?.marksWritable) throw new IdeasError('marks_invalid');
      if (!cache?.index.has(id)) throw new IdeasError('no_such_item');
      // Checked inside the write queue so a Start that lands first is kept.
      if (status === 'saved' && cache.index.get(id).status === 'taken') throw new IdeasError('already_started');
      const marks = { ...cache.marks, [id]: {
        status, at: now().toISOString(), ...(status === 'taken' && agent ? { agent } : {}),
      } };
      await atomicJson(marksFile, marks);
      await read();
      return cache.index.get(id) ?? null;
    });
  }

  function unmark(id) {
    return serialized(async () => {
      await read();
      if (!cache?.marksWritable) throw new IdeasError('marks_invalid');
      if (!cache?.index.has(id)) throw new IdeasError('no_such_item');
      // A Start from another tab outranks a stale Unsave.
      if (cache.index.get(id).status === 'taken') throw new IdeasError('already_started');
      const marks = { ...cache.marks };
      delete marks[id];
      await atomicJson(marksFile, marks);
      await read();
      return cache.index.get(id) ?? null;
    });
  }

  function add(value) {
    return serialized(async () => {
      await read();
      if (!cache?.marksWritable) throw new IdeasError('marks_invalid');
      const newline = value.indexOf('\n');
      const title = newline === -1 ? value : value.slice(0, newline);
      const text = newline === -1 ? '' : value.slice(newline + 1);
      const taken = new Set([...cache?.ids ?? [], ...Object.keys(cache?.marks ?? {})]);
      const stem = slug(title);
      let id = stem;
      for (let suffix = 2; taken.has(id); suffix += 1) id = `${stem.slice(0, 79 - String(suffix).length)}-${suffix}`;
      const date = monday(now(), zone);
      const file = path.join(dir, `${date}-manual.json`);
      let body = { producer: 'manual', date, generated_at: now().toISOString(), items: [] };
      try {
        body = await readManual(file, limits.ideasFileBytes, date);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      const entry = { id, title, text, kind: null, agents: [], source: null };
      body = { ...body, producer: 'manual', date, items: [...(Array.isArray(body.items) ? body.items : []), entry] };
      if (Buffer.byteLength(`${JSON.stringify(body, null, 2)}\n`, 'utf8') > limits.ideasFileBytes) {
        throw new IdeasError('ideas_file_full');
      }
      await atomicJson(file, body);
      await read();
      return cache.index.get(id);
    });
  }

  // Retires `week`'s produced ideas that are still new with a `replaced`
  // mark, in one write; saved, taken, and Hunter's own ideas keep theirs.
  // Resolves with the retired ids and the week's saved ideas.
  function replaceWeek(week) {
    return serialized(async () => {
      await read();
      if (!cache?.marksWritable) throw new IdeasError('marks_invalid');
      const inWeek = [...cache.index.values()].filter((entry) => entry.week === week && entry.producer !== 'manual');
      const replaced = inWeek.filter((entry) => entry.status === 'new').map((entry) => entry.id);
      const saved = inWeek.filter((entry) => entry.status === 'saved').map(({ id, title }) => ({ id, title }));
      if (replaced.length > 0) {
        const at = now().toISOString();
        const marks = { ...cache.marks };
        for (const id of replaced) marks[id] = { status: 'replaced', at };
        await atomicJson(marksFile, marks);
        await read();
      }
      return { replaced, saved };
    });
  }

  async function producerAgent(agents) {
    await read();
    const listed = new Set((agents ?? []).filter((agent) => agent.kind === 'persona' && agent.provider === 'claude').map((agent) => agent.id));
    return [...(cache?.allRuns ?? [])].reverse().find((run) => listed.has(run.producer))?.producer ?? defaultAgentId(agents);
  }

  return { read, find, mark, unmark, add, replaceWeek, producerAgent };
}

async function scanStore(dir, marksFile, log) {
  const problems = [];
  let entries = [];
  let state = 'ok';
  let failed = false;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch (error) {
    state = error.code === 'ENOENT' ? 'missing' : error.code === 'ENOTDIR' ? 'not-dir' : 'error';
    if (state === 'error') { failed = true; log({ event: 'ideas_read_error', path: dir, error: error.message }); }
    problems.push(state === 'missing' ? 'The ideas directory is missing.'
      : state === 'not-dir' ? 'The ideas directory is not a directory.' : 'The ideas directory could not be read.');
  }
  const names = entries.filter((entry) => FILE_NAME.test(entry.name)).map((entry) => entry.name).sort();
  const files = [];
  for (const name of names) files.push({ name, stats: await statOf(path.join(dir, name)) });
  return { state, files, marksStats: await statOf(marksFile), problems, failed };
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
  const text = await readFileCapped(file, stats, max, 'marks.json', problems, fail);
  if (text === null) return { value: {}, writable: false };
  try {
    const value = JSON.parse(text);
    if (!isRecord(value)) throw new Error('shape');
    const marks = {};
    for (const [id, mark] of Object.entries(value)) {
      if (!ID.test(id) || !isRecord(mark) || !MARKS.has(mark.status) || typeof mark.at !== 'string') continue;
      marks[id] = { status: mark.status, at: mark.at, ...(typeof mark.agent === 'string' ? { agent: mark.agent } : {}) };
    }
    return { value: marks, writable: true };
  } catch {
    problems.push('marks.json is not an ideas marks file.');
    return { value: {}, writable: false };
  }
}

async function readManual(file, max, date) {
  const stats = await lstat(file);
  if (!stats.isFile() || stats.size > max) throw new IdeasError('ideas_file_full');
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const buffer = Buffer.alloc(max + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > max) throw new IdeasError('ideas_file_full');
    const body = JSON.parse(buffer.subarray(0, length).toString('utf8'));
    if (!isRecord(body) || body.producer !== 'manual' || body.date !== date || !Array.isArray(body.items)) {
      throw new IdeasError('ideas_file_invalid');
    }
    return body;
  } catch (error) {
    if (error instanceof IdeasError) throw error;
    throw new IdeasError('ideas_file_invalid');
  } finally { await handle.close().catch(() => {}); }
}

async function readSource(dir, name, stats, max, problems, fail) {
  return readFileCapped(path.join(dir, name), stats, max, name, problems, fail);
}

async function readFileCapped(file, stats, max, name, problems, fail) {
  const tooLarge = `${name} is larger than ${Math.floor(max / 1024)} KiB.`;
  if (stats.kind === 'missing') return pushNull(problems, `${name} is missing.`);
  if (stats.kind === 'other') return pushNull(problems, `${name} is not a regular file.`);
  if (stats.kind === 'file' && stats.size > max) return pushNull(problems, tooLarge);
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const buffer = Buffer.alloc(max + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    return length > max ? pushNull(problems, tooLarge) : buffer.subarray(0, length).toString('utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return pushNull(problems, `${name} is missing.`);
    if (error.code === 'ELOOP' || error.code === 'EISDIR') return pushNull(problems, `${name} is not a regular file.`);
    fail(name, error);
    return pushNull(problems, `${name} could not be read.`);
  } finally { await handle?.close().catch(() => {}); }
}

function parseRun(text, name, limits, ids, marks, problems, index) {
  let body;
  try { body = JSON.parse(text); } catch { return pushNull(problems, `${name} is not JSON.`); }
  if (!isRecord(body) || !nonEmpty(body.producer) || !nonEmpty(body.date) || !Array.isArray(body.items) ||
      (Object.hasOwn(body, 'week') && !nonEmpty(body.week))) {
    return pushNull(problems, `${name} is not an ideas run.`);
  }
  const week = body.week ?? weekOf(body.date);
  const items = [];
  let skipped = 0;
  for (const entry of body.items) {
    const entryId = isRecord(entry) && ID.test(entry.id ?? '') ? entry.id : null;
    const duplicate = entryId !== null && ids.has(entryId);
    if (entryId !== null && !duplicate) ids.add(entryId);
    const valid = entryId !== null && !duplicate && nonEmpty(entry.title) &&
      (body.producer === 'manual' || Array.from(entry.title).length <= limits.ideaTitleChars) && typeof entry.text === 'string' &&
      (body.producer === 'manual' || entry.text !== '') &&
      Object.hasOwn(entry, 'kind') && (entry.kind === null || typeof entry.kind === 'string') &&
      Array.isArray(entry.agents) && entry.agents.every(nonEmpty) &&
      (entry.source === null || (nonEmpty(entry.source) && URL.test(entry.source)));
    if (!valid) { skipped += 1; continue; }
    const mark = marks[entry.id];
    if (HIDDEN.has(mark?.status)) continue;
    const item = {
      id: entry.id, title: entry.title, text: entry.text, kind: KINDS.has(entry.kind) ? entry.kind : null,
      agents: [...entry.agents], source: entry.source,
      status: mark?.status === 'taken' || mark?.status === 'saved' ? mark.status : 'new', ...(mark?.status === 'taken' && mark.agent ? { agent: mark.agent } : {}),
    };
    items.push(item);
    index.set(item.id, Object.freeze({ ...item, producer: body.producer, date: body.date, week }));
  }
  if (skipped) problems.push(`${name} has ${skipped} ${skipped === 1 ? 'item' : 'items'} that could not be shown.`);
  return { id: name.slice(0, -5), producer: body.producer, date: body.date, ...(body.week !== undefined ? { week: body.week } : {}), items };
}

async function atomicJson(file, value) {
  const root = path.dirname(file);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const tmp = path.join(root, `.${path.basename(file)}.${randomBytes(6).toString('hex')}.tmp`);
  const handle = await open(tmp, 'wx', 0o600);
  try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8'); await handle.sync(); } finally { await handle.close(); }
  try { await rename(tmp, file); } catch (error) { await unlink(tmp).catch(() => {}); throw error; }
}

function monday(date, zone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date).filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]));
  const noon = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, 12));
  const offset = (noon.getUTCDay() + 6) % 7;
  noon.setUTCDate(noon.getUTCDate() - offset);
  return noon.toISOString().slice(0, 10);
}

// The Monday of a YYYY-MM-DD date as the view reckons it, by the calendar;
// any other text is its own week.
function weekOf(date) {
  const noon = DAY.test(date) ? new Date(`${date}T12:00:00Z`) : null;
  return noon && !Number.isNaN(noon.getTime()) ? monday(noon, 'UTC') : date;
}

function slug(title) {
  const value = title.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80).replace(/-+$/g, '');
  return value || 'idea';
}

function pushNull(problems, sentence) { problems.push(sentence); return null; }
function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function nonEmpty(value) { return typeof value === 'string' && value !== ''; }
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
