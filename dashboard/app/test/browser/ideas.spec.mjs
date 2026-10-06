// Ideas against the isolated fixture store: weekly rendering, actions,
// quick-chat context, criteria, and the six-entry rail. Every idea and agent
// here is invented for the browser suite.

import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, expectView, nav, test } from '../support/browser-test.mjs';

const IDEAS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'ideas');
const persona = (fields) => ({
  description: 'Invented.', group: 'personal', kind: 'persona', cwd: '/invented', provider: 'claude', ...fields,
});
const AGENTS = [
  persona({ id: 'assistant', name: 'Assistant', role: 'Assistant', pinned: true }),
  persona({ id: 'myos', name: 'Myos', role: 'Guide', builtin: true }),
  persona({ id: 'focus', name: 'Focus', role: 'Attention' }),
];

const item = (page, id) => page.locator(`[data-ideas-item="${id}"]`);
const weeks = (page) => page.locator('#ideas-weeks .ideas-week');
const pane = (page) => page.locator('#quick-chat');
const paneInput = (page) => page.locator('#quick-chat-input');
const messages = (page) => page.locator('#agent-messages .thread-message');

async function openIdeaMenu(page, id) {
  const row = item(page, id);
  await row.getByRole('button', { name: 'More' }).click();
  return row.locator('.ideas-menu');
}

async function openIdeas(page, hub) {
  await page.goto(`${hub.origin}/ideas`);
  await expectView(page, 'ideas', 'Ideas');
  await expect(weeks(page)).toHaveCount(2);
}

// The Monday-start week that holds today, as the view heads it ("Week of
// October 5"); a manual idea always lands in this week.
function thisMonday() {
  const day = new Date();
  day.setHours(12, 0, 0, 0);
  day.setDate(day.getDate() - ((day.getDay() + 6) % 7));
  return day.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
}

