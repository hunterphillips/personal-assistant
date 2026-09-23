// Filesystem boundary and parser for generated Daily Brief viewers.

import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const MAX_VIEWER_BYTES = 2 * 1024 * 1024;

const VIEWER_NAME = /^viewer-(\d{4}-\d{2}-\d{2})\.html$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

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
  let latest = null;
  for (const entry of entries) {
    signal?.throwIfAborted();
    const match = VIEWER_NAME.exec(entry.name);
    if (!match || !entry.isFile() || !isCalendarDate(match[1])) continue;
    if (latest === null || match[1] > latest.date) latest = { date: match[1], name: entry.name };
  }
  signal?.throwIfAborted();
  return latest;
}

export async function loadBriefArtifact(briefsDir, date, { expectedRevision, signal } = {}) {
  if (!isCalendarDate(date)) throw new BriefArtifactError('unsupported', 'invalid_brief_date', { date });
  signal?.throwIfAborted();
  const root = path.resolve(briefsDir);
  const filename = `viewer-${date}.html`;
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
    if (stats.size > MAX_VIEWER_BYTES) throw new BriefArtifactError('oversized', 'brief_oversized', { date });
    const bytes = await readLimited(handle, stats.size, signal);
    const finalStats = await abortable(handle.stat(), signal);
    const finalPathStats = await abortable(lstat(file), signal).catch((error) => {
      if (error?.name === 'AbortError') throw error;
      return null;
    });
    const changed = bytes.length !== stats.size || finalStats.size !== stats.size ||
      finalStats.mtimeMs !== stats.mtimeMs || finalStats.ctimeMs !== stats.ctimeMs ||
      !finalPathStats || !finalPathStats.isFile() || finalPathStats.isSymbolicLink() ||
      finalPathStats.dev !== finalStats.dev || finalPathStats.ino !== finalStats.ino ||
      finalPathStats.size !== finalStats.size || finalPathStats.mtimeMs !== finalStats.mtimeMs ||
      finalPathStats.ctimeMs !== finalStats.ctimeMs;
    if (finalStats.size > MAX_VIEWER_BYTES) throw new BriefArtifactError('oversized', 'brief_oversized', { date });
    if (changed) {
      const code = expectedRevision === undefined ? 'brief_changed_during_read' : 'revision_conflict';
      throw new BriefArtifactError('unreadable', code, { date });
    }
    const revision = createHash('sha256').update(bytes).digest('hex');
    if (expectedRevision !== undefined && revision !== expectedRevision) {
      throw new BriefArtifactError('unsupported', 'revision_conflict', { date, revision });
    }
    try {
      const parsed = parseBriefViewer(bytes, date);
      return { date, revision, bytes, ...parsed };
    } catch (error) {
      if (error instanceof BriefArtifactError) {
        error.revision ??= revision;
        throw error;
      }
      throw error;
    }
  } finally {
    await handle.close().catch(() => {});
  }
}

