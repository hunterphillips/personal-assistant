// Feed: the runs the producers wrote to the feed store, read on demand for
// the Feed view. The store is a directory (config.feedDir, by default
// feed/items/ at the repo root; its README describes the files) of one JSON
// file per producer run, named <YYYY-MM-DD>-<producer>.json. The module never
// writes and runs nothing on a timer: the caller reads on demand.
//
// createFeed({ dir, agentId = 'watch', limits, log }) returns:
//
//   read() -> Promise<result>
//     Never rejects. Single-flight: calls made while a read is running share
//     it. Cached by signature: the directory and the lstat (type, mtimeMs,
//     size) of every file it lists. When the signature is unchanged the last
//     result object is returned without re-reading any file.
//
//     result, deeply frozen:
//       { agentId, readAt, problems: [sentence],
//         runs: [{ id, producer, date, since, generatedAt,
//                  items: [{ id, title, source, url, summary, test, kept, image }] }] }
//     - `agentId` is the persona Discuss sends to; the routes check the
//       registry for it.
//     - Runs are the files whose names match, regular files only, newest
//       first by name, at most limits.feedFiles; a run's `id` is its file
//       name without the extension.
//     - A file over limits.feedFileBytes (checked from lstat and again on the
//       bytes read), one that is not JSON, or one whose body is not an object
//       with `producer` and `date` as non-empty strings and `items` as a
//       list, is skipped with one problem sentence naming it. Within a run,
//       an item without `id`, `title`, `source`, `url`, and `summary` as
//       non-empty strings, with a `url` that is not http or https, or with
//       an id another item already used, is skipped, and the run's items
//       that were skipped are counted in one problem sentence. `kept` is a
//       boolean, false unless true; `test` is an integer or null; `image`
//       is an http or https URL or null, and never gets an item skipped;
//       `since` and `generatedAt` are strings or null.
//     - A missing directory is one problem and no runs; more files than
//       limits.feedFiles is one problem naming the count.
//
//   find(id) -> Promise<item | null>
//     Reads (through the cache) and returns the item with that id, with its
//     run's `producer` and `date` added, or null. When the latest read failed
//     outright, it answers from the last good one.
//
// Unexpected read failures (anything but a missing path or a non-regular
// file) are logged as { event: 'feed_read_error', path, error } and become
// a problem sentence; a result with one is not cached, so the next read
// retries. A `log` that throws is ignored.

import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import path from 'node:path';

const FILE_NAME = /^\d{4}-\d{2}-\d{2}-[a-z][a-z0-9-]*\.json$/;
const URL_SCHEME = /^https?:\/\//i;

