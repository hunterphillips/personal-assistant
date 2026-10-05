// The Goals view against a temporary copy of test/fixtures/vault, read by the
// real Goals routes, with the second-brain persona on the fake Claude
// adapter of test/support/browser-server.mjs.

import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, expectView, nav, test } from '../support/browser-test.mjs';

const VAULT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'vault');
const BUSY = 'Second brain is in the middle of a turn. Try again when it is idle.';
const NO_ANSWER = 'The dashboard did not respond.';

const sections = (page) => page.locator('#goals-cards .goal-section');
const item = (page, id) => page.locator(`[data-goal-item="${id}"]`);
const row = (page, id) => item(page, id).locator('.goal-row');
const composer = (page) => page.locator('#goals-cards form.goal-composer');
const messages = (page) => page.locator('#agent-messages .thread-message');

async function openRow(page, section, id) {
  await page.locator('#goals-cards').getByRole('button', { name: new RegExp(`^${section} \\d+$`) }).click();
  await row(page, id).click();
}

async function openGoals(page, hub) {
  await page.goto(`${hub.origin}/goals`);
  await expectView(page, 'goals', 'Goals');
  await expect(sections(page)).toHaveCount(5);
}

test.describe('with the fixture vault', () => {
  test.use({ hubOptions: { vault: VAULT } });

  test('Now shows one row per goal with its status line and nothing else', async ({ page, hub }) => {
    await openGoals(page, hub);
    const now = page.locator('[data-goal-section="now"]');
    await expect(now.locator('.goal-row')).toHaveCount(2);
    const garden = row(page, 'now:ship-the-garden-planner');
    await expect(garden.locator('.goal-title')).toHaveText('Ship the garden planner');
    await expect(garden.locator('.goal-status')).toHaveText('sketch the three beds and order seeds before the frost date.');
    await expect(garden).toHaveAttribute('aria-expanded', 'false');
    await expect(item(page, 'now:ship-the-garden-planner').getByText(/^Why:/)).toBeHidden();
    await expect(item(page, 'now:ship-the-garden-planner').locator('.goal-prose')).toBeHidden();
    await expect(item(page, 'now:ship-the-garden-planner').getByRole('button', { name: /^Edit/ })).toBeHidden();
  });

  test('opening a row shows its details, closing hides them, and several stay open', async ({ page, hub }) => {
    await openGoals(page, hub);
    const garden = item(page, 'now:ship-the-garden-planner');
    await row(page, 'now:ship-the-garden-planner').click();
    await expect(row(page, 'now:ship-the-garden-planner')).toHaveAttribute('aria-expanded', 'true');
    await expect(garden.locator('.goal-line')).toHaveText(['Why: fresh food from the yard by early summer.']);
    await expect(garden.locator('.goal-prose p')).toContainText('https://example.com/beds');
    await expect(garden.locator('.goal-prose li')).toHaveText(['A nested thought: folded into its parent', 'Keep the compost bin level.']);
    await expect(garden.locator('.goal-prose a')).toHaveCount(0);
    await expect(garden.getByRole('button', { name: 'Edit Ship the garden planner' })).toBeVisible();

    await row(page, 'now:learn-the-cello').click();
    await expect(row(page, 'now:ship-the-garden-planner')).toHaveAttribute('aria-expanded', 'true');
    await expect(item(page, 'now:learn-the-cello').getByRole('button', { name: 'Edit Learn the cello' })).toBeVisible();

    await row(page, 'now:ship-the-garden-planner').click();
    await expect(row(page, 'now:ship-the-garden-planner')).toHaveAttribute('aria-expanded', 'false');
    await expect(garden.locator('.goal-prose')).toBeHidden();
    await expect(row(page, 'now:learn-the-cello')).toHaveAttribute('aria-expanded', 'true');
  });

  test('Enter and Space on a focused row toggle it', async ({ page, hub }) => {
    await openGoals(page, hub);
    const cello = row(page, 'now:learn-the-cello');
    await cello.focus();
    await page.keyboard.press('Enter');
    await expect(cello).toHaveAttribute('aria-expanded', 'true');
    await expect(item(page, 'now:learn-the-cello').locator('.goal-prose')).toBeVisible();
    await page.keyboard.press('Space');
    await expect(cello).toHaveAttribute('aria-expanded', 'false');
    await expect(item(page, 'now:learn-the-cello').locator('.goal-prose')).toBeHidden();
    await expect(cello).toBeFocused();
  });

  test('the status line is clamped to two lines while its row is closed', async ({ page, hub }) => {
    await page.route('**/api/goals', async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      body.sections[0].items[0].now = 'sketch the three beds and order seeds before the frost date. '.repeat(12);
      await route.fulfill({ response, json: body });
    });
    await openGoals(page, hub);
    const garden = row(page, 'now:ship-the-garden-planner');
    const status = garden.locator('.goal-status');
    const lines = () => status.evaluate((node) => Math.round(node.getBoundingClientRect().height
      / parseFloat(getComputedStyle(node).lineHeight)));
    expect(await lines()).toBe(2);
    await garden.click();
    await expect.poll(lines).toBeGreaterThan(2);
    await garden.click();
    await expect.poll(lines).toBe(2);
  });

  test('rows and headers are one column and at least 44 px tall', async ({ page, hub }) => {
    await openGoals(page, hub);
    await page.locator('#goals-cards').getByRole('button', { name: /^Goal notes/ }).click();
    const heights = await page.locator('#goals-cards .goal-row:visible, #goals-cards .goal-section-toggle')
      .evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().height));
    expect(heights.length).toBeGreaterThan(5);
    for (const height of heights) expect(height).toBeGreaterThanOrEqual(44);
    const lefts = await page.locator('#goals-cards [data-goal-section="goals"] .goal-row')
      .evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().left));
    expect(new Set(lefts).size).toBe(1);
    const count = page.locator('[data-goal-section="goals"] .goal-count');
    await expect(count).toBeVisible();
    await expect(count).toBeInViewport();
    expect(await count.evaluate((node) => getComputedStyle(node).color))
      .toBe(await page.locator('.card-note').first().evaluate((node) => getComputedStyle(node).color));
  });

  test('the other sections are folded headers with counts that open to their rows', async ({ page, hub }) => {
    await openGoals(page, hub);
    const toggles = page.locator('#goals-cards .goal-section-toggle');
    await expect(toggles).toHaveText(['Now 2', 'Later 4', 'Not now 2', 'Long term 3', 'Goal notes 4']);
    expect(await toggles.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('aria-expanded'))))
      .toEqual(['true', 'false', 'false', 'false', 'false']);
    await expect(page.locator('[data-goal-section="later"] .goal-count')).toHaveText('4');
    await expect(page.locator('[data-goal-section="later"] .card-note')).toHaveText('Updated 2026-03-04');
    await expect(row(page, 'later:kayak-trip')).toBeHidden();

    await page.locator('#goals-cards').getByRole('button', { name: /^Later/ }).click();
    await expect(row(page, 'later:kayak-trip')).toBeVisible();
    await expect(row(page, 'later:kayak-trip').locator('.goal-status')).toHaveText('pick a river in May.');
    await expect(row(page, 'later:reorganise-the-garage-shelves-one-weekend').locator('.goal-title'))
      .toHaveText('Reorganise the garage shelves one weekend soon.');
    await expect(row(page, 'later:reorganise-the-garage-shelves-one-weekend').locator('.goal-status')).toHaveCount(0);

    await page.locator('#goals-cards').getByRole('button', { name: /^Long term/ }).click();
    const longTerm = page.locator('[data-goal-section="long-term"]');
    await expect(longTerm.locator('.goal-principle')).toHaveText('Make things by hand and share them with friends.');
    await expect(longTerm.locator('.goal-row .goal-title')).toHaveText([
      'A workshop of my own', 'Steady savings (or a path to them)', 'A garden that feeds the household most of the year',
    ]);
    await expect(longTerm.locator('.goal-status')).toHaveCount(0);
    await expect(longTerm.locator('.goal-horizons dt')).toHaveText(['1 yr', '5 yrs']);

    await page.locator('#goals-cards').getByRole('button', { name: /^Goal notes/ }).click();
    await expect(row(page, 'goal:boat').locator('.goal-status')).toHaveText('a small wooden rowing boat.');
    await expect(row(page, 'goal:zine').locator('.goal-status')).toHaveText('A photocopied zine about the neighbourhood.');
    await row(page, 'goal:boat').click();
    await expect(item(page, 'goal:boat').locator('.role-chip')).toHaveText('five years');
    await row(page, 'goal:zine').click();
    await expect(item(page, 'goal:zine').locator('.role-chip')).toHaveCount(0);
    await expect(item(page, 'goal:zine').locator('.goal-prose p')).toHaveText(['Walks and maps.', 'Recipes.']);

    await page.locator('#goals-cards').getByRole('button', { name: /^Later/ }).click();
    await expect(row(page, 'later:kayak-trip')).toBeHidden();
    await expect(page.locator('#view-goals [data-action]')).toHaveCount(0);
  });

  test('renders the five sections in order under the Updated note', async ({ page, hub }) => {
    await openGoals(page, hub);
    await expect(sections(page).locator('.card-name')).toHaveText(['Now 2', 'Later 4', 'Not now 2', 'Long term 3', 'Goal notes 4']);
    await expect(sections(page).first().locator('.card-note')).toHaveText('Updated 2026-03-04');
    await expect(page.locator('#goals-message')).toBeHidden();
  });

  test('Add goal sends the text to the second-brain persona and opens its thread', async ({ page, hub }) => {
    await openGoals(page, hub);
    await page.getByRole('button', { name: 'Add goal' }).click();
    await expect(composer(page)).toHaveCount(1);
    await expect(composer(page).locator('blockquote')).toHaveCount(0);
    await composer(page).getByLabel('What do you want to work toward?').fill('Run a half marathon.');
    await composer(page).getByRole('button', { name: 'Send' }).click();

    await expectView(page, 'agents', 'Agents');
    await expect(page).toHaveURL(`${hub.origin}/?agent=second-brain`);
    await expect(messages(page).first()).toHaveText(/^New goal from the dashboard:/);
    expect(hub.requests('/api/goals/propose')).toEqual([{ method: 'POST', status: 202 }]);
    expect(hub.personas.calls).toEqual([['send', 'second-brain', expect.stringContaining('Run a half marathon.')]]);
  });

  test('Edit quotes the goal note and sends an edit for its id', async ({ page, hub }) => {
    await openGoals(page, hub);
    await openRow(page, 'Goal notes', 'goal:boat');
    await item(page, 'goal:boat').getByRole('button', { name: 'Edit Build a boat' }).click();
    const form = item(page, 'goal:boat').locator('form.goal-composer');
    await expect(form.locator('blockquote p')).toHaveText(['Build a boat', 'What: a small wooden rowing boat.']);
    await form.getByLabel('What should change?').fill('Make it a sailing boat.');

    const posted = page.waitForRequest('**/api/goals/propose');
    await form.getByRole('button', { name: 'Send' }).click();
    expect((await posted).postDataJSON()).toEqual({ kind: 'edit', target: 'goal:boat', text: 'Make it a sailing boat.' });
    await expect(page).toHaveURL(`${hub.origin}/?agent=second-brain`);
    expect(hub.personas.calls[0][2]).toMatch(/^Edit a goal from the dashboard: "Build a boat" in notes\/goals\/boat\.md\./);
  });

  test('only one composer is open; Cancel and Escape close it and return focus', async ({ page, hub }) => {
    await openGoals(page, hub);
    await openRow(page, 'Later', 'later:kayak-trip');
    await page.getByRole('button', { name: 'Add goal' }).click();
    const kayak = item(page, 'later:kayak-trip').getByRole('button', { name: 'Edit Kayak trip' });
    await kayak.click();
    await expect(composer(page)).toHaveCount(1);
    await expect(item(page, 'later:kayak-trip').locator('blockquote p')).toHaveText(['Kayak trip', 'pick a river in May.']);
    await composer(page).getByLabel('What should change?').fill('Go in June.');
    await kayak.click();
    await expect(composer(page).getByLabel('What should change?')).toHaveValue('Go in June.');
    await composer(page).getByRole('button', { name: 'Cancel' }).click();
    await expect(composer(page)).toHaveCount(0);
    await expect(kayak).toBeFocused();

    await kayak.click();
    await row(page, 'later:kayak-trip').click();
    await expect(composer(page)).toBeVisible();
    await composer(page).getByRole('button', { name: 'Cancel' }).click();
    await expect(row(page, 'later:kayak-trip')).toBeFocused();

    await page.getByRole('button', { name: 'Add goal' }).click();
    await composer(page).getByLabel('What do you want to work toward?').press('Escape');
    await expect(composer(page)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Add goal' })).toBeFocused();
  });

  test('Control+Enter sends', async ({ page, hub }) => {
    await openGoals(page, hub);
    await page.getByRole('button', { name: 'Add goal' }).click();
    const input = composer(page).getByLabel('What do you want to work toward?');
    await input.fill('Plant an orchard.');
    await input.press('Control+Enter');
    await expect(page).toHaveURL(`${hub.origin}/?agent=second-brain`);
    expect(hub.requests('/api/goals/propose')).toEqual([{ method: 'POST', status: 202 }]);
  });

  test('a refetch keeps the composer, its text, and its focus', async ({ page, hub }) => {
    await page.clock.install();
    await openGoals(page, hub);
    await page.getByRole('button', { name: 'Add goal' }).click();
    const input = composer(page).getByLabel('What do you want to work toward?');
    await input.pressSequentially('Swim a mile');
    await writeFile(path.join(hub.vaultDir, 'notes', 'goals', 'swim.md'), '# Swim a mile\n');
    const before = hub.requests('/api/goals').length;

    await page.clock.runFor(60_000);
    await expect.poll(() => hub.requests('/api/goals').length).toBe(before + 1);
    await expect(item(page, 'goal:swim').locator('.goal-title')).toHaveText('Swim a mile');
    await expect(input).toBeFocused();
    await expect(input).toHaveValue('Swim a mile');
    await input.press('End');
    await input.pressSequentially('.');
    await expect(input).toHaveValue('Swim a mile.');
  });

  test('a refetch keeps open rows and sections open and focus where it was', async ({ page, hub }) => {
    await page.clock.install();
    await openGoals(page, hub);
    await openRow(page, 'Later', 'later:kayak-trip');
    await openRow(page, 'Goal notes', 'goal:boat');
    await row(page, 'goal:boat').focus();
    await rm(path.join(hub.vaultDir, 'notes', 'goals', 'zine.md'));
    await writeFile(path.join(hub.vaultDir, 'notes', 'goals', 'swim.md'), '# Swim a mile\n\n**What:** a mile in open water.\n');
    const before = hub.requests('/api/goals').length;

    await page.clock.runFor(60_000);
    await expect.poll(() => hub.requests('/api/goals').length).toBe(before + 1);
    await expect(row(page, 'goal:swim')).toBeVisible();
    await expect(item(page, 'goal:zine')).toHaveCount(0);
    await expect(page.locator('[data-goal-section="goals"] .goal-count')).toHaveText('4');
    await expect(row(page, 'goal:swim')).toHaveAttribute('aria-expanded', 'false');
    await expect(row(page, 'later:kayak-trip')).toHaveAttribute('aria-expanded', 'true');
    await expect(row(page, 'goal:boat')).toHaveAttribute('aria-expanded', 'true');
    await expect(item(page, 'goal:boat').locator('.role-chip')).toBeVisible();
    await expect(row(page, 'later:pottery-class')).toBeVisible();
    await expect(row(page, 'not-now:home-studio')).toBeHidden();
    await expect(row(page, 'goal:boat')).toBeFocused();
  });

  test('the view stops reading the vault once it is left', async ({ page, hub }) => {
    await page.clock.install();
    await openGoals(page, hub);
    await page.getByRole('navigation', { name: 'Dashboard' }).getByRole('link', { name: 'Home', exact: true }).click();
    await expectView(page, 'agents', 'Agents');
    const before = hub.requests('/api/goals').length;
    await page.clock.runFor(120_000);
    expect(hub.requests('/api/goals').length).toBe(before);
  });

  test('says the dashboard did not respond when /api/goals hangs', async ({ page, hub }) => {
    await page.clock.install();
    let stalled = null;
    const asked = new Promise((resolve) => {
      page.route('**/api/goals', (route) => {
        stalled = route;
        resolve();
      });
    });
    await page.goto(`${hub.origin}/goals`);
    await expectView(page, 'goals', 'Goals');
    await asked;
    await page.clock.runFor(8_000);
    await expect(page.locator('#goals-message')).toHaveText(NO_ANSWER);
    await expect(sections(page)).toHaveCount(0);
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await stalled.abort().catch(() => {});
  });

  test('an edit of a goal that has gone becomes a new goal with the same text', async ({ page, hub }) => {
    await openGoals(page, hub);
    await openRow(page, 'Goal notes', 'goal:zine');
    await item(page, 'goal:zine').getByRole('button', { name: 'Edit Zine' }).click();
    await composer(page).getByLabel('What should change?').fill('Add a third issue.');
    await rm(path.join(hub.vaultDir, 'notes', 'goals', 'zine.md'));
    await composer(page).getByRole('button', { name: 'Send' }).click();

    const form = page.locator('#goals-cards > form.goal-composer:first-child');
    await expect(form.locator('.composer-reason')).toHaveText('That goal has changed. Send this as a new goal, or cancel.');
    await expect(item(page, 'goal:zine')).toHaveCount(0);
    await expect(form.locator('blockquote')).toHaveCount(0);
    await expect(form.getByLabel('What do you want to work toward?')).toHaveValue('Add a third issue.');
    await expectView(page, 'goals', 'Goals');

    const posted = page.waitForRequest('**/api/goals/propose');
    await form.getByRole('button', { name: 'Send' }).click();
    expect((await posted).postDataJSON()).toEqual({ kind: 'add', text: 'Add a third issue.' });
    await expect(page).toHaveURL(`${hub.origin}/?agent=second-brain`);
  });
});

