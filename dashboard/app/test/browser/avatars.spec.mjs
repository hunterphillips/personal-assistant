// Agent avatars (public/avatar.js): the round picture beside an agent's
// name, from the agent's folder when it has one, its initials on a badge
// color chosen from its id otherwise. On desk and phone.

import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { expect, test } from '../support/browser-test.mjs';

const AGENTS = [
  { id: 'cfo', name: 'CFO', role: 'Money', description: 'Invented.', group: 'work', kind: 'persona', provider: 'claude', cwd: '/invented/cfo' },
  { id: 'brain', name: 'Second brain', role: 'Notes', description: 'Invented.', group: 'personal', kind: 'persona', provider: 'claude', cwd: '/invented/brain' },
  { id: 'focus', name: 'Focus', role: 'Tasks', description: 'Invented task board.', group: 'personal', kind: 'system', cwd: '/invented/focus' },
];

// The same hash avatar.js uses, so the test names the color it expects.
function colorIndex(id) {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return hash % 6;
}

const rowAvatar = (page, id) => page.locator(`#agents-groups .agent-row[data-agent="${id}"] .avatar`);
const headerAvatar = (page) => page.locator('#agent-panel .thread-title .avatar');
const phone = (page) => page.viewportSize().width < 720;

test.describe('initials', () => {
  test.use({ hubOptions: { agents: AGENTS } });

  test('an agent without a picture shows its initials on a color that stays with its id', async ({ page, hub }) => {
    await page.goto(`${hub.origin}/`);
    const expected = { cfo: 'CF', brain: 'SB', focus: 'FO' };
    const seen = {};
    for (const [id, text] of Object.entries(expected)) {
      const avatar = rowAvatar(page, id);
      await expect(avatar).toHaveAttribute('data-initials', text);
      await expect(avatar).toHaveText('');
      await expect(avatar).toHaveClass(new RegExp(`avatar-badge-${colorIndex(id)}\\b`));
      await expect(avatar.locator('img')).toHaveCount(0);
      seen[id] = await avatar.evaluate((node) => getComputedStyle(node).backgroundColor);
      const badge = await avatar.evaluate((node, index) => {
        const probe = document.createElement('span');
        probe.style.backgroundColor = `var(--badge-${index})`;
        node.parentNode.appendChild(probe);
        const color = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return color;
      }, colorIndex(id));
      expect(seen[id]).toBe(badge);
    }

    // The same colors after a reload, and in the thread header.
    await page.reload();
    for (const id of Object.keys(expected)) {
      await expect(rowAvatar(page, id)).toHaveClass(new RegExp(`avatar-badge-${colorIndex(id)}\\b`));
      expect(await rowAvatar(page, id).evaluate((node) => getComputedStyle(node).backgroundColor)).toBe(seen[id]);
    }
    await page.goto(`${hub.origin}/?agent=brain`);
    await expect(headerAvatar(page)).toHaveAttribute('data-initials', 'SB');
    await expect(headerAvatar(page)).toHaveClass(new RegExp(`avatar-badge-${colorIndex('brain')}\\b`));
  });
});

test.describe('pictures', () => {
  test.use({ hubOptions: { agents: AGENTS, avatars: ['cfo'] } });

  test('an agent with a picture in its folder shows it in the list and the thread header', async ({ page, hub }) => {
    await page.goto(`${hub.origin}/`);
    const image = rowAvatar(page, 'cfo').locator('img');
    await expect(image).toHaveAttribute('src', /^\/api\/agents\/cfo\/avatar\?v=\d+$/);
    await expect.poll(() => image.evaluate((node) => node.complete && node.naturalWidth)).toBe(16);
    await expect(rowAvatar(page, 'cfo')).not.toHaveAttribute('data-initials');
    await expect(rowAvatar(page, 'brain').locator('img')).toHaveCount(0);
    const box = await rowAvatar(page, 'cfo').boundingBox();
    expect([Math.round(box.width), Math.round(box.height)]).toEqual([24, 24]);

    await page.locator('#agents-groups .agent-row[data-agent="cfo"]').click();
    if (phone(page)) await expect(page.locator('#agent-panel')).toBeVisible();
    const header = headerAvatar(page).locator('img');
    await expect(header).toHaveAttribute('src', /^\/api\/agents\/cfo\/avatar\?v=\d+$/);
    await expect.poll(() => header.evaluate((node) => node.complete && node.naturalWidth)).toBe(16);
    const large = await headerAvatar(page).boundingBox();
    expect([Math.round(large.width), Math.round(large.height)]).toEqual([28, 28]);
    // One fetch for the version, however often the list and header redraw.
    expect(hub.requests('/api/agents/cfo/avatar')).toEqual([{ method: 'GET', status: 200 }]);
  });
});

