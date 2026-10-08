// Instructions: a markdown file an agent follows (the Ideas criteria, the
// brief's rules), read on demand for a view as prose. The module never
// writes and runs nothing on a timer. server.mjs binds the Ideas criteria
// to it, and brief-instructions.mjs the brief's rules.
//
// createInstructions({ file, path, maxBytes, label, event, log }) returns:
//
//   read() -> Promise<result>
//     Never rejects. Cached by the file's lstat (type, mtimeMs, size): when
//     it is unchanged the last result object is returned without reading.
//
//     result, deeply frozen:
//       { path, updated, problem, blocks }
//     - `path` is the label the view shows for the file (the `path`
//       option).
//     - `updated` is the file's modification time as ISO, or null.
//     - `blocks` are the markdown parsed by goals-markdown.mjs into the
//       shapes the Goals view renders: { type: 'p', text }, { type: 'h',
//       text }, { type: 'list', ordered, items: [text] }, inline markup
//       flattened. A paragraph whose every line starts with `|` and whose
//       second line is a delimiter row is a table instead:
//       { type: 'table', head: [cell], rows: [[cell]] }.
//     - `problem` is null, or one sentence with `blocks` empty: a missing
//       file, one that is not a regular file, one over `maxBytes` (checked
//       from lstat and again on the bytes read), or one that could not be
//       read. The sentences name the file as "The <label> instructions
//       file".
//
// Unexpected read failures are logged as { event, error } (the `event`
// option) and are not cached, so the next read retries. A `log` that throws
// is ignored.

import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';

import { flatten, parseBlocks, splitLines } from './goals-markdown.mjs';

export function createInstructions({ file, path: shownPath, maxBytes, label, event, log: rawLog = () => {} }) {
  const log = (entry) => {
    try {
      rawLog(entry);
    } catch {
      // Logging must never make read() reject.
    }
  };
  const missing = `The ${label} instructions file is missing.`;
  const notFile = `The ${label} instructions file is not a regular file.`;
  const tooLarge = `The ${label} instructions file is larger than ${Math.floor(maxBytes / 1024)} KiB.`;
  const unreadable = `The ${label} instructions file could not be read.`;
  let cache = null; // { signature, result }

  function shaped(updated, problem, blocks = []) {
    return deepFreeze({ path: shownPath, updated, problem, blocks });
  }

  async function load() {
    let stats = null;
    let signature;
    try {
      stats = await lstat(file);
      signature = JSON.stringify([file, stats.isFile(), stats.mtimeMs, stats.size]);
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
      signature = JSON.stringify([file, 'missing']);
    }
    if (cache?.signature === signature) return cache.result;

    const updated = stats ? stats.mtime.toISOString() : null;
    let result;
    if (!stats) result = shaped(null, missing);
    else if (!stats.isFile()) result = shaped(updated, notFile);
    else if (stats.size > maxBytes) result = shaped(updated, tooLarge);
    else {
      const text = await readCapped(file, maxBytes);
      if (text === null) result = shaped(updated, tooLarge);
      else {
        const lines = splitLines(text);
        result = shaped(updated, null, parseBlocks(lines).map((block) => proseBlock(block, lines)));
      }
    }
    cache = { signature, result };
    return result;
  }

  async function read() {
    try {
      return await load();
    } catch (error) {
      log({ event, error: error?.message ?? String(error) });
      if (error?.code === 'ELOOP' || error?.code === 'EISDIR') return shaped(null, notFile);
      if (error?.code === 'ENOENT') return shaped(null, missing);
      return shaped(null, unreadable);
    }
  }

  return { read };
}

const DELIMITER_ROW = /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$/;

function proseBlock(block, lines) {
  if (block.type === 'list') {
    return { type: 'list', ordered: block.ordered, items: block.items.map((item) => flatten(item.raw)) };
  }
  if (block.type === 'p') {
    const rows = lines.slice(block.start, block.end + 1).map((line) => line.trim());
    if (rows.length >= 2 && rows.every((row) => row.startsWith('|')) && DELIMITER_ROW.test(rows[1])) {
      return { type: 'table', head: cells(rows[0]), rows: rows.slice(2).map(cells) };
    }
  }
  return { type: block.type, text: flatten(block.raw) };
}

// A table row's cells, flattened, without the outer pipes.
function cells(row) {
  return row.replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => flatten(cell));
}

// The file's text, or null when it holds more than maxBytes. Opened without
// following a symlink and read to at most one byte past the cap.
async function readCapped(file, maxBytes) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    return length > maxBytes ? null : buffer.subarray(0, length).toString('utf8');
  } finally {
    await handle.close().catch(() => {});
  }
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
