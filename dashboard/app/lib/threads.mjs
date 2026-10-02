// Per-agent thread files: the session pointer, which is the one durable file
// a persona owns in this app, and a bounded message cache kept for display.
// Providers own transcripts; losing the pointer means the persona starts a
// fresh session, and losing the cache only empties the thread view.
//
//   <dir>/<agentId>.json    { "sessionId": "..." | null, "createdAt": "<ISO>",
//                             "model"?: "...", "effort"?: "..." }
//                           written atomically (exclusive temp file, fsync,
//                           rename), mode 0600. `model` and `effort` are the
//                           thread's own choice (runtime/claude.mjs setModel);
//                           a pointer may hold a choice before any session
//                           exists (sessionId null) but never neither.
//   <dir>/<agentId>.jsonl   one message per line, mode 0600:
//                           { role: 'user'|'assistant'|'system', text, at,
//                             truncated?: true, ...other JSON fields }
//                           A user message carries `from` (the agent that
//                           sent it) or `routine` ({ id, name }, the routine
//                           whose run sent it), never both; one with
//                           neither is Hunter's own.
//
// createThreadStore({ dir, limits, log }) returns:
//
//   readPointer(agentId) -> Promise<{ sessionId, createdAt, model?, effort? } | null>
//     null when the file is missing, or when it is not a valid pointer
//     (logged as { event: 'thread_pointer_invalid', agentId }). Any other
//     read error rejects, so a caller never mistakes an unreadable pointer
//     for no pointer and forks a new session over it. `model` is kept when
//     it is a string of at most 64 characters and `effort` when it is one
//     of models.mjs EFFORTS; anything else reads as absent.
//   writePointer(agentId, { sessionId, createdAt, model?, effort? }) -> Promise<void>
//     Rejects 'invalid_pointer' for a bad session id, a session id of null
//     with neither field, a model that is not a string of 1 to 64
//     characters, or an effort outside EFFORTS. Null fields are dropped.
//   clearPointer(agentId) -> Promise<void>      missing is fine
//   append(agentId, message) -> Promise<void>
//     Text over limits.messageTextBytes (UTF-8) is cut on a character
//     boundary and the record gets truncated: true. After the append, a cache
//     over limits.threadCacheMessages or limits.threadCacheBytes is rewritten
//     atomically with the newest messages that fit under both caps.
//   read(agentId) -> Promise<message[]>
//     Reads at most limits.threadCacheBytes from the end of the file and
//     returns at most limits.threadCacheMessages messages, oldest first.
//     Lines that do not parse as a message (a partial last line after a
//     crash, a line clipped by the byte cap) are skipped.
//   clear(agentId) -> Promise<void>             removes the cache; missing is fine
//
// agentId must match the registry id pattern; anything else rejects with
// code 'invalid_agent_id' before any path is built. `dir` is created
// (0700) on the first write. Appends, clears, and cache rewrites for one
// agent run one at a time in call order; pointer operations have their own
// queue per agent. The store keeps each cache's line count and size in
// memory after first touching it, so the dashboard process must be the
// only writer.