export function createFeed({ dir, agentId = 'watch', limits, log: rawLog = () => {} }) {
  const log = (entry) => {
    try {
      rawLog(entry);
    } catch {
      // Logging must never make read() reject.
    }
  };
  let cache = null; // { signature, result, index }
  let inFlight = null;

  async function load() {
    const scan = await scanDir(dir, limits, log);
    const signature = JSON.stringify([dir, scan.state, scan.files]);
    if (cache?.signature === signature) return cache.result;

    const problems = [...scan.problems];
    let failed = scan.failed;
    const fail = (name, error) => {
      failed = true;
      log({ event: 'feed_read_error', path: name, error: error?.message ?? String(error) });
    };
    const runs = [];
    const index = new Map();
    for (const file of scan.files) {
      const text = await readSource(dir, file.name, file.stats, limits.feedFileBytes, problems, fail);
      if (text === null) continue;
      const run = parseRun(text, file.name, problems, index);
      if (run) runs.push(run);
    }
    const result = deepFreeze({ agentId, readAt: new Date().toISOString(), problems, runs });
    // A null signature never matches, so a read that hit an error is retried.
    cache = { signature: failed ? null : signature, result, index };
    return result;
  }

  async function safeLoad() {
    try {
      return await load();
    } catch (error) {
      log({ event: 'feed_read_error', path: null, error: error?.message ?? String(error) });
      return deepFreeze({ agentId, readAt: new Date().toISOString(), problems: ['The feed could not be read.'], runs: [] });
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

  return { read, find };
}

// The directory's matching entries, newest first by name, with each one's
// lstat; this is all the signature needs.
async function scanDir(dir, limits, log) {
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
      log({ event: 'feed_read_error', path: dir, error: error?.message ?? String(error) });
    }
    problems.push(state === 'missing' ? 'The feed directory is missing.'
      : state === 'not-dir' ? 'The feed directory is not a directory.' : 'The feed directory could not be read.');
  }
  const names = entries.filter((entry) => FILE_NAME.test(entry.name)).map((entry) => entry.name)
    .sort(compareStrings).reverse();
  if (names.length > limits.feedFiles) {
    problems.push(`The feed has ${names.length} files; only the newest ${limits.feedFiles} are shown.`);
  }
  const files = [];
  for (const name of names.slice(0, limits.feedFiles)) {
    files.push({ name, stats: await statOf(path.join(dir, name)) });
  }
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

// The file's text, or null with a problem pushed. Opened without following
// a symlink and read to at most one byte past the cap.
async function readSource(dir, name, stats, maxBytes, problems, fail) {
  const tooLarge = `${name} is larger than ${Math.floor(maxBytes / 1024)} KiB.`;
  if (stats.kind === 'missing') return pushNull(problems, `${name} is missing.`);
  if (stats.kind === 'other') return pushNull(problems, `${name} is not a regular file.`);
  if (stats.kind === 'file' && stats.size > maxBytes) return pushNull(problems, tooLarge);
  let handle;
  try {
    handle = await open(path.join(dir, name), constants.O_RDONLY | constants.O_NOFOLLOW);
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > maxBytes) return pushNull(problems, tooLarge);
    return buffer.subarray(0, length).toString('utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return pushNull(problems, `${name} is missing.`);
    if (error.code === 'ELOOP' || error.code === 'EISDIR') return pushNull(problems, `${name} is not a regular file.`);
    fail(name, error);
    return pushNull(problems, `${name} could not be read.`);
  } finally {
    await handle?.close().catch(() => {});
  }
}

function pushNull(problems, sentence) {
  problems.push(sentence);
  return null;
}

// One run from a file's text, or null with a problem pushed. Items that
// are not the expected shape are left out and counted; each kept item goes
// into `index` under its id.
function parseRun(text, name, problems, index) {
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return pushNull(problems, `${name} is not JSON.`);
  }
  if (!isRecord(body) || !nonEmpty(body.producer) || !nonEmpty(body.date) || !Array.isArray(body.items)) {
    return pushNull(problems, `${name} is not a feed run.`);
  }
  const producer = body.producer;
  const date = body.date;
  const items = [];
  let skipped = 0;
  for (const entry of body.items) {
    if (!isRecord(entry) || !nonEmpty(entry.id) || !nonEmpty(entry.title) || !nonEmpty(entry.source) ||
        !nonEmpty(entry.url) || !URL_SCHEME.test(entry.url) || !nonEmpty(entry.summary) || index.has(entry.id)) {
      skipped += 1;
      continue;
    }
    const item = {
      id: entry.id,
      title: entry.title,
      source: entry.source,
      url: entry.url,
      summary: entry.summary,
      test: Number.isInteger(entry.test) ? entry.test : null,
      kept: entry.kept === true,
      image: nonEmpty(entry.image) && URL_SCHEME.test(entry.image) ? entry.image : null,
    };
    items.push(item);
    index.set(item.id, Object.freeze({ ...item, producer, date }));
  }
  if (skipped > 0) problems.push(`${name} has ${skipped} ${skipped === 1 ? 'item' : 'items'} that could not be shown.`);
  return {
    id: name.slice(0, -'.json'.length),
    producer,
    date,
    since: nonEmpty(body.since) ? body.since : null,
    generatedAt: nonEmpty(body.generated_at) ? body.generated_at : null,
    items,
  };
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

function compareStrings(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}