test.describe('Ideas', () => {
  test.use({ withFocus: false, hubOptions: { ideas: IDEAS, agents: AGENTS } });

  test('the rail, route, header actions, and phone tab bar hold all six views', async ({ page, hub }) => {
    await openIdeas(page, hub);
    const links = page.getByRole('navigation', { name: 'Dashboard' }).getByRole('link');
    await expect(links).toHaveCount(6);
    await expect(links).toHaveText(['Home', 'Feed', 'Focus', 'Goals', 'Ideas', 'Health']);
    await expect(page.locator('#app-header-title')).toHaveText('Ideas');
    const actions = page.locator('[data-actions-for="ideas"]');
    await expect(actions.getByRole('button')).toHaveText(['', 'New ideas', 'Add idea']);
    await expect(actions.getByRole('button', { name: 'Instructions' })).toBeVisible();
    await expect(actions.getByRole('button', { name: 'Add idea' })).toBeVisible();

    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await expectView(page, 'ideas', 'Ideas');
    await expect(links).toHaveCount(6);
    const boxes = await links.evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().toJSON()));
    expect(boxes[0].left).toBeGreaterThanOrEqual(0);
    expect(boxes.at(-1).right).toBeLessThanOrEqual(390);
    for (let i = 1; i < boxes.length; i += 1) expect(boxes[i].left).toBeGreaterThanOrEqual(boxes[i - 1].right);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBe(0);
  });

  test('groups runs into newest-first weeks with kind icons and agent names', async ({ page, hub }) => {
    await openIdeas(page, hub);
    await expect(weeks(page).locator('.ideas-week-title')).toHaveText(['Week of September 28', 'Week of September 21']);
    await expect(weeks(page).first().locator('.ideas-item')).toHaveCount(1);
    await expect(weeks(page).nth(1).locator('.ideas-item')).toHaveCount(2);
    await expect(item(page, 'fixture-agent-card').locator('.ideas-title')).toHaveText('Fixture agent card');
    await expect(item(page, 'fixture-agent-card').locator('.ideas-text')).toHaveText('Invented fixture content for a newer run.');
    await expect(item(page, 'fixture-agent-card').getByRole('img', { name: 'View' })).toBeVisible();
    await expect(item(page, 'fixture-weekly-map').getByRole('img', { name: 'Workflow' })).toBeVisible();
    await expect(item(page, 'fixture-agent-card').locator('.ideas-meta')).toHaveText('Assistant');
    await expect(item(page, 'fixture-weekly-map').locator('.ideas-meta')).toHaveText('Assistant · Focus');
    const source = item(page, 'fixture-reading-tool').getByRole('link', { name: 'Source' });
    await expect(source).toHaveAttribute('href', 'https://example.com/fixture-reading-tool');
    await expect(source).toHaveAttribute('target', '_blank');
    await expect(page.locator('#ideas-message')).toHaveText('No routine writes ideas.');
    await expect(page.locator('#view-ideas [data-action]')).toHaveCount(0);
  });

  test('Dismiss removes the idea and a later run cannot bring its id back', async ({ page, hub }) => {
    await openIdeas(page, hub);
    const menu = await openIdeaMenu(page, 'fixture-weekly-map');
    await menu.getByRole('button', { name: 'Dismiss' }).click();
    await expect(item(page, 'fixture-weekly-map')).toHaveCount(0);
    await writeFile(path.join(hub.ideasDir, '2026-10-05-myos.json'), JSON.stringify({
      producer: 'myos', date: '2026-10-05', generated_at: '2026-10-05T09:00:00-05:00', items: [{
        id: 'fixture-weekly-map', title: 'Fixture weekly map again', text: 'Invented later duplicate.',
        kind: 'workflow', agents: ['assistant'], source: null,
      }],
    }));
    await page.reload();
    await expectView(page, 'ideas', 'Ideas');
    await expect(item(page, 'fixture-weekly-map')).toHaveCount(0);
    const marks = await page.evaluate(() => fetch('/api/ideas').then((response) => response.json()));
    expect(marks.runs.some((run) => run.items.some((idea) => idea.id === 'fixture-weekly-map'))).toBe(false);
  });

  test('Start opens the pinned agent with context, marks the idea, and busy leaves another new', async ({ page, hub }) => {
    hub.personas.hold('assistant');
    await openIdeas(page, hub);
    let menu = await openIdeaMenu(page, 'fixture-agent-card');
    await menu.getByRole('button', { name: 'Start' }).click();
    await expectView(page, 'agents', 'Agents');
    await expect(page).toHaveURL(`${hub.origin}/?agent=assistant`);
    await expect(page.locator('#agent-messages .thread-message-context summary'))
      .toHaveText('Sent from Ideas: Fixture agent card');
    expect(hub.personas.sent[0].context.context).toEqual({
      view: 'ideas', label: 'Fixture agent card', detail: 'Invented fixture content for a newer run.',
    });

    await nav(page, 'Ideas').click();
    await expectView(page, 'ideas', 'Ideas');
    menu = await openIdeaMenu(page, 'fixture-agent-card');
    await expect(item(page, 'fixture-agent-card').getByRole('link', { name: 'Started with Assistant' })).toBeVisible();
    const next = item(page, 'fixture-reading-tool');
    await openIdeaMenu(page, 'fixture-reading-tool');
    await next.getByRole('button', { name: 'Start' }).click();
    await expect(next.locator('.ideas-reason')).toHaveText('Assistant is in the middle of a turn. Try again when it is idle.');
    await openIdeaMenu(page, 'fixture-reading-tool');
    await expect(next.getByRole('button', { name: 'Start' })).toBeVisible();
    await expect(page).toHaveURL(`${hub.origin}/ideas`);
    expect(hub.requests('/api/ideas/start').map((entry) => entry.status)).toEqual([202, 409]);
  });

  test('Add idea keeps Hunter\'s text and shows it in this week at once', async ({ page, hub }) => {
    await openIdeas(page, hub);
    await page.getByRole('button', { name: 'Add idea' }).click();
    const form = page.locator('#ideas-add-form');
    await expect(form).toBeVisible();
    const text = 'Fixture manual idea\n  Keep this line exactly.\nAnd **this** one.';
    await form.getByLabel('Idea').fill(text);
    await form.getByRole('button', { name: 'Send' }).click();
    await expect(form).toBeHidden();
    const added = item(page, 'fixture-manual-idea');
    await expect(added).toBeVisible();
    await expect(weeks(page).first().locator('.ideas-week-title')).toHaveText(`Week of ${thisMonday()}`);
    await expect(added.locator('.ideas-title')).toHaveText('Fixture manual idea');
    await expect(added.locator('.ideas-text')).toContainText('Keep this line exactly.');
    await expect(added.locator('.ideas-text')).toContainText('And this one.');
    await expect(added.locator('.ideas-text strong')).toHaveText('this');
    const stored = await page.evaluate(() => fetch('/api/ideas').then((response) => response.json()));
    const manual = stored.runs.flatMap((run) => run.items).find((idea) => idea.id === 'fixture-manual-idea');
    expect(manual.text).toBe('  Keep this line exactly.\nAnd **this** one.');
  });

  test('Discuss opens quick chat without a turn and sends context only with the first message', async ({ page, hub }) => {
    await openIdeas(page, hub);
    const menu = await openIdeaMenu(page, 'fixture-reading-tool');
    await menu.getByRole('button', { name: 'Discuss' }).click();
    await expect(pane(page)).toBeVisible();
    expect(hub.personas.sent).toEqual([]);

    await paneInput(page).fill('Tell me more.');
    await pane(page).getByRole('button', { name: 'Send', exact: true }).click();
    const contexts = page.locator('#quick-chat-messages .thread-message-context');
    await expect(contexts).toHaveCount(1);
    await expect(contexts.locator('summary')).toHaveText('Sent from Ideas: Fixture reading tool');
    expect(hub.personas.sent[0].context.context).toEqual({
      view: 'ideas', label: 'Fixture reading tool',
      detail: 'Kind: tool\nAgents: Myos\nSource: https://example.com/fixture-reading-tool\nInvented fixture content with an outside source.',
    });

    await paneInput(page).fill('And then?');
    await pane(page).getByRole('button', { name: 'Send', exact: true }).click();
    await expect(contexts).toHaveCount(1);
    expect(hub.personas.sent[1].context.context).toBeUndefined();
  });

  test('the row menu lists its actions and closes on Escape', async ({ page, hub }) => {
    await openIdeas(page, hub);
    const row = item(page, 'fixture-agent-card');
    const menu = await openIdeaMenu(page, 'fixture-agent-card');
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('button')).toHaveText(['Discuss', 'Start', 'Dismiss']);
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await expect(row.getByRole('button', { name: 'More' })).toBeFocused();
  });

  test('the bookmark saves and unsaves the row, and Start on a saved idea still works', async ({ page, hub }) => {
    await openIdeas(page, hub);
    const row = item(page, 'fixture-agent-card');
    const bookmark = row.locator('.ideas-save-toggle');
    await expect(bookmark).toHaveAttribute('aria-label', 'Save');
    await expect(bookmark).toHaveAttribute('title', 'Save');
    await expect(bookmark).toHaveAttribute('aria-pressed', 'false');
    const box = await bookmark.boundingBox();
    const more = await row.getByRole('button', { name: 'More' }).boundingBox();
    expect([box.width, box.height]).toEqual([44, 44]);
    expect(box.x + box.width).toBeLessThanOrEqual(more.x);
    expect(await bookmark.evaluate((node) => getComputedStyle(node.querySelector('svg path')).fill)).toBe('none');

    await bookmark.click();
    await expect(bookmark).toHaveAttribute('aria-pressed', 'true');
    await expect(bookmark).toHaveAttribute('aria-label', 'Unsave');
    await expect(bookmark).toHaveAttribute('title', 'Unsave');
    expect(await bookmark.evaluate((node) => getComputedStyle(node.querySelector('svg path')).fill)).not.toBe('none');
    await expect(row).toHaveAttribute('aria-expanded', 'false');
    await bookmark.click();
    await expect(bookmark).toHaveAttribute('aria-pressed', 'false');
    await expect(bookmark).toHaveAttribute('aria-label', 'Save');
    await expect(row).toHaveAttribute('aria-expanded', 'false');
    await bookmark.click();
    await expect(bookmark).toHaveAttribute('aria-pressed', 'true');

    const menu = await openIdeaMenu(page, 'fixture-agent-card');
    await menu.getByRole('button', { name: 'Start' }).click();
    await expectView(page, 'agents', 'Agents');
    await nav(page, 'Ideas').click();
    await expectView(page, 'ideas', 'Ideas');
    await expect(row.locator('.ideas-started')).toHaveCount(1);
    await expect(bookmark).toHaveCount(0);
    await openIdeaMenu(page, 'fixture-agent-card');
    await expect(row.getByRole('link', { name: 'Started with Assistant' })).toBeVisible();
    await expect(row.locator('.ideas-menu').getByRole('button')).toHaveText(['Discuss', 'Dismiss']);
    expect(hub.requests('/api/ideas/save').map((entry) => entry.status)).toEqual([200, 200]);
    expect(hub.requests('/api/ideas/unsave').map((entry) => entry.status)).toEqual([200]);
    expect(hub.requests('/api/ideas/start').map((entry) => entry.status)).toEqual([202]);
  });

  test('the bookmark keeps keyboard focus across a save and an unsave', async ({ page, hub }) => {
    await openIdeas(page, hub);
    const bookmark = item(page, 'fixture-agent-card').locator('.ideas-save-toggle');
    await bookmark.focus();
    await page.keyboard.press('Enter');
    await expect(bookmark).toHaveAttribute('aria-pressed', 'true');
    await expect(bookmark).toBeFocused();
    await page.keyboard.press('Space');
    await expect(bookmark).toHaveAttribute('aria-pressed', 'false');
    await expect(bookmark).toBeFocused();
    await expect(item(page, 'fixture-agent-card')).toHaveAttribute('aria-expanded', 'false');
  });

  test('a refused save shows its sentence on the row', async ({ page, hub }) => {
    await page.route('**/api/ideas/save', (route) => route.fulfill({ status: 404, json: { error: 'no_such_item' } }));
    await openIdeas(page, hub);
    const row = item(page, 'fixture-agent-card');
    await row.locator('.ideas-save-toggle').click();
    await expect(row.locator('.ideas-reason')).toHaveText('That idea is no longer available.');
    await expect(row.locator('.ideas-save-toggle')).toHaveAttribute('aria-pressed', 'false');
    await expect(row.locator('.ideas-save-toggle')).toBeEnabled();
  });

  test('a saved row keeps its bookmark shown at rest, and a new row shows it on hover', async ({ page, hub }) => {
    await openIdeas(page, hub);
    await item(page, 'fixture-agent-card').locator('.ideas-save-toggle').click();
    await expect(item(page, 'fixture-agent-card').locator('.ideas-save-toggle')).toHaveAttribute('aria-pressed', 'true');
    await page.mouse.move(0, 0);
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    const opacity = (id) => item(page, id).locator('.ideas-save-toggle').evaluate((node) => getComputedStyle(node).opacity);
    await expect.poll(() => opacity('fixture-agent-card')).toBe('1');
    if (page.viewportSize().width >= 720) {
      await expect.poll(() => opacity('fixture-reading-tool')).toBe('0');
      await item(page, 'fixture-reading-tool').hover();
      await expect.poll(() => opacity('fixture-reading-tool')).toBe('1');
      await page.setViewportSize({ width: 390, height: 844 });
      await page.mouse.move(0, 0);
    }
    await expect.poll(() => opacity('fixture-weekly-map')).toBe('1');
  });

  test('older weeks fade under a mask on the page, never on a row', async ({ page, hub }) => {
    await openIdeas(page, hub);
    const masks = await page.evaluate(() => {
      const of = (node) => { const style = getComputedStyle(node); return style.maskImage || style.webkitMaskImage; };
      return {
        page: of(document.getElementById('ideas-page')),
        feed: of(document.getElementById('feed-page')),
        items: [...document.querySelectorAll('.ideas-item, .ideas-week')].map(of),
      };
    });
    expect(masks.page).toContain('linear-gradient');
    expect(masks.feed).toBe('none');
    expect(masks.items.every((value) => value === 'none')).toBe(true);
  });

  test('clicking a row expands and collapses its text', async ({ page, hub }) => {
    await openIdeas(page, hub);
    const row = item(page, 'fixture-agent-card');
    await expect(row).toHaveAttribute('aria-expanded', 'false');
    await row.locator('.ideas-title').click();
    await expect(row).toHaveAttribute('aria-expanded', 'true');
    await expect(row).toHaveClass(/ideas-item-expanded/);
    await row.locator('.ideas-title').click();
    await expect(row).toHaveAttribute('aria-expanded', 'false');
  });

  test('Instructions shows the criteria and a change opens the producing agent', async ({ page, hub }) => {
    await openIdeas(page, hub);
    const toggle = page.getByRole('button', { name: 'Instructions' });
    await toggle.click();
    const panel = page.locator('#ideas-instructions');
    await expect(panel).toBeVisible();
    await expect(panel.getByRole('heading', { name: 'Ideas instructions' })).toBeVisible();
    await expect(panel.locator('.instructions-intro'))
      .toHaveText('Ideas follow these criteria. A change goes to the producer, which edits the file.');
    await expect(panel.locator('.goal-prose h4')).toHaveText('Fixture criteria');
    await expect(panel.locator('.goal-prose p')).toHaveText('This invented fixture file describes ideas used only by the automated tests.');
    await panel.getByLabel('What should change?').fill('Prefer smaller fixture ideas.');
    await panel.getByRole('button', { name: 'Send' }).click();
    await expectView(page, 'agents', 'Agents');
    await expect(page).toHaveURL(`${hub.origin}/?agent=myos`);
    await expect(messages(page).first()).toContainText('Change the Ideas criteria.');
    expect(hub.personas.sent[0].id).toBe('myos');
  });
});

