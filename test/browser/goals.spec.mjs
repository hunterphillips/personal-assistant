// The Goals view against a temporary copy of test/fixtures/vault, read by the
// real Goals routes, with the second-brain persona on the fake Claude
// adapter of test/support/browser-server.mjs.

import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, expectView, test } from '../support/browser-test.mjs';

const VAULT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'vault');
const BUSY = 'Second brain is in the middle of a turn. Try again when it is idle.';

const cards = (page) => page.locator('#goals-cards .goal-card');
const item = (page, id) => page.locator(`[data-goal-item="${id}"]`);
const composer = (page) => page.locator('#goals-cards form.goal-composer');
const messages = (page) => page.locator('#agent-messages .thread-message');

async function openGoals(page, hub) {
  await page.goto(`${hub.origin}/goals`);
  await expectView(page, 'goals', 'Goals');
  await expect(cards(page)).toHaveCount(5);
}

test.describe('with the fixture vault', () => {
  test.use({ hubOptions: { vault: VAULT } });

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

  test('only one composer is open, and Cancel closes it', async ({ page, hub }) => {
    await openGoals(page, hub);
    await page.getByRole('button', { name: 'Add goal' }).click();
    await item(page, 'later:kayak-trip').getByRole('button', { name: 'Edit Kayak trip' }).click();
    await expect(composer(page)).toHaveCount(1);
    await expect(item(page, 'later:kayak-trip').locator('blockquote p')).toHaveText(['Kayak trip', 'pick a river in May.']);
    await composer(page).getByRole('button', { name: 'Cancel' }).click();
    await expect(composer(page)).toHaveCount(0);
  });

  test('pressing Edit does not fetch the state', async ({ page, hub }) => {
    await openGoals(page, hub);
    await expect.poll(() => hub.requests('/api/state').length).toBeGreaterThan(0);
    await page.waitForTimeout(300);
    const before = hub.requests('/api/state').length;
    await item(page, 'goal:zine').getByRole('button', { name: 'Edit Zine' }).click();
    await expect(composer(page)).toHaveCount(1);
    await page.waitForTimeout(300);
    expect(hub.requests('/api/state').length).toBe(before);
  });

  test('an edit of a goal that has gone says so and refetches', async ({ page, hub }) => {
    await openGoals(page, hub);
    await item(page, 'goal:zine').getByRole('button', { name: 'Edit Zine' }).click();
    await composer(page).getByLabel('What should change?').fill('Add a third issue.');
    await rm(path.join(hub.vaultDir, 'notes', 'goals', 'zine.md'));
    await composer(page).getByRole('button', { name: 'Send' }).click();

    await expect(composer(page).locator('.composer-reason')).toHaveText('That goal has changed. Try again.');
    await expect(item(page, 'goal:zine')).toHaveCount(0);
    await expect(composer(page).getByLabel('What should change?')).toHaveValue('Add a third issue.');
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
    await page.waitForTimeout(300);
    await expect(item(page, 'goal:weld')).toHaveCount(0);
    await hub.personas.reply('second-brain', 'Wrote notes/goals/weld.md.');
    await expect(item(page, 'goal:weld').locator('h3')).toHaveText('Learn to weld');
  });
});

test.describe('with an empty vault', () => {
  test.use({ hubOptions: { vault: true } });

  test('lists what is missing, one sentence per line, and no cards', async ({ page, hub }) => {
    await page.goto(`${hub.origin}/goals`);
    await expectView(page, 'goals', 'Goals');
    const message = page.locator('#goals-message');
    await expect(message).toBeVisible();
    await expect(message.locator('br')).toHaveCount(2);
    await expect(message).toContainText('notes/current-priorities.md is missing.');
    await expect(cards(page)).toHaveCount(0);
  });

  test('says the vault is empty when every section is empty and nothing is wrong', async ({ page, hub }) => {
    const sections = [['now', 'Now'], ['later', 'Later'], ['not-now', 'Not now'], ['long-term', 'Long term'], ['goals', 'Goal notes']]
      .map(([id, title]) => ({ id, title, source: null, updated: null, items: [] }));
    await page.route('**/api/goals', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ agentId: 'second-brain', readAt: new Date().toISOString(), problems: [], sections }),
    }));
    await page.goto(`${hub.origin}/goals`);
    await expect(page.locator('#goals-message')).toHaveText('Nothing in the vault yet.');
    await expect(cards(page)).toHaveCount(0);
  });
});
