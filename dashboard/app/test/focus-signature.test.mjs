// The Focus no-change signature notices candidate identity, dates, and open
// board placement while ignoring prose, timestamps, order, and tombstones.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { signature } from '../lib/focus/signature.mjs';

const iso = new Date().toISOString();
const cand = (over = {}) => ({
  title: 'Lauren — party confirmations',
  source: 'gmail',
  external_id: 'th1',
  link: 'https://mail.google.com/x',
  meta: 'Gmail · Lauren ↔ me · latest from Lauren Sep 12',
  occurs_at: '2026-09-12T13:42:51Z',
  ...over,
});
const item = (over = {}) => ({
  id: 'i1',
  title: 'Send Lauren the confirmations',
  source: 'gmail',
  meta: 'Gmail · latest from Lauren Sep 12',
  tier: 'today',
  now: false,
  status: 'open',
  created: iso,
  updated: iso,
  ...over,
});
const focus = (...items) => ({ updated: iso, items });

test('rewording a candidate does not change the signature', () => {
  const base = signature([cand()], focus(item()));
  assert.equal(signature([cand({ title: 'Party confirmations for Lauren' })], focus(item())), base);
  assert.equal(signature([cand({ meta: 'Gmail · Lauren ↔ me · latest from Lauren 10 days ago' })], focus(item())), base);
  assert.equal(
    signature([cand({ external_id: 'th2' }), cand()], focus(item())),
    signature([cand(), cand({ external_id: 'th2' })], focus(item())),
  );
});

test('a new candidate or a moved date changes the signature', () => {
  const base = signature([cand()], focus(item()));
  assert.notEqual(signature([cand(), cand({ external_id: 'th2' })], focus(item())), base);
  assert.notEqual(signature([cand({ occurs_at: '2026-09-13T13:42:51Z' })], focus(item())), base);
  assert.notEqual(signature([cand({ source: 'calendar' })], focus(item())), base);
  assert.notEqual(signature([], focus(item())), base);
});

test('a candidate with no external_id is identified by its title', () => {
  const bare = (title) => ({ title, source: 'notes' });
  assert.notEqual(
    signature([bare('Focus surface')], focus(item())),
    signature([bare('Focus surface notes')], focus(item())),
  );
});

test('board timestamps, prose and tombstones are invisible', () => {
  const base = signature([cand()], focus(item()));
  const later = new Date(Date.now() + 3600_000).toISOString();
  assert.equal(signature([cand()], { updated: later, items: [item({ updated: later })] }), base);
  assert.equal(signature([cand()], focus(item({ meta: 'Gmail · something else' }))), base);
  assert.equal(signature([cand()], focus(item({ title: 'Send the confirmations' }))), base);
  assert.equal(signature([cand()], focus(item(), item({ id: 'i2', status: 'expired' }))), base);
});

test('where an open board item sits is visible', () => {
  const base = signature([cand()], focus(item()));
  for (const over of [{ tier: 'later' }, { now: true }, { rank: 0 }, { note: 'called her' }, { status: 'done' }]) {
    assert.notEqual(signature([cand()], focus(item(over))), base, JSON.stringify(over));
  }
  assert.notEqual(signature([cand()], focus(item(), item({ id: 'i2' }))), base);
});
