import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { LIMITS, TIMEOUTS } from '../lib/config.mjs';
import { ScanError, readCandidatesFile, writeCandidatesFile } from '../lib/focus/candidates.mjs';
import { createFocusJobs } from '../lib/focus/jobs.mjs';
import { createFocusSettings } from '../lib/focus/settings.mjs';
import { createJobRunner } from '../lib/jobs-runner.mjs';
import { candidatesHash, signature as candidateSignature } from '../lib/focus/signature.mjs';

function candidate(source, id = 'one') { return { title: `${source} ${id}`, source, external_id: id }; }

const SCANNED = '2026-10-10T12:00:00.000Z';
const EMPTY_BOARD = { updated: SCANNED, items: [] };

// Writes one source's candidates file, fresh (curated, and signed against the
// empty board) or stale (never curated). A signature passed in stands for a
// board that has moved since.
async function seed(dir, source, { fresh, signature = undefined }) {
  const candidates = [candidate(source)];
  await writeCandidatesFile(path.join(dir, `${source}.json`), {
    scanned: SCANNED, signature: signature ?? (fresh ? candidateSignature(candidates, EMPTY_BOARD) : null),
    curated: fresh ? candidatesHash(candidates) : null, candidates,
  }, LIMITS);
}
const groupOf = (source) => ({ source, scanned: SCANNED, candidates: [candidate(source)] });
const signatureOf = async (dir, source) => (await readCandidatesFile(path.join(dir, `${source}.json`), LIMITS)).signature;
const curatedOf = async (dir, source) => (await readCandidatesFile(path.join(dir, `${source}.json`), LIMITS)).curated;

async function setup({ paused = false, now = '2026-10-10T12:00:00.000Z', scan = null, curate = null, board: givenBoard = null } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'focus-jobs-'));
  const settings = createFocusSettings({ file: path.join(dir, 'settings.json'), limits: LIMITS });
  await settings.load();
  if (paused) await settings.update({ paused: true });
  const registered = [];
  const enqueues = [];
  const runner = {
    register(job) { registered.push(job); },
    async enqueue(...args) { enqueues.push(args); return { ok: true, run: 'queued' }; },
  };
  const scans = Object.fromEntries(['calendar', 'gmail', 'git', 'notes'].map((source) => [source, scan ?? (async () => [candidate(source)])]));
  const curator = { calls: [], async run(input) { curator.calls.push(input); return curate ? curate(input) : { run: 'curator-run', outcome: 'wrote', counts: { added: 1 }, pruned: 0 }; } };
  const board = givenBoard ?? { async read() { return { board: { updated: now, items: [] }, problem: null }; } };
  const jobs = createFocusJobs({
    runner, board, settings, scans, curator, candidatesDir: dir, zone: 'America/Chicago', limits: LIMITS, timeouts: TIMEOUTS,
    now: () => new Date(now),
  });
  const byLabel = Object.fromEntries(registered.map((job) => [job.label, job]));
  const controls = { signal: new AbortController().signal, enqueue: runner.enqueue.bind(runner) };
  return { dir, settings, runner, enqueues, curator, jobs, byLabel, controls };
}

test('registers the four scans and curate with live schedules and quiet-hour guards', async () => {
  const { byLabel } = await setup();
  assert.deepEqual(Object.keys(byLabel), ['focus.scan-calendar', 'focus.scan-gmail', 'focus.scan-git', 'focus.scan-notes', 'focus.curate']);
  assert.equal(byLabel['focus.scan-calendar'].cron(), '5 * * * *');
  assert.equal(byLabel['focus.scan-calendar'].due(new Date('2026-10-10T09:59:00Z'), 'schedule'), false); // 04:59 Chicago
  assert.equal(byLabel['focus.scan-calendar'].due(new Date('2026-10-10T10:00:00Z'), 'schedule'), true);
  assert.equal(byLabel['focus.curate'].due(new Date('2026-10-11T03:00:00Z'), 'rejudge'), false); // 22:00 Chicago
  assert.equal(byLabel['focus.curate'].due(new Date('2026-10-11T03:00:00Z'), 'refresh'), true);
});

