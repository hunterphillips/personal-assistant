// Validation for the Focus board file. Two layers:
//   validateFocus(doc)        — schema: shape every writer must satisfy
//   checkInvariants(prev, next) — curator rules: what an LLM write may not do
// Both return an array of error strings; empty array = valid.
// Plus pruneTombstones(doc, now) — the one edit code makes on its own.

export const TIERS = ['today', 'tomorrow', 'later'];
// The sources that run, in the order the status table reads best.
export const SCAN_SOURCES = ['gmail', 'calendar', 'notes', 'git'];
// Sources no longer scanned. Still accepted on stored items so their
// tombstones validate until pruneTombstones drops them (PRUNE_DAYS); remove
// an entry here once none remain in the board file.
export const RETIRED_SOURCES = ['work'];
export const SOURCES = ['manual', ...SCAN_SOURCES, ...RETIRED_SOURCES];
export const STATUSES = ['open', 'done', 'expired', 'dismissed'];

export const NOW_CAP = 3;    // max open items with now:true
export const TODAY_CAP = 7;  // max open items in tier today
export const PRUNE_DAYS = 30; // non-open items may be deleted only after this
export const NOTE_MAX = 500; // max length of the user's note on an item

const isISO = (s) => typeof s === 'string' && !Number.isNaN(Date.parse(s));

// A missing note and an explicitly null one are the same absence.
const noteOf = (it) => (it && it.note !== undefined && it.note !== null ? it.note : null);

export function validateFocus(doc) {
  const errors = [];
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    return ['document is not an object'];
  }
  if (!isISO(doc.updated)) errors.push('updated: missing or not an ISO datetime');
  if (!Array.isArray(doc.items)) {
    errors.push('items: missing or not an array');
    return errors;
  }
  const seen = new Set();
  doc.items.forEach((it, i) => {
    const at = (msg) => errors.push(`items[${i}]: ${msg}`);
    if (typeof it !== 'object' || it === null) return at('not an object');
    if (typeof it.id !== 'string' || it.id.length === 0) at('id missing');
    else if (seen.has(it.id)) at(`duplicate id ${it.id}`);
    else seen.add(it.id);
    if (typeof it.title !== 'string' || it.title.length === 0 || it.title.length > 200) {
      at('title missing or over 200 chars');
    }
    if (!SOURCES.includes(it.source)) at(`bad source ${JSON.stringify(it.source)}`);
    if (!TIERS.includes(it.tier)) at(`bad tier ${JSON.stringify(it.tier)}`);
    if (typeof it.now !== 'boolean') at('now must be boolean');
    if (!STATUSES.includes(it.status)) at(`bad status ${JSON.stringify(it.status)}`);
    if (!isISO(it.created)) at('created not an ISO datetime');
    if (!isISO(it.updated)) at('updated not an ISO datetime');
    for (const k of ['external_id', 'link', 'meta', 'note']) {
      if (it[k] !== undefined && it[k] !== null && typeof it[k] !== 'string') {
        at(`${k} must be string or null`);
      }
    }
    if (typeof it.note === 'string' && it.note.length > NOTE_MAX) at(`note over ${NOTE_MAX} chars`);
    if (it.rank !== undefined && it.rank !== null && (!Number.isInteger(it.rank) || it.rank < 0)) {
      at('rank must be a non-negative integer or null');
    }
    if (it.now === true && it.tier !== 'today') at('now:true requires tier today');
  });
  return errors;
}

// Drop tombstones past PRUNE_DAYS. This is code's job, not the curator's: the
// rulebook used to ask the model to do the date arithmetic and it got it wrong,
// rejecting 25 whole passes against the prune invariant below. Pure — returns a
// new document, and an open item is never dropped however old it is.
// `now` is a Date or epoch ms.
export function pruneTombstones(doc, now = Date.now()) {
  const cutoff = Number(now) - PRUNE_DAYS * 24 * 60 * 60 * 1000;
  return {
    ...doc,
    items: (doc.items || []).filter(
      (it) => it.status === 'open' || !(Date.parse(it.updated) < cutoff),
    ),
  };
}

export function checkInvariants(prev, next) {
  const errors = validateFocus(next);
  if (errors.length) return errors;

  const nextById = new Map(next.items.map((it) => [it.id, it]));
  const prevIds = new Set(prev.items.map((it) => it.id));
  const pruneCutoff = Date.now() - PRUNE_DAYS * 24 * 60 * 60 * 1000;

  for (const p of prev.items) {
    const n = nextById.get(p.id);
    if (!n) {
      // Invariant: open items never vanish — expiry is the only way out; a
      // non-open item is a tombstone (dedup anchor) prunable only once old.
      if (p.status === 'open') {
        errors.push(`item ${p.id} ("${p.title}") vanished — expire it instead`);
      } else if (Date.parse(p.updated) > pruneCutoff) {
        errors.push(`item ${p.id} ("${p.title}") pruned before ${PRUNE_DAYS} days — keep the tombstone`);
      }
      continue;
    }
    // Invariant: done and dismissed are user verbs — the curator leaves such
    // items entirely alone (and never moves anything into those statuses).
    if (['done', 'dismissed'].includes(p.status)) {
      if (JSON.stringify(n) !== JSON.stringify(p)) {
        errors.push(`item ${p.id} ("${p.title}") is ${p.status} — the curator may not touch it`);
      }
      continue;
    }
    // The curator may close an item it can see was actually finished (evidence
    // comes from the vault's project state) — but `dismissed` stays user-only:
    // whether something belongs on the board is a judgment only Hunter makes.
    if (n.status === 'dismissed') {
      errors.push(`item ${p.id} ("${p.title}") set to dismissed — only the user does that`);
    }
    // Invariant: the curator never rewords user text.
    if (p.source === 'manual' && n.title !== p.title) {
      errors.push(`manual item ${p.id} title reworded ("${p.title}" → "${n.title}")`);
    }
    // Invariant: `note` is the user's own words — readable context, never the
    // curator's to write. Pass it through byte-for-byte.
    if (noteOf(n) !== noteOf(p)) {
      errors.push(`item ${p.id} ("${p.title}") note changed — the note is the user's alone`);
    }
  }

  for (const n of next.items) {
    if (!prevIds.has(n.id) && ['done', 'dismissed'].includes(n.status)) {
      errors.push(`new item ${n.id} ("${n.title}") created as ${n.status} — closing is for items already on the board`);
    }
    if (!prevIds.has(n.id) && noteOf(n) !== null) {
      errors.push(`new item ${n.id} ("${n.title}") created with a note — the note is the user's alone`);
    }
  }

  const open = next.items.filter((it) => it.status === 'open');
  const nowCount = open.filter((it) => it.now).length;
  const todayCount = open.filter((it) => it.tier === 'today').length;
  if (nowCount > NOW_CAP) errors.push(`now cap exceeded: ${nowCount} > ${NOW_CAP}`);
  if (todayCount > TODAY_CAP) errors.push(`today cap exceeded: ${todayCount} > ${TODAY_CAP}`);

  return errors;
}
