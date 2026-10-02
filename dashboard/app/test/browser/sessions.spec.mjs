// Coding sessions in the Agents view, in real browsers against the fake
// Codex adapter, cmux inventory, and bindings of
// test/support/browser-server.mjs. Personas and the Health view are
// covered in agents.spec.mjs and jobs.spec.mjs; what is off shows on
// Health, which is checked here.

import { expect, expectView, test } from '../support/browser-test.mjs';

const MINUTE = 60_000;
const ago = (ms) => new Date(Date.now() - ms).toISOString();

const WS = '1F9F550D-BA32-4C4D-86E1-C4C6FBDB192F';
const SF_OPEN = '9211C31B-34F1-47BF-88D4-C3B1D414A8B3';
const SF_CLAUDE = '00223EE0-DBBE-4EB8-9D20-9330C73C8389';
const SF_GONE = 'E03C63C2-AD4F-4625-BDAA-9E5D3B3646F7';
const C_BUSY = 'a9d25355-6056-4302-9146-5d905cb8cec5';
const C_GONE = 'c1c2d3e4-0000-4000-8000-000000000003';

const AGENTS = [
  { id: 'cfo', name: 'CFO', role: 'Money', description: 'Invented.', group: 'work', kind: 'persona', provider: 'claude', cwd: '/invented/work/cfo' },
  { id: 'catchup', name: 'Catchup', role: 'Work', description: 'Invented work folder.', group: 'work', kind: 'project', provider: 'codex', cwd: '/invented/work/catchup' },
  { id: 'brain', name: 'Second brain', role: 'Notes', description: 'Invented.', group: 'personal', kind: 'persona', provider: 'claude', cwd: '/invented/brain' },
  { id: 'focus', name: 'Focus', role: 'Tasks', description: 'Invented task board.', group: 'personal', kind: 'system', cwd: '/invented/focus' },
];

const QUESTION = {
  requestId: 'q-1',
  kind: 'question',
  toolName: 'requestUserInput',
  native: false,
  input: {
    threadId: 't1',
    questions: [{
      id: 'colour', header: 'Colour', question: 'Which colour?', isOther: true, isSecret: false,
      options: [{ label: 'Amber', description: 'Warm.' }, { label: 'Blue', description: 'Cool.' }],
    }],
  },
};

const COMMAND = {
  requestId: 'a-1',
  kind: 'approval',
  toolName: 'commandExecution',
  native: false,
  input: { threadId: 't2', turnId: 'turn', itemId: 'exec-1', command: ['rm', '-rf', 'build'], cwd: '/invented/other', reason: 'Clean the build.' },
};

function thread(threadId, extra = {}) {
  return {
    id: `codex:${threadId}`, threadId, cwd: '/invented/work/catchup', title: null, state: 'idle', pending: null,
    lastMessage: null, lastError: null, updatedAt: ago(30 * MINUTE), ...extra,
  };
}

// Two live surfaces; a Claude terminal working in the Catchup folder and
// one whose terminal has closed.
function inventory(extra = {}) {
  return {
    available: true,
    stale: false,
    refreshedAt: ago(1000),
    workspaces: [{ id: WS, name: '~', cwd: '/invented' }],
    surfaces: [
      { id: SF_OPEN, workspaceId: WS, paneId: null, title: 'Terminal', cwd: '/invented/work/catchup/sub' },
      { id: SF_CLAUDE, workspaceId: WS, paneId: null, title: 'Terminal', cwd: '/invented/work/catchup' },
    ],
    agents: [
      { sessionId: C_BUSY, agent: 'claude', state: 'running', cwd: '/invented/work/catchup', workspaceId: WS, surfaceId: SF_CLAUDE, startedAt: ago(60 * MINUTE), updatedAt: ago(2 * MINUTE), live: true },
      { sessionId: C_GONE, agent: 'claude', state: 'idle', cwd: '/invented/home/notes', workspaceId: WS, surfaceId: SF_GONE, startedAt: ago(60 * MINUTE), updatedAt: ago(20 * MINUTE), live: false },
    ],
    ...extra,
  };
}

const CMUX_OFF = { available: false, reason: 'not_running', stale: false, refreshedAt: null, workspaces: [], surfaces: [], agents: [] };

