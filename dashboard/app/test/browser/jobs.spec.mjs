// The Health view's Settings card and jobs (the code's jobs), the
// settings panel beside a thread with its jobs line, and the shell's event
// stream client, in real
// browsers against the in-memory registry and jobs of
// test/support/browser-server.mjs. Pause and Resume reach the isolated
// Focus copy, whose launchd stubs refuse.

import { expect, expectView, nav, needsFocus, test } from '../support/browser-test.mjs';

const DATE = '2026-09-15';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const ago = (ms) => new Date(Date.now() - ms).toISOString();

const AGENTS = [
  {
    id: 'focus', name: 'Focus', role: 'Tasks', description: 'Invented.', group: 'personal', kind: 'system',
    jobs: ['gmail', 'git', 'notes', 'work', 'calendar', 'drive'].map((name) => `com.focus.scan-${name}`),
  },
  {
    id: 'brain', name: 'Second brain', role: 'Notes', description: 'Invented notes that keep themselves.', group: 'personal',
    kind: 'persona', provider: 'claude', cwd: '/invented/second-brain',
    jobs: ['com.hunter.brain-drain', 'com.hunter.brain-audit', 'com.hunter.brain-refresh'],
  },
  {
    id: 'scribe', name: 'Scribe', role: 'Drafts', description: 'Invented, with no jobs.', group: 'work', kind: 'persona',
    provider: 'codex', cwd: '/elsewhere/scribe',
  },
  { id: 'cfo', name: 'CFO', role: 'Money', description: 'Invented.', group: 'work', kind: 'persona', jobs: ['com.hunter.cfo.daily'] },
];

function job(agent, label, fields) {
  const name = label.replace(/^com\.(focus|hunter)\./, '');
  return {
    label,
    agentId: agent.id,
    agentName: agent.name,
    name,
    schedule: { kind: 'calendar', text: 'Hourly at :35' },
    logPath: `/invented/logs/${name}.log`,
    lastRun: ago(12.5 * MINUTE),
    outcome: 'ok',
    exitStatus: 0,
    failures24h: null,
    paused: null,
    source: 'launchctl',
    available: true,
    ...fields,
  };
}

function focusScan(name, fields) {
  return job(AGENTS[0], `com.focus.scan-${name}`, { source: 'focus', exitStatus: null, paused: false, failures24h: 0, ...fields });
}

function items({ paused = true } = {}) {
  return [
    focusScan('gmail', { outcome: 'wrote', paused, failures24h: 2 }),
    focusScan('git', { outcome: 'running', paused }),
    focusScan('notes', { outcome: 'skipped', lastRun: ago(3.5 * HOUR) }),
    focusScan('work', { outcome: 'failed', failures24h: 1 }),
    focusScan('calendar', { outcome: 'no change' }),
    focusScan('drive', { outcome: 'never ran', lastRun: null }),
    job(AGENTS[1], 'com.hunter.brain-drain', { schedule: { kind: 'calendar', text: 'Daily at 02:30' }, lastRun: ago(30 * HOUR) }),
    job(AGENTS[1], 'com.hunter.brain-audit', { outcome: 'failed', exitStatus: 78, lastRun: ago(5 * 24 * HOUR) }),
    job(AGENTS[1], 'com.hunter.brain-refresh', { outcome: 'not loaded', exitStatus: null, lastRun: null }),
    job(AGENTS[3], 'com.hunter.cfo.daily', {
      schedule: { kind: 'unavailable', text: 'Schedule unavailable' },
      outcome: 'unknown', exitStatus: null, lastRun: null, available: false,
    }),
  ];
}

function seeded(jobs = {}) {
  return { build: () => ({ agents: AGENTS, jobs: { items: items(), focusAvailable: true, refreshedAt: ago(5_000), ...jobs } }) };
}

function card(page, name) {
  return page.locator('.routine-card').filter({ has: page.getByRole('heading', { name, exact: true }) });
}

function row(page, name) {
  return page.locator('.routine-row').filter({ has: page.locator('.routine-name', { hasText: new RegExp(`^${name}$`) }) });
}

function agentRow(page, name) {
  return page.locator('.agent-row').filter({ has: page.locator('.agent-row-name', { hasText: new RegExp(`^${name}$`) }) });
}

