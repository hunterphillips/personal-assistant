import assert from 'node:assert/strict';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import { createBoard } from '../lib/focus/board.mjs';
import { createCurator } from '../lib/focus/curate.mjs';
import { tempDir } from './support/harness.mjs';

const FIXTURE = new URL('./fixtures/focus/board.json', import.meta.url);
const NOW = new Date('2026-10-10T15:00:00.000Z');
const LIMITS = { focusBoardBytes: 4 * 1024 * 1024, focusChangesLines: 100, briefInstructionsBytes: 64 * 1024 };
const TIMEOUTS = { focusCurateMs: 1_000 };

const init = (extra = {}) => ({ type: 'system', subtype: 'init', apiKeySource: 'none', ...extra });
const result = (structured_output = { ops: [] }, extra = {}) => ({
  type: 'result', subtype: 'success', is_error: false, structured_output,
  total_cost_usd: 0.02, usage: { input_tokens: 100, output_tokens: 12 }, ...extra,
});

function fakeQuery(generator) {
  const calls = [];
  const query = (args) => { calls.push(args); return generator(args); };
  query.calls = calls;
  return query;
}

async function setup(t, { query, body, importSdk, timeouts = TIMEOUTS, focusModel = { id: null, effort: null }, systemModel = { default: null, effort: null } } = {}) {
  const dir = await tempDir(t);
  const focusDir = path.join(dir, 'focus');
  const file = path.join(focusDir, 'board.json');
  const changesFile = path.join(focusDir, 'changes.jsonl');
  const candidatesDir = path.join(focusDir, 'candidates');
  const rules = path.join(focusDir, 'rules.md');
  await mkdir(candidatesDir, { recursive: true });
  await writeFile(file, body ?? await readFile(FIXTURE));
  await writeFile(rules, 'RULES NOW\nCurate carefully.\n');
  const board = createBoard({ file, changesFile, candidatesDir, limits: LIMITS, now: () => NOW });
  const settings = { current: () => ({ model: focusModel }) };
  const systemSettings = { current: () => ({ settings: { model: systemModel } }) };
  const curator = createCurator({
    query, importSdk, board, rules, vault: { readPriorities: () => 'Priority text', readProjectState: () => 'Project state' },
    profile: { read: async () => 'Profile text' }, settings, systemSettings,
    zone: 'America/Chicago', limits: LIMITS, timeouts, cwd: focusDir, now: () => NOW,
  });
  return { board, changesFile, curator, file, focusDir, rules };
}

