// Quick chat: the header's pane over every view, its picker of Claude
// agents, the thread it shares with the Agents view, and the context line
// the first message after it opens carries. Every agent, job, feed item,
// and message here is invented; the servers are the isolated test hub.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, expectView, nav, test } from '../support/browser-test.mjs';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const MINUTE = 60_000;

const persona = (fields) => ({
  description: 'Invented.', group: 'personal', kind: 'persona', cwd: '/invented', provider: 'claude', ...fields,
});
const AGENTS = [
  persona({ id: 'assistant', name: 'Assistant', role: 'Assistant', pinned: true }),
  persona({ id: 'myos', name: 'Myos', role: 'Helper', builtin: true }),
  persona({ id: 'cfo', name: 'CFO', role: 'Money', group: 'work', jobs: ['com.hunter.cfo.daily'] }),
  persona({ id: 'scribe', name: 'Scribe', role: 'Drafts', group: 'work', provider: 'codex' }),
];

const ago = (ms) => new Date(Date.now() - ms).toISOString();

function job(label, fields) {
  return {
    label, agentId: 'cfo', agentName: 'CFO', name: label.replace(/^com\.hunter\./, ''),
    schedule: { kind: 'calendar', text: 'Daily at 06:00' }, logPath: '/invented/logs/job.log',
    lastRun: ago(12 * MINUTE), outcome: 'ok', exitStatus: 0, failures24h: null, paused: null, source: 'launchctl', available: true,
    ...fields,
  };
}

function hubOptions(extra = {}) {
  return {
    build: () => ({
      agents: AGENTS,
      settings: { brief: { agent: 'assistant' }, quickChat: { agent: 'myos' } },
      personas: {
        myos: { messages: [{ role: 'user', text: 'Invented question.', at: ago(5 * MINUTE) }, { role: 'assistant', text: 'Invented answer.', at: ago(4 * MINUTE) }] },
      },
      jobs: {
        items: [job('com.hunter.cfo.daily', { outcome: 'failed', exitStatus: 78 }), job('com.hunter.cfo.weekly')],
        focusAvailable: true, refreshedAt: ago(5_000),
      },
      ...extra,
    }),
  };
}

const pane = (page) => page.locator('#quick-chat');
const picker = (page) => page.locator('#quick-chat-agent');
const paneMessages = (page) => page.locator('#quick-chat-messages .thread-message');
const paneInput = (page) => page.locator('#quick-chat-input');
const phone = (page) => page.viewportSize().width < 720;

// The header entry on a desk; on a phone it is in the menu.
async function openPane(page) {
  if (phone(page)) {
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
    await page.locator('#app-menu').getByRole('button', { name: 'Quick chat', exact: true }).click();
  } else {
    await page.locator('.header-right').getByRole('button', { name: 'Quick chat', exact: true }).click();
  }
  await expect(pane(page)).toBeVisible();
}

async function send(page, text) {
  await paneInput(page).fill(text);
  await pane(page).getByRole('button', { name: 'Send', exact: true }).click();
}

