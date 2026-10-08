import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { test } from 'node:test';

import {
  LAYOUT_VERSION, RootError, claimLock, layoutPaths, migrateFromRepo, prepareRoot, readLayout, seedDefaults, upgradeV1, writeLayout,
} from '../lib/root.mjs';
import { tempDir } from './support/harness.mjs';

// Every source in the pairs table, relative to the fixture checkout, with
// distinct bytes, a mode, and where it lands under the root once the move
// and the version 2 upgrade are done.
const FIXTURE = [
  ['dashboard/app/var/settings.json', '{"settings":1}\n', 0o600, 'settings.json'],
  ['dashboard/app/var/thread-reads.json', '{"reads":1}\n', 0o600, 'thread-reads.json'],
  ['registry/agents.json', '{"agents":[]}\n', 0o644, 'registry/agents.json'],
  ['routines/r1.json', '{"id":"r1"}\n', 0o644, 'routines/r1.json'],
  ['routines/runs/r1.jsonl', '{"run":1}\n', 0o600, 'routines/runs/r1.jsonl'],
  ['dashboard/app/var/threads/assistant.json', '{"pointer":1}\n', 0o600, 'threads/assistant.json'],
  ['dashboard/app/var/threads/assistant.jsonl', '{"m":1}\n', 0o600, 'threads/assistant.jsonl'],
  ['dashboard/app/var/threads/brief-notices.json', '{}\n', 0o600, 'threads/brief-notices.json'],
  ['dashboard/app/var/codex/bindings.json', '[]\n', 0o600, 'codex/bindings.json'],
  ['dashboard/app/var/codex/waiting/w1', 'w\n', 0o600, 'codex/waiting/w1'],
  ['notifications/notifications.jsonl', '{"n":1}\n', 0o644, 'notifications/notifications.jsonl'],
  ['feed/items/2026-10-01-watch.json', '{"producer":"watch"}\n', 0o644, 'feeds/news/items/2026-10-01-watch.json'],
  ['daily-brief/watch/relevance.md', 'Feed criteria.\n', 0o644, 'feeds/news/note.md'],
  ['ideas/items/2026-10-01-myos.json', '{"producer":"myos"}\n', 0o644, 'ideas/items/2026-10-01-myos.json'],
  ['ideas/marks.json', '{"marks":{}}\n', 0o644, 'ideas/marks.json'],
  ['ideas/criteria.md', 'Ideas criteria.\n', 0o644, 'ideas/criteria.md'],
  ['daily-brief/briefs/viewer-2026-10-01.html', '<p>viewer</p>\n', 0o644, 'briefs/viewer-2026-10-01.html'],
  ['daily-brief/briefs/brief-2026-10-01.json', '{"brief":1}\n', 0o644, 'briefs/brief-2026-10-01.json'],
  ['daily-brief/briefs/notice-2026-10-01.json', '{"notice":1}\n', 0o644, 'briefs/notice-2026-10-01.json'],
  ['daily-brief/briefs/memo-2026-10-01.md', 'Memo.\n', 0o644, 'briefs/memo-2026-10-01.md'],
  ['daily-brief/briefs/2026-10-01.md', 'Brief.\n', 0o644, 'briefs/2026-10-01.md'],
  ['daily-brief/briefs/feedback-2026-10-01.md', 'Feedback.\n', 0o644, 'briefs/feedback-2026-10-01.md'],
  ['daily-brief/briefs/feedback-2026-10-01.json', '{"feedback":1}\n', 0o644, 'briefs/feedback-2026-10-01.json'],
  ['daily-brief/briefs/.run.lock', '{"pid":1}\n', 0o644, 'briefs/.run.lock'],
  ['daily-brief/contributions/2026-10-01/cfo.yaml', 'cfo: 1\n', 0o644, 'briefs/contributions/2026-10-01/cfo.yaml'],
  ['daily-brief/watch/packets/p1.json', '{"packet":1}\n', 0o644, 'feeds/.run/packets/p1.json'],
  ['daily-brief/watch/overflow/o1.json', '{"overflow":1}\n', 0o644, 'feeds/.run/overflow/o1.json'],
  ['daily-brief/watch/seen.jsonl', '{"seen":1}\n', 0o644, 'feeds/.run/seen.jsonl'],
  ['daily-brief/watch/state.json', '{"state":1}\n', 0o644, 'feeds/.run/state.json'],
  ['dashboard/app/var/log/dashboard.log', 'log line\n', 0o644, 'log/checkout/dashboard.log'],
  ['dashboard/app/var/launchd/backup-1.plist', '<plist/>\n', 0o644, 'cache/launchd/checkout/backup-1.plist'],
  ['dashboard/app/var/ops/state.json', '{"ops":1}\n', 0o600, 'cache/ops/state.json'],
];