import { constants } from 'node:fs';
import { chmod, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

import { createKeyedQueue } from './feedback.mjs';
import { isEffort } from './models.mjs';
import { AGENT_ID } from './registry.mjs';

const ROLES = new Set(['user', 'assistant', 'system']);
const SESSION_ID_MAX = 256;
const MODEL_MAX = 64;
const POINTER_MAX_BYTES = 4 * 1024;

export class ThreadStoreError extends Error {
  constructor(code, options) {
    super(code, options);
    this.name = 'ThreadStoreError';
    this.code = code;
  }
}

// Cuts text to at most maxBytes of UTF-8 without splitting a character.
export function truncateUtf8(text, maxBytes) {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return { text, truncated: false };
  const { read } = new TextEncoder().encodeInto(text, new Uint8Array(maxBytes));
  return { text: text.slice(0, read), truncated: true };
}

export function createThreadStore({ dir, limits, log = () => {} }) {
  const root = path.resolve(dir);
  const queue = createKeyedQueue();
  // agentId -> { count, bytes, needsNewline } for the cache file as last seen.
  const caches = new Map();

  function fileFor(agentId, extension) {
    if (typeof agentId !== 'string' || !AGENT_ID.test(agentId)) throw new ThreadStoreError('invalid_agent_id');
    return path.join(root, `${agentId}${extension}`);
  }

  // The chmod tightens a directory created earlier under a looser umask.
  async function ensureDir() {
    await mkdir(root, { recursive: true, mode: 0o700 });
    await chmod(root, 0o700);
  }

  async function inspectCache(file) {
    const tail = await readTail(file, limits.threadCacheBytes);
    if (!tail) return { count: 0, bytes: 0, needsNewline: false };
    return {
      count: parseMessages(tail.text).length,
      bytes: tail.size,
      needsNewline: tail.size > 0 && !tail.text.endsWith('\n'),
    };
  }

  async function appendLocked(agentId, file, record) {
    await ensureDir();
    let cache = caches.get(agentId);
    if (!cache) {
      cache = await inspectCache(file);
      caches.set(agentId, cache);
    }
    const data = `${cache.needsNewline ? '\n' : ''}${JSON.stringify(record)}\n`;
    const handle = await open(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    try {
      await handle.writeFile(data, 'utf8');
    } finally {
      await handle.close();
    }
    cache.count += 1;
    cache.bytes += Buffer.byteLength(data, 'utf8');
    cache.needsNewline = false;
    if (cache.count > limits.threadCacheMessages || cache.bytes > limits.threadCacheBytes) {
      await rewriteCache(agentId, file);
    }
  }

  async function rewriteCache(agentId, file) {
    const tail = await readTail(file, limits.threadCacheBytes);
    const messages = tail ? parseMessages(tail.text) : [];
    const kept = [];
    let bytes = 0;
    for (let index = messages.length - 1; index >= 0 && kept.length < limits.threadCacheMessages; index -= 1) {
      const line = `${JSON.stringify(messages[index])}\n`;
      const size = Buffer.byteLength(line, 'utf8');
      if (bytes + size > limits.threadCacheBytes) break;
      kept.push(line);
      bytes += size;
    }
    kept.reverse();
    await atomicWrite(root, `${agentId}.jsonl`, kept.join(''));
    caches.set(agentId, { count: kept.length, bytes, needsNewline: false });
  }

  return {
    async readPointer(agentId) {
      const file = fileFor(agentId, '.json');
      let raw;
      try {
        raw = await readFile(file, { encoding: 'utf8', flag: constants.O_RDONLY | constants.O_NOFOLLOW });
      } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw error;
      }
      const pointer = parsePointer(raw);
      if (!pointer) log({ event: 'thread_pointer_invalid', agentId });
      return pointer;
    },

    async writePointer(agentId, pointer) {
      fileFor(agentId, '.json');
      if (!isPointer(pointer)) throw new ThreadStoreError('invalid_pointer');
      const body = `${JSON.stringify(pointerRecord(pointer))}\n`;
      await queue(`pointer:${agentId}`, async () => {
        await ensureDir();
        await atomicWrite(root, `${agentId}.json`, body);
      });
    },

    async clearPointer(agentId) {
      const file = fileFor(agentId, '.json');
      await queue(`pointer:${agentId}`, () => unlinkIfPresent(file));
    },

    async append(agentId, message) {
      const file = fileFor(agentId, '.jsonl');
      const record = normalizeMessage(message, limits.messageTextBytes);
      await queue(`cache:${agentId}`, () => appendLocked(agentId, file, record).catch((error) => {
        // The file may now hold part of a line; look at it again next time.
        caches.delete(agentId);
        throw error;
      }));
    },

    async read(agentId) {
      const file = fileFor(agentId, '.jsonl');
      const tail = await readTail(file, limits.threadCacheBytes);
      if (!tail) return [];
      return parseMessages(tail.text).slice(-limits.threadCacheMessages);
    },

    async clear(agentId) {
      const file = fileFor(agentId, '.jsonl');
      await queue(`cache:${agentId}`, async () => {
        caches.delete(agentId);
        await unlinkIfPresent(file);
      });
    },
  };
}

function normalizeMessage(message, maxBytes) {
  if (!isRecord(message) || !ROLES.has(message.role) || typeof message.text !== 'string' || typeof message.at !== 'string') {
    throw new ThreadStoreError('invalid_message');
  }
  const { text, truncated } = truncateUtf8(message.text, maxBytes);
  const record = { ...message, text };
  if (truncated) record.truncated = true;
  return record;
}

function parsePointer(raw) {
  if (Buffer.byteLength(raw, 'utf8') > POINTER_MAX_BYTES) return null;
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value) || typeof value.createdAt !== 'string') return null;
  // A stored choice that no longer validates (an effort the SDK dropped, say)
  // reads as absent rather than spoiling the pointer.
  const read = {
    sessionId: value.sessionId,
    createdAt: value.createdAt,
    model: isModelId(value.model) ? value.model : null,
    effort: isEffort(value.effort) ? value.effort : null,
  };
  return isPointer(read) ? pointerRecord(read) : null;
}

