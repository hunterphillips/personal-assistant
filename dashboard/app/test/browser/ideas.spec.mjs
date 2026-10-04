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

async function openIdeas(page, hub) {
  await page.goto(`${hub.origin}/ideas`);
  await expectView(page, 'ideas', 'Ideas');
  await expect(weeks(page)).toHaveCount(2);
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
    await expect(actions.getByRole('button')).toHaveText(['', 'Add idea']);
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

  test('groups runs into newest-first weeks with kinds and agent names', async ({ page, hub }) => {
    await openIdeas(page, hub);
    await expect(weeks(page).locator('.ideas-week-title')).toHaveText(['Week of September 28', 'Week of September 21']);
    await expect(weeks(page).first().locator('.ideas-item')).toHaveCount(1);
    await expect(weeks(page).nth(1).locator('.ideas-item')).toHaveCount(2);
    await expect(item(page, 'fixture-agent-card').locator('.ideas-title')).toHaveText('Fixture agent card');
    await expect(item(page, 'fixture-agent-card').locator('.ideas-text')).toHaveText('Invented fixture content for a newer run.');
    await expect(item(page, 'fixture-agent-card').locator('.ideas-meta')).toHaveText('view · Assistant');
    await expect(item(page, 'fixture-weekly-map').locator('.ideas-meta')).toHaveText('workflow · Assistant · Focus');
    const source = item(page, 'fixture-reading-tool').getByRole('link', { name: 'Source' });
    await expect(source).toHaveAttribute('href', 'https://example.com/fixture-reading-tool');
    await expect(source).toHaveAttribute('target', '_blank');
    await expect(page.locator('#ideas-message')).toBeHidden();
    await expect(page.locator('#view-ideas [data-action]')).toHaveCount(0);
  });

  test('Dismiss removes the idea and a later run cannot bring its id back', async ({ page, hub }) => {
    await openIdeas(page, hub);
    await item(page, 'fixture-weekly-map').getByRole('button', { name: 'Dismiss' }).click();
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
    await item(page, 'fixture-agent-card').getByRole('button', { name: 'Start' }).click();
    await expectView(page, 'agents', 'Agents');
    await expect(page).toHaveURL(`${hub.origin}/?agent=assistant`);
    await expect(page.locator('#agent-messages .thread-message-context summary'))
      .toHaveText('Sent from Ideas: Fixture agent card');
    expect(hub.personas.sent[0].context.context).toEqual({
      view: 'ideas', label: 'Fixture agent card', detail: 'Invented fixture content for a newer run.',
    });

    await nav(page, 'Ideas').click();
    await expectView(page, 'ideas', 'Ideas');
    await expect(item(page, 'fixture-agent-card').getByRole('link', { name: 'Started with Assistant' })).toBeVisible();
    const next = item(page, 'fixture-reading-tool');
    await next.getByRole('button', { name: 'Start' }).click();
    await expect(next.locator('.ideas-reason')).toHaveText('Assistant is in the middle of a turn. Try again when it is idle.');
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
    await expect(weeks(page).first().locator('.ideas-week-title')).toHaveText('Week of September 28');
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
    await item(page, 'fixture-reading-tool').getByRole('button', { name: 'Discuss' }).click();
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

test.describe('Ideas with an empty store', () => {
  test.use({ withFocus: false, hubOptions: { agents: AGENTS } });

  test('says there are no ideas', async ({ page, hub }) => {
    await page.goto(`${hub.origin}/ideas`);
    await expectView(page, 'ideas', 'Ideas');
    await expect(page.locator('#ideas-message')).toHaveText(/^No ideas yet\./);
    await expect(weeks(page)).toHaveCount(0);
  });
});
