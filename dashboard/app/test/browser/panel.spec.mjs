// The side panel between the rail and every view, and its one toggle at the
// head of the header. On a desk the toggle collapses the panel on every view
// and the choice is stored; on a phone the panel is a drawer over a scrim
// that nothing stores.

import { expect, expectView, nav, test } from '../support/browser-test.mjs';

const ASSISTANT = Object.freeze({
  id: 'assistant', name: 'Assistant', role: 'Assistant', description: 'Invented.', group: 'personal', kind: 'persona',
  cwd: '/invented', provider: 'claude', pinned: true,
});
const CFO = Object.freeze({ ...ASSISTANT, id: 'cfo', name: 'CFO', role: 'Money', pinned: false });

const VIEWS = [
  ['/', 'agents', 'Agents'],
  ['/feed', 'feed', 'Feed'],
  ['/focus', 'focus', 'Focus'],
  ['/goals', 'goals', 'Goals'],
  ['/ideas', 'ideas', 'Ideas'],
  ['/health', 'health', 'Health'],
];

const phone = (page) => page.viewportSize().width < 720;
const toggle = (page) => page.locator('#panel-toggle');
const panel = (page) => page.locator('#panel');
const stored = (page, key) => page.evaluate((name) => window.localStorage.getItem(name), key);

function row(page, name) {
  return page.locator('.agent-row').filter({ has: page.locator('.agent-row-name', { hasText: new RegExp(`^${name}$`) }) });
}

async function expectShown(page) {
  await expect(panel(page)).toBeVisible();
  await expect(toggle(page)).toHaveAttribute('aria-expanded', 'true');
  await expect(toggle(page)).toHaveAttribute('aria-label', 'Hide side panel');
  await expect(toggle(page)).toHaveAttribute('title', 'Hide side panel');
}

async function expectCollapsed(page) {
  await expect(panel(page)).toBeHidden();
  await expect(toggle(page)).toHaveAttribute('aria-expanded', 'false');
  await expect(toggle(page)).toHaveAttribute('aria-label', 'Show side panel');
  await expect(toggle(page)).toHaveAttribute('title', 'Show side panel');
}

test.use({ hubOptions: { agents: [ASSISTANT, CFO] } });

test('one toggle leads the header on all six views, and the header is the same height on each', async ({ page, hub }) => {
  const heights = [];
  for (const [route, view, title] of VIEWS) {
    await page.goto(hub.origin + route);
    await expectView(page, view, title);
    const header = page.locator('.app-header');
    await expect(header.locator('#panel-toggle')).toHaveCount(1);
    await expect(page.locator('#panel-toggle')).toHaveCount(1);
    await expect(header.locator('[data-actions-for] #panel-toggle')).toHaveCount(0);
    await expect(toggle(page)).toBeVisible();
    await expect(toggle(page)).toHaveAttribute('aria-controls', 'panel');
    // First in the header's left side, before the title.
    expect(await page.locator('.header-left > :first-child').getAttribute('id')).toBe('panel-toggle');
    await expect(toggle(page).locator('svg rect')).toHaveCount(1);
    await expect(toggle(page).locator('svg path.bar')).toHaveCount(1);
    heights.push((await header.boundingBox()).height);
  }
  expect(new Set(heights).size).toBe(1);
  expect(heights[0]).toBe(phone(page) ? 56 : 64);
});

test('the agents list sits in the panel and the Agents view keeps only the thread', async ({ page, hub }) => {
  await page.goto(hub.origin + '/');
  await expect(page.locator('#panel')).toHaveAttribute('aria-label', 'Side panel');
  await expect(page.locator('#panel [data-panel-for="agents"] #agents-list')).toHaveCount(1);
  await expect(page.locator('#view-agents #agents-list')).toHaveCount(0);
  await expect(page.locator('#view-agents > *')).toHaveCount(1);
  await expect(page.locator('#view-agents > #agent-thread')).toHaveCount(1);
  for (const view of ['now', 'agents', 'feed', 'goals', 'health', 'ideas']) {
    await expect(page.locator(`#panel > section[data-panel-for="${view}"]`)).toHaveCount(1);
  }
});

