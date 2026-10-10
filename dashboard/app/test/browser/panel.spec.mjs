// The side panel between the rail and every view, and its one toggle at the
// head of the header. On a desk the toggle collapses the panel on every view
// and the choice is stored, and the panel's right edge sets its width; on a
// phone the panel is a drawer over a scrim that nothing stores.

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
const handle = (page) => page.locator('#panel-resize');
const panelWidth = async (page) => (await panel(page).boundingBox()).width;

// Drags the handle by dx with the mouse, in steps so pointermove fires.
async function dragHandle(page, dx) {
  const box = await handle(page).boundingBox();
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y, { steps: 8 });
  await page.mouse.up();
}

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

  test('dragging the edge widens the panel, the stage takes the rest, and a reload keeps the width', async ({ page, hub }) => {
    await page.goto(hub.origin + '/feed');
    await expectView(page, 'feed', 'Feed');
    await expect(handle(page)).toBeVisible();
    await expect(handle(page)).toHaveAttribute('role', 'separator');
    await expect(handle(page)).toHaveAttribute('aria-orientation', 'vertical');
    await expect(handle(page)).toHaveAttribute('aria-label', 'Resize side panel');
    await expect(handle(page)).toHaveAttribute('aria-valuemin', '220');
    await expect(handle(page)).toHaveAttribute('aria-valuemax', '480');
    await expect(handle(page)).toHaveAttribute('aria-valuenow', '288');
    expect(await panelWidth(page)).toBe(288);
    const body = (await page.locator('.body').boundingBox()).width;

    await dragHandle(page, 100);
    await expect.poll(() => panelWidth(page)).toBe(388);
    await expect(handle(page)).toHaveAttribute('aria-valuenow', '388');
    await expect(page.locator('.shell')).not.toHaveClass(/panel-resizing/);
    expect((await page.locator('.stage').boundingBox()).width).toBe(body - 388);
    expect(await stored(page, 'dashboard.panelWidth')).toBe('388');

    await page.reload();
    await expectView(page, 'feed', 'Feed');
    expect(await panelWidth(page)).toBe(388);
    await expect(handle(page)).toHaveAttribute('aria-valuenow', '388');

    // Collapsing hides it and keeps the width for when it shows again.
    await toggle(page).click();
    await expectCollapsed(page);
    await expect(handle(page)).toBeHidden();
    await toggle(page).click();
    await expectShown(page);
    expect(await panelWidth(page)).toBe(388);
  });

  test('the width stops at 480 and 220, and a double-click puts it back to 288 and forgets it', async ({ page, hub }) => {
    await page.goto(hub.origin + '/goals');
    await expectView(page, 'goals', 'Goals');

    await dragHandle(page, 600);
    await expect.poll(() => panelWidth(page)).toBe(480);
    expect(await stored(page, 'dashboard.panelWidth')).toBe('480');

    await dragHandle(page, -600);
    await expect.poll(() => panelWidth(page)).toBe(220);
    expect(await stored(page, 'dashboard.panelWidth')).toBe('220');

    await handle(page).dblclick();
    await expect.poll(() => panelWidth(page)).toBe(288);
    await expect(handle(page)).toHaveAttribute('aria-valuenow', '288');
    expect(await stored(page, 'dashboard.panelWidth')).toBe(null);
  });

  test('the arrow keys move the edge 16px, and Home and End go to the ends', async ({ page, hub }) => {
    await page.goto(hub.origin + '/health');
    await expectView(page, 'health', 'Health');
    await handle(page).focus();

    await page.keyboard.press('ArrowRight');
    await expect.poll(() => panelWidth(page)).toBe(304);
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await expect.poll(() => panelWidth(page)).toBe(272);
    await expect(handle(page)).toHaveAttribute('aria-valuenow', '272');
    expect(await stored(page, 'dashboard.panelWidth')).toBe('272');

    await page.keyboard.press('End');
    await expect.poll(() => panelWidth(page)).toBe(480);
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => panelWidth(page)).toBe(480);
    await page.keyboard.press('Home');
    await expect.poll(() => panelWidth(page)).toBe(220);
    await expect(handle(page)).toHaveAttribute('aria-valuenow', '220');
  });

  test('a stored width out of range opens clamped, and one that is not a number opens at 288', async ({ page, hub }) => {
    await page.goto(hub.origin + '/goals');
    await page.evaluate(() => window.localStorage.setItem('dashboard.panelWidth', '900'));
    await page.reload();
    await expectView(page, 'goals', 'Goals');
    expect(await panelWidth(page)).toBe(480);

    await page.evaluate(() => window.localStorage.setItem('dashboard.panelWidth', 'wide'));
    await page.reload();
    await expectView(page, 'goals', 'Goals');
    expect(await panelWidth(page)).toBe(288);
  });
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('the drawer has no resize handle, and a stored width does not change it', async ({ page, hub }) => {
    await page.goto(hub.origin + '/goals');
    await page.evaluate(() => window.localStorage.setItem('dashboard.panelWidth', '420'));
    await page.reload();
    await expectView(page, 'goals', 'Goals');
    await toggle(page).click();
    await expectShown(page);
    await expect(handle(page)).toBeHidden();
    await expect.poll(async () => (await panel(page).boundingBox()).x).toBe(0);
    expect(await panelWidth(page)).toBe(Math.min(320, page.viewportSize().width * 0.86));
  });

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

    await page.locator('#notifications-toggle').click();
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