test.describe('the side panel', () => {
  test.use({ hubOptions: { vault: VAULT } });

  const side = (page) => page.locator('#panel [data-panel-for="goals"]');
  const area = (page, id) => side(page).locator(`.panel-row[data-goal-area="${id}"]`);
  const heading = (page, id) => page.locator(`#goals-section-${id}`);

  // On a phone the panel is a drawer, opened by the header's toggle first.
  async function openSide(page) {
    if (page.viewportSize().width >= 720) return;
    await page.locator('#panel-toggle').click();
    await expect(page.locator('#panel')).toBeVisible();
  }

  test('lists Areas, one row per section with its count', async ({ page, hub }) => {
    await openGoals(page, hub);
    await openSide(page);
    await expect(side(page)).toBeVisible();
    await expect(page.locator('#panel [data-panel-for="now"]')).toBeHidden();
    await expect(side(page).locator('h2.panel-heading')).toHaveText(['Areas']);
    await expect(side(page).locator('.panel-row-name')).toHaveText(['Now', 'Later', 'Not now', 'Long term', 'Goal notes']);
    await expect(side(page).locator('.panel-row-count')).toHaveText(['2', '4', '2', '3', '4']);
    const counts = await page.locator('#goals-cards .goal-count').allTextContents();
    expect(await side(page).locator('.panel-row-count').allTextContents()).toEqual(counts);
    expect(await side(page).locator('.panel-row').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-goal-area'))))
      .toEqual(await sections(page).evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-goal-section'))));
    await expect(side(page).locator('.panel-row[aria-current]')).toHaveCount(0);
  });

  test('choosing an area opens a folded section, scrolls to it, and marks the row', async ({ page, hub }) => {
    await page.setViewportSize({ width: 1280, height: 420 });
    await openGoals(page, hub);
    const toggle = page.locator('[data-goal-section="goals"] .goal-section-toggle');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(heading(page, 'goals')).not.toBeInViewport();

    await area(page, 'goals').click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('[data-goal-section="goals"] .goal-row').first()).toBeVisible();
    await expect(heading(page, 'goals')).toBeInViewport();
    await expect(area(page, 'goals')).toHaveAttribute('aria-current', 'true');
    await expect(side(page).locator('.panel-row[aria-current]')).toHaveCount(1);

    // An open section stays open, and the mark moves to the new row.
    await area(page, 'now').click();
    await expect(page.locator('[data-goal-section="now"] .goal-section-toggle')).toHaveAttribute('aria-expanded', 'true');
    await expect(heading(page, 'now')).toBeInViewport();
    await expect(area(page, 'now')).toHaveAttribute('aria-current', 'true');
    await expect(side(page).locator('.panel-row[aria-current]')).toHaveCount(1);
    await area(page, 'goals').click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');

    await nav(page, 'Home').click();
    await expectView(page, 'agents', 'Agents');
    await expect(side(page).locator('.panel-row')).toHaveCount(0);
    await nav(page, 'Goals').click();
    await expectView(page, 'goals', 'Goals');
    await expect(side(page).locator('.panel-row')).toHaveCount(5);
    await expect(side(page).locator('.panel-row[aria-current]')).toHaveCount(0);
  });

  test('on a phone a choice closes the drawer', async ({ page, hub }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openGoals(page, hub);
    await openSide(page);
    await expect(page.locator('#panel-scrim')).toBeVisible();
    await area(page, 'goals').click();
    await expect(page.locator('#panel-toggle')).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('#panel')).toBeHidden();
    await expect(page.locator('#panel-scrim')).toBeHidden();
    await expect(page.locator('[data-goal-section="goals"] .goal-section-toggle')).toHaveAttribute('aria-expanded', 'true');
    await expect(heading(page, 'goals')).toBeInViewport();
  });
});

