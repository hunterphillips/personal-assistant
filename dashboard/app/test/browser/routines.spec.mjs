// Routines in the Agents view: the panel's list and form under an agent's
// settings, the collapsed section at the foot of the list, the row chips,
// and a run's message and line in the thread, in real browsers against
// the real routine store and scheduler of test/support/browser-server.mjs
// over the fake persona adapter. Health's jobs are in jobs.spec.mjs.

import { readdir } from 'node:fs/promises';

import { expect, expectView, nav, test } from '../support/browser-test.mjs';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const ago = (ms) => new Date(Date.now() - ms).toISOString();

const AGENTS = [
  { id: 'cfo', name: 'CFO', role: 'Money', description: 'Invented.', group: 'work', kind: 'persona', provider: 'claude', cwd: '/invented/cfo',
    jobs: ['com.hunter.cfo.daily'] },
  { id: 'brain', name: 'Second brain', role: 'Notes', description: 'Invented.', group: 'personal', kind: 'persona', provider: 'claude', cwd: '/invented/brain' },
  { id: 'scribe', name: 'Scribe', role: 'Drafts', description: 'Invented, with no routines.', group: 'personal', kind: 'persona', provider: 'claude', cwd: '/invented/scribe' },
  { id: 'dev', name: 'Dev', role: 'Code', description: 'Invented.', group: 'personal', kind: 'persona', provider: 'codex', cwd: '/invented/dev' },
];

const JOBS = [{
  label: 'com.hunter.cfo.daily',
  agentId: 'cfo',
  agentName: 'CFO',
  name: 'cfo.daily',
  schedule: { kind: 'calendar', text: 'Daily at 06:00' },
  logPath: '/invented/logs/cfo.daily.log',
  lastRun: ago(30 * MINUTE),
  outcome: 'ok',
  exitStatus: 0,
  failures24h: null,
  paused: null,
  source: 'launchctl',
  available: true,
}];

const DRIFT = "Read this morning's snapshot and say how far each bucket sits from the policy.";

// Three routines: CFO's two (one with a finished run and a missed span,
// one never run) and Second brain's, switched off.
function routines() {
  const yesterday = ago(DAY + 2 * HOUR);
  return [
    {
      id: 'morning-drift', name: 'Morning drift', agent: 'cfo', instruction: DRIFT, cron: '30 6 * * 1-5',
      runs: [
        { outcome: 'missed', count: 1, from: ago(3 * DAY), to: ago(2 * DAY) },
        { run: 'run-failed', occurrence: ago(2 * DAY), trigger: 'schedule', startedAt: ago(2 * DAY), endedAt: ago(2 * DAY - 10_000), outcome: 'failed', reply: 'Partial answer.', detail: 'Invented failure' },
        { run: 'run-1', occurrence: yesterday, trigger: 'schedule', startedAt: yesterday },
        { run: 'run-1', endedAt: new Date(Date.parse(yesterday) + 48_000).toISOString(), outcome: 'finished', reply: 'Every bucket is within its band.\n\nBonds sit 1.2 points under.' },
      ],
    },
    { id: 'pending-decisions', name: 'Pending decisions', agent: 'cfo', instruction: 'List every open decision.', cron: '0 9 * * 1,4' },
    { id: 'inbox-check', name: 'Inbox check', agent: 'brain', instruction: 'Say how many captures sit in inbox/.', cron: '0 17 * * *', active: false },
  ];
}

const seeded = {
  build: () => ({
    agents: AGENTS,
    jobs: { items: JOBS, focusAvailable: true, refreshedAt: ago(5_000) },
    routines: routines(),
    personas: { cfo: { messages: [{ role: 'user', text: 'How is cash?', at: ago(20 * MINUTE) }, { role: 'assistant', text: 'Cash is fine.', at: ago(12 * MINUTE) }] } },
  }),
};

function row(page, name) {
  return page.locator('.agent-row').filter({ has: page.locator('.agent-row-name', { hasText: new RegExp(`^${name}$`) }) });
}

const panelRoutines = (page) => page.locator('#agent-routines');
const panelRows = (page) => page.locator('#agent-routines .routine-item');
const form = (page) => page.locator('#routine-form');
const problems = (page) => page.locator('#routine-form .form-problems li');
const section = (page) => page.locator('#agents-routines');
const sectionRows = (page) => page.locator('#agents-routines .routine-item');

async function openPanel(page, hub, id) {
  await page.goto(`${hub.origin}/?agent=${id}`);
  await expectView(page, 'agents', 'Agents');
  await page.locator('#agent-details-toggle').click();
  await expect(panelRoutines(page)).toBeVisible();
}

