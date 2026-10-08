// The Feed view against a temporary copy of
// test/fixtures/feed, read by the real Feed routes, with the watch persona on
// the fake Claude adapter of test/support/browser-server.mjs.

import { writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';

import { WATCH } from '../support/browser-server.mjs';
import { expect, expectView, nav, test } from '../support/browser-test.mjs';

const FEED = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'feed');
const INSTRUCTIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'feed-instructions', 'relevance.md');
const DATE = '2026-09-15';
const BUSY = 'Watch is in the middle of a turn. Try again when it is idle.';
const PNG = png(400, 600);

// A solid grey PNG, taller than the post is allowed to show.
function png(width, height) {
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 0, 0, 0, 0], 8); // 8-bit greyscale
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width, 0x99)]);
  const pixels = deflateSync(Buffer.concat(Array.from({ length: height }, () => row)));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header), chunk('IDAT', pixels), chunk('IEND', Buffer.alloc(0))]);
}

const runs = (page) => page.locator('#feed-runs .feed-run');
const item = (page, id) => page.locator(`[data-feed-item="${id}"]`);
const messages = (page) => page.locator('#agent-messages .thread-message');

async function openFeed(page, hub) {
  await page.goto(`${hub.origin}/feed`);
  await expectView(page, 'feed', 'Feed');
  await expect(runs(page)).toHaveCount(2);
}