// Code and an unrelated file that live in the briefs directory.
const BRIEFS_CODE = [
  ['daily-brief/briefs/build.py', 'print("build")\n'],
  ['daily-brief/briefs/check-viewer.mjs', '// check\n'],
  ['daily-brief/briefs/__pycache__/x.pyc', 'pyc\n'],
];
const BRIEFS_OTHER = ['daily-brief/briefs/notes.txt', 'Unrelated.\n'];

// Where each source is renamed to once it moved.
const MIGRATED = [
  'dashboard/app/var/settings.json.migrated',
  'dashboard/app/var/thread-reads.json.migrated',
  'registry/agents.json.migrated',
  'routines.migrated',
  'dashboard/app/var/threads.migrated',
  'dashboard/app/var/codex.migrated',
  'notifications.migrated',
  'feed/items.migrated',
  'daily-brief/watch/relevance.md.migrated',
  'ideas/items.migrated',
  'ideas/marks.json.migrated',
  'ideas/criteria.md.migrated',
  'daily-brief/contributions.migrated',
  'daily-brief/watch/packets.migrated',
  'daily-brief/watch/overflow.migrated',
  'daily-brief/watch/seen.jsonl.migrated',
  'daily-brief/watch/state.json.migrated',
  'dashboard/app/var/log.migrated',
  'dashboard/app/var/launchd.migrated',
  'dashboard/app/var/ops.migrated',
];

const UPGRADE_KEYS = ['feedDir', 'feedInstructions', 'watchDir/packets', 'watchDir/overflow', 'watchDir/seen.jsonl', 'watchDir/state.json'];

const ALL_KEYS = [
  'settings', 'threadReads', 'registry', 'routinesDir', 'threadsDir', 'codexDir', 'notificationsDir', 'feedDir',
  'feedInstructions', 'ideasDir', 'ideasMarks', 'ideasInstructions', 'briefsDir', 'contributionsDir',
  'watchDir/packets', 'watchDir/overflow', 'watchDir/seen.jsonl', 'watchDir/state.json',
  'logDir', 'cacheDir/launchd', 'cacheDir/ops',
];

async function put(file, body, mode = 0o644) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, body);
  await chmod(file, mode);
}

async function fixtureRepo(dir) {
  const repo = path.join(dir, 'repo');
  await mkdir(repo, { recursive: true });
  for (const [rel, body, mode] of FIXTURE) await put(path.join(repo, rel), body, mode);
  for (const [rel, body] of BRIEFS_CODE) await put(path.join(repo, rel), body);
  await put(path.join(repo, BRIEFS_OTHER[0]), BRIEFS_OTHER[1]);
  return repo;
}

async function fixtureDefaults(dir) {
  const defaultsDir = path.join(dir, 'defaults');
  await put(path.join(defaultsDir, 'ideas-criteria.md'), 'Default ideas criteria.\n');
  const readmeFile = path.join(dir, 'root-README.md');
  await put(readmeFile, '# The data root\n');
  return { defaultsDir, readmeFile };
}