test.describe('quick chat', () => {
  test.use({ withFocus: false, hubOptions: hubOptions() });

  test('opens over every view with the agent Settings names, lists only Claude agents, and closes with Escape or Close', async ({ page, hub }) => {
    const views = [['/', 'agents', 'Agents'], ['/reading', 'reading', 'Feed'], ['/focus', 'focus', 'Focus'], ['/goals', 'goals', 'Goals'], ['/health', 'health', 'Health']];
    for (const [route, view, title] of views) {
      await page.goto(hub.origin + route);
      await expectView(page, view, title);
      await openPane(page);
      await expect(picker(page)).toHaveValue('myos');
      expect(await picker(page).locator('option').allTextContents()).toEqual(['Assistant', 'Myos', 'CFO']);
      await expect(paneMessages(page)).toHaveCount(2);
      await expect(page.locator(`#view-${view}`)).toBeVisible();
      if (view === 'goals') {
        await pane(page).getByRole('button', { name: 'Close quick chat' }).click();
      } else {
        await paneInput(page).focus();
        await page.keyboard.press('Escape');
      }
      await expect(pane(page)).toBeHidden();
      await expectView(page, view, title);
    }
  });

  test('shows the thread the Agents view shows, and a message sent from either lands in the one thread', async ({ page, hub }) => {
    await page.goto(`${hub.origin}/?agent=myos`);
    await expect(page.locator('#agent-messages .thread-message')).toHaveCount(2);
    await openPane(page);
    await expect(paneMessages(page)).toHaveText([/Invented question\./, /Invented answer\./]);

    await send(page, 'From the pane.');
    await expect(paneMessages(page)).toHaveCount(5);
    await expect(paneMessages(page).nth(4)).toContainText('Reply: From the pane.');
    await expect(page.locator('#agent-messages .thread-message')).toHaveCount(5);
    await page.keyboard.press('Escape');
    await expect(pane(page)).toBeHidden();

    await page.locator('#agent-input').fill('From the Agents view.');
    await page.locator('#agent-send').click();
    await expect(page.locator('#agent-messages .thread-message')).toHaveCount(7);
    await openPane(page);
    await expect(paneMessages(page)).toHaveCount(7);
    expect(hub.personas.sent.map((entry) => [entry.id, entry.text])).toEqual([
      ['myos', 'From the pane.'], ['myos', 'From the Agents view.'],
    ]);
  });

  test('a draft typed in the pane is in the composer when the Agents view opens that agent', async ({ page, hub }) => {
    await page.goto(`${hub.origin}/goals`);
    await openPane(page);
    await paneInput(page).fill('Half a thought');
    await pane(page).getByRole('button', { name: 'Close quick chat' }).click();
    await nav(page, 'Home').click();
    await page.locator('#agents-list .agent-row[data-agent="myos"]').click();
    await expect(page.locator('#agent-name')).toHaveText('Myos');
    await expect(page.locator('#agent-input')).toHaveValue('Half a thought');
    expect(hub.personas.sent).toEqual([]);
  });

  test('the picker switches the thread, and the choice lasts for the page session', async ({ page, hub }) => {
    await page.goto(`${hub.origin}/health`);
    await openPane(page);
    await picker(page).selectOption('cfo');
    await expect(page.locator('#quick-chat-messages .thread-line')).toHaveText('No messages yet.');
    await expect(page.locator('#quick-chat-input-label')).toHaveText('Message CFO');
    await send(page, 'Hello CFO.');
    await expect(paneMessages(page)).toHaveCount(3);
    expect(hub.personas.sent.map((entry) => entry.id)).toEqual(['cfo']);

    await page.keyboard.press('Escape');
    await openPane(page);
    await expect(picker(page)).toHaveValue('cfo');
    await page.reload();
    await openPane(page);
    await expect(picker(page)).toHaveValue('cfo');
    await expect(page.locator('#quick-chat-input-label')).toHaveText('Message CFO');
  });

  test('the first message after opening on Health carries the selected job; the next carries nothing; a new view sends its name', async ({ page, hub }) => {
    await page.goto(`${hub.origin}/health`);
    await page.locator('.job-row', { hasText: 'cfo.daily' }).click();
    await expect(page.locator('.job-row[aria-current="true"]')).toHaveCount(1);
    await openPane(page);

    await send(page, 'What failed here?');
    const line = page.locator('#quick-chat-messages .thread-message-context');
    await expect(line).toHaveCount(1);
    const summary = line.locator('summary');
    await expect(summary).toHaveText('Sent from Health: cfo.daily');
    await expect(line.locator('.thread-context-detail')).toBeHidden();
    await summary.click();
    await expect(line.locator('.thread-context-detail')).toContainText('Outcome: failed (exit 78)');
    await expect(paneMessages(page).nth(3)).toHaveText(/What failed here\?/);
    await expect(paneMessages(page)).toHaveCount(5);

    const first = hub.personas.sent[0];
    expect(first.text).toBe('What failed here?');
    expect(first.context.context.view).toBe('health');
    expect(first.context.context.label).toBe('cfo.daily');
    expect(first.context.context.detail).toContain('Job: com.hunter.cfo.daily');
    expect(first.context.context.detail).toContain('Agent: CFO');
    expect(first.context.context.detail).toContain('Schedule: Daily at 06:00');

    await send(page, 'And now?');
    await expect(paneMessages(page)).toHaveCount(7);
    expect(hub.personas.sent[1].context.context).toBeUndefined();
    await expect(line).toHaveCount(1);

    // The view under the pane changes: the next message says where it came from.
    await nav(page, 'Goals').click();
    await expect(pane(page)).toBeVisible();
    await send(page, 'One more.');
    await expect(page.locator('#quick-chat-messages .thread-message-context')).toHaveCount(2);
    await expect(page.locator('#quick-chat-messages .thread-message-context').nth(1)).toHaveText(/Sent from Goals\./);
    expect(hub.personas.sent[2].context.context).toEqual({ view: 'goals' });
  });

  test('from the Agents view the context is the open agent and its state', async ({ page, hub }) => {
    await page.goto(`${hub.origin}/?agent=cfo`);
    await expect(page.locator('#agent-name')).toHaveText('CFO');
    await openPane(page);
    await send(page, 'About CFO.');
    await expect(page.locator('#quick-chat-messages .thread-message-context')).toHaveText(/Sent from Agents: CFO/);
    expect(hub.personas.sent[0].context.context).toEqual({ view: 'agents', label: 'CFO', detail: 'State: Idle' });
  });

  test('opening the pane on an agent with a new reply marks it read in every page', async ({ page, hub }) => {
    const second = await page.context().newPage();
    try {
      await Promise.all([page.goto(hub.origin + '/goals'), second.goto(hub.origin + '/goals')]);
      await hub.state.notify('myos', { role: 'system', kind: 'brief', date: '2026-10-03', state: 'ready', summary: 'Invented brief.', text: 'Invented brief.' });
      for (const current of [page, second]) await expect(current.locator('#agents-indicator')).toBeVisible();
      await openPane(page);
      for (const current of [page, second]) await expect(current.locator('#agents-indicator')).toBeHidden();
      expect(hub.state.snapshot().agents.find((agent) => agent.id === 'myos').unread).toBe(false);
    } finally {
      await second.close();
    }
  });
});