// Three Codex threads: one waiting on a question under Catchup with a live
// terminal, one idle under Catchup whose terminal closed, and one working
// outside every project with no terminal recorded.
function sessions() {
  return [
    thread('t1', {
      cwd: '/invented/work/catchup/sub', title: 'Fix the flaky test', state: 'waiting', pending: QUESTION,
      lastMessage: { role: 'assistant', text: 'Which colour?', at: ago(5 * MINUTE) }, updatedAt: ago(5 * MINUTE),
    }),
    thread('t3', { title: 'Closed one', updatedAt: ago(30 * MINUTE) }),
    thread('t2', { cwd: '/invented/other', state: 'busy', updatedAt: ago(10 * MINUTE) }),
  ];
}

const THREADS = {
  'codex:t1': [
    { role: 'user', text: 'Fix the flaky test.', at: ago(8 * MINUTE) },
    { role: 'assistant', text: 'Which colour?', at: ago(5 * MINUTE) },
  ],
};

function seeded(extra = {}) {
  return {
    build: () => ({
      agents: AGENTS,
      jobs: { items: [], focusAvailable: true, refreshedAt: ago(5_000) },
      personas: { cfo: {} },
      codex: { sessions: sessions(), status: { available: true }, threads: THREADS },
      cmux: inventory(),
      bindings: { t1: { workspaceId: WS, surfaceId: SF_OPEN }, t3: { workspaceId: WS, surfaceId: SF_GONE } },
      ...extra,
    }),
  };
}

function row(page, name) {
  return page.locator('.agent-row').filter({ has: page.locator('.agent-row-name', { hasText: new RegExp(`^${name}$`) }) });
}

const pane = (page) => page.locator('#agent-panel');
const messages = (page) => page.locator('#agent-messages .thread-message');
const openButton = (page) => page.locator('#agent-open-terminal');
const terminalLine = (page) => page.locator('#agent-terminal-reason');
const phone = (page) => page.viewportSize().width < 720;
const names = (page) => page.locator('#agents-groups .agent-row .agent-row-name');