const IDEAS_ROUTINE = Object.freeze({
  id: 'myos-weekly-ideas', name: 'Weekly ideas', agent: 'myos', instruction: 'Run the weekly-ideas skill.', cron: '0 4 * * 1',
});

test.describe('New ideas', () => {
  test.use({
    withFocus: false,
    hubOptions: {
      ideas: IDEAS, agents: AGENTS,
      routines: [{ id: 'assistant-ideas', name: 'Ideas', agent: 'assistant', instruction: 'Write ideas.', cron: '0 4 * * 1' }, IDEAS_ROUTINE],
    },
  });

  test('runs the producer\'s ideas routine and names the producer', async ({ page, hub }) => {
    await openIdeas(page, hub);
    const button = page.locator('#ideas-new');
    await expect(button).toBeEnabled();
    await button.click();
    await expect(page.locator('#ideas-message')).toHaveText('Myos is writing new ideas. They will appear here when it finishes.');
    await expect.poll(() => hub.requests('/api/routines/myos-weekly-ideas/run')).toEqual([{ method: 'POST', status: 202 }]);
    expect(hub.requests('/api/routines/assistant-ideas/run')).toEqual([]);
    await expect.poll(() => hub.personas.sent.length).toBe(1);
    expect(hub.personas.sent[0]).toMatchObject({ id: 'myos', text: 'Run the weekly-ideas skill.' });
  });

  test('a busy producer gives the busy sentence', async ({ page, hub }) => {
    hub.personas.hold('myos');
    await openIdeas(page, hub);
    const button = page.locator('#ideas-new');
    await button.click();
    await expect(page.locator('#ideas-message')).toHaveText('Myos is writing new ideas. They will appear here when it finishes.');
    await button.click();
    await expect(page.locator('#ideas-message')).toHaveText('Myos is in the middle of a turn. Try again when it is idle.');
    expect(hub.requests('/api/routines/myos-weekly-ideas/run')).toEqual([
      { method: 'POST', status: 202 }, { method: 'POST', status: 409 },
    ]);
  });

  test('a manual idea leaves the sentence and a new run clears it', async ({ page, hub }) => {
    await page.clock.install();
    await openIdeas(page, hub);
    const notice = page.locator('#ideas-message');
    await page.locator('#ideas-new').click();
    await expect(notice).toHaveText('Myos is writing new ideas. They will appear here when it finishes.');
    await page.getByRole('button', { name: 'Add idea' }).click();
    const form = page.locator('#ideas-add-form');
    await form.getByLabel('Idea').fill('Fixture manual idea');
    await form.getByRole('button', { name: 'Send' }).click();
    await expect(item(page, 'fixture-manual-idea')).toBeVisible();
    await expect(notice).toHaveText('Myos is writing new ideas. They will appear here when it finishes.');
    const run = {
      fixture: true, producer: 'myos', date: '2026-09-29', generated_at: '2026-09-29T09:00:00-05:00',
      items: [{ id: 'fixture-new-run', title: 'Fixture new run', text: 'Invented.', kind: 'view', agents: [], source: null }],
    };
    await writeFile(path.join(hub.ideasDir, '2026-09-29-myos.json'), JSON.stringify(run));
    await page.clock.runFor(10_000);
    await expect(item(page, 'fixture-new-run')).toBeVisible();
    await expect(notice).toBeHidden();
  });

  test('a routine gone since the last read gives the not running sentence', async ({ page, hub }) => {
    await openIdeas(page, hub);
    await hub.routines.remove(IDEAS_ROUTINE.id);
    await page.locator('#ideas-new').click();
    await expect(page.locator('#ideas-message')).toHaveText('Myos is not running.');
    expect(hub.requests('/api/routines/myos-weekly-ideas/run')).toEqual([{ method: 'POST', status: 404 }]);
  });
});

