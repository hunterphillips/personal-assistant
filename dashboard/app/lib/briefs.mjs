// Filesystem boundary and shape check for the Daily Brief's data. The morning
// run (daily-brief/briefs/build.py) writes brief-<date>.json beside the
// viewer page it keeps for the record; the dashboard reads only the JSON and
// renders it as the overlay. A date that has a viewer but no JSON (a brief
// from before the data existed, or a run that stopped between the two) is
// newer than any JSON and reported as missing, never skipped for an older
// date.
//
// selectLatestBrief(dir) -> { date, hasData } | null
//   The newest date among brief-<date>.json and viewer-<date>.html regular
//   files; `hasData` says whether that date has its JSON.
//
// loadBrief(dir, date, { expectedRevision, signal })
//   -> { date, revision, title, words, opening, sections, items }
//   Reads brief-<date>.json without following links, at most MAX_BRIEF_BYTES,
//   and checks its shape (validateBriefData). The revision is the SHA-256 of
//   the file's bytes; the run writes no revision of its own. `items` is every
//   item in reading order, the opening first, each { id, section, text },
//   where `section` is the section's label ('Opening' for the opening): what
//   the feedback writer keys and labels its lines by. Throws BriefArtifactError
//   with a state word the snapshot carries: unreadable (brief_not_found,
//   brief_unreadable), oversized, unsupported (invalid_brief, revision
//   conflicts).

import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const MAX_BRIEF_BYTES = 2 * 1024 * 1024;
// The feedback route's own cap (feedback.mjs) and build.py's ITEM_CAP.
export const MAX_ITEMS = 200;
export const MAX_SECTIONS = 20;
export const MAX_SECTION_ITEMS = 40;
export const MAX_TEXT_CHARS = 8000;
export const OPENING_LABEL = 'Opening';

const DATA_NAME = /^brief-(\d{4}-\d{2}-\d{2})\.json$/;
const VIEWER_NAME = /^viewer-(\d{4}-\d{2}-\d{2})\.html$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ID = /^[a-z0-9][a-z0-9-]{0,127}$/;
const DATA_KEYS = ['date', 'title', 'words', 'opening', 'sections'];

export class BriefArtifactError extends Error {
  constructor(state, code, { date, revision, cause } = {}) {
    super(code, cause ? { cause } : undefined);
    this.name = 'BriefArtifactError';
    this.state = state;
    this.code = code;
    this.date = date;
    this.revision = revision;
  }
}