test.describe('with sessions', () => {
  test.use({ hubOptions: seeded() });

  test('sessions nest under their project newest first, the rest under Other sessions, with folder, time, and state', async ({ page, hub }) => {
    await page.goto(`${hub.origin}/`);
    await expectView(page, 'agents', 'Agents');
    await expect(page.locator('.agent-group-heading')).toHaveText(['Work', 'Personal', 'Other sessions']);
    await expect(names(page)).toHaveText(['CFO', 'Catchup', 'catchup', 'Fix the flaky test', 'Closed one', 'Second brain', 'Focus', 'other', 'notes']);

    const fix = row(page, 'Fix the flaky test');
    await expect(fix).toHaveClass(/agent-row-session/);
    await expect(fix).toHaveAttribute('href', '/?agent=codex%3At1');
    await expect(fix.locator('.provider-chip')).toHaveText('Codex');
    await expect(fix.locator('.role-chip')).toHaveCount(0);
    await expect(fix.locator('.agent-row-preview')).toHaveText('~/work/catchup/sub');
    await expect(fix.locator('.agent-row-time')).toHaveText('5 minutes ago');
    await expect(fix.locator('.agent-row-state')).toHaveText('Waiting for you');
    await expect(fix.locator('.agent-row-state')).toHaveClass(/agent-row-state-wait/);

    const terminal = row(page, 'catchup');
    await expect(terminal).toHaveAttribute('href', `/?agent=claude%3A${C_BUSY}`);
    await expect(terminal.locator('.provider-chip')).toHaveText('Claude');
    await expect(terminal.locator('.agent-row-preview')).toHaveText('~/work/catchup');
    await expect(terminal.locator('.agent-row-state')).toHaveText('Working');

    await expect(row(page, 'Closed one').locator('.agent-row-state')).toHaveText('Terminal closed');
    await expect(row(page, 'other').locator('.agent-row-preview')).toHaveText('~/other');
    await expect(row(page, 'other').locator('.agent-row-state')).toHaveText('Working');
    await expect(row(page, 'notes').locator('.agent-row-state')).toHaveText('Terminal closed');
    await expect(page.locator('.agents-sessions-message')).toHaveCount(0);

    // The project row itself still opens nothing.
    await expect(row(page, 'Catchup')).not.toHaveAttribute('href', /.*/);
    for (const link of await page.locator('#agents-groups a.agent-row').all()) {
      expect((await link.boundingBox()).height).toBeGreaterThanOrEqual(44);
    }
    expect(hub.codex.calls).toEqual([]);
  });

  test('a Codex session opens its history, question, and Interrupt through the session routes, with no composer', async ({ page, hub }) => {
    await page.goto(`${hub.origin}/`);
    await row(page, 'Fix the flaky test').click();
    await expect(page).toHaveURL(`${hub.origin}/?agent=codex%3At1`);
    await expect(pane(page).locator('#agent-name')).toHaveText('Fix the flaky test');
    await expect(pane(page).locator('#agent-chips .provider-chip')).toHaveText('Codex');
    await expect(pane(page).locator('#agent-chips .role-chip')).toHaveCount(0);
    await expect(page.locator('#agent-description')).toHaveText('~/work/catchup/sub');
    await expect(page.locator('#agent-cost')).toBeEmpty();
    await expect(page.locator('#agent-new-thread')).toBeHidden();
    await expect(pane(page).getByRole('button', { name: /Jobs/ })).toHaveCount(0);
    await expect(page.locator('#agent-details-toggle')).toBeHidden();
    await expect(page.locator('#agent-details')).toBeHidden();
    await expect(page.locator('#agent-composer')).toBeHidden();
    await expect(page.locator('#agent-foot')).toHaveText('Type to this thread in its terminal.');
    await expect(messages(page)).toHaveText([/^Fix the flaky test\./, /^Which colour\?/]);
    await expect(messages(page).nth(0)).toHaveClass(/thread-message-user/);
    await expect(row(page, 'Fix the flaky test')).toHaveAttribute('aria-current', 'true');
    expect(hub.requests('/api/sessions/codex:t1/thread').map((r) => r.status)).toEqual([200]);

    const request = page.locator('#agent-request');
    await expect(request.locator('.request-chip')).toHaveText('Colour');
    await expect(request.locator('.request-title')).toHaveText('Which colour?');
    await expect(request.locator('.option .option-label')).toHaveText(['Amber', 'Blue']);
    await expect(page.locator('#agent-status-text')).toHaveText('Fix the flaky test is waiting for you.');
    await request.locator('.option').nth(0).click();
    await request.getByRole('button', { name: 'Answer' }).click();
    await expect(request).toBeHidden();
    await expect(page.locator('#agent-status-text')).toHaveText('Fix the flaky test is working.');
    await expect(row(page, 'Fix the flaky test').locator('.agent-row-state')).toHaveText('Working');
    expect(hub.codex.calls.filter((c) => c[0] === 'answer')).toEqual([['answer', 'codex:t1', 'q-1', { answers: { colour: 'Amber' } }]]);
    expect(hub.requests('/api/sessions/codex:t1/answer')).toEqual([{ method: 'POST', status: 200 }]);

    await page.locator('#agent-status').getByRole('button', { name: 'Interrupt' }).click();
    await expect(page.locator('#agent-status')).toBeHidden();
    await expect(row(page, 'Fix the flaky test').locator('.agent-row-state')).toHaveCount(0);
    expect(hub.codex.calls.filter((c) => c[0] === 'interrupt')).toEqual([['interrupt', 'codex:t1']]);
    expect(hub.requests('/api/sessions/codex:t1/interrupt')).toEqual([{ method: 'POST', status: 200 }]);
  });

  test('a command approval shows the command, folder, and reason, and Deny goes through the session route; a native request has no buttons', async ({ page, hub }) => {
    await page.goto(`${hub.origin}/?agent=codex:t2`);
    await expect(pane(page).locator('#agent-name')).toHaveText('other');
    await expect(page.locator('#agent-status-text')).toHaveText('other is working.');
    await expect(page.locator('#agent-messages .thread-line')).toHaveText('No messages yet.');

    hub.codex.set('codex:t2', { state: 'waiting', pending: COMMAND });
    const request = page.locator('#agent-request');
    await expect(request.locator('.request-title')).toHaveText('other wants to run a command');
    await expect(request.locator('.request-detail-label')).toHaveText(['Command', 'Folder', 'Reason']);
    await expect(request.locator('.request-detail .request-input')).toHaveText('rm -rf build');
    await expect(request.locator('.request-detail-text')).toHaveText(['~/other', 'Clean the build.']);
    await expect(request.getByRole('button')).toHaveText(['Allow', 'Deny']);
    await expect(request.locator('.request-note')).toHaveCount(0);
    await expect(page.locator('#agent-status-text')).toHaveText('other is waiting for you.');
    await expect(row(page, 'other').locator('.agent-row-state')).toHaveText('Waiting for you');

    await request.getByRole('button', { name: 'Deny' }).click();
    await expect(request).toBeHidden();
    await expect(page.locator('#agent-status-text')).toHaveText('other is working.');
    expect(hub.codex.calls.at(-1)).toEqual(['answer', 'codex:t2', 'a-1', { decision: 'deny' }]);
    expect(hub.requests('/api/sessions/codex:t2/answer')).toEqual([{ method: 'POST', status: 200 }]);

    // Permissions list what is asked for; a native one is answered in the terminal.
    hub.codex.set('codex:t2', {
      state: 'waiting',
      pending: {
        requestId: 'a-2', kind: 'approval', toolName: 'permissions', native: true,
        input: {
          threadId: 't2', reason: 'Write marker.txt?',
          permissions: { network: null, fileSystem: { read: null, write: ['/invented/other/marker.txt'], entries: [{ path: { type: 'path', path: '/invented/other/marker.txt' }, access: 'write' }] } },
        },
      },
    });
    await expect(request.locator('.request-title')).toHaveText('other asks for permission');
    await expect(request.locator('.request-detail-label')).toHaveText(['Permissions', 'Reason']);
    await expect(request.locator('.request-detail li')).toHaveText(['write ~/other/marker.txt']);
    await expect(request.locator('.request-note')).toHaveText('Answer this one in the terminal.');
    await expect(request.getByRole('button')).toHaveCount(0);

    // A request of a kind the view does not know is headed by what it is
    // for, not its wire method, and its input is shown as it came.
    hub.codex.set('codex:t2', {
      state: 'waiting',
      pending: { requestId: 'a-3', kind: 'approval', toolName: 'mcpServer/elicitation/request', native: true, input: { threadId: 't2', message: 'Hi' } },
    });
    await expect(request.locator('.request-title')).toHaveText('other is waiting on the terminal');
    await expect(request.locator('.request-details')).toHaveCount(0);
    await expect(request.locator('.request-input')).toHaveText('{\n  "threadId": "t2",\n  "message": "Hi"\n}');
    await expect(request.locator('.request-note')).toHaveText('Answer this one in the terminal.');
    await expect(request.getByRole('button')).toHaveCount(0);
  });

  test('a Codex question without Other has no field, and a secret answer is typed into a password field', async ({ page, hub }) => {
    await page.goto(`${hub.origin}/?agent=codex:t2`);
    const request = page.locator('#agent-request');
    hub.codex.set('codex:t2', {
      state: 'waiting',
      pending: {
        ...QUESTION, requestId: 'q-2',
        input: { threadId: 't2', questions: [{ id: 'branch', question: 'Which branch?', isOther: false, isSecret: false, options: [{ label: 'main' }, { label: 'dev' }] }] },
      },
    });
    await expect(request.locator('.request-title')).toHaveText('Which branch?');
    await expect(request.locator('.option .option-label')).toHaveText(['main', 'dev']);
    await expect(request.locator('.request-other')).toHaveCount(0);
    await request.getByRole('button', { name: 'Answer' }).click();
    await expect(request.locator('.request-missing')).toHaveText('Every question needs an answer.');
    await expect(request.locator('.option').nth(0)).toBeFocused();
    await request.locator('.option').nth(1).click();
    await request.getByRole('button', { name: 'Answer' }).click();
    await expect(request).toBeHidden();
    expect(hub.codex.calls.at(-1)).toEqual(['answer', 'codex:t2', 'q-2', { answers: { branch: 'dev' } }]);

    hub.codex.set('codex:t2', {
      state: 'waiting',
      pending: {
        ...QUESTION, requestId: 'q-3',
        input: { threadId: 't2', questions: [{ id: 'token', question: 'Paste the token.', isOther: true, isSecret: true, options: [] }] },
      },
    });
    await expect(request.locator('.request-title')).toHaveText('Paste the token.');
    const field = request.locator('.request-other-field');
    await expect(field).toHaveAttribute('type', 'password');
    await expect(field).toHaveAttribute('autocomplete', 'off');
    await field.fill('invented-secret');
    await request.getByRole('button', { name: 'Answer' }).click();
    await expect(request).toBeHidden();
    expect(hub.codex.calls.at(-1)).toEqual(['answer', 'codex:t2', 'q-3', { answers: { token: 'invented-secret' } }]);
  });

  test('a failed turn says only that the turn failed, whatever the server said', async ({ page, hub }) => {
    await page.goto(`${hub.origin}/?agent=codex:t2`);
    hub.codex.set('codex:t2', { state: 'error', lastError: 'Rate limited: retry after 30s' });
    await expect(page.locator('#agent-notice')).toHaveText('The last turn failed.');
    await expect(row(page, 'other').locator('.agent-row-state')).toHaveText('The last turn failed');
    await expect(page.locator('#agent-status')).toBeHidden();
    await expect(page.locator('#agent-panel')).not.toContainText('Rate limited');
  });

  test('a session opened with the settings open shows neither the gear nor the panel, and a project row shows both', async ({ page, hub }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${hub.origin}/?agent=catchup`);
    await page.locator('#agent-details-toggle').click();
    const details = page.locator('#agent-details');
    await expect(details.locator('.request-detail-text')).toHaveText(['Work', 'Work', 'Codex', '~/work/catchup']);

    await row(page, 'Fix the flaky test').click();
    await expect(pane(page).locator('#agent-name')).toHaveText('Fix the flaky test');
    await expect(page.locator('#agent-details-toggle')).toBeHidden();
    await expect(details).toBeHidden();
    await expect(messages(page)).toHaveCount(2);
  });

  test('a Claude terminal shows where it runs and its state, with no messages and no composer', async ({ page, hub }) => {
    await page.goto(`${hub.origin}/?agent=claude:${C_BUSY}`);
    await expect(pane(page).locator('#agent-name')).toHaveText('catchup');
    await expect(pane(page).locator('#agent-chips .provider-chip')).toHaveText('Claude');
    await expect(page.locator('#agent-description')).toHaveText('~/work/catchup');
    await expect(page.locator('#agent-messages .thread-line')).toHaveText(['Claude is working.']);
    await expect(messages(page)).toHaveCount(0);
    await expect(page.locator('#agent-composer')).toBeHidden();
    await expect(page.locator('#agent-foot')).toBeHidden();
    await expect(page.locator('#agent-status')).toBeHidden();
    await expect(page.locator('#agent-request')).toBeHidden();
    await expect(page.locator('#agent-new-thread')).toBeHidden();
    await expect(page.locator('#agent-details-toggle')).toBeHidden();
    await expect(openButton(page)).toBeEnabled();
    expect(hub.requests(`/api/sessions/claude:${C_BUSY}/thread`)).toEqual([]);

    // The pane follows the terminal's state.
    hub.cmux.set(inventory({ agents: [{ ...inventory().agents[0], state: 'idle' }, inventory().agents[1]] }));
    await hub.state.refreshSessions();
    await expect(page.locator('#agent-messages .thread-line')).toHaveText(['Claude is idle.']);
    await expect(row(page, 'catchup').locator('.agent-row-state')).toHaveCount(0);
    hub.cmux.set(inventory({ agents: [{ ...inventory().agents[0], state: 'needsInput' }, inventory().agents[1]] }));
    await hub.state.refreshSessions();
    await expect(page.locator('#agent-messages .thread-line')).toHaveText(['Claude is waiting for you.']);
    await expect(row(page, 'catchup').locator('.agent-row-state')).toHaveText('Waiting for you');
    await expect(row(page, 'catchup').locator('.agent-row-state')).toHaveClass(/agent-row-state-wait/);

    // A closed terminal says so and cannot be opened.
    await page.goto(`${hub.origin}/?agent=claude:${C_GONE}`);
    await expect(pane(page).locator('#agent-name')).toHaveText('notes');
    await expect(page.locator('#agent-messages .thread-line')).toHaveText(['The terminal is closed.']);
    await expect(openButton(page)).toBeDisabled();
    await expect(terminalLine(page)).toHaveText('That terminal is closed.');
  });

  test('Open terminal focuses the bound terminal and says why it cannot otherwise', async ({ page, hub }) => {
    await page.goto(`${hub.origin}/?agent=codex:t1`);
    await expect(openButton(page)).toBeEnabled();
    await expect(terminalLine(page)).toBeHidden();
    expect((await openButton(page).boundingBox()).height).toBeGreaterThanOrEqual(44);
    await openButton(page).click();
    await expect.poll(() => hub.requests('/api/sessions/codex:t1/open-terminal')).toEqual([{ method: 'POST', status: 200 }]);
    expect(hub.cmux.focusCalls).toEqual([{ workspaceId: WS, surfaceId: SF_OPEN }]);
    await expect(terminalLine(page)).toBeHidden();
    await expect(openButton(page)).toBeEnabled();

    // A refusal is said under the button until the next attempt.
    hub.cmux.focusResult = { ok: false, reason: 'error' };
    await openButton(page).click();
    await expect(terminalLine(page)).toHaveText('cmux could not open that terminal.');
    hub.cmux.focusResult = { ok: true, verified: true };
    await openButton(page).click();
    await expect(terminalLine(page)).toBeHidden();
    expect(hub.cmux.focusCalls).toHaveLength(3);

    await page.goto(`${hub.origin}/?agent=codex:t2`);
    await expect(openButton(page)).toBeDisabled();
    await expect(terminalLine(page)).toHaveText('This thread was not started with codex-new, so its terminal is not known.');

    await page.goto(`${hub.origin}/?agent=codex:t3`);
    await expect(openButton(page)).toBeDisabled();
    await expect(terminalLine(page)).toHaveText('That terminal is closed.');
    expect(hub.cmux.focusCalls).toHaveLength(3);
  });

  test('Health says nothing about availability while both answer', async ({ page, hub }) => {
    await page.goto(`${hub.origin}/health`);
    await expectView(page, 'health', 'Health');
    await expect(page.locator('#health-availability')).toBeHidden();
  });

  test('at phone width a session row opens its pane full width with a way back', async ({ page, hub }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${hub.origin}/`);
    await expect(page.locator('#agents-list')).toBeVisible();
    await expect(page.locator('#agent-thread')).toBeHidden();
    await row(page, 'Fix the flaky test').click();
    await expect(page).toHaveURL(`${hub.origin}/?agent=codex%3At1`);
    await expect(page.locator('#agents-list')).toBeHidden();
    await expect(page.locator('#agent-thread')).toBeVisible();
    expect((await page.locator('#agent-thread').boundingBox()).width).toBe(390);
    await expect(messages(page)).toHaveCount(2);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    const back = page.locator('#agent-back');
    await expect(back).toHaveText('All agents');
    await back.click();
    await expect(page).toHaveURL(`${hub.origin}/`);
    await expect(page.locator('#agents-list')).toBeVisible();
    await expect(page.locator('#agent-thread')).toBeHidden();
  });

  test('a session deep link opens the session, survives a reload, and an unlisted one says so', async ({ page, hub }) => {
    await page.goto(`${hub.origin}/?agent=codex:t1`);
    await expectView(page, 'agents', 'Agents');
    await expect(pane(page).locator('#agent-name')).toHaveText('Fix the flaky test');
    await expect(messages(page)).toHaveCount(2);
    await page.reload();
    await expect(pane(page).locator('#agent-name')).toHaveText('Fix the flaky test');
    await expect(messages(page)).toHaveCount(2);

    // Choosing the open row adds no history entry.
    const before = await page.evaluate(() => history.length);
    if (!phone(page)) {
      await row(page, 'Fix the flaky test').click();
      await expect(page).toHaveURL(`${hub.origin}/?agent=codex:t1`);
      expect(await page.evaluate(() => history.length)).toBe(before);
    }

    await page.goto(`${hub.origin}/?agent=codex:nowhere`);
    await expect(page.locator('#agent-empty')).toHaveText('That session is not listed.');
    await expect(pane(page)).toBeHidden();
  });
});

