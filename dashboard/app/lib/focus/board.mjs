// Focus board: the dashboard's persistent attention list and Hunter's change
// log. exists() and read() never reject; read() is single-flight and caches by
// the board file's signature. change() serializes validated atomic writes,
// appends bounded audit lines, and notifies listeners. curate() and prune()
// are the daemon's serialized write paths. candidates() joins each scanner's
// latest output to the board by external_id. Nothing here calls a model.

import { constants } from 'node:fs';
import { appendFile, lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

import { applyOps } from './apply.mjs';
import { checkInvariants, NOTE_MAX, pruneTombstones, SCAN_SOURCES, TIERS, validateFocus } from './validate.mjs';

const OPS = new Set(['add', 'done', 'reopen', 'dismiss', 'note', 'title', 'move']);
const OP_FIELDS = {
  add: new Set(['op', 'title', 'external_id', 'link', 'meta', 'tier', 'now']),
  done: new Set(['op', 'id']), reopen: new Set(['op', 'id']), dismiss: new Set(['op', 'id']),
  note: new Set(['op', 'id', 'note']), title: new Set(['op', 'id', 'title']),
  move: new Set(['op', 'id', 'place', 'order']),
};
const PLACES = new Set(['now', 'today', 'tomorrow', 'later']);
const CONTENT_KEYS = ['title', 'source', 'external_id', 'link', 'meta', 'note', 'tier', 'now', 'status'];
const NO_VERDICT = Object.freeze({ status: null, tier: null, id: null, updated: null });

export class BoardError extends Error {
  constructor(code, { field, detail } = {}) {
    super(code);
    this.name = 'BoardError';
    this.code = code;
    if (field !== undefined) this.field = field;
    if (detail !== undefined) this.detail = detail;
  }
}

export function createBoard({ file, changesFile, candidatesDir, limits, log: rawLog = () => {}, now = () => new Date() }) {
  const log = (entry) => { try { rawLog(entry); } catch {} };
  const listeners = new Set();
  let cache = null;
  let inFlight = null;
  let writing = null;

  function serialized(task) {
    const run = (writing ?? Promise.resolve()).then(task, task);
    writing = run.catch(() => {}).finally(() => { if (writing === run) writing = null; });
    return run;
  }

  async function statOf() {
    try {
      const stats = await lstat(file);
      return { kind: stats.isFile() ? 'file' : 'other', size: stats.size, mtimeMs: stats.mtimeMs };
    } catch (error) {
      return { kind: error?.code === 'ENOENT' || error?.code === 'ENOTDIR' ? 'missing' : 'error', code: error?.code };
    }
  }

  async function exists() {
    return (await statOf()).kind === 'file';
  }

  async function load() {
    const stats = await statOf();
    const signature = JSON.stringify(stats);
    if (cache?.signature === signature) return cache.result;
    let result;
    if (stats.kind === 'missing') result = { board: null, problem: null };
    else if (stats.kind !== 'file') result = { board: null, problem: 'The Focus board could not be read.' };
    else if (stats.size > limits.focusBoardBytes) result = { board: null, problem: 'The Focus board is too large.' };
    else {
      try {
        const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
        const buffer = Buffer.alloc(limits.focusBoardBytes + 1);
        let length = 0;
        try {
          while (length < buffer.length) {
            const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
            if (!bytesRead) break;
            length += bytesRead;
          }
        } finally { await handle.close(); }
        if (length > limits.focusBoardBytes) result = { board: null, problem: 'The Focus board is too large.' };
        else {
          const board = JSON.parse(buffer.subarray(0, length).toString('utf8'));
          const errors = validateFocus(board);
          result = errors.length === 0
            ? { board: structuredClone(board), problem: null }
            : { board: null, problem: `The Focus board is invalid: ${errors[0]}.` };
        }
      } catch (error) {
        log({ event: 'focus_board_read_error', path: file, error: error?.message ?? String(error) });
        result = { board: null, problem: error instanceof SyntaxError ? 'The Focus board is not valid JSON.' : 'The Focus board could not be read.' };
      }
    }
    result = deepFreeze(result);
    cache = { signature, result };
    return result;
  }

  function read() {
    if (!inFlight) inFlight = load().finally(() => { inFlight = null; });
    return inFlight;
  }

  function change(op) {
    return serialized(async () => {
      const current = await read();
      if (!current.board) throw new BoardError(current.problem === null ? 'no_board' : 'board_invalid');
      const stamp = now().toISOString();
      const applied = applyHunterOp(current.board, op, stamp);
      if (!applied.changed) return current.board;
      const errors = validateFocus(applied.board);
      if (errors.length > 0) {
        log({ event: 'focus_board_write_refused', path: file, error: errors[0] });
        throw new BoardError('board_invalid');
      }
      await atomicJson(file, applied.board);
      await appendChange(changesFile, applied.line, limits.focusChangesLines);
      cache = null;
      const result = (await read()).board;
      for (const listener of listeners) { try { listener(result); } catch {} }
      return result;
    });
  }

  function curate({ ops, run, basis }) {
    return serialized(async () => {
      const current = await read();
      if (!current.board) throw new BoardError(current.problem === null ? 'no_board' : 'board_invalid');
      if (current.board.updated !== basis) throw new BoardError('stale');
      const stamp = now().toISOString();
      const { next, errors } = applyOps(current.board, ops, stamp);
      if (errors.length > 0) throw new BoardError('rejected', { detail: errors[0] });
      const invariantErrors = checkInvariants(current.board, next);
      if (invariantErrors.length > 0) throw new BoardError('rejected', { detail: invariantErrors[0] });
      const counts = countChanges(current.board, next);
      if (JSON.stringify(next) === JSON.stringify(current.board)) {
        return deepFreeze({ board: current.board, counts: { added: 0, changed: 0, expired: 0 } });
      }
      const schemaErrors = validateFocus(next);
      if (schemaErrors.length > 0) throw new BoardError('rejected', { detail: schemaErrors[0] });
      await atomicJson(file, next);
      for (const line of curatorLines(ops, current.board, next, run, stamp)) {
        await appendChange(changesFile, line, limits.focusChangesLines);
      }
      cache = null;
      const result = (await read()).board;
      for (const listener of listeners) { try { listener(result); } catch {} }
      return deepFreeze({ board: result, counts });
    });
  }

  function prune({ run }) {
    return serialized(async () => {
      const current = await read();
      if (!current.board) throw new BoardError(current.problem === null ? 'no_board' : 'board_invalid');
      const stamp = now().toISOString();
      const next = pruneTombstones(current.board, now());
      const kept = new Set(next.items.map((item) => item.id));
      const removed = current.board.items.filter((item) => !kept.has(item.id));
      if (removed.length === 0) return deepFreeze({ board: current.board, pruned: 0 });
      next.updated = stamp;
      await atomicJson(file, next);
      for (const item of removed) {
        await appendChange(changesFile, {
          at: stamp, who: 'daemon', via: 'run', run, op: 'prune', id: item.id,
          summary: `prune ${quote(item.title)}`, fields: {},
        }, limits.focusChangesLines);
      }
      cache = null;
      const result = (await read()).board;
      for (const listener of listeners) { try { listener(result); } catch {} }
      return deepFreeze({ board: result, pruned: removed.length });
    });
  }

  async function corrections({ since, limit }) {
    let text;
    try { text = await readFile(changesFile, 'utf8'); } catch { return Object.freeze([]); }
    const threshold = since instanceof Date ? since.getTime() : Date.parse(since);
    const found = [];
    for (const raw of text.split('\n')) {
      if (!raw) continue;
      try {
        const line = JSON.parse(raw);
        if (line.who === 'hunter' && typeof line.summary === 'string' && Date.parse(line.at) > threshold) found.push(line);
      } catch {}
    }
    found.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    return Object.freeze(found.slice(0, limit).map((line) => line.summary));
  }

  async function candidates() {
    const { board } = await read();
    const placed = byExternalId(board);
    const sources = [];
    for (const source of SCAN_SOURCES) {
      let scanned = null;
      let found = [];
      try {
        const candidateFile = path.join(candidatesDir, `${source}.json`);
        const parsed = JSON.parse(await readFile(candidateFile, 'utf8'));
        if (Array.isArray(parsed)) found = parsed.filter(isRecord);
        else if (isRecord(parsed) && Array.isArray(parsed.candidates)) {
          found = parsed.candidates.filter(isRecord);
          scanned = typeof parsed.scanned === 'string' ? parsed.scanned : null;
        }
        if (scanned === null) scanned = (await lstat(candidateFile)).mtime.toISOString();
      } catch {}
      sources.push({ source, scanned, candidates: found.map((candidate) => ({
        ...candidate, verdict: verdictOf(placed.get(candidate.external_id)),
      })) });
    }
    return { sources };
  }

  function onChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  return { exists, read, change, curate, prune, corrections, candidates, onChange };
}

function countChanges(current, next) {
  const previous = new Map(current.items.map((item) => [item.id, item]));
  const counts = { added: 0, changed: 0, expired: 0 };
  for (const item of next.items) {
    const held = previous.get(item.id);
    if (!held) counts.added += 1;
    else if (held.status !== 'expired' && item.status === 'expired') counts.expired += 1;
    else if (JSON.stringify(held) !== JSON.stringify(item)) counts.changed += 1;
  }
  return counts;
}

function curatorLines(ops, current, next, run, stamp) {
  const currentIds = new Set(current.items.map((item) => item.id));
  const additions = next.items.filter((item) => !currentIds.has(item.id));
  let addition = 0;
  const lines = [];
  for (const op of ops) {
    const after = op.op === 'add' ? additions[addition++] : next.items.find((entry) => entry.id === op.id);
    const before = current.items.find((entry) => entry.id === (after?.id ?? op.id));
    if (JSON.stringify(before) === JSON.stringify(after)) continue;
    const item = after ?? before;
    const fields = { ...op };
    delete fields.op;
    delete fields.id;
    lines.push({
      at: stamp, who: 'curator', via: 'run', run, op: op.op, id: item.id,
      summary: `${op.op} ${quote(item.title)}`, fields,
    });
  }
  return lines;
}

function applyHunterOp(current, op, stamp) {
  if (!isRecord(op) || !OPS.has(op.op)) throw new BoardError('invalid_op');
  const unknown = Object.keys(op).find((key) => !OP_FIELDS[op.op].has(key));
  if (unknown !== undefined) throw new BoardError('invalid_field', { field: unknown });
  const next = structuredClone(current);
  let item;
  let before;
  let oldPlace;
  if (op.op !== 'add') {
    field(op.id, 'id', (value) => typeof value === 'string' && value.length > 0);
    item = next.items.find((entry) => entry.id === op.id);
    if (!item) throw new BoardError('no_such_item');
    before = structuredClone(item);
    oldPlace = placeOf(item);
  }

  switch (op.op) {
    case 'add': {
      const title = titleOf(op.title);
      optionalString(op, 'external_id'); optionalString(op, 'link'); optionalString(op, 'meta');
      if (op.tier !== undefined && !TIERS.includes(op.tier)) throw new BoardError('invalid_field', { field: 'tier' });
      if (op.now !== undefined && typeof op.now !== 'boolean') throw new BoardError('invalid_field', { field: 'now' });
      const tier = op.tier ?? 'today';
      const isNow = op.now ?? false;
      if (isNow && tier !== 'today') throw new BoardError('invalid_field', { field: 'now' });
      item = {
        id: randomUUID(), title, source: 'manual', external_id: op.external_id ?? null,
        link: op.link ?? null, meta: op.meta ?? 'added by you', tier, now: isNow,
        status: 'open', created: stamp, updated: stamp,
      };
      next.items.push(item);
      break;
    }
    case 'done':
      if (item.status !== 'open') throw new BoardError('not_open');
      item.status = 'done';
      break;
    case 'reopen':
      if (!['done', 'expired', 'dismissed'].includes(item.status)) throw new BoardError('not_closed');
      item.status = 'open';
      break;
    case 'dismiss':
      if (item.status !== 'open') throw new BoardError('not_open');
      item.status = 'dismissed'; item.now = false;
      break;
    case 'note':
      if (!(op.note === null || typeof op.note === 'string')) throw new BoardError('invalid_field', { field: 'note' });
      item.note = op.note === null ? null : op.note.trim();
      if (item.note !== null && item.note.length > NOTE_MAX) throw new BoardError('invalid_field', { field: 'note' });
      break;
    case 'title':
      if (item.source !== 'manual') throw new BoardError('not_manual');
      item.title = titleOf(op.title);
      break;
    case 'move': {
      if (item.status !== 'open') throw new BoardError('not_open');
      if (!PLACES.has(op.place)) throw new BoardError('invalid_field', { field: 'place' });
      if (op.order !== undefined && !Array.isArray(op.order)) throw new BoardError('invalid_order');
      if (oldPlace === op.place && op.order !== undefined && sameOrder(op.order, openOrder(current, op.place))) {
        return { board: current, changed: false };
      }
      const placement = placementOf(op.place);
      item.tier = placement.tier; item.now = placement.now;
      if (op.order !== undefined) {
        const ids = next.items.filter((entry) => entry.status === 'open' && placeOf(entry) === op.place).map((entry) => entry.id);
        if (op.order.length !== ids.length || new Set(op.order).size !== ids.length || ids.some((id) => !op.order.includes(id))) {
          throw new BoardError('invalid_order');
        }
        const byId = new Map(next.items.map((entry) => [entry.id, entry]));
        op.order.forEach((id, rank) => { byId.get(id).rank = rank; });
      }
      break;
    }
  }

  const changed = JSON.stringify(next) !== JSON.stringify(current);
  if (!changed) return { board: current, changed: false };
  for (const entry of next.items) {
    const previous = current.items.find((held) => held.id === entry.id);
    if (!previous || CONTENT_KEYS.some((key) => valueOf(previous, key) !== valueOf(entry, key))) entry.updated = stamp;
  }
  next.updated = stamp;
  const place = placeOf(item);
  const position = openOrder(next, place).indexOf(item.id) + 1;
  const summary = summarize(op, item, oldPlace, place, position);
  const fields = { ...op };
  delete fields.op;
  delete fields.id;
  const operation = op.op;
  return { board: next, changed: true, line: { at: stamp, who: 'hunter', via: 'board', op: operation, id: item.id, summary, fields } };
}

function summarize(op, item, oldPlace, place, position) {
  const title = quote(item.title);
  if (op.op === 'add') return `add ${title}`;
  if (op.op === 'done') return `done ${title}`;
  if (op.op === 'reopen') return `reopen ${title}`;
  if (op.op === 'dismiss') return `dismiss ${title}`;
  if (op.op === 'title') return `edit ${title}`;
  if (op.op === 'note') return `${item.note === null || item.note === '' ? 'clear note' : 'note'} ${title}`;
  if (op.order !== undefined && oldPlace === place) return `reorder ${title} to #${position} in ${place}`;
  return `move ${title} to ${place}${position ? `#${position}` : ''}`;
}

function openOrder(board, place) {
  return board.items.map((item, index) => ({ item, index })).filter(({ item }) => item.status === 'open' && placeOf(item) === place)
    .sort((a, b) => rankOf(a.item) - rankOf(b.item) || a.index - b.index).map(({ item }) => item.id);
}

function rankOf(item) { return Number.isInteger(item.rank) ? item.rank : Number.MAX_SAFE_INTEGER; }
function sameOrder(a, b) { return a.length === b.length && a.every((value, index) => value === b[index]); }
function placeOf(item) { return item.now ? 'now' : item.tier; }
function placementOf(place) { return place === 'now' ? { tier: 'today', now: true } : { tier: place, now: false }; }
function quote(title) { return `"${String(title ?? '').replace(/\s+/g, ' ').trim()}"`; }
function valueOf(item, key) { return key === 'note' ? item[key] ?? null : item[key]; }
function titleOf(value) { return field(typeof value === 'string' ? value.trim() : value, 'title', (title) => typeof title === 'string' && title.length >= 1 && title.length <= 200); }
function optionalString(op, key) { if (op[key] !== undefined && op[key] !== null && typeof op[key] !== 'string') throw new BoardError('invalid_field', { field: key }); }
function field(value, name, valid) { if (!valid(value)) throw new BoardError('invalid_field', { field: name }); return value; }
function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }

