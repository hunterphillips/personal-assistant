// Shell behavior in real browsers against invented data: an isolated Focus
// copy with a synthetic board and the invented brief JSON in a temporary
// directory. See test/support/browser-server.mjs. The brief's overlay has its
// own spec (brief.spec.mjs).

import { expect, expectView, nav, needsFocus, test } from '../support/browser-test.mjs';

const DATE = '2026-09-15';
const NEXT_DATE = '2026-09-16';
const TITLE = 'Invented brief for tests, not a real day';

async function frameOf(page, selector) {
  const handle = await page.locator(selector).elementHandle();
  return handle.contentFrame();
}

async function focusBoardReady(page) {
  await expect(page.frameLocator('#focus-frame').locator('#add')).toBeVisible();
}

const overlay = (page) => page.getByRole('dialog', { name: 'Brief' });

// The header's Brief entry: in the header on a desk, in the menu on a phone.
async function openBrief(page) {
  if (page.viewportSize().width < 720) {
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
    await page.locator('#app-menu').getByRole('button', { name: 'Brief', exact: true }).click();
  } else {
    await page.locator('.header-right > .header-brief').click();
  }
  await expect(overlay(page)).toBeVisible();
}

async function briefReady(page, title = TITLE) {
  await expect(page.locator('.brief-title')).toHaveText(title);
}

test('deep links, links, Back and Forward, and reload show the right view', async ({ page, hub }) => {
  needsFocus();
  await hub.writeBrief(DATE);

  await page.goto(`${hub.origin}/focus`);
  await expectView(page, 'focus', 'Focus');
  await focusBoardReady(page);

  await page.goto(`${hub.origin}/feed`);
  await expectView(page, 'feed', 'Feed');

  await nav(page, 'Home').click();
  await expect(page).toHaveURL(`${hub.origin}/`);
  await expectView(page, 'agents', 'Agents');

  await nav(page, 'Focus').click();
  await expect(page).toHaveURL(`${hub.origin}/focus`);
  await expectView(page, 'focus', 'Focus');

  await page.goBack();
  await expect(page).toHaveURL(`${hub.origin}/`);
  await expectView(page, 'agents', 'Agents');
  await page.goBack();
  await expect(page).toHaveURL(`${hub.origin}/feed`);
  await expectView(page, 'feed', 'Feed');
  await page.goForward();
  await expect(page).toHaveURL(`${hub.origin}/`);
  await expectView(page, 'agents', 'Agents');
  await page.goForward();
  await expectView(page, 'focus', 'Focus');

  await page.reload();
  await expectView(page, 'focus', 'Focus');
  await focusBoardReady(page);
  await nav(page, 'Feed').click();
  await page.reload();
  await expectView(page, 'feed', 'Feed');
});

test('the Focus frame is created once and kept, hidden, across navigation', async ({ page, hub }) => {
  needsFocus();
  await hub.writeBrief(DATE);

  await page.goto(`${hub.origin}/`);
  await expect(page.locator('iframe')).toHaveCount(0);
  await nav(page, 'Focus').click();
  await focusBoardReady(page);
  const focusFrame = await frameOf(page, '#focus-frame');
  await focusFrame.evaluate(() => { window.dashboardMarker = 'focus-kept'; });

  await nav(page, 'Feed').click();
  await expect(page.locator('#focus-frame')).toBeHidden();
  await openBrief(page);
  await briefReady(page);
  await page.keyboard.press('Escape');

  await nav(page, 'Home').click();
  await expect(page.locator('#focus-frame')).toBeHidden();
  await nav(page, 'Focus').click();
  await page.goBack();
  await page.goBack();
  await expectView(page, 'feed', 'Feed');
  await nav(page, 'Focus').click();

  await expect(page.locator('iframe')).toHaveCount(1);
  expect(await (await frameOf(page, '#focus-frame')).evaluate(() => window.dashboardMarker)).toBe('focus-kept');

  // Keyboard focus never reaches a hidden view.
  await expect(page.locator('#view-feed')).toBeHidden();
  const reachable = await page.evaluate(() => [...document.querySelectorAll('section.view[hidden] a, section.view[hidden] button, section.view[hidden] iframe')]
    .filter((element) => element.getClientRects().length > 0).length);
  expect(reachable).toBe(0);
});

test.describe('over HTTPS', () => {
  test.use({ ignoreHTTPSErrors: true });

  test('brief feedback saves through the dashboard without a download', async ({ page, hub }) => {
    await hub.writeBrief(DATE);
    const downloads = [];
    page.on('download', (download) => downloads.push(download.suggestedFilename()));

    await page.goto(`${hub.secureOrigin}/`);
    expect(new URL(page.url()).protocol).toBe('https:');
    await openBrief(page);
    await briefReady(page);
    await page.locator('[data-brief-item="needs-you-1"]').getByRole('button', { name: 'Approve' }).click();
    await page.locator('[data-brief-item="money-1"]').getByRole('button', { name: 'Dismiss' }).click();
    await page.getByLabel('Overall note').fill('Invented overall note.');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('#brief-saved')).toHaveText(/^Saved at /);

    const markdown = await hub.readFeedback(DATE);
    expect(markdown).toContain('- needs-you-1: APPROVED');
    expect(markdown).toContain('- money-1: DISMISSED');
    expect(markdown).toContain('Invented overall note.');
    expect(downloads).toEqual([]);
  });
});