// The vertical gap from the bottom of `above` to the top of `below`, or null
// while either is off the page (a rebuild replaces both mid-measure).
async function gap(scope, above, below) {
  const top = await scope.locator(above).boundingBox();
  const bottom = await scope.locator(below).boundingBox();
  return top && bottom ? bottom.y - (top.y + top.height) : null;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

async function openHealth(page, hub) {
  await page.goto(`${hub.origin}/health`);
  await expectView(page, 'health', 'Health');
}

test.describe('with seeded jobs', () => {
  test.use({ hubOptions: seeded() });

  test('each agent with jobs gets a card with its rows and outcome badges', async ({ page, hub }) => {
    await openHealth(page, hub);
    await expect(page.locator('#view-health').getByRole('heading', { name: 'Jobs', level: 1 })).toBeVisible();
    await expect(page.locator('#jobs-updated')).toHaveText('Updated just now');
    await expect(page.locator('#jobs-refresh')).toHaveText('Refresh');

    await expect(page.locator('.routine-card .card-name')).toHaveText(['Focus', 'Second brain', 'CFO']);
    await expect(card(page, 'Focus').locator('.role-chip')).toHaveText('Tasks');
    await expect(card(page, 'CFO').locator('.role-chip')).toHaveText('Money');

    const expected = [
      ['scan-gmail', 'Wrote'],
      ['scan-git', 'Running'],
      ['scan-notes', 'Skipped'],
      ['scan-work', 'Failed'],
      ['scan-calendar', 'No change'],
      ['scan-drive', 'Never ran'],
      ['brain-drain', 'OK'],
      ['brain-audit', 'Failed (exit 78)'],
      ['brain-refresh', 'Not loaded'],
      ['cfo.daily', 'Unknown'],
    ];
    for (const [name, badge] of expected) await expect(row(page, name).locator('.badge')).toHaveText(badge);

    await expect(row(page, 'scan-gmail').locator('.routine-schedule')).toHaveText('Hourly at :35');
    await expect(row(page, 'scan-gmail').locator('.routine-run')).toHaveText(/^12 minutes ago\s*2 failures today$/);
    await expect(row(page, 'scan-work').locator('.routine-failures')).toHaveText('1 failure today');
    await expect(row(page, 'scan-git').locator('.routine-failures')).toHaveCount(0);
    await expect(row(page, 'scan-drive').locator('.badge')).toHaveClass(/badge-wait/);
    await expect(row(page, 'scan-notes').locator('.routine-run')).toHaveText('3 hours ago');
    const yesterday = new Date(Date.parse(hub.jobs.items[6].lastRun));
    await expect(row(page, 'brain-drain').locator('.routine-run')).toHaveText(
      `Yesterday ${pad(yesterday.getHours())}:${pad(yesterday.getMinutes())}`);
    await expect(row(page, 'brain-audit').locator('.routine-run')).toHaveText(/^[A-Z][a-z]{2} \d{1,2} \d{2}:\d{2}$/);
    await expect(row(page, 'brain-refresh').locator('.routine-run')).toHaveText('Never run');
    await expect(row(page, 'cfo.daily').locator('.routine-schedule')).toHaveText('Schedule unavailable');

    const focus = card(page, 'Focus');
    await expect(focus.locator('.card-header .badge')).toHaveText('Paused');
    await expect(focus.locator('[data-jobs-action]')).toHaveText('Resume');
    await expect(card(page, 'Second brain').locator('[data-jobs-action]')).toHaveCount(0);
    await expect(focus.locator('.card-note')).toHaveCount(0);

    // A fresh refreshedAt means opening the view did not refresh.
    expect(hub.jobs.calls).toBe(0);

    for (const button of await page.locator('#view-health button').all()) {
      expect((await button.boundingBox()).height).toBeGreaterThanOrEqual(44);
    }
  });

  test('a job row is selected by pointer or keyboard and stays selected through a refresh', async ({ page, hub }) => {
    await openHealth(page, hub);
    const first = row(page, 'scan-gmail');
    const second = row(page, 'scan-git');

    await first.click();
    await expect(first).toHaveAttribute('aria-current', 'true');
    await expect(second).not.toHaveAttribute('aria-current', 'true');

    await second.focus();
    await page.keyboard.press('Enter');
    await expect(second).toHaveAttribute('aria-current', 'true');
    await expect(first).not.toHaveAttribute('aria-current', 'true');

    await hub.state.refreshJobs();
    await expect(row(page, 'scan-git')).toHaveAttribute('aria-current', 'true');
  });

  test('/routines lands on /health, and Agents holds no jobs', async ({ page, hub }) => {
    await page.goto(`${hub.origin}/routines?a=1`);
    await expect(page).toHaveURL(`${hub.origin}/health?a=1`);
    await expectView(page, 'health', 'Health');
    await expect(page.locator('.routine-card .card-name')).toHaveText(['Focus', 'Second brain', 'CFO']);

    await page.goto(`${hub.origin}/agents`);
    await expectView(page, 'agents', 'Agents');
    await expect(page.locator('#agents-list')).toBeVisible();
    await expect(page.locator('#view-agents .routine-card')).toHaveCount(0);
    await expect(page.locator('#view-agents').getByText(/job/i)).toHaveCount(0);
    expect(hub.jobs.calls).toBe(0);
  });

  test('a thread header has no Jobs button and no rows above the messages', async ({ page, hub }) => {
    await page.goto(`${hub.origin}/?agent=brain`);
    await expect(page.locator('#agent-name')).toHaveText('Second brain');
    await expect(page.locator('#agent-panel').getByRole('button', { name: /Jobs/ })).toHaveCount(0);
    await expect(page.locator('#agent-panel .routine-row')).toHaveCount(0);
    await page.waitForTimeout(300);
    expect(hub.jobs.calls).toBe(0);
  });

  test('the gear opens the agent\'s settings and a jobs line pointing at Health', async ({ page, hub }) => {
    await page.goto(`${hub.origin}/?agent=brain`);
    await expect(page.locator('#agent-name')).toHaveText('Second brain');
    const gear = page.locator('.app-header').getByRole('button', { name: 'Settings', exact: true });
    await expect(gear).toBeVisible();
    await expect(gear).toHaveAttribute('title', 'Settings');
    await expect(gear).toHaveAttribute('aria-expanded', 'false');
    await expect(gear).toHaveAttribute('aria-controls', 'agent-details');
    await expect(page.getByRole('button', { name: /^Jobs/ })).toHaveCount(0);
    const details = page.locator('#agent-details');
    await expect(details).toBeHidden();
    expect((await gear.boundingBox()).height).toBeGreaterThanOrEqual(44);

    await gear.click();
    await expect(gear).toHaveAttribute('aria-expanded', 'true');
    await expect(details).toBeVisible();
    await expect(details.getByRole('heading', { name: 'Settings' })).toBeVisible();
    await expect(details.locator('.details-name')).toHaveText('Second brain');
    await expect(details.locator('[name="role"]')).toHaveValue('Notes');
    await expect(details.locator('[name="group"] option:checked')).toHaveText('Personal');
    await expect(details.locator('[name="cwd"]')).toHaveValue('~/second-brain');
    await expect(details.locator('[name="description"]')).toHaveValue('Invented notes that keep themselves.');
    await expect(details.locator('.details-jobs')).toHaveText('Second brain runs 3 jobs.');
    await expect(details.getByRole('link', { name: '3 jobs' })).toHaveAttribute('href', '/health');

    // Nothing about the jobs themselves renders here.
    await expect(details.locator('.routine-row, .badge')).toHaveCount(0);
    await expect(details.getByRole('button')).toHaveCount(5);
    await expect(details.getByRole('button', { name: 'Add routine' })).toBeVisible();
    await expect(details.getByRole('button', { name: 'Delete', exact: true })).toBeVisible();
    await expect(details.getByRole('button', { name: 'Save' })).toBeDisabled();
    await expect(details.getByRole('button', { name: 'Close details' })).toBeVisible();
    expect(hub.jobs.calls).toBe(0);
  });

  test('the chevron and Escape close the panel and return the keyboard to the gear', async ({ page, hub }) => {
    await page.goto(`${hub.origin}/?agent=brain`);
    const gear = page.locator('#agent-details-toggle');
    const details = page.locator('#agent-details');
    await gear.click();
    const chevron = details.getByRole('button', { name: 'Close details' });
    await expect(chevron).toHaveAttribute('title', 'Close details');
    expect((await chevron.boundingBox()).height).toBeGreaterThanOrEqual(44);
    await chevron.click();
    await expect(details).toBeHidden();
    await expect(gear).toHaveAttribute('aria-expanded', 'false');
    await expect(gear).toBeFocused();

    await gear.click();
    const link = details.getByRole('link', { name: '3 jobs' });
    await link.focus();
    // A state change that leaves the settings as they were keeps the keyboard where it is.
    const revision = await page.evaluate(() => fetch('/api/state').then((r) => r.json()).then((s) => s.revision));
    await hub.state.refreshJobs();
    await expect.poll(() => page.evaluate(() => fetch('/api/state').then((r) => r.json()).then((s) => s.revision))).toBeGreaterThan(revision);
    await page.waitForTimeout(200);
    await expect(link).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(details).toBeHidden();
    await expect(gear).toBeFocused();
  });

  test('the panel stays open as another agent opens and starts closed after a reload', async ({ page, hub }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.goto(`${hub.origin}/?agent=brain`);
    const gear = page.locator('#agent-details-toggle');
    const details = page.locator('#agent-details');
    await gear.click();
    await expect(details.locator('.details-jobs')).toHaveText('Second brain runs 3 jobs.');

    await agentRow(page, 'CFO').click();
    await expect(page.locator('#agent-name')).toHaveText('CFO');
    await expect(details).toBeVisible();
    await expect(gear).toHaveAttribute('aria-expanded', 'true');
    await expect(details.locator('.details-name')).toHaveText('CFO');
    await expect(details.locator('.details-jobs')).toHaveText('CFO runs 1 job.');
    await expect(details.getByRole('link', { name: '1 job' })).toHaveAttribute('href', '/health');

    // Scribe has no jobs and a folder outside home.
    await agentRow(page, 'Scribe').click();
    await expect(details.locator('.details-name')).toHaveText('Scribe');
    await expect(details.locator('[name="role"]')).toHaveValue('Drafts');
    await expect(details.locator('[name="cwd"]')).toHaveValue('/elsewhere/scribe');
    await expect(details.locator('.form-note-codex')).toHaveText('Codex, its own settings');
    await expect(details.locator('[name="description"]')).toHaveValue('Invented, with no jobs.');
    await expect(details.locator('.details-jobs')).toBeHidden();
    await expect(details.getByRole('link')).toHaveCount(0);

    await page.reload();
    await expect(page.locator('#agent-name')).toHaveText('Scribe');
    await expect(gear).toHaveAttribute('aria-expanded', 'false');
    await expect(details).toBeHidden();
  });

  test('a value the registry does not have is left out with its label', async ({ page, hub }) => {
    // Focus is a system entry: no provider and, here, no folder.
    await page.goto(`${hub.origin}/?agent=focus`);
    await page.locator('#agent-details-toggle').click();
    const details = page.locator('#agent-details');
    await expect(details.locator('.request-detail-label')).toHaveText(['Role', 'Group']);
    await expect(details.locator('.request-detail-text')).toHaveText(['Tasks', 'Personal']);
    await expect(details.locator('.details-jobs')).toHaveText('Focus runs 6 jobs.');
  });

  test('from 720px the panel sits beside the messages; at 390px it covers the thread', async ({ page, hub }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${hub.origin}/?agent=brain`);
    const list = page.locator('#agents-list');
    const messages = page.locator('#agent-messages');
    const details = page.locator('#agent-details');
    const listWidth = (await list.boundingBox()).width;
    const before = (await messages.boundingBox()).width;
    await page.locator('#agent-details-toggle').click();
    await expect(details).toBeVisible();
    const box = await details.boundingBox();
    expect(Math.round(box.width)).toBe(300);
    await expect.poll(async () => (await messages.boundingBox()).width).toBeLessThan(before);
    const after = await messages.boundingBox();
    expect(after.x + after.width).toBeLessThanOrEqual(box.x + 1);
    expect((await list.boundingBox()).width).toBe(listWidth);
    expect(await details.evaluate((node) => getComputedStyle(node).borderLeftWidth)).toBe('1px');

    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(async () => (await details.boundingBox()).width).toBe(390);
    const sheet = await details.boundingBox();
    const thread = await page.locator('#agent-panel').boundingBox();
    expect(sheet.x).toBe(thread.x);
    expect(sheet.y).toBe(thread.y);
    expect(sheet.height).toBe(thread.height);
    await expect(details.getByRole('button', { name: 'Close details' })).toBeInViewport();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);

    // The way back is under the sheet until the chevron closes it.
    const back = await page.locator('#agent-back').boundingBox();
    const covered = await page.evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest('#agent-details'),
      { x: back.x + back.width / 2, y: back.y + back.height / 2 });
    expect(covered).toBe(true);
    await details.getByRole('button', { name: 'Close details' }).click();
    await expect(details).toBeHidden();
    await page.locator('#agent-back').click();
    await expect(page).toHaveURL(`${hub.origin}/`);
  });

  test('on a phone the gear hands the keyboard to the chevron', async ({ page, hub }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${hub.origin}/?agent=brain`);
    await page.locator('#agent-details-toggle').click();
    await expect(page.getByRole('button', { name: 'Close details' })).toBeFocused();
  });

  test('Refresh posts the control and reads Refreshing… until the refresh finishes', async ({ page, hub }) => {
    await openHealth(page, hub);
    const refresh = page.locator('#jobs-refresh');
    await expect(refresh).toHaveText('Refresh');
    const release = hub.jobs.hold();
    const posted = page.waitForRequest((r) => r.url().endsWith('/api/jobs/refresh') && r.method() === 'POST');
    await refresh.click();
    await posted;
    await expect(refresh).toHaveText('Refreshing…');
    await expect(refresh).toBeDisabled();
    hub.jobs.items = items().slice(0, 5);
    release();
    await expect(refresh).toHaveText('Refresh');
    await expect(refresh).toBeEnabled();
    await expect(page.locator('.routine-card .card-name')).toHaveText(['Focus']);
    expect(hub.jobs.calls).toBe(1);
  });

  test('Resume follows the state once the control succeeds', async ({ page, hub }) => {
    let answer;
    const answered = new Promise((resolve) => { answer = resolve; });
    await page.route('**/api/resume', async (route) => {
      await answered;
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });
    await openHealth(page, hub);
    const focus = card(page, 'Focus');
    const button = focus.getByRole('button', { name: 'Resume' });
    await button.click();
    await expect(button).toBeDisabled();
    answer();
    await expect(button).toBeEnabled();

    // What the server does after a real resume: refresh jobs.
    hub.jobs.items = items({ paused: false });
    await hub.state.refreshJobs();
    await expect(focus.locator('[data-jobs-action]')).toHaveText('Pause');
    await expect(focus.locator('.card-header .badge')).toHaveCount(0);
    await expect(focus.locator('.card-error')).toHaveCount(0);
  });

  test('Resume reaches the isolated Focus, whose refusal is reported in the card', async ({ page, hub }) => {
    needsFocus();
    await openHealth(page, hub);
    const focus = card(page, 'Focus');
    const response = page.waitForResponse((r) => r.url().endsWith('/api/resume'));
    await focus.getByRole('button', { name: 'Resume' }).click();
    // The fixture's launchd stubs exit 1, so Focus answers 500.
    expect((await response).status()).toBe(500);
    await expect(focus.locator('.card-error')).toHaveText('Focus reported an error.');
    await expect(focus.getByRole('button', { name: 'Resume' })).toBeEnabled();
    expect(hub.jobs.calls).toBe(0);
  });

  test('a Resume that gets no answer says Focus did not respond, and a state change clears it', async ({ page, hub }) => {
    await page.route('**/api/resume', (route) => route.abort());
    await openHealth(page, hub);
    const focus = card(page, 'Focus');
    await focus.getByRole('button', { name: 'Resume' }).click();
    await expect(focus.locator('.card-error')).toHaveText('Focus did not respond.');

    hub.jobs.items = items({ paused: false });
    await hub.state.refreshJobs();
    await expect(focus.locator('[data-jobs-action]')).toHaveText('Pause');
    await expect(focus.locator('.card-error')).toHaveCount(0);
  });

  test('a failed refresh says so and leaves Refresh available', async ({ page, hub }) => {
    await openHealth(page, hub);
    await expect(page.locator('.routine-card')).toHaveCount(3);
    hub.jobs.fail = true;
    await page.locator('#jobs-refresh').click();
    await expect(page.locator('#jobs-message')).toHaveText('Jobs could not be refreshed.');
    await expect(page.locator('#jobs-refresh')).toBeEnabled();
    await expect(page.locator('.routine-card')).toHaveCount(3);
  });

  test('rows stack at 390px and line up in columns on a wide screen, without horizontal scroll', async ({ page, hub }) => {
    const wide = page.viewportSize().width >= 720;
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${hub.origin}/health`);
    await expect(page.locator('.routine-card')).toHaveCount(3);
    const stacked = row(page, 'scan-gmail');
    // The schedule sits under the name.
    await expect.poll(() => gap(stacked, '.routine-name', '.routine-schedule')).toBeGreaterThanOrEqual(-1);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    for (const box of await page.locator('.routine-card').evaluateAll((cards) => cards.map((c) => c.getBoundingClientRect().right))) {
      expect(box).toBeLessThanOrEqual(390);
    }

    if (!wide) return;
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect.poll(async () => {
      const lefts = await page.locator('.routine-schedule').evaluateAll((cells) => cells.map((c) => Math.round(c.getBoundingClientRect().left)));
      return new Set(lefts).size;
    }).toBe(1);
    // The schedule sits beside the name: it starts above the name's bottom.
    await expect.poll(() => gap(stacked, '.routine-name', '.routine-schedule')).toBeLessThan(0);
    await expect.poll(async () => (await page.locator('.routine-card').first().boundingBox())?.width ?? null).toBeLessThanOrEqual(720);
  });
});

test.describe('with stale jobs', () => {
  test.use({ hubOptions: seeded({ refreshedAt: ago(5 * MINUTE) }) });

  test('opening Health refreshes once, and Agents does not', async ({ page, hub }) => {
    await page.goto(`${hub.origin}/`);
    await expectView(page, 'agents', 'Agents');
    await page.goto(`${hub.origin}/?agent=scribe`);
    await expect(page.locator('#agent-name')).toHaveText('Scribe');
    await page.waitForTimeout(300);
    expect(hub.jobs.calls).toBe(0);
    await nav(page, 'Health').click();
    await expect(page.locator('#jobs-updated')).toHaveText('Updated just now');
    await page.waitForTimeout(300);
    expect(hub.jobs.calls).toBe(1);
  });

});

test.describe('with jobs never refreshed', () => {
  test.use({ hubOptions: { build: () => ({ agents: AGENTS }) } });

  test('the jobs line counts the registry\'s jobs without a refresh', async ({ page, hub }) => {
    await page.goto(`${hub.origin}/?agent=brain`);
    await page.locator('#agent-details-toggle').click();
    await expect(page.locator('#agent-details .details-jobs')).toHaveText('Second brain runs 3 jobs.');
    await page.waitForTimeout(300);
    expect(hub.jobs.calls).toBe(0);
  });
});

test.describe('with Focus unreachable during the refresh', () => {
  test.use({ hubOptions: seeded({ focusAvailable: false }) });

  test('the Focus card says it is showing launchd status', async ({ page, hub }) => {
    await openHealth(page, hub);
    await expect(card(page, 'Focus').locator('.card-note')).toHaveText('Focus is not responding; showing launchd status.');
    await expect(card(page, 'Second brain').locator('.card-note')).toHaveCount(0);
  });
});

test.describe('with an unreadable registry', () => {
  test.use({ hubOptions: { build: () => ({ ...seeded().build(), registry: { ok: false, error: 'registry_invalid_json' } }) } });

  test('Health says the registry could not be read and keeps the last good cards', async ({ page, hub }) => {
    await openHealth(page, hub);
    const message = page.locator('#jobs-message');
    await expect(message).toHaveText('The registry could not be read. registry_invalid_json');
    await expect(message.locator('.jobs-code')).toHaveText('registry_invalid_json');
    await expect(page.locator('.routine-card').first()).toBeVisible();
  });
});

test.describe('Settings', () => {
  const SETTINGS = { model: { default: 'opus', effort: 'high' }, brief: { agent: 'brain' } };
  test.use({ hubOptions: { build: () => ({ ...seeded().build(), settings: SETTINGS }) } });

  const select = (page, label) => page.locator('#settings-card').getByLabel(label, { exact: true });
  const status = (page) => page.locator('#settings-status');
  const readFile = async (hub) => JSON.parse(await (await import('node:fs/promises')).readFile(hub.settingsPath, 'utf8'));

  test('the card sits above Jobs and shows the saved values with the lists the registry and model table give', async ({ page, hub }) => {
    await openHealth(page, hub);
    const headings = await page.locator('#view-health h1').allTextContents();
    expect(headings).toEqual(['Settings', 'Jobs']);
    await expect(select(page, 'Default model')).toHaveValue('opus');
    await expect(select(page, 'Default effort')).toHaveValue('high');
    await expect(select(page, 'Brief goes to')).toHaveValue('brain');
    expect(await select(page, 'Default model').locator('option').allTextContents()).toEqual(['Claude Code default', 'Fable', 'Opus', 'Sonnet', 'Haiku']);
    expect(await select(page, 'Default effort').locator('option').allTextContents()).toEqual(['Claude Code default', 'Low', 'Medium', 'High', 'Extra high', 'Max']);
    // Claude personas only: not the Codex one, not the system entry.
    expect(await select(page, 'Brief goes to').locator('option').allTextContents()).toEqual(['No one', 'Second brain']);
    await expect(select(page, 'Default permissions')).toHaveValue('ask');
    expect(await select(page, 'Default permissions').locator('option').allTextContents()).toEqual(['Ask', 'Auto', 'Full access']);
    await expect(page.locator('#settings-permission-note')).toHaveText('Asks before each tool that is not already allowed.');
    await expect(status(page)).toBeHidden();
    // Settings is not a jobs card.
    await expect(page.locator('.routine-card')).toHaveCount(3);
  });

  test('a change is saved through one PUT, confirmed for a moment, and lands in the file and the state', async ({ page, hub }) => {
    await openHealth(page, hub);
    await select(page, 'Default model').selectOption('sonnet');
    await expect(status(page)).toHaveText('Saved.');
    expect(hub.requests('/api/settings')).toEqual([{ method: 'PUT', status: 200 }]);
    expect((await readFile(hub)).model).toEqual({ default: 'sonnet', effort: 'high' });
    expect(hub.state.snapshot().settings.model.default).toBe('sonnet');
    expect(hub.state.snapshot().agents.find((a) => a.id === 'brain').model).toEqual({ id: 'sonnet', effort: 'high', source: 'system', default: { id: 'sonnet', effort: 'high' }, agent: { id: null, effort: null } });
    await expect(select(page, 'Default model')).toHaveValue('sonnet');
    await expect(status(page)).toBeHidden({ timeout: 5_000 });

    await select(page, 'Default effort').selectOption('');
    await expect(status(page)).toHaveText('Saved.');
    expect((await readFile(hub)).model).toEqual({ default: 'sonnet', effort: null });

    await select(page, 'Brief goes to').selectOption('');
    await expect(status(page)).toHaveText('Saved.');
    expect((await readFile(hub)).brief).toEqual({ agent: null });
    await expect(status(page)).toHaveText('No agent receives the brief.', { timeout: 5_000 });
  });

  test('Default permissions saves the level, the sentence and the agents follow, and a refused level shows the sentence', async ({ page, hub }) => {
    await openHealth(page, hub);
    const note = page.locator('#settings-permission-note');
    await select(page, 'Default permissions').selectOption('auto');
    await expect(status(page)).toHaveText('Saved.');
    await expect(note).toHaveText('Claude decides, and asks only when it is unsure.');
    expect((await readFile(hub)).permission).toEqual({ default: 'auto' });
    expect(hub.state.snapshot().settings.permission).toEqual({ default: 'auto' });
    expect(hub.state.snapshot().agents.find((a) => a.id === 'brain').permission).toEqual({ level: 'auto', source: 'system', agent: null, default: 'auto' });
    expect('permission' in hub.state.snapshot().agents.find((a) => a.id === 'scribe')).toBe(false);

    // The gear form's default option names the new level.
    await page.goto(`${hub.origin}/?agent=brain`);
    await page.locator('#agent-details-toggle').click();
    await expect(page.locator('#agent-form [name="permission"] option:checked')).toHaveText('System default (Auto)');
    await expect(page.locator('#agent-form .form-note-permission')).toHaveText('Claude decides, and asks only when it is unsure.');

    // A level the list does not carry is refused by the daemon, and the
    // select goes back to the saved value.
    await openHealth(page, hub);
    await expect(select(page, 'Default permissions')).toHaveValue('auto');
    await select(page, 'Default permissions').evaluate((node) => {
      const option = document.createElement('option');
      option.value = 'bypass';
      option.textContent = 'Bypass';
      node.appendChild(option);
      node.value = 'bypass';
      node.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await expect(status(page)).toHaveText('That permission level is not offered.');
    await expect.poll(() => hub.requests('/api/settings').at(-1)).toEqual({ method: 'PUT', status: 400 });
    await expect(select(page, 'Default permissions')).toHaveValue('auto');
    expect((await readFile(hub)).permission).toEqual({ default: 'auto' });
  });

  test('a saved change reaches a second page through the stream', async ({ page, hub, browser }) => {
    await openHealth(page, hub);
    const other = await browser.newPage();
    try {
      await other.goto(`${hub.origin}/health`);
      await expect(select(other, 'Default model')).toHaveValue('opus');
      await select(page, 'Default model').selectOption('haiku');
      await expect(status(page)).toHaveText('Saved.');
      await expect(select(other, 'Default model')).toHaveValue('haiku');
    } finally {
      await other.close();
    }
  });

  test('rows stack at 390px and sit side by side on a wide screen', async ({ page, hub }) => {
    const wide = page.viewportSize().width >= 720;
    await page.setViewportSize({ width: 390, height: 844 });
    await openHealth(page, hub);
    const first = page.locator('.settings-row').first();
    await expect.poll(() => gap(first, '.settings-label', '.settings-select')).toBeGreaterThanOrEqual(0);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    if (!wide) return;
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect.poll(() => gap(first, '.settings-label', '.settings-select')).toBeLessThan(0);
  });
});

test.describe('Settings with no file', () => {
  test.use({ hubOptions: seeded() });

  test('every select reads Claude Code default or No one, and the card says no agent receives the brief', async ({ page, hub }) => {
    await openHealth(page, hub);
    const card = page.locator('#settings-card');
    await expect(card.getByLabel('Default model', { exact: true })).toHaveValue('');
    await expect(card.getByLabel('Default effort', { exact: true })).toHaveValue('');
    await expect(card.getByLabel('Brief goes to', { exact: true })).toHaveValue('');
    await expect(card.getByLabel('Default permissions', { exact: true })).toHaveValue('ask');
    await expect(page.locator('#settings-status')).toHaveText('No agent receives the brief.');
    await card.getByLabel('Brief goes to', { exact: true }).selectOption('brain');
    await expect(page.locator('#settings-status')).toHaveText('Saved.');
    expect(hub.state.snapshot().settings.brief.agent).toBe('brain');
  });
});

test.describe('Settings with an unreadable file', () => {
  test.use({ hubOptions: { build: () => ({ ...seeded().build(), settings: 'broken' }) } });

  test('the card says the file could not be read, and a change is refused and reverted', async ({ page, hub }) => {
    await openHealth(page, hub);
    const card = page.locator('#settings-card');
    const message = 'The settings file could not be read. Fix or delete it.';
    await expect(page.locator('#settings-status')).toHaveText(message);
    await card.getByLabel('Default model', { exact: true }).selectOption('opus');
    await expect.poll(() => hub.requests('/api/settings')).toEqual([{ method: 'PUT', status: 409 }]);
    await expect(page.locator('#settings-status')).toHaveText(message);
    await expect(card.getByLabel('Default model', { exact: true })).toHaveValue('');
    await expect(card.getByLabel('Default model', { exact: true })).toBeEnabled();
  });
});

test.describe('with no jobs registered', () => {
  test.use({ hubOptions: seeded({ items: [] }) });

  test('Health says none are registered', async ({ page, hub }) => {
    await openHealth(page, hub);
    await expect(page.locator('#jobs-message')).toHaveText('No jobs are registered.');
    await expect(page.locator('.routine-card')).toHaveCount(0);
    await expect(page.locator('#jobs-refresh')).toBeEnabled();
  });
});

test('with no agents, Home says so, and Health refreshes once when opened', async ({ page, hub }) => {
  await page.goto(`${hub.origin}/`);
  await expectView(page, 'agents', 'Agents');
  await expect(page.locator('#agents-message')).toHaveText('No agents are registered.');
  await page.waitForTimeout(300);
  expect(hub.jobs.calls).toBe(0);
  await nav(page, 'Health').click();
  await expect(page).toHaveURL(`${hub.origin}/health`);
  await expectView(page, 'health', 'Health');
  await expect(page.locator('#jobs-refresh')).toBeVisible();
  // Health opened with nothing refreshed, so it refreshed once.
  await expect.poll(() => hub.jobs.calls).toBe(1);
});

test('the rail holds five links without scrolling, and /brief and /reading land on the Feed', async ({ page, hub }) => {
  await page.goto(`${hub.origin}/goals`);
  await expectView(page, 'goals', 'Goals');
  await expect(page.locator('#app-header-title')).toHaveText('Goals');
  const links = page.getByRole('navigation', { name: 'Dashboard' }).getByRole('link');
  await expect(links).toHaveCount(5);
  for (const [i, name] of ['Home', 'Feed', 'Focus', 'Goals', 'Health'].entries()) {
    await expect(links.nth(i)).toHaveAccessibleName(name);
  }
  const onPhone = test.info().project.name === 'mobile-webkit';
  for (const link of await links.all()) {
    const box = await link.boundingBox();
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
    const label = link.locator('.nav-label');
    if (onPhone) {
      await expect(label).toBeVisible();
    } else {
      const labelBox = await label.boundingBox();
      expect(labelBox.width).toBeLessThanOrEqual(1);
      expect(labelBox.height).toBeLessThanOrEqual(1);
    }
  }
  // The phone rail runs across the top; all five links fit without scrolling.
  if (onPhone) {
    expect(await page.locator('.nav').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  }

  await page.goto(`${hub.origin}/brief`);
  await expect(page).toHaveURL(`${hub.origin}/feed`);
  await expect(page.locator('#view-feed')).toBeVisible();
  await expect(page).toHaveTitle('Feed · Dashboard');
  await expect(page.getByRole('dialog', { name: 'Brief' })).toBeVisible();
  await page.keyboard.press('Escape');

  await page.goto(`${hub.origin}/reading`);
  await expect(page).toHaveURL(`${hub.origin}/feed`);
  await expectView(page, 'feed', 'Feed');
  await nav(page, 'Home').click();
  await expectView(page, 'agents', 'Agents');
  await nav(page, 'Goals').click();
  await expect(page).toHaveURL(`${hub.origin}/goals`);
  await expectView(page, 'goals', 'Goals');
  await nav(page, 'Health').click();
  await expect(page).toHaveURL(`${hub.origin}/health`);
  await expectView(page, 'health', 'Health');
  const health = nav(page, 'Health');
  await expect(health).toHaveAttribute('title', 'Health');
  await expect(health.locator('svg.nav-icon')).toHaveCount(1);
});

test.describe('stream client', () => {
  // Jobs already read and none registered, so nothing refreshes on open
  // and the count starts at zero on every width.
  test.use({ hubOptions: seeded({ items: [] }) });

  function countRequests(page, suffix) {
    const seen = [];
    page.on('request', (r) => {
      if (new URL(r.url()).pathname === suffix) seen.push(r);
    });
    return seen;
  }

  // The rows on Health follow the jobs.
  const rows = (page) => page.locator('#jobs-cards .routine-row');
  const none = (page) => expect(page.locator('#jobs-message')).toHaveText('No jobs are registered.');

  test('the Health view follows deltas without refetching the state', async ({ page, hub }) => {
    const states = countRequests(page, '/api/state');
    await page.goto(`${hub.origin}/health`);
    await expectView(page, 'health', 'Health');
    await expect.poll(() => hub.state.clientCount()).toBe(1);
    await settled(page, states);
    const before = states.length;

    hub.jobs.items = items().slice(0, 1);
    await hub.state.refreshJobs();
    await expect(rows(page)).toHaveCount(1);
    hub.jobs.items = items().slice(0, 2);
    await hub.state.refreshJobs();
    await expect(rows(page)).toHaveCount(2);
    expect(states.length).toBe(before);
  });

  test('a reload event fetches the state again', async ({ page, hub }) => {
    const states = countRequests(page, '/api/state');
    let firstState;
    const stateDone = new Promise((resolve) => { firstState = resolve; });
    page.on('requestfinished', (r) => {
      if (new URL(r.url()).pathname === '/api/state') firstState();
    });
    let first = true;
    await page.route('**/api/events', async (route) => {
      if (!first) return route.continue();
      first = false;
      await stateDone;
      const snapshot = hub.state.snapshot();
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: `event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\nevent: reload\ndata: {}\n\n`,
      });
    });
    await page.goto(`${hub.origin}/`);
    await expect.poll(() => states.length).toBe(2);
  });

  // Waits until every /api/state request seen so far has finished.
  async function settled(page, seen) {
    await expect.poll(() => seen.length).toBeGreaterThan(0);
    await Promise.all(seen.map((r) => r.response()));
  }

  test('a delta that skips a revision fetches the state once and continues from it', async ({ page, hub }) => {
    const states = countRequests(page, '/api/state');
    await page.goto(`${hub.origin}/health`);
    await none(page);
    await expect.poll(() => hub.state.clientCount()).toBe(1);
    await settled(page, states);
    const before = states.length;
    const answered = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/state');

    const current = hub.state.snapshot().revision;
    hub.emitDelta(current + 2, { jobs: { refreshedAt: new Date().toISOString(), focusAvailable: null, refreshing: false, error: null, items: items() } });
    const snapshot = await (await answered).json();
    expect(snapshot.revision).toBe(current);
    // The gap delta was not applied; the fetched snapshot was.
    await none(page);
    await expect(rows(page)).toHaveCount(0);
    expect(states.length).toBe(before + 1);

    // The next real delta is revision + 1 of that snapshot and applies directly.
    hub.jobs.items = items().slice(0, 1);
    await hub.state.refreshJobs();
    await expect(rows(page)).toHaveCount(1);
    expect(states.length).toBe(before + 1);
  });

  test('a delta at or below the current revision is dropped without fetching the state', async ({ page, hub }) => {
    const states = countRequests(page, '/api/state');
    await page.goto(`${hub.origin}/health`);
    await none(page);
    await expect.poll(() => hub.state.clientCount()).toBe(1);
    await settled(page, states);
    const before = states.length;

    const current = hub.state.snapshot().revision;
    const stale = { jobs: { refreshedAt: new Date().toISOString(), focusAvailable: null, refreshing: false, error: null, items: items() } };
    hub.emitDelta(current, stale);
    hub.emitDelta(current - 1, stale);
    // A real change after them shows both were handled, in order.
    hub.jobs.items = items().slice(0, 2);
    await hub.state.refreshJobs();
    await expect(rows(page)).toHaveCount(2);
    expect(states.length).toBe(before);
  });

  const streamStatuses = (hub) => hub.requests('/api/events').map((entry) => entry.status);

  test('after the server ends the stream, the client reconnects and keeps following', async ({ page, hub }) => {
    await page.goto(`${hub.origin}/health`);
    await none(page);
    await expect.poll(() => streamStatuses(hub)).toEqual([200]);

    hub.restartApp();
    await expect.poll(() => streamStatuses(hub)).toEqual([200, 200]);
    await expect(page.locator('#shell-notice')).toBeHidden();
    hub.jobs.items = items().slice(0, 2);
    await hub.state.refreshJobs();
    await expect(rows(page)).toHaveCount(2);
  });

  test('while new streams are refused the notice shows, and the next snapshot clears it', async ({ page, hub }) => {
    await page.goto(`${hub.origin}/`);
    await expect.poll(() => streamStatuses(hub)).toEqual([200]);

    hub.stopStreams();
    const notice = page.locator('#shell-notice');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('The dashboard is not responding.');
    expect(streamStatuses(hub).filter((status) => status === 503).length).toBeGreaterThanOrEqual(2);

    hub.restartApp();
    await expect(notice).toBeHidden({ timeout: 10_000 });
    expect(streamStatuses(hub).at(-1)).toBe(200);
  });

  test('Retry on the notice reconnects at once', async ({ page, hub }) => {
    await page.goto(`${hub.origin}/health`);
    await none(page);
    hub.stopStreams();
    const notice = page.locator('#shell-notice');
    await expect(notice).toBeVisible();
    hub.restartApp();
    const reopened = page.waitForResponse((r) => r.url().endsWith('/api/events') && r.status() === 200);
    await notice.getByRole('button', { name: 'Retry' }).click();
    await reopened;
    await expect(notice).toBeHidden({ timeout: 1_000 });
  });
});