test.describe('quick chat over the Feed', () => {
  test.use({ withFocus: false, hubOptions: hubOptions({ feed: path.join(FIXTURES, 'feed') }) });

  test('the context is the topmost item in view', async ({ page, hub }) => {
    await page.goto(`${hub.origin}/reading`);
    const items = page.locator('#feed-runs .feed-item');
    await expect(items.first()).toBeVisible();
    const second = await items.nth(1).locator('.feed-title').textContent();
    await items.nth(1).evaluate((node) => node.scrollIntoView({ block: 'start' }));
    await openPane(page);
    await send(page, 'Summarize this one.');
    await expect(page.locator('#quick-chat-messages .thread-message-context')).toHaveText(new RegExp(`Sent from Feed: ${second.trim()}`));
    const context = hub.personas.sent[0].context.context;
    expect(context.view).toBe('feed');
    expect(context.label).toBe(second.trim());
    expect(context.detail).toMatch(/^Source: .+\nURL: https:\/\/example\.com\/.+\nSummary: /);
  });
});

test.describe('quick chat with no Claude agent', () => {
  test.use({ withFocus: false, hubOptions: { agents: [AGENTS[3]] } });

  test('the pane says so and offers no composer', async ({ page, hub }) => {
    await page.goto(`${hub.origin}/health`);
    await openPane(page);
    await expect(page.locator('#quick-chat-empty')).toHaveText('No Claude agent is registered.');
    await expect(picker(page)).toBeHidden();
    await expect(paneInput(page)).toBeHidden();
  });
});
