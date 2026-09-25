// The Agents view in real browsers against the in-memory registry and the
// fake persona adapter of test/support/browser-server.mjs.

import { expect, expectView, nav, test } from '../support/browser-test.mjs';

const MINUTE = 60_000;
const ago = (ms) => new Date(Date.now() - ms).toISOString();

const AGENTS = [
  { id: 'cfo', name: 'CFO', role: 'Money', description: 'Invented.', group: 'work', kind: 'persona', provider: 'claude' },
  { id: 'catchup', name: 'Catchup', role: 'Work', description: 'Invented work folder.', group: 'work', kind: 'project', provider: 'codex' },
  { id: 'brain', name: 'Second brain', role: 'Notes', description: 'Invented.', group: 'personal', kind: 'persona', provider: 'claude' },
  { id: 'dev', name: 'Dev', role: 'Code', description: 'Invented.', group: 'personal', kind: 'persona', provider: 'codex' },
  { id: 'focus', name: 'Focus', role: 'Tasks', description: 'Invented task board.', group: 'personal', kind: 'system' },
];

const QUESTION = 'Which color do you want?';
const QUESTION_REQUEST = {
  kind: 'question',
  toolName: 'AskUserQuestion',
  input: {
    questions: [{
      question: QUESTION,
      header: 'Color',
      options: [{ label: 'Blue', description: 'Cool.' }, { label: 'Amber', description: 'Warm.' }],
      multiSelect: false,
    }],
  },
};

function seeded(extra = {}) {
  return {
    build: () => ({
      agents: AGENTS,
      personas: {
        cfo: {
          messages: [
            { role: 'user', text: 'How is cash?', at: ago(20 * MINUTE) },
            { role: 'assistant', text: 'Cash is fine.', at: ago(12 * MINUTE) },
          ],
        },
        brain: { state: 'waiting', pending: QUESTION_REQUEST },
        ...extra,
      },
    }),
  };
}

function row(page, name) {
  return page.locator('.agent-row').filter({ has: page.locator('.agent-row-name', { hasText: new RegExp(`^${name}$`) }) });
}

const pane = (page) => page.locator('#agent-panel');
const messages = (page) => page.locator('#agent-messages .thread-message');

