import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import { createNotices, firstSentence, POSTED_FILE, SUMMARY_CHARS } from '../lib/notices.mjs';
import { createThreadStore } from '../lib/threads.mjs';
import { LIMITS } from '../lib/config.mjs';
import { tempDir } from './support/harness.mjs';

const NOW = '2026-09-30T11:06:00.000Z';

// A hub stand-in: `started` says whether the Assistant counts as started;
// notify records and appends through the real store.
function fakeHub(store, { started = true } = {}) {
  const hub = {
    started,
    notified: [],
    commits: 0,
    persona: (id) => (hub.started && id === 'assistant' ? { agent: { id }, adapter: {} } : null),
    async notify(agentId, message) {
      if (hub.failNext) {
        hub.failNext = false;
        throw new Error('invented append failure');
      }
      await store.append(agentId, message);
      hub.notified.push({ agentId, ...message });
      hub.commits += 1;
      return message;
    },
  };
  return hub;
}

async function setup(t, { started = true, limits = LIMITS } = {}) {
  const briefsDir = await tempDir(t);
  const threadsDir = path.join(await tempDir(t), 'threads');
  const store = createThreadStore({ dir: threadsDir, limits });
  const hub = fakeHub(store, { started });
  const logs = [];
  const notices = createNotices({
    briefsDir, threadsDir, hub, limits, log: (entry) => logs.push(entry), now: () => new Date(NOW),
  });
  t.after(() => notices.stop());
  const writeNotice = (date, fields = {}) => writeFile(
    path.join(briefsDir, `notice-${date}.json`),
    JSON.stringify({ date, state: 'ready', opening: `Opening for ${date}. More follows.`, memo: `## Money\n\nMemo for ${date}.`, ...fields }),
  );
  const posted = async () => JSON.parse(await readFile(path.join(threadsDir, POSTED_FILE), 'utf8'));
  return { briefsDir, threadsDir, store, hub, logs, notices, writeNotice, posted };
}

test('reconcile posts one message per unposted notice, oldest first, newest two dates only', async (t) => {
  const { hub, notices, writeNotice, store, posted } = await setup(t);
  await writeNotice('2026-09-27');
  await writeNotice('2026-09-28');
  await writeNotice('2026-09-30', { opening: 'Cash is fine. Nothing is due.', memo: '## Money\n\nCash is fine.' });
  await notices.reconcile();
  assert.deepEqual(hub.notified.map((m) => [m.agentId, m.date, m.state]), [
    ['assistant', '2026-09-28', 'ready'],
    ['assistant', '2026-09-30', 'ready'],
  ]);
  assert.deepEqual(hub.notified[1], {
    agentId: 'assistant', role: 'system', kind: 'brief', date: '2026-09-30', state: 'ready',
    summary: 'Cash is fine.', text: '## Money\n\nCash is fine.', at: NOW,
  });
  const messages = await store.read('assistant');
  assert.deepEqual(messages.map((m) => m.date), ['2026-09-28', '2026-09-30']);
  assert.deepEqual((await posted()).posted, { '2026-09-28': ['ready'], '2026-09-30': ['ready'] });

  // A second reconcile posts nothing.
  await notices.reconcile();
  assert.equal(hub.notified.length, 2);
});

test('a restart after three missed dates posts two lines, not three', async (t) => {
  const { hub, notices, writeNotice } = await setup(t);
  for (const date of ['2026-09-21', '2026-09-22', '2026-09-23']) await writeNotice(date);
  await notices.reconcile();
  assert.deepEqual(hub.notified.map((m) => m.date), ['2026-09-22', '2026-09-23']);
});

test('two concurrent reconciles share one run and post once', async (t) => {
  const { hub, notices, writeNotice } = await setup(t);
  await writeNotice('2026-09-30');
  await Promise.all([notices.reconcile(), notices.reconcile(), notices.reconcile()]);
  assert.equal(hub.notified.length, 1);
});

