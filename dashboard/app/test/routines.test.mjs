import assert from 'node:assert/strict';
import { readFile, readdir, stat, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import { LIMITS } from '../lib/config.mjs';
import { ROUTINE_ID, RoutineError, createRoutines, validateFields } from '../lib/routines.mjs';
import { tempDir } from './support/harness.mjs';

const NOW = '2026-10-03T12:00:00.000Z';

const FIELDS = Object.freeze({
  name: 'Daily drift', agent: 'cfo', instruction: 'Compute drift against the policy and say which bands are out.',
  schedule: { cron: '30 6 * * 1-5' }, active: true,
});

async function setup(t, { limits = {}, uuids = ['aaaa1111-0000-0000-0000-000000000000', 'bbbb2222-0000-0000-0000-000000000000'] } = {}) {
  const base = await tempDir(t);
  const dir = path.join(base, 'routines');
  const logs = [];
  let clock = Date.parse(NOW);
  const ids = [...uuids];
  const store = createRoutines({
    dir, limits: { ...LIMITS, ...limits }, log: (entry) => logs.push(entry),
    now: () => new Date(clock), randomUUID: () => ids.shift() ?? 'ffff0000-0000-0000-0000-000000000000',
  });
  const changes = [];
  store.onChange(() => changes.push(store.current().map((r) => r.id)));
  const read = async (id) => JSON.parse(await readFile(path.join(dir, `${id}.json`), 'utf8'));
  const readLog = async (id) => (await readFile(path.join(dir, 'runs', `${id}.jsonl`), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  return { dir, store, logs, changes, read, readLog, tick: (ms) => { clock += ms; } };
}

test('a missing directory loads as no routines, and create writes the file atomically with mode 0600 in key order', async (t) => {
  const { dir, store, read, changes } = await setup(t);
  await store.load();
  assert.deepEqual(store.current(), []);
  const routine = await store.create(FIELDS);
  assert.deepEqual(routine, {
    version: 1, id: 'daily-drift', name: 'Daily drift', agent: 'cfo', instruction: FIELDS.instruction,
    schedule: { cron: '30 6 * * 1-5', text: 'Weekdays at 6:30' }, active: true, created: NOW, updated: NOW,
  });
  assert.ok(Object.isFrozen(routine) && Object.isFrozen(routine.schedule));
  assert.deepEqual(Object.keys(await read('daily-drift')), ['version', 'id', 'name', 'agent', 'instruction', 'schedule', 'active', 'created', 'updated']);
  assert.equal((await stat(path.join(dir, 'daily-drift.json'))).mode & 0o777, 0o600);
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
  assert.deepEqual(await readdir(dir), ['daily-drift.json']);
  assert.deepEqual(changes, [['daily-drift']]);
  assert.deepEqual(store.current().map((r) => r.id), ['daily-drift']);
});

test('the id is a slug of the name, with a suffix on a collision or a name that makes no id', async (t) => {
  const { store } = await setup(t);
  await store.load();
  assert.equal((await store.create({ ...FIELDS, name: '  Morning  review!  ' })).id, 'morning-review');
  assert.equal((await store.create({ ...FIELDS, name: 'Morning review' })).id, 'morning-review-aaaa');
  assert.equal((await store.create({ ...FIELDS, name: '42' })).id, 'r-42');
  assert.equal((await store.create({ ...FIELDS, name: 'A' })).id, 'r-a');
  assert.equal((await store.create({ ...FIELDS, name: '!!!' })).id, 'r-bbbb');
  const long = await store.create({ ...FIELDS, name: 'x'.repeat(60) });
  assert.ok(ROUTINE_ID.test(long.id) && long.id.length <= 48, long.id);
  assert.deepEqual(store.current().map((r) => r.name), ['!!!', '42', 'A', 'Morning review', 'Morning  review!', 'x'.repeat(60)].sort((a, b) => a.localeCompare(b)));
});

test('update keeps the id and created, bumps updated on every save (an Active toggle included), and rewrites the words', async (t) => {
  const { store, read, tick, changes } = await setup(t);
  await store.load();
  await store.create(FIELDS);
  tick(60_000);
  const toggled = await store.update('daily-drift', { active: false });
  assert.equal(toggled.active, false);
  assert.equal(toggled.created, NOW);
  assert.equal(toggled.updated, '2026-10-03T12:01:00.000Z');
  tick(60_000);
  const moved = await store.update('daily-drift', { schedule: { cron: '0 18 * * *', text: 'stale words' }, name: 'Evening drift' });
  assert.deepEqual(moved.schedule, { cron: '0 18 * * *', text: 'Every day at 18:00' });
  assert.equal(moved.id, 'daily-drift');
  assert.equal(moved.updated, '2026-10-03T12:02:00.000Z');
  assert.equal((await read('daily-drift')).name, 'Evening drift');
  assert.equal(changes.length, 3);
  await assert.rejects(store.update('daily-drift', { colour: 'red' }), (error) => error instanceof RoutineError && error.code === 'invalid_body');
  await assert.rejects(store.update('nobody', { active: true }), (error) => error.code === 'no_such_routine');
});

test('remove deletes the file and its runs log, and the id is free again', async (t) => {
  const { dir, store, changes } = await setup(t);
  await store.load();
  await store.create(FIELDS);
  await store.appendRun('daily-drift', { occurrence: NOW, trigger: 'schedule', outcome: 'busy' });
  assert.ok(await stat(path.join(dir, 'runs', 'daily-drift.jsonl')));
  await store.remove('daily-drift');
  assert.deepEqual(store.current(), []);
  await assert.rejects(stat(path.join(dir, 'daily-drift.json')), { code: 'ENOENT' });
  await assert.rejects(stat(path.join(dir, 'runs', 'daily-drift.jsonl')), { code: 'ENOENT' });
  await assert.rejects(store.remove('daily-drift'), (error) => error.code === 'no_such_routine');
  assert.equal((await store.create(FIELDS)).id, 'daily-drift');
  assert.deepEqual(store.runs('daily-drift'), []);
  assert.equal(changes.length, 3);
});

test('load reads every routine and its log, skips and logs a bad file without deleting it, and ignores other files', async (t) => {
  const { dir, store, logs } = await setup(t);
  await mkdir(path.join(dir, 'runs'), { recursive: true });
  const good = {
    version: 1, id: 'daily-drift', name: 'Daily drift', agent: 'cfo', instruction: 'Do the thing.',
    schedule: { cron: 'mon-fri 6', text: 'Weekdays at 6:30' }, active: true, created: NOW, updated: NOW,
  };
  await writeFile(path.join(dir, 'daily-drift.json'), JSON.stringify({ ...good, schedule: { cron: '30 6 * * mon-fri', text: 'Weekdays at 6:30' } }));
  await writeFile(path.join(dir, 'runs', 'daily-drift.jsonl'), [
    JSON.stringify({ run: 'r1', occurrence: '2026-10-02T11:30:00.000Z', trigger: 'schedule', startedAt: '2026-10-02T11:30:04.000Z' }),
    JSON.stringify({ run: 'r1', endedAt: '2026-10-02T11:31:00.000Z', outcome: 'finished' }),
    'not json',
    '',
  ].join('\n'));
  await writeFile(path.join(dir, 'bad-cron.json'), JSON.stringify({ ...good, id: 'bad-cron', schedule: { cron: '0 0 L * *', text: 'x' } }));
  await writeFile(path.join(dir, 'wrong-id.json'), JSON.stringify({ ...good, id: 'other', schedule: { cron: '0 9 * * *', text: 'x' } }));
  await writeFile(path.join(dir, 'extra-key.json'), JSON.stringify({ ...good, id: 'extra-key', schedule: { cron: '0 9 * * *', text: 'x' }, colour: 'red' }));
  await writeFile(path.join(dir, 'broken.json'), '{');
  await writeFile(path.join(dir, 'Notes.json'), JSON.stringify(good));
  await writeFile(path.join(dir, 'README.md'), 'not a routine');
  await store.load();
  assert.deepEqual(store.current().map((r) => r.id), ['daily-drift']);
  // The stored cron is normalized on load; the stored words are kept.
  assert.deepEqual(store.current()[0].schedule, { cron: '30 6 * * 1-5', text: 'Weekdays at 6:30' });
  assert.deepEqual(store.runs('daily-drift'), [{ run: 'r1', occurrence: '2026-10-02T11:30:00.000Z', trigger: 'schedule', startedAt: '2026-10-02T11:30:04.000Z', endedAt: '2026-10-02T11:31:00.000Z', outcome: 'finished' }]);
  assert.deepEqual(logs.map((l) => [l.event, path.basename(l.file), l.reason]).sort(), [
    ['routine_invalid', 'bad-cron.json', '0 0 L * *'],
    ['routine_invalid', 'broken.json', 'bad_json'],
    ['routine_invalid', 'extra-key.json', 'unknown_key:colour'],
    ['routine_invalid', 'wrong-id.json', 'id_mismatch'],
  ]);
  assert.deepEqual(await readdir(dir).then((names) => names.sort()), ['Notes.json', 'README.md', 'bad-cron.json', 'broken.json', 'daily-drift.json', 'extra-key.json', 'runs', 'wrong-id.json']);
});

test('run lines append with mode 0600, fold into runs newest first, and the log keeps only the newest lines', async (t) => {
  const { dir, store, readLog } = await setup(t, { limits: { routineRunLines: 5 } });
  await store.load();
  await store.create(FIELDS);
  await store.appendRun('daily-drift', { run: 'r1', occurrence: '2026-10-01T11:30:00.000Z', trigger: 'schedule', startedAt: '2026-10-01T11:30:04.000Z' });
  await store.appendRun('daily-drift', { run: 'r1', endedAt: '2026-10-01T11:31:00.000Z', outcome: 'finished' });
  assert.equal((await stat(path.join(dir, 'runs', 'daily-drift.jsonl'))).mode & 0o777, 0o600);
  assert.equal((await stat(path.join(dir, 'runs'))).mode & 0o777, 0o700);
  await store.appendRun('daily-drift', { occurrence: '2026-10-02T11:30:00.000Z', trigger: 'schedule', outcome: 'busy' });
  await store.appendRun('daily-drift', { outcome: 'missed', count: 2, from: '2026-10-05T11:30:00.000Z', to: '2026-10-06T11:30:00.000Z' });
  await store.appendRun('daily-drift', { run: 'r2', occurrence: '2026-10-07T11:30:00.000Z', trigger: 'catchup', startedAt: '2026-10-07T11:30:04.000Z' });
  assert.deepEqual(store.runs('daily-drift'), [
    { run: 'r2', occurrence: '2026-10-07T11:30:00.000Z', trigger: 'catchup', startedAt: '2026-10-07T11:30:04.000Z' },
    { outcome: 'missed', count: 2, from: '2026-10-05T11:30:00.000Z', to: '2026-10-06T11:30:00.000Z' },
    { occurrence: '2026-10-02T11:30:00.000Z', trigger: 'schedule', outcome: 'busy' },
    { run: 'r1', occurrence: '2026-10-01T11:30:00.000Z', trigger: 'schedule', startedAt: '2026-10-01T11:30:04.000Z', endedAt: '2026-10-01T11:31:00.000Z', outcome: 'finished' },
  ]);
  assert.deepEqual(store.runs('daily-drift', 2).map((r) => r.run ?? r.outcome), ['r2', 'missed']);
  assert.deepEqual(store.lastRun('daily-drift'), { run: 'r2', occurrence: '2026-10-07T11:30:00.000Z', trigger: 'catchup', startedAt: '2026-10-07T11:30:04.000Z' });
  assert.equal(store.marker('daily-drift'), '2026-10-07T11:30:00.000Z');
  assert.deepEqual(store.openRuns(), [{ id: 'daily-drift', run: 'r2', occurrence: '2026-10-07T11:30:00.000Z', trigger: 'catchup', startedAt: '2026-10-07T11:30:04.000Z' }]);
  assert.equal((await readLog('daily-drift')).length, 5);
  // A sixth line passes the cap: the oldest line (r1's start) goes, and r1 reads as an end without a start.
  await store.appendRun('daily-drift', { run: 'r2', endedAt: '2026-10-07T11:32:00.000Z', outcome: 'waiting', cards: [{ agent: 'cfo', kind: 'approval', toolName: 'Bash', summary: 'ls', resolved: 'expired' }] });
  const kept = await readLog('daily-drift');
  assert.equal(kept.length, 5);
  assert.deepEqual(kept[0], { run: 'r1', endedAt: '2026-10-01T11:31:00.000Z', outcome: 'finished' });
  assert.deepEqual(store.runs('daily-drift').at(-1), { run: 'r1', endedAt: '2026-10-01T11:31:00.000Z', outcome: 'finished' });
  assert.equal(store.lastRun('daily-drift').outcome, 'waiting');
  assert.deepEqual(store.openRuns(), []);
  // The runs answered are copies.
  store.runs('daily-drift')[0].outcome = 'tampered';
  assert.equal(store.lastRun('daily-drift').outcome, 'waiting');
  await assert.rejects(store.appendRun('nobody', { outcome: 'busy' }), (error) => error.code === 'no_such_routine');
  await assert.rejects(store.appendRun('daily-drift', 'a line'), (error) => error.code === 'invalid_body');
  assert.throws(() => store.runs('nobody'), (error) => error.code === 'no_such_routine');
});

test('marker skips lines without an occurrence and a test run never moves it', async (t) => {
  const { store } = await setup(t);
  await store.load();
  await store.create(FIELDS);
  assert.equal(store.marker('daily-drift'), null);
  await store.appendRun('daily-drift', { run: 't1', occurrence: null, trigger: 'test', startedAt: NOW });
  await store.appendRun('daily-drift', { outcome: 'missed', count: 1, from: '2026-10-01T11:30:00.000Z', to: '2026-10-01T11:30:00.000Z' });
  assert.equal(store.marker('daily-drift'), null);
  await store.appendRun('daily-drift', { occurrence: '2026-10-02T11:30:00.000Z', trigger: 'schedule', outcome: 'busy' });
  await store.appendRun('daily-drift', { occurrence: '2026-10-01T11:30:00.000Z', trigger: 'schedule', outcome: 'busy' });
  assert.equal(store.marker('daily-drift'), '2026-10-02T11:30:00.000Z');
});

test('validation refuses each bad field with its code and detail, and create refuses past the cap', async (t) => {
  const { store } = await setup(t, { limits: { routinesMax: 2, routineNameChars: 12, routineInstructionChars: 70 } });
  await store.load();
  const cases = [
    [{ ...FIELDS, name: '' }, 'invalid_body', /name must be 1 to 12/],
    [{ ...FIELDS, name: 'x'.repeat(13) }, 'invalid_body', /name must be 1 to 12/],
    [{ ...FIELDS, name: 42 }, 'invalid_body', /name/],
    [{ ...FIELDS, agent: 'CFO' }, 'invalid_body', /agent must be an agent id/],
    [{ ...FIELDS, instruction: '   ' }, 'invalid_body', /instruction must be 1 to 70/],
    [{ ...FIELDS, instruction: 'x'.repeat(71) }, 'invalid_body', /instruction must be 1 to 70/],
    [{ ...FIELDS, schedule: '30 6 * * 1-5' }, 'invalid_body', /schedule must be \{ cron \}/],
    [{ ...FIELDS, schedule: { cron: '30 6 * * 1-5', zone: 'UTC' } }, 'invalid_body', /schedule\.zone/],
    [{ ...FIELDS, schedule: { cron: '0 0 L * *' } }, 'invalid_schedule', /L/],
    [{ ...FIELDS, active: 'yes' }, 'invalid_body', /active must be true or false/],
    [{ ...FIELDS, colour: 'red' }, 'invalid_body', /unknown field "colour"/],
    [{ name: 'x', agent: 'cfo' }, 'invalid_body', /missing field "instruction"/],
    ['nope', 'invalid_body', null],
  ];
  for (const [fields, code, detail] of cases) {
    await assert.rejects(store.create(fields), (error) => {
      assert.ok(error instanceof RoutineError, JSON.stringify(fields));
      assert.equal(error.code, code, JSON.stringify(fields));
      if (detail) assert.match(error.detail, detail, JSON.stringify(fields));
      return true;
    });
  }
  assert.deepEqual(validateFields({ ...FIELDS, name: ' Short ', instruction: ' ok ' }, { ...LIMITS, routineNameChars: 12 }), {
    name: 'Short', agent: 'cfo', instruction: 'ok', schedule: { cron: '30 6 * * 1-5', text: 'Weekdays at 6:30' }, active: true,
  });
  await store.create({ ...FIELDS, name: 'One', instruction: 'short' });
  await store.create({ ...FIELDS, name: 'Two', instruction: 'short' });
  await assert.rejects(store.create({ ...FIELDS, name: 'Three', instruction: 'short' }), (error) => error.code === 'too_many_routines');
  assert.deepEqual(store.current().map((r) => r.id), ['one', 'two']);
});
