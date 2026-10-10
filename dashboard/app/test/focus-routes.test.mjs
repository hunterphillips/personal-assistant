import assert from 'node:assert/strict';
import { cp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { LIMITS } from '../lib/config.mjs';
import { createBoard } from '../lib/focus/board.mjs';
import { instructionsMessage } from '../lib/focus-routes.mjs';
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

async function startFocus(t, { includeBoard = true, limits = LIMITS, focusBoard = undefined } = {}) {
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
    focusBoard: board, focusInstructions: instructions,
    focus: { checkHealth: async () => ({ available: true }), handleApi: (_req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"proxy":true}'); }, handlePage() {}, handleControl() {} },
    brief: { latestMetadata: async () => ({ state: 'empty' }) },
    registry: fakeRegistry([agent('pinned', { pinned: true }), agent('other')]), adapters: { claude: adapter },
    env: { DASHBOARD_FOCUS_RULES: rulesFile }, configure: (config) => Object.freeze({ ...config, limits }),
  });
  t.after(() => adapter.release());
  return { ...app, adapter, boardFile, changesFile, rulesFile };
}

function post(app, body, headers = {}) {
  return request(app, 'POST', '/api/focus/changes', { headers: { origin: app.origin, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
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