// The fields a pointer file carries: null model and effort are dropped.
function pointerRecord(pointer) {
  const record = { sessionId: pointer.sessionId ?? null, createdAt: pointer.createdAt };
  if (isModelId(pointer.model)) record.model = pointer.model;
  if (isEffort(pointer.effort)) record.effort = pointer.effort;
  return record;
}

function isModelId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= MODEL_MAX;
}

function isPointer(value) {
  if (!isRecord(value) || typeof value.createdAt !== 'string') return false;
  if (value.model !== undefined && value.model !== null && !isModelId(value.model)) return false;
  if (value.effort !== undefined && value.effort !== null && !isEffort(value.effort)) return false;
  const hasChoice = isModelId(value.model) || isEffort(value.effort);
  if (value.sessionId === null || value.sessionId === undefined) return hasChoice;
  return typeof value.sessionId === 'string' && value.sessionId.length > 0 && value.sessionId.length <= SESSION_ID_MAX;
}

function parseMessages(text) {
  const messages = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (isRecord(value) && ROLES.has(value.role) && typeof value.text === 'string') messages.push(value);
  }
  return messages;
}

// Reads the last maxBytes of a file. When the read starts mid-file, the first
// (clipped) line is dropped. Returns null for a missing file.
async function readTail(file, maxBytes) {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, maxBytes);
    const position = size - length;
    const buffer = Buffer.alloc(length);
    let filled = 0;
    while (filled < length) {
      const { bytesRead } = await handle.read(buffer, filled, length - filled, position + filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    let text = buffer.subarray(0, filled).toString('utf8');
    if (position > 0) {
      const newline = text.indexOf('\n');
      text = newline === -1 ? '' : text.slice(newline + 1);
    }
    return { text, size };
  } finally {
    await handle.close();
  }
}

// Writes <root>/<name> by way of an exclusive temporary file, fsync, and
// rename, mode 0600. Also used by lib/bindings.mjs and the Codex helpers.
export async function atomicWrite(root, name, data) {
  const target = path.join(root, name);
  let created = null;
  let handle;
  try {
    for (let attempt = 0; attempt < 8 && !handle; attempt += 1) {
      const candidate = path.join(root, `.${name}.${process.pid}.${randomBytes(12).toString('hex')}.tmp`);
      try {
        handle = await open(candidate, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        created = candidate;
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
      }
    }
    if (!handle) throw new Error('temporary file collision');
    await handle.writeFile(data, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(created, target);
    created = null;
  } finally {
    await handle?.close().catch(() => {});
    if (created) await unlink(created).catch(() => {});
  }
}

async function unlinkIfPresent(file) {
  try {
    await unlink(file);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