test('a changed scan keeps the old signature and queues one scan curate', async () => {
  const value = await setup();
  const result = await value.byLabel['focus.scan-calendar'].run('schedule', null, value.controls);
  assert.equal(result.outcome, 'wrote');
  const file = await readCandidatesFile(path.join(value.dir, 'calendar.json'), LIMITS);
  assert.equal(file.signature, null);
  assert.equal(value.enqueues.length, 1);
  assert.deepEqual(value.enqueues[0].slice(0, 2), ['focus.curate', 'scan']);
  assert.equal(value.enqueues[0][2].source, 'calendar');

  value.enqueues.length = 0;
  const unchanged = await value.byLabel['focus.scan-calendar'].run('schedule', null, value.controls);
  assert.equal(unchanged.outcome, 'wrote', 'the uncurated signature deliberately causes another curate');
  assert.equal(value.enqueues.length, 1);
});

test('a successful curate advances the covered signature and the next scan is unchanged', async () => {
  const value = await setup();
  const first = await value.byLabel['focus.scan-calendar'].run('schedule', null, value.controls);
  const signature = value.enqueues[0][2].signature;
  const curated = await value.byLabel['focus.curate'].run('scan', { source: 'calendar', signature }, value.controls);
  assert.equal(curated.outcome, 'wrote');
  assert.equal((await readCandidatesFile(path.join(value.dir, 'calendar.json'), LIMITS)).signature, signature);
  value.enqueues.length = 0;
  const next = await value.byLabel['focus.scan-calendar'].run('schedule', null, value.controls);
  assert.equal(next.outcome, 'no change');
  assert.equal(value.enqueues.length, 0);
});

test('a curate that moves an item stores signatures against the board it left, so the same scan is unchanged', async () => {
  let items = [{ id: 'a', status: 'open', tier: 'today', now: false, rank: 1, note: null }];
  const board = { async read() { return { board: { updated: '2026-10-10T12:00:00.000Z', items }, problem: null }; } };
  const value = await setup({
    board,
    curate: async () => {
      items = [{ ...items[0], tier: 'tomorrow' }];
      return { run: 'curator-run', outcome: 'wrote' };
    },
  });
  await value.byLabel['focus.scan-gmail'].run('schedule', null, value.controls);
  value.enqueues.length = 0;
  assert.equal((await value.byLabel['focus.scan-calendar'].run('schedule', null, value.controls)).outcome, 'wrote');
  const { signature } = value.enqueues[0][2];
  assert.equal((await value.byLabel['focus.curate'].run('scan', { source: 'calendar', signature }, value.controls)).outcome, 'wrote');
  value.enqueues.length = 0;
  assert.equal((await value.byLabel['focus.scan-calendar'].run('schedule', null, value.controls)).outcome, 'no change');
  assert.equal((await value.byLabel['focus.scan-gmail'].run('schedule', null, value.controls)).outcome, 'no change', 'the others the curator saw advance too');
  assert.equal(value.enqueues.length, 0);
});

test('failed and rejected curates leave the old signature', async () => {
  for (const outcome of ['failed', 'rejected']) {
    const value = await setup({ curate: async () => ({ run: 'inner', outcome, detail: 'No.' }) });
    await value.byLabel['focus.scan-calendar'].run('schedule', null, value.controls);
    const signature = value.enqueues[0][2].signature;
    await seed(value.dir, 'gmail', { fresh: false });
    await seed(value.dir, 'git', { fresh: true });
    await value.byLabel['focus.curate'].run('scan', { source: 'calendar', signature }, value.controls);
    assert.equal(await signatureOf(value.dir, 'calendar'), null);
    assert.equal(await signatureOf(value.dir, 'gmail'), null, 'a stale file stays stale');
    assert.equal(await curatedOf(value.dir, 'gmail'), null);
    assert.equal(await curatedOf(value.dir, 'calendar'), null);
    assert.equal(await signatureOf(value.dir, 'git'), candidateSignature([candidate('git')], EMPTY_BOARD));
  }
});