function byExternalId(board) {
  const map = new Map();
  for (const item of board?.items ?? []) {
    if (typeof item.external_id !== 'string' || item.external_id === '') continue;
    const held = map.get(item.external_id);
    if (!held || Date.parse(item.updated) >= Date.parse(held.updated)) map.set(item.external_id, item);
  }
  return map;
}
function verdictOf(item) { return item ? { status: item.status, tier: item.tier, id: item.id, updated: item.updated } : { ...NO_VERDICT }; }

async function appendChange(file, line, limit) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await appendFile(file, `${JSON.stringify(line)}\n`, { encoding: 'utf8', mode: 0o600 });
  const lines = (await readFile(file, 'utf8')).split('\n').filter(Boolean);
  if (lines.length > limit) await atomicText(file, `${lines.slice(-limit).join('\n')}\n`);
}

export async function atomicJson(file, value) { await atomicText(file, `${JSON.stringify(value, null, 2)}\n`); }
// Writes a 0600 temp file beside `file`, fsyncs it, and renames it into place.
export async function atomicText(file, text) {
  const dir = path.dirname(file);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.${path.basename(file)}.${randomBytes(6).toString('hex')}.tmp`);
  const handle = await open(tmp, 'wx', 0o600);
  try { await handle.writeFile(text, 'utf8'); await handle.sync(); } finally { await handle.close(); }
  try { await rename(tmp, file); } catch (error) { await unlink(tmp).catch(() => {}); throw error; }
}

export function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
