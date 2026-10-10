import assert from 'node:assert/strict';
import { cp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { LIMITS } from '../lib/config.mjs';
import { createBoard } from '../lib/focus/board.mjs';
import { createFocusRoutes, instructionsMessage } from '../lib/focus-routes.mjs';
import { createFocusSettings } from '../lib/focus/settings.mjs';
import { createInstructions } from '../lib/instructions.mjs';
import { fakeRegistry, request, startApp, tempDir } from './support/harness.mjs';

const FIXTURE = fileURLToPath(new URL('./fixtures/focus/', import.meta.url));

function agent(id, extra = {}) {
  return Object.freeze({ id, name: id, role: 'Role', description: 'Invented.', group: 'personal', kind: 'persona', cwd: '/invented', provider: 'claude', jobs: [], ...extra });
}

function fakeAdapter() {
  let release;
  const adapter = {
    calls: [], turn: new Promise((resolve) => { release = resolve; }), release: () => release(),
    start: async () => ({}), state: () => ({ state: 'idle', pending: null, lastError: null, sessionId: null, costUsd: null }),
    subscribe: () => () => {},
    send(agentValue, text, options) { adapter.calls.push([agentValue.id, text, options]); return adapter.turn; },
  };
  return adapter;
}

async function startFocus(t, {
  includeBoard = true, limits = LIMITS, focusBoard = undefined, focusSettings = null, focusRunner = null, focusJobs = null,
} = {}) {
  const root = await tempDir(t);
  const dir = path.join(root, 'focus');
  await cp(FIXTURE, dir, { recursive: true });
  const boardFile = path.join(dir, 'board.json');
  if (!includeBoard) await import('node:fs/promises').then(({ unlink }) => unlink(boardFile));
  const changesFile = path.join(dir, 'changes.jsonl');
  const rulesFile = path.join(dir, 'rules.md');
  await writeFile(rulesFile, '# Invented Focus rules\n');
  const board = focusBoard ?? createBoard({ file: boardFile, changesFile, candidatesDir: path.join(dir, 'candidates'), limits });
  const instructions = createInstructions({ file: rulesFile, path: 'focus/rules.md', maxBytes: limits.focusBoardBytes, label: 'Focus', event: 'focus_rules_error' });
  const adapter = fakeAdapter();
  const app = await startApp(t, {
    focusBoard: board, focusInstructions: instructions, focusSettings, focusRunner, focusJobs,
    focus: { checkHealth: async () => ({ available: true }), handleApi: (_req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"proxy":true}'); }, handlePage() {}, handleControl() {} },
    brief: { latestMetadata: async () => ({ state: 'empty' }) },
    registry: fakeRegistry([agent('pinned', { pinned: true }), agent('other')]), adapters: { claude: adapter },
    env: { DASHBOARD_FOCUS_RULES: rulesFile }, configure: (config) => Object.freeze({ ...config, limits }),
  });
  t.after(() => adapter.release());
  return { ...app, adapter, boardFile, changesFile, rulesFile };
}

async function startControls(t, overrides = {}) {
  const state = { paused: false, schedules: { calendar: '5 * * * *', gmail: '35 * * * *', git: '15 6,10,14,18 * * *', notes: '45 5,7,11,15,19 * * *', rejudge: '30 5 * * *' }, model: { id: null, effort: null }, problem: null };
  const focusSettings = {
    current: () => state,
    async update(patch) { Object.assign(state, patch); return state; },
    onChange: () => () => {},
  };
  const focusRunner = { state: () => ({ running: null }), lastRun: () => null, onChange: () => () => {}, rows: () => [] };
  const focusJobs = { refresh: async () => ({ ok: true, run: 'refresh-run' }) };
  return startFocus(t, { focusSettings, focusRunner, focusJobs, ...overrides });
}

function post(app, body, headers = {}) {
  return request(app, 'POST', '/api/focus/changes', { headers: { origin: app.origin, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
}

function fakeResponse() {
  return {
    status: null, json: null,
    writeHead(status) { this.status = status; },
    end(body) { this.json = body === undefined ? null : JSON.parse(String(body)); },
  };
}

function jsonRequest(value) {
  const text = JSON.stringify(value);
  const req = Readable.from([Buffer.from(text)]);
  req.headers = { 'content-length': String(Buffer.byteLength(text)), 'content-type': 'application/json' };
  return req;
}

async function settingsRoutes(t, overrides = {}) {
  const root = await tempDir(t);
  const settings = createFocusSettings({ file: path.join(root, 'settings.json'), limits: LIMITS });
  await settings.load();
  const runner = overrides.runner ?? { state: () => ({ running: 'focus.scan-calendar' }), lastRun: (label) => ({ run: label, outcome: 'wrote' }) };
  const board = overrides.board ?? {
    exists: async () => true,
    read: async () => ({ board: { updated: '2026-10-10T12:00:00.000Z', items: [] }, problem: null }),
  };
  const jobs = overrides.jobs ?? { refresh: async () => ({ ok: true, run: 'refresh-run' }) };
  return { settings, runner, board, jobs, routes: createFocusRoutes({ board, settings, runner, jobs, limits: LIMITS }) };
}

test('GET /api/focus reads the native board and candidates carry verdicts', async (t) => {
  const app = await startFocus(t);
  const board = await request(app, 'GET', '/api/focus');
  assert.equal(board.status, 200);
  assert.deepEqual([board.json.board.updated, board.json.problem], ['2026-10-10T12:00:00.000Z', null]);
  const candidates = await request(app, 'GET', '/api/focus/candidates');
  assert.equal(candidates.status, 200);
  assert.deepEqual(candidates.json.sources[0].candidates[0].verdict, { status: 'open', tier: 'today', id: 'now-one', updated: '2026-10-10T12:00:00.000Z' });
});

test('native Focus read adds paused and the running job', async (t) => {
  const { routes } = await settingsRoutes(t);
  const res = fakeResponse();
  await routes.serveRead(res);
  assert.equal(res.status, 200);
  assert.equal(res.json.paused, false);
  assert.equal(res.json.scanning, 'focus.scan-calendar');
});

test('Focus settings routes describe schedules, update allowed fields, and map refusals', async (t) => {
  const { routes, settings } = await settingsRoutes(t);
  const read = fakeResponse();
  routes.serveSettings(read);
  assert.deepEqual(read.json.schedules[0], {
    source: 'calendar', cron: '5 * * * *', text: 'Every hour at :05',
    lastRun: { run: 'focus.scan-calendar', outcome: 'wrote' },
  });
  const changed = fakeResponse();
  await routes.serveSettingsUpdate(jsonRequest({ paused: true, model: { id: 'sonnet' } }), changed);
  assert.equal(changed.status, 200);
  assert.equal(changed.json.paused, true);
  assert.deepEqual(changed.json.model, { id: 'sonnet', effort: null });
  assert.equal(settings.current().paused, true);

  await assert.rejects(routes.serveSettingsUpdate(jsonRequest({ paused: 'yes' }), fakeResponse()), (error) => error.status === 400 && error.code === 'invalid_body');
  await settings.update({ paused: false });
});

test('Focus refresh returns its run and maps busy and missing board', async (t) => {
  const ready = await settingsRoutes(t);
  const accepted = fakeResponse();
  await ready.routes.serveRefresh(accepted);
  assert.deepEqual([accepted.status, accepted.json], [202, { run: 'refresh-run' }]);

  const busy = await settingsRoutes(t, { jobs: { refresh: async () => ({ ok: false, reason: 'already_running' }) } });
  await assert.rejects(busy.routes.serveRefresh(fakeResponse()), (error) => error.status === 409 && error.code === 'already_running');
  const refused = await settingsRoutes(t, { jobs: { refresh: async () => ({ ok: false, reason: 'stopped' }) } });
  await assert.rejects(refused.routes.serveRefresh(fakeResponse()), (error) => error.status === 409 && error.code === 'stopped');
  const missing = await settingsRoutes(t, { board: { exists: async () => false } });
  await assert.rejects(missing.routes.serveRefresh(fakeResponse()), (error) => error.status === 404 && error.code === 'no_board');
});

test('native settings and refresh routes enforce Origin and expose their response shapes', async (t) => {
  const app = await startControls(t);
  const read = await request(app, 'GET', '/api/focus/settings');
  assert.equal(read.status, 200);
  assert.equal(read.json.schedules.length, 5);
  const forbidden = await request(app, 'PUT', '/api/focus/settings', {
    headers: { 'content-type': 'application/json' }, body: '{"paused":true}',
  });
  assert.deepEqual([forbidden.status, forbidden.json], [403, { error: 'forbidden_origin' }]);
  const updated = await request(app, 'PUT', '/api/focus/settings', {
    headers: { origin: app.origin, 'content-type': 'application/json' }, body: '{"paused":true}',
  });
  assert.deepEqual([updated.status, updated.json.paused], [200, true]);
  const refreshForbidden = await request(app, 'POST', '/api/focus/refresh');
  assert.deepEqual([refreshForbidden.status, refreshForbidden.json], [403, { error: 'forbidden_origin' }]);
  const refreshed = await request(app, 'POST', '/api/focus/refresh', { headers: { origin: app.origin } });
  assert.deepEqual([refreshed.status, refreshed.json], [202, { run: 'refresh-run' }]);
});

test('new native Focus routes are not found without their dependencies', async (t) => {
  const app = await startFocus(t);
  assert.deepEqual([(await request(app, 'GET', '/api/focus/settings')).status, (await request(app, 'POST', '/api/focus/refresh', { headers: { origin: app.origin } })).status], [404, 404]);
});

test('native Focus settings and refresh routes expose size, invalid-file, busy, and no-board refusals', async (t) => {
  const tiny = await startControls(t, { limits: Object.freeze({ ...LIMITS, focusSettingsBytes: 16 }) });
  const oversized = await request(tiny, 'PUT', '/api/focus/settings', {
    headers: { origin: tiny.origin, 'content-type': 'application/json' }, body: JSON.stringify({ model: { id: 'x'.repeat(40) } }),
  });
  assert.deepEqual([oversized.status, oversized.json], [413, { error: 'payload_too_large' }]);

  const invalidSettings = {
    current: () => ({ paused: true, schedules: { calendar: '5 * * * *', gmail: '35 * * * *', git: '15 6,10,14,18 * * *', notes: '45 5,7,11,15,19 * * *', rejudge: '30 5 * * *' }, model: { id: null, effort: null }, problem: 'Broken.' }),
    async update() { const error = new Error('settings_invalid'); error.code = 'settings_invalid'; throw error; },
    onChange: () => () => {},
  };
  const invalid = await startControls(t, { focusSettings: invalidSettings });
  const refused = await request(invalid, 'PUT', '/api/focus/settings', {
    headers: { origin: invalid.origin, 'content-type': 'application/json' }, body: '{"paused":false}',
  });
  assert.deepEqual([refused.status, refused.json], [409, { error: 'settings_invalid' }]);

  const busy = await startControls(t, { focusJobs: { refresh: async () => ({ ok: false, reason: 'already_running' }) } });
  assert.deepEqual([(await request(busy, 'POST', '/api/focus/refresh', { headers: { origin: busy.origin } })).status], [409]);
  const missing = await startControls(t, { includeBoard: false });
  assert.deepEqual([(await request(missing, 'POST', '/api/focus/refresh', { headers: { origin: missing.origin } })).status], [404]);
});

test('GET /api/focus returns no_board if the selected native board disappears', async (t) => {
  const fake = { exists: async () => true, read: async () => ({ board: null, problem: null }), onChange: () => () => {}, candidates: async () => ({ sources: [] }), change: async () => null };
  const app = await startFocus(t, { focusBoard: fake });
  const response = await request(app, 'GET', '/api/focus');
  assert.deepEqual([response.status, response.json], [404, { error: 'no_board' }]);
});

test('GET /api/focus still reaches the proxy when the configured board file is absent', async (t) => {
  const app = await startFocus(t, { includeBoard: false });
  const response = await request(app, 'GET', '/api/focus');
  assert.deepEqual([response.status, response.json], [200, { proxy: true }]);
});

test('POST /api/focus/changes applies one operation and requires the exact Origin', async (t) => {
  const app = await startFocus(t);
  const changed = await post(app, { op: 'done', id: 'now-one' });
  assert.equal(changed.status, 200);
  assert.equal(changed.json.board.items.find((item) => item.id === 'now-one').status, 'done');
  assert.equal(JSON.parse(await readFile(app.changesFile, 'utf8')).summary, 'done "Send the draft agenda"');
  const forbidden = await request(app, 'POST', '/api/focus/changes', { headers: { 'content-type': 'application/json' }, body: '{"op":"done","id":"today-one"}' });
  assert.deepEqual([forbidden.status, forbidden.json], [403, { error: 'forbidden_origin' }]);
});

test('change route maps every board refusal code', async (t) => {
  const cases = [
    [{ op: 'unknown' }, 400, 'invalid_op'],
    [{ op: 'done', id: 'now-one', extra: true }, 400, 'invalid_field'],
    [{ op: 'move', id: 'now-one', place: 'now', order: [] }, 400, 'invalid_order'],
    [{ op: 'done', id: 'missing' }, 404, 'no_such_item'],
    [{ op: 'done', id: 'done-one' }, 409, 'not_open'],
    [{ op: 'reopen', id: 'now-one' }, 409, 'not_closed'],
    [{ op: 'title', id: 'now-one', title: 'Changed' }, 409, 'not_manual'],
  ];
  for (const [body, status, error] of cases) {
    const app = await startFocus(t);
    const response = await post(app, body);
    assert.deepEqual([response.status, response.json.error], [status, error], JSON.stringify(body));
  }
  const app = await startFocus(t);
  for (const body of [null, [], 'bad']) {
    const response = await post(app, body);
    assert.deepEqual([response.status, response.json], [400, { error: 'invalid_body' }]);
  }
});

test('change route reports no_board, board_invalid, and payload_too_large', async (t) => {
  const missing = await startFocus(t, { includeBoard: false });
  assert.deepEqual([(await post(missing, { op: 'done', id: 'x' })).status, (await post(missing, { op: 'done', id: 'x' })).json.error], [404, 'no_board']);
  const invalid = await startFocus(t);
  await writeFile(invalid.boardFile, '{');
  const refused = await post(invalid, { op: 'done', id: 'now-one' });
  assert.deepEqual([refused.status, refused.json.error], [409, 'board_invalid']);
  const tiny = await startFocus(t, { limits: Object.freeze({ ...LIMITS, focusChangeBytes: 32 }) });
  const over = await post(tiny, { op: 'add', title: 'x'.repeat(100) });
  assert.deepEqual([over.status, over.json], [413, { error: 'payload_too_large' }]);
});

test('Focus instructions resolve the pinned default agent and name the absolute rules file', async (t) => {
  const app = await startFocus(t);
  const read = await request(app, 'GET', '/api/focus/instructions');
  assert.deepEqual([read.status, read.json.path, read.json.problem, read.json.blocks], [200, 'focus/rules.md', null, [{ type: 'h', text: 'Invented Focus rules' }]]);
  const proposal = request(app, 'POST', '/api/focus/instructions/propose', {
    headers: { origin: app.origin, 'content-type': 'application/json' }, body: JSON.stringify({ text: 'Prefer smaller tasks.' }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  app.adapter.release();
  const response = await proposal;
  assert.deepEqual([response.status, response.json.agentId], [202, 'pinned']);
  assert.deepEqual(app.adapter.calls[0].slice(0, 2), ['pinned', instructionsMessage('Prefer smaller tasks.', app.rulesFile)]);
});