test('a rejudge hands stale files as candidates and fresh ones as others, then signs both against the board it left', async () => {
  let items = [];
  const board = { async read() { return { board: { updated: SCANNED, items }, problem: null }; } };
  const value = await setup({
    board,
    curate: async () => {
      items = [{ id: 'a', status: 'open', tier: 'today', now: false, rank: 1, note: null }];
      return { run: 'curator-run', outcome: 'wrote' };
    },
  });
  await seed(value.dir, 'calendar', { fresh: false });
  await seed(value.dir, 'gmail', { fresh: true });
  assert.equal((await value.byLabel['focus.curate'].run('rejudge', null, value.controls)).outcome, 'wrote');
  const call = value.curator.calls.at(-1);
  assert.equal(call.trigger, 'rejudge');
  assert.equal(call.source, null);
  assert.deepEqual(call.candidates, [groupOf('calendar')]);
  assert.deepEqual(call.others, [groupOf('gmail')]);
  const left = { updated: SCANNED, items };
  for (const source of ['calendar', 'gmail']) {
    assert.equal(await signatureOf(value.dir, source), candidateSignature([candidate(source)], left));
    assert.equal(await curatedOf(value.dir, source), candidatesHash([candidate(source)]), 'a wrote curate marks the file curated');
  }
});

test('a scan curate while another file is stale runs as a catch-up over both', async () => {
  const value = await setup();
  await seed(value.dir, 'calendar', { fresh: false });
  await seed(value.dir, 'gmail', { fresh: false });
  await seed(value.dir, 'git', { fresh: true });
  const answer = await value.byLabel['focus.curate'].run('scan', { source: 'calendar', signature: 'x' }, value.controls);
  assert.deepEqual(answer.covered, ['calendar', 'gmail']);
  const call = value.curator.calls.at(-1);
  assert.equal(call.trigger, 'catchup');
  assert.equal(call.source, null);
  assert.deepEqual(call.candidates, [groupOf('calendar'), groupOf('gmail')]);
  assert.deepEqual(call.others, [groupOf('git')]);
});

test('a scan curate while every other file is fresh stays a single-source scan', async () => {
  const value = await setup();
  await seed(value.dir, 'calendar', { fresh: false });
  for (const source of ['gmail', 'git', 'notes']) await seed(value.dir, source, { fresh: true });
  const answer = await value.byLabel['focus.curate'].run('scan', { source: 'calendar', signature: 'x' }, value.controls);
  assert.equal(Object.hasOwn(answer, 'covered'), false);
  const call = value.curator.calls.at(-1);
  assert.equal(call.trigger, 'scan');
  assert.equal(call.source, 'calendar');
  assert.deepEqual(call.candidates, [candidate('calendar')]);
  assert.deepEqual(call.others, ['gmail', 'git', 'notes'].map(groupOf));
});

test('a board move alone leaves a curated file fresh, so a scan curate stays a scan', async () => {
  const value = await setup();
  await seed(value.dir, 'calendar', { fresh: false });
  for (const source of ['gmail', 'git', 'notes']) await seed(value.dir, source, { fresh: true, signature: 'b'.repeat(64) });
  const answer = await value.byLabel['focus.curate'].run('scan', { source: 'calendar', signature: 'x' }, value.controls);
  assert.equal(answer.outcome, 'wrote');
  assert.equal(Object.hasOwn(answer, 'covered'), false);
  const call = value.curator.calls.at(-1);
  assert.equal(call.trigger, 'scan');
  assert.equal(call.source, 'calendar');
  assert.deepEqual(call.candidates, [candidate('calendar')]);
  assert.equal(await signatureOf(value.dir, 'gmail'), candidateSignature([candidate('gmail')], EMPTY_BOARD), 'the moved board is signed again');
});