test('a malformed or oversized notice file is logged and skipped, never deleted', async (t) => {
  const { hub, notices, logs, briefsDir, writeNotice } = await setup(t);
  await writeFile(path.join(briefsDir, 'notice-2026-09-29.json'), '{ not json');
  await writeFile(path.join(briefsDir, 'notice-2026-09-30.json'), JSON.stringify({ date: '2026-09-30', state: 'built', opening: 'x' }));
  await writeFile(path.join(briefsDir, 'notice-2026-09-31.json'), '{}'); // not a calendar date: ignored
  await writeFile(path.join(briefsDir, 'notice-2026-09-28.json'), JSON.stringify({ date: '2026-09-27', state: 'ready', opening: 'x' }));
  await notices.reconcile();
  assert.equal(hub.notified.length, 0);
  assert.deepEqual(logs.filter((e) => e.event === 'notice_invalid').map((e) => [e.date, e.reason]), [
    ['2026-09-29', 'bad_json'],
    ['2026-09-30', 'bad_state'],
  ]);
  assert.deepEqual((await readdir(briefsDir)).sort(), [
    'notice-2026-09-28.json', 'notice-2026-09-29.json', 'notice-2026-09-30.json', 'notice-2026-09-31.json',
  ]);

  // Oversized: over the file cap, skipped as too_large.
  await writeFile(path.join(briefsDir, 'notice-2026-10-01.json'), JSON.stringify({ date: '2026-10-01', state: 'ready', opening: 'x'.repeat(70 * 1024) }));
  await notices.reconcile();
  assert.equal(hub.notified.length, 0);
  assert.ok(logs.some((e) => e.event === 'notice_invalid' && e.date === '2026-10-01' && e.reason === 'too_large'));

  // A good file beside them still posts.
  await writeNotice('2026-10-02');
  await notices.reconcile();
  assert.deepEqual(hub.notified.map((m) => m.date), ['2026-10-02']);
});

test('a failed-state notice posts the sentence alone, and ready then failed posts both in order', async (t) => {
  const { hub, notices, writeNotice, posted } = await setup(t);
  await writeNotice('2026-09-30', { state: 'failed', opening: 'The morning brief did not build.' });
  await notices.reconcile();
  assert.deepEqual(hub.notified.map((m) => [m.state, m.summary, m.text]), [
    ['failed', 'The morning brief did not build.', 'The morning brief did not build.'],
  ]);
  assert.equal('memo' in hub.notified[0], false);

  // The run rebuilt: a ready notice over the failed one posts too.
  await writeNotice('2026-09-30', { opening: 'Cash is fine. More.', memo: 'Memo.' });
  await notices.reconcile();
  assert.deepEqual(hub.notified.map((m) => m.state), ['failed', 'ready']);
  assert.deepEqual((await posted()).posted, { '2026-09-30': ['failed', 'ready'] });

  // Neither posts again.
  await notices.reconcile();
  await writeNotice('2026-09-30', { state: 'failed', opening: 'The morning brief did not build.' });
  await notices.reconcile();
  assert.equal(hub.notified.length, 2);
});

test('the summary is the first sentence, the title when there is no opening paragraph, capped at 300 characters', async (t) => {
  assert.equal(firstSentence('Cash is fine. Nothing due.'), 'Cash is fine.');
  assert.equal(firstSentence('Is cash fine? Yes.'), 'Is cash fine?');
  assert.equal(firstSentence('Drift is 0.4 pts and under the band. Next.'), 'Drift is 0.4 pts and under the band.');
  assert.equal(firstSentence('  Two\n lines  here '), 'Two lines here');
  assert.equal(firstSentence('Daily Brief — Tuesday, 2026-09-30'), 'Daily Brief — Tuesday, 2026-09-30');
  const long = `${'a'.repeat(400)}. Rest.`;
  assert.equal(firstSentence(long).length, SUMMARY_CHARS);
  assert.equal(firstSentence(`${'é'.repeat(310)}.`).length, SUMMARY_CHARS);

  // build.py puts the title in `opening` when the memo has none; it posts as is.
  const { hub, notices, writeNotice } = await setup(t);
  await writeNotice('2026-09-30', { opening: 'Daily Brief — Tuesday, 2026-09-30', memo: '## Money\n\nFlat.' });
  await notices.reconcile();
  assert.equal(hub.notified[0].summary, 'Daily Brief — Tuesday, 2026-09-30');
  assert.equal(hub.notified[0].text, '## Money\n\nFlat.');
});

test('a memo over the message limit is cut by the store and flagged', async (t) => {
  const { hub, notices, writeNotice, store } = await setup(t);
  await writeNotice('2026-09-30', { memo: 'm'.repeat(LIMITS.messageTextBytes + 100) });
  await notices.reconcile();
  const [message] = await store.read('assistant');
  assert.equal(Buffer.byteLength(message.text), LIMITS.messageTextBytes);
  assert.equal(message.truncated, true);
  assert.equal(hub.notified.length, 1);
});

