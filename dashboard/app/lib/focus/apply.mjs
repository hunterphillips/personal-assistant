// The curator answers with decisions — add, update, expire, reopen, done — and
// this is the only place they become a document. Retyping all 49 items to change
// one was 12-14k output tokens a call, and the class of bug where an item went
// missing because the model did not retype it.
//
// Pure: the document handed in is never mutated. All-or-nothing: any error at
// all and `next` is null, so a half-understood answer writes nothing. These
// errors are the clearer, earlier half of the net — checkInvariants still runs
// on the result.

import { randomUUID } from 'node:crypto';
import { SOURCES, TIERS } from './validate.mjs';

const OPS = ['add', 'update', 'expire', 'reopen', 'done'];

// The curator never authors a manual item: `manual` means the user typed it.
const ADDABLE_SOURCES = SOURCES.filter((s) => s !== 'manual');

// What an op may carry onto an item, and what counts as a legal value. Named
// here so a bad value reports which op carried it, not which array index it
// landed at.
const FIELDS = {
  title: (v) => typeof v === 'string' && v.length > 0,
  link: (v) => v === null || typeof v === 'string',
  meta: (v) => v === null || typeof v === 'string',
  tier: (v) => TIERS.includes(v),
  now: (v) => typeof v === 'boolean',
  rank: (v) => v === null || (Number.isInteger(v) && v >= 0),
};

const UPDATABLE = ['title', 'link', 'meta', 'tier', 'now', 'rank'];
const PLACEMENT = ['tier', 'now', 'meta', 'rank']; // reopen says where it lands

function assign(item, op, allowed, at) {
  for (const key of allowed) {
    if (op[key] === undefined) continue;
    if (!FIELDS[key](op[key])) {
      at(`${key}: ${JSON.stringify(op[key])} is not a legal value`);
      continue;
    }
    item[key] = op[key];
  }
}

function buildItem(op, now, at) {
  if (!FIELDS.title(op.title)) return at('add needs a title');
  if (!ADDABLE_SOURCES.includes(op.source)) {
    return at(`add needs a source (one of ${ADDABLE_SOURCES.join(', ')})`);
  }
  if (!FIELDS.tier(op.tier)) return at(`add needs a tier (one of ${TIERS.join(', ')})`);
  if (op.rank !== undefined && op.rank !== null && !FIELDS.rank(op.rank)) {
    return at(`rank: ${JSON.stringify(op.rank)} is not a legal value`);
  }
  return {
    id: randomUUID(),
    title: op.title,
    source: op.source,
    external_id: op.external_id ?? null,
    link: op.link ?? null,
    meta: op.meta ?? null,
    ...(op.rank === undefined || op.rank === null ? {} : { rank: op.rank }),
    tier: op.tier,
    now: op.now === true,
    status: 'open',
    created: now,
    updated: now,
  };
}

// `now` is an ISO string: the caller's one timestamp for the whole pass.
export function applyOps(current, ops, now) {
  const errors = [];
  if (!Array.isArray(ops)) return { next: null, errors: ['ops is not an array'] };

  const next = structuredClone(current);
  const byId = new Map(next.items.map((it) => [it.id, it]));
  let changed = false;

  ops.forEach((op, i) => {
    const at = (msg) => {
      errors.push(`ops[${i}] (${(op && op.op) || '?'}): ${msg}`);
      return null;
    };
    if (typeof op !== 'object' || op === null || Array.isArray(op)) return at('not an object');
    if (!OPS.includes(op.op)) return at(`unknown op ${JSON.stringify(op.op)} — expected ${OPS.join(', ')}`);
    // `note` is the user's own words: not the curator's to write on any op.
    if (op.note !== undefined) return at('carries a note — the note is the user\'s alone');

    if (op.op === 'add') {
      const item = buildItem(op, now, at);
      if (!item) return;
      next.items.push(item);
      byId.set(item.id, item);
      changed = true;
      return;
    }

    if (typeof op.id !== 'string' || op.id.length === 0) return at('id missing');
    const item = byId.get(op.id);
    if (!item) return at(`unknown id ${op.id}`);
    const label = `item ${op.id} ("${item.title}")`;
    if (item.status === 'done' || item.status === 'dismissed') {
      return at(`${label} is ${item.status} — the curator may not touch it`);
    }

    const before = JSON.stringify(item);
    switch (op.op) {
      case 'update':
        if (item.status !== 'open') {
          at(`${label} is ${item.status} — update is only for open items (reopen it first)`);
          break;
        }
        assign(item, op, UPDATABLE, at);
        break;
      case 'expire':
        assign(item, op, ['meta'], at);
        item.status = 'expired';
        item.now = false;
        break;
      case 'reopen':
        if (item.status !== 'expired') {
          at(`${label} is ${item.status} — reopen is only for expired items`);
          break;
        }
        if (op.tier === undefined) {
          at('reopen needs a tier');
          break;
        }
        item.status = 'open';
        item.now = false;
        assign(item, op, PLACEMENT, at);
        break;
      case 'done':
        if (item.status !== 'open') {
          at(`${label} is ${item.status} — only an open item can be closed as done`);
          break;
        }
        assign(item, op, ['meta'], at);
        item.status = 'done';
        break;
    }
    // An op that asks for what is already true is not a change: no timestamp bump.
    if (JSON.stringify(item) !== before) {
      item.updated = now;
      changed = true;
    }
  });

  if (errors.length) return { next: null, errors };
  if (changed) next.updated = now;
  return { next, errors };
}