export function parseBriefViewer(bytes, date) {
  if (!isCalendarDate(date)) throw new BriefArtifactError('unsupported', 'invalid_brief_date', { date });
  let html;
  try {
    // ignoreBOM keeps a leading BOM in the string so character offsets map
    // back to the same byte offsets used for injection.
    html = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (error) {
    throw new BriefArtifactError('unsupported', 'invalid_viewer_encoding', { date, cause: error });
  }

  const scripts = [...html.matchAll(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi)];
  if (scripts.length !== 1) throw new BriefArtifactError('unsupported', 'incompatible_script_boundaries', { date });
  const scriptMatch = scripts[0];
  if (!/^<script\s*>/i.test(scriptMatch[0])) {
    throw new BriefArtifactError('unsupported', 'incompatible_script_element', { date });
  }
  const scriptEnd = scriptMatch.index + scriptMatch[0].length;
  if (!/^\s*<\/body>\s*<\/html>\s*$/i.test(html.slice(scriptEnd))) {
    throw new BriefArtifactError('unsupported', 'incompatible_script_boundary', { date });
  }
  requireControls(html, date);

  const openEnd = scriptMatch[0].indexOf('>') + 1;
  const closeStart = scriptMatch[0].search(/<\/script\s*>$/i);
  const script = scriptMatch[0].slice(openEnd, closeStart);
  const marker = /^\s*const\s+ITEMS\s*=/.exec(script);
  if (!marker) {
    const code = /^\s*const\s+DATA\s*=/.test(script) ? 'unsupported_data_layout' : 'missing_items';
    const state = code === 'missing_items' ? 'incomplete' : 'unsupported';
    throw new BriefArtifactError(state, code, { date });
  }

  let cursor = marker.index + marker[0].length;
  while (/\s/.test(script[cursor] ?? '')) cursor += 1;
  if (script[cursor] !== '[') throw new BriefArtifactError('incomplete', 'invalid_items_array', { date });
  const arrayEnd = findJsonArrayEnd(script, cursor);
  if (arrayEnd === -1) throw new BriefArtifactError('incomplete', 'truncated_items_array', { date });

  const afterArray = script.slice(arrayEnd + 1);
  const keyMatch = /^\s*;\s*const\s+KEY\s*=\s*(['"])([^'"\\\r\n]*)\1\s*;/.exec(afterArray);
  if (!keyMatch) throw new BriefArtifactError('incomplete', 'missing_storage_key', { date });
  const key = keyMatch[2];
  const keyDate = /^db-items-(\d{4}-\d{2}-\d{2})(?:[-_.][A-Za-z0-9._-]+)?$/.exec(key)?.[1];
  if (keyDate !== date) throw new BriefArtifactError('unsupported', 'storage_key_date_mismatch', { date });
  if (/\b(?:const|let|var)\s+ITEMS\b/.test(afterArray)) {
    throw new BriefArtifactError('unsupported', 'duplicate_items_declaration', { date });
  }
  const supportedBindings = [
    /\blet\s+fb\s*=/,
    /\bfunction\s+saveOut\s*\(/,
    /\bfunction\s+copyOut\s*\(/,
    /\bfunction\s+clearAll\s*\(/,
  ];
  if (supportedBindings.some((pattern) => !pattern.test(script))) {
    throw new BriefArtifactError('unsupported', 'missing_viewer_bindings', { date });
  }

  let rawItems;
  try {
    rawItems = JSON.parse(script.slice(cursor, arrayEnd + 1));
  } catch (error) {
    throw new BriefArtifactError('incomplete', 'invalid_items_json', { date, cause: error });
  }
  const items = validateArtifactItems(rawItems, date);
  return {
    html,
    items,
    key,
    scriptEndByte: Buffer.byteLength(html.slice(0, scriptEnd)),
  };
}

export function validateArtifactItems(rawItems, date) {
  if (!Array.isArray(rawItems)) throw new BriefArtifactError('unsupported', 'items_not_array', { date });
  if (rawItems.length > 200) throw new BriefArtifactError('unsupported', 'too_many_items', { date });
  const ids = new Set();
  return rawItems.map((item) => {
    if (!isRecord(item) || typeof item.id !== 'string' || item.id.length === 0 ||
        typeof item.sec !== 'string' || item.sec.length === 0) {
      throw new BriefArtifactError('unsupported', 'invalid_item', { date });
    }
    if (ids.has(item.id)) throw new BriefArtifactError('unsupported', 'duplicate_item_id', { date });
    ids.add(item.id);
    let text;
    let shape;
    if (typeof item.text === 'string' && item.text.length > 0) {
      text = item.text;
      shape = 'text';
    } else if (typeof item.lede === 'string' && item.lede.length > 0 && typeof item.body === 'string') {
      text = item.lede;
      shape = 'lede';
    } else {
      throw new BriefArtifactError('unsupported', 'invalid_item_text', { date });
    }
    return { id: item.id, section: item.sec, text, shape };
  });
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

function findJsonArrayEnd(source, start) {
  let depth = 0;
  let string = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (string) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') string = false;
      continue;
    }
    if (char === '"') string = true;
    else if (char === '[') depth += 1;
    else if (char === ']' && --depth === 0) return index;
  }
  return -1;
}

function requireControls(html, date) {
  const required = [
    /id=["']brief["']/,
    /<textarea\b[^>]*id=["']overall["'][^>]*>/,
    /id=["']status["']/,
    /<button\b[^>]*class=["'][^"']*\bsave\b[^"']*["'][^>]*onclick=["']saveOut\(\)["'][^>]*>/,
    /<button\b[^>]*onclick=["']copyOut\(\)["'][^>]*>/,
    /<button\b[^>]*onclick=["']clearAll\(\)["'][^>]*>/,
  ];
  if (required.some((pattern) => !pattern.test(html))) {
    throw new BriefArtifactError('unsupported', 'missing_viewer_controls', { date });
  }
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