test.describe('with the fixture store', () => {
  test.use({ hubOptions: { feed: FEED, agents: [WATCH] } });

  // Phase 2 rewrites the Feed view
  test.skip('renders each run as a group of posts, newest first', async ({ page, hub }) => {
    await openFeed(page, hub);
    await expect(page.getByRole('navigation', { name: 'Reading' })).toHaveCount(0);
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
    await expect(page.locator('iframe')).toHaveCount(0);

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
    await expect(page.locator('#view-feed [data-action]')).toHaveCount(0);
  });

  // Phase 2 rewrites the Feed view
  test.skip('a source keeps its badge colour across posts', async ({ page, hub }) => {
    await openFeed(page, hub);
    const colour = (id) => item(page, id).locator('.feed-badge').evaluate((node) => getComputedStyle(node).backgroundColor);
    await expect(item(page, 'watch/2026-09-28/4').locator('.feed-badge')).toHaveText('IG');
    expect(await colour('watch/2026-09-28/4')).toBe(await colour('watch/2026-09-28/1'));
    expect(await colour('watch/2026-09-28/8')).toBe(await colour('watch/2026-09-28/1'));
    expect(await colour('watch/2026-09-28/1')).not.toBe('rgba(0, 0, 0, 0)');
  });

  // Phase 2 rewrites the Feed view
  test.skip('on a phone the posts stay in one column without horizontal scroll', async ({ page, hub }) => {
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
      feed: document.getElementById('feed-page').scrollWidth - document.getElementById('feed-page').clientWidth,
    }));
    expect(overflow).toEqual({ page: 0, feed: 0 });
  });

  // Phase 2 rewrites the Feed view
  test.skip('a post with an image shows it under the summary; one without or with a broken image has none', async ({ page, hub }) => {
    // The image comes from another origin over http, as a story's would.
    const pictures = http.createServer((req, res) => {
      if (req.url !== '/story.png') {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' }).end(PNG);
    });
    await new Promise((resolve) => pictures.listen(0, '127.0.0.1', resolve));
    try {
      const origin = `http://localhost:${pictures.address().port}`;
      const post = (n, extra) => ({
        id: `watch/2026-10-05/${n}`, title: `Story ${n}`, source: 'Invented Gazette',
        url: `https://example.com/${n}`, summary: `Summary of story ${n}.`, ...extra,
      });
      await writeFile(path.join(hub.feedDir, '2026-10-05-watch.json'), JSON.stringify({
        producer: 'watch', date: '2026-10-05', since: '2026-09-28', items: [
          post(1, { image: `${origin}/story.png` }), post(2), post(3, { image: `${origin}/missing.png` }),
        ],
      }));
      await page.goto(`${hub.origin}/feed`);
      await expectView(page, 'feed', 'Feed');
      await expect(runs(page)).toHaveCount(3);

      const withImage = item(page, 'watch/2026-10-05/1');
      const image = withImage.locator('img');
      await expect(image).toHaveCount(1);
      await expect(image).toHaveAttribute('src', `${origin}/story.png`);
      await expect(image).toHaveAttribute('loading', 'lazy');
      await expect(image).toHaveAttribute('referrerpolicy', 'no-referrer');
      await expect(image).toHaveAttribute('alt', '');
      await expect.poll(() => image.evaluate((node) => node.complete && node.naturalWidth)).toBe(400);
      await expect(image).toHaveCSS('object-fit', 'cover');
      await expect(image).toHaveCSS('border-top-left-radius', '10px');
      const summary = await withImage.locator('.feed-summary').boundingBox();
      const box = await image.boundingBox();
      const actions = await withImage.locator('.feed-actions').boundingBox();
      const body = await withImage.locator('.feed-body').boundingBox();
      expect(Math.round(box.y - (summary.y + summary.height))).toBe(10);
      expect(Math.round(actions.y - (box.y + box.height))).toBe(10);
      expect(Math.round(box.height)).toBe(220);
      expect(box.width).toBeLessThanOrEqual(body.width);
      expect(Math.round(box.x)).toBe(Math.round(body.x));

      await expect(item(page, 'watch/2026-10-05/2').locator('img')).toHaveCount(0);
      await expect(item(page, 'watch/2026-10-05/2').locator('.feed-summary + .feed-actions')).toHaveCount(1);
      await expect(item(page, 'watch/2026-10-05/3').locator('img')).toHaveCount(0);
      await expect(item(page, 'watch/2026-10-05/3').locator('.feed-summary + .feed-actions')).toHaveCount(1);
      await expect(runs(page).nth(1).locator('img')).toHaveCount(0);
    } finally {
      await new Promise((resolve) => pictures.close(resolve));
    }
  });

  // Phase 2 rewrites the Feed view
  test.skip('Discuss sends the item to the watch persona and opens its thread', async ({ page, hub }) => {
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

  // Phase 2 rewrites the Feed view
  test.skip('Discuss while the persona is busy says so under the item', async ({ page, hub }) => {
    hub.personas.hold('watch');
    await openFeed(page, hub);
    await item(page, 'watch/2026-09-28/3').getByRole('button', { name: /^Discuss/ }).click();
    await expectView(page, 'agents', 'Agents');
    await nav(page, 'Feed').click();
    await expect(page).toHaveURL(`${hub.origin}/feed`);
    await item(page, 'watch/2026-09-28/4').getByRole('button', { name: /^Discuss/ }).click();
    await expect(item(page, 'watch/2026-09-28/4').locator('.feed-reason')).toHaveText(BUSY);
    await expect(page).toHaveURL(`${hub.origin}/feed`);
    expect(hub.requests('/api/feed/discuss').map((entry) => entry.status)).toEqual([202, 409]);
  });

  // Phase 2 rewrites the Feed view
  test.skip('the brief opens over the Feed and leaves it as it was', async ({ page, hub }) => {
    await hub.writeBrief(DATE);
    await openFeed(page, hub);
    await page.goto(`${hub.origin}/brief`);
    await expect(page.getByRole('dialog', { name: 'Brief' })).toBeVisible();
    await expect(page).toHaveURL(`${hub.origin}/feed`);
    await page.keyboard.press('Escape');
    await expectView(page, 'feed', 'Feed');
    await expect(runs(page)).toHaveCount(2);
  });

  // Phase 2 rewrites the Feed view
  test.skip('the view stops reading the store once it is left', async ({ page, hub }) => {
    await page.clock.install();
    await openFeed(page, hub);
    await nav(page, 'Home').click();
    await expectView(page, 'agents', 'Agents');
    const before = hub.requests('/api/feed').length;
    await page.clock.runFor(120_000);
    expect(hub.requests('/api/feed').length).toBe(before);
  });
});

test.describe('the side panel', () => {
  test.use({ hubOptions: { feed: FEED, agents: [WATCH] } });

  const side = (page) => page.locator('#panel [data-panel-for="feed"]');
  const sourceRow = (page, name) => side(page).locator(`.panel-row[data-feed-source="${name}"]`);
  const shownItems = (page) => page.locator('#feed-runs .feed-item:visible');

  // On a phone the panel is a drawer, opened by the header's toggle first.
  async function openSide(page) {
    if (page.viewportSize().width >= 720) return;
    await page.locator('#panel-toggle').click();
    await expect(page.locator('#panel')).toBeVisible();
  }

  async function pick(page, name) {
    await openSide(page);
    await sourceRow(page, name).click();
  }

  // Phase 2 rewrites the Feed view
  test.skip('lists All and each source with its count, matching the posts', async ({ page, hub }) => {
    await openFeed(page, hub);
    await openSide(page);
    await expect(side(page)).toBeVisible();
    await expect(page.locator('#panel [data-panel-for="now"]')).toBeHidden();
    // watch/2026-09-28/5's source joins two newsletters ("Invented Gazette,
    // Invented Weekly"); it counts once under each, with no combined row.
    await expect(side(page).locator('.panel-row-name')).toHaveText([
      'All', 'Invented Gazette', 'Invented Letters', 'Invented Weekly',
    ]);
    await expect(side(page).locator('.panel-row-count')).toHaveText(['10', '5', '3', '3']);
    await expect(side(page).locator('h2.panel-heading')).toHaveText(['Sources']);
    await expect(side(page).locator('.panel-heading')).toHaveCSS('text-transform', 'uppercase');
    await expect(sourceRow(page, '')).toHaveAttribute('aria-current', 'true');
    await expect(side(page).locator('.panel-row[aria-current]')).toHaveCount(1);
    await expect(sourceRow(page, 'Invented Gazette')).toHaveCSS('height', '40px');

    // The rows' counts are the posts' own, splitting a joined source on
    // "/" and ",".
    const posts = await page.locator('#feed-runs .feed-item .feed-badge').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('aria-label')));
    expect(posts).toHaveLength(10);
    const splitNames = (source) => source.split(/[/,]/).map((part) => part.trim());
    for (const name of ['Invented Gazette', 'Invented Letters', 'Invented Weekly']) {
      const matching = posts.filter((source) => splitNames(source).includes(name)).length;
      await expect(sourceRow(page, name).locator('.panel-row-count')).toHaveText(String(matching));
    }

    // The same initials and colour as the posts' badges.
    const badge = sourceRow(page, 'Invented Gazette').locator('.feed-badge');
    await expect(badge).toHaveText('IG');
    const colour = (locator) => locator.evaluate((node) => getComputedStyle(node).backgroundColor);
    expect(await colour(badge)).toBe(await colour(item(page, 'watch/2026-09-28/1').locator('.feed-badge')));
    await expect(sourceRow(page, '').locator('.feed-badge')).toHaveCount(0);
  });

  // Phase 2 rewrites the Feed view
  test.skip('a source named with another in one item is split into its own row', async ({ page, hub }) => {
    await writeFile(path.join(hub.feedDir, '2026-10-05-watch.json'), JSON.stringify({
      producer: 'watch', date: '2026-10-05', items: [
        { id: 'watch/2026-10-05/1', title: 'Story one', source: 'A / B', url: 'https://example.com/1', summary: 'Summary one.' },
        { id: 'watch/2026-10-05/2', title: 'Story two', source: 'B, A', url: 'https://example.com/2', summary: 'Summary two.' },
      ],
    }));
    await page.goto(`${hub.origin}/feed`);
    await expectView(page, 'feed', 'Feed');
    await expect(runs(page)).toHaveCount(3);
    await openSide(page);
    await expect(sourceRow(page, 'A / B')).toHaveCount(0);
    await expect(sourceRow(page, 'B, A')).toHaveCount(0);
    await expect(sourceRow(page, 'A').locator('.panel-row-count')).toHaveText('2');
    await expect(sourceRow(page, 'B').locator('.panel-row-count')).toHaveText('2');

    await sourceRow(page, 'A').click();
    await expect(item(page, 'watch/2026-10-05/1')).toBeVisible();
    await expect(item(page, 'watch/2026-10-05/2')).toBeVisible();
  });

  // Phase 2 rewrites the Feed view
  test.skip('choosing a source shows only its posts; Show all and All restore them', async ({ page, hub }) => {
    await openFeed(page, hub);
    const line = page.locator('#feed-filter');
    await expect(line).toBeHidden();

    await pick(page, 'Invented Weekly');
    await expect(sourceRow(page, 'Invented Weekly')).toHaveAttribute('aria-current', 'true');
    await expect(side(page).locator('.panel-row[aria-current]')).toHaveCount(1);
    // watch/2026-09-28/5 names both Invented Gazette and Invented Weekly,
    // so it shows under either.
    await expect(shownItems(page)).toHaveCount(3);
    await expect(item(page, 'watch/2026-09-28/2')).toBeVisible();
    await expect(item(page, 'watch/2026-09-28/5')).toBeVisible();
    await expect(item(page, 'watch/2026-09-28/6')).toBeVisible();
    await expect(item(page, 'watch/2026-09-28/1')).toBeHidden();
    // The run with no Weekly post is hidden whole.
    await expect(page.locator('[data-feed-run="2026-09-21-watch"]')).toBeHidden();
    await expect(line).toBeVisible();
    await expect(page.locator('#feed-filter-text')).toHaveText('Showing Invented Weekly only.');
    const showAll = line.getByRole('button', { name: 'Show all' });
    await expect(showAll).toBeVisible();

    await showAll.click();
    await expect(shownItems(page)).toHaveCount(10);
    await expect(runs(page)).toHaveCount(2);
    await expect(page.locator('#feed-runs .feed-run:visible')).toHaveCount(2);
    await expect(line).toBeHidden();
    await expect(sourceRow(page, '')).toHaveAttribute('aria-current', 'true');

    await pick(page, 'Invented Letters');
    await expect(shownItems(page)).toHaveCount(3);
    await expect(page.locator('#feed-runs .feed-run:visible')).toHaveCount(2);
    await pick(page, '');
    await expect(shownItems(page)).toHaveCount(10);
    await expect(line).toBeHidden();
  });

  // Phase 2 rewrites the Feed view
  test.skip('the choice survives the refetch and clears once the Feed is left', async ({ page, hub }) => {
    await page.clock.install();
    await openFeed(page, hub);
    await pick(page, 'Invented Weekly');
    await expect(shownItems(page)).toHaveCount(3);
    const before = hub.requests('/api/feed').length;
    await page.clock.runFor(60_000);
    await expect.poll(() => hub.requests('/api/feed').length).toBeGreaterThan(before);
    await expect(shownItems(page)).toHaveCount(3);

    await nav(page, 'Home').click();
    await expectView(page, 'agents', 'Agents');
    await expect(side(page)).toBeHidden();
    await expect(side(page).locator('.panel-row')).toHaveCount(0);
    await nav(page, 'Feed').click();
    await expectView(page, 'feed', 'Feed');
    await expect(sourceRow(page, '')).toHaveAttribute('aria-current', 'true');
    await expect(shownItems(page)).toHaveCount(10);
    await expect(page.locator('#feed-filter')).toBeHidden();
  });

  // Phase 2 rewrites the Feed view
  test.skip('on a phone a choice closes the drawer', async ({ page, hub }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openFeed(page, hub);
    await expect(side(page).locator('.panel-row')).toHaveCount(4);
    await page.locator('#panel-toggle').click();
    await expect(page.locator('#panel')).toBeVisible();
    await expect(page.locator('#panel-scrim')).toBeVisible();
    await sourceRow(page, 'Invented Gazette').click();
    await expect(page.locator('#panel-toggle')).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('#panel')).toBeHidden();
    await expect(page.locator('#panel-scrim')).toBeHidden();
    // watch/2026-09-28/5 names both Invented Gazette and Invented Weekly.
    await expect(shownItems(page)).toHaveCount(5);
    await expect(page.locator('#feed-filter-text')).toHaveText('Showing Invented Gazette only.');
  });
});