// The Now section, shown for a view with no panel of its own (Focus): the
// agents waiting on Hunter, the open notifications, and today's brief, all
// from the snapshot.
test.describe('the Now panel', () => {
  const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
  const now = (page) => page.locator('#panel [data-panel-for="now"]');
  const group = (page, name) => now(page).locator(`[data-now-group="${name}"]`);
  // Today as the browser's calendar day, and the date as the overlay titles it.
  const today = (page) => page.evaluate(() => {
    const day = new Date();
    const pad = (value) => String(value).padStart(2, '0');
    return {
      date: `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`,
      words: day.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }),
    };
  });

  async function openNow(page, hub) {
    await page.goto(hub.origin + '/focus');
    await expectView(page, 'focus', 'Focus');
    if (phone(page)) await toggle(page).click();
    await expect(now(page)).toBeVisible();
  }

  test.describe('with an agent waiting, an open notification, and today\'s brief', () => {
    test.use({
      hubOptions: {
        agents: [ASSISTANT, CFO],
        personas: {
          cfo: {
            state: 'waiting',
            messages: [{ role: 'assistant', text: 'Which account should the transfer come from?', at: minutesAgo(5) }],
          },
        },
        notifications: [
          { id: 'n-agent', agent: 'cfo', text: 'The transfer needs an account.', link: 'agent:cfo', at: minutesAgo(30) },
          { id: 'n-brief', agent: 'assistant', text: 'The brief landed.', link: 'brief:2026-10-03', at: minutesAgo(10) },
          { id: 'n-done', agent: 'assistant', text: 'An acknowledged one.', at: minutesAgo(60), acknowledgedAt: minutesAgo(50) },
        ],
      },
    });

    test('Focus shows the three groups, each listing what is open, and other views their own panel', async ({ page, hub }) => {
      await page.goto(hub.origin + '/');
      await hub.writeBrief((await today(page)).date);
      await openNow(page, hub);
      const { words } = await today(page);
      await expect(now(page).locator('.panel-heading')).toHaveText(['Waiting on you', 'Notifications', 'Brief']);

      const waiting = group(page, 'agents').locator('.panel-row');
      await expect(waiting).toHaveCount(1);
      await expect(waiting.locator('.agent-row-dot-wait')).toHaveCount(1);
      await expect(waiting.locator('.panel-row-name')).toHaveText('CFO');
      await expect(waiting.locator('.now-row-detail')).toHaveText('Which account should the transfer come from?');

      // Open ones only, newest first, each with when it came.
      const notices = group(page, 'notifications').locator('.panel-row');
      await expect(notices.locator('.panel-row-name')).toHaveText(['The brief landed.', 'The transfer needs an account.']);
      await expect(notices.locator('.now-row-detail')).toHaveText(['10 minutes ago', '30 minutes ago']);

      const brief = group(page, 'brief').locator('.panel-row');
      await expect(brief.locator('.panel-row-name')).toHaveText(words);
      await expect(now(page).locator('.now-empty')).toHaveCount(0);

      // A view with its own panel shows that instead.
      await nav(page, 'Home').click();
      await expectView(page, 'agents', 'Agents');
      if (phone(page)) await toggle(page).click();
      await expect(page.locator('#agents-list')).toBeVisible();
      await expect(now(page)).toBeHidden();
    });

    test('the waiting agent opens its thread, and leaves the list on the next state', async ({ page, hub }) => {
      await openNow(page, hub);
      await group(page, 'agents').locator('.panel-row').click();
      await expect(page).toHaveURL(`${hub.origin}/?agent=cfo`);
      await expectView(page, 'agents', 'Agents');
      await expect(page.locator('#agent-name')).toHaveText('CFO');

      await nav(page, 'Focus').click();
      await expectView(page, 'focus', 'Focus');
      if (phone(page)) await toggle(page).click();
      await expect(group(page, 'agents').locator('.panel-row')).toHaveCount(1);
      await hub.personas.adapter.interrupt(CFO);
      await expect(group(page, 'agents').locator('.panel-row')).toHaveCount(0);
      await expect(group(page, 'agents').locator('.now-empty')).toHaveText('No one is waiting on you.');
    });

    test('a notification opens its link, and acknowledging it removes its row', async ({ page, hub }) => {
      await openNow(page, hub);
      const row = (id) => now(page).locator(`[data-now-notification="${id}"]`);
      await row('n-agent').click();
      await expectView(page, 'agents', 'Agents');
      await expect(page.locator('#agent-name')).toHaveText('CFO');

      await page.goto(hub.origin + '/focus');
      if (phone(page)) await toggle(page).click();
      await hub.writeBrief('2026-10-03');
      await row('n-brief').click();
      await expect(page.getByRole('dialog', { name: 'Brief' })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog', { name: 'Brief' })).toBeHidden();

      if (phone(page)) await toggle(page).click();
      await expect(row('n-brief')).toBeVisible();
      const answer = await page.evaluate(() => fetch('/api/notifications/n-brief/acknowledge', { method: 'POST' }).then((response) => response.status));
      expect(answer).toBe(200);
      await expect(row('n-brief')).toHaveCount(0);
      await expect(row('n-agent')).toHaveCount(1);
    });

    test('today\'s brief opens in the overlay', async ({ page, hub }) => {
      await page.goto(hub.origin + '/');
      const { date } = await today(page);
      await hub.writeBrief(date);
      await openNow(page, hub);
      await now(page).locator(`[data-now-brief="${date}"]`).click();
      await expect(page.getByRole('dialog', { name: 'Brief' })).toBeVisible();
      await expect(page.locator('.brief-date')).toHaveText((await today(page)).words);
      await expectView(page, 'focus', 'Focus');
    });

    // The Now row names today's brief by date, not "latest"; a load it
    // starts must still clear the Brief button's dot (brief.spec.mjs covers
    // open(null) from the header itself).
    test('opening today\'s brief from the Now row clears the Brief button\'s dot', async ({ page, hub }) => {
      await page.goto(hub.origin + '/');
      const { date } = await today(page);
      await hub.writeBrief(date);
      await hub.state.refreshStatus();
      await openNow(page, hub);
      const dot = phone(page) ? page.locator('#app-menu-dot') : page.locator('#brief-dot');
      await expect(dot).toBeVisible();
      await now(page).locator(`[data-now-brief="${date}"]`).click();
      await expect(page.getByRole('dialog', { name: 'Brief' })).toBeVisible();
      await expect(dot).toBeHidden();
    });
  });

  test.describe('with nothing open and an older brief', () => {
    test.use({
      hubOptions: {
        agents: [ASSISTANT],
        notifications: [{ id: 'n-done', agent: 'assistant', text: 'An acknowledged one.', at: minutesAgo(60), acknowledgedAt: minutesAgo(50) }],
      },
    });

    test('each empty group says so in a sentence', async ({ page, hub }) => {
      await hub.writeBrief('2026-10-03');
      await openNow(page, hub);
      await expect(now(page).locator('.panel-heading')).toHaveText(['Waiting on you', 'Notifications', 'Brief']);
      await expect(now(page).locator('.panel-row')).toHaveCount(0);
      await expect(now(page).locator('.now-empty')).toHaveText([
        'No one is waiting on you.', 'There are no notifications.', 'No brief today.',
      ]);
    });
  });

  test.describe('on a phone', () => {
    test.use({
      viewport: { width: 390, height: 844 },
      hubOptions: {
        agents: [ASSISTANT, CFO],
        personas: { cfo: { state: 'waiting' } },
        notifications: [{ id: 'n-agent', agent: 'cfo', text: 'The transfer needs an account.', link: 'agent:cfo', at: minutesAgo(30) }],
      },
    });

    test('a choice closes the drawer', async ({ page, hub }) => {
      await page.goto(hub.origin + '/');
      const { date } = await today(page);
      await hub.writeBrief(date);
      for (const target of ['[data-now-agent="cfo"]', '[data-now-notification="n-agent"]', `[data-now-brief="${date}"]`]) {
        await page.goto(hub.origin + '/focus');
        await expectView(page, 'focus', 'Focus');
        await toggle(page).click();
        await expectShown(page);
        await now(page).locator(target).click();
        await expectCollapsed(page);
      }
      await expect(page.getByRole('dialog', { name: 'Brief' })).toBeVisible();
    });
  });
});