test.describe('New ideas with the producer not started', () => {
  test.use({
    withFocus: false,
    hubOptions: { ideas: IDEAS, agents: AGENTS, routines: [IDEAS_ROUTINE], personas: { myos: { startFails: true } } },
  });

  test('gives the not running sentence', async ({ page, hub }) => {
    await openIdeas(page, hub);
    await page.locator('#ideas-new').click();
    await expect(page.locator('#ideas-message')).toHaveText('Myos is not running.');
    expect(hub.requests('/api/routines/myos-weekly-ideas/run')).toEqual([{ method: 'POST', status: 409 }]);
  });
});

test.describe('New ideas without a routine', () => {
  test.use({ withFocus: false, hubOptions: { ideas: IDEAS, agents: AGENTS } });

  test('disables the button and says why', async ({ page, hub }) => {
    await openIdeas(page, hub);
    const button = page.locator('#ideas-new');
    await expect(button).toBeDisabled();
    await expect(button).toHaveAttribute('title', 'No routine writes ideas.');
    await expect(page.locator('#ideas-message')).toHaveText('No routine writes ideas.');
    expect(hub.requests('/api/routines/myos-weekly-ideas/run')).toEqual([]);
  });
});

test.describe('Refresh a week', () => {
  test.use({ withFocus: false, hubOptions: { ideas: IDEAS, agents: AGENTS, routines: [IDEAS_ROUTINE] } });
  const refresh = (page, key) => page.locator(`#ideas-weeks .ideas-week[data-ideas-week="${key}"] .ideas-week-refresh`);
  const weekNotice = (page, key) => page.locator(`#ideas-weeks .ideas-week[data-ideas-week="${key}"] .ideas-week-notice`);
  const WRITING = 'Myos is writing new ideas for this week. They will appear here when it finishes.';

  test('the week button retires the week\'s new ideas, keeps the saved one, and runs the routine for that week', async ({ page, hub }) => {
    await writeFile(hub.ideasMarksFile, JSON.stringify({ 'fixture-weekly-map': { status: 'saved', at: '2026-09-22T00:00:00Z' } }));
    hub.personas.hold('myos');
    await page.clock.install();
    await openIdeas(page, hub);
    const button = refresh(page, '2026-09-21');
    await expect(button).toHaveAttribute('aria-label', 'New ideas for this week');
    await expect(button).toHaveAttribute('title', 'New ideas for this week');
    await button.click();
    await expect(weekNotice(page, '2026-09-21')).toHaveText(WRITING);
    await expect(weekNotice(page, '2026-09-21')).toHaveAttribute('role', 'status');
    await expect(item(page, 'fixture-reading-tool')).toHaveCount(0);
    await expect(item(page, 'fixture-weekly-map')).toBeVisible();
    await expect(item(page, 'fixture-agent-card')).toBeVisible();
    await expect(page.locator('#ideas-message')).toBeHidden();
    expect(hub.requests('/api/ideas/refresh')).toEqual([{ method: 'POST', status: 202 }]);
    await expect.poll(() => hub.routines.runs(IDEAS_ROUTINE.id)[0]?.context).toBe(
      'Write this run\'s ideas for the week of September 21 (`week: "2026-09-21"` in the file).\n'
        + 'These ideas of that week are saved and stay; do not repeat them: Fixture weekly map.');
    expect(hub.personas.sent[0].context.prompt).toContain('Run the weekly-ideas skill.\n\nWrite this run\'s ideas for the week of September 21');

    const run = {
      fixture: true, producer: 'myos', date: '2026-10-02', week: '2026-09-21', generated_at: '2026-10-02T09:00:00-05:00',
      items: [{ id: 'fixture-refreshed', title: 'Fixture refreshed', text: 'Invented.', kind: 'view', agents: [], source: null }],
    };
    await writeFile(path.join(hub.ideasDir, '2026-10-02-myos.json'), JSON.stringify(run));
    await page.clock.runFor(10_000);
    await expect(page.locator('#ideas-weeks .ideas-week[data-ideas-week="2026-09-21"] [data-ideas-item="fixture-refreshed"]')).toBeVisible();
    await expect(weekNotice(page, '2026-09-21')).toHaveCount(0);
  });

  test('a week left with no rows keeps its heading and sentence', async ({ page, hub }) => {
    await openIdeas(page, hub);
    await refresh(page, '2026-09-28').click();
    await expect(weekNotice(page, '2026-09-28')).toHaveText(WRITING);
    await expect(item(page, 'fixture-agent-card')).toHaveCount(0);
    await expect(weeks(page).locator('.ideas-week-title')).toHaveText(['Week of September 28', 'Week of September 21']);
  });

  test('a held producer gives the busy sentence and the rows stay', async ({ page, hub }) => {
    hub.personas.hold('myos');
    await openIdeas(page, hub);
    await page.locator('#ideas-new').click();
    await expect(page.locator('#ideas-message')).toHaveText('Myos is writing new ideas. They will appear here when it finishes.');
    await refresh(page, '2026-09-21').click();
    await expect(weekNotice(page, '2026-09-21')).toHaveText('Myos is in the middle of a turn. Try again when it is idle.');
    expect(hub.requests('/api/ideas/refresh')).toEqual([{ method: 'POST', status: 409 }]);
    await expect(item(page, 'fixture-reading-tool')).toBeVisible();
    await expect(item(page, 'fixture-weekly-map')).toBeVisible();
  });

  test('a run file with a week groups under that week', async ({ page, hub }) => {
    await writeFile(path.join(hub.ideasDir, '2026-10-02-myos.json'), JSON.stringify({
      fixture: true, producer: 'myos', date: '2026-10-02', week: '2026-09-21',
      items: [{ id: 'fixture-week-run', title: 'Fixture week run', text: 'Invented.', kind: 'tool', agents: [], source: null }],
    }));
    await openIdeas(page, hub);
    await expect(page.locator('#ideas-weeks .ideas-week[data-ideas-week="2026-09-21"] [data-ideas-item="fixture-week-run"]')).toBeVisible();
    await expect(weeks(page).locator('.ideas-week-title')).toHaveText(['Week of September 28', 'Week of September 21']);
  });
});