test('a memo-less ready notice posts the opening as its text', async (t) => {
  const { hub, notices, writeNotice } = await setup(t);
  await writeNotice('2026-09-30', { opening: 'Only an opening. Two sentences.', memo: undefined });
  await notices.reconcile();
  assert.equal(hub.notified[0].text, 'Only an opening. Two sentences.');
});

test('an unstarted Assistant skips with a log and a later reconcile posts once', async (t) => {
  const { hub, notices, logs, writeNotice, threadsDir } = await setup(t, { started: false });
  await writeNotice('2026-09-30');
  await notices.reconcile();
  assert.equal(hub.notified.length, 0);
  assert.deepEqual(logs.filter((e) => e.event === 'notice_skipped'), [
    { event: 'notice_skipped', agentId: 'assistant', date: '2026-09-30', state: 'ready', reason: 'agent_not_started' },
  ]);
  await assert.rejects(stat(path.join(threadsDir, POSTED_FILE)), { code: 'ENOENT' });

  hub.started = true;
  await notices.reconcile();
  await notices.reconcile();
  assert.equal(hub.notified.length, 1);
});

test('a failed append is logged, leaves the pair unposted, and the next reconcile retries', async (t) => {
  const { hub, notices, logs, writeNotice, threadsDir } = await setup(t);
  await writeNotice('2026-09-30');
  hub.failNext = true;
  await notices.reconcile();
  assert.equal(hub.notified.length, 0);
  assert.ok(logs.some((e) => e.event === 'notice_error' && e.error === 'invented append failure'));
  await assert.rejects(stat(path.join(threadsDir, POSTED_FILE)), { code: 'ENOENT' });
  await notices.reconcile();
  assert.equal(hub.notified.length, 1);
});

test('the posted file is written atomically with mode 600 and a bad one is treated as empty', async (t) => {
  const { notices, writeNotice, threadsDir, hub, logs, posted } = await setup(t);
  await writeNotice('2026-09-30');
  await notices.reconcile();
  const file = path.join(threadsDir, POSTED_FILE);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.deepEqual((await readdir(threadsDir)).filter((name) => name.startsWith('.')), []);
  assert.deepEqual(await posted(), { version: 1, posted: { '2026-09-30': ['ready'] } });

  await writeFile(file, 'nonsense');
  await notices.reconcile();
  assert.equal(hub.notified.length, 2);
  assert.ok(logs.some((e) => e.event === 'notice_posted_invalid'));
  assert.deepEqual((await posted()).posted, { '2026-09-30': ['ready'] });
});

test('a missing briefs directory posts nothing and does not throw', async (t) => {
  const briefsDir = path.join(await tempDir(t), 'missing');
  const threadsDir = path.join(await tempDir(t), 'threads');
  const store = createThreadStore({ dir: threadsDir, limits: LIMITS });
  const hub = fakeHub(store);
  const logs = [];
  const notices = createNotices({ briefsDir, threadsDir, hub, log: (entry) => logs.push(entry) });
  await notices.reconcile();
  assert.equal(hub.notified.length, 0);
  assert.deepEqual(logs, []);
});

test('start runs reconcile on the interval until stop', async (t) => {
  const { hub, notices, writeNotice } = await setup(t);
  assert.equal(notices.running(), false);
  notices.start(20);
  notices.start(20);
  assert.equal(notices.running(), true);
  await writeNotice('2026-09-30');
  await waitFor(() => hub.notified.length === 1);
  notices.stop();
  assert.equal(notices.running(), false);
  await writeNotice('2026-10-01');
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(hub.notified.length, 1);
});

test('the threads directory is created for the posted file when the store has not made it yet', async (t) => {
  const briefsDir = await tempDir(t);
  const threadsDir = path.join(await tempDir(t), 'nested', 'threads');
  const hub = { persona: () => ({}), notified: [], async notify(agentId, message) { hub.notified.push(message); } };
  const notices = createNotices({ briefsDir, threadsDir, hub });
  await mkdir(briefsDir, { recursive: true });
  await writeFile(path.join(briefsDir, 'notice-2026-09-30.json'), JSON.stringify({ date: '2026-09-30', state: 'ready', opening: 'Hi.' }));
  await notices.reconcile();
  assert.equal(hub.notified.length, 1);
  assert.ok((await stat(path.join(threadsDir, POSTED_FILE))).isFile());
});

async function waitFor(condition, ms = 2_000) {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
