// The persistent app header, its local theme menu, and the two rail marks.
// The fixtures keep both apps and every file isolated from Hunter's running
// dashboard and Focus installation.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, expectView, needsFocus, test } from '../support/browser-test.mjs';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const FEED_INSTRUCTIONS = path.join(FIXTURES, 'feed-instructions', 'relevance.md');
const BRIEF_INSTRUCTIONS = path.join(FIXTURES, 'brief-instructions', 'curator.md');
const ASSISTANT = Object.freeze({
  id: 'assistant', name: 'Assistant', role: 'Assistant', description: 'Invented.', group: 'personal', kind: 'persona',
  cwd: '/invented', provider: 'claude', pinned: true,
});

test.describe('header shell', () => {
  test.use({
    hubOptions: {
      agents: [ASSISTANT], vault: true, instructions: FEED_INSTRUCTIONS, briefInstructions: BRIEF_INSTRUCTIONS,
    },
  });

  test('every view keeps one header and only its left-side actions', async ({ page, hub }) => {
    const cases = [
      ['/?agent=assistant', 'agents', 'Agents', ['agents-toggle', 'agent-open-terminal', 'agent-details-toggle']],
      ['/feed', 'feed', 'Feed', ['feed-instructions-toggle']],
      ['/focus', 'focus', 'Focus', []],
      ['/goals', 'goals', 'Goals', ['goals-add']],
      ['/health', 'health', 'Health', ['jobs-refresh']],
    ];
    const moved = [...new Set(cases.flatMap((entry) => entry[3]))];
    const heights = [];

    for (const [route, view, title, ids] of cases) {
      await page.goto(hub.origin + route);
      await expectView(page, view, title);
      const header = page.locator('.app-header');
      await expect(header).toHaveCount(1);
      await expect(header.locator('#app-header-title')).toHaveText(title);
      await expect(header.locator(`[data-actions-for="${view}"]`)).not.toHaveAttribute('hidden', '');
      for (const id of ids) await expect(header.locator(`#${id}`)).toHaveCount(1);
      for (const id of moved) await expect(page.locator(`section.view #${id}`)).toHaveCount(0);
      heights.push((await header.boundingBox()).height);
    }

    expect(new Set(heights).size).toBe(1);
    // The brief's instructions live in its overlay, not in any view's header.
    await expect(page.locator('.app-header #brief-instructions-toggle')).toHaveCount(0);
    await expect(page.locator('.header-right > .header-entry, .header-right > .header-menu-toggle'))
      .toHaveText(['Brief', 'Quick chat', 'Notifications', 'Menu']);
  });

  test('Menu closes with Escape or an outside click, and Settings opens Health', async ({ page, hub }) => {
    await page.goto(hub.origin + '/');
    const toggle = page.getByRole('button', { name: 'Menu', exact: true });
    const menu = page.locator('#app-menu');

    await toggle.click();
    await expect(menu).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await expect(toggle).toBeFocused();

    await toggle.click();
    await page.locator('#app-header-title').click();
    await expect(menu).toBeHidden();

    await toggle.click();
    await menu.getByRole('link', { name: 'Settings', exact: true }).click();
    await expect(page).toHaveURL(hub.origin + '/health');
    await expectView(page, 'health', 'Health');
    await expect(page.locator('#settings-card')).toBeVisible();
  });
});

test.describe('header entries', () => {
  test.use({ hubOptions: { agents: [ASSISTANT] } });

  test('Brief opens the overlay over the view from the header on a desk and from the menu on a phone, which also holds Theme and Settings', async ({ page, hub }) => {
    await hub.writeBrief('2026-09-15');
    const onPhone = page.viewportSize().width < 720;
    await page.goto(hub.origin + '/goals');
    await expectView(page, 'goals', 'Goals');
    const headerBrief = page.locator('.header-right > .header-brief');
    const menu = page.locator('#app-menu');

    if (onPhone) {
      await expect(headerBrief).toBeHidden();
      await page.getByRole('button', { name: 'Menu', exact: true }).click();
      await expect(menu.locator('.menu-entry:visible')).toHaveText(['Brief', 'Quick chat', 'Notifications', 'Settings']);
      await expect(menu.getByRole('group', { name: 'Theme' })).toBeVisible();
      await menu.getByRole('button', { name: 'Brief', exact: true }).click();
      await expect(menu).toBeHidden();
    } else {
      await expect(menu.locator('.menu-mobile-only').first()).toBeHidden();
      await headerBrief.click();
    }
    await expect(page.getByRole('dialog', { name: 'Brief' })).toBeVisible();
    await expect(page.locator('.brief-title')).toHaveText('Invented brief for tests, not a real day');
    await expect(page).toHaveURL(hub.origin + '/goals');
    await expect(page.locator('#view-goals')).toBeVisible();
  });
});