test.describe('with seeded agents', () => {
  test.use({ hubOptions: seeded() });

  test('the list groups agents under Work and Personal with role and provider chips', async ({ page, hub }) => {
    await page.goto(`${hub.origin}/agents`);
    await expectView(page, 'agents', 'Agents');
    await expect(page.locator('.agent-group-heading')).toHaveText(['Work', 'Personal']);
    await expect(page.locator('.agent-row .agent-row-name')).toHaveText(['CFO', 'Catchup', 'Second brain', 'Dev', 'Focus']);

    const cfo = row(page, 'CFO');
    await expect(cfo.locator('.role-chip')).toHaveText('Money');
    await expect(cfo.locator('.provider-chip')).toHaveText('Claude');
    await expect(cfo.locator('.agent-row-preview')).toHaveText('Cash is fine.');
    await expect(cfo.locator('.agent-row-time')).toHaveText('12 minutes ago');
    await expect(cfo.locator('.agent-row-state')).toHaveCount(0);
    await expect(cfo).toHaveAttribute('href', '/agents?agent=cfo');

    const catchup = row(page, 'Catchup');
    await expect(catchup).not.toHaveAttribute('href', /.*/);
    await expect(catchup.locator('.provider-chip')).toHaveText('Codex');
    await expect(catchup.locator('.agent-row-preview')).toHaveText('Invented work folder.');
    await expect(catchup.locator('.agent-row-state')).toHaveCount(0);

    await expect(row(page, 'Second brain').locator('.agent-row-state')).toHaveText('Waiting for you');
    await expect(row(page, 'Dev').locator('.agent-row-state')).toHaveText('Unavailable');
    await expect(row(page, 'Focus').locator('.provider-chip')).toHaveCount(0);
    await expect(row(page, 'Focus').locator('.agent-row-state')).toHaveCount(0);

    for (const link of await page.locator('a.agent-row').all()) {
      expect((await link.boundingBox()).height).toBeGreaterThanOrEqual(44);
    }
    expect(hub.personas.calls).toEqual([]);
  });

  test('Home says who is waiting and the nav lists Agents', async ({ page, hub }) => {
    await page.goto(`${hub.origin}/`);
    await expect(page.getByRole('navigation', { name: 'Dashboard' }).getByRole('link'))
      .toHaveText(['Home', 'Agents', 'Routines', 'Focus', 'Daily Brief']);
    await expect(page.locator('#home-agents')).toHaveText('Second brain is waiting for you');
    await page.locator('#view-home').getByRole('link', { name: /Agents/ }).click();
    await expect(page).toHaveURL(`${hub.origin}/agents`);
    await expectView(page, 'agents', 'Agents');
  });

  test('opening a persona shows its thread, and a reload lands on it', async ({ page, hub }) => {
    await page.goto(`${hub.origin}/agents`);
    await row(page, 'CFO').click();
    await expect(page).toHaveURL(`${hub.origin}/agents?agent=cfo`);
    await expect(pane(page).locator('#agent-name')).toHaveText('CFO');
    await expect(pane(page).locator('#agent-chips .role-chip')).toHaveText('Money');
    await expect(pane(page).locator('#agent-chips .provider-chip')).toHaveText('Claude');
    await expect(messages(page)).toHaveText(['How is cash?', 'Cash is fine.'].map((text) => new RegExp(`^${text}`)));
    await expect(messages(page).nth(0)).toHaveClass(/thread-message-user/);
    await expect(messages(page).nth(1)).toHaveClass(/thread-message-assistant/);
    await expect(messages(page).nth(1).locator('.thread-message-meta')).toHaveText('12 minutes ago');
    await expect(page.locator('#agent-input-label')).toHaveText('Message CFO');
    await expect(page.locator('#agent-send')).toBeEnabled();
    await expect(page.locator('#agent-composer-reason')).toBeHidden();
    await expect(page.locator('#agent-new-thread')).toBeEnabled();
    await expect(row(page, 'CFO')).toHaveAttribute('aria-current', 'true');

    await page.reload();
    await expectView(page, 'agents', 'Agents');
    await expect(pane(page).locator('#agent-name')).toHaveText('CFO');
    await expect(messages(page)).toHaveCount(2);

    await nav(page, 'Agents').click();
    await expect(page).toHaveURL(`${hub.origin}/agents`);
    await expect(pane(page)).toBeHidden();
  });

  test('sending shows the message, the working line with Interrupt, and then the reply', async ({ page, hub }) => {
    hub.personas.hold('cfo');
    await page.goto(`${hub.origin}/agents?agent=cfo`);
    await expect(messages(page)).toHaveCount(2);
    await page.locator('#agent-input').fill('What about next month?');
    await page.locator('#agent-send').click();

    await expect(messages(page)).toHaveCount(3);
    await expect(messages(page).nth(2)).toHaveText(/^What about next month\?/);
    await expect(messages(page).nth(2)).toHaveClass(/thread-message-user/);
    await expect(page.locator('#agent-input')).toHaveValue('');
    await expect(page.locator('#agent-status-text')).toHaveText('CFO is working.');
    await expect(page.locator('#agent-status').getByRole('button', { name: 'Interrupt' })).toBeEnabled();
    await expect(page.locator('#agent-send')).toBeDisabled();
    await expect(page.locator('#agent-composer-reason')).toHaveText('CFO is working. Wait for the reply or interrupt.');
    await expect(page.locator('#agent-new-thread')).toBeDisabled();
    await expect(row(page, 'CFO').locator('.agent-row-state')).toHaveText('Working');
    await expect(row(page, 'CFO').locator('.agent-row-preview')).toHaveText('You: What about next month?');

    await hub.personas.reply('cfo', 'Next month looks fine.');
    await expect(messages(page)).toHaveCount(4);
    await expect(messages(page).nth(3)).toHaveText(/^Next month looks fine\./);
    await expect(page.locator('#agent-status')).toBeHidden();
    await expect(page.locator('#agent-send')).toBeEnabled();
    await expect(page.locator('#agent-cost')).toHaveText('$0.01 this session');
    await expect(row(page, 'CFO').locator('.agent-row-state')).toHaveCount(0);
    expect(hub.personas.calls).toEqual([['send', 'cfo', 'What about next month?']]);
  });

  test('Interrupt ends the turn', async ({ page, hub }) => {
    hub.personas.hold('cfo');
    await page.goto(`${hub.origin}/agents?agent=cfo`);
    await page.locator('#agent-input').fill('Take your time.');
    await page.locator('#agent-send').click();
    await expect(page.locator('#agent-status')).toBeVisible();
    await page.locator('#agent-status').getByRole('button', { name: 'Interrupt' }).click();
    await expect(page.locator('#agent-status')).toBeHidden();
    await expect(page.locator('#agent-send')).toBeEnabled();
    await expect(messages(page)).toHaveCount(3);
  });

  test('a pending question renders its options, and answering clears the Waiting line and the card', async ({ page, hub }) => {
    await page.goto(`${hub.origin}/agents?agent=brain`);
    const request = page.locator('#agent-request');
    await expect(request).toBeVisible();
    await expect(request.locator('.request-chip')).toHaveText('Color');
    await expect(request.locator('.request-title')).toHaveText(QUESTION);
    const options = request.locator('.option');
    await expect(options.locator('.option-label')).toHaveText(['Blue', 'Amber']);
    await expect(options.locator('.option-description')).toHaveText(['Cool.', 'Warm.']);
    await expect(request.locator('.request-other-field')).toBeVisible();
    await expect(page.locator('#agent-send')).toBeDisabled();
    await expect(page.locator('#agent-composer-reason')).toHaveText('Answer the question first.');
    await expect(row(page, 'Second brain').locator('.agent-row-state')).toHaveText('Waiting for you');
    for (const button of await request.getByRole('button').all()) {
      expect((await button.boundingBox()).height).toBeGreaterThanOrEqual(44);
    }

    await request.getByRole('button', { name: 'Answer' }).click();
    await expect(request.locator('.request-missing')).toHaveText('Every question needs an answer.');
    expect(hub.personas.calls).toEqual([]);

    await options.nth(1).click();
    await expect(options.nth(1)).toHaveAttribute('aria-pressed', 'true');
    await options.nth(0).click();
    await expect(options.nth(0)).toHaveAttribute('aria-pressed', 'true');
    await expect(options.nth(1)).toHaveAttribute('aria-pressed', 'false');
    await options.nth(1).click();
    await request.getByRole('button', { name: 'Answer' }).click();

    await expect(request).toBeHidden();
    await expect(row(page, 'Second brain').locator('.agent-row-state')).toHaveCount(0, { timeout: 10_000 });
    await expect(messages(page)).toHaveText([/^Reply: answered/]);
    await expect(page.locator('#agent-send')).toBeEnabled();
    expect(hub.personas.calls).toEqual([['answer', 'brain', expect.stringMatching(/^req-/), { answers: { [QUESTION]: 'Amber' } }]]);
  });

  test('a typed Other answer is sent as the label', async ({ page, hub }) => {
    await page.goto(`${hub.origin}/agents?agent=brain`);
    const request = page.locator('#agent-request');
    await request.locator('.request-other-field').fill('Teal');
    await request.getByRole('button', { name: 'Answer' }).click();
    await expect(request).toBeHidden();
    expect(hub.personas.calls[0][3]).toEqual({ answers: { [QUESTION]: 'Teal' } });
  });

  test('a pending approval shows the tool and its input, and Deny resolves it', async ({ page, hub }) => {
    hub.personas.hold('cfo');
    await page.goto(`${hub.origin}/agents?agent=cfo`);
    await page.locator('#agent-input').fill('List the files.');
    await page.locator('#agent-send').click();
    await expect(page.locator('#agent-status')).toBeVisible();

    hub.personas.raise('cfo', { kind: 'approval', toolName: 'Bash', input: { command: 'ls', description: 'List files' } });
    const request = page.locator('#agent-request');
    await expect(request.locator('.request-title')).toHaveText('CFO wants to run Bash');
    await expect(request.locator('.request-input')).toHaveText('{\n  "command": "ls",\n  "description": "List files"\n}');
    await expect(request.locator('.request-note')).toHaveCount(0);
    await expect(request.getByRole('button')).toHaveText(['Allow', 'Deny']);
    await expect(page.locator('#agent-composer-reason')).toHaveText('Allow or deny the request first.');
    await expect(row(page, 'CFO').locator('.agent-row-state')).toHaveText('Waiting for you');
    await expect(page.locator('#home-agents')).toHaveCount(1);

    await request.getByRole('button', { name: 'Deny' }).click();
    await expect(request).toBeHidden();
    await expect(page.locator('#agent-status-text')).toHaveText('CFO is working.');
    await expect(row(page, 'CFO').locator('.agent-row-state')).toHaveText('Working');
    expect(hub.personas.calls.at(-1)).toEqual(['answer', 'cfo', expect.stringMatching(/^req-/), { decision: 'deny' }]);

    // A second approval whose input is over the snapshot cap arrives cut.
    hub.personas.raise('cfo', { kind: 'approval', toolName: 'Write', input: { content: 'x'.repeat(20_000) } });
    await expect(request.locator('.request-title')).toHaveText('CFO wants to run Write');
    await expect(request.locator('.request-note')).toHaveText('Input cut at 16 KB.');
    expect((await request.locator('.request-input').textContent()).length).toBeLessThan(17_000);
    await request.getByRole('button', { name: 'Allow' }).click();
    await expect(request).toBeHidden();
    expect(hub.personas.calls.at(-1)[3]).toEqual({ decision: 'allow' });
  });

  test('New thread asks inline, then starts the persona over', async ({ page, hub }) => {
    await page.goto(`${hub.origin}/agents?agent=cfo`);
    await expect(messages(page)).toHaveCount(2);
    await page.locator('#agent-new-thread').click();
    const confirm = page.locator('#agent-confirm');
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText('Start a new thread?');
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await expect(confirm).toBeHidden();
    expect(hub.personas.calls).toEqual([]);

    await page.locator('#agent-new-thread').click();
    await confirm.getByRole('button', { name: 'Start new thread' }).click();
    await expect(confirm).toBeHidden();
    await expect(messages(page)).toHaveText([/^New thread/]);
    await expect(messages(page).first()).toHaveClass(/thread-message-system/);
    await expect(row(page, 'CFO').locator('.agent-row-preview')).toHaveText('New thread');
    expect(hub.personas.calls).toEqual([['newThread', 'cfo']]);
  });

  test('an unavailable persona shows why and a disabled composer', async ({ page, hub }) => {
    await page.goto(`${hub.origin}/agents?agent=dev`);
    await expect(pane(page).locator('#agent-name')).toHaveText('Dev');
    await expect(page.locator('#agent-composer-reason')).toHaveText('There is no runtime for Codex yet.');
    await expect(page.locator('#agent-input')).toBeDisabled();
    await expect(page.locator('#agent-send')).toBeDisabled();
    await expect(page.locator('#agent-new-thread')).toBeDisabled();
    await expect(page.locator('#agent-messages')).toBeEmpty();
    expect(hub.requests('/api/agents/dev/thread')).toEqual([]);
  });

  test('a failed turn shows the adapter sentence and keeps the composer open', async ({ page, hub }) => {
    hub.personas.hold('cfo');
    await page.goto(`${hub.origin}/agents?agent=cfo`);
    await page.locator('#agent-input').fill('Resume please.');
    await page.locator('#agent-send').click();
    await expect(page.locator('#agent-status')).toBeVisible();
    hub.personas.fail('cfo', 'The stored session could not be resumed. Start a new thread.');
    await expect(page.locator('#agent-notice')).toHaveText('The stored session could not be resumed. Start a new thread.');
    await expect(page.locator('#agent-send')).toBeEnabled();
    await expect(page.locator('#agent-new-thread')).toBeEnabled();
    await expect(row(page, 'CFO').locator('.agent-row-state')).toHaveText('The last turn failed');
  });

  test('a refused send is reported under the composer', async ({ page, hub }) => {
    await page.route('**/api/agents/cfo/send', (route) => route.fulfill({
      status: 503, contentType: 'application/json', body: '{"error":"shutting_down"}',
    }));
    await page.goto(`${hub.origin}/agents?agent=cfo`);
    await page.locator('#agent-input').fill('Anyone there?');
    await page.locator('#agent-send').click();
    await expect(page.locator('#agent-failure')).toHaveText('The dashboard is shutting down. Try again in a moment.');
    await expect(page.locator('#agent-input')).toHaveValue('Anyone there?');
    await expect(page.locator('#agent-send')).toBeEnabled();
  });

  test('at phone width the list comes first and a row opens the thread full width with a way back', async ({ page, hub }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${hub.origin}/agents`);
    await expect(page.locator('#agents-list')).toBeVisible();
    await expect(page.locator('#agent-thread')).toBeHidden();

    await row(page, 'CFO').click();
    await expect(page.locator('#agents-list')).toBeHidden();
    await expect(page.locator('#agent-thread')).toBeVisible();
    expect((await page.locator('#agent-thread').boundingBox()).width).toBe(390);
    const back = page.locator('#agent-back');
    await expect(back).toBeVisible();
    await expect(back).toHaveText('All agents');
    expect((await back.boundingBox()).height).toBeGreaterThanOrEqual(44);
    await expect(messages(page)).toHaveCount(2);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);

    await back.click();
    await expect(page).toHaveURL(`${hub.origin}/agents`);
    await expect(page.locator('#agents-list')).toBeVisible();
    await expect(page.locator('#agent-thread')).toBeHidden();

    await page.goBack();
    await expect(page).toHaveURL(`${hub.origin}/agents?agent=cfo`);
    await expect(page.locator('#agent-thread')).toBeVisible();
  });
});

test.describe('with no agents', () => {
  test('the list says none are registered', async ({ page, hub }) => {
    await page.goto(`${hub.origin}/agents`);
    await expect(page.locator('#agents-message')).toHaveText('No agents are registered.');
    await expect(page.locator('#home-agents')).toBeHidden();
  });
});
