// The Agents view, the page at `/`, in real browsers against the in-memory
// registry, routines, and fake persona adapter of
// test/support/browser-server.mjs. The jobs are on the Health view, covered
// in routines.spec.mjs.

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

// CFO's two jobs; the other agents have none.
const ROUTINES = ['com.hunter.cfo.daily', 'com.hunter.cfo.weekly'].map((label, i) => ({
  label,
  agentId: 'cfo',
  agentName: 'CFO',
  name: label.replace(/^com\.hunter\./, ''),
  schedule: { kind: 'calendar', text: i === 0 ? 'Daily at 06:00' : 'Mondays at 06:00' },
  logPath: `/invented/logs/${label}.log`,
  lastRun: ago((i + 1) * 30 * MINUTE),
  outcome: i === 0 ? 'ok' : 'failed',
  exitStatus: i === 0 ? 0 : 1,
  failures24h: null,
  paused: null,
  source: 'launchctl',
  available: true,
}));

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
      routines: { items: ROUTINES, focusAvailable: true, refreshedAt: ago(5_000) },
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
const phone = (page) => page.viewportSize().width < 720;

// Counts rebuilds of the element's children from now on (a rebuild clears
// them first: one mutation record with removed nodes) and follows the 720px
// query. Its listener was added after the view's, so by the time it has
// seen a crossing the view has handled it.
async function watchRebuilds(page, selector) {
  await page.evaluate((sel) => {
    window.__rebuilds = 0;
    new MutationObserver((records) => {
      for (const record of records) if (record.removedNodes.length > 0) window.__rebuilds += 1;
    }).observe(document.querySelector(sel), { childList: true });
    const wide = window.matchMedia('(min-width: 720px)');
    window.__wide = wide.matches;
    wide.addEventListener('change', (event) => { window.__wide = event.matches; });
  }, selector);
}
const rebuilds = (page) => page.evaluate(() => window.__rebuilds);
const crossed = (page, wide) => expect.poll(() => page.evaluate(() => window.__wide)).toBe(wide);
const historyLength = (page) => page.evaluate(() => history.length);

