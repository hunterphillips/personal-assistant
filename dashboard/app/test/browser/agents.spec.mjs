// The Agents view, the page at `/`, in real browsers against the in-memory
// registry, routines, and fake persona adapter of
// test/support/browser-server.mjs. The jobs are on the Health view, covered
// in routines.spec.mjs.

import { expect, expectView, nav, test } from '../support/browser-test.mjs';

const MINUTE = 60_000;
const ago = (ms) => new Date(Date.now() - ms).toISOString();

const AGENTS = [
  { id: 'cfo', name: 'CFO', role: 'Money', description: 'Invented.', group: 'work', kind: 'persona', provider: 'claude', cwd: '/invented/cfo',
    routines: ['com.hunter.cfo.daily', 'com.hunter.cfo.weekly'] },
  { id: 'catchup', name: 'Catchup', role: 'Work', description: 'Invented work folder.', group: 'work', kind: 'project', provider: 'codex', cwd: '/invented/catchup' },
  { id: 'brain', name: 'Second brain', role: 'Notes', description: 'Invented.', group: 'personal', kind: 'persona', provider: 'claude', cwd: '/invented/brain' },
  { id: 'dev', name: 'Dev', role: 'Code', description: 'Invented.', group: 'personal', kind: 'persona', provider: 'codex', cwd: '/invented/dev' },
  { id: 'focus', name: 'Focus', role: 'Tasks', description: 'Invented task board.', group: 'personal', kind: 'system', cwd: '/invented/focus' },
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

// Counts rebuilds of the element's children (or, with `subtree`, of any
// element's children under it) from now on (a rebuild clears them first:
// one mutation record with removed nodes) and follows the 720px query. Its
// listener was added after the view's, so by the time it has seen a
// crossing the view has handled it.
async function watchRebuilds(page, selector, { subtree = false } = {}) {
  await page.evaluate(({ sel, deep }) => {
    window.__rebuilds = 0;
    new MutationObserver((records) => {
      for (const record of records) if (record.removedNodes.length > 0) window.__rebuilds += 1;
    }).observe(document.querySelector(sel), { childList: true, subtree: deep });
    const wide = window.matchMedia('(min-width: 720px)');
    window.__wide = wide.matches;
    wide.addEventListener('change', (event) => { window.__wide = event.matches; });
  }, { sel: selector, deep: subtree });
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
    // Nothing sits above the groups; New agent sits under them.
    await expect(page.locator('#agents-list > :visible')).toHaveText(['Agents', /^Work/, 'New agent']);
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

  test('the gear opens the settings beside the thread, whose messages stay', async ({ page, hub }) => {
    await page.goto(`${hub.origin}/?agent=cfo`);
    const gear = pane(page).getByRole('button', { name: 'Details', exact: true });
    await expect(gear).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('#agent-details')).toBeHidden();
    await expect(messages(page)).toHaveCount(2);

    await gear.click();
    const details = page.locator('#agent-details');
    await expect(details.locator('.details-name')).toHaveText('CFO');
    await expect(details.locator('#agent-form .form-label')).toHaveText(['Name', 'Role', 'Group', 'Group name', 'Description', 'Folder', 'Model', 'Effort', 'Permissions']);
    await expect(details.locator('[name="name"]')).toHaveValue('CFO');
    await expect(details.locator('[name="role"]')).toHaveValue('Money');
    await expect(details.locator('[name="group"]')).toHaveValue('work');
    await expect(details.locator('[name="description"]')).toHaveValue('Invented.');
    await expect(details.locator('[name="cwd"]')).toHaveValue('~/cfo');
    await expect(details.locator('.details-description')).toBeHidden();
    await expect(details.locator('.details-jobs')).toHaveText('CFO runs 2 jobs.');
    await expect(details.locator('.routine-row, .badge')).toHaveCount(0);
    await expect(messages(page)).toHaveCount(2);
  });

  test('the agents toggle hides and shows the list, moves between the two panes, widens and centers the thread, and a reload keeps the choice', async ({ page, hub }) => {
    test.skip(phone(page), 'the toggle is desktop only');
    await page.goto(`${hub.origin}/?agent=cfo`);
    const list = page.locator('#agents-list');
    const threadMain = pane(page).locator('.thread-main');
    const threadHeader = pane(page).locator('.thread-header');

    await expect(list).toBeVisible();
    await expect(list.locator('#agents-toggle')).toHaveCount(1);
    await expect(threadHeader.locator('#agents-toggle')).toHaveCount(0);
    var toggle = page.getByRole('button', { name: 'Hide agents', exact: true });
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(toggle).toHaveAttribute('aria-controls', 'agents-list');
    const narrowWidth = (await threadMain.boundingBox()).width;

    await toggle.click();
    await expect(list).toBeHidden();
    await expect(threadHeader.locator('#agents-toggle')).toHaveCount(1);
    await expect(list.locator('#agents-toggle')).toHaveCount(0);
    toggle = page.getByRole('button', { name: 'Show agents', exact: true });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    const wideWidth = (await threadMain.boundingBox()).width;
    expect(wideWidth).toBeGreaterThan(narrowWidth);

    if (page.viewportSize().width === 1280) {
      const mainBox = await threadMain.boundingBox();
      const messagesBox = await pane(page).locator('#agent-messages').boundingBox();
      expect(messagesBox.width).toBeLessThanOrEqual(822);
      const leftGap = messagesBox.x - mainBox.x;
      const rightGap = mainBox.x + mainBox.width - (messagesBox.x + messagesBox.width);
      expect(Math.abs(leftGap - rightGap)).toBeLessThanOrEqual(3);
    }

    await page.reload();
    await expect(list).toBeHidden();
    await expect(threadHeader.locator('#agents-toggle')).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'Show agents', exact: true })).toHaveAttribute('aria-expanded', 'false');

    await page.getByRole('button', { name: 'Show agents', exact: true }).click();
    await expect(list).toBeVisible();
    await expect(list.locator('#agents-toggle')).toHaveCount(1);
    await expect(threadHeader.locator('#agents-toggle')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Hide agents', exact: true })).toHaveAttribute('aria-expanded', 'true');
  });

  test('the agents toggle does not appear on a phone', async ({ page, hub }) => {
    test.skip(!phone(page), 'desktop only has the toggle');
    await page.goto(`${hub.origin}/?agent=cfo`);
    await expect(page.locator('#agents-toggle')).toBeHidden();
  });

  test('a persona without jobs has no jobs line', async ({ page, hub }) => {
    await page.goto(`${hub.origin}/?agent=brain`);
    await expect(pane(page).locator('#agent-name')).toHaveText('Second brain');
    await page.locator('#agent-details-toggle').click();
    await expect(page.locator('#agent-details .details-name')).toHaveText('Second brain');
    await expect(page.locator('#agent-details .details-jobs')).toBeHidden();
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

  test('Enter sends the composer, Shift+Enter adds a newline, and an empty composer sends nothing', async ({ page, hub }) => {
    await page.goto(`${hub.origin}/?agent=cfo`);
    await expect(messages(page)).toHaveCount(2);
    const input = page.locator('#agent-input');

    await input.fill('   ');
    await input.press('Enter');
    await expect(messages(page)).toHaveCount(2);
    expect(hub.personas.calls).toEqual([]);

    await input.fill('');
    await input.press('Enter');
    await expect(messages(page)).toHaveCount(2);
    expect(hub.personas.calls).toEqual([]);

    await input.fill('Next line');
    await input.press('Shift+Enter');
    await expect(input).toHaveValue('Next line\n');
    await expect(messages(page)).toHaveCount(2);
    expect(hub.personas.calls).toEqual([]);

    await input.fill('What about next month?');
    await input.press('Enter');
    await expect(messages(page)).toHaveCount(3);
    await expect(messages(page).nth(2)).toHaveText(/^What about next month\?/);
    await expect(input).toHaveValue('');
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

  test('crossing 720px with an agent open keeps the settings open', async ({ page, hub }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${hub.origin}/?agent=cfo`);
    await page.locator('#agent-details-toggle').click();
    const details = page.locator('#agent-details');
    await expect(details.locator('.details-jobs')).toHaveText('CFO runs 2 jobs.');
    await watchRebuilds(page, '#agent-details', { subtree: true });

    await page.setViewportSize({ width: 390, height: 844 });
    await crossed(page, false);
    await expect(page.locator('#agents-list')).toBeHidden();
    await expect(page.locator('#agent-thread')).toBeVisible();
    await expect(details).toBeVisible();
    await expect(details.locator('.details-jobs')).toHaveText('CFO runs 2 jobs.');

    await page.setViewportSize({ width: 1280, height: 800 });
    await crossed(page, true);
    await expect(page.locator('#agents-list')).toBeVisible();
    await expect(details).toBeVisible();
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
    expect(between).toEqual(['agents-list-head', '', 'agents-list-foot']);
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
    await expect(page.locator('#agent-details-toggle')).toBeVisible();

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

// The registry's groups list, a pinned persona above it, and a group the
// list leaves out. Seeded only here, so the other tests keep an empty pane.
const PINNED_AGENTS = [
  { id: 'assistant', name: 'Assistant', role: 'Assistant', description: 'I am the way in.', group: 'personal', kind: 'persona', provider: 'claude',
    cwd: '/invented/assistant', pinned: true, routines: ['com.invented.dashboard'] },
  ...AGENTS,
  { id: 'kin', name: 'Kin', role: 'Family', description: 'Invented.', group: 'family', kind: 'persona', provider: 'claude', cwd: '/invented/kin' },
];
const PINNED_ROUTINES = [...ROUTINES, {
  ...ROUTINES[0], label: 'com.invented.dashboard', agentId: 'assistant', agentName: 'Assistant', name: 'dashboard',
  schedule: { kind: 'keepalive', text: 'Always on' }, outcome: 'ok', exitStatus: 0,
}];

test.describe('with a pinned persona and a group the list leaves out', () => {
  test.use({
    hubOptions: {
      build: () => ({
        ...seeded().build(),
        agents: PINNED_AGENTS,
        registry: { groups: [{ id: 'work', name: 'Work' }, { id: 'personal', name: 'Personal' }] },
        routines: { items: PINNED_ROUTINES, focusAvailable: true, refreshedAt: ago(5_000) },
      }),
    },
  });

  test('the pinned row sits above the groups, the unlisted group follows them, and Home is a chat icon', async ({ page, hub }) => {
    await page.goto(`${hub.origin}/`);
    await expectView(page, 'agents', 'Agents');
    await expect(page.locator('#agents-groups > section').first()).toHaveClass(/agent-group-pinned/);
    await expect(page.locator('#agents-groups > section').first().locator('h2')).toHaveCount(0);
    await expect(page.locator('#agents-groups > section').first()).toHaveAttribute('aria-label', 'Pinned');
    await expect(page.locator('.agent-group-heading')).toHaveText(['Work', 'Personal', 'Family']);
    await expect(page.locator('#agents-groups .agent-row .agent-row-name')).toHaveText(['Assistant', 'CFO', 'Catchup', 'Second brain', 'Dev', 'Focus', 'Kin']);
    // A role that only repeats the name is not shown as a chip.
    await expect(row(page, 'Assistant').locator('.role-chip')).toHaveCount(0);
    await expect(row(page, 'Kin').locator('.role-chip')).toHaveText('Family');
    await expect(nav(page, 'Home').locator('svg.nav-icon')).toHaveCount(1);
    await expect(nav(page, 'Home').locator('svg.nav-icon path')).toHaveCount(1);
  });

  test('a desk opens the pinned thread at /, keeps the URL, and a phone shows the list', async ({ page, hub }) => {
    await page.goto(`${hub.origin}/`);
    await expectView(page, 'agents', 'Agents');
    if (phone(page)) {
      await expect(page.locator('#agents-list')).toBeVisible();
      await expect(page.locator('#agent-thread')).toBeHidden();
      await expect(row(page, 'Assistant')).not.toHaveAttribute('aria-current', /.*/);
      await row(page, 'Assistant').click();
      await expect(page).toHaveURL(`${hub.origin}/?agent=assistant`);
      await expect(pane(page)).toBeVisible();
      return;
    }
    await expect(pane(page)).toBeVisible();
    await expect(page.locator('#agent-name')).toHaveText('Assistant');
    await expect(row(page, 'Assistant')).toHaveAttribute('aria-current', 'true');
    await expect(page).toHaveURL(`${hub.origin}/`);
    await expect(page.locator('#agent-empty')).toBeHidden();
    // The default never takes the keyboard.
    await expect(page.locator('#agent-input')).not.toBeFocused();

    // A row click still adds its entry, and Back lands on the default again.
    const before = await historyLength(page);
    await row(page, 'CFO').click();
    await expect(page).toHaveURL(`${hub.origin}/?agent=cfo`);
    await expect(page.locator('#agent-name')).toHaveText('CFO');
    expect(await historyLength(page)).toBe(before + 1);
    await page.goBack();
    await expect(page).toHaveURL(`${hub.origin}/`);
    await expect(page.locator('#agent-name')).toHaveText('Assistant');
    await expect(row(page, 'Assistant')).toHaveAttribute('aria-current', 'true');

    // A reload lands on the same default; a tab coming back does not rebuild the thread.
    await page.reload();
    await expect(page.locator('#agent-name')).toHaveText('Assistant');
    await watchRebuilds(page, '#agent-messages');
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect(page.locator('#agent-name')).toHaveText('Assistant');
    expect(await rebuilds(page)).toBe(0);
  });

  test('resizing between phone and desk opens and closes the default thread', async ({ page, hub }) => {
    test.skip(phone(page), 'the emulated phone cannot resize');
    await page.setViewportSize({ width: 600, height: 800 });
    await page.goto(`${hub.origin}/`);
    await watchRebuilds(page, '#agents-groups');
    await expect(page.locator('#agents-list')).toBeVisible();
    await expect(page.locator('#agent-thread')).toBeHidden();

    await page.setViewportSize({ width: 1280, height: 800 });
    await crossed(page, true);
    await expect(pane(page)).toBeVisible();
    await expect(page.locator('#agent-name')).toHaveText('Assistant');
    await expect(page).toHaveURL(`${hub.origin}/`);

    await page.setViewportSize({ width: 600, height: 800 });
    await crossed(page, false);
    await expect(page.locator('#agents-list')).toBeVisible();
    await expect(page.locator('#agent-thread')).toBeHidden();
    await expect(row(page, 'Assistant')).not.toHaveAttribute('aria-current', /.*/);

    // A thread named in the URL stays open on a phone.
    await page.setViewportSize({ width: 1280, height: 800 });
    await crossed(page, true);
    await row(page, 'CFO').click();
    await expect(page).toHaveURL(`${hub.origin}/?agent=cfo`);
    await page.setViewportSize({ width: 600, height: 800 });
    await crossed(page, false);
    await expect(pane(page)).toBeVisible();
    await expect(page.locator('#agent-name')).toHaveText('CFO');
  });

  test('Health lists the dashboard job under the pinned agent and the settings name its group', async ({ page, hub }) => {
    await page.goto(`${hub.origin}/health`);
    await expectView(page, 'health', 'Health');
    await expect(page.locator('.routine-card .card-name')).toHaveText(['Assistant', 'CFO']);
    // A role that only repeats the name is not a chip on the card either.
    await expect(page.locator('.routine-card').nth(0).locator('.role-chip')).toHaveCount(0);
    await expect(page.locator('.routine-card').nth(1).locator('.role-chip')).toHaveText('Money');
    await page.goto(`${hub.origin}/?agent=kin`);
    await page.locator('#agent-details-toggle').click();
    await expect(page.locator('#agent-details [name="group"]')).toHaveValue('family');
    await expect(page.locator('#agent-details [name="group"] option:checked')).toHaveText('Family');
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

// The morning brief's notice in the Assistant's thread, and date lines
// between days. Times at 18:00 UTC are early afternoon in America/Chicago
// (the suite's zone), so consecutive UTC dates are consecutive local days.
const ASSISTANT = {
  id: 'assistant', name: 'Assistant', role: 'Assistant', description: 'The way in.', group: 'personal', kind: 'persona',
  provider: 'claude', cwd: '/invented', pinned: true,
};
const DAY = 24 * 60 * MINUTE;
const utcAfternoon = (daysAgo) => {
  const date = new Date();
  date.setUTCHours(18, 0, 0, 0);
  return new Date(date.getTime() - daysAgo * DAY).toISOString();
};
const BRIEF_NOTICE = {
  role: 'system', kind: 'brief', date: '2026-09-30', state: 'ready',
  summary: 'Cash is fine and nothing is due before Thursday.',
  text: 'Cash is fine and nothing is due before Thursday. Two threads wait on other people.\n\n## Money\n\n- Drift is under a point.',
  at: ago(30 * MINUTE),
};
const FAILED_NOTICE = {
  role: 'system', kind: 'brief', date: '2026-09-29', state: 'failed',
  summary: 'The morning brief did not build.', text: 'The morning brief did not build.', at: ago(25 * MINUTE),
};

test.describe('with a brief notice in the Assistant thread', () => {
  test.use({
    hubOptions: {
      build: () => ({
        agents: [ASSISTANT, ...AGENTS],
        personas: {
          assistant: { messages: [FAILED_NOTICE, BRIEF_NOTICE] },
          cfo: { messages: [
            { role: 'user', text: 'Yesterday afternoon.', at: utcAfternoon(1) },
            { role: 'assistant', text: 'Today afternoon.', at: utcAfternoon(0) },
          ] },
        },
      }),
    },
  });

  test('the notice renders collapsed, expands to the memo, and the row preview shows the opening', async ({ page, hub }) => {
    await page.goto(`${hub.origin}/`);
    await expect(row(page, 'Assistant').locator('.agent-row-preview')).toHaveText('Cash is fine and nothing is due before Thursday.');

    await page.goto(`${hub.origin}/?agent=assistant`);
    await expect(messages(page)).toHaveCount(2);
    const brief = messages(page).nth(1).locator('details.thread-brief');
    await expect(brief).toBeVisible();
    await expect(brief).not.toHaveAttribute('open', /.*/);
    await expect(brief.locator('summary')).toHaveText('Brief, Wednesday, September 30: Cash is fine and nothing is due before Thursday.');
    await expect(brief.locator('.thread-brief-body')).toBeHidden();
    const summary = await brief.locator('summary').boundingBox();
    expect(summary.height).toBeGreaterThanOrEqual(44);

    await brief.locator('summary').click();
    await expect(brief).toHaveAttribute('open', '');
    await expect(brief.locator('.thread-brief-body')).toBeVisible();
    await expect(brief.locator('.thread-brief-body')).toContainText('Two threads wait on other people.');
    await expect(brief.locator('.thread-brief-body h4')).toHaveText('Money');
    await expect(brief.locator('.thread-brief-body li')).toHaveText(['Drift is under a point.']);
    await expect(brief.locator('.thread-brief-body')).not.toContainText('##');
    await expect(page.locator('#agent-messages .thread-day')).toHaveCount(0);
  });

  test('a failed notice renders as one line without a disclosure', async ({ page, hub }) => {
    await page.goto(`${hub.origin}/?agent=assistant`);
    const failed = messages(page).nth(0);
    await expect(failed).toHaveClass(/thread-message-brief-failed/);
    await expect(failed).toHaveClass(/thread-message-system/);
    await expect(failed.locator('details')).toHaveCount(0);
    await expect(failed.locator('.thread-message-text')).toHaveText('The morning brief did not build.');
  });

  test('messages on different days get a date line before each day', async ({ page, hub }) => {
    await page.goto(`${hub.origin}/?agent=cfo`);
    await expect(messages(page)).toHaveCount(2);
    const lines = page.locator('#agent-messages .thread-day');
    await expect(lines).toHaveCount(2);
    const order = await page.locator('#agent-messages > *').evaluateAll((nodes) => nodes.map((node) => node.className.split(' ')[0]));
    expect(order).toEqual(['thread-day', 'thread-message', 'thread-day', 'thread-message']);
    const labels = await lines.allTextContents();
    expect(labels[0]).not.toEqual(labels[1]);
    expect(labels[1]).toMatch(/^(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday), [A-Z][a-z]+ \d{1,2}(, \d{4})?$/);
  });

  test('a notice file the run writes is posted once when the page connects, and a reload adds nothing', async ({ page, hub }) => {
    await hub.writeNotice('2026-10-01', { opening: 'A fresh brief. Details follow.', memo: '## Work\n\nOne thread.' });
    await page.goto(`${hub.origin}/?agent=assistant`);
    await expect(messages(page)).toHaveCount(3);
    await expect(messages(page).nth(2).locator('summary')).toHaveText('Brief, Thursday, October 1: A fresh brief.');
    await expect(row(page, 'Assistant').locator('.agent-row-preview')).toHaveText('A fresh brief.');

    await page.reload();
    await expect(messages(page)).toHaveCount(3);
    await hub.notices.reconcile();
    await page.reload();
    await expect(messages(page)).toHaveCount(3);
  });
});

// Messages render their Markdown: an agent's reply, a plain line, and the
// brief notice's memo.
const MARKDOWN_REPLY = [
  '## Needs you',
  '',
  'Two things wait on **you** today:',
  '',
  '- Sign the `wire` form at [the bank](https://bank.example/forms)',
  '- Reply to Sam',
  '  - about the lease',
  '',
  '```sh',
  'cfo snapshot --date 2026-10-01',
  '```',
  '',
  '<img src=x onerror="window.__injected = true">',
].join('\n');
const MARKDOWN_BRIEF = {
  role: 'system', kind: 'brief', date: '2026-09-30', state: 'ready',
  summary: '**Cash** is fine.',
  text: 'Cash is fine.\n\n## Money\n\n- Drift is under a point.\n- Nothing is due before Thursday.\n\n## Work\n\n1. One thread waits on Sam.',
  at: ago(40 * MINUTE),
};

test.describe('with Markdown messages', () => {
  test.use({
    hubOptions: {
      build: () => ({
        agents: [ASSISTANT, ...AGENTS],
        personas: {
          assistant: { messages: [
            MARKDOWN_BRIEF,
            { role: 'user', text: 'What needs me?', at: ago(20 * MINUTE) },
            { role: 'assistant', text: 'Cash is fine.', at: ago(19 * MINUTE) },
            { role: 'assistant', text: MARKDOWN_REPLY, at: ago(18 * MINUTE) },
          ] },
        },
      }),
    },
  });

  test('a reply renders its heading, list, code, and link, and raw HTML stays text', async ({ page, hub }) => {
    await page.goto(`${hub.origin}/`);
    await expect(row(page, 'Assistant').locator('.agent-row-preview')).toHaveText(/^Needs you Two things wait on you today: Sign the wire form at the bank Reply to Sam about the lease/);

    await page.goto(`${hub.origin}/?agent=assistant`);
    await expect(messages(page)).toHaveCount(4);
    const reply = messages(page).nth(3).locator('.thread-message-text');
    await expect(reply.locator('h4')).toHaveText('Needs you');
    await expect(reply.locator('strong')).toHaveText('you');
    await expect(reply.locator(':scope > ul > li')).toHaveCount(2);
    await expect(reply.locator('ul ul > li')).toHaveText(['about the lease']);
    await expect(reply.locator('p code')).toHaveText('wire');
    const link = reply.locator('a');
    await expect(link).toHaveText('the bank');
    await expect(link).toHaveAttribute('href', 'https://bank.example/forms');
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    await expect(reply.locator('pre code')).toHaveText('cfo snapshot --date 2026-10-01');
    await expect(reply).not.toContainText('##');
    await expect(reply.locator('img')).toHaveCount(0);
    await expect(reply).toContainText('<img src=x onerror="window.__injected = true">');
    expect(await page.evaluate(() => window.__injected)).toBeUndefined();

    // A plain line is one paragraph, with the bubble's own size.
    const plain = messages(page).nth(2).locator('.thread-message-text');
    await expect(plain.locator('> *')).toHaveCount(1);
    await expect(plain.locator('> p')).toHaveText('Cash is fine.');
    const sizes = await plain.locator('> p').evaluate((node) => {
      const own = getComputedStyle(node);
      const outer = getComputedStyle(node.parentElement);
      return [own.fontSize, own.marginTop, own.marginBottom, outer.fontSize];
    });
    expect(sizes).toEqual(['15px', '0px', '0px', '15px']);
  });

  test('the brief memo renders its headings and lists, and the summary and preview show no markers', async ({ page, hub }) => {
    await page.goto(`${hub.origin}/?agent=assistant`);
    const brief = messages(page).nth(0).locator('details.thread-brief');
    await expect(brief.locator('summary')).toHaveText('Brief, Wednesday, September 30: Cash is fine.');
    await brief.locator('summary').click();
    const body = brief.locator('.thread-brief-body');
    await expect(body.locator('h4')).toHaveText(['Money', 'Work']);
    await expect(body.locator('ul > li')).toHaveText(['Drift is under a point.', 'Nothing is due before Thursday.']);
    await expect(body.locator('ol > li')).toHaveText(['One thread waits on Sam.']);
    await expect(body).not.toContainText('##');
  });
});

test.describe('with a model picker under the composer', () => {
  const SETTINGS = { model: { default: 'opus', effort: 'high' }, brief: { agent: null } };
  test.use({ hubOptions: { build: () => ({ ...seeded().build(), settings: SETTINGS }) } });

  const button = (page) => page.locator('#agent-model');
  const menu = (page) => page.locator('#agent-model-menu');
  const option = (page, name) => menu(page).getByRole('option', { name, exact: true });
  const level = (page, name) => menu(page).locator('.effort-option', { hasText: new RegExp(`^${name}$`) });

  test('the button shows the effective pair and the picker marks the default, the choice, and the effort', async ({ page, hub }) => {
    await page.goto(`${hub.origin}/?agent=cfo`);
    await expect(button(page)).toHaveText('Opus · High');
    await expect(button(page)).toHaveAttribute('aria-expanded', 'false');
    await expect(menu(page)).toBeHidden();
    await expect(page.locator('#agent-model-note')).toBeHidden();
    expect((await button(page).boundingBox()).height).toBeGreaterThanOrEqual(44);

    await button(page).click();
    await expect(menu(page)).toBeVisible();
    await expect(button(page)).toHaveAttribute('aria-expanded', 'true');
    await expect(menu(page).locator('.model-option')).toHaveText(['Fable', 'OpusDefault', 'Sonnet', 'Haiku']);
    await expect(option(page, 'Opus Default')).toHaveAttribute('aria-selected', 'true');
    await expect(option(page, 'Opus Default')).toBeFocused();
    await expect(menu(page).locator('.effort-option')).toHaveText(['Low', 'Medium', 'High', 'Extra high', 'Max']);
    await expect(level(page, 'High')).toHaveAttribute('aria-pressed', 'true');
    await expect(menu(page).locator('[aria-pressed="true"]')).toHaveCount(1);
    await expect(page.locator('#agent-model-reset')).toBeDisabled();

    await page.keyboard.press('Escape');
    await expect(menu(page)).toBeHidden();
    await expect(button(page)).toBeFocused();
    expect(hub.requests('/api/agents/cfo/model')).toEqual([]);
  });

  test('choosing a model and an effort changes the button, posts the route, adds the line, and a reload keeps it; the reset returns to the default', async ({ page, hub }) => {
    await page.goto(`${hub.origin}/?agent=cfo`);
    await expect(messages(page)).toHaveCount(2);

    await button(page).click();
    await option(page, 'Sonnet').click();
    await expect(menu(page)).toBeHidden();
    await expect(button(page)).toHaveText('Sonnet · High');
    await expect(button(page)).toBeFocused();
    await expect(messages(page)).toHaveCount(3);
    await expect(messages(page).nth(2)).toHaveText(/^Now on Sonnet\./);
    await expect(messages(page).nth(2)).toHaveClass(/thread-message-system/);
    // The row keeps the thread's real last message; the line is bookkeeping.
    await expect(row(page, 'CFO').locator('.agent-row-preview')).toHaveText('Cash is fine.');
    await expect(row(page, 'CFO').locator('.agent-row-time')).toHaveText('12 minutes ago');
    expect(hub.requests('/api/agents/cfo/model')).toEqual([{ method: 'POST', status: 200 }]);
    expect(hub.personas.calls).toEqual([['setModel', 'cfo', { model: 'sonnet' }]]);

    await button(page).click();
    await expect(option(page, 'Sonnet')).toHaveAttribute('aria-selected', 'true');
    await expect(option(page, 'Opus Default')).toHaveAttribute('aria-selected', 'false');
    await expect(page.locator('#agent-model-reset')).toBeEnabled();
    await level(page, 'Low').click();
    await expect(button(page)).toHaveText('Sonnet · Low');
    await expect(messages(page)).toHaveCount(4);
    await expect(messages(page).nth(3)).toHaveText(/^Now on Sonnet, low effort\./);
    expect(hub.personas.calls.at(-1)).toEqual(['setModel', 'cfo', { effort: 'low' }]);

    await page.reload();
    await expect(button(page)).toHaveText('Sonnet · Low');
    await expect(messages(page)).toHaveCount(4);
    await expect(row(page, 'CFO').locator('.agent-row-preview')).toHaveText('Cash is fine.');

    await button(page).click();
    await page.locator('#agent-model-reset').click();
    await expect(button(page)).toHaveText('Opus · High');
    await expect(messages(page)).toHaveCount(5);
    await expect(messages(page).nth(4)).toHaveText(/^Back to the agent's default\./);
    expect(hub.personas.calls.at(-1)).toEqual(['setModel', 'cfo', { model: null, effort: null }]);
  });

  test('a change during a turn is refused with the sentence, and the choice stands', async ({ page, hub }) => {
    hub.personas.hold('cfo');
    await page.goto(`${hub.origin}/?agent=cfo`);
    await page.locator('#agent-input').fill('Take your time.');
    await page.locator('#agent-send').click();
    await expect(page.locator('#agent-status-text')).toHaveText('CFO is working.');

    await button(page).click();
    await option(page, 'Sonnet').click();
    await expect(page.locator('#agent-failure')).toHaveText('Wait for the turn to finish before changing the model.');
    await expect(button(page)).toHaveText('Opus · High');
    expect(hub.requests('/api/agents/cfo/model')).toEqual([{ method: 'POST', status: 409 }]);

    await hub.personas.reply('cfo', 'Done.');
    await expect(page.locator('#agent-status')).toBeHidden();
    await button(page).click();
    await option(page, 'Sonnet').click();
    await expect(button(page)).toHaveText('Sonnet · High');
    await expect(page.locator('#agent-failure')).toBeHidden();
  });

  test('New thread returns the button to the default', async ({ page, hub }) => {
    await page.goto(`${hub.origin}/?agent=cfo`);
    await button(page).click();
    await option(page, 'Haiku').click();
    await expect(button(page)).toHaveText('Haiku · High');

    await page.locator('#agent-new-thread').click();
    await page.locator('#agent-confirm').getByRole('button', { name: 'Start new thread' }).click();
    await expect(messages(page)).toHaveText([/^New thread/]);
    await expect(button(page)).toHaveText('Opus · High');
    await button(page).click();
    await expect(option(page, 'Opus Default')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#agent-model-reset')).toBeDisabled();
  });

  test('a Codex agent gets a note in place of the button', async ({ page, hub }) => {
    await page.goto(`${hub.origin}/?agent=dev`);
    await expect(pane(page).locator('#agent-name')).toHaveText('Dev');
    await expect(button(page)).toBeHidden();
    await expect(page.locator('#agent-model-note')).toHaveText('Codex, its own settings');
    await expect(page.locator('#agent-model-note')).toBeVisible();
  });

  test('at phone width the picker is a sheet along the bottom that Escape and a tap outside close', async ({ page, hub }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${hub.origin}/?agent=cfo`);
    await expect(button(page)).toHaveText('Opus · High');

    await button(page).click();
    await expect(menu(page)).toBeVisible();
    const box = await menu(page).boundingBox();
    expect(box.x).toBe(0);
    expect(box.width).toBe(390);
    expect(Math.round(box.y + box.height)).toBe(844);
    await expect(menu(page).locator('.effort-option')).toHaveCount(5);

    await page.keyboard.press('Escape');
    await expect(menu(page)).toBeHidden();
    await expect(button(page)).toBeFocused();

    await button(page).click();
    await expect(menu(page)).toBeVisible();
    await page.mouse.click(195, 300);
    await expect(menu(page)).toBeHidden();
    expect(hub.requests('/api/agents/cfo/model')).toEqual([]);
  });
});

// The settings form and New agent, against the harness's in-memory
// registry: a save validates with the real validator (any absolute path
// counts as a folder) and lands in hub.registry.writes.
test.describe('the settings form', () => {
  test.use({ hubOptions: { build: () => seeded().build() } });
  const form = (page) => page.locator('#agent-form');
  const field = (page, name) => form(page).locator(`[name="${name}"]`);
  const save = (page) => form(page).getByRole('button', { name: 'Save' });
  const checks = (page) => form(page).locator('input[name="accepts"]');
  async function openForm(page, hub, id) {
    await page.goto(`${hub.origin}/?agent=${id}`);
    await page.locator('#agent-details-toggle').click();
    await expect(field(page, 'name')).toBeVisible();
  }

  test('Save is off until a field changes, and Cancel puts the values back', async ({ page, hub }) => {
    await openForm(page, hub, 'cfo');
    await expect(save(page)).toBeDisabled();
    await expect(form(page).locator('.form-field-group-name')).toBeHidden();
    await expect(field(page, 'model')).toHaveValue('');
    await expect(field(page, 'model').locator('option:checked')).toHaveText('Default (Claude Code)');
    await expect(field(page, 'effort').locator('option:checked')).toHaveText('Default (Claude Code)');
    await expect(field(page, 'pinned')).not.toBeChecked();
    await field(page, 'role').fill('Finance');
    await expect(save(page)).toBeEnabled();
    await form(page).getByRole('button', { name: 'Cancel' }).click();
    await expect(field(page, 'role')).toHaveValue('Money');
    await expect(save(page)).toBeDisabled();
    expect(hub.registry.writes).toHaveLength(0);
  });

  test('editing the role and saving changes the header and the row', async ({ page, hub }) => {
    await openForm(page, hub, 'cfo');
    await field(page, 'role').fill('Finance');
    await field(page, 'model').selectOption('sonnet');
    await field(page, 'effort').selectOption('low');
    await save(page).click();
    await expect(page.locator('#agent-chips .role-chip')).toHaveText('Finance');
    await expect(field(page, 'role')).toHaveValue('Finance');
    await expect(save(page)).toBeDisabled();
    await expect(form(page).locator('.form-problems')).toBeHidden();
    expect(hub.registry.writes).toHaveLength(1);
    const written = hub.registry.writes[0].agents.find((a) => a.id === 'cfo');
    expect(written).toEqual({
      id: 'cfo', name: 'CFO', role: 'Finance', description: 'Invented.', group: 'work', kind: 'persona', cwd: '/invented/cfo',
      provider: 'claude', model: 'sonnet', effort: 'low', routines: ['com.hunter.cfo.daily', 'com.hunter.cfo.weekly'],
    });
    if (!phone(page)) await expect(row(page, 'CFO').locator('.role-chip')).toHaveText('Finance');
    // The composer follows the agent's level.
    if (!phone(page)) await expect(page.locator('#agent-model-label')).toHaveText('Sonnet · Low');
  });

  test('a blank name is refused with the problem and changes nothing', async ({ page, hub }) => {
    await openForm(page, hub, 'cfo');
    await field(page, 'name').fill('');
    await save(page).click();
    await expect(form(page).locator('.form-problems li')).toHaveText(['name must be a non-empty string of at most 40 characters']);
    await expect(page.locator('#agent-name')).toHaveText('CFO');
    expect(hub.registry.writes).toHaveLength(0);
    // The next edit clears the list.
    await field(page, 'name').fill('C');
    await expect(form(page).locator('.form-problems')).toBeHidden();
  });

  test('a changed folder is saved with ~ expanded and says when it applies', async ({ page, hub }) => {
    await openForm(page, hub, 'cfo');
    await field(page, 'cwd').fill('~/elsewhere');
    await save(page).click();
    await expect(form(page).locator('.form-note-line')).toHaveText('The folder applies when a new thread starts.');
    const written = hub.registry.writes[0].agents.find((a) => a.id === 'cfo');
    expect(written.cwd.endsWith('/elsewhere')).toBe(true);
    expect(written.cwd.startsWith('/')).toBe(true);
    await expect(field(page, 'cwd')).toHaveValue('~/elsewhere');
  });

  test('New group adds a heading, and a name that slugs to a listed group joins it', async ({ page, hub }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await openForm(page, hub, 'brain');
    await field(page, 'group').selectOption('__new__');
    await expect(form(page).locator('.form-field-group-name')).toBeVisible();
    await field(page, 'groupName').fill('Side Projects');
    await save(page).click();
    // This registry lists no groups, so the new one is the first listed and
    // the groups the agents name follow it.
    await expect(page.locator('.agent-group-heading')).toHaveText(['Side Projects', 'Work', 'Personal']);
    await expect(field(page, 'group')).toHaveValue('side-projects');
    await expect(field(page, 'group').locator('option')).toHaveText(['Side Projects', 'Work', 'Personal', 'New group…']);
    expect(hub.registry.writes[0].groups).toEqual([{ id: 'side-projects', name: 'Side Projects' }]);
    expect(hub.registry.writes[0].agents.find((a) => a.id === 'brain').group).toBe('side-projects');

    // A name that slugs to a group already listed joins it without a rename.
    await field(page, 'group').selectOption('__new__');
    await field(page, 'groupName').fill('Side projects');
    await save(page).click();
    await expect(field(page, 'group')).toHaveValue('side-projects');
    await expect(form(page).locator('.form-field-group-name')).toBeHidden();
    await expect(page.locator('.agent-group-heading')).toHaveText(['Side Projects', 'Work', 'Personal']);
    expect(hub.registry.writes).toHaveLength(2);
    expect(hub.registry.writes[1].groups).toEqual([{ id: 'side-projects', name: 'Side Projects' }]);
  });

  test('Everyone and the named agents exclude each other, and no one chosen is everyone', async ({ page, hub }) => {
    await openForm(page, hub, 'cfo');
    await expect(checks(page)).toHaveCount(3);
    await expect(form(page).locator('.form-check')).toHaveText(['Everyone', 'Second brain', 'Dev', 'Pinned']);
    await expect(checks(page).nth(0)).toBeChecked();
    await checks(page).nth(1).check();
    await expect(checks(page).nth(0)).not.toBeChecked();
    await checks(page).nth(2).check();
    await save(page).click();
    await expect(save(page)).toBeDisabled();
    expect(hub.registry.writes[0].agents.find((a) => a.id === 'cfo').accepts).toEqual(['brain', 'dev']);
    await expect(checks(page).nth(1)).toBeChecked();

    await checks(page).nth(0).check();
    await expect(checks(page).nth(1)).not.toBeChecked();
    await expect(checks(page).nth(2)).not.toBeChecked();
    await checks(page).nth(0).click();
    await expect(checks(page).nth(0)).toBeChecked();
    await expect(save(page)).toBeEnabled();
    await save(page).click();
    await expect(save(page)).toBeDisabled();
    expect('accepts' in hub.registry.writes[1].agents.find((a) => a.id === 'cfo')).toBe(false);
  });

  test("a Codex persona's form says Codex, its own settings", async ({ page, hub }) => {
    await openForm(page, hub, 'dev');
    await expect(form(page).locator('.form-note-codex')).toHaveText('Codex, its own settings');
    await expect(field(page, 'model')).toHaveCount(0);
    await expect(field(page, 'effort')).toHaveCount(0);
    await expect(field(page, 'permission')).toHaveCount(0);
    await expect(form(page).locator('.form-note-permission')).toHaveCount(0);
    await expect(field(page, 'role')).toHaveValue('Code');
  });

  test('Permissions offers the system default and the three levels, the sentence follows the choice, and Save writes the level', async ({ page, hub }) => {
    await openForm(page, hub, 'cfo');
    const note = form(page).locator('.form-note-permission');
    await expect(field(page, 'permission')).toHaveValue('');
    await expect(field(page, 'permission').locator('option:checked')).toHaveText('System default (Ask)');
    expect(await field(page, 'permission').locator('option').allTextContents()).toEqual(['System default (Ask)', 'Ask', 'Auto', 'Full access']);
    await expect(note).toHaveText('Asks before each tool that is not already allowed.');
    await expect(save(page)).toBeDisabled();

    await field(page, 'permission').selectOption('full');
    await expect(note).toHaveText('Runs every tool without asking.');
    await expect(save(page)).toBeEnabled();
    await field(page, 'permission').selectOption('auto');
    await expect(note).toHaveText('Claude decides, and asks only when it is unsure.');
    await field(page, 'permission').selectOption('full');
    await save(page).click();
    await expect(save(page)).toBeDisabled();
    expect(hub.registry.writes).toHaveLength(1);
    const written = hub.registry.writes[0].agents.find((a) => a.id === 'cfo');
    expect(written.permission).toBe('full');
    expect(Object.keys(written)).toEqual(['id', 'name', 'role', 'description', 'group', 'kind', 'cwd', 'provider', 'permission', 'routines']);
    await expect(field(page, 'permission')).toHaveValue('full');
    await expect(note).toHaveText('Runs every tool without asking.');
    // The level shows nowhere but the form: the row's chips are as before.
    if (!phone(page)) {
      await expect(row(page, 'CFO').locator('.role-chip')).toHaveText('Money');
      await expect(row(page, 'CFO').getByText('Full access')).toHaveCount(0);
    }
    await expect(page.locator('#agent-chips').getByText('Full access')).toHaveCount(0);

    await page.reload();
    await page.locator('#agent-details-toggle').click();
    await expect(field(page, 'permission')).toHaveValue('full');
    await expect(note).toHaveText('Runs every tool without asking.');

    // Back to the system default writes no key.
    await field(page, 'permission').selectOption('');
    await expect(note).toHaveText('Asks before each tool that is not already allowed.');
    await save(page).click();
    await expect(save(page)).toBeDisabled();
    expect(hub.registry.writes).toHaveLength(2);
    expect('permission' in hub.registry.writes[1].agents.find((a) => a.id === 'cfo')).toBe(false);
    await expect(field(page, 'permission')).toHaveValue('');
  });

  test('New agent fills the defaults, slugs the id from the name, and opens the new thread', async ({ page, hub }) => {
    await page.goto(`${hub.origin}/`);
    const open = page.locator('#agents-new');
    await expect(open).toHaveText('New agent');
    if (phone(page)) await expect(page.locator('#agent-panel')).toBeHidden();
    await open.click();
    await expect(page.locator('#agent-details')).toBeVisible();
    await expect(page.locator('#agent-details .details-name')).toHaveText('New agent');
    await expect(field(page, 'name')).toBeFocused();
    await expect(field(page, 'group')).toHaveValue('work');
    await expect(field(page, 'model').locator('option:checked')).toHaveText('Default (Claude Code)');
    await expect(field(page, 'effort').locator('option:checked')).toHaveText('Default (Claude Code)');
    await expect(field(page, 'permission').locator('option:checked')).toHaveText('System default (Ask)');
    await expect(field(page, 'cwd')).toHaveValue('');
    await expect(checks(page)).toHaveCount(4);
    if (phone(page)) {
      await expect(page.locator('#agents-list')).toBeHidden();
      await expect(page.locator('#agent-name')).toHaveText('New agent');
    }

    await field(page, 'name').fill('Scout Two');
    await expect(field(page, 'agentId')).toHaveValue('scout-two');
    await field(page, 'role').fill('Files');
    await field(page, 'description').fill('Reads my files.');
    await field(page, 'cwd').fill('~/scout');
    await form(page).getByRole('button', { name: 'Create' }).click();

    await expect(page.locator('#agent-name')).toHaveText('Scout Two');
    await expect(page).toHaveURL(`${hub.origin}/?agent=scout-two`);
    await expect(page.locator('#agent-messages .thread-line')).toHaveText('No messages yet.');
    await expect(page.locator('#agent-details')).toBeHidden();
    if (!phone(page)) await expect(row(page, 'Scout Two').locator('.role-chip')).toHaveText('Files');
    const written = hub.registry.writes[0].agents.at(-1);
    expect(written).toMatchObject({ id: 'scout-two', name: 'Scout Two', role: 'Files', description: 'Reads my files.', group: 'work', kind: 'persona', provider: 'claude' });
    expect(written.cwd.endsWith('/scout')).toBe(true);
    expect('model' in written).toBe(false);
    expect('permission' in written).toBe(false);
    expect('accepts' in written).toBe(false);
  });

  test('a duplicate id is refused and Cancel leaves New agent', async ({ page, hub }) => {
    await page.goto(`${hub.origin}/`);
    await page.locator('#agents-new').click();
    await field(page, 'name').fill('CFO');
    await expect(field(page, 'agentId')).toHaveValue('cfo');
    await field(page, 'agentId').fill('cfo');
    await field(page, 'name').fill('CFO again');
    await expect(field(page, 'agentId')).toHaveValue('cfo');
    await field(page, 'role').fill('Money');
    await field(page, 'description').fill('Twice.');
    await field(page, 'cwd').fill('/invented/twice');
    await form(page).getByRole('button', { name: 'Create' }).click();
    await expect(form(page).locator('.form-problems li')).toHaveText(['An agent with that id exists.']);
    await form(page).getByRole('button', { name: 'Cancel' }).click();
    await expect(page.locator('#agent-details')).toBeHidden();
    await expect(page.locator('#agents-new')).toBeFocused();
    expect(hub.registry.writes).toHaveLength(0);
  });
});

// Phase 3, piece 1: messages carry who sent them and lines about a
// delegation render; nothing sends yet, so the threads are seeded.
const DELEGATION = (fields) => ({ role: 'system', kind: 'delegation', ...fields });
const FROM_ASSISTANT = {
  role: 'user', from: 'assistant', mentions: ['brain'], text: 'Should he rebalance? Ask @Second brain about the lease too.', at: ago(9 * MINUTE),
};

test.describe('the settings form with Auto as the system default', () => {
  test.use({ hubOptions: { build: () => ({ ...seeded().build(), settings: { model: { default: null, effort: null }, brief: { agent: null }, permission: { default: 'auto' } } }) } });

  test('the default option names the system level and the sentence is its own until a level is chosen', async ({ page, hub }) => {
    await page.goto(`${hub.origin}/?agent=cfo`);
    await page.locator('#agent-details-toggle').click();
    const form = page.locator('#agent-form');
    const select = form.locator('[name="permission"]');
    await expect(select).toHaveValue('');
    await expect(select.locator('option:checked')).toHaveText('System default (Auto)');
    await expect(form.locator('.form-note-permission')).toHaveText('Claude decides, and asks only when it is unsure.');
    expect(hub.state.snapshot().agents.find((a) => a.id === 'cfo').permission).toEqual({ level: 'auto', source: 'system', agent: null, default: 'auto' });
    await select.selectOption('ask');
    await expect(form.locator('.form-note-permission')).toHaveText('Asks before each tool that is not already allowed.');
  });
});

test.describe('with messages between agents', () => {
  test.use({
    hubOptions: {
      build: () => ({
        agents: [ASSISTANT, ...AGENTS],
        personas: {
          assistant: { messages: [
            { role: 'user', text: 'Should I rebalance? @CFO knows.', mentions: ['cfo'], at: ago(10 * MINUTE) },
            DELEGATION({ state: 'sent', to: 'cfo', text: 'Messaged CFO', summary: 'Messaged CFO', at: ago(10 * MINUTE + 1_000) }),
            DELEGATION({ state: 'busy', to: 'brain', text: 'Second brain is busy. Try again in a moment.', summary: 'Second brain is busy. Try again in a moment.', at: ago(9 * MINUTE) }),
            DELEGATION({ state: 'refused', reason: 'not_allowed', to: 'brain', from: 'assistant', text: 'Second brain does not accept messages from Assistant.', summary: 'Second brain does not accept messages from Assistant.', at: ago(8 * MINUTE) }),
            DELEGATION({ state: 'waiting', to: 'cfo', text: 'CFO is waiting for you.', summary: 'CFO is waiting for you.', at: ago(7 * MINUTE) }),
            DELEGATION({ state: 'failed', to: 'cfo', text: 'CFO could not answer.', summary: 'CFO could not answer.', at: ago(6 * MINUTE) }),
            DELEGATION({ state: 'finished', to: 'cfo', delegationId: 'd1', summary: 'No. Drift is under a point.',
              text: 'No. Drift is under a point.\n\n- Nothing is due before Thursday.\n- The **wire** goes out Friday.', at: ago(5 * MINUTE) }),
            { role: 'assistant', text: 'CFO says no: drift is under a point.', at: ago(4 * MINUTE) },
          ] },
          cfo: { messages: [
            FROM_ASSISTANT,
            { role: 'assistant', text: 'No. Drift is under a point.', at: ago(8 * MINUTE) },
            { role: 'user', text: 'Thanks. Tell @Second brain I said so.', mentions: ['brain'], at: ago(3 * MINUTE) },
          ] },
        },
      }),
    },
  });

  test('a message another agent sent shows its sender, previews with its name, and mentions render as pills', async ({ page, hub }) => {
    await page.goto(`${hub.origin}/`);
    // The sender's reply is CFO's last message; the Assistant's row keeps its own reply, since delegation lines are bookkeeping.
    await expect(row(page, 'CFO').locator('.agent-row-preview')).toHaveText('You: Thanks. Tell @Second brain I said so.');
    await expect(row(page, 'Assistant').locator('.agent-row-preview')).toHaveText('CFO says no: drift is under a point.');

    await page.goto(`${hub.origin}/?agent=cfo`);
    await expect(messages(page)).toHaveCount(3);
    const first = messages(page).nth(0);
    await expect(first).toHaveClass(/thread-message-agent/);
    await expect(first).toHaveClass(/thread-message-assistant/);
    await expect(first).not.toHaveClass(/thread-message-user/);
    const label = first.locator('a.thread-message-from');
    await expect(label).toHaveText('Assistant');
    await expect(label).toHaveAttribute('data-agent', 'assistant');
    await expect(label).toHaveAttribute('href', '/?agent=assistant');
    const pill = first.locator('.mention');
    await expect(pill).toHaveText('@Second brain');
    await expect(pill).toHaveAttribute('data-mention', 'brain');
    await expect(first.locator('.thread-message-text')).toHaveText('Should he rebalance? Ask @Second brain about the lease too.');
    // Hunter's own message stays on the right with no label, and its mention is a pill too.
    const last = messages(page).nth(2);
    await expect(last).toHaveClass(/thread-message-user/);
    await expect(last.locator('.thread-message-from')).toHaveCount(0);
    await expect(last.locator('.mention')).toHaveText('@Second brain');
    // The sender's label opens the sender's thread.
    await label.click();
    await expect(page).toHaveURL(/agent=assistant/);
    await expect(page.locator('#agent-name')).toHaveText('Assistant');
  });

  test('delegation lines render centered with the agent linked, and a finished one opens to the reply', async ({ page, hub }) => {
    await page.goto(`${hub.origin}/?agent=assistant`);
    await expect(messages(page)).toHaveCount(8);
    const lines = page.locator('#agent-messages .thread-message-delegation');
    await expect(lines).toHaveCount(6);
    await expect(lines.nth(0)).toHaveClass(/thread-message-system/);
    await expect(lines.nth(0).locator('.thread-message-text')).toHaveText('Messaged CFO');
    await expect(lines.nth(0).locator('a[data-agent="cfo"]')).toHaveText('CFO');
    await expect(lines.nth(1).locator('.thread-message-text')).toHaveText('Second brain is busy. Try again in a moment.');
    await expect(lines.nth(2).locator('.thread-message-text')).toHaveText('Second brain does not accept messages from Assistant.');
    await expect(lines.nth(3).locator('.thread-message-text')).toHaveText('CFO is waiting for you.');
    await expect(lines.nth(3).locator('a[data-agent="cfo"]')).toHaveCount(1);
    await expect(lines.nth(4).locator('.thread-message-text')).toHaveText('CFO could not answer.');

    const finished = lines.nth(5).locator('details.thread-delegation');
    await expect(finished).toBeVisible();
    await expect(finished).not.toHaveAttribute('open', /.*/);
    await expect(finished.locator('summary')).toHaveText('CFO replied: No. Drift is under a point.');
    await expect(finished.locator('.thread-brief-body')).toBeHidden();
    await finished.locator('summary').click();
    await expect(finished).toHaveAttribute('open', '');
    await expect(finished.locator('.thread-brief-body li')).toHaveText(['Nothing is due before Thursday.', 'The wire goes out Friday.']);
    await expect(finished.locator('.thread-brief-body strong')).toHaveText('wire');
    await expect(lines.nth(5).locator('a.thread-delegation-link[data-agent="cfo"]')).toHaveText('Open CFO');
    // The mention in Hunter's own message is a pill here too.
    await expect(messages(page).nth(0).locator('.mention')).toHaveAttribute('data-mention', 'cfo');
  });
});

// Phase 3, piece 2: the Assistant asks CFO through the delegation service
// as its fake turn, and the lines arrive live on both threads.
test.describe('with a live exchange between agents', () => {
  test.use({
    hubOptions: {
      build: () => ({
        agents: [ASSISTANT, ...AGENTS],
        delegationWaitMs: 150,
        personas: {
          assistant: {
            delegate: { to: 'cfo', text: 'Is he over on equities? One line.' },
            messages: [{ role: 'assistant', text: 'Morning.', at: ago(10 * MINUTE) }],
          },
          cfo: { messages: [{ role: 'assistant', text: 'Cash is fine.', at: ago(12 * MINUTE) }] },
        },
      }),
    },
  });

  test('a reply within the wait lands inline: the sent line, the reply, and the message with its sender on the other thread', async ({ page, hub }) => {
    await page.goto(`${hub.origin}/?agent=assistant`);
    await expect(messages(page)).toHaveCount(1);
    await page.locator('#agent-input').fill('Ask CFO about equities.');
    await page.locator('#agent-send').click();

    await expect(messages(page)).toHaveCount(5);
    await expect(messages(page).nth(1)).toHaveClass(/thread-message-user/);
    const lines = page.locator('#agent-messages .thread-message-delegation');
    await expect(lines).toHaveCount(2);
    await expect(lines.nth(0).locator('.thread-message-text')).toHaveText('Messaged CFO');
    await expect(lines.nth(0).locator('a[data-agent="cfo"]')).toHaveText('CFO');
    const finished = lines.nth(1).locator('details.thread-delegation');
    await expect(finished.locator('summary')).toHaveText('CFO replied: Reply: Is he over on equities?');
    await expect(finished.locator('.thread-brief-body')).toBeHidden();
    await expect(lines.nth(1).locator('a.thread-delegation-link[data-agent="cfo"]')).toHaveText('Open CFO');
    await expect(messages(page).nth(4)).toHaveText(/^Reply: Is he over on equities\? One line\./);
    // The row keeps the real last message, never a line.
    await expect(row(page, 'Assistant').locator('.agent-row-preview')).toHaveText('Reply: Is he over on equities? One line.');
    await expect(row(page, 'CFO').locator('.agent-row-preview')).toHaveText('Reply: Is he over on equities? One line.');

    await lines.nth(1).locator('a.thread-delegation-link').click();
    await expect(page).toHaveURL(/agent=cfo/);
    await expect(messages(page)).toHaveCount(3);
    const incoming = messages(page).nth(1);
    await expect(incoming).toHaveClass(/thread-message-agent/);
    await expect(incoming.locator('a.thread-message-from')).toHaveText('Assistant');
    await expect(incoming.locator('.thread-message-text')).toHaveText('Is he over on equities? One line.');
    await expect(messages(page).nth(2)).toHaveText(/^Reply: Is he over on equities\? One line\./);
  });

  test('a reply after the wait is pending, then its line arrives when the other agent answers', async ({ page, hub }) => {
    hub.personas.hold('cfo');
    await page.goto(`${hub.origin}/?agent=assistant`);
    await page.locator('#agent-input').fill('Ask CFO, no rush.');
    await page.locator('#agent-send').click();

    await expect(messages(page)).toHaveCount(4);
    const lines = page.locator('#agent-messages .thread-message-delegation');
    await expect(lines).toHaveCount(1);
    await expect(lines.nth(0).locator('.thread-message-text')).toHaveText('Messaged CFO');
    await expect(messages(page).nth(3).locator('.thread-message-text')).toHaveText('CFO is still working. The reply will arrive in this thread.');
    await expect(page.locator('#agent-send')).toBeEnabled();
    await expect(row(page, 'CFO').locator('.agent-row-state')).toHaveText('Working');

    await hub.personas.reply('cfo', 'Not over. Drift is under a point.');
    await expect(messages(page)).toHaveCount(5);
    await expect(lines).toHaveCount(2);
    const finished = lines.nth(1).locator('details.thread-delegation');
    await expect(finished.locator('summary')).toHaveText('CFO replied: Not over.');
    await finished.locator('summary').click();
    await expect(finished.locator('.thread-brief-body')).toHaveText('Not over. Drift is under a point.');
    await expect(row(page, 'Assistant').locator('.agent-row-preview')).toHaveText('CFO is still working. The reply will arrive in this thread.');
  });

  test('a question raised by the other agent shows a waiting line here and its card, answerable from this thread', async ({ page, hub }) => {
    hub.personas.hold('cfo');
    await page.goto(`${hub.origin}/?agent=assistant`);
    await page.locator('#agent-input').fill('Ask CFO to check.');
    await page.locator('#agent-send').click();
    await expect(messages(page)).toHaveCount(4);

    hub.personas.raise('cfo', QUESTION_REQUEST);
    const lines = page.locator('#agent-messages .thread-message-delegation');
    await expect(lines).toHaveCount(2);
    await expect(lines.nth(1).locator('.thread-message-text')).toHaveText('CFO is waiting for you.');
    await expect(lines.nth(1).locator('a[data-agent="cfo"]')).toHaveText('CFO');
    const request = page.locator('#agent-request');
    await expect(request).toBeVisible();
    await expect(request.locator('.request-title')).toHaveText(QUESTION);
    await expect(request.locator('.request-note')).toHaveText('Asked while answering you.');
    await expect(row(page, 'CFO').locator('.agent-row-state')).toHaveText('Waiting for you');
    await expect(row(page, 'Assistant').locator('.agent-row-state')).toHaveText('Waiting for you');
    // The Assistant's own turn is over: the status line names CFO, Interrupt is gone, and the composer stays open.
    await expect(page.locator('#agent-status-text')).toHaveText('CFO is waiting for you.');
    await expect(page.locator('#agent-status').getByRole('button', { name: 'Interrupt' })).toBeHidden();
    await expect(page.locator('#agent-send')).toBeEnabled();

    await request.locator('.option').nth(1).click();
    await request.getByRole('button', { name: 'Answer' }).click();
    await expect(request).toBeHidden();
    await expect(row(page, 'Assistant').locator('.agent-row-state')).toHaveCount(0);
    await expect(row(page, 'CFO').locator('.agent-row-state')).toHaveText('Working');
    expect(hub.personas.calls.filter((call) => call[0] === 'answer')).toEqual([
      ['answer', 'assistant', expect.stringMatching(/^req-/), { answers: { [QUESTION]: 'Amber' } }],
      ['answer', 'cfo', expect.stringMatching(/^req-/), { answers: { [QUESTION]: 'Amber' } }],
    ]);
    await hub.personas.reply('cfo', 'Checked.');
    await expect(lines).toHaveCount(3);
    await expect(lines.nth(2).locator('details.thread-delegation summary')).toHaveText('CFO replied: Checked.');
  });

  test('a forwarded card that was already answered says so under the composer', async ({ page, hub }) => {
    hub.personas.hold('cfo');
    await page.route('**/api/agents/assistant/answer', (route) => route.fulfill({
      status: 409, contentType: 'application/json', body: '{"error":"no_such_request"}',
    }));
    await page.goto(`${hub.origin}/?agent=assistant`);
    await page.locator('#agent-input').fill('Ask CFO to check.');
    await page.locator('#agent-send').click();
    await expect(messages(page)).toHaveCount(4);

    hub.personas.raise('cfo', { kind: 'approval', toolName: 'Bash', input: { command: 'ls' } });
    const request = page.locator('#agent-request');
    await expect(request.locator('.request-title')).toHaveText('CFO wants to run Bash');
    await request.getByRole('button', { name: 'Allow' }).click();
    await expect(page.locator('#agent-failure')).toHaveText('That request was already answered or has expired.');
    await expect(request).toBeVisible();
    expect(hub.personas.calls.filter((call) => call[0] === 'answer')).toEqual([]);
  });
});

// Phase 3b, piece 1: a request the receiver raises while answering a
// delegation is forwarded to the thread the exchange started in. The
// receiver raises it on arrival (the `raise` on the sender's delegate seed).
test.describe('with an approval raised while answering a delegation', () => {
  test.use({
    hubOptions: {
      build: () => ({
        agents: [ASSISTANT, ...AGENTS],
        delegationWaitMs: 150,
        personas: {
          assistant: {
            delegate: {
              to: 'cfo', text: 'Check the ledger.',
              raise: { kind: 'approval', toolName: 'Bash', input: { command: 'ls', description: 'List files' } },
            },
            messages: [{ role: 'assistant', text: 'Morning.', at: ago(10 * MINUTE) }],
          },
          cfo: { messages: [{ role: 'assistant', text: 'Cash is fine.', at: ago(12 * MINUTE) }] },
        },
      }),
    },
  });

  test("the card shows here under the other agent's name, Allow here clears it in both threads, and the reply arrives", async ({ page, hub }) => {
    await page.goto(`${hub.origin}/?agent=assistant`);
    await page.locator('#agent-input').fill('Ask CFO to check.');
    await page.locator('#agent-send').click();

    const request = page.locator('#agent-request');
    await expect(request.locator('.request-title')).toHaveText('CFO wants to run Bash');
    await expect(request.locator('.request-note')).toHaveText('Asked while answering you.');
    await expect(request.locator('.request-input')).toHaveText('{\n  "command": "ls",\n  "description": "List files"\n}');
    await expect(request.getByRole('button')).toHaveText(['Allow', 'Deny']);
    await expect(row(page, 'Assistant').locator('.agent-row-state')).toHaveText('Waiting for you');
    await expect(row(page, 'CFO').locator('.agent-row-state')).toHaveText('Waiting for you');
    // Past the wait the ask goes pending and the Assistant's own turn ends; the card stays, with the status line naming CFO.
    await expect(messages(page)).toHaveCount(5);
    await expect(messages(page).nth(4).locator('.thread-message-text')).toHaveText('CFO is still working. The reply will arrive in this thread.');
    await expect(request).toBeVisible();
    await expect(page.locator('#agent-status-text')).toHaveText('CFO is waiting for you.');
    await expect(page.locator('#agent-status').getByRole('button', { name: 'Interrupt' })).toBeHidden();
    await expect(page.locator('#agent-send')).toBeEnabled();

    // The same card in CFO's own thread, without the note.
    await page.goto(`${hub.origin}/?agent=cfo`);
    await expect(request.locator('.request-title')).toHaveText('CFO wants to run Bash');
    await expect(request.locator('.request-note')).toHaveCount(0);
    await expect(page.locator('#agent-composer-reason')).toHaveText('Allow or deny the request first.');

    await page.goto(`${hub.origin}/?agent=assistant`);
    await expect(request.locator('.request-note')).toHaveText('Asked while answering you.');
    await request.getByRole('button', { name: 'Allow' }).click();
    await expect(request).toBeHidden();
    await expect(page.locator('#agent-status')).toBeHidden();
    await expect(row(page, 'Assistant').locator('.agent-row-state')).toHaveCount(0);
    expect(hub.personas.calls.filter((call) => call[0] === 'answer')).toEqual([
      ['answer', 'assistant', expect.stringMatching(/^req-/), { decision: 'allow' }],
      ['answer', 'cfo', expect.stringMatching(/^req-/), { decision: 'allow' }],
    ]);
    const lines = page.locator('#agent-messages .thread-message-delegation');
    await expect(lines).toHaveCount(3);
    await expect(lines.nth(2).locator('details.thread-delegation summary')).toHaveText('CFO replied: Reply: answered');
    await expect(row(page, 'CFO').locator('.agent-row-state')).toHaveCount(0, { timeout: 10_000 });

    await page.goto(`${hub.origin}/?agent=cfo`);
    await expect(request).toBeHidden();
    await expect(messages(page)).toHaveCount(3);
    await expect(messages(page).nth(2)).toHaveText(/^Reply: answered/);
  });
});

test.describe('with the @ picker in the composer', () => {
  // CFO's thread is open and idle; Second brain (waiting on a question) and Dev (a Codex agent) are the agents it can name.
  test.use({ hubOptions: seeded() });

  const input = (page) => page.locator('#agent-input');
  const picker = (page) => page.locator('#agent-mention-menu');
  const options = (page) => picker(page).locator('.mention-option');
  const lastSent = (hub) => hub.personas.sent[hub.personas.sent.length - 1];

  test('typing @ and letters offers the matching agents, Enter inserts the name, Enter again sends with the mention, and the bubble shows a pill', async ({ page, hub }) => {
    await page.goto(`${hub.origin}/?agent=cfo`);
    await expect(messages(page)).toHaveCount(2);
    await expect(picker(page)).toBeHidden();
    await expect(input(page)).toHaveAttribute('aria-expanded', 'false');

    await input(page).fill('Ask @sec');
    await expect(picker(page)).toBeVisible();
    await expect(options(page).locator('.mention-option-name')).toHaveText(['Second brain']);
    await expect(options(page).first()).toHaveAttribute('aria-selected', 'true');
    await expect(options(page).first().locator('.role-chip')).toHaveText('Notes');
    await expect(input(page)).toHaveAttribute('aria-expanded', 'true');
    await expect(input(page)).toHaveAttribute('aria-activedescendant', 'agent-mention-brain');
    expect((await options(page).first().boundingBox()).height).toBeGreaterThanOrEqual(44);

    await input(page).press('Enter');
    await expect(picker(page)).toBeHidden();
    await expect(input(page)).toHaveValue('Ask @Second brain ');
    await expect(input(page)).toBeFocused();
    expect(hub.personas.sent).toEqual([]);

    await input(page).pressSequentially('about the lease');
    await expect(picker(page)).toBeHidden();
    await input(page).press('Enter');
    await expect(messages(page)).toHaveCount(3);
    await expect(input(page)).toHaveValue('');
    expect(lastSent(hub).text).toBe('Ask @Second brain about the lease');
    expect(lastSent(hub).context.mentions).toEqual(['brain']);
    const bubble = messages(page).nth(2);
    await expect(bubble.locator('.thread-message-text')).toHaveText('Ask @Second brain about the lease');
    await expect(bubble.locator('.mention')).toHaveText('@Second brain');
    await expect(bubble.locator('.mention')).toHaveAttribute('data-mention', 'brain');
  });

  test('Down moves, Escape closes and Enter then sends, Shift+Enter breaks the line, and @ inside a word opens nothing', async ({ page, hub }) => {
    await page.goto(`${hub.origin}/?agent=cfo`);
    await expect(messages(page)).toHaveCount(2);

    await input(page).fill('@');
    // Every other agent with a thread, in the list's order; the open agent, the project folder, and the system entry are left out.
    await expect(options(page).locator('.mention-option-name')).toHaveText(['Second brain', 'Dev']);
    await expect(options(page).nth(0)).toHaveAttribute('aria-selected', 'true');
    await input(page).press('ArrowDown');
    await expect(options(page).nth(1)).toHaveAttribute('aria-selected', 'true');
    await expect(input(page)).toHaveAttribute('aria-activedescendant', 'agent-mention-dev');
    await input(page).press('ArrowDown');
    await expect(options(page).nth(0)).toHaveAttribute('aria-selected', 'true');
    await input(page).press('ArrowUp');
    await input(page).press('Tab');
    await expect(input(page)).toHaveValue('@Dev ');
    await expect(picker(page)).toBeHidden();
    await expect(input(page)).toBeFocused();

    await input(page).fill('Hi @d');
    await expect(picker(page)).toBeVisible();
    await input(page).press('Escape');
    await expect(picker(page)).toBeHidden();
    await expect(input(page)).toHaveValue('Hi @d');
    await input(page).press('Enter');
    await expect(messages(page)).toHaveCount(3);
    expect(lastSent(hub).text).toBe('Hi @d');
    expect(lastSent(hub).context.mentions).toBeUndefined();
    await expect(messages(page).nth(2).locator('.mention')).toHaveCount(0);

    await input(page).fill('@d');
    await expect(picker(page)).toBeVisible();
    await input(page).press('Shift+Enter');
    await expect(input(page)).toHaveValue('@d\n');
    await expect(picker(page)).toBeHidden();
    await expect(messages(page)).toHaveCount(3);

    await input(page).fill('mail a@d');
    await expect(picker(page)).toBeHidden();
    await input(page).fill('@zzz');
    await expect(picker(page)).toBeHidden();
  });

  test('a click or a tap on an option inserts the name', async ({ page, hub }) => {
    await page.goto(`${hub.origin}/?agent=cfo`);
    await expect(messages(page)).toHaveCount(2);
    await input(page).fill('Tell @de');
    await expect(options(page).locator('.mention-option-name')).toHaveText(['Dev']);
    await options(page).first().click();
    await expect(picker(page)).toBeHidden();
    await expect(input(page)).toHaveValue('Tell @Dev ');
    await expect(input(page)).toBeFocused();
    expect(hub.personas.sent).toEqual([]);

    await input(page).press('Enter');
    await expect(messages(page)).toHaveCount(3);
    expect(lastSent(hub).context.mentions).toEqual(['dev']);
    await expect(messages(page).nth(2).locator('.mention')).toHaveText('@Dev');
  });
});
