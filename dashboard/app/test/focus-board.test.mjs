import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import { BoardError, createBoard } from '../lib/focus/board.mjs';
import { tempDir } from './support/harness.mjs';

const FIXTURE = new URL('./fixtures/focus/', import.meta.url);
const OLD = '2026-10-10T12:00:00.000Z';
const NOW = new Date('2026-10-10T15:00:00.000Z');

async function setup(t, { body } = {}) {
  const dir = await tempDir(t);
  const file = path.join(dir, 'focus/board.json');
  const changesFile = path.join(dir, 'focus/changes.jsonl');
  const candidatesDir = path.join(dir, 'focus/candidates');
  await mkdir(candidatesDir, { recursive: true });
  if (body !== null) await writeFile(file, body ?? await readFile(new URL('board.json', FIXTURE)));
  await writeFile(path.join(candidatesDir, 'gmail.json'), await readFile(new URL('candidates/gmail.json', FIXTURE)));
  const events = [];
  const board = createBoard({ file, changesFile, candidatesDir,
    limits: { focusBoardBytes: 4 * 1024 * 1024, focusChangesLines: 50 }, now: () => NOW, log: (entry) => events.push(entry) });
  return { board, file, changesFile, candidatesDir, events };
}

async function lines(file) { return (await readFile(file, 'utf8')).trim().split('\n').map(JSON.parse); }

test('read is frozen and missing, malformed, oversized, and invalid boards are safe', async (t) => {
  const missing = await setup(t, { body: null });
  assert.equal(await missing.board.exists(), false);
  assert.deepEqual(await missing.board.read(), { board: null, problem: null });
  await assert.rejects(missing.board.change({ op: 'add', title: 'x' }), (error) => error instanceof BoardError && error.code === 'no_board');

  for (const body of ['{', JSON.stringify({ updated: OLD, items: [{ id: 'x' }] })]) {
    const found = await setup(t, { body });
    const result = await found.board.read();
    assert.equal(result.board, null);
    assert.match(result.problem, /Focus board/);
    assert.ok(Object.isFrozen(result));
    await assert.rejects(found.board.change({ op: 'done', id: 'x' }), { code: 'board_invalid' });
  }
  const found = await setup(t);
  const oversized = createBoard({ file: found.file, changesFile: found.changesFile, candidatesDir: found.candidatesDir,
    limits: { focusBoardBytes: 10, focusChangesLines: 50 } });
  assert.deepEqual(await oversized.read(), { board: null, problem: 'The Focus board is too large.' });
});

test('add, status, note, and title ops stamp and log their exact summaries', async (t) => {
  const { board, changesFile } = await setup(t);
  const notifications = [];
  const unsubscribe = board.onChange((value) => notifications.push(value.updated));
  let next = await board.change({ op: 'add', title: '  Draft   the outline  ', external_id: 'draft-1' });
  const added = next.items.at(-1);
  assert.equal(added.title, 'Draft   the outline');
  assert.equal(added.updated, NOW.toISOString());
  await board.change({ op: 'note', id: added.id, note: '  Use three examples  ' });
  await board.change({ op: 'note', id: added.id, note: null });
  await board.change({ op: 'title', id: added.id, title: 'Finish the outline' });
  await board.change({ op: 'done', id: added.id });
  await board.change({ op: 'reopen', id: added.id });
  await board.change({ op: 'dismiss', id: added.id });
  unsubscribe();
  assert.equal(notifications.length, 7);
  assert.deepEqual((await lines(changesFile)).map((line) => line.summary), [
    'add "Draft the outline"', 'note "Draft the outline"', 'clear note "Draft the outline"',
    'edit "Finish the outline"', 'done "Finish the outline"', 'reopen "Finish the outline"', 'dismiss "Finish the outline"',
  ]);
});

test('move validates a full place order, preserves rank-only timestamps, and skips a no-op', async (t) => {
  const { board, changesFile } = await setup(t);
  await board.change({ op: 'move', id: 'today-one', place: 'today', order: ['today-one'] });
  await assert.rejects(readFile(changesFile), { code: 'ENOENT' });

  let next = await board.change({ op: 'move', id: 'tomorrow-one', place: 'today', order: ['tomorrow-one', 'today-one'] });
  assert.equal(next.items.find((item) => item.id === 'tomorrow-one').updated, NOW.toISOString());
  assert.equal((await lines(changesFile))[0].summary, 'move "Review the release checklist" to today#1');

  next = await board.change({ op: 'move', id: 'today-one', place: 'today', order: ['today-one', 'tomorrow-one'] });
  assert.equal(next.items.find((item) => item.id === 'today-one').updated, '2026-10-09T12:00:00.000Z');
  assert.equal((await lines(changesFile))[1].summary, 'reorder "Choose a workshop topic" to #1 in today');
  await assert.rejects(board.change({ op: 'move', id: 'today-one', place: 'today', order: ['today-one'] }), { code: 'invalid_order' });
});

