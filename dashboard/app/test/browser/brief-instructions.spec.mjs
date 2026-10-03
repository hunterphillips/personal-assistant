// The Brief instructions panel on the Reading view's Brief tab, against a
// temporary copy of test/fixtures/brief-instructions/curator.md read by the
// real routes, with an invented pinned Assistant on the fake Claude adapter
// of test/support/browser-server.mjs as the agent Settings names.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, expectView, test } from '../support/browser-test.mjs';

const INSTRUCTIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'brief-instructions', 'curator.md');
const ASSISTANT = Object.freeze({
  id: 'assistant', name: 'Assistant', role: 'Assistant', description: 'Invented.', group: 'personal', kind: 'persona',
  cwd: '/invented', provider: 'claude', pinned: true,
});

const tabs = (page) => page.getByRole('navigation', { name: 'Reading' });
const toggle = (page) => page.getByRole('button', { name: 'Brief instructions' });
const panel = (page) => page.locator('#brief-instructions');
const input = (page) => panel(page).getByLabel('What should change?');
const messages = (page) => page.locator('#agent-messages .thread-message');

async function openBrief(page, hub) {
  await page.goto(`${hub.origin}/brief`);
  await expectView(page, 'reading', 'Reading');
  await expect(tabs(page).getByRole('link', { name: 'Brief' })).toHaveAttribute('aria-current', 'page');
}

async function openPanel(page, hub) {
  await openBrief(page, hub);
  await toggle(page).click();
  await expect(panel(page)).toBeVisible();
  await expect(panel(page).locator('.goal-prose li')).toHaveCount(4);
}

test.describe('with the brief instructions', () => {
  test.use({ hubOptions: { briefInstructions: INSTRUCTIONS, agents: [ASSISTANT] } });

  test('the button opens the rules as prose above the brief', async ({ page, hub }) => {
    await openBrief(page, hub);
    await expect(toggle(page)).toBeVisible();
    await expect(toggle(page)).toHaveAttribute('aria-expanded', 'false');
    if (page.viewportSize().width >= 720) await expect(toggle(page)).toHaveText('Brief instructions');
    await expect(panel(page)).toBeHidden();
    await toggle(page).click();
    await expect(toggle(page)).toHaveAttribute('aria-expanded', 'true');
    await expect(panel(page).getByRole('heading', { name: 'Brief instructions' })).toBeVisible();
    await expect(panel(page).locator('.instructions-intro'))
      .toHaveText('The brief follows these rules. A change goes to Assistant, which edits the file.');
    await expect(panel(page).locator('.goal-prose h4')).toHaveText(['Invented brief rules', 'The memo', 'Sections']);
    await expect(panel(page).locator('.goal-prose ol li')).toHaveText(['Nothing he already knows.', 'One item per story, read cold.']);
    await expect(panel(page).locator('.goal-prose ul li')).toHaveText(['Needs you', 'Today']);
    await expect(input(page)).toBeFocused();
    await expect(panel(page).getByRole('button', { name: 'Send' })).toBeVisible();
    const box = await panel(page).boundingBox();
    const notice = await page.locator('#brief-notice').boundingBox();
    expect(box.y + box.height).toBeLessThanOrEqual(notice.y);
    expect(hub.requests('/api/brief/instructions')).toEqual([{ method: 'GET', status: 200 }]);
  });

  test('the button is only on the Brief tab, beside no Feed button', async ({ page, hub }) => {
    await page.goto(`${hub.origin}/feed`);
    await expectView(page, 'reading', 'Feed');
    await expect(toggle(page)).toBeHidden();
    await tabs(page).getByRole('link', { name: 'Brief' }).click();
    await expect(toggle(page)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Feed instructions' })).toBeHidden();
    await tabs(page).getByRole('link', { name: 'Feed' }).click();
    await expect(toggle(page)).toBeHidden();
  });

  test('Send asks the agent for the change and opens its thread', async ({ page, hub }) => {
    await openPanel(page, hub);
    await input(page).fill('Leave the weather out.');
    const posted = page.waitForRequest('**/api/brief/instructions/propose');
    await panel(page).getByRole('button', { name: 'Send' }).click();
    expect((await posted).postDataJSON()).toEqual({ text: 'Leave the weather out.' });
    await expectView(page, 'agents', 'Agents');
    await expect(page).toHaveURL(`${hub.origin}/?agent=assistant`);
    await expect(messages(page).first()).toHaveText(/^Change the brief's instructions\./);
    await expect(messages(page).first()).toContainText('Leave the weather out.');
    expect(hub.requests('/api/brief/instructions/propose')).toEqual([{ method: 'POST', status: 202 }]);
  });

  test('Cancel and Escape close the panel and focus the button; the panel closes with the tab', async ({ page, hub }) => {
    await openPanel(page, hub);
    await panel(page).getByRole('button', { name: 'Cancel' }).click();
    await expect(panel(page)).toBeHidden();
    await expect(toggle(page)).toBeFocused();
    await toggle(page).click();
    await expect(panel(page)).toBeVisible();
    await input(page).press('Escape');
    await expect(panel(page)).toBeHidden();
    await toggle(page).click();
    await expect(panel(page)).toBeVisible();
    await tabs(page).getByRole('link', { name: 'Feed' }).click();
    await expect(panel(page)).toBeHidden();
    await tabs(page).getByRole('link', { name: 'Brief' }).click();
    await expect(panel(page)).toBeHidden();
    await expect(toggle(page)).toBeVisible();
  });

  test('a refused send shows its sentence under the composer', async ({ page, hub }) => {
    await openPanel(page, hub);
    await page.route('**/api/brief/instructions/propose', (route) => route.fulfill({
      status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'busy' }),
    }));
    await input(page).fill('Leave the weather out.');
    await panel(page).getByRole('button', { name: 'Send' }).click();
    await expect(panel(page).locator('#brief-instructions-reason'))
      .toHaveText('Assistant is in the middle of a turn. Try again when it is idle.');
    await expect(panel(page)).toBeVisible();
    await expect(input(page)).toHaveValue('Leave the weather out.');
  });
});

test.describe('with no agent receiving the brief', () => {
  test.use({ hubOptions: {
    briefInstructions: INSTRUCTIONS, agents: [ASSISTANT],
    settings: { model: { default: null, effort: null }, brief: { agent: null } },
  } });

  test('the panel says so and a send is refused with the same sentence', async ({ page, hub }) => {
    await openPanel(page, hub);
    await expect(panel(page).locator('.instructions-intro'))
      .toHaveText('The brief follows these rules. No agent receives the brief, so a change has nowhere to go. Choose one in Settings.');
    await input(page).fill('Leave the weather out.');
    await panel(page).getByRole('button', { name: 'Send' }).click();
    await expect(panel(page).locator('#brief-instructions-reason')).toHaveText('No agent receives the brief. Choose one in Settings.');
    expect(hub.requests('/api/brief/instructions/propose')).toEqual([{ method: 'POST', status: 409 }]);
  });
});

test.describe('with no brief instructions file', () => {
  test.use({ hubOptions: { agents: [ASSISTANT] } });

  test('the panel says the file is missing', async ({ page, hub }) => {
    await openBrief(page, hub);
    await toggle(page).click();
    await expect(panel(page).locator('.instructions-problem')).toHaveText('The brief instructions file is missing.');
    await expect(panel(page).locator('.goal-prose')).toBeEmpty();
  });
});
