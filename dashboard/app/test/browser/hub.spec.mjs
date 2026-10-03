// Shell behavior in real browsers against invented data: an isolated Focus
// copy with a synthetic board and invented brief viewers in a temporary
// directory. See test/support/browser-server.mjs.

import { expect, expectView, nav, needsFocus, test } from '../support/browser-test.mjs';

const DATE = '2026-09-15';
const NEXT_DATE = '2026-09-16';

async function frameOf(page, selector) {
  const handle = await page.locator(selector).elementHandle();
  return handle.contentFrame();
}

async function focusBoardReady(page) {
  await expect(page.frameLocator('#focus-frame').locator('#add')).toBeVisible();
}

async function briefReady(page, heading = `Daily Brief — ${DATE}`) {
  await expect(page.frameLocator('#brief-frame').locator('h1')).toHaveText(heading);
}

function markButton(page, id, label) {
  return page.frameLocator('#brief-frame').locator(`.item[data-id="${id}"]`).getByRole('button', { name: label });
}

// The Reading rail link lands on the Feed tab by default; these tests are
// about the Brief tab, so they follow it with a click on the Brief tab.
function briefTab(page) {
  return page.getByRole('navigation', { name: 'Reading' }).getByRole('link', { name: 'Brief' });
}

test('deep links, links, Back and Forward, and reload show the right view', async ({ page, hub }) => {
  needsFocus();
  await hub.writeBrief(DATE);

  await page.goto(`${hub.origin}/focus`);
  await expectView(page, 'focus', 'Focus');
  await focusBoardReady(page);

  await page.goto(`${hub.origin}/brief`);
  await expectView(page, 'reading', 'Reading');
  await briefReady(page);

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
  await expect(page).toHaveURL(`${hub.origin}/brief`);
  await expectView(page, 'reading', 'Reading');
  await page.goForward();
  await expect(page).toHaveURL(`${hub.origin}/`);
  await expectView(page, 'agents', 'Agents');
  await page.goForward();
  await expectView(page, 'focus', 'Focus');

  await page.reload();
  await expectView(page, 'focus', 'Focus');
  await focusBoardReady(page);
  await nav(page, 'Reading').click();
  await page.reload();
  await expectView(page, 'reading', 'Feed');
});

test('frames are created once and kept, hidden, across navigation', async ({ page, hub }) => {
  needsFocus();
  await hub.writeBrief(DATE);

  await page.goto(`${hub.origin}/`);
  await expect(page.locator('iframe')).toHaveCount(0);
  await nav(page, 'Focus').click();
  await focusBoardReady(page);
  const focusFrame = await frameOf(page, '#focus-frame');
  await focusFrame.evaluate(() => { window.dashboardMarker = 'focus-kept'; });

  await nav(page, 'Reading').click();
  await briefTab(page).click();
  await briefReady(page);
  const briefFrame = await frameOf(page, '#brief-frame');
  await briefFrame.evaluate(() => { window.dashboardMarker = 'brief-kept'; });
  await expect(page.locator('#focus-frame')).toBeHidden();

  await nav(page, 'Home').click();
  await expect(page.locator('#focus-frame')).toBeHidden();
  await expect(page.locator('#brief-frame')).toBeHidden();
  await nav(page, 'Focus').click();
  await page.goBack();
  await page.goBack();
  await expectView(page, 'reading', 'Reading');
  await nav(page, 'Focus').click();

  await expect(page.locator('iframe')).toHaveCount(2);
  expect(await (await frameOf(page, '#focus-frame')).evaluate(() => window.dashboardMarker)).toBe('focus-kept');
  expect(await (await frameOf(page, '#brief-frame')).evaluate(() => window.dashboardMarker)).toBe('brief-kept');

  // Keyboard focus never reaches a hidden view.
  await expect(page.locator('#view-reading')).toBeHidden();
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

    await page.goto(`${hub.secureOrigin}/brief`);
    expect(new URL(page.url()).protocol).toBe('https:');
    await briefReady(page);
    await markButton(page, 'invented-one', 'Approve').click();
    await markButton(page, 'invented-three', 'Dismiss').click();
    const viewer = page.frameLocator('#brief-frame');
    await viewer.locator('#overall').fill('Invented overall note.');
    await viewer.getByRole('button', { name: 'Save feedback' }).click();
    await expect(viewer.locator('#status')).toHaveText('Saved');

    expect(await hub.readFeedback(DATE)).toBe([
      `# Brief feedback — ${DATE}`,
      '',
      '## Overall',
      '',
      'Invented overall note.',
      '',
      '## Needs you',
      '',
      '- APPROVED — Invented item one.',
      '- no mark — Invented item two.',
      '## Later',
      '',
      '- DISMISSED — Invented item three.',
      '',
    ].join('\n'));
    expect(downloads).toEqual([]);
  });
});

