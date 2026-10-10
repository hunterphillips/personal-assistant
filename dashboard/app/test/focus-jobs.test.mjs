import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { LIMITS, TIMEOUTS } from '../lib/config.mjs';
import { ScanError, readCandidatesFile, writeCandidatesFile } from '../lib/focus/candidates.mjs';
import { createFocusJobs } from '../lib/focus/jobs.mjs';
import { createFocusSettings } from '../lib/focus/settings.mjs';

function candidate(source, id = 'one') { return { title: `${source} ${id}`, source, external_id: id }; }

async function setup({ paused = false, now = '2026-10-10T12:00:00.000Z', scan = null, curate = null } = {}) {
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
  const board = { async read() { return { board: { updated: now, items: [] }, problem: null }; } };
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

test('failed and rejected curates leave the old signature', async () => {
  for (const outcome of ['failed', 'rejected']) {
    const value = await setup({ curate: async () => ({ run: 'inner', outcome, detail: 'No.' }) });
    await value.byLabel['focus.scan-calendar'].run('schedule', null, value.controls);
    const signature = value.enqueues[0][2].signature;
    await value.byLabel['focus.curate'].run('scan', { source: 'calendar', signature }, value.controls);
    assert.equal((await readCandidatesFile(path.join(value.dir, 'calendar.json'), LIMITS)).signature, null);
  }
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
    { label: 'focus.scan-calendar', outcome: 'no change', burst: 'refresh', changed: false, signature: 'a' },
    { label: 'focus.scan-gmail', outcome: 'failed', burst: 'refresh', changed: false },
  ]);
  assert.equal(value.enqueues.length, 1);
  assert.deepEqual(value.enqueues[0].slice(0, 2), ['focus.curate', 'refresh']);
  assert.deepEqual(value.enqueues[0][2].sources, [{ source: 'calendar', signature: 'a' }, { source: 'gmail', signature: undefined }]);
});

test('catch-up fan-in includes only changed sources and rejudge has no candidates', async () => {
  const value = await setup();
  await writeCandidatesFile(path.join(value.dir, 'calendar.json'), {
    scanned: '2026-10-10T12:00:00.000Z', signature: null, candidates: [candidate('calendar')],
  }, LIMITS);
  await value.byLabel['focus.curate'].onBurstEnd([
    { label: 'focus.scan-calendar', outcome: 'wrote', burst: 'catchup', changed: true, signature: 'a' },
    { label: 'focus.scan-gmail', outcome: 'no change', burst: 'catchup', changed: false, signature: 'b' },
  ]);
  assert.deepEqual(value.enqueues[0][2], { sources: [{ source: 'calendar', signature: 'a' }] });
  await value.byLabel['focus.curate'].run('catchup', value.enqueues[0][2], value.controls);
  assert.deepEqual(value.curator.calls.at(-1).candidates, [{
    source: 'calendar', scanned: '2026-10-10T12:00:00.000Z', candidates: [candidate('calendar')],
  }]);
  await value.byLabel['focus.curate'].run('rejudge', null, value.controls);
  assert.deepEqual(value.curator.calls.at(-1).candidates, []);
  assert.deepEqual(value.curator.calls.at(-1).others, [{
    source: 'calendar', scanned: '2026-10-10T12:00:00.000Z', candidates: [candidate('calendar')],
  }]);
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