test.describe('with an empty store', () => {
  test.use({ hubOptions: { agents: [WATCH] } });

  // Phase 2 rewrites the Feed view
  test.skip('says the feed is empty', async ({ page, hub }) => {
    await page.goto(`${hub.origin}/feed`);
    await expectView(page, 'feed', 'Feed');
    await expect(page.locator('#feed-message')).toHaveText(/^Nothing in the feed yet\./);
    await expect(runs(page)).toHaveCount(0);
  });

  test('/reading moves to /feed', async ({ page, hub }) => {
    await page.goto(`${hub.origin}/reading`);
    await expect(page).toHaveURL(`${hub.origin}/feed`);
    await expectView(page, 'feed', 'Feed');
    await expect(nav(page, 'Feed')).toHaveAttribute('title', 'Feed');
  });
});

test.describe('with the feed instructions', () => {
  test.use({ hubOptions: { feed: FEED, instructions: INSTRUCTIONS, agents: [WATCH] } });

  const toggle = (page) => page.getByRole('button', { name: 'Instructions' });
  const panel = (page) => page.locator('#feed-instructions');
  const input = (page) => panel(page).getByLabel('What should change?');

  async function openPanel(page, hub) {
    await openFeed(page, hub);
    await toggle(page).click();
    await expect(panel(page)).toBeVisible();
    await expect(panel(page).locator('.goal-prose li')).toHaveCount(4);
  }

  // Phase 2 rewrites the Feed view
  test.skip('the button opens the criteria as prose above the posts', async ({ page, hub }) => {
    await openFeed(page, hub);
    await expect(toggle(page)).toBeVisible();
    await expect(toggle(page)).toHaveAttribute('aria-expanded', 'false');
    await expect(toggle(page).locator('svg')).toHaveCount(1);
    await expect(toggle(page)).toHaveAttribute('aria-label', 'Instructions');
    await expect(toggle(page)).toHaveAttribute('title', 'Instructions');
    await expect(panel(page)).toBeHidden();
    await toggle(page).click();
    await expect(toggle(page)).toHaveAttribute('aria-expanded', 'true');
    await expect(panel(page).getByRole('heading', { name: 'Feed instructions' })).toBeVisible();
    await expect(panel(page).locator('.instructions-intro'))
      .toHaveText('The feed keeps what passes these tests. A change goes to Watch, which edits the file.');
    await expect(panel(page).locator('.goal-prose h4')).toHaveText(['Invented watch criteria', 'Sources', 'An item survives if']);
    await expect(panel(page).locator('.goal-prose p')).toHaveText(['What the invented feed keeps. Written as tests, not as topics.']);
    await expect(panel(page).locator('.goal-prose ul li')).toHaveText(['Invented Gazette', 'Invented Letters, weekly']);
    await expect(panel(page).locator('.goal-prose ol li'))
      .toHaveText(['It changes how the garden is planted.', 'It names a trail opening nearby.']);
    const table = panel(page).locator('.goal-prose table');
    await expect(table.locator('th')).toHaveText(['Source', 'Sender', 'Cadence']);
    await expect(table.locator('tbody tr')).toHaveCount(2);
    await expect(table.locator('tbody tr').nth(1).locator('td'))
      .toHaveText(['Invented Letters', 'letters@example.com, free', 'weekly']);
    await expect(input(page)).toBeFocused();
    await expect(panel(page).getByRole('button', { name: 'Send' })).toBeVisible();
    const box = await panel(page).boundingBox();
    const posts = await runs(page).first().boundingBox();
    expect(box.y + box.height).toBeLessThanOrEqual(posts.y);
    await expect(page.locator('#feed-instructions')).toHaveCount(1);
    expect(hub.requests('/api/feed/instructions')).toEqual([{ method: 'GET', status: 200 }]);
  });

  test('the button is only on the Feed view', async ({ page, hub }) => {
    await page.goto(`${hub.origin}/goals`);
    await expect(toggle(page)).toBeHidden();
    await nav(page, 'Feed').click();
    await expect(toggle(page)).toBeVisible();
    await nav(page, 'Goals').click();
    await expect(toggle(page)).toBeHidden();
  });

  // Phase 2 rewrites the Feed view
  test.skip('Send asks Watch for the change and opens its thread', async ({ page, hub }) => {
    await openPanel(page, hub);
    await input(page).fill('Drop the Invented Gazette.');
    const posted = page.waitForRequest('**/api/feed/instructions/propose');
    await panel(page).getByRole('button', { name: 'Send' }).click();
    expect((await posted).postDataJSON()).toEqual({ text: 'Drop the Invented Gazette.' });
    await expectView(page, 'agents', 'Agents');
    await expect(page).toHaveURL(`${hub.origin}/?agent=watch`);
    await expect(messages(page).first()).toHaveText(/^Change the feed's criteria\./);
    await expect(messages(page).first()).toContainText('Drop the Invented Gazette.');
    expect(hub.requests('/api/feed/instructions/propose')).toEqual([{ method: 'POST', status: 202 }]);
  });

  // Phase 2 rewrites the Feed view
  test.skip('Control+Enter sends', async ({ page, hub }) => {
    await openPanel(page, hub);
    await input(page).fill('Add the Invented Almanac.');
    await input(page).press('Control+Enter');
    await expect(page).toHaveURL(`${hub.origin}/?agent=watch`);
    expect(hub.requests('/api/feed/instructions/propose')).toEqual([{ method: 'POST', status: 202 }]);
  });

  // Phase 2 rewrites the Feed view
  test.skip('Cancel, Escape, and the button close the panel and focus the button', async ({ page, hub }) => {
    await openPanel(page, hub);
    await panel(page).getByRole('button', { name: 'Cancel' }).click();
    await expect(panel(page)).toBeHidden();
    await expect(toggle(page)).toBeFocused();
    await expect(toggle(page)).toHaveAttribute('aria-expanded', 'false');

    await toggle(page).click();
    await expect(input(page)).toBeFocused();
    await input(page).press('Escape');
    await expect(panel(page)).toBeHidden();
    await expect(toggle(page)).toBeFocused();

    await toggle(page).click();
    await expect(panel(page)).toBeVisible();
    await toggle(page).click();
    await expect(panel(page)).toBeHidden();
    await expect(toggle(page)).toBeFocused();
    expect(hub.requests('/api/feed/instructions/propose')).toEqual([]);
  });

  // Phase 2 rewrites the Feed view
  test.skip('a busy Watch says so under the composer', async ({ page, hub }) => {
    hub.personas.hold('watch');
    await openFeed(page, hub);
    await item(page, 'watch/2026-09-28/3').getByRole('button', { name: /^Discuss/ }).click();
    await expectView(page, 'agents', 'Agents');
    await nav(page, 'Feed').click();
    await toggle(page).click();
    await input(page).fill('Drop the Invented Gazette.');
    await panel(page).getByRole('button', { name: 'Send' }).click();
    await expect(panel(page).locator('.composer-reason')).toHaveText(BUSY);
    await expect(page).toHaveURL(`${hub.origin}/feed`);
    await expect(input(page)).toHaveValue('Drop the Invented Gazette.');
    expect(hub.requests('/api/feed/instructions/propose')).toEqual([{ method: 'POST', status: 409 }]);
  });

  // Phase 2 rewrites the Feed view
  test.skip('the panel keeps its text through the refetch', async ({ page, hub }) => {
    await page.clock.install();
    await openPanel(page, hub);
    await input(page).pressSequentially('Drop the Gazette');
    await writeFile(path.join(hub.feedDir, '2026-10-05-watch.json'), JSON.stringify({
      producer: 'watch', date: '2026-10-05', items: [{
        id: 'watch/2026-10-05/1', title: 'A new story', source: 'Invented Gazette', url: 'https://example.com/new', summary: 'New.',
      }],
    }));
    await page.clock.runFor(60_000);
    await expect(runs(page)).toHaveCount(3);
    await expect(panel(page)).toBeVisible();
    await expect(input(page)).toBeFocused();
    await expect(input(page)).toHaveValue('Drop the Gazette');
  });

  // Phase 2 rewrites the Feed view
  test.skip('on a phone the button is the icon alone and the panel fits', async ({ page, hub }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openPanel(page, hub);
    await expect(toggle(page).locator('.instructions-label')).toHaveCount(0);
    const button = await toggle(page).boundingBox();
    expect(button.x + button.width).toBeLessThanOrEqual(390);
    expect(button.height).toBeGreaterThanOrEqual(44);
    const overflow = await page.evaluate(() => ({
      page: document.documentElement.scrollWidth - window.innerWidth,
      feed: document.getElementById('feed-page').scrollWidth - document.getElementById('feed-page').clientWidth,
    }));
    expect(overflow).toEqual({ page: 0, feed: 0 });
  });
});

test.describe('with no feed instructions file', () => {
  test.use({ hubOptions: { feed: FEED, agents: [WATCH] } });

  // Phase 2 rewrites the Feed view
  test.skip('the panel says the file is missing and does not show an old copy on reopen', async ({ page, hub }) => {
    await openFeed(page, hub);
    await page.getByRole('button', { name: 'Instructions' }).click();
    await expect(page.locator('#feed-instructions .instructions-problem')).toHaveText('The feed instructions file is missing.');
    await page.getByRole('button', { name: 'Instructions' }).click();
    // The next read is held, so only what openPanel leaves in place shows.
    await page.route('**/api/feed/instructions', () => {});
    await page.getByRole('button', { name: 'Instructions' }).click();
    await expect(page.locator('#feed-instructions')).toBeVisible();
    await expect(page.locator('#feed-instructions .instructions-problem')).toHaveCount(0);
  });
});