// A temporary directory with a short path, under /tmp where it exists.
async function shortTempDir(t) {
  let dir;
  try {
    dir = await mkdtemp('/tmp/pa-root-');
  } catch {
    return tempDir(t);
  }
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const sha = async (file) => createHash('sha256').update(await readFile(file)).digest('hex');
const modeOf = async (file) => (await lstat(file)).mode & 0o777;

test('layoutPaths answers the frozen v2 table under the root', () => {
  const paths = layoutPaths('/data/root');
  assert.equal(LAYOUT_VERSION, 2);
  assert.ok(Object.isFrozen(paths));
  assert.equal(paths.readme, '/data/root/README.md');
  assert.equal(paths.layout, '/data/root/layout.json');
  assert.equal(paths.lock, '/data/root/daemon.lock');
  assert.equal(paths.registry, '/data/root/registry/agents.json');
  assert.equal(paths.feedsDir, '/data/root/feeds');
  assert.equal(paths.sourcesDir, '/data/root/sources');
  assert.equal(paths.feedsRunDir, '/data/root/feeds/.run');
  for (const retired of ['feedDir', 'feedInstructions', 'watchDir']) assert.ok(!(retired in paths), retired);
  assert.equal(paths.contributionsDir, '/data/root/briefs/contributions');
  assert.equal(paths.cacheDir, '/data/root/cache');
  assert.equal(paths.briefReads, '/data/root/brief-reads.json');
  assert.equal(Object.keys(paths).length, 21);
  for (const value of Object.values(paths)) assert.ok(value.startsWith('/data/root/'));
});

test('prepareRoot moves every source of a full checkout into an empty root', async (t) => {
  const dir = await tempDir(t);
  const repo = await fixtureRepo(dir);
  const { defaultsDir, readmeFile } = await fixtureDefaults(dir);
  const root = path.join(dir, 'root');
  const logs = [];
  const result = await prepareRoot(root, { migrateFrom: repo, defaultsDir, readmeFile, log: (entry) => logs.push(entry) });

  assert.equal(result.created, true);
  assert.deepEqual(result.moved, ALL_KEYS);
  assert.deepEqual(result.skipped, []);
  assert.deepEqual(result.upgraded, UPGRADE_KEYS);
  // The criteria files came from the checkout, so only the README is seeded.
  assert.deepEqual(result.seeded, ['readme']);

  for (const [, body, mode, target] of FIXTURE) {
    const file = path.join(root, target);
    assert.equal(await readFile(file, 'utf8'), body, target);
    assert.equal(await modeOf(file), mode, target);
  }
  for (const rel of MIGRATED) assert.ok(existsSync(path.join(repo, rel)), rel);
  for (const [rel] of FIXTURE) {
    if (!rel.startsWith('daily-brief/briefs/')) assert.ok(!existsSync(path.join(repo, rel)), rel);
  }
  for (const [rel, body] of BRIEFS_CODE) assert.equal(await readFile(path.join(repo, rel), 'utf8'), body);
  const briefsLeft = (await readdir(path.join(repo, 'daily-brief/briefs'))).sort();
  assert.deepEqual(briefsLeft, ['__pycache__', 'build.py', 'check-viewer.mjs']);
  const aside = path.join(repo, 'daily-brief/briefs.migrated');
  assert.equal(await readFile(path.join(aside, 'notes.txt'), 'utf8'), BRIEFS_OTHER[1]);
  assert.ok(existsSync(path.join(aside, 'brief-2026-10-01.json')));
  assert.ok(!existsSync(path.join(root, 'briefs/notes.txt')));

  // The move landed on the version 1 paths, which the upgrade renamed.
  assert.ok((await lstat(path.join(root, 'feed.migrated/items/2026-10-01-watch.json'))).isFile());
  assert.ok((await lstat(path.join(root, 'watch.migrated/seen.jsonl'))).isFile());
  assert.equal(JSON.parse(await readFile(path.join(root, 'feeds/news/feed.json'), 'utf8')).producer, 'scout');

  const layout = await readLayout(root);
  assert.equal(layout.version, 2);
  assert.equal(layout.migratedFrom, repo);
  assert.ok(!Number.isNaN(Date.parse(layout.createdAt)));
  assert.equal(await modeOf(path.join(root, 'layout.json')), 0o600);
  assert.equal(await modeOf(root), 0o700);
  assert.equal(await readFile(path.join(root, 'README.md'), 'utf8'), '# The data root\n');

  const moved = logs.filter((entry) => entry.event === 'migration_moved');
  assert.equal(moved.length, ALL_KEYS.length);
  assert.deepEqual(moved.find((entry) => entry.key === 'routinesDir'),
    { event: 'migration_moved', key: 'routinesDir', source: path.join(repo, 'routines'), target: path.join(root, 'routines'), files: 2 });
  assert.deepEqual(logs.find((entry) => entry.event === 'migration_done'), { event: 'migration_done', moved: ALL_KEYS.length, skipped: 0 });

  // A second start finds the layout and moves nothing.
  const again = await prepareRoot(root, { migrateFrom: repo, defaultsDir, readmeFile, log: () => {} });
  assert.deepEqual(again, { created: false, moved: [], skipped: [], upgraded: [], seeded: [] });
});

test('layout.json is written last, so a run cut off before the renames reruns to the same result', async (t) => {
  const dir = await tempDir(t);
  const repo = await fixtureRepo(dir);
  const { defaultsDir, readmeFile } = await fixtureDefaults(dir);
  const root = path.join(dir, 'root');
  const failing = async (from, to) => {
    if (to.includes('.migrated')) throw Object.assign(new Error('injected'), { code: 'EIO' });
    return rename(from, to);
  };
  await assert.rejects(prepareRoot(root, { migrateFrom: repo, defaultsDir, readmeFile, log: () => {}, rename: failing }), /injected/);
  assert.ok(!existsSync(path.join(root, 'layout.json')));
  // The copies are in place and no source was renamed.
  assert.equal(await readFile(path.join(root, 'feed/items/2026-10-01-watch.json'), 'utf8'), '{"producer":"watch"}\n');
  assert.ok(existsSync(path.join(repo, 'routines/r1.json')));

  const result = await prepareRoot(root, { migrateFrom: repo, defaultsDir, readmeFile, log: () => {} });
  assert.equal(result.created, true);
  assert.deepEqual(result.moved, ALL_KEYS);
  for (const rel of MIGRATED) assert.ok(existsSync(path.join(repo, rel)), rel);
  assert.equal((await readLayout(root)).migratedFrom, repo);
});

for (const [name, setup] of [
  ['an empty migrateFrom', async () => ''],
  ['an empty checkout', async (dir) => { const repo = path.join(dir, 'empty'); await mkdir(repo); return repo; }],
]) {
  test(`prepareRoot with ${name} creates the layout and seeds the defaults`, async (t) => {
    const dir = await tempDir(t);
    const { defaultsDir, readmeFile } = await fixtureDefaults(dir);
    const root = path.join(dir, 'root');
    const migrateFrom = await setup(dir);
    const logs = [];
    const result = await prepareRoot(root, { migrateFrom, defaultsDir, readmeFile, log: (entry) => logs.push(entry) });
    assert.equal(result.created, true);
    assert.deepEqual(result.moved, []);
    assert.deepEqual(result.seeded, ['readme', 'ideasInstructions']);
    assert.deepEqual(result.upgraded, []);
    assert.deepEqual(logs.find((entry) => entry.event === 'root_seeded'), { event: 'root_seeded', keys: result.seeded });
    const paths = layoutPaths(root);
    for (const key of ['routinesDir', 'threadsDir', 'codexDir', 'notificationsDir', 'feedsDir', 'sourcesDir', 'feedsRunDir',
      'ideasDir', 'briefsDir', 'contributionsDir', 'logDir', 'cacheDir']) {
      assert.ok((await lstat(paths[key])).isDirectory(), key);
      assert.equal(await modeOf(paths[key]), 0o700, key);
    }
    assert.equal(await readFile(paths.ideasInstructions, 'utf8'), 'Default ideas criteria.\n');
    assert.equal(await modeOf(paths.ideasInstructions), 0o600);
    // A fresh root has no feed until one is made.
    assert.deepEqual(await readdir(paths.feedsDir), ['.run']);
    assert.ok(!existsSync(path.join(root, 'feed')));
    assert.equal(await readFile(paths.readme, 'utf8'), '# The data root\n');
    const layout = JSON.parse(await readFile(paths.layout, 'utf8'));
    assert.equal(layout.version, 2);
    assert.ok(!('migratedFrom' in layout));
  });
}

test('a root at version 2 only seeds what is missing and rewrites the README when it differs', async (t) => {
  const dir = await tempDir(t);
  const repo = await fixtureRepo(dir);
  const { defaultsDir, readmeFile } = await fixtureDefaults(dir);
  const root = path.join(dir, 'root');
  await prepareRoot(root, { migrateFrom: '', defaultsDir, readmeFile, log: () => {} });
  const paths = layoutPaths(root);
  await unlink(paths.ideasInstructions);

  const result = await prepareRoot(root, { migrateFrom: repo, defaultsDir, readmeFile, log: () => {} });
  assert.deepEqual(result, { created: false, moved: [], skipped: [], upgraded: [], seeded: ['ideasInstructions'] });
  assert.equal(await readFile(paths.ideasInstructions, 'utf8'), 'Default ideas criteria.\n');
  await writeFile(paths.ideasInstructions, 'Edited ideas criteria.\n');
  await prepareRoot(root, { migrateFrom: '', defaultsDir, readmeFile, log: () => {} });
  assert.equal(await readFile(paths.ideasInstructions, 'utf8'), 'Edited ideas criteria.\n');
  assert.ok(existsSync(path.join(repo, 'routines/r1.json')), 'the checkout is not touched once a layout exists');

  await writeFile(readmeFile, '# The data root, revised\n');
  const revised = await prepareRoot(root, { migrateFrom: '', defaultsDir, readmeFile, log: () => {} });
  assert.deepEqual(revised.seeded, ['readme']);
  assert.equal(await readFile(paths.readme, 'utf8'), '# The data root, revised\n');
});

test('seedDefaults skips a default file that is not there', async (t) => {
  const dir = await tempDir(t);
  const root = path.join(dir, 'root');
  const seeded = await seedDefaults(root, { defaultsDir: path.join(dir, 'nowhere'), readmeFile: path.join(dir, 'none.md'), log: () => {} });
  assert.deepEqual(seeded, []);
  assert.ok(!existsSync(layoutPaths(root).ideasInstructions));
  assert.ok(existsSync(layoutPaths(root).feedsDir));
});

test('readLayout refuses a newer or an invalid layout', async (t) => {
  const dir = await tempDir(t);
  const root = path.join(dir, 'root');
  assert.equal(await readLayout(root), null);
  await mkdir(root);
  await writeFile(path.join(root, 'layout.json'), JSON.stringify({ version: 3, createdAt: '2026-10-01T00:00:00.000Z' }));
  await assert.rejects(readLayout(root), (error) => error instanceof RootError && error.code === 'layout_newer'
    && error.details.version === 3 && error.message.includes(root));
  await assert.rejects(prepareRoot(root, { migrateFrom: '', log: () => {} }), { code: 'layout_newer' });
  for (const body of ['{"version": "one"}', '{ not json', '{"version": 0}', '[]']) {
    await writeFile(path.join(root, 'layout.json'), body);
    await assert.rejects(readLayout(root), { code: 'layout_invalid' }, body);
  }
  await writeLayout(root, { version: 1, createdAt: '2026-10-01T00:00:00.000Z', migratedFrom: '/repo' });
  assert.deepEqual(await readLayout(root), { version: 1, createdAt: '2026-10-01T00:00:00.000Z', migratedFrom: '/repo' });
});

test('a target already holding the same bytes counts as moved', async (t) => {
  const dir = await tempDir(t);
  const repo = await fixtureRepo(dir);
  const root = path.join(dir, 'root');
  await put(path.join(root, 'feed/items/2026-10-01-watch.json'), '{"producer":"watch"}\n');
  const result = await migrateFromRepo(root, { migrateFrom: repo, log: () => {} });
  assert.ok(result.moved.includes('feedDir'));
  assert.ok(existsSync(path.join(repo, 'feed/items.migrated')));
});

test('a socket in a source directory is left with the source and does not stop the move', async (t) => {
  // A socket path is capped at 104 bytes on macOS, which the default
  // temporary directory leaves too little room for; /tmp when it is there.
  const dir = await shortTempDir(t);
  const repo = await fixtureRepo(dir);
  const root = path.join(dir, 'root');
  const socket = path.join(repo, 'dashboard/app/var/codex/app.sock');
  const server = createServer();
  await new Promise((resolve) => server.listen(socket, resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const result = await migrateFromRepo(root, { migrateFrom: repo, log: () => {} });
  assert.deepEqual(result.moved, ALL_KEYS);
  assert.equal(await readFile(path.join(root, 'codex/bindings.json'), 'utf8'), '[]\n');
  assert.ok(!existsSync(path.join(root, 'codex/app.sock')));
  assert.ok((await lstat(path.join(repo, 'dashboard/app/var/codex.migrated/app.sock'))).isSocket());
});

test('a target with different bytes is a conflict that renames nothing and writes no layout', async (t) => {
  const dir = await tempDir(t);
  const repo = await fixtureRepo(dir);
  const { defaultsDir, readmeFile } = await fixtureDefaults(dir);
  const root = path.join(dir, 'root');
  const target = path.join(root, 'feed/items/2026-10-01-watch.json');
  await put(target, '{"producer":"other"}\n');
  const before = await sha(path.join(repo, 'feed/items/2026-10-01-watch.json'));

  await assert.rejects(prepareRoot(root, { migrateFrom: repo, defaultsDir, readmeFile, log: () => {} }), (error) => {
    assert.ok(error instanceof RootError);
    assert.equal(error.code, 'migration_conflict');
    assert.deepEqual(error.details.pairs, [{
      source: path.join(repo, 'feed/items'), target: path.join(root, 'feed/items'), file: '2026-10-01-watch.json',
    }]);
    assert.ok(error.message.includes(target));
    assert.ok(error.message.includes(path.join(repo, 'feed/items/2026-10-01-watch.json')));
    return true;
  });
  assert.ok(!existsSync(path.join(root, 'layout.json')));
  assert.equal(await readFile(target, 'utf8'), '{"producer":"other"}\n');
  assert.equal(await sha(path.join(repo, 'feed/items/2026-10-01-watch.json')), before);
  for (const rel of MIGRATED) assert.ok(!existsSync(path.join(repo, rel)), rel);
  assert.ok(!existsSync(path.join(repo, 'daily-brief/briefs.migrated')));
  assert.ok(existsSync(path.join(repo, 'dashboard/app/var/settings.json')), 'pairs earlier in the order stay');
});

test('a file missing on one side of an existing target is a conflict', async (t) => {
  const dir = await tempDir(t);
  const repo = await fixtureRepo(dir);
  const root = path.join(dir, 'root');
  await put(path.join(root, 'routines/r1.json'), '{"id":"r1"}\n');
  await assert.rejects(migrateFromRepo(root, { migrateFrom: repo, log: () => {} }), (error) => {
    assert.equal(error.code, 'migration_conflict');
    assert.deepEqual(error.details.pairs.map((pair) => pair.file), ['runs/r1.jsonl']);
    return true;
  });
  assert.ok(existsSync(path.join(repo, 'routines/runs/r1.jsonl')));
});

// A version 1 root holding every path the upgrade moves, the retired
// agent in the registry and the read times, its thread files, and an
// agent that accepts messages from it. All invented.
const V1_ROOT = [
  ['feed/items/2026-10-01-watch.json', '{"producer":"watch","n":1}\n', 0o600, 'feeds/news/items/2026-10-01-watch.json'],
  ['feed/items/2026-10-02-watch.json', '{"producer":"watch","n":2}\n', 0o644, 'feeds/news/items/2026-10-02-watch.json'],
  ['feed/relevance.md', 'Invented criteria.\n', 0o600, 'feeds/news/note.md'],
  ['watch/packets/2026-10-02.yaml', 'packet: 1\n', 0o600, 'feeds/.run/packets/2026-10-02.yaml'],
  ['watch/overflow/2026-10-02.json', '{"overflow":1}\n', 0o600, 'feeds/.run/overflow/2026-10-02.json'],
  ['watch/seen.jsonl', '{"seen":1}\n', 0o600, 'feeds/.run/seen.jsonl'],
  ['watch/state.json', '{"reported":[]}\n', 0o600, 'feeds/.run/state.json'],
];

const v1Registry = {
  version: 1,
  groups: [{ id: 'personal', name: 'Personal' }],
  agents: [
    { id: 'assistant', name: 'Assistant', role: 'Assistant', description: 'Invented.', group: 'personal', kind: 'persona', cwd: '/invented', provider: 'claude', accepts: ['watch', 'myos'], pinned: true },
    { id: 'watch', name: 'Watch', role: 'Newsletters', description: 'Invented.', group: 'personal', kind: 'persona', cwd: '/invented', provider: 'claude', jobs: ['com.personal-assistant.watch'] },
    { id: 'myos', name: 'Myos', role: 'Guide', description: 'Invented.', group: 'personal', kind: 'persona', cwd: '/invented', provider: 'claude', builtin: true },
  ],
};

async function fixtureV1Root(dir) {
  const root = path.join(dir, 'root');
  for (const [rel, body, mode] of V1_ROOT) await put(path.join(root, rel), body, mode);
  // A file the upgrade does not name goes with its folder.
  await put(path.join(root, 'watch/.run.lock'), '{"pid":1}\n');
  await put(path.join(root, 'registry/agents.json'), `${JSON.stringify(v1Registry, null, 2)}\n`, 0o600);
  await put(path.join(root, 'threads/watch.json'), '{"pointer":"w"}\n', 0o600);
  await put(path.join(root, 'threads/watch.jsonl'), '{"m":"w"}\n', 0o600);
  await put(path.join(root, 'threads/assistant.jsonl'), '{"m":"a"}\n', 0o600);
  await put(path.join(root, 'thread-reads.json'), `${JSON.stringify({ assistant: '2026-10-01T00:00:00.000Z', watch: '2026-10-01T00:00:00.000Z' })}\n`, 0o600);
  await writeLayout(root, { version: 1, createdAt: '2026-10-06T00:00:00.000Z', migratedFrom: '/repo' });
  return root;
}

// Every file under `top` with its bytes, for a before-and-after comparison.
async function snapshot(top) {
  const files = {};
  const visit = async (dir, rel) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(path.join(dir, entry.name), child);
      else files[child] = await readFile(path.join(dir, entry.name), 'utf8');
    }
  };
  await visit(top, '');
  return files;
}

test('a version 1 root upgrades to version 2: the feed, its note, and the run state move, and the retired agent leaves', async (t) => {
  const dir = await tempDir(t);
  const { defaultsDir, readmeFile } = await fixtureDefaults(dir);
  const root = await fixtureV1Root(dir);
  const logs = [];
  const result = await prepareRoot(root, { migrateFrom: '/nowhere', defaultsDir, readmeFile, log: (entry) => logs.push(entry) });

  assert.deepEqual(result, { created: false, moved: [], skipped: [], upgraded: UPGRADE_KEYS, seeded: ['readme', 'ideasInstructions'] });
  for (const [rel, body, mode, target] of V1_ROOT) {
    assert.equal(await readFile(path.join(root, target), 'utf8'), body, target);
    assert.equal(await modeOf(path.join(root, target)), mode, target);
    assert.equal(await readFile(path.join(root, rel.replace(/^(feed|watch)\//, '$1.migrated/')), 'utf8'), body, rel);
  }
  assert.ok(!existsSync(path.join(root, 'feed')));
  assert.ok(!existsSync(path.join(root, 'watch')));
  assert.equal(await readFile(path.join(root, 'watch.migrated/.run.lock'), 'utf8'), '{"pid":1}\n');
  assert.ok(!existsSync(path.join(root, 'feeds/.run/.run.lock')));

  const feed = JSON.parse(await readFile(path.join(root, 'feeds/news/feed.json'), 'utf8'));
  assert.deepEqual(Object.keys(feed), ['version', 'id', 'name', 'producer', 'sources', 'active', 'created', 'updated']);
  assert.deepEqual([feed.version, feed.id, feed.name, feed.producer, feed.sources, feed.active], [1, 'news', 'News', 'scout', [], true]);
  assert.equal(feed.created, feed.updated);
  assert.equal(await modeOf(path.join(root, 'feeds/news/feed.json')), 0o600);

  const registry = JSON.parse(await readFile(path.join(root, 'registry/agents.json'), 'utf8'));
  assert.deepEqual(registry.agents.map((agent) => agent.id), ['assistant', 'myos']);
  assert.deepEqual(registry.agents[0].accepts, ['myos']);
  assert.deepEqual(registry.groups, v1Registry.groups);
  assert.deepEqual(JSON.parse(await readFile(path.join(root, 'registry/agents.json.migrated'), 'utf8')), v1Registry);

  assert.deepEqual((await readdir(path.join(root, 'threads'))).sort(), ['assistant.jsonl', 'watch.json.migrated', 'watch.jsonl.migrated']);
  assert.equal(await readFile(path.join(root, 'threads/watch.jsonl.migrated'), 'utf8'), '{"m":"w"}\n');
  assert.deepEqual(JSON.parse(await readFile(path.join(root, 'thread-reads.json'), 'utf8')), { assistant: '2026-10-01T00:00:00.000Z' });

  assert.deepEqual(await readLayout(root), { version: 2, createdAt: '2026-10-06T00:00:00.000Z', migratedFrom: '/repo' });
  assert.deepEqual(logs.filter((entry) => entry.event === 'upgrade_moved').map((entry) => entry.key), UPGRADE_KEYS);
  assert.deepEqual(logs.find((entry) => entry.event === 'upgrade_moved'), {
    event: 'upgrade_moved', key: 'feedDir', source: path.join(root, 'feed/items'), target: path.join(root, 'feeds/news/items'), files: 2,
  });
  assert.deepEqual(logs.find((entry) => entry.event === 'upgrade_done'),
    { event: 'upgrade_done', from: 1, to: 2, moved: 6, retired: 2, agent: true, reads: true });

  // A second start finds version 2 and changes nothing.
  const before = await snapshot(root);
  const again = await prepareRoot(root, { migrateFrom: '/nowhere', defaultsDir, readmeFile, log: (entry) => logs.push(entry) });
  assert.deepEqual(again, { created: false, moved: [], skipped: [], upgraded: [], seeded: [] });
  assert.deepEqual(await snapshot(root), before);
  assert.equal(logs.filter((entry) => entry.event === 'upgrade_done').length, 1);
});

test('an upgrade target with different bytes is a conflict that names both, renames nothing, and keeps version 1', async (t) => {
  const dir = await tempDir(t);
  const { defaultsDir, readmeFile } = await fixtureDefaults(dir);
  const root = await fixtureV1Root(dir);
  const note = path.join(root, 'feeds/news/note.md');
  await put(note, 'Different criteria.\n');
  const before = await snapshot(root);

  await assert.rejects(prepareRoot(root, { migrateFrom: '', defaultsDir, readmeFile, log: () => {} }), (error) => {
    assert.ok(error instanceof RootError);
    assert.equal(error.code, 'migration_conflict');
    assert.deepEqual(error.details.pairs, [{ source: path.join(root, 'feed/relevance.md'), target: note, file: 'relevance.md' }]);
    assert.ok(error.message.includes(note));
    assert.ok(error.message.includes(path.join(root, 'feed/relevance.md')));
    return true;
  });
  assert.deepEqual(await snapshot(root), before);
  assert.equal((await readLayout(root)).version, 1);
});

test('an upgrade cut off before its renames runs again to the same result', async (t) => {
  const dir = await tempDir(t);
  const { defaultsDir, readmeFile } = await fixtureDefaults(dir);
  const root = await fixtureV1Root(dir);
  const failing = async (from, to) => {
    if (to.includes('.migrated')) throw Object.assign(new Error('injected'), { code: 'EIO' });
    return rename(from, to);
  };
  await assert.rejects(prepareRoot(root, { migrateFrom: '', defaultsDir, readmeFile, log: () => {}, rename: failing }), /injected/);
  assert.equal((await readLayout(root)).version, 1);
  assert.ok(existsSync(path.join(root, 'feed/items')));
  assert.equal(await readFile(path.join(root, 'feeds/news/note.md'), 'utf8'), 'Invented criteria.\n');
  const feed = await readFile(path.join(root, 'feeds/news/feed.json'), 'utf8');

  const result = await prepareRoot(root, { migrateFrom: '', defaultsDir, readmeFile, log: () => {} });
  assert.deepEqual(result.upgraded, UPGRADE_KEYS);
  assert.equal((await readLayout(root)).version, 2);
  assert.ok(existsSync(path.join(root, 'feed.migrated/items/2026-10-01-watch.json')));
  assert.equal(await readFile(path.join(root, 'feeds/news/feed.json'), 'utf8'), feed, 'feed.json is written once');
  assert.deepEqual(JSON.parse(await readFile(path.join(root, 'registry/agents.json'), 'utf8')).agents.map((agent) => agent.id), ['assistant', 'myos']);
});

test('upgradeV1 on a root without the version 1 paths writes nothing and leaves an unreadable registry alone', async (t) => {
  const dir = await tempDir(t);
  const root = path.join(dir, 'root');
  await put(path.join(root, 'registry/agents.json'), '{ not json');
  const logs = [];
  assert.deepEqual(await upgradeV1(root, { log: (entry) => logs.push(entry) }), { moved: [], retired: [] });
  assert.equal(await readFile(path.join(root, 'registry/agents.json'), 'utf8'), '{ not json');
  assert.ok(!existsSync(path.join(root, 'feeds')));
  assert.deepEqual(logs.map((entry) => entry.event), ['upgrade_registry_skipped', 'upgrade_done']);
});

test('claimLock refuses a live holder, takes over a stale one, and releases only its own claim', async (t) => {
  const dir = await tempDir(t);
  const root = path.join(dir, 'root');
  const lock = layoutPaths(root).lock;
  await mkdir(root);

  // A live holder: the parent process.
  await writeFile(lock, JSON.stringify({ pid: process.ppid, startedAt: '2026-10-01T00:00:00.000Z' }));
  await assert.rejects(claimLock(root), (error) => error instanceof RootError && error.code === 'root_locked'
    && error.details.pid === process.ppid && error.message.includes(lock));

  // A stale holder: a process that has exited.
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  await writeFile(lock, JSON.stringify({ pid: dead, startedAt: '2026-10-01T00:00:00.000Z' }));
  const held = await claimLock(root);
  const content = JSON.parse(await readFile(lock, 'utf8'));
  assert.equal(content.pid, process.pid);
  assert.ok(!Number.isNaN(Date.parse(content.startedAt)));
  assert.equal(await modeOf(lock), 0o600);
  await assert.rejects(claimLock(root), { code: 'root_locked' });
  await held.release();
  assert.ok(!existsSync(lock));

  // Two claims racing over a stale lock: one holder.
  await writeFile(lock, JSON.stringify({ pid: dead, startedAt: '2026-10-01T00:00:00.000Z' }));
  const outcomes = await Promise.allSettled([claimLock(root), claimLock(root)]);
  assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
  const lost = outcomes.find((outcome) => outcome.status === 'rejected');
  assert.equal(lost.reason.code, 'root_locked');
  const winner = outcomes.find((outcome) => outcome.status === 'fulfilled').value;

  // Another process re-claimed after a takeover: release leaves its file.
  const other = JSON.stringify({ pid: process.ppid, startedAt: '2026-10-02T00:00:00.000Z' });
  await rm(lock);
  await writeFile(lock, other);
  await winner.release();
  assert.equal(await readFile(lock, 'utf8'), other);
});

test('two processes racing over a stale lock leave exactly one holder', async (t) => {
  const dir = await tempDir(t);
  const root = path.join(dir, 'root');
  await mkdir(root);
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  const moduleUrl = new URL('../lib/root.mjs', import.meta.url).href;
  // Each child claims, says what happened, and holds a won claim until
  // stdin closes, so the winner is still alive while the loser looks.
  const script = `
    const { claimLock } = await import(${JSON.stringify(moduleUrl)});
    try { await claimLock(process.argv[1]); console.log('won'); }
    catch (error) { console.log(error.code); }
    process.stdin.resume();
    process.stdin.on('end', () => process.exit(0));
  `;
  for (let round = 0; round < 5; round += 1) {
    await writeFile(path.join(root, 'daemon.lock'), JSON.stringify({ pid: dead, startedAt: '2026-10-01T00:00:00.000Z' }));
    const children = [0, 1].map(() => spawn(process.execPath, ['--input-type=module', '-e', script, root], { stdio: ['pipe', 'pipe', 'inherit'] }));
    t.after(() => { for (const child of children) child.kill(); });
    const outcomes = await Promise.all(children.map((child) => new Promise((resolve) => {
      let out = '';
      child.stdout.on('data', (chunk) => {
        out += chunk;
        if (out.includes('\n')) resolve(out.trim());
      });
    })));
    assert.deepEqual(outcomes.sort(), ['root_locked', 'won'], `round ${round}`);
    const holder = JSON.parse(await readFile(path.join(root, 'daemon.lock'), 'utf8')).pid;
    assert.ok(children.some((child) => child.pid === holder));
    for (const child of children) child.stdin.end();
    await Promise.all(children.map((child) => new Promise((resolve) => child.once('exit', resolve))));
  }
});