test('ops return the specified errors and a validation failure writes nothing', async (t) => {
  const { board, file, changesFile } = await setup(t);
  for (const [op, code, field] of [
    [{ op: 'what' }, 'invalid_op'], [{ op: 'done', id: 'missing' }, 'no_such_item'],
    [{ op: 'done', id: 'done-one' }, 'not_open'], [{ op: 'reopen', id: 'today-one' }, 'not_closed'],
    [{ op: 'title', id: 'now-one', title: 'x' }, 'not_manual'], [{ op: 'note', id: 'today-one', note: 'x'.repeat(501) }, 'invalid_field', 'note'],
    [{ op: 'done', id: 'today-one', extra: true }, 'invalid_field', 'extra'],
  ]) await assert.rejects(board.change(op), (error) => error.code === code && (field === undefined || error.field === field));
  const before = await readFile(file, 'utf8');
  const invalidClock = createBoard({ file, changesFile, candidatesDir: path.join(path.dirname(file), 'candidates'),
    limits: { focusBoardBytes: 4 * 1024 * 1024, focusChangesLines: 50 }, now: () => ({ toISOString: () => 'not-a-date' }) });
  await assert.rejects(invalidClock.change({ op: 'note', id: 'today-one', note: 'changed' }), { code: 'board_invalid' });
  assert.equal(await readFile(file, 'utf8'), before);
  await assert.rejects(readFile(changesFile), { code: 'ENOENT' });
});

test('the change log keeps only the newest configured lines', async (t) => {
  const setupResult = await setup(t);
  const board = createBoard({ file: setupResult.file, changesFile: setupResult.changesFile, candidatesDir: setupResult.candidatesDir,
    limits: { focusBoardBytes: 4 * 1024 * 1024, focusChangesLines: 2 }, now: () => NOW });
  await board.change({ op: 'note', id: 'today-one', note: 'one' });
  await board.change({ op: 'note', id: 'today-one', note: 'two' });
  await board.change({ op: 'note', id: 'today-one', note: 'three' });
  assert.deepEqual((await lines(setupResult.changesFile)).map((line) => line.fields.note), ['two', 'three']);
});

test('candidates follow scanner order and carry the newest matching verdict', async (t) => {
  const { board } = await setup(t);
  const result = await board.candidates();
  assert.deepEqual(result.sources.map((source) => source.source), ['gmail', 'calendar', 'notes', 'git']);
  assert.equal(result.sources[0].scanned, '2026-10-10T12:30:00.000Z');
  assert.deepEqual(result.sources[0].candidates[0].verdict, {
    status: 'open', tier: 'today', id: 'now-one', updated: '2026-10-10T12:00:00.000Z',
  });
  assert.deepEqual(result.sources[0].candidates[1].verdict, { status: null, tier: null, id: null, updated: null });
  assert.deepEqual(result.sources[1], { source: 'calendar', scanned: null, candidates: [] });
});

test('curate applies ops, counts changes, logs the run, and notifies listeners', async (t) => {
  const { board, changesFile } = await setup(t);
  const notifications = [];
  board.onChange((value) => notifications.push(value.updated));
  const expired = await board.curate({
    basis: OLD, run: 'run-expire', ops: [{ op: 'expire', id: 'tomorrow-one', meta: 'The release shipped.' }],
  });
  assert.deepEqual(expired.counts, { added: 0, changed: 0, expired: 1 });
  assert.equal(expired.board.items.find((item) => item.id === 'tomorrow-one').status, 'expired');
  assert.deepEqual((await lines(changesFile))[0], {
    at: NOW.toISOString(), who: 'curator', via: 'run', run: 'run-expire', op: 'expire', id: 'tomorrow-one',
    summary: 'expire "Review the release checklist"', fields: { meta: 'The release shipped.' },
  });
  const done = await board.curate({
    basis: NOW.toISOString(), run: 'run-done', ops: [{ op: 'done', id: 'today-one', meta: 'Finished in the vault.' }],
  });
  assert.deepEqual(done.counts, { added: 0, changed: 1, expired: 0 });
  assert.equal(notifications.length, 2);
});

test('curate add assigns an id and one timestamp', async (t) => {
  const { board } = await setup(t);
  const result = await board.curate({
    basis: OLD, run: 'run-add', ops: [{
      op: 'add', title: 'Reply to Morgan', source: 'gmail', external_id: 'thread-morgan',
      tier: 'tomorrow', now: false,
    }],
  });
  const item = result.board.items.find((entry) => entry.external_id === 'thread-morgan');
  assert.ok(item.id);
  assert.equal(item.created, NOW.toISOString());
  assert.equal(item.updated, item.created);
  assert.deepEqual(result.counts, { added: 1, changed: 0, expired: 0 });
});

