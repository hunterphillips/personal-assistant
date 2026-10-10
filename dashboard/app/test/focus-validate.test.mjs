import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateFocus, checkInvariants, pruneTombstones } from '../lib/focus/validate.mjs';

const iso = new Date().toISOString();
const item = (over = {}) => ({
  id: over.id ?? crypto.randomUUID(),
  title: 'a task',
  source: 'manual',
  external_id: null,
  link: null,
  meta: null,
  tier: 'today',
  now: false,
  status: 'open',
  created: iso,
  updated: iso,
  ...over,
});
const doc = (...items) => ({ updated: iso, items });

test('valid document passes', () => {
  assert.deepEqual(validateFocus(doc(item(), item({ tier: 'later' }))), []);
});

test('schema rejects bad tier, status, and now-outside-today', () => {
  assert.ok(validateFocus(doc(item({ tier: 'someday' }))).length > 0);
  assert.ok(validateFocus(doc(item({ status: 'deleted' }))).length > 0);
  assert.ok(validateFocus(doc(item({ tier: 'later', now: true }))).length > 0);
});

test('invariant: open item may not vanish', () => {
  const a = item();
  const errors = checkInvariants(doc(a, item()), doc(item({ id: 'other' })));
  assert.ok(errors.some((e) => e.includes('vanished')));
});

test('invariant: expiring an item is allowed', () => {
  const a = item();
  assert.deepEqual(checkInvariants(doc(a), doc({ ...a, status: 'expired' })), []);
});

test('invariant: manual title may not be reworded', () => {
  const a = item({ source: 'manual', title: 'call insurance' });
  const errors = checkInvariants(doc(a), doc({ ...a, title: 'Call the insurance company' }));
  assert.ok(errors.some((e) => e.includes('reworded')));
});

test('dismissed is a valid status', () => {
  assert.deepEqual(validateFocus(doc(item({ status: 'dismissed' }))), []);
});

test('invariant: fresh tombstones may not be pruned, old ones may', () => {
  const fresh = item({ status: 'done' });
  assert.ok(checkInvariants(doc(fresh), doc()).some((e) => e.includes('pruned before')));
  const oldISO = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
  for (const status of ['done', 'dismissed', 'expired']) {
    assert.deepEqual(checkInvariants(doc(item({ status, updated: oldISO })), doc()), []);
  }
});

test('prune: tombstones go at 30 days, open items never', () => {
  const ago = (d) => new Date(Date.now() - d * 24 * 60 * 60 * 1000).toISOString();
  const old = item({ id: 'old', status: 'expired', updated: ago(31) });
  const recent = item({ id: 'recent', status: 'expired', updated: ago(29) });
  const ancient = item({ id: 'ancient', updated: ago(400) }); // open
  const pruned = pruneTombstones(doc(old, recent, ancient));
  assert.deepEqual(pruned.items.map((it) => it.id), ['recent', 'ancient']);
  for (const status of ['done', 'dismissed', 'expired']) {
    assert.equal(pruneTombstones(doc(item({ status, updated: ago(31) }))).items.length, 0);
  }
  // Pure: the document it was handed is untouched.
  const before = doc(old, recent);
  pruneTombstones(before);
  assert.equal(before.items.length, 2);
  // `now` is the caller's to supply, so the cutoff is testable without waiting.
  assert.equal(pruneTombstones(doc(recent), Date.now() + 2 * 86400000).items.length, 0);
});

test('invariant: curator may close a finished item but never dismiss one', () => {
  const a = item();
  assert.deepEqual(checkInvariants(doc(a), doc({ ...a, status: 'done' })), []);
  assert.ok(checkInvariants(doc(a), doc({ ...a, status: 'dismissed' }))
    .some((e) => e.includes('only the user')));
});