test('theme choice persists, follows the system, and reloads Focus with its resolved theme', async ({ page, hub }) => {
  needsFocus();
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto(hub.origin + '/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

  const menu = page.locator('#app-menu');
  await page.getByRole('button', { name: 'Menu', exact: true }).click();
  await menu.getByLabel('Light', { exact: true }).check();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

  await page.getByRole('button', { name: 'Menu', exact: true }).click();
  await menu.getByLabel('Follow the system', { exact: true }).check();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

  await menu.getByLabel('Dark', { exact: true }).check();
  await page.goto(hub.origin + '/focus');
  await expectView(page, 'focus', 'Focus');
  await expect(page.locator('#focus-frame')).toHaveAttribute('src', '/embedded/focus?theme=dark');
  await expect(page.frameLocator('#focus-frame').locator('html')).toHaveAttribute('data-theme', 'dark');

  await page.getByRole('button', { name: 'Menu', exact: true }).click();
  await menu.getByLabel('Light', { exact: true }).check();
  await expect(page.locator('#focus-frame')).toHaveAttribute('src', '/embedded/focus?theme=light');
  await expect(page.frameLocator('#focus-frame').locator('html')).toHaveAttribute('data-theme', 'light');
});

test.describe('rail marks', () => {
  test.use({
    hubOptions: {
      agents: [ASSISTANT],
      personas: { assistant: { state: 'waiting' } },
      jobs: {
        refreshedAt: new Date().toISOString(), focusAvailable: true,
        items: [{
          label: 'com.invented.failed', agentId: 'assistant', agentName: 'Assistant', name: 'failed',
          schedule: { kind: 'calendar', text: 'Daily at 08:00' }, logPath: '/invented/failed.log',
          lastRun: new Date().toISOString(), outcome: 'failed', exitStatus: 1, failures24h: 1,
          paused: null, source: 'launchctl', available: true,
        }],
      },
    },
  });

  test('seeded agent and job states show the same rail marks in two pages', async ({ page, hub }) => {
    const second = await page.context().newPage();
    try {
      await Promise.all([page.goto(hub.origin + '/'), second.goto(hub.origin + '/health')]);
      await Promise.all([expectView(page, 'agents', 'Agents'), expectView(second, 'health', 'Health')]);
      for (const current of [page, second]) {
        await expect(current.locator('#agents-indicator')).toBeVisible();
        await expect(current.locator('#health-indicator')).toBeVisible();
      }

      await hub.personas.adapter.interrupt(ASSISTANT);
      hub.jobs.items = [{ ...hub.jobs.items[0], outcome: 'ok', exitStatus: 0 }];
      await hub.state.refreshJobs();
      for (const current of [page, second]) {
        await expect(current.locator('#agents-indicator')).toBeHidden();
        await expect(current.locator('#health-indicator')).toBeHidden();
      }
    } finally {
      await second.close();
    }
  });
});

test.describe('unread', () => {
  const CFO = Object.freeze({ ...ASSISTANT, id: 'cfo', name: 'CFO', role: 'Money', pinned: false });
  test.use({ hubOptions: { agents: [ASSISTANT, CFO] } });

  test('a reply lights the rail in two pages and the row, and opening the thread clears them in both', async ({ page, hub }) => {
    const second = await page.context().newPage();
    try {
      await Promise.all([page.goto(hub.origin + '/goals'), second.goto(hub.origin + '/goals')]);
      for (const current of [page, second]) await expect(current.locator('#agents-indicator')).toBeHidden();

      await hub.state.notify('cfo', {
        role: 'system', kind: 'brief', date: '2026-10-03', state: 'ready', summary: 'Invented brief.', text: 'Invented brief.',
      });
      for (const current of [page, second]) await expect(current.locator('#agents-indicator')).toBeVisible();

      await page.getByRole('navigation', { name: 'Dashboard' }).getByRole('link', { name: 'Home' }).click();
      const cfoRow = page.locator('#agents-list .agent-row[data-agent="cfo"]');
      await expect(cfoRow.locator('.agent-row-dot')).toHaveAttribute('aria-label', 'New reply');
      expect(hub.state.snapshot().agents.find((agent) => agent.id === 'cfo').unread).toBe(true);

      await cfoRow.click();
      await expect(page.locator('#agent-name')).toHaveText('CFO');
      for (const current of [page, second]) await expect(current.locator('#agents-indicator')).toBeHidden();
      expect(hub.state.snapshot().agents.find((agent) => agent.id === 'cfo').unread).toBe(false);
    } finally {
      await second.close();
    }
  });
});
