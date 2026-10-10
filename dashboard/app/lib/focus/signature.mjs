// Focus scan signature: hashes candidate identity and dates plus every open
// board item's placement. Returns a stable sha256 string and never reads files
// or includes scanner prose, board timestamps, or tombstones. candidatesHash
// hashes the same candidate facts alone, without the board.

import { createHash } from 'node:crypto';

const DATE_KEYS = ['occurs_at', 'date', 'start', 'end', 'last_message_at', 'updated'];

const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function candidateFacts(raw) {
  const list = Array.isArray(raw) ? raw : [];
  return list
    .map((candidate) => {
      const held = candidate && typeof candidate === 'object' ? candidate : {};
      const facts = { source: held.source ?? null, id: String(held.external_id || held.title || '') };
      for (const key of DATE_KEYS) {
        if (held[key] !== undefined && held[key] !== null) facts[key] = String(held[key]);
      }
      return facts;
    })
    .sort(byId);
}

function focusFacts(raw) {
  const items = raw && Array.isArray(raw.items) ? raw.items : [];
  return items
    .filter((item) => item && item.status === 'open')
    .map((item) => ({
      id: String(item.id),
      status: item.status,
      tier: item.tier ?? null,
      now: item.now === true,
      rank: item.rank ?? null,
      note: item.note ?? null,
    }))
    .sort(byId);
}

export function signature(candidates, board) {
  const canonical = JSON.stringify({
    candidates: candidateFacts(candidates),
    focus: focusFacts(board),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

export function candidatesHash(candidates) {
  return createHash('sha256').update(JSON.stringify({ candidates: candidateFacts(candidates) })).digest('hex');
}
