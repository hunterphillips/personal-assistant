// Quick chat's pure helpers, loaded from public/ into a bare window:
// the context cut to the route's caps, a job's facts as lines, and the
// thread line's words. Nothing here touches the DOM.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const context = { window: {} };
for (const file of ['markdown.js', 'agents.js', 'jobs.js', 'quick-chat.js']) {
  vm.runInNewContext(readFileSync(new URL(`../public/${file}`, import.meta.url), 'utf8'), context);
}
const { DashboardQuickChat: quick, DashboardJobs: jobs, DashboardAgents: agents } = context.window;
const plain = (value) => JSON.parse(JSON.stringify(value));

test('fitContext cuts a long label or detail to the route caps and drops empty ones', () => {
  const fitted = plain(quick.fitContext({ view: 'feed', label: 'x'.repeat(250), detail: 'y'.repeat(2500) }));
  assert.equal(Array.from(fitted.label).length, 200);
  assert.ok(fitted.label.endsWith('…'));
  assert.equal(Array.from(fitted.detail).length, 2000);
  assert.deepEqual(plain(quick.fitContext({ view: 'goals', label: '' })), { view: 'goals' });
  assert.deepEqual(plain(quick.fitContext({ view: 'health', label: 'Nightly', detail: 'Outcome: ok' })), { view: 'health', label: 'Nightly', detail: 'Outcome: ok' });
  assert.equal(quick.fitContext(null), null);
});

test('jobDetail lists what the snapshot has for the job, with the agent by its listed name', () => {
  const job = {
    label: 'com.hunter.cfo.daily', agentId: 'cfo', agentName: 'Old name', schedule: { text: 'Daily at 06:00' },
    lastRun: '2026-10-03T11:00:00.000Z', outcome: 'failed', exitStatus: 78, failures24h: 2, paused: null, source: 'launchctl', available: true,
  };
  assert.equal(jobs.jobDetail(job, { agents: [{ id: 'cfo', name: 'CFO' }] }), [
    'Job: com.hunter.cfo.daily', 'Agent: CFO', 'Schedule: Daily at 06:00', 'Last run: 2026-10-03T11:00:00.000Z',
    'Outcome: failed (exit 78)', 'Failures in the last day: 2', 'Source: launchctl',
  ].join('\n'));
  // An agent the registry no longer lists keeps the job's own name; a job never run says so.
  const bare = { label: 'com.x', agentId: 'gone', agentName: 'Gone', schedule: null, lastRun: null, outcome: 'unknown', exitStatus: null, available: false, paused: true };
  assert.equal(jobs.jobDetail(bare, { agents: [] }), ['Job: com.x', 'Agent: Gone', 'Last run: never', 'Outcome: unknown', 'Paused'].join('\n'));
});

test('a context line reads Sent from the view, with the label when there is one', () => {
  assert.equal(agents.contextSummary({ view: 'health', label: 'cfo.daily' }), 'Sent from Health: cfo.daily');
  assert.equal(agents.contextSummary({ view: 'focus' }), 'Sent from Focus.');
});
