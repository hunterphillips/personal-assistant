// The Feed's settings sheet, Sources, and New feed against a temporary feed
// `news` (a copy of test/fixtures/feed, its note the fixture instructions),
// the real feeds and sources routes, and a local site standing in for a
// newsletter's, so discovery never leaves the machine.

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SCOUT } from '../support/browser-server.mjs';
import { expect, expectView, test } from '../support/browser-test.mjs';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const AT = '2026-10-01T12:00:00.000Z';

const sheet = (page) => page.locator('#feed-settings');
const gear = (page) => page.locator('#feed-settings-toggle');
const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'));

async function writeSource(hub, fields) {
  await mkdir(hub.sourcesDir, { recursive: true });
  await writeFile(path.join(hub.sourcesDir, `${fields.id}.json`), JSON.stringify({
    version: 1, active: true, default: false, ...fields, created: AT, updated: AT,
  }));
}

async function writeSuggestions(hub, feed, sources) {
  await writeFile(path.join(hub.feedsDir, feed, 'suggestions.json'), JSON.stringify({ version: 1, at: AT, sources }));
}

async function openSettings(page, hub) {
  await page.goto(`${hub.origin}/feed`);
  await expectView(page, 'feed', 'Feed');
  await expect(page.locator('#feed-runs .feed-run')).toHaveCount(2);
  await gear(page).click();
  await expect(sheet(page)).toBeVisible();
}

async function openSources(page, hub) {
  await openSettings(page, hub);
  await sheet(page).getByRole('button', { name: 'Manage sources' }).click();
  await expect(sheet(page).getByRole('heading', { name: 'Sources' })).toBeVisible();
}

