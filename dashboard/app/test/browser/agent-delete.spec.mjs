// A built-in agent, Delete in an agent's settings panel, and the Settings
// row for quick chat, in real browsers against the in-memory registry and
// the real routine store of test/support/browser-server.mjs.

import { expect, test } from '../support/browser-test.mjs';

const AGENTS = [
  { id: 'myos', name: 'Myos', role: 'Guide', description: 'I know how this dashboard and its agents work.', group: 'personal', kind: 'persona',
    provider: 'claude', cwd: '/invented/repo', builtin: true },
  { id: 'assistant', name: 'Assistant', role: 'Assistant', description: 'Invented.', group: 'personal', kind: 'persona', provider: 'claude',
    cwd: '/invented/repo', pinned: true },
  { id: 'cfo', name: 'CFO', role: 'Money', description: 'Invented.', group: 'work', kind: 'persona', provider: 'claude', cwd: '/invented/cfo' },
  { id: 'scout', name: 'Scout', role: 'Files', description: 'Invented.', group: 'work', kind: 'persona', provider: 'claude', cwd: '/invented/scout' },
];

const ROUTINES = [
  { id: 'cfo-drift', name: 'Daily drift', agent: 'cfo', instruction: 'Compute drift.', cron: '30 6 * * 1-5' },
];

test.use({
  hubOptions: {
    build: () => ({
      agents: AGENTS,
      routines: ROUTINES,
      settings: { brief: { agent: 'cfo' }, quickChat: { agent: 'myos' } },
      personas: { scout: { state: 'busy' } },
    }),
  },
});

const details = (page) => page.locator('#agent-details');
const deleteFoot = (page) => page.locator('#agent-delete');

async function openSettings(page, hub, id) {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${hub.origin}/?agent=${id}`);
  await page.locator('#agent-details-toggle').click();
  await expect(details(page)).toBeVisible();
}

test('a built-in agent is listed with its thread, is editable, and offers no Delete', async ({ page, hub }) => {
  await openSettings(page, hub, 'myos');
  await expect(page.locator('#agent-name')).toHaveText('Myos');
  await expect(details(page).locator('#agent-form-name')).toHaveValue('Myos');
  await expect(details(page).locator('#agent-form-description')).toBeEditable();
  await expect(deleteFoot(page)).toBeHidden();
  await expect(page.getByRole('button', { name: 'Delete', exact: true })).toHaveCount(0);
});

test('Delete asks inline with what goes and where the brief moves; Cancel keeps the agent; Delete removes it and its routines', async ({ page, hub }) => {
  await openSettings(page, hub, 'cfo');
  await expect(deleteFoot(page)).toBeVisible();
  const confirm = page.locator('#agent-delete-confirm');
  await expect(confirm).toBeHidden();

  await deleteFoot(page).getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(confirm).toBeVisible();
  await expect(page.locator('#agent-delete-text')).toHaveText(
    'Delete CFO? This removes it from the registry with its routines and their runs. Its thread stays on disk. The brief will go to Myos.',
  );
  await expect(confirm.getByRole('button', { name: 'Delete', exact: true })).toBeFocused();
  // Destructive, not the primary teal: the theme's red behind it.
  const red = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--red').trim());
  const background = await confirm.getByRole('button', { name: 'Delete', exact: true }).evaluate((node) => getComputedStyle(node).backgroundColor);
  const probe = await page.evaluate((value) => { const el = document.createElement('i'); el.style.color = value; document.body.appendChild(el); const c = getComputedStyle(el).color; el.remove(); return c; }, red);
  expect(background).toBe(probe);

  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await expect(confirm).toBeHidden();
  await expect(deleteFoot(page).getByRole('button', { name: 'Delete', exact: true })).toBeFocused();
  expect(hub.requests('/api/agents/cfo')).toEqual([]);

  await deleteFoot(page).getByRole('button', { name: 'Delete', exact: true }).click();
  await confirm.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.locator('.agent-row', { hasText: 'CFO' })).toHaveCount(0);
  await expect.poll(() => hub.requests('/api/agents/cfo')).toEqual([{ method: 'DELETE', status: 200 }]);
  expect(hub.state.snapshot().agents.some((agent) => agent.id === 'cfo')).toBe(false);
  expect(hub.routines.current()).toEqual([]);
  expect(hub.settings.current().settings.brief.agent).toBe('myos');
  await expect(page).not.toHaveURL(/agent=cfo/);
});

test('a Delete the daemon refuses says why in a sentence and changes nothing', async ({ page, hub }) => {
  await openSettings(page, hub, 'scout');
  await deleteFoot(page).getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.locator('#agent-delete-text')).toHaveText(
    'Delete Scout? This removes it from the registry with its routines and their runs. Its thread stays on disk.',
  );
  await page.locator('#agent-delete-confirm').getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.locator('#agent-delete-refusal')).toHaveText('Scout is in the middle of a turn. Delete it once the turn ends.');
  await expect(page.locator('#agent-delete-confirm')).toBeHidden();
  expect(hub.state.snapshot().agents.some((agent) => agent.id === 'scout')).toBe(true);
  expect(hub.registry.writes).toEqual([]);
});

test('Settings shows "Quick chat talks to" over the Claude agents and saves a change', async ({ page, hub }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${hub.origin}/health`);
  const quickChat = page.locator('#settings-card').getByLabel('Quick chat talks to', { exact: true });
  await expect(quickChat).toHaveValue('myos');
  expect(await quickChat.locator('option').allTextContents()).toEqual(['Myos', 'Assistant', 'CFO', 'Scout']);
  await quickChat.selectOption('assistant');
  await expect(page.locator('#settings-status')).toHaveText('Saved.');
  expect(hub.settings.current().settings.quickChat).toEqual({ agent: 'assistant' });
  await expect(quickChat).toHaveValue('assistant');
});
