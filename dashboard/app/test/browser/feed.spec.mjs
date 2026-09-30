// The Feed tab of the Reading view against a temporary copy of
// test/fixtures/feed, read by the real Feed routes, with the watch persona on
// the fake Claude adapter of test/support/browser-server.mjs.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { WATCH } from '../support/browser-server.mjs';
import { expect, expectView, nav, needsFocus, test } from '../support/browser-test.mjs';

const FEED = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'feed');
const DATE = '2026-09-15';
const BUSY = 'Watch is in the middle of a turn. Try again when it is idle.';

const runs = (page) => page.locator('#feed-runs .feed-run');
const item = (page, id) => page.locator(`[data-feed-item="${id}"]`);
const tabs = (page) => page.getByRole('navigation', { name: 'Reading' });
const messages = (page) => page.locator('#agent-messages .thread-message');

async function openFeed(page, hub) {
  await page.goto(`${hub.origin}/feed`);
  await expectView(page, 'reading', 'Feed');
  await expect(runs(page)).toHaveCount(2);
}

test.describe('with the fixture store', () => {
  test.use({ hubOptions: { feed: FEED, agents: [WATCH] } });

  test('renders each run as a group of posts, newest first', async ({ page, hub }) => {
    await openFeed(page, hub);
    await expect(tabs(page).getByRole('link', { name: 'Feed' })).toHaveAttribute('aria-current', 'page');
    await expect(tabs(page).getByRole('link', { name: 'Brief' })).not.toHaveAttribute('aria-current', 'page');
    await expect(runs(page).locator('.feed-date')).toHaveText(['Monday, September 28', 'Monday, September 21']);
    await expect(runs(page).first().locator('.feed-since')).toHaveText('Since September 14');
    await expect(runs(page).first().locator('.feed-item')).toHaveCount(8);
    await expect(page.locator('#feed-runs .routine-card')).toHaveCount(0);
    await expect(runs(page).first()).toHaveCSS('border-top-width', '0px');
    const first = await runs(page).first().boundingBox();
    const second = await runs(page).nth(1).boundingBox();
    expect(Math.round(second.y - (first.y + first.height))).toBe(32);
    const post = await item(page, 'watch/2026-09-28/1').boundingBox();
    const next = await item(page, 'watch/2026-09-28/2').boundingBox();
    expect(Math.round(next.y - (post.y + post.height))).toBe(24);
    await expect(page.locator('#feed-message')).toBeHidden();
    await expect(page.locator('#brief-frame')).toHaveCount(0);

    const robots = item(page, 'watch/2026-09-28/1');
    const badge = robots.locator('.feed-badge');
    await expect(badge).toHaveText('IG');
    await expect(badge).toHaveCSS('border-radius', '50%');
    const link = robots.locator('.feed-title a');
    await expect(link).toHaveText('Town council adopts a rule for delivery robots');
    await expect(link).toHaveAttribute('href', 'https://example.com/robots');
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    await expect(robots.locator('.feed-summary')).toHaveText('The Invented Gazette reports the town adopted a rule for delivery robots on sidewalks.');
    const discuss = robots.getByRole('button', { name: 'Discuss Town council adopts a rule for delivery robots' });
    await expect(discuss).toBeVisible();
    await expect(discuss).toHaveText('Discuss');
    await expect(discuss.locator('svg')).toHaveCount(1);
    await expect(discuss).toHaveCSS('border-top-width', '0px');
    await expect(discuss).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(page.locator('#view-reading [data-action]')).toHaveCount(2);
  });

  test('a source keeps its badge colour across posts', async ({ page, hub }) => {
    await openFeed(page, hub);
    const colour = (id) => item(page, id).locator('.feed-badge').evaluate((node) => getComputedStyle(node).backgroundColor);
    await expect(item(page, 'watch/2026-09-28/4').locator('.feed-badge')).toHaveText('IG');
    expect(await colour('watch/2026-09-28/4')).toBe(await colour('watch/2026-09-28/1'));
    expect(await colour('watch/2026-09-28/8')).toBe(await colour('watch/2026-09-28/1'));
    expect(await colour('watch/2026-09-28/1')).not.toBe('rgba(0, 0, 0, 0)');
  });

  test('on a phone the posts stay in one column without horizontal scroll', async ({ page, hub }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openFeed(page, hub);
    const robots = item(page, 'watch/2026-09-28/1');
    await expect(robots.locator('.feed-badge')).toHaveCSS('width', '24px');
    const badge = await robots.locator('.feed-badge').boundingBox();
    const title = await robots.locator('.feed-title').boundingBox();
    expect(title.x).toBeGreaterThan(badge.x + badge.width);
    expect(title.x + title.width).toBeLessThanOrEqual(390);
    const overflow = await page.evaluate(() => ({
      page: document.documentElement.scrollWidth - window.innerWidth,
      feed: document.getElementById('reading-feed').scrollWidth - document.getElementById('reading-feed').clientWidth,
    }));
    expect(overflow).toEqual({ page: 0, feed: 0 });
  });

  test('Discuss sends the item to the watch persona and opens its thread', async ({ page, hub }) => {
    await openFeed(page, hub);
    const posted = page.waitForRequest('**/api/feed/discuss');
    await item(page, 'watch/2026-09-21/2').getByRole('button', { name: /^Discuss/ }).click();
    expect((await posted).postDataJSON()).toEqual({ id: 'watch/2026-09-21/2' });

    await expectView(page, 'agents', 'Agents');
    await expect(page).toHaveURL(`${hub.origin}/?agent=watch`);
    await expect(messages(page).first()).toHaveText(/^Discuss this feed item with me\./);
    await expect(messages(page).first()).toContainText('Hand-bound notebooks, a how-to');
    expect(hub.requests('/api/feed/discuss')).toEqual([{ method: 'POST', status: 202 }]);
    expect(hub.personas.calls).toEqual([['send', 'watch', expect.stringContaining('https://example.com/notebooks')]]);
  });

  test('Discuss while the persona is busy says so under the item', async ({ page, hub }) => {
    hub.personas.hold('watch');
    await openFeed(page, hub);
    await item(page, 'watch/2026-09-28/3').getByRole('button', { name: /^Discuss/ }).click();
    await expectView(page, 'agents', 'Agents');
    await nav(page, 'Reading').click();
    await tabs(page).getByRole('link', { name: 'Feed' }).click();
    await expect(page).toHaveURL(`${hub.origin}/feed`);
    await item(page, 'watch/2026-09-28/4').getByRole('button', { name: /^Discuss/ }).click();
    await expect(item(page, 'watch/2026-09-28/4').locator('.feed-reason')).toHaveText(BUSY);
    await expect(page).toHaveURL(`${hub.origin}/feed`);
    expect(hub.requests('/api/feed/discuss').map((entry) => entry.status)).toEqual([202, 409]);
  });

  test('the tabs switch between the brief and the feed and keep both', async ({ page, hub }) => {
    needsFocus();
    await hub.writeBrief(DATE);
    await openFeed(page, hub);

    await tabs(page).getByRole('link', { name: 'Brief' }).click();
    await expect(page).toHaveURL(`${hub.origin}/reading`);
    await expectView(page, 'reading', 'Reading');
    await expect(page.frameLocator('#brief-frame').locator('h1')).toHaveText(`Daily Brief — ${DATE}`);
    await expect(page.locator('#reading-feed')).toBeHidden();

    await tabs(page).getByRole('link', { name: 'Feed' }).click();
    await expect(page).toHaveURL(`${hub.origin}/feed`);
    await expectView(page, 'reading', 'Feed');
    await expect(page.locator('#brief-frame')).toBeHidden();
    await expect(runs(page)).toHaveCount(2);

    await page.goBack();
    await expect(page).toHaveURL(`${hub.origin}/reading`);
    await expectView(page, 'reading', 'Reading');
    await expect(page.locator('#brief-frame')).toBeVisible();
    await expect(page.locator('iframe#brief-frame')).toHaveCount(1);

    await page.reload();
    await expectView(page, 'reading', 'Reading');
    await expect(page.frameLocator('#brief-frame').locator('h1')).toHaveText(`Daily Brief — ${DATE}`);
  });

  test('the tab stops reading the store once it is left', async ({ page, hub }) => {
    await page.clock.install();
    await openFeed(page, hub);
    await nav(page, 'Home').click();
    await expectView(page, 'agents', 'Agents');
    const before = hub.requests('/api/feed').length;
    await page.clock.runFor(120_000);
    expect(hub.requests('/api/feed').length).toBe(before);
  });
});

test.describe('with an empty store', () => {
  test.use({ hubOptions: { agents: [WATCH] } });

  test('says the feed is empty', async ({ page, hub }) => {
    await page.goto(`${hub.origin}/feed`);
    await expectView(page, 'reading', 'Feed');
    await expect(page.locator('#feed-message')).toHaveText(/^Nothing in the feed yet\./);
    await expect(runs(page)).toHaveCount(0);
  });
});