test.describe('with the Codex server gone', () => {
  test.use({
    hubOptions: seeded({
      codex: {
        sessions: [thread('t1', { title: 'Fix the flaky test', state: 'unavailable', lastError: 'server_gone', updatedAt: ago(5 * MINUTE) })],
        status: { available: false, reason: 'disconnected' },
        threads: {},
      },
    }),
  });

  test('the row says Server stopped, the pane says why, and Health says the server disconnected', async ({ page, hub }) => {
    await page.goto(`${hub.origin}/`);
    await expectView(page, 'agents', 'Agents');
    await expect(row(page, 'Fix the flaky test').locator('.agent-row-state')).toHaveText('Server stopped');
    await expect(page.locator('.agents-sessions-message')).toHaveCount(0);
    await expect(page.locator('#view-agents .availability')).toHaveCount(0);
    await page.goto(`${hub.origin}/health`);
    await expect(page.locator('#health-availability p')).toHaveText(['The Codex server disconnected.']);

    await page.goto(`${hub.origin}/?agent=codex:t1`);
    await expect(page.locator('#agent-notice')).toHaveText('The Codex server disconnected.');
    await expect(page.locator('#agent-messages')).toBeEmpty();
    await expect(page.locator('#agent-status')).toBeHidden();
    await expect(page.locator('#agent-foot')).toHaveText('Type to this thread in its terminal.');
    expect(hub.requests('/api/sessions/codex:t1/thread')).toEqual([]);
  });
});