test('curate rejects bad answers and stale bases without writing', async (t) => {
  const { board, file, changesFile } = await setup(t);
  const before = await readFile(file, 'utf8');
  await assert.rejects(
    board.curate({ basis: OLD, run: 'bad', ops: [{ op: 'update', id: 'done-one', meta: 'changed' }] }),
    (error) => error.code === 'rejected' && /done/.test(error.detail),
  );
  await assert.rejects(
    board.curate({ basis: '2026-10-10T11:00:00.000Z', run: 'stale', ops: [] }),
    { code: 'stale' },
  );
  const capOps = Array.from({ length: 3 }, (_, index) => ({
    op: 'add', title: `Now ${index}`, source: 'notes', tier: 'today', now: true,
  }));
  await assert.rejects(
    board.curate({ basis: OLD, run: 'cap', ops: capOps }),
    (error) => error.code === 'rejected' && /now cap exceeded/.test(error.detail),
  );
  assert.equal(await readFile(file, 'utf8'), before);
  await assert.rejects(readFile(changesFile), { code: 'ENOENT' });
});

test('curate with empty ops writes nothing', async (t) => {
  const { board, file, changesFile } = await setup(t);
  const before = await readFile(file, 'utf8');
  const result = await board.curate({ basis: OLD, run: 'empty', ops: [] });
  assert.deepEqual(result.counts, { added: 0, changed: 0, expired: 0 });
  assert.equal(await readFile(file, 'utf8'), before);
  await assert.rejects(readFile(changesFile), { code: 'ENOENT' });
});

test('curate writes nothing for an accepted non-empty no-op', async (t) => {
  const { board, file, changesFile } = await setup(t);
  const before = await readFile(file);
  let notified = 0;
  board.onChange(() => { notified += 1; });
  const result = await board.curate({
    basis: OLD, run: 'no-op', ops: [{ op: 'update', id: 'tomorrow-one', tier: 'tomorrow' }],
  });
  assert.deepEqual(result.counts, { added: 0, changed: 0, expired: 0 });
  assert.deepEqual(await readFile(file), before);
  await assert.rejects(readFile(changesFile), { code: 'ENOENT' });
  assert.equal(notified, 0);
});

test('curate logs only the ops in a mixed batch that changed an item', async (t) => {
  const { board, changesFile } = await setup(t);
  const result = await board.curate({
    basis: OLD, run: 'mixed', ops: [
      { op: 'update', id: 'tomorrow-one', tier: 'tomorrow' },
      { op: 'expire', id: 'later-one', meta: 'Booked already.' },
    ],
  });
  assert.deepEqual(result.counts, { added: 0, changed: 0, expired: 1 });
  assert.deepEqual((await lines(changesFile)).map((line) => line.summary), ['expire "Book the practice room"']);
});

test('prune removes only old tombstones, logs them, and notifies listeners', async (t) => {
  const fixture = JSON.parse(await readFile(new URL('board.json', FIXTURE)));
  fixture.items.find((item) => item.id === 'done-one').updated = '2026-08-01T12:00:00.000Z';
  fixture.items.find((item) => item.id === 'expired-one').updated = '2026-10-01T12:00:00.000Z';
  const found = await setup(t, { body: JSON.stringify(fixture) });
  let notified = 0;
  found.board.onChange(() => { notified += 1; });
  const result = await found.board.prune({ run: 'run-prune' });
  assert.equal(result.pruned, 1);
  assert.equal(result.board.items.some((item) => item.id === 'done-one'), false);
  assert.equal(result.board.items.some((item) => item.id === 'expired-one'), true);
  assert.equal(notified, 1);
  assert.deepEqual((await lines(found.changesFile))[0], {
    at: NOW.toISOString(), who: 'daemon', via: 'run', run: 'run-prune', op: 'prune', id: 'done-one',
    summary: 'prune "Confirm the sample order"', fields: {},
  });
});

test('corrections returns recent Hunter summaries newest first', async (t) => {
  const { board, changesFile } = await setup(t);
  const entries = [
    { at: '2026-09-01T00:00:00.000Z', who: 'hunter', summary: 'too old' },
    { at: '2026-10-08T10:00:00.000Z', who: 'curator', summary: 'skip curator' },
    { at: '2026-10-09T10:00:00.000Z', who: 'hunter', summary: 'older Hunter' },
    { at: '2026-10-10T10:00:00.000Z', who: 'daemon', summary: 'skip daemon' },
    { at: '2026-10-10T11:00:00.000Z', who: 'hunter', summary: 'newer Hunter' },
  ];
  await writeFile(changesFile, `${entries.map(JSON.stringify).join('\n')}\n`);
  assert.deepEqual(await board.corrections({ since: new Date('2026-09-26T00:00:00.000Z'), limit: 10 }), [
    'newer Hunter', 'older Hunter',
  ]);
  assert.deepEqual(await board.corrections({ since: new Date('2026-09-26T00:00:00.000Z'), limit: 1 }), ['newer Hunter']);
});
