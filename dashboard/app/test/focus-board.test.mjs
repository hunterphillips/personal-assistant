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
