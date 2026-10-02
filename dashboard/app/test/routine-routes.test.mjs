import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';

import { LIMITS } from '../lib/config.mjs';
import { createRoutines } from '../lib/routines.mjs';
import { SCHEDULE_SENTENCE } from '../lib/routine-routes.mjs';
import { fakeRegistry, request, startApp, tempDir } from './support/harness.mjs';

const AGENTS = [
  { id: 'assistant', name: 'Assistant', role: 'Assistant', description: 'Invented.', group: 'personal', kind: 'persona', provider: 'claude', cwd: '/invented', pinned: true },
  { id: 'cfo', name: 'CFO', role: 'Money', description: 'Invented.', group: 'work', kind: 'persona', provider: 'claude', cwd: '/invented' },
  { id: 'scribe', name: 'Scribe', role: 'Drafts', description: 'Invented.', group: 'work', kind: 'persona', provider: 'codex', cwd: '/invented' },
  { id: 'focus', name: 'Focus', role: 'Tasks', description: 'Invented.', group: 'personal', kind: 'system', cwd: '/invented' },
  { id: 'repo', name: 'Repo', role: 'Code', description: 'Invented.', group: 'work', kind: 'project', provider: 'codex', cwd: '/invented' },
];

const BODY = Object.freeze({ name: 'Daily drift', agent: 'cfo', instruction: 'Compute drift.', schedule: '30 6 * * 1-5', active: true });