test('paused scans write candidates but queue nothing and queued curates are refused', async () => {
  const value = await setup({ paused: true });
  const result = await value.byLabel['focus.scan-calendar'].run('schedule', null, value.controls);
  assert.equal(result.outcome, 'wrote');
  assert.equal(value.enqueues.length, 0);
  assert.equal(value.byLabel['focus.curate'].paused(), true);
  assert.equal(value.byLabel['focus.curate'].due(new Date('2026-10-10T12:00:00Z'), 'scan'), false);
  assert.equal(value.byLabel['focus.curate'].due(new Date('2026-10-10T12:00:00Z'), 'refresh'), true);
});

test('refresh is one exclusive four-scan batch and its burst always queues one curate', async () => {
  const value = await setup();
  assert.deepEqual(await value.jobs.refresh(), { ok: true, run: 'queued' });
  assert.equal(value.enqueues[0][0].length, 4);
  assert.deepEqual(value.enqueues[0][3], { exclusive: true });
  value.enqueues.length = 0;
  await value.byLabel['focus.curate'].onBurstEnd([
    { label: 'focus.scan-calendar', outcome: 'no change', trigger: 'refresh', changed: false, signature: 'a' },
    { label: 'focus.scan-gmail', outcome: 'failed', trigger: 'refresh', changed: false },
  ]);
  assert.equal(value.enqueues.length, 1);
  assert.deepEqual(value.enqueues[0].slice(0, 2), ['focus.curate', 'refresh']);
  assert.deepEqual(value.enqueues[0][2].sources, [{ source: 'calendar', signature: 'a' }, { source: 'gmail', signature: undefined }]);
});

test('catch-up fan-in includes only changed sources, and a rejudge has candidates only for stale files', async () => {
  const value = await setup();
  await writeCandidatesFile(path.join(value.dir, 'calendar.json'), {
    scanned: SCANNED, signature: null, candidates: [candidate('calendar')],
  }, LIMITS);
  await value.byLabel['focus.curate'].onBurstEnd([
    { label: 'focus.scan-calendar', outcome: 'wrote', trigger: 'catchup', changed: true, signature: 'a' },
    { label: 'focus.scan-gmail', outcome: 'no change', trigger: 'catchup', changed: false, signature: 'b' },
  ]);
  assert.deepEqual(value.enqueues[0][2], { sources: [{ source: 'calendar', signature: 'a' }] });
  await value.byLabel['focus.curate'].run('catchup', value.enqueues[0][2], value.controls);
  assert.deepEqual(value.curator.calls.at(-1).candidates, [groupOf('calendar')]);
  // The catch-up signed calendar against the board, so nothing is stale.
  await value.byLabel['focus.curate'].run('rejudge', null, value.controls);
  assert.deepEqual(value.curator.calls.at(-1).candidates, []);
  assert.deepEqual(value.curator.calls.at(-1).others, [groupOf('calendar')]);
  await seed(value.dir, 'gmail', { fresh: false });
  await value.byLabel['focus.curate'].run('rejudge', null, value.controls);
  assert.deepEqual(value.curator.calls.at(-1).candidates, [groupOf('gmail')]);
  assert.deepEqual(value.curator.calls.at(-1).others, [groupOf('calendar')]);
});

test('ScanError codes use stable user sentences and other errors keep their message', async () => {
  const cases = {
    google_signed_out: 'Sign in to Google first.', google_reauth: 'Sign in to Google again.', google_failed: 'Google did not answer.',
    gh_failed: 'GitHub could not be read.', vault_unavailable: 'The vault folder is not available.',
    invalid_candidates: 'The scan produced candidates the board cannot take.',
  };
  for (const [code, detail] of Object.entries(cases)) {
    const value = await setup({ scan: async () => { throw new ScanError(code, 'diagnostic'); } });
    assert.deepEqual(await value.byLabel['focus.scan-calendar'].run('schedule', null, value.controls), { outcome: 'failed', detail });
  }
  const value = await setup({ scan: async () => { throw new Error('Invented failure.'); } });
  assert.equal((await value.byLabel['focus.scan-calendar'].run('schedule', null, value.controls)).detail, 'Invented failure.');
});

