// The Feed view against a temporary feed `news` holding a copy of
// test/fixtures/feed (old-shape items, each with a `source` name), read by
// the real feeds and sources routes, with Scout, the feed's producer, on the
// fake Claude adapter of test/support/browser-server.mjs.

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';

import { SCOUT } from '../support/browser-server.mjs';
import { expect, expectView, nav, test } from '../support/browser-test.mjs';

const FEED = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'feed');
const DATE = '2026-09-15';
const AT = '2026-10-01T12:00:00.000Z';
const BUSY = 'Scout is in the middle of a turn. Try again when it is idle.';
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

async function openFeed(page, hub, count = 2) {
  await page.goto(`${hub.origin}/feed`);
  await expectView(page, 'feed', 'Feed');
  await expect(runs(page)).toHaveCount(count);
}

// A run file in feed `news` (or `feed`), as a producer writes it.
async function writeRun(hub, date, items, feed = 'news') {
  const dir = path.join(hub.feedsDir, feed, 'items');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${date}.json`), JSON.stringify({
    feed, producer: 'scout', date, since: null, generated_at: AT, read: [], items,
  }));
}

// A second feed beside `news`, created after it so it lists first.
async function writeFeed(hub, id, name) {
  await mkdir(path.join(hub.feedsDir, id, 'items'), { recursive: true });
  await writeFile(path.join(hub.feedsDir, id, 'feed.json'), JSON.stringify({
    version: 1, id, name, producer: 'scout', sources: [], active: true, created: '2099-01-01T00:00:00.000Z', updated: AT,
  }));
}

async function writeSource(hub, id, name) {
  await mkdir(hub.sourcesDir, { recursive: true });
  await writeFile(path.join(hub.sourcesDir, `${id}.json`), JSON.stringify({
    version: 1, id, name, kind: 'rss', url: `https://example.com/${id}.xml`, active: true, default: false, created: AT, updated: AT,
  }));
}

const post = (n, extra) => ({
  id: `news/2026-10-05/${n}`, title: `Story ${n}`, sources: ['invented-gazette'],
  url: `https://example.com/${n}`, summary: `Summary of story ${n}.`, ...extra,
});