test.describe('with the second-brain persona not started', () => {
  test.use({ hubOptions: { vault: VAULT, personas: { 'second-brain': { startFails: true } } } });

  test('Send says the persona is not running', async ({ page, hub }) => {
    await openGoals(page, hub);
    await page.getByRole('button', { name: 'Add goal' }).click();
    await composer(page).getByLabel('What do you want to work toward?').fill('Learn to weld.');
    await composer(page).getByRole('button', { name: 'Send' }).click();
    await expect(composer(page).locator('.composer-reason')).toHaveText('Second brain is not running.');
    await expectView(page, 'goals', 'Goals');
  });
});

test.describe('with the second-brain persona busy', () => {
  test.use({ hubOptions: { vault: VAULT, personas: { 'second-brain': { state: 'busy' } } } });

  test('Send says the persona is busy and stays on Goals', async ({ page, hub }) => {
    await openGoals(page, hub);
    await page.getByRole('button', { name: 'Add goal' }).click();
    await composer(page).getByLabel('What do you want to work toward?').fill('Learn to weld.');
    await composer(page).getByRole('button', { name: 'Send' }).click();

    await expect(composer(page).locator('.composer-reason')).toHaveText(BUSY);
    await expect(composer(page).getByLabel('What do you want to work toward?')).toHaveValue('Learn to weld.');
    await expect(composer(page).getByRole('button', { name: 'Send' })).toBeEnabled();
    await expectView(page, 'goals', 'Goals');
    await expect(page).toHaveURL(`${hub.origin}/goals`);
    expect(hub.requests('/api/goals/propose')).toEqual([{ method: 'POST', status: 409 }]);
  });

  test('the view reads the vault again when the persona goes idle', async ({ page, hub }) => {
    await openGoals(page, hub);
    await writeFile(path.join(hub.vaultDir, 'notes', 'goals', 'weld.md'), '# Learn to weld\n');
    await hub.personas.reply('second-brain', 'Wrote notes/goals/weld.md.');
    await expect(item(page, 'goal:weld').locator('.goal-title')).toHaveText('Learn to weld');
  });
});

test.describe('with an empty vault', () => {
  test.use({ hubOptions: { vault: true } });

  test('says the vault is empty, then what is missing, one sentence per line', async ({ page, hub }) => {
    await page.goto(`${hub.origin}/goals`);
    await expectView(page, 'goals', 'Goals');
    const message = page.locator('#goals-message');
    await expect(message).toBeVisible();
    const lines = await message.evaluate((node) => Array.from(node.childNodes)
      .filter((child) => child.nodeType === Node.TEXT_NODE).map((child) => child.textContent));
    expect(lines[0]).toBe('Nothing in the vault yet.');
    expect(lines.slice(1)).toContain('notes/current-priorities.md is missing.');
    await expect(sections(page)).toHaveCount(0);
    await expect(page.locator('#panel [data-panel-for="goals"] .panel-row')).toHaveCount(0);
    await expect(page.locator('#panel [data-panel-for="goals"]')).toBeHidden();
  });
});
