// The routines overview inside the Agents view, and the shell's event
// stream client, in real browsers against the in-memory registry and
// routines of test/support/browser-server.mjs. Pause and Resume reach the
// isolated Focus copy, whose launchd stubs refuse.

import { expect, expectView, nav, needsFocus, test } from '../support/browser-test.mjs';

const DATE = '2026-09-15';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const ago = (ms) => new Date(Date.now() - ms).toISOString();

const AGENTS = [
  { id: 'focus', name: 'Focus', role: 'Tasks', description: 'Invented.', group: 'personal', kind: 'system' },
  { id: 'brain', name: 'Second brain', role: 'Notes', description: 'Invented.', group: 'personal', kind: 'persona' },
  { id: 'scribe', name: 'Scribe', role: 'Drafts', description: 'Invented, with no routines.', group: 'work', kind: 'persona' },
  { id: 'cfo', name: 'CFO', role: 'Money', description: 'Invented.', group: 'work', kind: 'persona' },
];

function routine(agent, label, fields) {
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
  return routine(AGENTS[0], `com.focus.scan-${name}`, { source: 'focus', exitStatus: null, paused: false, failures24h: 0, ...fields });
}

function items({ paused = true } = {}) {
  return [
    focusScan('gmail', { outcome: 'wrote', paused, failures24h: 2 }),
    focusScan('git', { outcome: 'running', paused }),
    focusScan('notes', { outcome: 'skipped', lastRun: ago(3.5 * HOUR) }),
    focusScan('work', { outcome: 'failed', failures24h: 1 }),
    focusScan('calendar', { outcome: 'no change' }),
    focusScan('drive', { outcome: 'never ran', lastRun: null }),
    routine(AGENTS[1], 'com.hunter.brain-drain', { schedule: { kind: 'calendar', text: 'Daily at 02:30' }, lastRun: ago(30 * HOUR) }),
    routine(AGENTS[1], 'com.hunter.brain-audit', { outcome: 'failed', exitStatus: 78, lastRun: ago(5 * 24 * HOUR) }),
    routine(AGENTS[1], 'com.hunter.brain-refresh', { outcome: 'not loaded', exitStatus: null, lastRun: null }),
    routine(AGENTS[3], 'com.hunter.cfo.daily', {
      schedule: { kind: 'unavailable', text: 'Schedule unavailable' },
      outcome: 'unknown', exitStatus: null, lastRun: null, available: false,
    }),
  ];
}