test('an item added in the embedded Focus reaches its API and is committed', async ({ page, hub }) => {
  needsFocus();
  const before = hub.focus.commitSubjects();
  await page.goto(`${hub.origin}/focus`);
  await focusBoardReady(page);
  const add = page.frameLocator('#focus-frame').locator('#add');
  await add.fill('Invented browser task');
  await add.press('Enter');

  await expect.poll(async () => (await hub.focus.readDoc()).items.map((item) => item.title))
    .toContain('Invented browser task');
  await expect.poll(() => hub.focus.commitSubjects().length).toBe(before.length + 1);
  expect(hub.focus.commitSubjects()[0]).toMatch(/^manual: /);
});

test('when Focus stops, the shell reports it and keeps the mounted frame', async ({ page, hub }) => {
  needsFocus();
  await hub.writeBrief(DATE);
  await page.goto(`${hub.origin}/focus`);
  await focusBoardReady(page);
  await (await frameOf(page, '#focus-frame')).evaluate(() => { window.dashboardMarker = 'still-here'; });
  await expect(page.locator('#focus-notice')).toBeHidden();

  await hub.focus.stop();
  await nav(page, 'Home').click();
  await expectView(page, 'agents', 'Agents');
  await nav(page, 'Focus').click();
  const notice = page.locator('#focus-notice');
  await expect(notice).toContainText('Focus is not responding.');
  const retried = page.waitForRequest((r) => r.url().endsWith('/api/state'));
  await notice.getByRole('button', { name: 'Retry' }).click();
  await retried;
  await expect(notice).toBeVisible();
  expect(await (await frameOf(page, '#focus-frame')).evaluate(() => window.dashboardMarker)).toBe('still-here');

  await openBrief(page);
  await briefReady(page);
});

test.describe('with Focus not running', () => {
  test.use({ withFocus: false });

  test('Focus shows its state and Retry without a frame; the brief still works', async ({ page, hub }) => {
    await hub.writeBrief(DATE);
    await page.goto(`${hub.origin}/focus`);
    const notice = page.locator('#focus-notice');
    await expect(notice).toContainText('Focus is not responding.');
    await expect(page.locator('#focus-frame')).toHaveCount(0);
    const retried = page.waitForRequest((r) => r.url().endsWith('/api/state'));
    await notice.getByRole('button', { name: 'Retry' }).click();
    await retried;
    await expect(notice).toBeVisible();
    await openBrief(page);
    await briefReady(page);
  });
});

test('a newer brief is offered in the open overlay, and the open one stays until it is loaded', async ({ page, hub }) => {
  await hub.writeBrief(DATE);
  await page.goto(`${hub.origin}/`);
  await openBrief(page);
  await briefReady(page);
  await expect(page.locator('#brief-newer')).toBeHidden();

  await hub.writeBrief(NEXT_DATE, { title: 'Invented next brief' });
  await hub.state.refreshStatus();
  const newer = page.locator('#brief-newer');
  await expect(newer).toContainText('A newer brief is available.');
  await briefReady(page);

  await newer.getByRole('button', { name: 'Load newer brief' }).click();
  await briefReady(page, 'Invented next brief');
  await expect(newer).toBeHidden();
});

test('a Focus page that fails at mount is hidden, and Retry loads it once Focus answers', async ({ page, hub }) => {
  needsFocus();
  let refuse = true;
  await page.route('**/embedded/focus?*', (route) => {
    if (!refuse) return route.continue();
    refuse = false;
    return route.fulfill({ status: 502, contentType: 'application/json', body: '{"error":"upstream_unavailable"}' });
  });
  await page.goto(`${hub.origin}/focus`);
  const notice = page.locator('#focus-notice');
  await expect(notice).toContainText('Focus is not responding.');
  await expect(page.locator('#focus-frame')).toHaveAttribute('data-failed', '');
  await expect(page.locator('#focus-frame')).toBeHidden();

  await notice.getByRole('button', { name: 'Retry' }).click();
  await focusBoardReady(page);
  await expect(page.locator('#focus-frame')).toBeVisible();
  await expect(notice).toBeHidden();
  await expect(page.locator('iframe#focus-frame')).toHaveCount(1);
});

test('a brief that cannot be read reads plainly and leaves Focus usable', async ({ page, hub }) => {
  needsFocus();
  await hub.writeRawBrief(DATE, '{"invented": "unsupported"}\n');
  await page.goto(`${hub.origin}/focus`);
  await focusBoardReady(page);
  await openBrief(page);
  await expect(page.locator('#brief-state')).toHaveText(/^The brief for Tuesday, September 15(, 2026)? could not be opened\.$/);
  await page.keyboard.press('Escape');
  await expect(page.frameLocator('#focus-frame').locator('#add')).toBeVisible();
});

test('navigation stays reachable on every view, with one scroll owner', async ({ page, hub }, testInfo) => {
  await page.goto(`${hub.origin}/feed`);
  const viewport = page.viewportSize();

  const names = ['Home', 'Feed', 'Focus', 'Goals'];
  for (const name of names) {
    const link = nav(page, name);
    await expect(link).toBeInViewport();
    await link.click({ trial: true });
  }
  const tops = await Promise.all(names.map(async (name) => (await nav(page, name).boundingBox()).y));
  if (testInfo.project.name === 'mobile-webkit') expect(new Set(tops).size).toBe(1);
  else expect(tops[1]).toBeGreaterThan(tops[0]);

  const shell = await page.evaluate(() => ({
    scrollHeight: document.documentElement.scrollHeight,
    scrollWidth: document.documentElement.scrollWidth,
    innerHeight: window.innerHeight,
    innerWidth: window.innerWidth,
  }));
  expect(shell.scrollHeight).toBe(shell.innerHeight);
  expect(shell.scrollWidth).toBeLessThanOrEqual(viewport.width);
});