test.describe('with the fixture store', () => {
  test.use({ hubOptions: { feed: FEED, agents: [SCOUT] } });

  test('renders each run as a group of posts, newest first', async ({ page, hub }) => {
    await openFeed(page, hub);
    await expect(page.locator('#feed-tabs')).toBeHidden();
    await expect(runs(page).locator('.feed-date')).toHaveText(['Monday, September 28', 'Monday, September 21']);
    await expect(runs(page).first().locator('.feed-since')).toHaveText('Since September 14');
    await expect(runs(page).first().locator('.feed-item')).toHaveCount(8);
    await expect(runs(page).first()).toHaveCSS('border-top-width', '0px');
    const first = await runs(page).first().boundingBox();
    const second = await runs(page).nth(1).boundingBox();
    expect(Math.round(second.y - (first.y + first.height))).toBe(32);
    const postBox = await item(page, 'watch/2026-09-28/1').boundingBox();
    const next = await item(page, 'watch/2026-09-28/2').boundingBox();
    expect(Math.round(next.y - (postBox.y + postBox.height))).toBe(24);
    await expect(page.locator('#feed-message')).toBeHidden();
    await expect(page.locator('iframe')).toHaveCount(0);

    // An old-shape post: its `source` name is shown as written.
    const robots = item(page, 'watch/2026-09-28/1');
    const badge = robots.locator('.feed-badge');
    await expect(badge).toHaveText('IG');
    await expect(badge).toHaveAttribute('aria-label', 'Invented Gazette');
    await expect(badge).toHaveCSS('border-radius', '50%');
    const link = robots.locator('.feed-title a');
    await expect(link).toHaveText('Town council adopts a rule for delivery robots');
    await expect(link).toHaveAttribute('href', 'https://example.com/robots');
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    await expect(robots.locator('.feed-summary')).toHaveText('The Invented Gazette reports the town adopted a rule for delivery robots on sidewalks.');
    await expect(robots.locator('.feed-takeaway')).toHaveCount(0);
    await expect(robots.locator('.feed-insights-toggle')).toHaveCount(0);
    const discuss = robots.getByRole('button', { name: 'Discuss Town council adopts a rule for delivery robots' });
    await expect(discuss).toBeVisible();
    await expect(discuss).toHaveText('Discuss');
    await expect(discuss.locator('svg')).toHaveCount(1);
    await expect(discuss).toHaveCSS('border-top-width', '0px');
    await expect(discuss).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(robots.getByRole('button', { name: 'Save', exact: true })).toHaveAttribute('aria-pressed', 'false');
    await expect(robots.getByRole('button', { name: 'More' })).toBeVisible();
    await expect(robots.getByRole('menuitem', { name: 'Dismiss' })).toBeHidden();
    await expect(page.locator('#view-feed [data-action]')).toHaveCount(0);
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
      feed: document.getElementById('feed-page').scrollWidth - document.getElementById('feed-page').clientWidth,
    }));
    expect(overflow).toEqual({ page: 0, feed: 0 });
  });

  test('a post with an image shows it under the summary; one without or with a broken image has none', async ({ page, hub }) => {
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
      await writeRun(hub, '2026-10-05', [
        post(1, { image: `${origin}/story.png` }), post(2), post(3, { image: `${origin}/missing.png` }),
      ]);
      await openFeed(page, hub, 3);

      const withImage = item(page, 'news/2026-10-05/1');
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

      await expect(item(page, 'news/2026-10-05/2').locator('img')).toHaveCount(0);
      await expect(item(page, 'news/2026-10-05/2').locator('.feed-summary + .feed-actions')).toHaveCount(1);
      await expect(item(page, 'news/2026-10-05/3').locator('img')).toHaveCount(0);
      await expect(item(page, 'news/2026-10-05/3').locator('.feed-summary + .feed-actions')).toHaveCount(1);
      await expect(runs(page).nth(1).locator('img')).toHaveCount(0);
    } finally {
      await new Promise((resolve) => pictures.close(resolve));
    }
  });

  test('the takeaway is its own muted line under the summary, never joined to it', async ({ page, hub }) => {
    await writeRun(hub, '2026-10-05', [post(1, { takeaway: 'The rule takes effect in March.' }), post(2)]);
    await openFeed(page, hub, 3);
    const first = item(page, 'news/2026-10-05/1');
    await expect(first.locator('.feed-summary')).toHaveText('Summary of story 1.');
    await expect(first.locator('.feed-summary + .feed-takeaway')).toHaveText('The rule takes effect in March.');
    const style = (selector) => first.locator(selector).evaluate((node) => {
      const css = getComputedStyle(node);
      return { size: parseFloat(css.fontSize), colour: css.color, display: css.display };
    });
    const summary = await style('.feed-summary');
    const takeaway = await style('.feed-takeaway');
    expect(takeaway.size).toBeLessThan(summary.size);
    expect(takeaway.colour).not.toBe(summary.colour);
    expect(takeaway.display).toBe('block');
    const summaryBox = await first.locator('.feed-summary').boundingBox();
    const takeawayBox = await first.locator('.feed-takeaway').boundingBox();
    expect(takeawayBox.y).toBeGreaterThanOrEqual(summaryBox.y + summaryBox.height);
    await expect(item(page, 'news/2026-10-05/2').locator('.feed-takeaway')).toHaveCount(0);
  });

  test('Insights expand under the action row and collapse again, with aria-expanded', async ({ page, hub }) => {
    await writeRun(hub, '2026-10-05', [post(1, { insights: 'Why it matters:\n\n- **Cost** fell by half.\n- It ships in March.' }), post(2)]);
    await openFeed(page, hub, 3);
    const first = item(page, 'news/2026-10-05/1');
    const toggle = first.getByRole('button', { name: 'Insights' });
    const panel = first.locator('.feed-insights');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(panel).toBeHidden();
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(panel).toBeVisible();
    await expect(panel.locator('li')).toHaveText(['Cost fell by half.', 'It ships in March.']);
    await expect(panel.locator('strong')).toHaveText('Cost');
    await expect(first.locator('.feed-actions + .feed-insights')).toHaveCount(1);
    expect(await toggle.getAttribute('aria-controls')).toBe(await panel.getAttribute('id'));
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(panel).toBeHidden();
    await expect(item(page, 'news/2026-10-05/2').getByRole('button', { name: 'Insights' })).toHaveCount(0);
  });

  test('a post names its sources by their registered names, and an unknown id as written', async ({ page, hub }) => {
    await writeSource(hub, 'invented-gazette', 'Invented Gazette');
    await writeRun(hub, '2026-10-05', [post(1), post(2, { sources: ['mystery-letter'] })]);
    await openFeed(page, hub, 3);
    await expect(item(page, 'news/2026-10-05/1').locator('.feed-badge')).toHaveAttribute('aria-label', 'Invented Gazette');
    await expect(item(page, 'news/2026-10-05/1').locator('.feed-badge')).toHaveText('IG');
    await expect(item(page, 'news/2026-10-05/2').locator('.feed-badge')).toHaveAttribute('aria-label', 'mystery-letter');
    // An old post's "Invented Gazette" maps to the registered source.
    await expect(item(page, 'watch/2026-09-28/1').locator('.feed-badge')).toHaveAttribute('aria-label', 'Invented Gazette');
  });

  test('Save fills the bookmark and Unsave empties it; the marks file keeps it', async ({ page, hub }) => {
    await openFeed(page, hub);
    const robots = item(page, 'watch/2026-09-28/1');
    const posted = page.waitForRequest('**/api/feeds/news/save');
    await robots.getByRole('button', { name: 'Save', exact: true }).click();
    expect((await posted).postDataJSON()).toEqual({ id: 'watch/2026-09-28/1' });
    const unsave = robots.getByRole('button', { name: 'Unsave' });
    await expect(unsave).toHaveAttribute('aria-pressed', 'true');
    const marks = JSON.parse(await readFile(path.join(hub.feedsDir, 'news', 'marks.json'), 'utf8'));
    expect(marks.marks['watch/2026-09-28/1'].status).toBe('saved');
    await unsave.click();
    await expect(robots.getByRole('button', { name: 'Save', exact: true })).toHaveAttribute('aria-pressed', 'false');
    expect(hub.requests('/api/feeds/news/unsave')).toEqual([{ method: 'POST', status: 200 }]);
  });

  test('Dismiss in the More menu hides the post, and it stays hidden after the refetch', async ({ page, hub }) => {
    await page.clock.install();
    await openFeed(page, hub);
    const robots = item(page, 'watch/2026-09-28/1');
    const more = robots.getByRole('button', { name: 'More' });
    await more.click();
    await expect(more).toHaveAttribute('aria-expanded', 'true');
    const dismiss = robots.getByRole('menuitem', { name: 'Dismiss' });
    await expect(dismiss).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dismiss).toBeHidden();
    await expect(more).toBeFocused();
    await more.click();
    await dismiss.click();
    await expect(robots).toHaveCount(0);
    await expect(runs(page).first().locator('.feed-item')).toHaveCount(7);
    const before = hub.requests('/api/feeds/news').length;
    await page.clock.runFor(60_000);
    await expect.poll(() => hub.requests('/api/feeds/news').length).toBeGreaterThan(before);
    await expect(item(page, 'watch/2026-09-28/1')).toHaveCount(0);
    const marks = JSON.parse(await readFile(path.join(hub.feedsDir, 'news', 'marks.json'), 'utf8'));
    expect(marks.marks['watch/2026-09-28/1'].status).toBe('dismissed');
  });

  test('Discuss sends the post to Scout and opens its thread', async ({ page, hub }) => {
    await openFeed(page, hub);
    const posted = page.waitForRequest('**/api/feeds/news/discuss');
    await item(page, 'watch/2026-09-21/2').getByRole('button', { name: /^Discuss/ }).click();
    expect((await posted).postDataJSON()).toEqual({ id: 'watch/2026-09-21/2' });

    await expectView(page, 'agents', 'Agents');
    await expect(page).toHaveURL(`${hub.origin}/?agent=scout`);
    await expect(messages(page).first()).toHaveText(/^Discuss this feed post with me\./);
    await expect(messages(page).first()).toContainText('Hand-bound notebooks, a how-to');
    expect(hub.requests('/api/feeds/news/discuss')).toEqual([{ method: 'POST', status: 202 }]);
    expect(hub.personas.calls).toEqual([['send', 'scout', expect.stringContaining('https://example.com/notebooks')]]);
  });

  test('Discuss while Scout is busy says so under the post', async ({ page, hub }) => {
    hub.personas.hold('scout');
    await openFeed(page, hub);
    await item(page, 'watch/2026-09-28/3').getByRole('button', { name: /^Discuss/ }).click();
    await expectView(page, 'agents', 'Agents');
    await nav(page, 'Feed').click();
    await expect(page).toHaveURL(`${hub.origin}/feed`);
    await item(page, 'watch/2026-09-28/4').getByRole('button', { name: /^Discuss/ }).click();
    await expect(item(page, 'watch/2026-09-28/4').locator('.feed-reason')).toHaveText(BUSY);
    await expect(page).toHaveURL(`${hub.origin}/feed`);
    expect(hub.requests('/api/feeds/news/discuss').map((entry) => entry.status)).toEqual([202, 409]);
  });

  test('the brief opens over the Feed and leaves it as it was', async ({ page, hub }) => {
    await hub.writeBrief(DATE);
    await openFeed(page, hub);
    await page.goto(`${hub.origin}/brief`);
    await expect(page.getByRole('dialog', { name: 'Brief' })).toBeVisible();
    await expect(page).toHaveURL(`${hub.origin}/feed`);
    await page.keyboard.press('Escape');
    await expectView(page, 'feed', 'Feed');
    await expect(runs(page)).toHaveCount(2);
  });

  test('the view stops reading the store once it is left', async ({ page, hub }) => {
    await page.clock.install();
    await openFeed(page, hub);
    await nav(page, 'Home').click();
    await expectView(page, 'agents', 'Agents');
    const before = hub.requests('/api/feeds').length;
    await page.clock.runFor(120_000);
    expect(hub.requests('/api/feeds').length).toBe(before);
  });
});

