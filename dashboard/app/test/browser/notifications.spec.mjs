// Notifications: the header count, the list under the header, Acknowledge
// and Acknowledge all, and each link opening its target. The store is a
// temporary file (browser-server.mjs); a persona seeded with `notify`
// raises one through the notify tool's own path.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, expectView, test } from '../support/browser-test.mjs';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const ASSISTANT = Object.freeze({
  id: 'assistant', name: 'Assistant', role: 'Assistant', description: 'Invented.', group: 'personal', kind: 'persona',
  cwd: '/invented', provider: 'claude', pinned: true,
});
const CFO = Object.freeze({ ...ASSISTANT, id: 'cfo', name: 'CFO', role: 'Money', pinned: false });
const JOB = Object.freeze({
  label: 'com.invented.drift', agentId: 'cfo', agentName: 'CFO', name: 'Daily drift',
  schedule: { kind: 'calendar', text: 'Daily at 06:30' }, logPath: '/invented/drift.log',
  lastRun: new Date().toISOString(), outcome: 'ok', exitStatus: 0, failures24h: 0, paused: null, source: 'launchctl', available: true,
});

const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();

// The count on the entry Hunter can see: the header's on a desk, the menu
// toggle's on a phone.
function countOf(page) {
  return page.viewportSize().width < 720 ? page.locator('#app-menu-count') : page.locator('#notifications-count');
}

async function openList(page) {
  if (page.viewportSize().width < 720) {
    await page.getByRole('button', { name: /^Menu/ }).click();
    await page.locator('#notifications-menu-entry').click();
    await expect(page.locator('#app-menu')).toBeHidden();
  } else {
    await page.locator('#notifications-toggle').click();
  }
  const panel = page.getByRole('dialog', { name: 'Notifications' });
  await expect(panel).toBeVisible();
  return panel;
}

test.describe('the list', () => {
  test.use({
    hubOptions: {
      build: () => ({
        agents: [ASSISTANT, CFO],
        jobs: { refreshedAt: new Date().toISOString(), focusAvailable: true, items: [JOB] },
        feed: path.join(FIXTURES, 'feed'),
        notifications: [
          { id: 'n-old', agent: 'assistant', text: 'The vault audit from last week is done.', at: minutesAgo(600), acknowledgedAt: minutesAgo(500) },
          { id: 'n-job', agent: 'cfo', text: 'Unusual activity on the card ending 0000.', link: 'job:com.invented.drift', at: minutesAgo(120) },
          { id: 'n-gone', agent: 'old-agent', text: 'An agent since removed left this.', link: 'agent:old-agent', at: minutesAgo(30) },
        ],
      }),
    },
  });

  test('the count shows the open ones; the list puts them first and the acknowledged under a divider', async ({ page, hub }) => {
    await page.goto(hub.origin + '/goals');
    await expectView(page, 'goals', 'Goals');
    await expect(countOf(page)).toHaveText('2');
    const panel = await openList(page);
    await expect(panel.locator('#notifications-open .notification-text')).toHaveText([
      'An agent since removed left this.', 'Unusual activity on the card ending 0000.',
    ]);
    await expect(panel.locator('#notifications-open .notification-agent')).toHaveText(['old-agent', 'CFO']);
    await expect(panel.locator('#notifications-open .notification-time')).toHaveText(['30 minutes ago', '2 hours ago']);
    await expect(panel.locator('#notifications-open .notification-link')).toHaveText(['old-agent', 'Daily drift']);
    await expect(panel.getByRole('heading', { name: 'Acknowledged' })).toBeVisible();
    await expect(panel.locator('#notifications-acknowledged .notification-text')).toHaveText(['The vault audit from last week is done.']);
    await expect(panel.locator('#notifications-acknowledged button')).toHaveCount(0);

    await panel.locator('[data-notification-id="n-job"]').getByRole('button', { name: 'Acknowledge' }).click();
    await expect(countOf(page)).toHaveText('1');
    await expect(panel.locator('#notifications-acknowledged .notification-text')).toHaveText([
      'Unusual activity on the card ending 0000.', 'The vault audit from last week is done.',
    ]);
    await panel.getByRole('button', { name: 'Acknowledge all' }).click();
    await expect(countOf(page)).toBeHidden();
    await expect(panel.locator('#notifications-open')).toBeHidden();
    await expect(panel.getByRole('button', { name: 'Acknowledge all' })).toBeHidden();
    await expect(panel.locator('#notifications-acknowledged .notification')).toHaveCount(3);
    expect(hub.notifications.view().items.every((item) => item.acknowledgedAt !== null)).toBe(true);
  });

  test('Escape and an outside click close it', async ({ page, hub }) => {
    await page.goto(hub.origin + '/goals');
    let panel = await openList(page);
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    panel = await openList(page);
    await page.locator('#app-header-title').click();
    await expect(panel).toBeHidden();
  });

  test('a job link opens Health with the job selected, and a gone agent opens Agents with the sentence', async ({ page, hub }) => {
    await page.goto(hub.origin + '/goals');
    let panel = await openList(page);
    await panel.getByRole('button', { name: 'Daily drift' }).click();
    await expect(panel).toBeHidden();
    await expectView(page, 'health', 'Health');
    await expect(page.locator('[data-job-label="com.invented.drift"]')).toHaveAttribute('aria-current', 'true');

    panel = await openList(page);
    await panel.getByRole('button', { name: 'old-agent' }).click();
    await expect(page).toHaveURL(hub.origin + '/?agent=old-agent');
    await expect(page.locator('#agent-empty')).toHaveText('No agent named old-agent is registered.');
  });
});