function seeded(routines = {}) {
  return { build: () => ({ agents: AGENTS, routines: { items: items(), focusAvailable: true, refreshedAt: ago(5_000), ...routines } }) };
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

const phone = (page) => page.viewportSize().width < 720;

// The overview sits beside the list from 720px; a phone reaches it through
// the Routines row at the top of the list.
async function openOverview(page, hub) {
  await page.goto(`${hub.origin}/`);
  await expectView(page, 'agents', 'Agents');
  if (phone(page)) await page.locator('#agents-routines').click();
  await expect(page.locator('#routines-overview')).toBeVisible();
}

test.describe('with seeded routines', () => {
  test.use({ hubOptions: seeded() });

  test('each agent with routines gets a card with its rows and outcome badges', async ({ page, hub }) => {
    await openOverview(page, hub);
    await expect(page.getByRole('heading', { name: 'Routines', level: 2 })).toBeVisible();
    await expect(page.locator('#routines-updated')).toHaveText('Updated just now');
    await expect(page.locator('#routines-refresh')).toHaveText('Refresh');

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
    const yesterday = new Date(Date.parse(items()[6].lastRun));
    await expect(row(page, 'brain-drain').locator('.routine-run')).toHaveText(
      `Yesterday ${pad(yesterday.getHours())}:${pad(yesterday.getMinutes())}`);
    await expect(row(page, 'brain-audit').locator('.routine-run')).toHaveText(/^[A-Z][a-z]{2} \d{1,2} \d{2}:\d{2}$/);
    await expect(row(page, 'brain-refresh').locator('.routine-run')).toHaveText('Never run');
    await expect(row(page, 'cfo.daily').locator('.routine-schedule')).toHaveText('Schedule unavailable');

    const focus = card(page, 'Focus');
    await expect(focus.locator('.card-header .badge')).toHaveText('Paused');
    await expect(focus.getByRole('button')).toHaveText(['Resume']);
    await expect(card(page, 'Second brain').getByRole('button')).toHaveCount(0);
    await expect(focus.locator('.card-note')).toHaveCount(0);

    // A fresh refreshedAt means opening the view did not refresh.
    expect(hub.routines.calls).toBe(0);

    for (const button of await page.locator('#routines-overview button').all()) {
      expect((await button.boundingBox()).height).toBeGreaterThanOrEqual(44);
    }
  });

  test('/routines lands on the overview, and /agents shows the same page', async ({ page, hub }) => {
    await page.goto(`${hub.origin}/routines`);
    await expectView(page, 'agents', 'Agents');
    await expect(page.locator('#routines-overview')).toBeVisible();
    await expect(page.locator('.routine-card .card-name')).toHaveText(['Focus', 'Second brain', 'CFO']);
    await expect(page.locator('#agent-panel')).toBeHidden();
    if (phone(page)) {
      await expect(page.locator('#agents-list')).toBeHidden();
      await expect(page.locator('#routines-back')).toHaveText('All agents');
    } else {
      await expect(page.locator('#agents-list')).toBeVisible();
      await expect(page.locator('#routines-back')).toBeHidden();
    }

    await page.goto(`${hub.origin}/agents`);
    await expectView(page, 'agents', 'Agents');
    await expect(page.locator('#agents-list')).toBeVisible();
    await expect(page.locator('#agents-routines')).toBeVisible({ visible: phone(page) });
    expect(hub.routines.calls).toBe(0);
  });

  test('a thread with routines lists them behind a toggle; one without has no toggle', async ({ page, hub }) => {
    await page.goto(`${hub.origin}/?agent=brain`);
    await expect(page.locator('#agent-name')).toHaveText('Second brain');
    const toggle = page.locator('#agent-routines-toggle');
    await expect(toggle).toHaveText('Routines (3)');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('#agent-routines')).toBeHidden();
    await expect(page.locator('#routines-overview')).toBeHidden();
    expect((await toggle.boundingBox()).height).toBeGreaterThanOrEqual(44);

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const section = page.locator('#agent-routines');
    await expect(section).toBeVisible();
    await expect(section.locator('.routine-name')).toHaveText(['brain-drain', 'brain-audit', 'brain-refresh']);
    await expect(section.locator('.badge')).toHaveText(['OK', 'Failed (exit 78)', 'Not loaded']);
    await expect(section.locator('.routine-run').last()).toHaveText('Never run');
    await expect(section.locator('.card-name')).toHaveCount(0);
    await expect(section.getByRole('button')).toHaveCount(0);
    expect(hub.routines.calls).toBe(0);

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(section).toBeHidden();

    await page.goto(`${hub.origin}/?agent=scribe`);
    await expect(page.locator('#agent-name')).toHaveText('Scribe');
    await expect(toggle).toBeHidden();
    await expect(section).toBeHidden();
  });

  test('a thread\'s routines close when another agent opens and stay closed on return', async ({ page, hub }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.goto(`${hub.origin}/?agent=brain`);
    const toggle = page.locator('#agent-routines-toggle');
    const section = page.locator('#agent-routines');
    await expect(toggle).toHaveText('Routines (3)');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(section.locator('.routine-name')).toHaveText(['brain-drain', 'brain-audit', 'brain-refresh']);

    await agentRow(page, 'CFO').click();
    await expect(page.locator('#agent-name')).toHaveText('CFO');
    await expect(toggle).toHaveText('Routines (1)');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(section).toBeHidden();
    await expect(section).toBeEmpty();

    await agentRow(page, 'Second brain').click();
    await expect(page.locator('#agent-name')).toHaveText('Second brain');
    await expect(toggle).toHaveText('Routines (3)');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(section).toBeHidden();
    await expect(section).toBeEmpty();
  });

  test('the Focus scans keep Pause and Resume under the Focus thread', async ({ page, hub }) => {
    let answer;
    const answered = new Promise((resolve) => { answer = resolve; });
    const resumes = [];
    page.on('request', (r) => {
      if (new URL(r.url()).pathname === '/api/resume') resumes.push(r);
    });
    await page.route('**/api/resume', async (route) => {
      await answered;
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });
    await page.goto(`${hub.origin}/?agent=focus`);
    await page.locator('#agent-routines-toggle').click();
    const section = page.locator('#agent-routines');
    await expect(section.locator('.routine-row')).toHaveCount(6);
    await expect(section.locator('.card-header .badge')).toHaveText('Paused');
    const button = section.getByRole('button', { name: 'Resume' });
    await button.click();
    await expect(button).toBeDisabled();
    answer();
    await expect(button).toBeEnabled();
    expect(resumes.length).toBe(1);

    hub.routines.items = items({ paused: false });
    await hub.state.refreshRoutines();
    await expect(section.getByRole('button')).toHaveText(['Pause']);
    await expect(section.locator('.card-header .badge')).toHaveCount(0);
    expect(resumes.length).toBe(1);
  });

  test('Refresh posts the control and reads Refreshing… until the refresh finishes', async ({ page, hub }) => {
    await openOverview(page, hub);
    const refresh = page.locator('#routines-refresh');
    await expect(refresh).toHaveText('Refresh');
    const release = hub.routines.hold();
    const posted = page.waitForRequest((r) => r.url().endsWith('/api/routines/refresh') && r.method() === 'POST');
    await refresh.click();
    await posted;
    await expect(refresh).toHaveText('Refreshing…');
    await expect(refresh).toBeDisabled();
    hub.routines.items = items().slice(0, 5);
    release();
    await expect(refresh).toHaveText('Refresh');
    await expect(refresh).toBeEnabled();
    await expect(page.locator('.routine-card .card-name')).toHaveText(['Focus']);
    expect(hub.routines.calls).toBe(1);
  });

  test('Resume follows the state once the control succeeds', async ({ page, hub }) => {
    let answer;
    const answered = new Promise((resolve) => { answer = resolve; });
    await page.route('**/api/resume', async (route) => {
      await answered;
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });
    await openOverview(page, hub);
    const focus = card(page, 'Focus');
    const button = focus.getByRole('button', { name: 'Resume' });
    await button.click();
    await expect(button).toBeDisabled();
    answer();
    await expect(button).toBeEnabled();

    // What the server does after a real resume: refresh routines.
    hub.routines.items = items({ paused: false });
    await hub.state.refreshRoutines();
    await expect(focus.getByRole('button')).toHaveText(['Pause']);
    await expect(focus.locator('.card-header .badge')).toHaveCount(0);
    await expect(focus.locator('.card-error')).toHaveCount(0);
  });

  test('Resume reaches the isolated Focus, whose refusal is reported in the card', async ({ page, hub }) => {
    needsFocus();
    await openOverview(page, hub);
    const focus = card(page, 'Focus');
    const response = page.waitForResponse((r) => r.url().endsWith('/api/resume'));
    await focus.getByRole('button', { name: 'Resume' }).click();
    // The fixture's launchd stubs exit 1, so Focus answers 500.
    expect((await response).status()).toBe(500);
    await expect(focus.locator('.card-error')).toHaveText('Focus reported an error.');
    await expect(focus.getByRole('button', { name: 'Resume' })).toBeEnabled();
    expect(hub.routines.calls).toBe(0);
  });

  test('a Resume that gets no answer says Focus did not respond, and a state change clears it', async ({ page, hub }) => {
    await page.route('**/api/resume', (route) => route.abort());
    await openOverview(page, hub);
    const focus = card(page, 'Focus');
    await focus.getByRole('button', { name: 'Resume' }).click();
    await expect(focus.locator('.card-error')).toHaveText('Focus did not respond.');

    hub.routines.items = items({ paused: false });
    await hub.state.refreshRoutines();
    await expect(focus.getByRole('button')).toHaveText(['Pause']);
    await expect(focus.locator('.card-error')).toHaveCount(0);
  });

  test('a failed refresh says so and leaves Refresh available', async ({ page, hub }) => {
    await openOverview(page, hub);
    await expect(page.locator('.routine-card')).toHaveCount(3);
    hub.routines.fail = true;
    await page.locator('#routines-refresh').click();
    await expect(page.locator('#routines-message')).toHaveText('Routines could not be refreshed.');
    await expect(page.locator('#routines-refresh')).toBeEnabled();
    await expect(page.locator('.routine-card')).toHaveCount(3);
  });

  test('rows stack at 390px and line up in columns on a wide screen, without horizontal scroll', async ({ page, hub }) => {
    const wide = page.viewportSize().width >= 720;
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${hub.origin}/routines`);
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

test.describe('with stale routines', () => {
  test.use({ hubOptions: seeded({ refreshedAt: ago(5 * MINUTE) }) });

  test('opening the overview refreshes once', async ({ page, hub }) => {
    await page.goto(`${hub.origin}/?agent=scribe`);
    await expect(page.locator('#agent-name')).toHaveText('Scribe');
    await page.waitForTimeout(300);
    expect(hub.routines.calls).toBe(0);
    await nav(page, 'Home').click();
    if (phone(page)) await page.locator('#agents-routines').click();
    await expect(page.locator('#routines-updated')).toHaveText('Updated just now');
    await page.waitForTimeout(300);
    expect(hub.routines.calls).toBe(1);
  });

  test('expanding a thread\'s routines refreshes once', async ({ page, hub }) => {
    await page.goto(`${hub.origin}/?agent=brain`);
    await expect(page.locator('#agent-routines-toggle')).toHaveText('Routines (3)');
    await page.waitForTimeout(300);
    expect(hub.routines.calls).toBe(0);
    await page.locator('#agent-routines-toggle').click();
    await expect.poll(() => hub.routines.calls).toBe(1);
  });
});

test.describe('with Focus unreachable during the refresh', () => {
  test.use({ hubOptions: seeded({ focusAvailable: false }) });

  test('the Focus card says it is showing launchd status', async ({ page, hub }) => {
    await openOverview(page, hub);
    await expect(card(page, 'Focus').locator('.card-note')).toHaveText('Focus is not responding; showing launchd status.');
    await expect(card(page, 'Second brain').locator('.card-note')).toHaveCount(0);
  });
});

test.describe('with an unreadable registry', () => {
  test.use({ hubOptions: { build: () => ({ ...seeded().build(), registry: { ok: false, error: 'registry_invalid_json' } }) } });

  test('the overview says the registry could not be read and keeps the last good cards', async ({ page, hub }) => {
    await openOverview(page, hub);
    const message = page.locator('#routines-message');
    await expect(message).toHaveText('The registry could not be read. registry_invalid_json');
    await expect(message.locator('.routines-code')).toHaveText('registry_invalid_json');
    await expect(page.locator('.routine-card').first()).toBeVisible();
  });
});

test.describe('with no routines registered', () => {
  test.use({ hubOptions: seeded({ items: [] }) });

  test('the overview says none are registered', async ({ page, hub }) => {
    await openOverview(page, hub);
    await expect(page.locator('#routines-message')).toHaveText('No routines are registered.');
    await expect(page.locator('.routine-card')).toHaveCount(0);
    await expect(page.locator('#routines-refresh')).toBeEnabled();
  });
});

test('the nav lists Home, Reading, Focus, and Goals, and Home shows Agents', async ({ page, hub }) => {
  await page.goto(`${hub.origin}/`);
  await expectView(page, 'agents', 'Agents');
  await expect(page.getByRole('navigation', { name: 'Dashboard' }).getByRole('link'))
    .toHaveText(['Home', 'Reading', 'Focus', 'Goals']);
  await expect(page.locator('#agents-message')).toHaveText('No agents are registered.');
  if (phone(page)) await page.locator('#agents-routines').click();
  await expect(page.locator('#routines-overview')).toBeVisible();
  await expect(page.locator('#routines-refresh')).toBeVisible();
  // The overview opened with nothing refreshed, so it refreshed once.
  await expect.poll(() => hub.routines.calls).toBe(1);
});

test('the rail holds four links without scrolling, and /brief and /reading show Reading', async ({ page, hub }) => {
  await page.goto(`${hub.origin}/goals`);
  await expectView(page, 'goals', 'Goals');
  await expect(page.locator('#view-goals')).toHaveText('Goals');
  const links = page.getByRole('navigation', { name: 'Dashboard' }).getByRole('link');
  await expect(links).toHaveCount(4);
  for (const [i, name] of ['Home', 'Reading', 'Focus', 'Goals'].entries()) {
    await expect(links.nth(i)).toHaveAccessibleName(name);
  }
  expect(await page.locator('.nav').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);

  for (const path of ['/brief', '/reading']) {
    await page.goto(`${hub.origin}${path}`);
    await expect(page.locator('#view-reading')).toBeVisible();
    await expect(page).toHaveTitle('Reading · Dashboard');
  }
  await nav(page, 'Home').click();
  await expectView(page, 'agents', 'Agents');
  await nav(page, 'Goals').click();
  await expect(page).toHaveURL(`${hub.origin}/goals`);
  await expectView(page, 'goals', 'Goals');
});

test.describe('stream client', () => {
  // Routines already read and none registered, so nothing refreshes on open
  // and the count starts at zero on every width.
  test.use({ hubOptions: seeded({ items: [] }) });

  function countRequests(page, suffix) {
    const seen = [];
    page.on('request', (r) => {
      if (new URL(r.url()).pathname === suffix) seen.push(r);
    });
    return seen;
  }

  // The list's Routines row counts the routines on every width; it is
  // shown only on a phone, so its text, not its visibility, is checked.
  const count = (page) => page.locator('#agents-routines-count');

  test('the Agents view follows deltas without refetching the state', async ({ page, hub }) => {
    const states = countRequests(page, '/api/state');
    await page.goto(`${hub.origin}/`);
    await expectView(page, 'agents', 'Agents');
    await expect.poll(() => hub.state.clientCount()).toBe(1);
    await settled(page, states);
    const before = states.length;

    hub.routines.items = items().slice(0, 1);
    await hub.state.refreshRoutines();
    await expect(count(page)).toHaveText('1 routine');
    hub.routines.items = items().slice(0, 2);
    await hub.state.refreshRoutines();
    await expect(count(page)).toHaveText('2 routines');
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
    await page.goto(`${hub.origin}/`);
    await expect(count(page)).toHaveText('0 routines');
    await expect.poll(() => hub.state.clientCount()).toBe(1);
    await settled(page, states);
    const before = states.length;
    const answered = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/state');

    const current = hub.state.snapshot().revision;
    hub.emitDelta(current + 2, { routines: { refreshedAt: new Date().toISOString(), focusAvailable: null, refreshing: false, error: null, items: items() } });
    const snapshot = await (await answered).json();
    expect(snapshot.revision).toBe(current);
    // The gap delta was not applied; the fetched snapshot was.
    await expect(count(page)).toHaveText('0 routines');
    expect(states.length).toBe(before + 1);

    // The next real delta is revision + 1 of that snapshot and applies directly.
    hub.routines.items = items().slice(0, 1);
    await hub.state.refreshRoutines();
    await expect(count(page)).toHaveText('1 routine');
    expect(states.length).toBe(before + 1);
  });

  test('a delta at or below the current revision is dropped without fetching the state', async ({ page, hub }) => {
    const states = countRequests(page, '/api/state');
    await page.goto(`${hub.origin}/`);
    await expect(count(page)).toHaveText('0 routines');
    await expect.poll(() => hub.state.clientCount()).toBe(1);
    await settled(page, states);
    const before = states.length;

    const current = hub.state.snapshot().revision;
    const stale = { routines: { refreshedAt: new Date().toISOString(), focusAvailable: null, refreshing: false, error: null, items: items() } };
    hub.emitDelta(current, stale);
    hub.emitDelta(current - 1, stale);
    // A real change after them shows both were handled, in order.
    hub.routines.items = items().slice(0, 2);
    await hub.state.refreshRoutines();
    await expect(count(page)).toHaveText('2 routines');
    expect(states.length).toBe(before);
  });

  const streamStatuses = (hub) => hub.requests('/api/events').map((entry) => entry.status);

  test('after the server ends the stream, the client reconnects and keeps following', async ({ page, hub }) => {
    await page.goto(`${hub.origin}/`);
    await expect(count(page)).toHaveText('0 routines');
    await expect.poll(() => streamStatuses(hub)).toEqual([200]);

    hub.restartApp();
    await expect.poll(() => streamStatuses(hub)).toEqual([200, 200]);
    await expect(page.locator('#shell-notice')).toBeHidden();
    hub.routines.items = items().slice(0, 2);
    await hub.state.refreshRoutines();
    await expect(count(page)).toHaveText('2 routines');
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
    await page.goto(`${hub.origin}/`);
    await expect(count(page)).toHaveText('0 routines');
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