export function isCalendarDate(value) {
  const match = typeof value === 'string' ? DATE.exec(value) : null;
  if (!match) return false;
  const [year, month, day] = match.slice(1).map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

export async function selectLatestBrief(briefsDir, { signal } = {}) {
  signal?.throwIfAborted();
  const entries = await abortable(readdir(path.resolve(briefsDir), { withFileTypes: true }), signal);
  const data = new Set();
  let latest = null;
  for (const entry of entries) {
    signal?.throwIfAborted();
    if (!entry.isFile()) continue;
    const dataMatch = DATA_NAME.exec(entry.name);
    const match = dataMatch ?? VIEWER_NAME.exec(entry.name);
    if (!match || !isCalendarDate(match[1])) continue;
    if (dataMatch) data.add(match[1]);
    if (latest === null || match[1] > latest) latest = match[1];
  }
  signal?.throwIfAborted();
  return latest === null ? null : { date: latest, hasData: data.has(latest) };
}

export async function loadBrief(briefsDir, date, { expectedRevision, signal } = {}) {
  if (!isCalendarDate(date)) throw new BriefArtifactError('unsupported', 'invalid_brief_date', { date });
  signal?.throwIfAborted();
  const root = path.resolve(briefsDir);
  const filename = `brief-${date}.json`;
  const file = path.resolve(root, filename);
  if (path.dirname(file) !== root || path.basename(file) !== filename) {
    throw new BriefArtifactError('unsupported', 'invalid_brief_path', { date });
  }

  let handle;
  try {
    const pathStats = await abortable(lstat(file), signal);
    if (!pathStats.isFile() || pathStats.isSymbolicLink()) {
      throw new BriefArtifactError('unreadable', 'brief_not_found', { date });
    }
    handle = await openWithSignal(file, constants.O_RDONLY | constants.O_NOFOLLOW, signal);
  } catch (error) {
    if (error instanceof BriefArtifactError) throw error;
    if (error?.name === 'AbortError') throw error;
    if (error?.code === 'ENOENT' || error?.code === 'ELOOP' || error?.code === 'ENOTDIR') {
      throw new BriefArtifactError('unreadable', 'brief_not_found', { date, cause: error });
    }
    throw new BriefArtifactError('unreadable', 'brief_unreadable', { date, cause: error });
  }

  try {
    const stats = await abortable(handle.stat(), signal);
    if (!stats.isFile()) throw new BriefArtifactError('unreadable', 'brief_not_found', { date });
    if (stats.size > MAX_BRIEF_BYTES) throw new BriefArtifactError('oversized', 'brief_oversized', { date });
    const bytes = await readLimited(handle, stats.size, signal);
    const finalStats = await abortable(handle.stat(), signal);
    // The run renames a finished file into place, so a change mid-read means
    // a rebuild landed; the caller reads again rather than trusting a mix.
    if (bytes.length !== stats.size || finalStats.size !== stats.size || finalStats.mtimeMs !== stats.mtimeMs) {
      const code = expectedRevision === undefined ? 'brief_changed_during_read' : 'revision_conflict';
      throw new BriefArtifactError('unreadable', code, { date });
    }
    const revision = createHash('sha256').update(bytes).digest('hex');
    if (expectedRevision !== undefined && revision !== expectedRevision) {
      throw new BriefArtifactError('unsupported', 'revision_conflict', { date, revision });
    }
    let value;
    try {
      value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch (error) {
      throw new BriefArtifactError('unsupported', 'invalid_brief', { date, revision, cause: error });
    }
    try {
      return { revision, ...validateBriefData(value, date) };
    } catch (error) {
      if (error instanceof BriefArtifactError) error.revision ??= revision;
      throw error;
    }
  } finally {
    await handle.close().catch(() => {});
  }
}

// The shape build.py writes (data_for): { date, title, words, opening:
// { id: 'opening', text } | null, sections: [{ id, label, items: [{ id,
// text }] }] }. A brief that fails any check is refused whole, never shown
// in part. Unknown top-level keys are refused too, so a change to the run's
// output is noticed here rather than silently dropped.
export function validateBriefData(value, date) {
  const invalid = () => new BriefArtifactError('unsupported', 'invalid_brief', { date });
  if (!isRecord(value) || !hasExactKeys(value, DATA_KEYS)) throw invalid();
  if (value.date !== date) throw invalid();
  if (typeof value.title !== 'string' || characterCount(value.title) > 500) throw invalid();
  if (!Number.isSafeInteger(value.words) || value.words < 0) throw invalid();
  if (!Array.isArray(value.sections) || value.sections.length > MAX_SECTIONS) throw invalid();

  const ids = new Set();
  const items = [];
  let opening = null;
  if (value.opening !== null) {
    const item = checkItem(value.opening, ids, invalid);
    if (item.id !== 'opening') throw invalid();
    opening = item;
    items.push({ id: item.id, section: OPENING_LABEL, text: item.text });
  }
  const sectionIds = new Set();
  const sections = value.sections.map((section) => {
    if (!isRecord(section) || !hasExactKeys(section, ['id', 'label', 'items'])) throw invalid();
    if (typeof section.id !== 'string' || !ID.test(section.id) || sectionIds.has(section.id)) throw invalid();
    sectionIds.add(section.id);
    if (typeof section.label !== 'string' || !section.label.trim() || characterCount(section.label) > 200) throw invalid();
    if (!Array.isArray(section.items) || section.items.length > MAX_SECTION_ITEMS) throw invalid();
    const sectionItems = section.items.map((raw) => {
      const item = checkItem(raw, ids, invalid);
      items.push({ id: item.id, section: section.label, text: item.text });
      return item;
    });
    return { id: section.id, label: section.label, items: sectionItems };
  });
  if (items.length > MAX_ITEMS) throw invalid();
  return { date, title: value.title, words: value.words, opening, sections, items };
}

function checkItem(item, ids, invalid) {
  if (!isRecord(item) || !hasExactKeys(item, ['id', 'text'])) throw invalid();
  if (typeof item.id !== 'string' || !ID.test(item.id) || ids.has(item.id)) throw invalid();
  if (typeof item.text !== 'string' || !item.text.trim() || characterCount(item.text) > MAX_TEXT_CHARS) throw invalid();
  ids.add(item.id);
  return { id: item.id, text: item.text };
}

async function readLimited(handle, size, signal) {
  const target = Buffer.allocUnsafe(size);
  let total = 0;
  while (total < size) {
    signal?.throwIfAborted();
    const { bytesRead } = await abortable(handle.read(target, total, size - total, total), signal);
    if (bytesRead === 0) break;
    total += bytesRead;
  }
  return target.subarray(0, total);
}

function characterCount(value) {
  return [...value].length;
}

function hasExactKeys(value, expected) {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && expected.slice().sort().every((key, index) => key === keys[index]);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function abortable(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

function openWithSignal(file, flags, signal) {
  if (!signal) return open(file, flags);
  if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
  const opening = open(file, flags);
  return new Promise((resolve, reject) => {
    let aborted = false;
    const onAbort = () => {
      aborted = true;
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    opening.then((handle) => {
      signal.removeEventListener('abort', onAbort);
      if (aborted) handle.close().catch(() => {});
      else resolve(handle);
    }, (error) => {
      signal.removeEventListener('abort', onAbort);
      reject(error);
    });
  });
}