test.describe('with seeded agents', () => {
  test.use({ hubOptions: seeded() });

  test('the list groups agents under Work and Personal with role and provider chips', async ({ page, hub }) => {
    await page.goto(`${hub.origin}/`);
    await expectView(page, 'agents', 'Agents');
    await expect(page.locator('.agent-group-heading')).toHaveText(['Work', 'Personal']);
    await expect(page.locator('#agents-groups .agent-row .agent-row-name')).toHaveText(['CFO', 'Catchup', 'Second brain', 'Dev', 'Focus']);

    const cfo = row(page, 'CFO');
    await expect(cfo.locator('.role-chip')).toHaveText('Money');
    await expect(cfo.locator('.provider-chip')).toHaveText('Claude');
    await expect(cfo.locator('.agent-row-preview')).toHaveText('Cash is fine.');
    await expect(cfo.locator('.agent-row-time')).toHaveText('12 minutes ago');
    await expect(cfo.locator('.agent-row-state')).toHaveCount(0);
    await expect(cfo).toHaveAttribute('href', '/?agent=cfo');

    const catchup = row(page, 'Catchup');
    await expect(catchup).not.toHaveAttribute('href', /.*/);
    await expect(catchup.locator('.provider-chip')).toHaveText('Codex');
    await expect(catchup.locator('.agent-row-preview')).toHaveText('Invented work folder.');
    await expect(catchup.locator('.agent-row-state')).toHaveCount(0);

    await expect(row(page, 'Second brain').locator('.agent-row-state')).toHaveText('Waiting for you');
    await expect(row(page, 'Dev').locator('.agent-row-state')).toHaveText('Unavailable');
    await expect(row(page, 'Focus').locator('.provider-chip')).toHaveCount(0);
    await expect(row(page, 'Focus').locator('.agent-row-state')).toHaveCount(0);

    for (const link of await page.locator('#agents-groups a.agent-row').all()) {
      expect((await link.boundingBox()).height).toBeGreaterThanOrEqual(44);
    }
    expect(hub.personas.calls).toEqual([]);
  });

  test('the page at / is the list beside a sentence that asks for an agent', async ({ page, hub }) => {
    await page.goto(`${hub.origin}/`);
    await expectView(page, 'agents', 'Agents');
    await expect(page.locator('#agents-list')).toBeVisible();
    await expect(page.locator('#agent-panel')).toBeHidden();
    // Nothing sits above the groups.
    await expect(page.locator('#agents-list > :visible')).toHaveText(['Agents', /^Work/]);
    await expect(page.locator('#agents-list .agent-row').first()).toHaveAttribute('data-agent', 'cfo');
    await expect(page.locator('#view-agents .routine-card')).toHaveCount(0);
    if (phone(page)) {
      await expect(page.locator('#agent-empty')).toBeHidden();
      expect((await page.locator('#agents-list').boundingBox()).width).toBe(page.viewportSize().width);
    } else {
      const empty = page.locator('#agent-empty');
      await expect(empty).toHaveText('Choose an agent to open its thread.');
      await expect(empty).toBeVisible();
      const list = await page.locator('#agents-list').boundingBox();
      expect((await empty.boundingBox()).x).toBeGreaterThanOrEqual(list.x + list.width);
    }
    expect(hub.routines.calls).toBe(0);
  });

  test('/agents?agent=cfo and /?agent=cfo both open the thread', async ({ page, hub }) => {
    await page.goto(`${hub.origin}/agents?agent=cfo`);
    await expectView(page, 'agents', 'Agents');
    await expect(pane(page).locator('#agent-name')).toHaveText('CFO');
    await expect(messages(page)).toHaveCount(2);
    await page.goto(`${hub.origin}/?agent=cfo`);
    await expectView(page, 'agents', 'Agents');
    await expect(pane(page).locator('#agent-name')).toHaveText('CFO');
    await expect(messages(page)).toHaveCount(2);
    await expect(page.locator('#agent-empty')).toBeHidden();
  });

  test('a persona with jobs has no Routines button and no rows above its messages', async ({ page, hub }) => {
    await page.goto(`${hub.origin}/?agent=cfo`);
    await expect(messages(page)).toHaveCount(2);
    await expect(pane(page).locator('.thread-header').getByRole('button')).toHaveText(['New thread']);
    await expect(pane(page).locator('.routine-row')).toHaveCount(0);
  });

  test('opening a persona shows its thread, and a reload lands on it', async ({ page, hub }) => {
    await page.goto(`${hub.origin}/`);
    await row(page, 'CFO').click();
    await expect(page).toHaveURL(`${hub.origin}/?agent=cfo`);
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

    await nav(page, 'Home').click();
    await expect(page).toHaveURL(`${hub.origin}/`);
    await expect(pane(page)).toBeHidden();
  });

  test('sending shows the message, the working line with Interrupt, and then the reply', async ({ page, hub }) => {
    hub.personas.hold('cfo');
    await page.goto(`${hub.origin}/?agent=cfo`);
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
    await page.goto(`${hub.origin}/?agent=cfo`);
    await page.locator('#agent-input').fill('Take your time.');
    await page.locator('#agent-send').click();
    await expect(page.locator('#agent-status')).toBeVisible();
    await page.locator('#agent-status').getByRole('button', { name: 'Interrupt' }).click();
    await expect(page.locator('#agent-status')).toBeHidden();
    await expect(page.locator('#agent-send')).toBeEnabled();
    await expect(messages(page)).toHaveCount(3);
  });

  test('a pending question renders its options, and answering clears the Waiting line and the card', async ({ page, hub }) => {
    await page.goto(`${hub.origin}/?agent=brain`);
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
    await expect(page.locator('#agent-status-text')).toHaveText('Second brain is waiting for you.');
    await expect(page.locator('#agent-status').getByRole('button', { name: 'Interrupt' })).toBeEnabled();
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
    await expect(page.locator('#agent-input')).toBeFocused();
    await expect(row(page, 'Second brain').locator('.agent-row-state')).toHaveCount(0, { timeout: 10_000 });
    await expect(messages(page)).toHaveText([/^Reply: answered/]);
    await expect(page.locator('#agent-send')).toBeEnabled();
    expect(hub.personas.calls).toEqual([['answer', 'brain', expect.stringMatching(/^req-/), { answers: { [QUESTION]: 'Amber' } }]]);
  });

  test('a typed Other answer is sent as the label, and wins over a pressed option', async ({ page, hub }) => {
    await page.goto(`${hub.origin}/?agent=brain`);
    const request = page.locator('#agent-request');
    await request.locator('.option').nth(0).click();
    await request.locator('.request-other-field').fill('Teal');
    await request.getByRole('button', { name: 'Answer' }).click();
    await expect(request).toBeHidden();
    expect(hub.personas.calls[0][3]).toEqual({ answers: { [QUESTION]: 'Teal' } });
  });

  test('a multi-select question posts every pressed label as a list', async ({ page, hub }) => {
    hub.personas.hold('cfo');
    await page.goto(`${hub.origin}/?agent=cfo`);
    await page.locator('#agent-input').fill('Pick colors.');
    await page.locator('#agent-send').click();
    await expect(page.locator('#agent-status')).toBeVisible();
    hub.personas.raise('cfo', {
      ...QUESTION_REQUEST,
      input: { questions: [{ ...QUESTION_REQUEST.input.questions[0], multiSelect: true }] },
    });
    const request = page.locator('#agent-request');
    const options = request.locator('.option');
    await options.nth(0).click();
    await options.nth(1).click();
    await expect(options.nth(0)).toHaveAttribute('aria-pressed', 'true');
    await expect(options.nth(1)).toHaveAttribute('aria-pressed', 'true');
    await request.locator('.request-other-field').fill('Teal');
    await request.getByRole('button', { name: 'Answer' }).click();
    await expect(request).toBeHidden();
    expect(hub.personas.calls.at(-1)).toEqual(['answer', 'cfo', expect.stringMatching(/^req-/), { answers: { [QUESTION]: ['Blue', 'Amber', 'Teal'] } }]);
  });

  test('a question whose request has expired says so under the composer', async ({ page, hub }) => {
    await page.route('**/api/agents/brain/answer', (route) => route.fulfill({
      status: 409, contentType: 'application/json', body: '{"error":"no_such_request"}',
    }));
    await page.goto(`${hub.origin}/?agent=brain`);
    const request = page.locator('#agent-request');
    await request.locator('.option').nth(0).click();
    await request.getByRole('button', { name: 'Answer' }).click();
    await expect(page.locator('#agent-failure')).toHaveText('That request was already answered or has expired.');
    await expect(request).toBeVisible();
    expect(hub.personas.calls).toEqual([]);
  });

  test('a pending approval shows the tool and its input, and Deny resolves it', async ({ page, hub }) => {
    hub.personas.hold('cfo');
    await page.goto(`${hub.origin}/?agent=cfo`);
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

    await request.getByRole('button', { name: 'Deny' }).click();
    await expect(request).toBeHidden();
    await expect(page.locator('#agent-status-text')).toHaveText('CFO is working.');
    await expect(row(page, 'CFO').locator('.agent-row-state')).toHaveText('Working');
    expect(hub.personas.calls.at(-1)).toEqual(['answer', 'cfo', expect.stringMatching(/^req-/), { decision: 'deny' }]);

    // A second approval whose input is over the snapshot cap arrives cut.
    hub.personas.raise('cfo', { kind: 'approval', toolName: 'Write', input: { content: 'x'.repeat(20_000) } });
    await expect(request.locator('.request-title')).toHaveText('CFO wants to run Write');
    await expect(request.locator('.request-note')).toHaveText('Input cut short.');
    expect((await request.locator('.request-input').textContent()).length).toBeLessThan(17_000);
    await request.getByRole('button', { name: 'Allow' }).click();
    await expect(request).toBeHidden();
    expect(hub.personas.calls.at(-1)[3]).toEqual({ decision: 'allow' });
  });

  test('New thread asks inline, then starts the persona over', async ({ page, hub }) => {
    await page.goto(`${hub.origin}/?agent=cfo`);
    await expect(messages(page)).toHaveCount(2);
    await page.locator('#agent-new-thread').click();
    const confirm = page.locator('#agent-confirm');
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText('Start a new thread? CFO will not remember this one.');
    await expect(confirm.getByRole('button', { name: 'Start new thread' })).toBeFocused();
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await expect(confirm).toBeHidden();
    await expect(page.locator('#agent-new-thread')).toBeFocused();
    expect(hub.personas.calls).toEqual([]);

    await page.locator('#agent-new-thread').click();
    await confirm.getByRole('button', { name: 'Start new thread' }).click();
    await expect(confirm).toBeHidden();
    await expect(messages(page)).toHaveText([/^New thread/]);
    await expect(messages(page).first()).toHaveClass(/thread-message-system/);
    await expect(row(page, 'CFO').locator('.agent-row-preview')).toHaveText('New thread');
    await expect(page.locator('#agent-new-thread')).toBeFocused();
    expect(hub.personas.calls).toEqual([['newThread', 'cfo']]);
  });

  test('a thread that cannot be read again keeps its messages, and Retry or the next change recovers', async ({ page, hub }) => {
    hub.personas.hold('cfo');
    await page.goto(`${hub.origin}/?agent=cfo`);
    await expect(messages(page)).toHaveCount(2);

    let failing = true;
    await page.route('**/api/agents/cfo/thread', (route) => (failing ? route.fulfill({ status: 500, body: '' }) : route.continue()));
    await page.locator('#agent-input').fill('Still there?');
    await page.locator('#agent-send').click();
    const line = page.locator('#agent-messages .thread-line');
    await expect(line).toHaveText('The thread could not be loaded. Retry');
    await expect(messages(page)).toHaveCount(2);
    expect(await page.locator('#agent-messages > *').first().getAttribute('class')).toBe('thread-line');

    await line.getByRole('button', { name: 'Retry' }).click();
    await expect(line).toHaveText('The thread could not be loaded. Retry');
    failing = false;
    await line.getByRole('button', { name: 'Retry' }).click();
    await expect(line).toHaveCount(0);
    await expect(messages(page)).toHaveCount(3);

    failing = true;
    await hub.personas.reply('cfo', 'Yes.');
    await expect(line).toHaveText('The thread could not be loaded. Retry');
    await expect(messages(page)).toHaveCount(3);
    failing = false;
    await page.locator('#agent-input').fill('Good.');
    await page.locator('#agent-send').click();
    await expect(line).toHaveCount(0);
    await expect(messages(page)).toHaveCount(5);
  });

  test('a draft typed for one persona is kept while another thread is open', async ({ page, hub }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.goto(`${hub.origin}/?agent=cfo`);
    await page.locator('#agent-input').fill('For CFO');
    await row(page, 'Second brain').click();
    await expect(pane(page).locator('#agent-name')).toHaveText('Second brain');
    await expect(page.locator('#agent-input')).toHaveValue('');
    await page.locator('#agent-input').fill('For Second brain');
    await row(page, 'CFO').click();
    await expect(page.locator('#agent-input')).toHaveValue('For CFO');
    await page.goBack();
    await expect(pane(page).locator('#agent-name')).toHaveText('Second brain');
    await expect(page.locator('#agent-input')).toHaveValue('For Second brain');
  });

  test('Back from a thread returns to the list, and choosing the open row adds no history', async ({ page, hub }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.goto(`${hub.origin}/`);
    const empty = page.locator('#agent-empty');
    await expect(empty).toHaveText('Choose an agent to open its thread.');
    await row(page, 'CFO').click();
    await expect(page).toHaveURL(`${hub.origin}/?agent=cfo`);
    await expect(pane(page)).toBeVisible();
    await expect(empty).toBeHidden();
    await row(page, 'CFO').click();
    await page.goBack();
    await expect(page).toHaveURL(`${hub.origin}/`);
    await expect(pane(page)).toBeHidden();
    await expect(empty).toHaveText('Choose an agent to open its thread.');
  });

  test('choosing the open row from /agents?agent= adds no history entry', async ({ page, hub }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.goto(`${hub.origin}/agents?agent=cfo`);
    await expect(pane(page).locator('#agent-name')).toHaveText('CFO');
    const before = await historyLength(page);
    await row(page, 'CFO').click();
    await expect(page).toHaveURL(`${hub.origin}/agents?agent=cfo`);
    expect(await historyLength(page)).toBe(before);

    await row(page, 'Second brain').click();
    await expect(page).toHaveURL(`${hub.origin}/?agent=brain`);
    expect(await historyLength(page)).toBe(before + 1);
    await page.goBack();
    await expect(page).toHaveURL(`${hub.origin}/agents?agent=cfo`);
    await expect(pane(page).locator('#agent-name')).toHaveText('CFO');
  });

  test('a server refresh rebuilds the Health cards once per state change', async ({ page, hub }) => {
    await page.goto(`${hub.origin}/health`);
    await expectView(page, 'health', 'Health');
    await expect(page.locator('.routine-card .card-name')).toHaveText(['CFO']);
    await watchRebuilds(page, '#routines-cards');

    // The refresh changes the state twice: refreshing, then the result.
    hub.routines.items = ROUTINES.slice(0, 1);
    await hub.state.refreshRoutines();
    await expect(page.locator('.routine-name')).toHaveText(['cfo.daily']);
    expect(await rebuilds(page)).toBe(2);
  });

  test('crossing 720px with no agent open swaps the sentence for the list alone', async ({ page, hub }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${hub.origin}/`);
    const empty = page.locator('#agent-empty');
    await expect(empty).toBeVisible();
    await watchRebuilds(page, '#agents-groups');

    await page.setViewportSize({ width: 390, height: 844 });
    await crossed(page, false);
    await expect(page.locator('#agents-list')).toBeVisible();
    await expect(page.locator('#agent-thread')).toBeHidden();

    await page.setViewportSize({ width: 1280, height: 800 });
    await crossed(page, true);
    await expect(page.locator('#agents-list')).toBeVisible();
    await expect(empty).toHaveText('Choose an agent to open its thread.');
    await expect(empty).toBeVisible();
    expect(await rebuilds(page)).toBe(0);
  });

  test('an unavailable persona shows why and a disabled composer', async ({ page, hub }) => {
    await page.goto(`${hub.origin}/?agent=dev`);
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
    await page.goto(`${hub.origin}/?agent=cfo`);
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
    await page.goto(`${hub.origin}/?agent=cfo`);
    await page.locator('#agent-input').fill('Anyone there?');
    await page.locator('#agent-send').click();
    await expect(page.locator('#agent-failure')).toHaveText('The dashboard is shutting down. Try again in a moment.');
    await expect(page.locator('#agent-input')).toHaveValue('Anyone there?');
    await expect(page.locator('#agent-send')).toBeEnabled();
  });

  test('a sent message clears the composer and leaves the keyboard in it', async ({ page, hub }) => {
    await page.goto(`${hub.origin}/?agent=cfo`);
    await page.locator('#agent-input').fill('Hello');
    await page.locator('#agent-send').click();
    await expect(page.locator('#agent-input')).toHaveValue('');
    await expect(page.locator('#agent-input')).toBeFocused();
  });

  test('at phone width the list comes first and a row opens the thread full width with a way back', async ({ page, hub }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${hub.origin}/`);
    await expect(page.locator('#agents-list')).toBeVisible();
    await expect(page.locator('#agent-thread')).toBeHidden();

    // No Routines row: the first thing under the heading is a group.
    await expect(page.locator('#view-agents').getByText('Routines')).toHaveCount(0);
    const heading = await page.locator('.agents-heading').boundingBox();
    const firstGroup = await page.locator('.agent-group-heading').first().boundingBox();
    const between = await page.locator('#agents-list > :visible').evaluateAll((nodes) => nodes.map((n) => n.className));
    expect(between).toEqual(['agents-heading', '']);
    expect(firstGroup.y).toBeGreaterThan(heading.y);

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

    await expect(page.locator('#agent-panel').getByRole('button', { name: /Routines/ })).toHaveCount(0);

    await back.click();
    await expect(page).toHaveURL(`${hub.origin}/`);
    await expect(page.locator('#agents-list')).toBeVisible();
    await expect(page.locator('#agent-thread')).toBeHidden();

    await page.goBack();
    await expect(page).toHaveURL(`${hub.origin}/?agent=cfo`);
    await expect(page.locator('#agent-thread')).toBeVisible();
  });
});