test.describe('Refresh a week with the producer not started', () => {
  test.use({
    withFocus: false,
    hubOptions: { ideas: IDEAS, agents: AGENTS, routines: [IDEAS_ROUTINE], personas: { myos: { startFails: true } } },
  });

  test('gives the not running sentence and retires nothing', async ({ page, hub }) => {
    await openIdeas(page, hub);
    await page.locator('#ideas-weeks .ideas-week[data-ideas-week="2026-09-21"] .ideas-week-refresh').click();
    await expect(page.locator('#ideas-weeks .ideas-week[data-ideas-week="2026-09-21"] .ideas-week-notice')).toHaveText('Myos is not running.');
    await expect(item(page, 'fixture-reading-tool')).toBeVisible();
  });
});

test.describe('Refresh a week without a routine', () => {
  test.use({ withFocus: false, hubOptions: { ideas: IDEAS, agents: AGENTS } });

  test('disables every week button and says why', async ({ page, hub }) => {
    await openIdeas(page, hub);
    const buttons = page.locator('#ideas-weeks .ideas-week-refresh');
    await expect(buttons).toHaveCount(2);
    for (const button of await buttons.all()) {
      await expect(button).toBeDisabled();
      await expect(button).toHaveAttribute('title', 'No routine writes ideas.');
    }
    expect(hub.requests('/api/ideas/refresh')).toEqual([]);
  });
});