async function changeLines(file) {
  try { return (await readFile(file, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); } catch { return []; }
}

test('the scan prompt carries every section in order, compact tombstones, other candidates, and fresh rules', async (t) => {
  const query = fakeQuery(async function* () { yield init(); yield result(); });
  const found = await setup(t, { query });
  await writeFile(found.rules, 'FRESH RULES\n');
  await found.board.change({ op: 'note', id: 'today-one', note: 'Use the short version' });
  const answer = await found.curator.run({
    trigger: 'scan', source: 'gmail', candidates: [{ title: 'Current mail' }],
    others: [{ source: 'calendar', scanned: '2026-10-10T14:00:00.000Z', candidates: [{ title: 'Other event' }] }],
  });
  assert.equal(answer.outcome, 'no change');
  const prompt = query.calls[0].prompt;
  const headings = [
    'FRESH RULES', '=== CURRENT TIME ===', '=== STANDING PRIORITIES', '=== PROJECT STATE',
    '=== WHO THE USER IS', '=== ITEM SCHEMA', '=== YOUR ANSWER', '=== CURRENT DOCUMENT',
    '=== CLOSED ITEMS', '=== CANDIDATES (source: gmail)', '=== LATEST CANDIDATES FROM THE OTHER SOURCES',
    '=== RECENT USER CORRECTIONS', '=== YOUR OUTPUT ===',
  ];
  assert.ok(prompt.startsWith('FRESH RULES\n'));
  let position = 0;
  for (const heading of headings.slice(1)) {
    const next = prompt.indexOf(heading);
    assert.ok(next > position, `${heading} follows the prior section`);
    position = next;
  }
  assert.match(prompt, /Current mail/);
  assert.match(prompt, /Other event/);
  assert.match(prompt, /note "Choose a workshop topic"/);
  assert.doesNotMatch(prompt, /--- gmail \(scanned/);
  assert.match(prompt, /\{"id":"done-one","title":"Confirm the sample order"/);
  assert.doesNotMatch(prompt, /"id": "done-one"/);
});

test('rejudge has no candidates and refresh renders one candidates section per source', async (t) => {
  const query = fakeQuery(async function* () { yield init(); yield result(); });
  const found = await setup(t, { query });
  await found.curator.run({ trigger: 'rejudge', candidates: [], others: [] });
  assert.match(query.calls[0].prompt, /=== REJUDGE ===/);
  assert.doesNotMatch(query.calls[0].prompt, /=== CANDIDATES \(source:/);
  await found.curator.run({
    trigger: 'refresh', candidates: [
      { source: 'gmail', candidates: [{ title: 'Mail' }] },
      { source: 'notes', candidates: [{ title: 'Note' }] },
    ], others: [{ source: 'git', scanned: 'now', candidates: [{ title: 'PR' }] }],
  });
  assert.equal((query.calls[1].prompt.match(/=== CANDIDATES \(source:/g) ?? []).length, 2);
  assert.match(query.calls[1].prompt, /source: gmail/);
  assert.match(query.calls[1].prompt, /source: notes/);
});

test('a prune happens before the prompt and is logged as the daemon', async (t) => {
  const document = JSON.parse(await readFile(FIXTURE));
  document.items.push({
    id: 'old-tombstone', title: 'Old closed task', source: 'notes', external_id: 'old', link: null, meta: null,
    tier: 'later', now: false, status: 'expired', created: '2026-07-01T00:00:00.000Z', updated: '2026-08-01T00:00:00.000Z',
  });
  const query = fakeQuery(async function* () { yield init(); yield result(); });
  const found = await setup(t, { query, body: JSON.stringify(document) });
  const answer = await found.curator.run({ trigger: 'rejudge' });
  assert.equal(answer.pruned, 1);
  assert.doesNotMatch(query.calls[0].prompt, /Old closed task/);
  assert.equal((await changeLines(found.changesFile))[0].who, 'daemon');
});

test('failed SDK results and API-key init messages are failed outcomes', async (t) => {
  const bad = fakeQuery(async function* () {
    yield init();
    yield result(null, { subtype: 'error_max_structured_output_retries', is_error: true, errors: ['The answer did not match the schema.'] });
  });
  const first = await setup(t, { query: bad });
  assert.deepEqual(await first.curator.run({ trigger: 'rejudge' }), {
    outcome: 'failed', detail: 'The answer did not match the schema.', pruned: 0,
    usage: { input: 100, output: 12, costUsd: 0.02 },
  });

  let aborted = false;
  const billed = fakeQuery(async function* ({ options }) {
    options.abortController.signal.addEventListener('abort', () => { aborted = true; });
    yield init({ apiKeySource: 'ANTHROPIC_API_KEY' });
    assert.equal(options.abortController.signal.aborted, true);
  });
  const second = await setup(t, { query: billed });
  const answer = await second.curator.run({ trigger: 'rejudge' });
  assert.equal(answer.outcome, 'failed');
  assert.equal(answer.detail, 'This call would bill an API key.');
  assert.equal(aborted, true);
});

test('rejected, written, stale, and empty op answers map to curator outcomes', async (t) => {
  const rejectedQuery = fakeQuery(async function* () { yield init(); yield result({ ops: [{ op: 'expire', id: 'done-one' }] }); });
  const rejected = await setup(t, { query: rejectedQuery });
  const rejectedBefore = await readFile(rejected.file);
  const rejectedAnswer = await rejected.curator.run({ trigger: 'rejudge' });
  assert.equal(rejectedAnswer.outcome, 'rejected');
  assert.match(rejectedAnswer.detail, /may not touch/);
  assert.equal((await changeLines(rejected.changesFile)).length, 0);
  assert.deepEqual(await readFile(rejected.file), rejectedBefore);

  const expireQuery = fakeQuery(async function* () { yield init(); yield result({ ops: [{ op: 'expire', id: 'tomorrow-one', meta: 'Shipped' }] }); });
  const expired = await setup(t, { query: expireQuery });
  const expiredAnswer = await expired.curator.run({ trigger: 'scan', source: 'git', candidates: [] });
  assert.equal(expiredAnswer.outcome, 'wrote');
  assert.deepEqual(expiredAnswer.counts, { added: 0, changed: 0, expired: 1 });
  assert.equal((await changeLines(expired.changesFile))[0].who, 'curator');

  let staleBoard;
  let staleBefore;
  let staleLines;
  const staleQuery = fakeQuery(async function* () {
    yield init();
    await staleBoard.change({ op: 'note', id: 'today-one', note: 'Changed while curating' });
    staleBefore = await readFile(stale.file);
    staleLines = await changeLines(stale.changesFile);
    yield result({ ops: [{ op: 'expire', id: 'tomorrow-one' }] });
  });
  const stale = await setup(t, { query: staleQuery });
  staleBoard = stale.board;
  const staleAnswer = await stale.curator.run({ trigger: 'rejudge' });
  assert.deepEqual(staleAnswer.outcome, 'skipped');
  assert.equal(staleAnswer.detail, 'The board changed during the call.');
  assert.equal((await changeLines(stale.changesFile)).filter((line) => line.who === 'curator').length, 0);
  assert.deepEqual(await changeLines(stale.changesFile), staleLines);
  assert.deepEqual(await readFile(stale.file), staleBefore);

  const emptyQuery = fakeQuery(async function* () { yield init(); yield result({ ops: [] }); });
  const empty = await setup(t, { query: emptyQuery });
  assert.equal((await empty.curator.run({ trigger: 'rejudge' })).outcome, 'no change');
});

test('caller aborts fail the run with a sentence', async (t) => {
  const started = Promise.withResolvers();
  const query = fakeQuery(async function* ({ options }) {
    yield init();
    started.resolve();
    await new Promise((resolve) => options.abortController.signal.addEventListener('abort', resolve, { once: true }));
    throw new Error('Claude Code process aborted by user');
  });
  const found = await setup(t, { query });
  const controller = new AbortController();
  const running = found.curator.run({ trigger: 'rejudge', signal: controller.signal });
  await started.promise;
  controller.abort();
  const answer = await running;
  assert.equal(answer.outcome, 'failed');
  assert.equal(answer.detail, 'The run was stopped.');
});

test('a timed-out call fails with a sentence', async (t) => {
  const query = fakeQuery(async function* ({ options }) {
    yield init();
    await new Promise((resolve) => options.abortController.signal.addEventListener('abort', resolve, { once: true }));
    throw new Error('Claude Code process aborted by user');
  });
  const found = await setup(t, { query, timeouts: { focusCurateMs: 20 } });
  const answer = await found.curator.run({ trigger: 'rejudge' });
  assert.equal(answer.outcome, 'failed');
  assert.equal(answer.detail, 'The curator timed out.');
});

test('a missing or invalid board and an unloadable SDK fail with sentences', async (t) => {
  const query = fakeQuery(async function* () { yield init(); yield result(); });
  const missing = await setup(t, { query });
  await unlink(missing.file);
  assert.equal((await missing.curator.run({ trigger: 'rejudge' })).detail, 'The board file is missing.');

  const invalid = await setup(t, { query, body: '{' });
  assert.equal((await invalid.curator.run({ trigger: 'rejudge' })).detail, 'The board file is not valid.');
  assert.equal(query.calls.length, 0);

  const unloadable = await setup(t, { importSdk: async () => { throw new Error('Cannot find package'); } });
  const answer = await unloadable.curator.run({ trigger: 'rejudge' });
  assert.equal(answer.outcome, 'failed');
  assert.equal(answer.detail, 'The Claude Agent SDK could not be loaded.');
});

test('query options are isolated and model choices follow Focus then system settings', async (t) => {
  const focusQuery = fakeQuery(async function* () { yield init(); yield result(); });
  const focus = await setup(t, { query: focusQuery, focusModel: { id: 'focus-model', effort: 'high' }, systemModel: { default: 'system-model', effort: 'low' } });
  await focus.curator.run({ trigger: 'rejudge' });
  const options = focusQuery.calls[0].options;
  assert.deepEqual(options.outputFormat, { type: 'json_schema', schema: options.outputFormat.schema });
  assert.equal(options.outputFormat.type, 'json_schema');
  assert.deepEqual(options.tools, []);
  assert.deepEqual(options.settingSources, []);
  assert.equal(options.persistSession, false);
  assert.equal(options.permissionMode, 'dontAsk');
  assert.equal(Object.hasOwn(options, 'mcpServers'), false);
  assert.equal(options.model, 'focus-model');
  assert.equal(options.effort, 'high');

  const systemQuery = fakeQuery(async function* () { yield init(); yield result(); });
  const system = await setup(t, { query: systemQuery, systemModel: { default: 'system-model', effort: 'medium' } });
  await system.curator.run({ trigger: 'rejudge' });
  assert.equal(systemQuery.calls[0].options.model, 'system-model');
  assert.equal(systemQuery.calls[0].options.effort, 'medium');

  const defaultQuery = fakeQuery(async function* () { yield init(); yield result(); });
  const defaults = await setup(t, { query: defaultQuery });
  await defaults.curator.run({ trigger: 'rejudge' });
  assert.equal(Object.hasOwn(defaultQuery.calls[0].options, 'model'), false);
  assert.equal(Object.hasOwn(defaultQuery.calls[0].options, 'effort'), false);
});

test('query null disables model calls', async (t) => {
  const found = await setup(t, { query: null });
  assert.deepEqual(await found.curator.run({ trigger: 'rejudge' }), {
    outcome: 'failed', detail: 'Model calls are off while an API key is in the daemon\'s environment.', pruned: 0,
  });
});