test('candidate file JSON carries null before curation', async () => {
  const value = await setup();
  await value.byLabel['focus.scan-calendar'].run('schedule', null, value.controls);
  assert.equal(JSON.parse(await readFile(path.join(value.dir, 'calendar.json'), 'utf8')).signature, null);
});

// A real runner on a fixed clock. The scans' logs carry a future occurrence so
// only the curate is due.
async function withRunner(t, { now: start, seed = true }) {
  let now = start;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'focus-jobs-runner-'));
  const runsDir = path.join(dir, 'runs');
  await mkdir(runsDir, { recursive: true });
  for (const source of seed ? ['calendar', 'gmail', 'git', 'notes'] : []) {
    await writeFile(path.join(runsDir, `focus.scan-${source}.jsonl`), `${JSON.stringify({ run: `seed-${source}`, occurrence: '2099-01-01T00:00:00.000Z', trigger: 'schedule', startedAt: now, endedAt: now, outcome: 'no change' })}\n`);
  }
  const settings = createFocusSettings({ file: path.join(dir, 'settings.json'), limits: LIMITS });
  await settings.load();
  let uuid = 0;
  const runner = createJobRunner({
    runsDir, zone: 'America/Chicago', limits: LIMITS, now: () => new Date(now), randomUUID: () => `run-${++uuid}`,
    onTick: () => settings.reload(),
    setTimeout: () => ({ unref() {} }), clearTimeout: () => {},
  });
  t.after(() => runner.stop());
  const curator = { calls: [], async run(input) { curator.calls.push(input); return { run: 'curator-run', outcome: 'no change' }; } };
  const board = { async read() { return { board: { updated: now, items: [] }, problem: null }; } };
  const scans = Object.fromEntries(['calendar', 'gmail', 'git', 'notes'].map((source) => [source, async () => [candidate(source)]]));
  const jobs = createFocusJobs({ runner, board, settings, scans, curator, candidatesDir: dir, zone: 'America/Chicago', limits: LIMITS, timeouts: TIMEOUTS, now: () => new Date(now) });
  return { runner, curator, jobs, settingsFile: path.join(dir, 'settings.json'), set: (iso) => { now = iso; } };
}