test.describe('with cmux not running', () => {
  test.use({ hubOptions: seeded({ cmux: CMUX_OFF }) });

  test('Open terminal is off with the cmux sentence, terminal rows are gone, and Health says it', async ({ page, hub }) => {
    await page.goto(`${hub.origin}/?agent=codex:t1`);
    await expect(openButton(page)).toBeDisabled();
    await expect(terminalLine(page)).toHaveText('cmux is not running.');
    await expect(names(page)).toHaveText(['CFO', 'Catchup', 'Fix the flaky test', 'Closed one', 'Second brain', 'Focus', 'other']);
    await expect(row(page, 'Closed one').locator('.agent-row-state')).toHaveText('Terminal closed');
    await expect(page.locator('.agents-sessions-message')).toHaveCount(0);

    await page.goto(`${hub.origin}/health`);
    await expect(page.locator('#health-availability p')).toHaveText(['cmux is not running.']);
  });
});

test.describe('with nothing to list and both sources off', () => {
  test.use({
    hubOptions: seeded({
      codex: { sessions: [], status: { available: false, reason: 'no_server' }, threads: {} },
      cmux: CMUX_OFF,
      bindings: {},
    }),
  });

  test('the list ends with one sentence and Health lists both', async ({ page, hub }) => {
    await page.goto(`${hub.origin}/`);
    await expectView(page, 'agents', 'Agents');
    await expect(names(page)).toHaveText(['CFO', 'Catchup', 'Second brain', 'Focus']);
    await expect(page.locator('.agent-group-heading')).toHaveText(['Work', 'Personal']);
    const sentence = page.locator('.agents-sessions-message');
    await expect(sentence).toHaveText('No coding sessions. Start the Codex server or open a terminal in cmux.');
    expect((await sentence.boundingBox()).y).toBeGreaterThan((await row(page, 'Focus').boundingBox()).y);
    await expect(page.locator('#view-agents .availability')).toHaveCount(0);

    // With cmux back, the sentence goes.
    hub.cmux.set(inventory({ agents: [] }));
    await hub.state.refreshSessions();
    await expect(sentence).toHaveCount(0);

    // Health says what is still off, and follows the state.
    await page.goto(`${hub.origin}/health`);
    const lines = page.locator('#health-availability p');
    await expect(lines).toHaveText(['The Codex server is not running.']);
    hub.cmux.set(CMUX_OFF);
    await hub.state.refreshSessions();
    await expect(lines).toHaveText(['The Codex server is not running.', 'cmux is not running.']);
  });
});