function send(app, method, path, body, headers = {}) {
  return request(app, method, path, {
    headers: { origin: app.origin, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
}

async function setup(t, { agents = AGENTS, limits = {} } = {}) {
  const dir = path.join(await tempDir(t), 'routines');
  const routines = createRoutines({ dir, limits: { ...LIMITS, ...limits }, now: () => new Date('2026-10-03T12:00:00.000Z') });
  await routines.load();
  const app = await startApp(t, { registry: fakeRegistry(agents), routines, configure: (c) => ({ ...c, limits: { ...c.limits, ...limits } }) });
  return { app, routines, dir };
}

test('create answers 201 with the snapshot item, the list and the snapshot follow, and the file is written', async (t) => {
  const { app, routines } = await setup(t);
  const before = app.hub.snapshot().revision;
  const created = await send(app, 'POST', '/api/routines', BODY);
  assert.equal(created.status, 201);
  assert.equal(created.json.ok, true);
  const { routine } = created.json;
  assert.equal(routine.id, 'daily-drift');
  assert.deepEqual(routine.schedule, { cron: '30 6 * * 1-5', text: 'Weekdays at 6:30' });
  assert.equal(typeof routine.nextAt, 'string');
  assert.equal(routine.lastRun, null);
  assert.equal(routines.current().length, 1);
  const snapshot = app.hub.snapshot();
  assert.equal(snapshot.revision, before + 1);
  assert.deepEqual(snapshot.routines.items, [routine]);
  const list = await send(app, 'GET', '/api/routines');
  assert.equal(list.status, 200);
  assert.deepEqual(list.json, { routines: [routine] });
  const state = await request(app, 'GET', '/api/state');
  assert.deepEqual(state.json.routines.items.map((r) => r.id), ['daily-drift']);
});

test('update answers 200 with the item, delete answers 200 and empties the snapshot, and runs lists the newest first', async (t) => {
  const { app, routines } = await setup(t, { limits: { routineRunsShown: 2 } });
  await send(app, 'POST', '/api/routines', BODY);
  const updated = await send(app, 'PUT', '/api/routines/daily-drift', { ...BODY, name: 'Evening drift', schedule: '0 18 * * *', active: false });
  assert.equal(updated.status, 200);
  assert.equal(updated.json.routine.name, 'Evening drift');
  assert.deepEqual(updated.json.routine.schedule, { cron: '0 18 * * *', text: 'Every day at 18:00' });
  assert.equal(updated.json.routine.nextAt, null);
  assert.equal(app.hub.snapshot().routines.items[0].active, false);

  for (let i = 1; i <= 3; i += 1) {
    await routines.appendRun('daily-drift', { occurrence: `2026-10-0${i}T23:00:00.000Z`, trigger: 'schedule', outcome: 'busy' });
  }
  const runs = await send(app, 'GET', '/api/routines/daily-drift/runs');
  assert.equal(runs.status, 200);
  assert.deepEqual(runs.json.runs.map((r) => r.occurrence), ['2026-10-03T23:00:00.000Z', '2026-10-02T23:00:00.000Z']);
  assert.equal((await send(app, 'GET', '/api/routines/nobody/runs')).status, 404);

  const removed = await send(app, 'DELETE', '/api/routines/daily-drift');
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.json, { ok: true });
  assert.deepEqual(app.hub.snapshot().routines.items, []);
  assert.equal((await send(app, 'DELETE', '/api/routines/daily-drift')).status, 404);
  assert.equal((await send(app, 'DELETE', '/api/routines/daily-drift')).json.error, 'no_such_routine');
  assert.equal((await send(app, 'PUT', '/api/routines/daily-drift', BODY)).status, 404);
});

test('refusals: shape, schedule with its sentence, the agent, the cap, the path, the method, and the origin', async (t) => {
  const { app } = await setup(t, { limits: { routinesMax: 1 } });
  for (const [body, status, code, extra] of [
    ['nope', 400, 'invalid_json'],
    [[], 400, 'invalid_body'],
    [{ ...BODY, colour: 'red' }, 400, 'invalid_body', { detail: 'unknown field "colour"' }],
    [{ name: 'x' }, 400, 'invalid_body', { detail: 'missing field "agent"' }],
    [{ ...BODY, schedule: { cron: '30 6 * * 1-5' } }, 400, 'invalid_body', { detail: 'schedule must be a string' }],
    [{ ...BODY, name: '' }, 400, 'invalid_body'],
    [{ ...BODY, active: 'yes' }, 400, 'invalid_body'],
    [{ ...BODY, schedule: '0 0 L * *' }, 400, 'invalid_schedule', { sentence: SCHEDULE_SENTENCE }],
    [{ ...BODY, agent: 'nobody' }, 404, 'no_such_agent'],
    [{ ...BODY, agent: 'scribe' }, 400, 'not_an_agent'],
    [{ ...BODY, agent: 'focus' }, 400, 'not_an_agent'],
    [{ ...BODY, agent: 'repo' }, 400, 'not_an_agent'],
    [{ ...BODY, agent: 42 }, 400, 'invalid_body'],
  ]) {
    const response = await send(app, 'POST', '/api/routines', body);
    assert.equal(response.status, status, JSON.stringify(body));
    assert.equal(response.json.error, code, JSON.stringify(body));
    if (extra) assert.deepEqual(response.json, { error: code, ...extra }, JSON.stringify(body));
  }
  assert.equal((await send(app, 'POST', '/api/routines', BODY)).status, 201);
  const full = await send(app, 'POST', '/api/routines', { ...BODY, name: 'Another' });
  assert.equal(full.status, 409);
  assert.equal(full.json.error, 'too_many_routines');
  // Paths and methods.
  assert.equal((await send(app, 'GET', '/api/routines/Daily-Drift')).status, 404);
  assert.equal((await send(app, 'GET', '/api/routines/daily-drift/other')).status, 404);
  assert.equal((await send(app, 'GET', '/api/routines/daily-drift')).status, 405);
  assert.equal((await send(app, 'PATCH', '/api/routines/daily-drift', BODY)).status, 405);
  assert.equal((await send(app, 'PUT', '/api/routines', BODY)).status, 405);
  assert.equal((await send(app, 'GET', '/api/routines/daily-drift/run')).status, 405);
  // Mutations need the exact Origin; DELETE takes no body.
  assert.equal((await request(app, 'DELETE', '/api/routines/daily-drift')).status, 403);
  assert.equal((await request(app, 'POST', '/api/routines', { headers: { origin: 'http://example.com', 'content-type': 'application/json' }, body: JSON.stringify(BODY) })).status, 403);
  assert.equal((await request(app, 'DELETE', '/api/routines/daily-drift', { headers: { origin: app.origin, 'content-length': '1' }, body: 'x' })).status, 413);
  assert.equal((await request(app, 'POST', '/api/routines', { headers: { origin: app.origin, 'content-type': 'text/plain' }, body: '{}' })).status, 415);
  // The body cap.
  const big = await send(app, 'POST', '/api/routines', { ...BODY, instruction: 'x'.repeat(LIMITS.routineBodyBytes) });
  assert.equal(big.status, 413);
  assert.equal(app.hub.snapshot().routines.items.length, 1);
});

test('test run is 503 not_yet without a scheduler and 404 for an unknown routine; everything is 503 once shutting down', async (t) => {
  const { app } = await setup(t);
  await send(app, 'POST', '/api/routines', BODY);
  const run = await send(app, 'POST', '/api/routines/daily-drift/run');
  assert.equal(run.status, 503);
  assert.equal(run.json.error, 'not_yet');
  assert.equal((await send(app, 'POST', '/api/routines/nobody/run')).status, 404);
  app.handler.closeStreams();
  for (const [method, path, body] of [['POST', '/api/routines', BODY], ['PUT', '/api/routines/daily-drift', BODY], ['DELETE', '/api/routines/daily-drift'], ['POST', '/api/routines/daily-drift/run']]) {
    const response = await send(app, method, path, body);
    assert.equal(response.status, 503, path);
    assert.equal(response.json.error, 'shutting_down', path);
  }
  assert.equal((await send(app, 'GET', '/api/routines')).status, 200);
});

test('without a routine store every routine route is 404', async (t) => {
  const app = await startApp(t, { registry: fakeRegistry(AGENTS) });
  assert.equal((await send(app, 'GET', '/api/routines')).status, 404);
  assert.equal((await send(app, 'POST', '/api/routines', BODY)).status, 404);
  assert.deepEqual(app.hub.snapshot().routines, { items: [] });
});