test('marks survive navigation and reload through the viewer storage key', async ({ page, hub }) => {
  await hub.writeBrief(DATE);
  await page.goto(`${hub.origin}/brief`);
  await briefReady(page);
  await markButton(page, 'invented-two', 'Dismiss').click();
  const viewer = page.frameLocator('#brief-frame');
  await viewer.locator('#overall').fill('Unsaved invented draft.');

  await nav(page, 'Home').click();
  await nav(page, 'Reading').click();
  await briefTab(page).click();
  await expect(markButton(page, 'invented-two', 'Dismiss')).toHaveAttribute('aria-pressed', 'true');
  await expect(viewer.locator('#overall')).toHaveValue('Unsaved invented draft.');

  await page.reload();
  await briefReady(page);
  await expect(markButton(page, 'invented-two', 'Dismiss')).toHaveAttribute('aria-pressed', 'true');
  const stored = await (await frameOf(page, '#brief-frame')).evaluate((key) => localStorage.getItem(key), `db-items-${DATE}`);
  expect(JSON.parse(stored)).toEqual({ 'invented-two': { m: 'd' } });
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

  await nav(page, 'Reading').click();
  await briefTab(page).click();
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
    await nav(page, 'Reading').click();
    await briefTab(page).click();
    await briefReady(page);
  });
});

test('a newer brief is offered, and the open one stays until it is loaded', async ({ page, hub }) => {
  await hub.writeBrief(DATE);
  await page.goto(`${hub.origin}/brief`);
  await briefReady(page);
  await (await frameOf(page, '#brief-frame')).evaluate(() => { window.dashboardMarker = 'old-brief'; });
  await expect(page.locator('#brief-newer')).toBeHidden();

  await hub.writeBrief(NEXT_DATE);
  await nav(page, 'Home').click();
  await expect.poll(async () => (await (await page.request.get(`${hub.origin}/api/state`)).json()).brief.date).toBe(NEXT_DATE);
  await nav(page, 'Reading').click();
  await briefTab(page).click();
  const newer = page.locator('#brief-newer');
  await expect(newer).toContainText('A newer brief is available.');
  await briefReady(page);
  expect(await (await frameOf(page, '#brief-frame')).evaluate(() => window.dashboardMarker)).toBe('old-brief');

  await newer.getByRole('button', { name: 'Load newer brief' }).click();
  await briefReady(page, `Daily Brief — ${NEXT_DATE}`);
  await expect(newer).toBeHidden();
  await expect(page.locator('iframe#brief-frame')).toHaveCount(1);
});

test('a same-date replacement refuses the stale save and keeps the draft', async ({ page, hub }) => {
  await hub.writeBrief(DATE);
  await page.goto(`${hub.origin}/brief`);
  await briefReady(page);
  await markButton(page, 'invented-one', 'Approve').click();

  const revised = `Daily Brief — ${DATE} (revised)`;
  await hub.writeBrief(DATE, { heading: revised });
  const viewer = page.frameLocator('#brief-frame');
  const response = page.waitForResponse((r) => r.url().endsWith('/api/brief/feedback'));
  await viewer.getByRole('button', { name: 'Save feedback' }).click();
  expect((await response).status()).toBe(409);
  await expect(viewer.locator('#status')).toHaveText('Save failed: a newer brief is available. Load it from the dashboard, then save again.');
  await expect(markButton(page, 'invented-one', 'Approve')).toHaveAttribute('aria-pressed', 'true');
  await expect(hub.readFeedback(DATE)).rejects.toThrow();

  await nav(page, 'Home').click();
  await nav(page, 'Reading').click();
  await briefTab(page).click();
  await page.locator('#brief-newer').getByRole('button', { name: 'Load newer brief' }).click();
  await briefReady(page, revised);
  await expect(markButton(page, 'invented-one', 'Approve')).toHaveAttribute('aria-pressed', 'true');
});

// Records any embedded brief page that was not served as HTML.
function watchBriefPages(page) {
  const refused = [];
  page.on('response', (response) => {
    if (response.url().includes('/embedded/brief/') && response.status() !== 200) refused.push(response.status());
  });
  return refused;
}

