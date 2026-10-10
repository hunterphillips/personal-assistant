// applyOps is pure: no board file, change log, or clock of its own — the caller
// supplies `now`, so every timestamp here is checked against a fixed string.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyOps } from '../lib/focus/apply.mjs';

const NOW = '2026-09-24T15:00:00.000Z';
const OLD = '2026-09-20T09:00:00.000Z';

const item = (over = {}) => ({
  id: 'i1',
  title: 'a task',
  source: 'gmail',
  external_id: null,
  link: null,
  meta: null,
  tier: 'today',
  now: false,
  status: 'open',
  created: OLD,
  updated: OLD,
  ...over,
});
const doc = (...items) => ({ updated: OLD, items });

const apply = (current, ...ops) => applyOps(current, ops, NOW);
const only = (result) => {
  assert.deepEqual(result.errors, []);
  return result.next;
};

test('add: code sets the id, the status and both timestamps', () => {
  const next = only(apply(doc(), {
    op: 'add', title: 'Email Lauren the headcount', source: 'gmail',
    external_id: 'th1', meta: 'Gmail · asked 9/23', tier: 'today', now: true, rank: 0,
  }));
  assert.equal(next.items.length, 1);
  const added = next.items[0];
  assert.match(added.id, /^[0-9a-f]{8}-[0-9a-f]{4}-/);
  assert.equal(added.status, 'open');
  assert.equal(added.created, NOW);
  assert.equal(added.updated, NOW);
  assert.equal(added.title, 'Email Lauren the headcount');
  assert.equal(added.rank, 0);
  assert.equal(added.link, null, 'fields the op left out default to null');
  assert.equal(next.updated, NOW);
});

test('add: now and rank are optional, missing required fields are errors', () => {
  const next = only(apply(doc(), { op: 'add', title: 'x', source: 'git', tier: 'later' }));
  assert.equal(next.items[0].now, false);
  assert.equal('rank' in next.items[0], false);

  for (const bad of [
    { op: 'add', source: 'git', tier: 'later' },
    { op: 'add', title: 'x', tier: 'later' },
    { op: 'add', title: 'x', source: 'git' },
    { op: 'add', title: 'x', source: 'nowhere', tier: 'later' },
    { op: 'add', title: 'x', source: 'git', tier: 'someday' },
  ]) {
    const { next: n, errors } = apply(doc(), bad);
    assert.equal(n, null);
    assert.equal(errors.length, 1, JSON.stringify(bad));
  }
});

test('add: a manual source is the user\'s alone', () => {
  const { next, errors } = apply(doc(), { op: 'add', title: 'x', source: 'manual', tier: 'today' });
  assert.equal(next, null);
  assert.ok(errors[0].includes('source'));
});

test('an op carrying a note is rejected', () => {
  for (const op of [
    { op: 'add', title: 'x', source: 'git', tier: 'later', note: 'made up' },
    { op: 'update', id: 'i1', note: 'made up' },
    { op: 'done', id: 'i1', note: 'he said so' },
  ]) {
    const { next, errors } = apply(doc(item()), op);
    assert.equal(next, null);
    assert.ok(errors[0].includes('note'), errors[0]);
  }
});

test('update: only the named fields move, and updated is stamped', () => {
  const next = only(apply(doc(item({ meta: 'old' })), {
    op: 'update', id: 'i1', tier: 'tomorrow', rank: 2, meta: 'Gmail · Lauren replied',
  }));
  assert.deepEqual(next.items[0], item({
    meta: 'Gmail · Lauren replied', tier: 'tomorrow', rank: 2, updated: NOW,
  }));
});

test('update: an op that asks for what is already true changes nothing', () => {
  const before = doc(item({ tier: 'later', rank: 1 }));
  const { next, errors } = apply(before, { op: 'update', id: 'i1', tier: 'later', rank: 1 });
  assert.deepEqual(errors, []);
  assert.equal(next.items[0].updated, OLD, 'no timestamp bump');
  assert.equal(next.updated, OLD, 'and no document bump');
  assert.equal(before.items[0].updated, OLD, 'the input document is never mutated');
});

test('update: a value the schema would reject is named with its op', () => {
  const { next, errors } = apply(doc(item()), { op: 'update', id: 'i1', tier: 'someday', rank: -1 });
  assert.equal(next, null);
  assert.equal(errors.length, 2);
  assert.ok(errors[0].includes('tier'));
  assert.ok(errors[1].includes('rank'));
});

test('expire: clears now, takes an optional meta', () => {
  const next = only(apply(doc(item({ now: true })), {
    op: 'expire', id: 'i1', meta: 'the send-ahead window has passed',
  }));
  assert.equal(next.items[0].status, 'expired');
  assert.equal(next.items[0].now, false);
  assert.equal(next.items[0].meta, 'the send-ahead window has passed');
  assert.equal(next.items[0].updated, NOW);
});

test('reopen: expired only, tier required', () => {
  const next = only(apply(doc(item({ status: 'expired' })), {
    op: 'reopen', id: 'i1', tier: 'later', meta: 'Robert wrote again',
  }));
  assert.equal(next.items[0].status, 'open');
  assert.equal(next.items[0].tier, 'later');
  assert.equal(next.items[0].updated, NOW);

  const open = apply(doc(item()), { op: 'reopen', id: 'i1', tier: 'later' });
  assert.equal(open.next, null);
  assert.ok(open.errors[0].includes('only for expired'));

  const noTier = apply(doc(item({ status: 'expired' })), { op: 'reopen', id: 'i1' });
  assert.equal(noTier.next, null);
  assert.ok(noTier.errors[0].includes('needs a tier'));
});

test('done: open items only', () => {
  const next = only(apply(doc(item()), { op: 'done', id: 'i1', meta: 'PROJECT STATE: shipped 9/23' }));
  assert.equal(next.items[0].status, 'done');

  const twice = apply(doc(item({ status: 'expired' })), { op: 'done', id: 'i1' });
  assert.equal(twice.next, null);
  assert.ok(twice.errors[0].includes('only an open item'));
});

test('tombstones are untouchable whatever the op', () => {
  for (const status of ['done', 'dismissed']) {
    for (const op of ['update', 'expire', 'reopen', 'done']) {
      const { next, errors } = apply(doc(item({ status })), { op, id: 'i1', tier: 'today' });
      assert.equal(next, null);
      assert.ok(errors[0].includes('may not touch it'), errors[0]);
    }
  }
});

test('an unknown id or op is an error, and nothing is written', () => {
  const unknownId = apply(doc(item()), { op: 'update', id: 'nope', tier: 'later' });
  assert.equal(unknownId.next, null);
  assert.ok(unknownId.errors[0].includes('unknown id nope'));

  const unknownOp = apply(doc(item()), { op: 'delete', id: 'i1' });
  assert.equal(unknownOp.next, null);
  assert.ok(unknownOp.errors[0].includes('unknown op'));

  assert.equal(applyOps(doc(item()), 'ops', NOW).next, null);
});

test('ops apply in order: updating what a previous op expired is an error', () => {
  const { next, errors } = apply(
    doc(item()),
    { op: 'expire', id: 'i1' },
    { op: 'update', id: 'i1', tier: 'later' },
  );
  assert.equal(next, null);
  assert.equal(errors.length, 1);
  assert.ok(errors[0].startsWith('ops[1]'), errors[0]);
  assert.ok(errors[0].includes('is expired'), errors[0]);
});

test('empty ops leave the document exactly as it was', () => {
  const before = doc(item());
  const next = only(applyOps(before, [], NOW));
  assert.deepEqual(next, before);
});