test.describe('with a persona whose last turn the clock stopped', () => {
  test.use({ hubOptions: seeded({ cfo: { lastError: 'turn_timeout' } }) });

  test('the idle persona says why above the messages and takes a message', async ({ page, hub }) => {
    await page.goto(`${hub.origin}/?agent=cfo`);
    await expect(page.locator('#agent-notice')).toHaveText('The last turn ran too long and was stopped.');
    await expect(page.locator('#agent-send')).toBeEnabled();
    await expect(row(page, 'CFO').locator('.agent-row-state')).toHaveCount(0);
  });
});

test.describe('with an unreadable registry', () => {
  // The fake registry lists no agents while it cannot be read; the cards
  // come from the routines' own agent names.
  test.use({ hubOptions: { build: () => ({ ...seeded().build(), registry: { ok: false, error: 'registry_invalid_json' } }) } });

  test('Health says the registry could not be read, and the list claims nothing', async ({ page, hub }) => {
    await page.goto(`${hub.origin}/`);
    await expectView(page, 'agents', 'Agents');
    const listMessage = page.locator('#agents-message');
    await expect(listMessage).toBeHidden();

    await page.goto(`${hub.origin}/?agent=cfo`);
    await expect(page.locator('#agent-empty')).toHaveText('No agent named cfo is registered.');
    await expect(listMessage).toBeHidden();

    await nav(page, 'Health').click();
    await expectView(page, 'health', 'Health');
    await expect(page.locator('#routines-message')).toHaveText('The registry could not be read. registry_invalid_json');
    await expect(page.locator('.routine-card .card-name')).toHaveText(['CFO']);
  });
});

test.describe('with no agents', () => {
  test('the list says none are registered', async ({ page, hub }) => {
    await page.goto(`${hub.origin}/`);
    await expect(page.locator('#agents-message')).toHaveText('No agents are registered.');
    await expect(page.locator('#agent-panel')).toBeHidden();
  });
});
