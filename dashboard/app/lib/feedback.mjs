// Feedback contract, Markdown rendering, and atomic per-date writer.
//
// The overlay saves every item of one brief revision at once. The writer
// keeps two files beside the brief, both 0600: feedback-<date>.md, which the
// curator reads the next morning (each item under its section label, keyed
// by its id, with the paragraph's text quoted under the mark), and
// feedback-<date>.json, { date, revision, overall, items: [{ id, mark, note
// }], savedAt }, which the overlay reads back on its next open.

import { constants } from 'node:fs';
import { lstat, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

import { isCalendarDate } from './briefs.mjs';

// A saved JSON file larger than this is not ours; read() treats it as absent.
const MAX_SAVED_BYTES = 1024 * 1024;
const REVISION = /^[0-9a-f]{64}$/;
const MARKS = new Set(['approved', 'dismissed', null]);

export class FeedbackError extends Error {
  constructor(status, code, options) {
    super(code, options);
    this.name = 'FeedbackError';
    this.status = status;
    this.code = code;
  }
}

export function validateFeedbackRequest(value) {
  if (!isRecord(value) || !hasExactKeys(value, ['date', 'revision', 'overall', 'items'])) {
    throw new FeedbackError(400, 'invalid_feedback');
  }
  if (!isCalendarDate(value.date)) throw new FeedbackError(400, 'invalid_feedback_date');
  if (typeof value.revision !== 'string' || !REVISION.test(value.revision)) {
    throw new FeedbackError(400, 'invalid_feedback_revision');
  }
  if (typeof value.overall !== 'string') throw new FeedbackError(400, 'invalid_feedback_overall');
  if (characterCount(value.overall) > 8_000) throw new FeedbackError(413, 'feedback_too_large');
  if (!Array.isArray(value.items)) throw new FeedbackError(400, 'invalid_feedback_items');
  if (value.items.length > 200) throw new FeedbackError(413, 'feedback_too_large');

  const seen = new Set();
  const items = value.items.map((item) => {
    if (!isRecord(item) || !hasExactKeys(item, ['id', 'mark', 'note']) ||
        typeof item.id !== 'string' || typeof item.note !== 'string' || !MARKS.has(item.mark)) {
      throw new FeedbackError(400, 'invalid_feedback_item');
    }
    if (characterCount(item.note) > 4_000) throw new FeedbackError(413, 'feedback_too_large');
    if (seen.has(item.id)) throw new FeedbackError(400, 'duplicate_feedback_item');
    seen.add(item.id);
    return { id: item.id, mark: item.mark, note: item.note };
  });
  return { date: value.date, revision: value.revision, overall: value.overall, items };
}

export function validateFeedbackForArtifact(feedback, artifact) {
  const expected = new Set(artifact.items.map((item) => item.id));
  if (feedback.items.length !== expected.size || feedback.items.some((item) => !expected.has(item.id))) {
    throw new FeedbackError(400, 'feedback_items_mismatch');
  }
  return feedback;
}

export function renderFeedbackMarkdown(artifact, feedback) {
  const values = new Map(feedback.items.map((item) => [item.id, item]));
  const lines = [`# Brief feedback for ${artifact.date}`, ''];
  const overall = normalizeNewlines(feedback.overall).trim();
  if (overall) lines.push('## Overall', '', overall, '');
  let section = null;
  for (const item of artifact.items) {
    if (item.section !== section) {
      if (section !== null) lines.push('');
      section = item.section;
      lines.push(`## ${section}`, '');
    }
    const value = values.get(item.id);
    const tag = value.mark === 'approved' ? 'APPROVED' : value.mark === 'dismissed' ? 'DISMISSED' : 'no mark';
    lines.push(`- ${item.id}: ${tag}`);
    for (const textLine of normalizeNewlines(item.text).split('\n')) lines.push(textLine ? `  > ${textLine}` : '  >');
    if (value.note.trim()) {
      const noteLines = normalizeNewlines(value.note).split('\n');
      lines.push(`  - note: ${noteLines[0]}`);
      for (const noteLine of noteLines.slice(1)) lines.push(`    ${noteLine}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

// What the overlay reads back: the request as validated, and when it landed.
export function savedFeedbackRecord(feedback, savedAt) {
  return {
    date: feedback.date,
    revision: feedback.revision,
    overall: feedback.overall,
    items: feedback.items.map((item) => ({ id: item.id, mark: item.mark, note: item.note })),
    savedAt,
  };
}

// Runs tasks one at a time per key, in call order. The Brief routes wrap the
// whole load, validate, and write sequence in it so a later save for a date
// always lands after an earlier one.
export function createKeyedQueue() {
  const chains = new Map();
  return function run(key, task) {
    const previous = chains.get(key) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(task);
    chains.set(key, current);
    return current.finally(() => {
      if (chains.get(key) === current) chains.delete(key);
    });
  };
}

// The writer is not serialized itself; callers use createKeyedQueue.
export function createFeedbackWriter(briefsDir, operations = {}) {
  const root = path.resolve(briefsDir);
  const fs = { lstat, open, rename, unlink, ...operations };

  return {
    // The JSON goes first: a Markdown file the curator reads always has a
    // read-back copy beside it, and a failure between the two leaves only a
    // draft the next save replaces.
    async save(date, markdown, record) {
      if (!isCalendarDate(date)) throw new FeedbackError(400, 'invalid_feedback_date');
      if (record !== undefined) await atomicWrite(root, date, `feedback-${date}.json`, `${JSON.stringify(record, null, 2)}\n`, fs);
      return atomicWrite(root, date, `feedback-${date}.md`, markdown, fs);
    },
    // The saved record for a date, or null when there is none or it is not
    // one the writer would have written.
    async read(date) {
      if (!isCalendarDate(date)) throw new FeedbackError(400, 'invalid_feedback_date');
      const target = containedFile(root, `feedback-${date}.json`);
      let handle;
      try {
        handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
        const stats = await handle.stat();
        if (!stats.isFile() || stats.size > MAX_SAVED_BYTES) return null;
        return parseSavedFeedback(await handle.readFile('utf8'), date);
      } catch (error) {
        if (error?.code === 'ENOENT' || error?.code === 'ELOOP') return null;
        throw new FeedbackError(500, 'feedback_read_failed', { cause: error });
      } finally {
        await handle?.close().catch(() => {});
      }
    },
  };
}

export function parseSavedFeedback(text, date) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(value) || typeof value.savedAt !== 'string') return null;
  const { savedAt, ...request } = value;
  try {
    const feedback = validateFeedbackRequest(request);
    return feedback.date === date ? savedFeedbackRecord(feedback, savedAt) : null;
  } catch {
    return null;
  }
}

async function atomicWrite(root, date, targetName, contents, fs) {
  const target = containedFile(root, targetName);
  let targetStats;
  try {
    targetStats = await fs.lstat(target);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw new FeedbackError(500, 'feedback_write_failed', { cause: error });
  }
  if (targetStats && (!targetStats.isFile() || targetStats.isSymbolicLink())) {
    throw new FeedbackError(500, 'feedback_write_failed');
  }

  // `created` is set only after this request's exclusive open succeeds, so
  // cleanup never unlinks a path some other process owns.
  let created = null;
  let handle;
  try {
    for (let attempt = 0; attempt < 8 && !handle; attempt += 1) {
      const suffix = randomBytes(12).toString('hex');
      const candidate = containedFile(root, `.${targetName}.${process.pid}.${suffix}.tmp`);
      try {
        handle = await fs.open(candidate, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        created = candidate;
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
      }
    }
    if (!handle) throw new Error('temporary file collision');
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(created, target);
    created = null;
  } catch (error) {
    await handle?.close().catch(() => {});
    if (created) await fs.unlink(created).catch(() => {});
    if (error instanceof FeedbackError) throw error;
    throw new FeedbackError(500, 'feedback_write_failed', { cause: error });
  }
}

function containedFile(root, name) {
  const file = path.resolve(root, name);
  if (path.dirname(file) !== root || path.basename(file) !== name) throw new FeedbackError(500, 'feedback_write_failed');
  return file;
}

function normalizeNewlines(value) {
  return value.replace(/\r\n?/g, '\n');
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