async function settle(condition) {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition did not hold');
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test('the curate\'s scheduled occurrence reaches the curator as a rejudge and its start line says so', async (t) => {
  const { runner, curator } = await withRunner(t, { now: '2026-10-10T10:30:10.000Z' }); // 05:30:10 Chicago
  await runner.start();
  await runner.tick();
  assert.equal(curator.calls.length, 1);
  assert.equal(curator.calls[0].trigger, 'rejudge');
  assert.deepEqual(curator.calls[0].candidates, []);
  assert.equal(runner.lastRun('focus.curate').trigger, 'rejudge');
  assert.equal(runner.lastRun('focus.curate').occurrence, '2026-10-10T10:30:00.000Z');
});

test('a curate catch-up with sources stays a catch-up, and one without sources is a rejudge', async (t) => {
  const { runner, curator } = await withRunner(t, { now: '2026-10-10T10:30:10.000Z' });
  await runner.start();
  await runner.tick();
  curator.calls.length = 0;
  await runner.enqueue('focus.curate', 'catchup', { sources: [{ source: 'calendar', signature: 'a' }] });
  await settle(() => curator.calls.length === 1);
  assert.equal(curator.calls[0].trigger, 'catchup');
  await settle(() => runner.lastRun('focus.curate')?.endedAt && runner.lastRun('focus.curate').trigger === 'catchup');
  await runner.enqueue('focus.curate', 'catchup');
  await settle(() => curator.calls.length === 2);
  assert.equal(curator.calls[1].trigger, 'rejudge');
});

test('a refresh through the runner queues its curate from the results\' trigger, and scan end lines carry no burst', async (t) => {
  const { runner, curator, jobs } = await withRunner(t, { now: '2026-10-10T10:30:10.000Z' });
  await runner.start();
  await runner.tick();
  curator.calls.length = 0;
  assert.equal((await jobs.refresh()).ok, true);
  await settle(() => curator.calls.length === 1 && runner.state().running === null);
  assert.equal(curator.calls[0].trigger, 'refresh');
  assert.equal(curator.calls[0].candidates.length, 4);
  const scan = runner.lastRun('focus.scan-calendar');
  assert.equal(scan.trigger, 'refresh');
  assert.equal(scan.changed, true);
  assert.equal(typeof scan.signature, 'string');
  assert.equal(Object.hasOwn(scan, 'burst'), false);
});

test('refresh and catch-up scans queue nothing and carry changed and signature', async () => {
  for (const trigger of ['refresh', 'catchup']) {
    const value = await setup();
    const result = await value.byLabel['focus.scan-calendar'].run(trigger, null, value.controls);
    assert.equal(value.enqueues.length, 0);
    assert.equal(result.outcome, 'wrote');
    assert.equal(result.changed, true);
    assert.equal(typeof result.signature, 'string');
    assert.equal(Object.hasOwn(result, 'burst'), false);
  }
});

test('a catch-up burst that includes the curate\'s own occurrence calls the curator once', async (t) => {
  const { runner, curator } = await withRunner(t, { now: '2026-10-10T10:30:10.000Z', seed: false }); // 05:30:10 Chicago
  await runner.start();
  await runner.tick();
  assert.deepEqual(['calendar', 'gmail', 'git', 'notes'].map((source) => [runner.lastRun(`focus.scan-${source}`).trigger, runner.lastRun(`focus.scan-${source}`).changed]),
    [['catchup', true], ['catchup', true], ['catchup', true], ['catchup', true]]);
  assert.equal(curator.calls.length, 1);
  assert.equal(curator.calls[0].trigger, 'rejudge');
  assert.deepEqual(curator.calls[0].candidates.map((group) => group.source), ['calendar', 'gmail', 'git', 'notes'], 'the night\'s new candidates are placed');
  assert.equal(curator.calls[0].others.length, 0);
  assert.equal(runner.runs('focus.curate').length, 1);
});

test('a schedule changed on disk is the next tick\'s cron', async (t) => {
  const { runner, curator, settingsFile, set } = await withRunner(t, { now: '2026-10-10T10:30:10.000Z' });
  await runner.start();
  await runner.tick();
  assert.equal(curator.calls.length, 1);
  await writeFile(settingsFile, JSON.stringify({
    version: 1, paused: false,
    schedules: { calendar: '5 * * * *', gmail: '35 * * * *', git: '15 6,10,14,18 * * *', notes: '45 5,7,11,15,19 * * *', rejudge: '31 5 * * *' },
    model: { id: null, effort: null },
  }));
  set('2026-10-10T10:31:10.000Z');
  await runner.tick();
  assert.equal(curator.calls.length, 2);
  assert.equal(runner.lastRun('focus.curate').occurrence, '2026-10-10T10:31:00.000Z');
  assert.equal(runner.rows().at(-1).schedule.text, 'Every day at 5:31');
});

test('the curator is handed the runner\'s run id, so its changes lines and the runs log share it', async (t) => {
  const { runner, curator } = await withRunner(t, { now: '2026-10-10T10:30:10.000Z' });
  await runner.start();
  await runner.tick();
  assert.equal(curator.calls.length, 1);
  const record = runner.lastRun('focus.curate');
  assert.equal(typeof record.run, 'string');
  assert.equal(curator.calls[0].run, record.run);
});