// A site with a page that links its RSS feed, a page with none, and the feed.
async function fixtureSite() {
  const server = http.createServer((req, res) => {
    const pages = {
      '/': ['text/html', '<html><head><link rel="alternate" type="application/rss+xml" href="/feed.xml"></head><body></body></html>'],
      '/plain': ['text/html', '<html><head><title>No feed</title></head><body></body></html>'],
      '/feed.xml': ['application/rss+xml', '<?xml version="1.0"?><rss version="2.0"><channel></channel></rss>'],
    };
    const page = pages[req.url];
    if (!page) res.writeHead(404).end();
    else res.writeHead(200, { 'content-type': page[0] }).end(page[1]);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

test.describe('feed settings', () => {
  test.use({ hubOptions: { feed: path.join(FIXTURES, 'feed'), instructions: path.join(FIXTURES, 'feed-instructions', 'relevance.md'), agents: [SCOUT] } });

  test('the gear opens the feed\'s instructions; Save is on once they change and writes the note', async ({ page, hub }) => {
    await openSettings(page, hub);
    await expect(gear(page)).toHaveAttribute('aria-expanded', 'true');
    await expect(sheet(page).getByRole('heading', { name: 'Settings' })).toBeFocused();
    await expect(sheet(page).locator('.details-name')).toHaveText('News');
    const note = sheet(page).getByRole('textbox', { name: 'Instructions' });
    const original = await readFile(hub.instructionsFile, 'utf8');
    await expect(note).toHaveValue(original);
    const save = sheet(page).getByRole('button', { name: 'Save' });
    await expect(save).toBeDisabled();
    await note.fill('Keep only stories about the garden.');
    await expect(save).toBeEnabled();
    await save.click();
    await expect(sheet(page).locator('.feed-settings-status').first()).toHaveText('Saved.');
    await expect(save).toBeDisabled();
    expect(await readFile(hub.instructionsFile, 'utf8')).toBe('Keep only stories about the garden.');
    expect(hub.requests('/api/feeds/news/note')).toEqual([{ method: 'GET', status: 200 }, { method: 'PUT', status: 200 }]);

    await page.keyboard.press('Escape');
    await expect(sheet(page)).toBeHidden();
    await expect(gear(page)).toBeFocused();
    await expect(gear(page)).toHaveAttribute('aria-expanded', 'false');
  });

  test('a source checkbox changes the feed\'s sources; incoming come first, then context, and inactive ones are left out', async ({ page, hub }) => {
    await writeSource(hub, { id: 'latent-space', name: 'Latent Space', kind: 'rss', url: 'https://example.com/feed' });
    await writeSource(hub, { id: 'priorities', name: 'Priorities', kind: 'file', path: hub.instructionsFile });
    await writeSource(hub, { id: 'old-letter', name: 'Old letter', kind: 'email', sender: 'old@example.com', active: false });
    await openSettings(page, hub);
    const list = sheet(page).locator('.feed-settings-sources');
    await expect(list.locator('legend')).toHaveText(['Incoming', 'Context']);
    await expect(list.getByRole('checkbox')).toHaveCount(2);
    await expect(list.getByRole('checkbox', { name: 'Old letter' })).toHaveCount(0);
    await list.getByRole('checkbox', { name: 'Priorities' }).check();
    await expect.poll(async () => (await readJson(path.join(hub.feedsDir, 'news', 'feed.json'))).sources).toEqual(['priorities']);
    await list.getByRole('checkbox', { name: 'Latent Space' }).check();
    await expect.poll(async () => (await readJson(path.join(hub.feedsDir, 'news', 'feed.json'))).sources).toEqual(['priorities', 'latent-space']);
    await list.getByRole('checkbox', { name: 'Priorities' }).uncheck();
    await expect.poll(async () => (await readJson(path.join(hub.feedsDir, 'news', 'feed.json'))).sources).toEqual(['latent-space']);
  });

  test('Add source walks each type: a newsletter with a feed is RSS, one without asks for the sender, and a path says when it is not there', async ({ page, hub }) => {
    const site = await fixtureSite();
    try {
      await openSources(page, hub);
      await expect(sheet(page).locator('.feed-settings-status').last()).toHaveText('There are no sources yet.');
      const add = async () => {
        await sheet(page).getByRole('button', { name: 'Add source' }).click();
        return sheet(page).getByRole('form', { name: 'Add source' });
      };

      let form = await add();
      await expect(form.getByRole('radio', { name: 'Newsletter' })).toBeChecked();
      await expect(form.getByLabel('Site')).toBeVisible();
      await expect(form.getByLabel('Sender')).toBeHidden();
      await form.getByLabel('Name').fill('Invented Letters');
      await form.getByLabel('Site').fill(`${site.origin}/`);
      await form.getByRole('button', { name: 'Save' }).click();
      const row = (id) => sheet(page).locator(`.feed-source[data-source="${id}"]`);
      await expect(row('invented-letters').locator('.feed-source-kind')).toHaveText('RSS');
      await expect(row('invented-letters').locator('.feed-source-address')).toHaveText(`${site.origin}/feed.xml`);

      form = await add();
      await form.getByLabel('Name').fill('Invented Weekly');
      await form.getByLabel('Site').fill(`${site.origin}/plain`);
      await form.getByRole('button', { name: 'Save' }).click();
      await expect(form.getByLabel('Sender')).toBeVisible();
      await expect(form.getByLabel('Sender')).toBeFocused();
      await expect(form).toContainText('No feed was found at that site.');
      await form.getByLabel('Sender').fill('weekly@example.com');
      await form.getByRole('button', { name: 'Save' }).click();
      await expect(row('invented-weekly').locator('.feed-source-kind')).toHaveText('Newsletter');
      await expect(row('invented-weekly').locator('.feed-source-address')).toHaveText('weekly@example.com');

      form = await add();
      await form.getByRole('radio', { name: 'RSS or blog' }).check();
      await expect(form.getByLabel('Address')).toBeVisible();
      await form.getByLabel('Name').fill('Invented Blog');
      await form.getByLabel('Address').fill(`${site.origin}/plain`);
      await form.getByRole('button', { name: 'Save' }).click();
      await expect(form.locator('.feed-settings-status')).toHaveText('No feed was found at that address.');
      await form.getByLabel('Address').fill(`${site.origin}/feed.xml`);
      await form.getByRole('button', { name: 'Save' }).click();
      await expect(row('invented-blog').locator('.feed-source-address')).toHaveText(`${site.origin}/feed.xml`);

      form = await add();
      await form.getByRole('radio', { name: 'File' }).check();
      await expect(form.getByLabel('Path')).toBeVisible();
      await expect(form.getByLabel('Site')).toHaveCount(0);
      await form.getByLabel('Name').fill('Gone notes');
      await form.getByLabel('Path').fill('notes.md');
      await form.getByRole('button', { name: 'Save' }).click();
      await expect(form.locator('.feed-settings-status')).toHaveText('The path must start with /.');
      await form.getByLabel('Path').fill('/invented/not-there.md');
      await form.getByRole('button', { name: 'Save' }).click();
      await expect(row('gone-notes').locator('.feed-source-missing')).toHaveText('This path is not there.');

      form = await add();
      await form.getByRole('radio', { name: 'Folder' }).check();
      await form.getByLabel('Name').fill('Feeds folder');
      await form.getByLabel('Path').fill(hub.feedsDir);
      await form.getByRole('button', { name: 'Save' }).click();
      await expect(row('feeds-folder').locator('.feed-source-kind')).toHaveText('Folder');
      await expect(row('feeds-folder').locator('.feed-source-missing')).toHaveCount(0);

      const stored = await Promise.all((await readdir(hub.sourcesDir)).sort().map((name) => readJson(path.join(hub.sourcesDir, name))));
      expect(stored.map((source) => [source.id, source.kind])).toEqual([
        ['feeds-folder', 'folder'], ['gone-notes', 'file'], ['invented-blog', 'rss'], ['invented-letters', 'rss'], ['invented-weekly', 'email'],
      ]);
      expect(hub.requests('/api/sources/discover').map((entry) => entry.status)).toEqual([200, 200, 200, 200]);
    } finally {
      await site.close();
    }
  });

  test('the Default switch puts a source in the next new feed, which opens on its tab with its settings and says when it first runs', async ({ page, hub }) => {
    await writeSource(hub, { id: 'latent-space', name: 'Latent Space', kind: 'rss', url: 'https://example.com/feed' });
    await writeSource(hub, { id: 'axios', name: 'Axios', kind: 'email', sender: 'news@axios.com' });
    await openSources(page, hub);
    const switchFor = (id, name) => sheet(page).locator(`.feed-source[data-source="${id}"]`).getByRole('switch', { name });
    await expect(switchFor('latent-space', 'Active')).toBeChecked();
    await switchFor('latent-space', 'Default for new feeds').check();
    await expect.poll(async () => (await readJson(path.join(hub.sourcesDir, 'latent-space.json'))).default).toBe(true);

    await page.locator('#feed-new').click();
    await expect(sheet(page).getByRole('heading', { name: 'New feed' })).toBeVisible();
    const form = sheet(page).getByRole('form', { name: 'New feed' });
    await expect(form.getByLabel('Name')).toBeFocused();
    await form.getByLabel('Name').fill('Research');
    await form.getByLabel('Instructions').fill('Papers on retrieval.');
    await form.getByRole('button', { name: 'Create' }).click();
    await expect(sheet(page).getByRole('heading', { name: 'Settings' })).toBeFocused();
    await expect(sheet(page).locator('.details-name')).toHaveText('Research');
    await expect(gear(page)).toHaveAttribute('aria-expanded', 'true');
    const tabs = page.getByRole('tablist', { name: 'Feeds' });
    await expect(tabs.getByRole('tab', { name: 'Research' })).toHaveAttribute('aria-selected', 'true');
    await expect(page).toHaveURL(`${hub.origin}/feed?f=research`);
    await expect(page.locator('#feed-message')).toHaveText('No posts yet. Scout fills this feed on its next run.');
    const created = await readJson(path.join(hub.feedsDir, 'research', 'feed.json'));
    expect([created.name, created.producer, created.sources]).toEqual(['Research', 'scout', ['latent-space']]);
    expect(await readFile(path.join(hub.feedsDir, 'research', 'note.md'), 'utf8')).toBe('Papers on retrieval.');

    await expect(sheet(page).getByRole('checkbox', { name: 'Latent Space' })).toBeChecked();
    await expect(sheet(page).getByRole('checkbox', { name: 'Axios' })).not.toBeChecked();
  });

  test('Delete refuses while a feed uses the source and names it; an unused source goes', async ({ page, hub }) => {
    await writeSource(hub, { id: 'latent-space', name: 'Latent Space', kind: 'rss', url: 'https://example.com/feed' });
    await writeSource(hub, { id: 'axios', name: 'Axios', kind: 'email', sender: 'news@axios.com' });
    const feedFile = path.join(hub.feedsDir, 'news', 'feed.json');
    await writeFile(feedFile, JSON.stringify({ ...(await readJson(feedFile)), sources: ['latent-space'] }));
    await openSources(page, hub);
    const row = (id) => sheet(page).locator(`.feed-source[data-source="${id}"]`);
    await row('latent-space').getByRole('button', { name: 'Delete' }).click();
    await expect(row('latent-space').locator('.feed-settings-status')).toHaveText('News uses this source. Uncheck it in that feed first.');
    await row('axios').getByRole('button', { name: 'Delete' }).click();
    await expect(row('axios')).toHaveCount(0);
    expect((await readdir(hub.sourcesDir)).sort()).toEqual(['latent-space.json']);
    await sheet(page).getByRole('button', { name: 'Back to settings' }).click();
    await expect(sheet(page).getByRole('heading', { name: 'Instructions' })).toBeVisible();
    await expect(sheet(page).getByRole('heading', { name: 'Settings' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(sheet(page)).toBeHidden();
    await expect(gear(page)).toBeFocused();
  });

  test('on a phone the sheet covers the posts without horizontal scroll', async ({ page, hub }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openSettings(page, hub);
    const box = await sheet(page).boundingBox();
    expect(Math.round(box.x)).toBe(0);
    expect(Math.round(box.width)).toBe(390);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBe(0);
    await sheet(page).getByRole('button', { name: 'Close settings' }).click();
    await expect(sheet(page)).toBeHidden();
  });

  test('Suggested lists the picks not on the feed with their reasons; Add puts one on the feed and it leaves the list', async ({ page, hub }) => {
    await writeSource(hub, { id: 'latent-space', name: 'Latent Space', kind: 'rss', url: 'https://example.com/feed' });
    await writeSource(hub, { id: 'priorities', name: 'Priorities', kind: 'file', path: hub.instructionsFile });
    await writeSource(hub, { id: 'garden', name: 'Garden', kind: 'rss', url: 'https://example.com/garden' });
    const feedFile = path.join(hub.feedsDir, 'news', 'feed.json');
    await writeFile(feedFile, JSON.stringify({ ...(await readJson(feedFile)), sources: ['garden'] }));
    await writeSuggestions(hub, 'news', [
      { id: 'latent-space', why: 'It covers the field the instructions name.' },
      { id: 'garden', why: 'Already on the feed.' },
      { id: 'priorities', why: 'It says what matters this year.' },
    ]);
    await openSettings(page, hub);
    const suggested = sheet(page).getByRole('list', { name: 'Suggested' });
    const rows = suggested.locator('.feed-suggested-source');
    await expect(rows.locator('.feed-source-name')).toHaveText(['Latent Space', 'Priorities']);
    await expect(rows.locator('.feed-source-kind')).toHaveText(['RSS', 'File']);
    await expect(rows.locator('.feed-suggested-why')).toHaveText(['It covers the field the instructions name.', 'It says what matters this year.']);

    await suggested.getByRole('button', { name: 'Add Latent Space' }).click();
    await expect(rows.locator('.feed-source-name')).toHaveText(['Priorities']);
    await expect(suggested.getByRole('button', { name: 'Add Priorities' })).toBeFocused();
    await expect.poll(async () => (await readJson(feedFile)).sources).toEqual(['garden', 'latent-space']);
    await expect(sheet(page).locator('.feed-settings-sources').getByRole('checkbox', { name: 'Latent Space' })).toBeChecked();

    // A checkbox does the same as Add.
    await sheet(page).locator('.feed-settings-sources').getByRole('checkbox', { name: 'Priorities' }).check();
    await expect(rows).toHaveCount(0);
    await expect(sheet(page).locator('.feed-suggested-status')).toHaveText('No other sources fit this feed.');
    await expect.poll(async () => (await readJson(feedFile)).sources).toEqual(['garden', 'latent-space', 'priorities']);
  });

  test('Suggest runs Scout again: the old picks go, a sentence says it is looking, and the new picks appear when it ends', async ({ page, hub }) => {
    await writeSource(hub, { id: 'latent-space', name: 'Latent Space', kind: 'rss', url: 'https://example.com/feed' });
    await writeSource(hub, { id: 'garden', name: 'Garden', kind: 'rss', url: 'https://example.com/garden' });
    await writeSuggestions(hub, 'news', [{ id: 'garden', why: 'An old pick.' }]);
    await openSettings(page, hub);
    const block = sheet(page).locator('.feed-suggested');
    await expect(block.locator('.feed-source-name')).toHaveText(['Garden']);

    hub.personas.hold('scout');
    await block.getByRole('button', { name: 'Suggest' }).click();
    await expect(block.locator('.feed-suggested-status')).toHaveText('Scout is looking for sources that fit this feed.');
    await expect(block.getByRole('button', { name: 'Suggest' })).toBeDisabled();
    await expect(block.locator('.feed-suggested-source')).toHaveCount(0);
    await expect.poll(() => hub.personas.sent.length).toBe(1);
    expect(hub.personas.sent[0]).toMatchObject({ id: 'scout', context: { routine: { name: 'Suggest sources' } } });
    await expect(readFile(path.join(hub.feedsDir, 'news', 'suggestions.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    // Reopened while the run is out, the sheet still says so.
    await page.keyboard.press('Escape');
    await gear(page).click();
    await expect(block.locator('.feed-suggested-status')).toHaveText('Scout is looking for sources that fit this feed.');

    await writeSuggestions(hub, 'news', [{ id: 'latent-space', why: 'A new pick.' }]);
    await hub.personas.reply('scout', 'Suggested one source.');
    await expect(block.locator('.feed-source-name')).toHaveText(['Latent Space']);
    await expect(block.locator('.feed-suggested-status')).toBeHidden();
    await expect(block.getByRole('button', { name: 'Suggest' })).toBeEnabled();
  });

  test('a new feed opens its settings while Scout looks, and the picks appear there', async ({ page, hub }) => {
    await writeSource(hub, { id: 'latent-space', name: 'Latent Space', kind: 'rss', url: 'https://example.com/feed' });
    await page.goto(`${hub.origin}/feed`);
    await expectView(page, 'feed', 'Feed');
    hub.personas.hold('scout');
    await page.locator('#feed-new').click();
    const form = sheet(page).getByRole('form', { name: 'New feed' });
    await form.getByLabel('Name').fill('Garden');
    await form.getByLabel('Instructions').fill('Stories about the garden.');
    await form.getByRole('button', { name: 'Create' }).click();
    await expect(sheet(page).locator('.details-name')).toHaveText('Garden');
    const block = sheet(page).locator('.feed-suggested');
    await expect(block.locator('.feed-suggested-status')).toHaveText('Scout is looking for sources that fit this feed.');
    await writeSuggestions(hub, 'garden', [{ id: 'latent-space', why: 'It writes about gardens.' }]);
    await hub.personas.reply('scout', 'Suggested one source.');
    await expect(block.locator('.feed-suggested-why')).toHaveText(['It writes about gardens.']);
  });
});