test.describe('with two feeds', () => {
  test.use({ hubOptions: { feed: FEED, agents: [SCOUT] } });

  test('tabs appear, switch the feed, and keep it in the address', async ({ page, hub }) => {
    await writeFeed(hub, 'research', 'Research');
    await page.goto(`${hub.origin}/feed`);
    await expectView(page, 'feed', 'Feed');
    const tabs = page.getByRole('tablist', { name: 'Feeds' });
    await expect(tabs).toBeVisible();
    await expect(tabs.getByRole('tab')).toHaveText(['Research', 'News']);
    await expect(tabs.getByRole('tab', { name: 'Research' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#feed-message')).toHaveText('No posts yet. Scout fills this feed on its next run.');
    await expect(runs(page)).toHaveCount(0);
    await expect(page).toHaveURL(`${hub.origin}/feed?f=research`);

    await tabs.getByRole('tab', { name: 'News' }).click();
    await expect(tabs.getByRole('tab', { name: 'News' })).toHaveAttribute('aria-selected', 'true');
    await expect(tabs.getByRole('tab', { name: 'Research' })).toHaveAttribute('aria-selected', 'false');
    await expect(runs(page)).toHaveCount(2);
    await expect(page.locator('#feed-message')).toBeHidden();
    await expect(page).toHaveURL(`${hub.origin}/feed?f=news`);

    await tabs.getByRole('tab', { name: 'News' }).press('ArrowRight');
    await expect(tabs.getByRole('tab', { name: 'Research' })).toHaveAttribute('aria-selected', 'true');
    await expect(tabs.getByRole('tab', { name: 'Research' })).toBeFocused();

    await page.goto(`${hub.origin}/feed?f=news`);
    await expect(runs(page)).toHaveCount(2);
    await expect(tabs.getByRole('tab', { name: 'News' })).toHaveAttribute('aria-selected', 'true');
  });
});

test.describe('with two feeds and the producer\'s job', () => {
  test.use({
    hubOptions: {
      feed: FEED, agents: [SCOUT],
      jobs: {
        focusAvailable: true, refreshedAt: AT,
        items: [{
          label: 'com.hunter.scout', agentId: 'scout', agentName: 'Scout', name: 'scout',
          schedule: { kind: 'calendar', text: 'Daily at 06:00' }, logPath: '/invented/scout.log', lastRun: null,
          outcome: 'unknown', exitStatus: null, failures24h: null, paused: null, source: 'launchctl',
        }],
      },
    },
  });

  test('the empty sentence names the producer\'s scheduled run', async ({ page, hub }) => {
    await writeFeed(hub, 'research', 'Research');
    await page.goto(`${hub.origin}/feed?f=research`);
    await expect(page.locator('#feed-message')).toHaveText('No posts yet. Scout runs daily at 06:00.');
  });
});

test.describe('the side panel', () => {
  test.use({ hubOptions: { feed: FEED, agents: [SCOUT] } });

  const side = (page) => page.locator('#panel [data-panel-for="feed"]');
  const row = (page, key) => side(page).locator(`.panel-row[data-feed-filter="${key}"]`);
  const sourceRow = (page, name) => row(page, `source:${name}`);
  const shownItems = (page) => page.locator('#feed-runs .feed-item:visible');

  // On a phone the panel is a drawer, opened by the header's toggle first.
  async function openSide(page) {
    if (page.viewportSize().width >= 720) return;
    await page.locator('#panel-toggle').click();
    await expect(page.locator('#panel')).toBeVisible();
  }

  async function pick(page, key) {
    await openSide(page);
    await row(page, key).click();
  }

  test('lists All and each source with its count, matching the posts', async ({ page, hub }) => {
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
    await expect(row(page, 'all')).toHaveAttribute('aria-current', 'true');
    await expect(side(page).locator('.panel-row[aria-current]')).toHaveCount(1);
    await expect(row(page, 'saved')).toHaveCount(0);
    await expect(sourceRow(page, 'Invented Gazette')).toHaveCSS('height', '40px');

    // The same initials and colour as the posts' badges.
    const badge = sourceRow(page, 'Invented Gazette').locator('.feed-badge');
    await expect(badge).toHaveText('IG');
    const colour = (locator) => locator.evaluate((node) => getComputedStyle(node).backgroundColor);
    expect(await colour(badge)).toBe(await colour(item(page, 'watch/2026-09-28/1').locator('.feed-badge')));
    await expect(row(page, 'all').locator('.feed-badge')).toHaveCount(0);
  });

  test('a bracketed aside in a source name is ignored for its initials', async ({ page, hub }) => {
    await writeRun(hub, '2026-10-06', [
      { id: 'news/2026-10-06/1', title: 'Story one', source: 'AINews (Latent Space)', url: 'https://example.com/1', summary: 'Summary one.' },
    ]);
    await openFeed(page, hub, 3);
    await openSide(page);
    await expect(sourceRow(page, 'AINews (Latent Space)').locator('.feed-badge')).toHaveText('A');
    await expect(item(page, 'news/2026-10-06/1').locator('.feed-badge')).toHaveText('A');
  });

  test('a source named with another in one old post is split into its own row', async ({ page, hub }) => {
    await writeRun(hub, '2026-10-05', [
      { id: 'news/2026-10-05/1', title: 'Story one', source: 'A / B', url: 'https://example.com/1', summary: 'Summary one.' },
      { id: 'news/2026-10-05/2', title: 'Story two', source: 'B, A', url: 'https://example.com/2', summary: 'Summary two.' },
    ]);
    await openFeed(page, hub, 3);
    await openSide(page);
    await expect(sourceRow(page, 'A / B')).toHaveCount(0);
    await expect(sourceRow(page, 'B, A')).toHaveCount(0);
    await expect(sourceRow(page, 'A').locator('.panel-row-count')).toHaveText('2');
    await expect(sourceRow(page, 'B').locator('.panel-row-count')).toHaveText('2');

    await sourceRow(page, 'A').click();
    await expect(item(page, 'news/2026-10-05/1')).toBeVisible();
    await expect(item(page, 'news/2026-10-05/2')).toBeVisible();
  });

  test('choosing a source shows only its posts; Show all and All restore them', async ({ page, hub }) => {
    await openFeed(page, hub);
    const line = page.locator('#feed-filter');
    await expect(line).toBeHidden();

    await pick(page, 'source:Invented Weekly');
    await expect(sourceRow(page, 'Invented Weekly')).toHaveAttribute('aria-current', 'true');
    await expect(side(page).locator('.panel-row[aria-current]')).toHaveCount(1);
    await expect(shownItems(page)).toHaveCount(3);
    await expect(item(page, 'watch/2026-09-28/2')).toBeVisible();
    await expect(item(page, 'watch/2026-09-28/5')).toBeVisible();
    await expect(item(page, 'watch/2026-09-28/6')).toBeVisible();
    await expect(item(page, 'watch/2026-09-28/1')).toHaveCount(0);
    // The run with no Weekly post is left out whole.
    await expect(page.locator('[data-feed-run="2026-09-21-watch"]')).toHaveCount(0);
    await expect(line).toBeVisible();
    await expect(page.locator('#feed-filter-text')).toHaveText('Showing Invented Weekly only.');

    await line.getByRole('button', { name: 'Show all' }).click();
    await expect(shownItems(page)).toHaveCount(10);
    await expect(runs(page)).toHaveCount(2);
    await expect(line).toBeHidden();
    await expect(row(page, 'all')).toHaveAttribute('aria-current', 'true');

    await pick(page, 'source:Invented Letters');
    await expect(shownItems(page)).toHaveCount(3);
    await expect(runs(page)).toHaveCount(2);
    await pick(page, 'all');
    await expect(shownItems(page)).toHaveCount(10);
    await expect(line).toBeHidden();
  });

  test('Saved appears once a post is saved and shows saved posts across days', async ({ page, hub }) => {
    await openFeed(page, hub);
    await item(page, 'watch/2026-09-28/2').getByRole('button', { name: 'Save', exact: true }).click();
    await expect(item(page, 'watch/2026-09-28/2').getByRole('button', { name: 'Unsave' })).toBeVisible();
    await item(page, 'watch/2026-09-21/2').getByRole('button', { name: 'Save', exact: true }).click();
    await expect(item(page, 'watch/2026-09-21/2').getByRole('button', { name: 'Unsave' })).toBeVisible();
    await openSide(page);
    await expect(side(page).locator('.panel-row-name')).toHaveText([
      'All', 'Saved', 'Invented Gazette', 'Invented Letters', 'Invented Weekly',
    ]);
    await expect(row(page, 'saved').locator('.panel-row-count')).toHaveText('2');
    await row(page, 'saved').click();
    await expect(shownItems(page)).toHaveCount(2);
    await expect(runs(page)).toHaveCount(2);
    await expect(page.locator('#feed-filter-text')).toHaveText('Showing saved posts only.');

    // Unsaving the last saved post drops the row and the filter with it.
    await item(page, 'watch/2026-09-28/2').getByRole('button', { name: 'Unsave' }).click();
    await expect(shownItems(page)).toHaveCount(1);
    await item(page, 'watch/2026-09-21/2').getByRole('button', { name: 'Unsave' }).click();
    await expect(shownItems(page)).toHaveCount(10);
    await expect(page.locator('#feed-filter')).toBeHidden();
    await openSide(page);
    await expect(row(page, 'saved')).toHaveCount(0);
  });

  test('the choice survives the refetch and clears once the Feed is left', async ({ page, hub }) => {
    await page.clock.install();
    await openFeed(page, hub);
    await pick(page, 'source:Invented Weekly');
    await expect(shownItems(page)).toHaveCount(3);
    const before = hub.requests('/api/feeds').length;
    await page.clock.runFor(60_000);
    await expect.poll(() => hub.requests('/api/feeds').length).toBeGreaterThan(before);
    await expect(shownItems(page)).toHaveCount(3);

    await nav(page, 'Home').click();
    await expectView(page, 'agents', 'Agents');
    await expect(side(page)).toBeHidden();
    await expect(side(page).locator('.panel-row')).toHaveCount(0);
    await nav(page, 'Feed').click();
    await expectView(page, 'feed', 'Feed');
    await expect(row(page, 'all')).toHaveAttribute('aria-current', 'true');
    await expect(shownItems(page)).toHaveCount(10);
    await expect(page.locator('#feed-filter')).toBeHidden();
  });

  test('on a phone a choice closes the drawer', async ({ page, hub }) => {
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

test.describe('with no feeds', () => {
  test.use({ hubOptions: { agents: [SCOUT] } });

  test('says there are no feeds', async ({ page, hub }) => {
    await page.goto(`${hub.origin}/feed`);
    await expectView(page, 'feed', 'Feed');
    await expect(page.locator('#feed-message')).toHaveText('There are no feeds yet.');
    await expect(runs(page)).toHaveCount(0);
    await expect(page.locator('#feed-tabs')).toBeHidden();
  });

  test('/reading moves to /feed', async ({ page, hub }) => {
    await page.goto(`${hub.origin}/reading`);
    await expect(page).toHaveURL(`${hub.origin}/feed`);
    await expectView(page, 'feed', 'Feed');
    await expect(nav(page, 'Feed')).toHaveAttribute('title', 'Feed');
  });
});

test.describe('the settings gear', () => {
  test.use({ hubOptions: { feed: FEED, agents: [SCOUT] } });

  test('is only on the Feed view, as the agent settings gear, and the sheet closes when the Feed is left', async ({ page, hub }) => {
    const gear = page.locator('#feed-settings-toggle');
    await page.goto(`${hub.origin}/goals`);
    await expect(gear).toBeHidden();
    await nav(page, 'Feed').click();
    await expect(gear).toBeVisible();
    await expect(gear).toHaveAttribute('aria-label', 'Settings');
    await expect(gear).toHaveAttribute('aria-controls', 'feed-settings');
    const agentGear = await page.locator('#thread-template').evaluate((node) => node.content.querySelector('[data-part="details-toggle"] svg').outerHTML);
    expect(await gear.locator('svg').evaluate((node) => node.outerHTML)).toBe(agentGear);
    await expect(page.getByRole('button', { name: 'Instructions' })).toHaveCount(0);
    await gear.click();
    await expect(page.locator('#feed-settings')).toBeVisible();
    await nav(page, 'Goals').click();
    await expect(gear).toBeHidden();
    await nav(page, 'Feed').click();
    await expect(page.locator('#feed-settings')).toBeHidden();
  });

  test('is not there without a feed, while New feed is', async ({ page, hub }) => {
    await rm(path.join(hub.feedsDir, 'news'), { recursive: true });
    await page.goto(`${hub.origin}/feed`);
    await expect(page.locator('#feed-message')).toHaveText('There are no feeds yet.');
    await expect(page.locator('#feed-settings-toggle')).toBeHidden();
    await expect(page.locator('#feed-new')).toBeVisible();
  });
});