test.describe('Ideas side panel', () => {
  test.use({ withFocus: false, hubOptions: { ideas: IDEAS, agents: AGENTS } });

  const side = (page) => page.locator('#panel [data-panel-for="ideas"]');
  const week = (page, key) => side(page).locator(`.panel-row[data-ideas-week="${key}"]`);
  const heading = (page, key) => page.locator(`#ideas-weeks [data-ideas-week="${key}"] .ideas-week-title`);

  // On a phone the panel is a drawer, opened by the header's toggle first.
  async function openSide(page) {
    if (page.viewportSize().width >= 720) return;
    await page.locator('#panel-toggle').click();
    await expect(page.locator('#panel')).toBeVisible();
  }

  // Pads the newer week with copies of its idea, so the older week starts
  // below the fold.
  async function padNewerWeek(page) {
    await page.route('**/api/ideas', async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      const response = await route.fetch();
      const body = await response.json();
      const run = body.runs.find((entry) => entry.date === '2026-09-28');
      const first = run.items[0];
      for (let i = 1; i <= 11; i += 1) run.items.push({ ...first, id: `${first.id}-${i}` });
      await route.fulfill({ response, json: body });
    });
  }

  test('lists Weeks, one row per week with its count of ideas', async ({ page, hub }) => {
    await openIdeas(page, hub);
    await openSide(page);
    await expect(side(page)).toBeVisible();
    await expect(page.locator('#panel [data-panel-for="now"]')).toBeHidden();
    await expect(side(page).locator('h2.panel-heading')).toHaveText(['Weeks']);
    await expect(side(page).locator('.panel-row-name')).toHaveText(['Week of September 28', 'Week of September 21']);
    await expect(side(page).locator('.panel-row-count')).toHaveText(['1', '2']);
    expect(await side(page).locator('.panel-row').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-ideas-week'))))
      .toEqual(await weeks(page).evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-ideas-week'))));
    await expect(side(page).locator('.panel-row[aria-current]')).toHaveCount(0);
  });

  test('choosing a week scrolls to it and marks the row', async ({ page, hub }) => {
    await padNewerWeek(page);
    await openIdeas(page, hub);
    await expect(week(page, '2026-09-28').locator('.panel-row-count')).toHaveText('12');
    await expect(heading(page, '2026-09-21')).not.toBeInViewport();

    await openSide(page);
    await week(page, '2026-09-21').click();
    await expect(heading(page, '2026-09-21')).toBeInViewport();
    await expect(week(page, '2026-09-21')).toHaveAttribute('aria-current', 'true');
    await expect(side(page).locator('.panel-row[aria-current]')).toHaveCount(1);

    await openSide(page);
    await week(page, '2026-09-28').click();
    await expect(heading(page, '2026-09-28')).toBeInViewport();
    await expect(week(page, '2026-09-28')).toHaveAttribute('aria-current', 'true');
    await expect(side(page).locator('.panel-row[aria-current]')).toHaveCount(1);

    await nav(page, 'Home').click();
    await expectView(page, 'agents', 'Agents');
    await expect(side(page).locator('.panel-row')).toHaveCount(0);
    await nav(page, 'Ideas').click();
    await expectView(page, 'ideas', 'Ideas');
    await expect(side(page).locator('.panel-row')).toHaveCount(2);
    await expect(side(page).locator('.panel-row[aria-current]')).toHaveCount(0);
  });

  async function save(page, id) {
    const bookmark = item(page, id).getByRole('button', { name: 'Save', exact: true });
    await bookmark.click();
    await expect(item(page, id).locator('.ideas-save-toggle')).toHaveAttribute('aria-pressed', 'true');
  }

  const saved = (page) => side(page).locator('.panel-row[data-ideas-saved]');

  test('Saved appears with its count, filters the page, and a week clears the filter', async ({ page, hub }) => {
    await openIdeas(page, hub);
    await expect(side(page).locator('.panel-row')).toHaveCount(2);
    await expect(saved(page)).toHaveCount(0);
    await save(page, 'fixture-reading-tool');
    await openSide(page);
    await expect(saved(page).locator('.panel-row-name')).toHaveText('Saved');
    await expect(saved(page).locator('.panel-row-count')).toHaveText('1');
    expect(await side(page).evaluate((node) => [...node.children].map((child) => child.textContent)))
      .toEqual(['Saved1', 'Weeks', 'Week of September 281', 'Week of September 212']);

    await week(page, '2026-09-28').click();
    await expect(week(page, '2026-09-28')).toHaveAttribute('aria-current', 'true');
    await openSide(page);
    await saved(page).click();
    await expect(saved(page)).toHaveAttribute('aria-current', 'true');
    await expect(side(page).locator('.panel-row[aria-current]')).toHaveCount(1);
    await expect(weeks(page)).toHaveCount(1);
    await expect(weeks(page).locator('.ideas-week-title')).toHaveText(['Week of September 21']);
    await expect(page.locator('#ideas-weeks .ideas-item')).toHaveCount(1);
    await expect(item(page, 'fixture-reading-tool')).toBeVisible();
    await expect(side(page).locator('.panel-row[data-ideas-week]')).toHaveCount(2);

    await openSide(page);
    await week(page, '2026-09-28').click();
    await expect(weeks(page)).toHaveCount(2);
    await expect(page.locator('#ideas-weeks .ideas-item')).toHaveCount(3);
    await expect(heading(page, '2026-09-28')).toBeInViewport();
    await expect(week(page, '2026-09-28')).toHaveAttribute('aria-current', 'true');
    await expect(saved(page)).not.toHaveAttribute('aria-current');

    await openSide(page);
    await saved(page).click();
    await expect(weeks(page)).toHaveCount(1);
    await nav(page, 'Home').click();
    await expectView(page, 'agents', 'Agents');
    await nav(page, 'Ideas').click();
    await expectView(page, 'ideas', 'Ideas');
    await expect(weeks(page)).toHaveCount(2);
    await expect(side(page).locator('.panel-row[aria-current]')).toHaveCount(0);
  });

  test('the Saved row\'s count follows the bookmark', async ({ page, hub }) => {
    await openIdeas(page, hub);
    await save(page, 'fixture-reading-tool');
    await expect(saved(page).locator('.panel-row-count')).toHaveText('1');
    await save(page, 'fixture-agent-card');
    await expect(saved(page).locator('.panel-row-count')).toHaveText('2');
    await item(page, 'fixture-agent-card').getByRole('button', { name: 'Unsave' }).click();
    await expect(saved(page).locator('.panel-row-count')).toHaveText('1');
    await item(page, 'fixture-reading-tool').getByRole('button', { name: 'Unsave' }).click();
    await expect(saved(page)).toHaveCount(0);
  });

  test('on a phone choosing Saved closes the drawer', async ({ page, hub }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openIdeas(page, hub);
    await save(page, 'fixture-reading-tool');
    await page.locator('#panel-toggle').click();
    await expect(page.locator('#panel')).toBeVisible();
    await saved(page).click();
    await expect(page.locator('#panel-toggle')).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('#panel')).toBeHidden();
    await expect(weeks(page)).toHaveCount(1);
  });

  test('on a phone a choice closes the drawer', async ({ page, hub }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await padNewerWeek(page);
    await openIdeas(page, hub);
    await page.locator('#panel-toggle').click();
    await expect(page.locator('#panel')).toBeVisible();
    await expect(page.locator('#panel-scrim')).toBeVisible();
    await week(page, '2026-09-21').click();
    await expect(page.locator('#panel-toggle')).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('#panel')).toBeHidden();
    await expect(page.locator('#panel-scrim')).toBeHidden();
    await expect(heading(page, '2026-09-21')).toBeInViewport();
  });
});

test.describe('Ideas with an empty store', () => {
  test.use({ withFocus: false, hubOptions: { agents: AGENTS } });

  test('says there are no ideas', async ({ page, hub }) => {
    await page.goto(`${hub.origin}/ideas`);
    await expectView(page, 'ideas', 'Ideas');
    await expect(page.locator('#ideas-message')).toHaveText(/^No ideas yet\./);
    await expect(weeks(page)).toHaveCount(0);
    await expect(page.locator('#panel [data-panel-for="ideas"] .panel-row')).toHaveCount(0);
    await expect(page.locator('#panel [data-panel-for="ideas"]')).toBeHidden();
  });
});