async function openRoutine(page, hub, agentId, name) {
  await openPanel(page, hub, agentId);
  await panelRows(page).filter({ hasText: name }).click();
  await expect(page.locator('#agent-routines-heading')).toHaveText(name);
  await expect(form(page)).toBeVisible();
}

test.describe('with seeded routines', () => {
  test.use({ hubOptions: seeded });

  test('the panel lists the agent\'s routines with their schedule, last run, and chip', async ({ page, hub }) => {
    await openPanel(page, hub, 'cfo');
    await expect(page.locator('#agent-routines-heading')).toHaveText('Routines');
    await expect(panelRows(page).locator('.routine-item-name')).toHaveText(['Morning drift', 'Pending decisions']);
    await expect(panelRows(page).locator('.routine-chip')).toHaveText(['Finished', 'Not yet run']);
    await expect(panelRows(page).nth(0).locator('.routine-item-when')).toHaveText(/^Weekdays at 6:30 · Last run Yesterday /);
    await expect(panelRows(page).nth(1).locator('.routine-item-when')).toHaveText('Every Monday and Thursday at 9:00');
    await expect(page.locator('#agent-form')).toBeVisible();
    await expect(page.locator('#agent-routines [data-agent-action="add-routine"]')).toHaveText('Add routine');

    await openPanel(page, hub, 'brain');
    await expect(panelRows(page).locator('.routine-item-name')).toHaveText(['Inbox check']);
    await expect(panelRows(page).locator('.routine-chip')).toHaveText(['Off']);

    await openPanel(page, hub, 'scribe');
    await expect(panelRows(page)).toHaveCount(0);
    await expect(page.locator('#agent-routines .routine-empty')).toHaveText('No routines yet.');

    // A Codex agent has settings of its own and no routines.
    await page.goto(`${hub.origin}/?agent=dev`);
    await page.locator('#agent-details-toggle').click();
    await expect(page.locator('#agent-form')).toBeVisible();
    await expect(panelRoutines(page)).toBeHidden();
  });

  test('Add routine saves a schedule from the picker and the row shows the daemon\'s words', async ({ page, hub }) => {
    await openPanel(page, hub, 'cfo');
    await page.locator('[data-agent-action="add-routine"]').click();
    await expect(page.locator('#agent-routines-heading')).toHaveText('New routine');
    await expect(page.locator('#agent-form')).toBeHidden();
    await expect(form(page).locator('.form-label')).toHaveText(['Name', 'Instruction', 'When', 'Day of the month']);
    await expect(form(page).locator('[name="cadence"] option')).toHaveText([
      'Every day', 'Weekdays', 'Weekends', 'Every week on…', 'Every hour', 'Every 30 minutes', 'Every month on the…',
    ]);
    await expect(form(page).locator('[name="cadence"]')).toHaveValue('weekdays');
    await expect(form(page).locator('.form-days')).toBeHidden();
    await expect(form(page).locator('.form-field-dom')).toBeHidden();
    await expect(form(page).locator('[name="active"]')).toBeChecked();

    await form(page).locator('[name="name"]').fill('Evening cash');
    await form(page).locator('[name="instruction"]').fill('Say the cash total.');
    await form(page).locator('[name="cadence"]').selectOption('daily');
    await form(page).locator('[name="time"]').fill('18:00');
    await form(page).locator('[data-form-action="save"]').click();

    await expect(form(page)).toHaveCount(0);
    await expect(page.locator('#agent-routines-heading')).toHaveText('Routines');
    const added = panelRows(page).filter({ hasText: 'Evening cash' });
    await expect(added.locator('.routine-item-when')).toHaveText('Every day at 18:00');
    await expect(added.locator('.routine-chip')).toHaveText('Not yet run');
    const stored = hub.routines.current().find((routine) => routine.name === 'Evening cash');
    expect(stored.schedule).toEqual({ cron: '0 18 * * *', text: 'Every day at 18:00' });
    expect(stored.agent).toBe('cfo');
    expect(await readdir(hub.routinesDir)).toContain(`${stored.id}.json`);
  });

  test('a picker with no day chosen shows the sentence until a day is chosen', async ({ page, hub }) => {
    await openPanel(page, hub, 'cfo');
    await page.locator('[data-agent-action="add-routine"]').click();
    await form(page).locator('[name="name"]').fill('Weekly look');
    await form(page).locator('[name="instruction"]').fill('Look over the week.');
    await form(page).locator('[name="cadence"]').selectOption('days');
    await expect(form(page).locator('.form-days')).toBeVisible();
    await expect(form(page).locator('.form-days .form-check')).toHaveText(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
    await form(page).locator('[data-form-action="save"]').click();
    await expect(problems(page)).toHaveText(['Choose at least one day.']);
    expect(hub.routines.current().some((routine) => routine.name === 'Weekly look')).toBe(false);

    await form(page).locator('.form-days input[value="1"]').check();
    await expect(problems(page)).toHaveCount(0);
    await form(page).locator('[data-form-action="save"]').click();
    await expect(panelRows(page).filter({ hasText: 'Weekly look' }).locator('.routine-item-when')).toHaveText('Every Monday at 6:30');

    // Nothing to save is said plainly too.
    await page.locator('[data-agent-action="add-routine"]').click();
    await form(page).locator('[data-form-action="save"]').click();
    await expect(problems(page)).toHaveText(['Give the routine a name.', 'Say what the routine asks CFO to do.']);
  });

  test('edit changes the words and Save returns to the list', async ({ page, hub }) => {
    await openRoutine(page, hub, 'cfo', 'Morning drift');
    await expect(form(page).locator('[name="name"]')).toHaveValue('Morning drift');
    await expect(form(page).locator('[name="instruction"]')).toHaveValue(DRIFT);
    await expect(form(page).locator('[name="cadence"]')).toHaveValue('weekdays');
    await expect(form(page).locator('[name="time"]')).toHaveValue('06:30');
    await expect(form(page).locator('[data-form-action="save"]')).toBeDisabled();

    await form(page).locator('[name="cadence"]').selectOption('daily');
    await form(page).locator('[name="time"]').fill('07:00');
    await expect(form(page).locator('[data-form-action="save"]')).toBeEnabled();
    const before = hub.state.snapshot().routines.items.find((routine) => routine.id === 'morning-drift').nextAt;
    await form(page).locator('[data-form-action="save"]').click();
    await expect(form(page)).toHaveCount(0);
    await expect(panelRows(page).nth(0).locator('.routine-item-when')).toHaveText(/^Every day at 7:00 · Last run/);
    const after = hub.state.snapshot().routines.items.find((routine) => routine.id === 'morning-drift');
    expect(after.schedule.cron).toBe('0 7 * * *');
    expect(after.nextAt).not.toBe(before);

    // Cancel leaves the routine alone.
    await panelRows(page).nth(0).click();
    await form(page).locator('[name="name"]').fill('Something else');
    await form(page).locator('[data-agent-action="cancel-routine"]').last().click();
    await expect(form(page)).toHaveCount(0);
    await expect(panelRows(page).nth(0).locator('.routine-item-name')).toHaveText('Morning drift');
  });

  test('Active off keeps the row with no next fire; Delete asks first and removes it from both lists', async ({ page, hub }) => {
    await openRoutine(page, hub, 'cfo', 'Morning drift');
    await form(page).locator('[name="active"]').uncheck();
    await form(page).locator('[data-form-action="save"]').click();
    await expect(form(page)).toHaveCount(0);
    const off = panelRows(page).filter({ hasText: 'Morning drift' });
    await expect(off.locator('.routine-chip')).toHaveText('Off');
    await expect.poll(() => hub.state.snapshot().routines.items.find((routine) => routine.id === 'morning-drift').nextAt).toBeNull();

    await panelRows(page).filter({ hasText: 'Pending decisions' }).click();
    await form(page).locator('[data-agent-action="delete-routine"]').click();
    const confirm = form(page).locator('.routine-confirm');
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText('Delete Pending decisions? Its runs go with it.');
    await confirm.locator('[data-agent-action="cancel-delete-routine"]').click();
    await expect(confirm).toBeHidden();
    await form(page).locator('[data-agent-action="delete-routine"]').click();
    await confirm.locator('[data-agent-action="confirm-delete-routine"]').click();
    await expect(form(page)).toHaveCount(0);
    await expect(panelRows(page).locator('.routine-item-name')).toHaveText(['Morning drift']);
    expect(hub.routines.current().map((routine) => routine.id)).toEqual(['inbox-check', 'morning-drift']);
    expect(await readdir(hub.routinesDir)).not.toContain('pending-decisions.json');

    if (page.viewportSize().width < 720) {
      await page.locator('[data-agent-action="close-details"]').click();
      await page.locator('#agent-back').click();
    }
    await section(page).locator('summary').click();
    await expect(sectionRows(page).locator('.routine-item-name')).toHaveText(['Morning drift', 'Inbox check']);
    await expect(sectionRows(page).nth(0).locator('.routine-item-when')).toHaveText('Weekdays at 6:30');
  });

  test('Test run shows the run and its reply in Last runs and leaves the thread alone', async ({ page, hub }) => {
    await openRoutine(page, hub, 'cfo', 'Morning drift');
    const runs = page.locator('#routine-runs .routine-run-row');
    await expect(runs).toHaveCount(3);
    await expect(runs.nth(0).locator('.routine-chip')).toHaveText('Finished');
    await expect(runs.nth(0).locator('.routine-run-note')).toHaveText('Replied in 48 seconds.');
    const seededReply = runs.nth(0).locator('details.routine-run-reply');
    await expect(seededReply.locator('summary')).toHaveText('Every bucket is within its band.');
    await seededReply.locator('summary').click();
    await expect(seededReply).toHaveAttribute('open', '');
    await expect(seededReply.locator('.routine-run-reply-body')).toBeVisible();
    await expect(seededReply).toContainText('Every bucket is within its band.');
    await expect(seededReply).toContainText('Bonds sit 1.2 points under.');
    await expect(runs.nth(1).locator('.routine-chip')).toHaveText('Failed');
    await expect(runs.nth(1).locator('.routine-run-note')).toHaveText('The turn failed.');
    await expect(runs.nth(1).locator('.routine-run-reply')).toHaveText('Invented failure');
    await expect(runs.nth(2).locator('.routine-chip')).toHaveText('Missed');
    await expect(runs.nth(2).locator('.routine-run-note')).toHaveText('One fire was missed.');

    await form(page).locator('[data-agent-action="test-routine"]').click();
    await expect(runs).toHaveCount(4);
    await expect(runs.nth(0).locator('.routine-chip')).toHaveText('Finished');
    await expect(runs.nth(0).locator('.routine-run-note')).toHaveText(/^Test run\. Replied in \d+ seconds?\.$/);
    await expect(runs.nth(0).locator('.routine-run-reply')).toHaveText(`Reply: ${DRIFT}`);
    await expect(panelRows(page)).toHaveCount(0);
    expect(hub.personas.sent.at(-1)).toMatchObject({ id: 'cfo', text: DRIFT, context: { routine: { id: 'morning-drift', name: 'Morning drift' } } });

    // A run is a session of its own: neither its instruction nor its reply is a message.
    if (page.viewportSize().width < 720) await page.locator('[data-agent-action="close-details"]').click();
    await expect(page.locator('#agent-messages .thread-message-routine')).toHaveCount(0);
    await expect(page.locator('#agent-messages .thread-message').last()).toContainText('Cash is fine.');
    await expect(row(page, 'CFO').locator('.agent-row-dot')).toHaveCount(0);
  });

  test('a run whose card is raised shows the card and the line; unanswered, the row says Needs you until Hunter writes', async ({ page, hub }) => {
    hub.personas.hold('cfo');
    await openRoutine(page, hub, 'cfo', 'Morning drift');
    await form(page).locator('[data-agent-action="test-routine"]').click();
    await expect.poll(() => hub.personas.sent.length).toBe(1);
    hub.personas.raise('cfo', { kind: 'approval', toolName: 'Bash', input: { command: 'python3 snapshot.py' } });

    if (page.viewportSize().width < 720) await page.locator('[data-agent-action="close-details"]').click();
    await expect(page.locator('#agent-request .request-title')).toHaveText('CFO wants to run Bash');
    await expect(page.locator('#agent-status-text')).toHaveText('CFO is waiting for you.');
    const line = page.locator('#agent-messages .thread-message-routine-line');
    await expect(line.locator('.thread-brief-summary')).toHaveText('CFO is waiting for you during Morning drift.');
    await line.locator('.thread-brief-summary').click();
    await expect(line.locator('.thread-routine-input')).toHaveText('{"command":"python3 snapshot.py"}');
    if (page.viewportSize().width < 720) await page.locator('#agent-back').click();
    await expect(row(page, 'CFO').locator('.agent-row-dot')).toHaveAttribute('aria-label', 'Waiting for you');

    // The card goes unanswered; the turn ends; the run is `waiting`.
    hub.personas.expire('cfo');
    await hub.personas.reply('cfo', 'Done without it.');
    await expect(row(page, 'CFO').locator('.agent-row-dot')).toHaveAttribute('aria-label', 'Needs you');
    await expect.poll(() => hub.routines.lastRun('morning-drift').outcome).toBe('waiting');

    // The form stayed open on the routine; the panel reopens on it.
    if (page.viewportSize().width < 720) await row(page, 'CFO').click();
    if (!(await page.locator('#agent-details').isVisible())) await page.locator('#agent-details-toggle').click();
    await expect(page.locator('#agent-routines-heading')).toHaveText('Morning drift');
    const runs = page.locator('#routine-runs .routine-run-row');
    await expect(runs.nth(0).locator('.routine-chip')).toHaveText('Waiting for you');
    await expect(runs.nth(0).locator('.routine-run-note')).toHaveText('Test run. CFO wanted to run Bash.');
    await expect(runs.nth(0).locator('.routine-run-reply')).toHaveText('Done without it.');
    await expect(panelRows(page)).toHaveCount(0);

    // Hunter's own message clears the chip.
    if (page.viewportSize().width < 720) await page.locator('[data-agent-action="close-details"]').click();
    await page.locator('#agent-input').fill('Thanks, I saw it.');
    await page.locator('#agent-send').click();
    await expect.poll(() => hub.personas.sent.length).toBe(2);
    await hub.personas.reply('cfo', 'Noted.');
    if (page.viewportSize().width < 720) await page.locator('#agent-back').click();
    await expect(row(page, 'CFO').locator('.agent-row-state')).toHaveCount(0);
    await expect(row(page, 'CFO')).toContainText('Noted.');
  });

  test('the section at the foot of the list groups by agent and a row opens the panel on the routine', async ({ page, hub }) => {
    await page.goto(`${hub.origin}/`);
    await expectView(page, 'agents', 'Agents');
    await expect(section(page)).toBeVisible();
    await expect(section(page)).not.toHaveAttribute('open', /.*/);
    await expect(page.locator('#agents-groups .agent-row .agent-row-name')).toHaveText(['CFO', 'Second brain', 'Scribe', 'Dev']);
    await section(page).locator('summary').click();
    await expect(section(page).locator('.agents-routines-heading')).toHaveText(['CFO', 'Second brain']);
    await expect(sectionRows(page).locator('.routine-item-name')).toHaveText(['Morning drift', 'Pending decisions', 'Inbox check']);
    await expect(sectionRows(page).nth(0).locator('.routine-item-when')).toHaveText(/^Weekdays at 6:30 · Next at 6:30 (today|tomorrow|on \w+)$/);
    await expect(sectionRows(page).nth(1).locator('.routine-item-when')).toHaveText(/^Every Monday and Thursday at 9:00 · Next at 9:00 (today|tomorrow|on \w+)$/);
    await expect(sectionRows(page).nth(2).locator('.routine-item-when')).toHaveText('Every day at 17:00');
    await expect(sectionRows(page).locator('.routine-chip')).toHaveText(['Finished', 'Not yet run', 'Off']);
    await expect(sectionRows(page).nth(1)).toHaveAttribute('href', '/?agent=cfo');

    await sectionRows(page).nth(1).click();
    await expect(page).toHaveURL(/\?agent=cfo$/);
    await expect(page.locator('#agent-name')).toHaveText('CFO');
    await expect(page.locator('#agent-details')).toBeVisible();
    await expect(page.locator('#agent-routines-heading')).toHaveText('Pending decisions');
    await expect(form(page).locator('[name="name"]')).toHaveValue('Pending decisions');
    await expect(page.locator('#agent-form')).toBeHidden();

    // Back from the form, the settings form returns.
    await form(page).locator('[data-agent-action="cancel-routine"]').first().click();
    await expect(page.locator('#agent-form')).toBeVisible();
    await expect(page.locator('#agent-routines-heading')).toHaveText('Routines');
  });

  test('Health lists the jobs and no routine', async ({ page, hub }) => {
    await page.goto(`${hub.origin}/health`);
    await expectView(page, 'health', 'Health');
    await expect(page.locator('#jobs-cards .routine-name')).toHaveText(['cfo.daily']);
    await expect(page.locator('#view-health')).not.toContainText('Morning drift');
    await expect(page.locator('#view-health')).not.toContainText('Routines');
    await nav(page, 'Home').click();
    await expect(section(page)).toBeVisible();
  });
});

test.describe('with no routines', () => {
  test.use({ hubOptions: { build: () => ({ agents: AGENTS, personas: {} }) } });

  test('the section says so once opened', async ({ page, hub }) => {
    await page.goto(`${hub.origin}/`);
    await expectView(page, 'agents', 'Agents');
    await section(page).locator('summary').click();
    await expect(section(page).locator('.routine-empty')).toHaveText('No agent has a routine yet.');
    await expect(sectionRows(page)).toHaveCount(0);
  });
});