test('a brief replaced before its view opens is mounted from fresh status', async ({ page, hub }) => {
  await hub.writeBrief(DATE);
  await page.goto(`${hub.origin}/`);
  await expectView(page, 'agents', 'Agents');
  await expect.poll(() => hub.state.clientCount()).toBe(1);
  const refused = watchBriefPages(page);

  const revised = `Daily Brief — ${DATE} (revised)`;
  await hub.writeBrief(DATE, { heading: revised });
  await nav(page, 'Reading').click();
  await briefTab(page).click();
  await briefReady(page, revised);
  await expect(page.locator('#brief-frame')).toBeVisible();
  expect(refused).toEqual([]);
});

test('a same-date replacement of a mounted brief is offered and never shown as an error', async ({ page, hub }) => {
  await hub.writeBrief(DATE);
  await page.goto(`${hub.origin}/brief`);
  await briefReady(page);
  const refused = watchBriefPages(page);

  await hub.writeBrief(DATE, { heading: `Daily Brief — ${DATE} (revised)` });
  await nav(page, 'Home').click();
  await nav(page, 'Reading').click();
  await briefTab(page).click();
  const newer = page.locator('#brief-newer');
  await expect(newer).toContainText('A newer brief is available.');
  await briefReady(page);

  // Replaced again after the offer appeared: the button reads the status
  // afresh and loads the file as it is now.
  const again = `Daily Brief — ${DATE} (revised again)`;
  await hub.writeBrief(DATE, { heading: again });
  await newer.getByRole('button', { name: 'Load newer brief' }).click();
  await briefReady(page, again);
  await expect(page.locator('#brief-frame')).toBeVisible();
  await expect(newer).toBeHidden();
  await expect(page.locator('#brief-notice')).toBeHidden();
  expect(refused).toEqual([]);
});

test('a brief page that fails to load is hidden, and Retry loads it', async ({ page, hub }) => {
  await hub.writeBrief(DATE);
  let refuse = true;
  await page.route('**/embedded/brief/**', (route) => {
    if (!refuse) return route.continue();
    refuse = false;
    return route.fulfill({ status: 409, contentType: 'application/json', body: '{"error":"revision_conflict"}' });
  });
  await page.goto(`${hub.origin}/brief`);
  const notice = page.locator('#brief-notice');
  await expect(notice).toContainText(`The brief for ${DATE} could not be opened.`);
  await expect(page.locator('#brief-frame')).toHaveAttribute('data-failed', '');
  await expect(page.locator('#brief-frame')).toBeHidden();

  await notice.getByRole('button', { name: 'Retry' }).click();
  await briefReady(page);
  await expect(page.locator('#brief-frame')).toBeVisible();
  await expect(notice).toBeHidden();
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

test('brief states other than ready read plainly and leave Focus usable', async ({ page, hub }) => {
  needsFocus();
  await page.goto(`${hub.origin}/brief`);
  const notice = page.locator('#brief-notice');
  await expect(notice).toContainText('No brief has been generated yet.');
  await expect(page.locator('#brief-frame')).toHaveCount(0);

  await nav(page, 'Focus').click();
  await focusBoardReady(page);

  await hub.writeRawBrief(DATE, '<!doctype html><html><body>Invented, unsupported.</body></html>\n');
  await nav(page, 'Reading').click();
  await expect(notice).toContainText(`The brief for ${DATE} could not be opened.`);
});

test('navigation and the brief Save control stay reachable, with one scroll owner', async ({ page, hub }, testInfo) => {
  await hub.writeBrief(DATE);
  await page.goto(`${hub.origin}/brief`);
  await briefReady(page);
  const viewport = page.viewportSize();

  const names = ['Home', 'Reading', 'Focus', 'Goals'];
  for (const name of names) {
    const link = nav(page, name);
    await expect(link).toBeInViewport();
    await link.click({ trial: true });
  }
  const tops = await Promise.all(names.map(async (name) => (await nav(page, name).boundingBox()).y));
  if (testInfo.project.name === 'mobile-webkit') expect(new Set(tops).size).toBe(1);
  else expect(tops[1]).toBeGreaterThan(tops[0]);

  const save = page.frameLocator('#brief-frame').getByRole('button', { name: 'Save feedback' });
  await save.click({ trial: true });
  const box = await save.boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);

  // The child page is taller than the viewport; only the frame scrolls.
  const childHeight = await (await frameOf(page, '#brief-frame')).evaluate(() => document.documentElement.scrollHeight);
  expect(childHeight).toBeGreaterThan(viewport.height);
  const shell = await page.evaluate(() => ({
    scrollHeight: document.documentElement.scrollHeight,
    scrollWidth: document.documentElement.scrollWidth,
    innerHeight: window.innerHeight,
    innerWidth: window.innerWidth,
  }));
  expect(shell.scrollHeight).toBe(shell.innerHeight);
  expect(shell.scrollWidth).toBeLessThanOrEqual(shell.innerWidth);
});