test.describe('a picture that does not load', () => {
  test.use({ hubOptions: { agents: AGENTS, avatars: ['cfo'] } });

  test('shows initials and is not fetched again when the list redraws', async ({ page, hub }) => {
    const cwd = hub.state.snapshot().agents.find((agent) => agent.id === 'cfo').cwd;
    await writeFile(path.join(cwd, 'avatar.png'), 'not a picture');
    await page.goto(`${hub.origin}/`);
    await expect(rowAvatar(page, 'cfo')).toHaveAttribute('data-initials', 'CF');
    await expect(rowAvatar(page, 'cfo').locator('img')).toHaveCount(0);
    await expect.poll(() => hub.state.clientCount()).toBe(1);
    // Chromium may fetch a picture that fails to decode a second time
    // itself; what matters is that redraws add nothing.
    const fetched = hub.requests('/api/agents/cfo/avatar').length;
    expect(fetched).toBeGreaterThan(0);

    // Two redraws of the list from the same agents.
    const { revision, agents } = hub.state.snapshot();
    hub.emitDelta(revision + 1, { agents: agents.map((agent) => ({ ...agent, lastLineAt: new Date().toISOString() })) });
    hub.emitDelta(revision + 2, { agents: agents.map((agent) => ({ ...agent, lastLineAt: new Date(Date.now() + 1000).toISOString() })) });
    await expect(rowAvatar(page, 'cfo')).toHaveAttribute('data-initials', 'CF');
    await page.waitForTimeout(500);
    expect(hub.requests('/api/agents/cfo/avatar').length).toBe(fetched);
  });
});

test.describe('quick chat', () => {
  test.use({ withFocus: false, hubOptions: { agents: AGENTS, avatars: ['cfo'], settings: { quickChat: { agent: 'cfo' } } } });

  test('the picker shows the chosen agent\'s avatar on its button and each agent\'s on its row', async ({ page, hub }) => {
    await page.goto(`${hub.origin}/`);
    if (phone(page)) {
      await page.getByRole('button', { name: 'Menu', exact: true }).click();
      await page.locator('#app-menu').getByRole('button', { name: 'Quick chat', exact: true }).click();
    } else {
      await page.locator('.header-right').getByRole('button', { name: 'Quick chat', exact: true }).click();
    }
    const button = page.locator('#quick-chat-agent');
    await expect(button).toBeVisible();
    await expect(button.locator('.avatar img')).toHaveAttribute('src', /^\/api\/agents\/cfo\/avatar\?v=\d+$/);
    await expect(button).toHaveAccessibleName('CFO');

    await button.click();
    const row = (id) => page.locator(`#quick-chat-agent-list [role="option"][data-agent="${id}"] .avatar`);
    await expect(row('cfo').locator('img')).toHaveAttribute('src', /^\/api\/agents\/cfo\/avatar\?v=\d+$/);
    await expect(row('brain')).toHaveAttribute('data-initials', 'SB');
    await expect(row('brain')).toHaveClass(new RegExp(`avatar-badge-${colorIndex('brain')}\\b`));

    // Choosing another agent puts its initials on the button.
    await page.locator('#quick-chat-agent-list [role="option"][data-agent="brain"]').click();
    await expect(button.locator('.avatar')).toHaveAttribute('data-initials', 'SB');
    await expect(button.locator('.avatar img')).toHaveCount(0);
  });
});