test.describe('feed and brief links', () => {
  test.use({
    hubOptions: {
      agents: [ASSISTANT],
      feed: path.join(FIXTURES, 'feed'),
      notifications: [
        { id: 'n-feed', agent: 'assistant', text: 'A story you asked about is in the feed.', link: 'feed:2026-09-28-watch/6' },
        { id: 'n-brief', agent: 'assistant', text: 'The brief has a decision for you.', link: 'brief:2026-10-03' },
      ],
    },
  });

  test('a feed link opens the Feed on that item, a brief link opens that brief over the view', async ({ page, hub }) => {
    await hub.writeBrief('2026-10-03');
    await hub.writeBrief('2026-10-04', { title: 'Invented later brief' });
    await page.goto(hub.origin + '/health');
    let panel = await openList(page);
    await expect(panel.locator('.notification-link')).toHaveText(['Brief for October 3', 'The last typewriter shop']);
    await panel.getByRole('button', { name: 'The last typewriter shop' }).click();
    await expect(page).toHaveURL(hub.origin + '/feed');
    const item = page.locator('[data-feed-run="2026-09-28-watch"] .feed-item').nth(6);
    await expect(item).toHaveAttribute('data-feed-target', '');
    await expect(item).toBeInViewport();
    await expect(page.locator('.feed-item[data-feed-target]')).toHaveCount(1);

    panel = await openList(page);
    await panel.getByRole('button', { name: 'Brief for October 3' }).click();
    await expect(page.getByRole('dialog', { name: 'Brief' })).toBeVisible();
    await expect(page.locator('.brief-date')).toHaveText(/^Saturday, October 3(, 2026)?$/);
    await expect(page.locator('.brief-title')).toHaveText('Invented brief for tests, not a real day');
    await expect(page).toHaveURL(hub.origin + '/feed');
  });
});

test.describe('raised by an agent', () => {
  test.use({
    hubOptions: {
      agents: [ASSISTANT, CFO],
      personas: { cfo: { notify: { text: 'Unusual activity on the card.', link: 'agent:cfo' } } },
    },
  });

  test('a notify call from a turn adds one item and raises the count in two pages, with nothing posted in a thread', async ({ page, hub }) => {
    const second = await page.context().newPage();
    try {
      await Promise.all([page.goto(hub.origin + '/goals'), second.goto(hub.origin + '/health')]);
      for (const current of [page, second]) await expect(countOf(current)).toBeHidden();

      await hub.personas.adapter.send(CFO, 'Check the card.', {});
      for (const current of [page, second]) await expect(countOf(current)).toHaveText('1');
      const panel = await openList(page);
      await expect(panel.locator('.notification-agent')).toHaveText(['CFO']);
      await expect(panel.locator('.notification-text')).toHaveText(['Unusual activity on the card.']);
      await expect(panel.locator('.notification-time')).toHaveText(['just now']);

      const lines = [];
      for (const id of ['assistant', 'cfo']) {
        const response = await page.request.get(`${hub.origin}/api/agents/${id}/thread`);
        lines.push(...(await response.json()).messages);
      }
      expect(lines.some((line) => String(line.text).includes('Unusual activity'))).toBe(false);

      await panel.getByRole('button', { name: 'CFO' }).click();
      await expect(page).toHaveURL(hub.origin + '/?agent=cfo');
      await expect(page.locator('#agent-name')).toHaveText('CFO');
    } finally {
      await second.close();
    }
  });
});

test.describe('what is not a notification', () => {
  test.use({
    hubOptions: {
      agents: [ASSISTANT, CFO],
      personas: { cfo: { state: 'waiting' } },
      jobs: { refreshedAt: new Date().toISOString(), focusAvailable: true, items: [{ ...JOB, outcome: 'failed', exitStatus: 1, failures24h: 1 }] },
    },
  });

  test('a waiting agent, an unopened reply, and a failed job light the rail but never the list', async ({ page, hub }) => {
    await page.goto(hub.origin + '/goals');
    await hub.state.notify('assistant', { role: 'system', kind: 'brief', date: '2026-10-03', state: 'ready', summary: 'Invented brief.', text: 'Invented brief.' });
    await expect(page.locator('#agents-indicator')).toBeVisible();
    await expect(page.locator('#health-indicator')).toBeVisible();
    await expect(countOf(page)).toBeHidden();
    const panel = await openList(page);
    await expect(panel.locator('#notifications-empty')).toHaveText('There are no notifications.');
    await expect(panel.locator('.notification')).toHaveCount(0);
  });
});
