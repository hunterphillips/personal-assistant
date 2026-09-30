// The Goals view against a temporary copy of test/fixtures/vault, read by the
// real Goals routes, with the second-brain persona on the fake Claude
// adapter of test/support/browser-server.mjs.

import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, expectView, test } from '../support/browser-test.mjs';

const VAULT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'vault');
const BUSY = 'Second brain is in the middle of a turn. Try again when it is idle.';
const NO_ANSWER = 'The dashboard did not respond.';

const cards = (page) => page.locator('#goals-cards .goal-card');
const item = (page, id) => page.locator(`[data-goal-item="${id}"]`);
const row = (page, id) => item(page, id).locator('.goal-row');
const composer = (page) => page.locator('#goals-cards form.goal-composer');
const messages = (page) => page.locator('#agent-messages .thread-message');

async function openGoals(page, hub) {
  await page.goto(`${hub.origin}/goals`);
  await expectView(page, 'goals', 'Goals');
  await expect(cards(page)).toHaveCount(5);
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

  test('renders each section as a card with its items', async ({ page, hub }) => {
    await openGoals(page, hub);
    await expect(cards(page).locator('.card-name')).toHaveText(['Now', 'Later', 'Not now', 'Long term', 'Goal notes']);
    await expect(cards(page).first().locator('.card-note')).toHaveText('Updated 2026-03-04');
    await expect(page.locator('#goals-message')).toBeHidden();

    const garden = item(page, 'now:ship-the-garden-planner');
    await expect(garden.locator('h3')).toHaveText('Ship the garden planner');
    await expect(garden.locator('.goal-line')).toHaveText([
      'Now: sketch the three beds and order seeds before the frost date.',
      'Why: fresh food from the yard by early summer.',
    ]);
    await expect(garden.locator('.goal-prose p')).toContainText('https://example.com/beds');
    await expect(garden.locator('.goal-prose a')).toHaveCount(0);

    await expect(item(page, 'goal:boat').locator('.role-chip')).toHaveText('five years');
    await expect(item(page, 'goal:zine').locator('.role-chip')).toHaveCount(0);
    await expect(page.locator('.goal-principle')).toHaveText('Make things by hand and share them with friends.');
    await expect(page.locator('.goal-top h3')).toHaveCount(3);
    await expect(page.locator('#view-goals [data-action]')).toHaveCount(0);
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
    await expect(item(page, 'goal:swim').locator('h3')).toHaveText('Swim a mile');
    await expect(input).toBeFocused();
    await expect(input).toHaveValue('Swim a mile');
    await input.press('End');
    await input.pressSequentially('.');
    await expect(input).toHaveValue('Swim a mile.');
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
    await expect(cards(page)).toHaveCount(0);
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await stalled.abort().catch(() => {});
  });

  test('an edit of a goal that has gone becomes a new goal with the same text', async ({ page, hub }) => {
    await openGoals(page, hub);
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
    await expect(item(page, 'goal:weld').locator('h3')).toHaveText('Learn to weld');
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
    await expect(cards(page)).toHaveCount(0);
  });
});