test('invariant: curator may not create an item already closed, or touch a tombstone', () => {
  for (const status of ['done', 'dismissed']) {
    assert.ok(checkInvariants(doc(), doc(item({ status })))
      .some((e) => e.includes('closing is for items already on the board')));
    const tomb = item({ status });
    const errors = checkInvariants(doc(tomb), doc({ ...tomb, tier: 'later' }));
    assert.ok(errors.some((e) => e.includes('may not touch')));
    assert.deepEqual(checkInvariants(doc(tomb), doc({ ...tomb })), []);
  }
});

test('schema: note is optional, string or null, capped at 500 chars', () => {
  assert.deepEqual(validateFocus(doc(item({ note: 'texted John, every other Thursday' }))), []);
  assert.deepEqual(validateFocus(doc(item({ note: null }))), []);
  const { note, ...without } = item({ note: 'x' });
  assert.deepEqual(validateFocus(doc(without)), []);
  assert.ok(validateFocus(doc(item({ note: 'x'.repeat(501) }))).some((e) => e.includes('note over')));
  assert.ok(validateFocus(doc(item({ note: 7 }))).some((e) => e.includes('note must be string')));
});

test('invariant: the curator may not write, change, or drop a note', () => {
  const a = item({ note: 'texted John, every other Thursday' });
  assert.ok(checkInvariants(doc(a), doc({ ...a, note: 'texted John' }))
    .some((e) => e.includes('note changed')));
  assert.ok(checkInvariants(doc(a), doc({ ...a, note: null }))
    .some((e) => e.includes('note changed')));
  const { note, ...dropped } = a;
  assert.ok(checkInvariants(doc(a), doc(dropped)).some((e) => e.includes('note changed')));
  const bare = item();
  assert.ok(checkInvariants(doc(bare), doc({ ...bare, note: 'the curator guessing' }))
    .some((e) => e.includes('note changed')));
  // Passing one through untouched — and expiring an item that carries one — is fine.
  assert.deepEqual(checkInvariants(doc(a), doc({ ...a })), []);
  assert.deepEqual(checkInvariants(doc(a), doc({ ...a, status: 'expired' })), []);
});

test('invariant: a missing note and a null note are the same absence', () => {
  const { note, ...bare } = item({ note: null });
  assert.deepEqual(checkInvariants(doc(bare), doc({ ...bare, note: null })), []);
  assert.deepEqual(checkInvariants(doc({ ...bare, note: null }), doc(bare)), []);
});

test('invariant: the curator may not create an item carrying a note', () => {
  assert.ok(checkInvariants(doc(), doc(item({ note: 'made up' })))
    .some((e) => e.includes('created with a note')));
  assert.deepEqual(checkInvariants(doc(), doc(item({ note: null }))), []);
});

test('schema: rank is optional, a non-negative integer or null', () => {
  assert.deepEqual(validateFocus(doc(item({ rank: 0 }), item({ rank: 12 }))), []);
  assert.deepEqual(validateFocus(doc(item({ rank: null }))), []);
  const { rank, ...without } = item({ rank: 1 });
  assert.deepEqual(validateFocus(doc(without)), []);
  for (const bad of [-1, 1.5, '2', true]) {
    assert.ok(validateFocus(doc(item({ rank: bad }))).some((e) => e.includes('rank must be')));
  }
});

test('invariant: rank is the curator\'s to set and to change', () => {
  const a = item({ rank: 2 });
  assert.deepEqual(checkInvariants(doc(a), doc({ ...a, rank: 0 })), []);
  const bare = item();
  assert.deepEqual(checkInvariants(doc(bare), doc({ ...bare, rank: 0 })), []);
  assert.deepEqual(checkInvariants(doc(), doc(item({ rank: 0 }))), []);
});

test('invariant: caps on now and today', () => {
  const nows = [1, 2, 3, 4].map((n) => item({ id: `n${n}`, now: true }));
  assert.ok(checkInvariants(doc(), doc(...nows)).some((e) => e.includes('now cap')));
  const todays = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => item({ id: `t${n}` }));
  assert.ok(checkInvariants(doc(), doc(...todays)).some((e) => e.includes('today cap')));
});