// Each width sets its own viewport, so both projects run every test: the
// desk in WebKit and the phone in Chromium too.
test.describe('on a desk', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('collapsing on one view collapses it on all, a reload keeps the choice, and the view takes the width', async ({ page, hub }) => {
    await page.goto(hub.origin + '/goals');
    await expectView(page, 'goals', 'Goals');
    await expectShown(page);
    const before = (await page.locator('#view-goals').boundingBox()).width;

    await toggle(page).click();
    await expectCollapsed(page);
    await expect(toggle(page)).toBeFocused();
    expect((await page.locator('#view-goals').boundingBox()).width).toBeGreaterThan(before);
    expect(await stored(page, 'dashboard.panelHidden')).toBe('1');

    for (const [, view, title] of VIEWS) {
      await nav(page, { agents: 'Home', feed: 'Feed', focus: 'Focus', goals: 'Goals', ideas: 'Ideas', health: 'Health' }[view]).click();
      await expectView(page, view, title);
      await expectCollapsed(page);
    }

    await page.reload();
    await expectCollapsed(page);

    await toggle(page).click();
    await expectShown(page);
    expect(await stored(page, 'dashboard.panelHidden')).toBe(null);
    await page.goto(hub.origin + '/');
    await expectShown(page);
    await expect(page.locator('#agents-list')).toBeVisible();
  });

  test('the old agents-list choice carries over once and is removed', async ({ page, hub }) => {
    await page.goto(hub.origin + '/');
    await page.evaluate(() => window.localStorage.setItem('dashboard.agentsListHidden', '1'));
    await page.reload();
    await expectCollapsed(page);
    expect(await stored(page, 'dashboard.agentsListHidden')).toBe(null);
    expect(await stored(page, 'dashboard.panelHidden')).toBe('1');
  });
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('the toggle opens the drawer; the scrim, Escape, and another view close it; nothing is stored', async ({ page, hub }) => {
    await page.goto(hub.origin + '/goals');
    await expectView(page, 'goals', 'Goals');
    const scrim = page.locator('#panel-scrim');
    await expectCollapsed(page);
    await expect(scrim).toBeHidden();

    await toggle(page).click();
    await expectShown(page);
    await expect(scrim).toBeVisible();
    // It slides in from the left.
    await expect.poll(async () => (await panel(page).boundingBox()).x).toBe(0);
    const drawer = await panel(page).boundingBox();
    expect(drawer.width).toBe(Math.min(320, page.viewportSize().width * 0.86));
    // Over the view and above the bottom bar, whose links stay in reach.
    const bar = await page.locator('.nav').boundingBox();
    expect(drawer.y + drawer.height).toBeLessThanOrEqual(bar.y + 1);
    const box = await scrim.boundingBox();
    await scrim.click({ position: { x: box.width - 10, y: box.height / 2 } });
    await expectCollapsed(page);
    await expect(scrim).toBeHidden();

    await toggle(page).click();
    await expectShown(page);
    await page.keyboard.press('Escape');
    await expectCollapsed(page);

    await toggle(page).click();
    await expectShown(page);
    await nav(page, 'Feed').click();
    await expectView(page, 'feed', 'Feed');
    await expectCollapsed(page);

    await toggle(page).click();
    await expectShown(page);
    expect(await stored(page, 'dashboard.panelHidden')).toBe(null);
    await page.reload();
    await expectCollapsed(page);
    await page.evaluate(() => window.DashboardPanel.openPanel());
    await expectShown(page);
    await page.evaluate(() => window.DashboardPanel.closePanel());
    await expectCollapsed(page);
  });

  test('Escape closes a layer opened over the drawer first, and the drawer only on the next press', async ({ page, hub }) => {
    await page.goto(hub.origin + '/goals');
    await expectView(page, 'goals', 'Goals');
    await toggle(page).click();
    await expectShown(page);

    await page.getByRole('button', { name: 'Menu', exact: true }).click();
    await page.locator('#notifications-menu-entry').click();
    const notifications = page.locator('#notifications-panel');
    await expect(notifications).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(notifications).toBeHidden();
    await expectShown(page);

    await page.keyboard.press('Escape');
    await expectCollapsed(page);
  });

  test('Agents with no agent open opens the drawer, a row closes it, and Back opens it', async ({ page, hub }) => {
    await page.goto(hub.origin + '/?agent=cfo');
    await expectView(page, 'agents', 'Agents');
    await expectCollapsed(page);

    await page.goto(hub.origin + '/');
    await expectView(page, 'agents', 'Agents');
    await expectShown(page);
    await expect(page.locator('#agents-list')).toBeVisible();

    await row(page, 'CFO').click();
    await expect(page).toHaveURL(`${hub.origin}/?agent=cfo`);
    await expectCollapsed(page);
    await expect(page.locator('#agent-name')).toHaveText('CFO');
    await expect(page.locator('#agent-thread')).toBeVisible();

    await page.locator('#agent-back').click();
    await expect(page).toHaveURL(`${hub.origin}/`);
    await expectShown(page);

    await nav(page, 'Goals').click();
    await expectCollapsed(page);
    await nav(page, 'Home').click();
    await expectShown(page);
  });
});
