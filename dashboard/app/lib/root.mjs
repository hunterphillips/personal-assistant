// Data root: the one folder outside the repository that holds everything the
// product writes while it is used, so using it leaves the checkout clean.
// This module knows the root's layout, seeds a new root with its defaults,
// moves the data a checkout holds today into the root once, and guards the
// root with a lock so one daemon runs over it. It copies bytes and never
// parses a store; every file keeps the format it has today.
//
// The root is ~/.personal-assistant/ unless PERSONAL_ASSISTANT_HOME names
// another; the caller resolves that and passes an absolute path.
//
// layoutPaths(root) -> frozen { key: absolute path }, layout version 2
//   (layout.mjs, re-exported here).
//
// readLayout(root) -> Promise<{ version, createdAt, migratedFrom } | null>
//   null when layout.json is missing. Rejects with layout_invalid for a file
//   that is not a JSON object with an integer version of at least 1, and with
//   layout_newer ({ version }) for a version above LAYOUT_VERSION: a newer
//   daemon wrote this root, and this one must not touch it.
//
// writeLayout(root, { version, createdAt, migratedFrom }) -> Promise<void>
//   Atomic (threads.mjs atomicWrite, mode 0600); migratedFrom only when set.
//
// seedDefaults(root, { defaultsDir, readmeFile, log }) -> Promise<[key]>
//   Creates every directory of the layout (0700). Writes README.md from
//   readmeFile when the bytes differ, and copies <defaultsDir>/ideas-criteria.md
//   to the Ideas criteria file only when the target is missing, so a
//   deliberate delete starts from the default again. A missing default is
//   skipped. Answers the keys it wrote and logs root_seeded.
//
// migrateFromRepo(root, { migrateFrom, log, rename }) -> Promise<{ moved,
//   skipped, migratedFrom }>
//   The one-time move out of the checkout at migrateFrom (absolute, or empty
//   for none; never derived from this file's location). Every pair whose
//   source exists is compared with its target first; a target that differs,
//   or holds a file the source lacks or lacks one it holds, is a conflict,
//   and any conflict rejects with migration_conflict ({ pairs }) before
//   anything is copied or renamed. Then each missing target is copied into
//   place (a temporary name beside it, then a rename), verified file by file
//   (relative path, type, mode, size, SHA-256), and each source is renamed to
//   <source>.migrated. The pairs land on the version 1 paths (V1 below), and
//   upgradeV1 then moves them on. daily-brief/briefs/ stays for its code: its data files
//   and any other file but build.py, check-viewer.mjs, and __pycache__/ move
//   into daily-brief/briefs.migrated/ instead. Nothing is deleted. A run cut off between the steps
//   reruns cleanly: a copied source compares equal and is renamed. `rename`
//   replaces fs.rename for the tests.
//
// claimLock(root) -> Promise<{ release }>
//   Claims daemon.lock ({ pid, startedAt }) through bindings.mjs claimPidFile
//   and reads it back once; rejects with root_locked ({ pid }) when another
//   process holds it or won a race over a stale one. release() removes the
//   file only while it still holds this claim.
//
// upgradeV1(root, { log, rename, now }) -> Promise<{ moved, retired }>
//   The version 1 to 2 move, copy, verify, then rename, as migrateFromRepo:
//   feed/items/ becomes feeds/news/items/ and feed/relevance.md
//   feeds/news/note.md; watch/'s packets/, overflow/, seen.jsonl, and
//   state.json go to feeds/.run/. When the upgrade creates feeds/news, the
//   last two are converted for the feeds run as they are copied: each seen
//   line gains "feed": "news", and state.json's last_run moves to
//   feeds.news.last_run; a target holding either the source's bytes or
//   their conversion counts as moved. A conflict rejects with
//   migration_conflict before anything is copied or renamed. When the root
//   had a feed/ folder, feeds/news/feed.json is written if missing (News,
//   produced by scout, no sources, active). Then feed/ and watch/ are
//   renamed whole to <path>.migrated; the registry loses the retired agent
//   (and every `accepts` naming it), its version 1 file kept beside it as
//   agents.json.migrated; the agent's thread files are renamed
//   <file>.migrated; and its key leaves thread-reads.json. An unreadable
//   registry or reads file is left alone and logged. Every step is skipped
//   when already done, so a run cut off midway reruns cleanly. Logs
//   upgrade_moved per pair and upgrade_done.
//
// prepareRoot(root, { migrateFrom, defaultsDir, readmeFile, log, rename })
//   -> Promise<{ created, moved, skipped, upgraded, seeded }>
//   What the daemon calls at start. A root without layout.json is migrated,
//   upgraded, seeded, and then given layout.json, always the last file
//   written, so a first run cut off midway looks like a fresh root to the
//   next one. A root at version 1 is upgraded, seeded, and given version 2
//   last, so an upgrade cut off midway runs again. A root at version 2 is
//   only seeded. `upgraded` lists the upgrade's moved keys.

import { createHash, randomBytes } from 'node:crypto';
import {
  chmod, copyFile, lstat, mkdir, readFile, readdir, readlink, rename as fsRename, rm, symlink, unlink, writeFile,
} from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

import { claimPidFile } from './bindings.mjs';
import { LAYOUT_VERSION, layoutPaths } from './layout.mjs';
import { atomicWrite } from './threads.mjs';

export { LAYOUT_VERSION, layoutPaths };

// The migration's pairs in order: a key for the result and the log, the
// source relative to the checkout, and the target under the root.
const VAR = 'dashboard/app/var';

// The version 1 paths that version 2 retired, relative to the root. Only the
// move from the checkout and upgradeV1 read them.
const V1 = { feedRoot: 'feed', feedDir: 'feed/items', feedInstructions: 'feed/relevance.md', watchDir: 'watch' };
const v1Paths = (root) => Object.fromEntries(Object.entries(V1).map(([key, rel]) => [key, path.join(path.resolve(root), rel)]));

const PAIRS = [
  ['settings', `${VAR}/settings.json`, (p) => p.settings],
  ['threadReads', `${VAR}/thread-reads.json`, (p) => p.threadReads],
  ['registry', 'registry/agents.json', (p) => p.registry],
  ['routinesDir', 'routines', (p) => p.routinesDir],
  ['threadsDir', `${VAR}/threads`, (p) => p.threadsDir],
  ['codexDir', `${VAR}/codex`, (p) => p.codexDir],
  ['notificationsDir', 'notifications', (p) => p.notificationsDir],
  ['feedDir', 'feed/items', (p, v1) => v1.feedDir],
  ['feedInstructions', 'daily-brief/watch/relevance.md', (p, v1) => v1.feedInstructions],
  ['ideasDir', 'ideas/items', (p) => p.ideasDir],
  ['ideasMarks', 'ideas/marks.json', (p) => p.ideasMarks],
  ['ideasInstructions', 'ideas/criteria.md', (p) => p.ideasInstructions],
  ['briefsDir', 'daily-brief/briefs', (p) => p.briefsDir, 'briefs'],
  ['contributionsDir', 'daily-brief/contributions', (p) => p.contributionsDir],
  ...['packets', 'overflow', 'seen.jsonl', 'state.json'].map((name) => [`watchDir/${name}`, `daily-brief/watch/${name}`, (p, v1) => path.join(v1.watchDir, name)]),
  // The log and the installer's plists are written under the root before the
  // daemon first starts (bin/dashboard-start and bin/dashboard-install), so
  // the checkout's copies land in a folder of their own beside them.
  ['logDir', `${VAR}/log`, (p) => path.join(p.logDir, 'checkout')],
  ['cacheDir/launchd', `${VAR}/launchd`, (p) => path.join(p.cacheDir, 'launchd', 'checkout')],
  ['cacheDir/ops', `${VAR}/ops`, (p) => path.join(p.cacheDir, 'ops')],
].map(([key, source, target, kind = 'entry']) => ({ key, source, target, kind }));

// What leaves daily-brief/briefs/ for the root; build.py, check-viewer.mjs,
// and __pycache__/ are code and stay; anything else goes to briefs.migrated/.
const BRIEF_DATA = [/^viewer-.*\.html$/, /^brief-.*\.json$/, /^notice-.*\.json$/, /^memo-.*\.md$/, /^.{4}-.{2}-.{2}.*\.md$/, /^feedback-/, /^\.run\.lock$/];
const BRIEF_CODE = new Set(['build.py', 'check-viewer.mjs', '__pycache__']);

const SEEDS = [['ideasInstructions', 'ideas-criteria.md']];

// The version 1 to 2 upgrade: today's one feed becomes the feed `news`, and
// the producer that wrote it, retired with version 1, gives way to the
// built-in Scout (seeded from registry/builtin.json at start).
const NEWS = { id: 'news', name: 'News', producer: 'scout' };
const RETIRED_AGENT = 'watch';

// The retired producer's run state in the shapes feeds/run reads: seen lines
// name their feed, and the last run is per feed. A line or file that does not
// parse is kept as it is.
const RUN_STATE = {
  'seen.jsonl': (bytes) => Buffer.from(bytes.toString('utf8').split('\n').map((line) => {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      return line;
    }
    return isRecord(entry) && !Object.hasOwn(entry, 'feed') ? JSON.stringify({ feed: NEWS.id, ...entry }) : line;
  }).join('\n')),
  'state.json': (bytes) => {
    let state;
    try {
      state = JSON.parse(bytes.toString('utf8'));
    } catch {
      return bytes;
    }
    if (!isRecord(state) || !Object.hasOwn(state, 'last_run')) return bytes;
    const { last_run: lastRun, ...rest } = state;
    const feeds = isRecord(rest.feeds) ? rest.feeds : {};
    const news = isRecord(feeds[NEWS.id]) ? feeds[NEWS.id] : {};
    return Buffer.from(`${JSON.stringify({ ...rest, feeds: { ...feeds, [NEWS.id]: { ...news, last_run: lastRun } } }, null, 1)}\n`);
  },
};
const UPGRADE_PAIRS = [
  ['feedDir', (v1) => v1.feedDir, (p) => path.join(p.feedsDir, NEWS.id, 'items')],
  ['feedInstructions', (v1) => v1.feedInstructions, (p) => path.join(p.feedsDir, NEWS.id, 'note.md')],
  ...['packets', 'overflow', 'seen.jsonl', 'state.json'].map((name) => [
    `watchDir/${name}`, (v1) => path.join(v1.watchDir, name), (p) => path.join(p.feedsRunDir, name), RUN_STATE[name]]),
].map(([key, source, target, convert = null]) => ({ key, source, target, convert }));

export class RootError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'RootError';
    this.code = code;
    this.details = details;
  }
}

export async function readLayout(root) {
  const file = layoutPaths(root).layout;
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    data = null;
  }
  const version = isRecord(data) ? data.version : undefined;
  if (!Number.isInteger(version) || version < 1) {
    throw new RootError('layout_invalid', `The layout file ${file} does not name a layout version this daemon can read.`, { file });
  }
  if (version > LAYOUT_VERSION) {
    throw new RootError('layout_newer', `The root at ${path.dirname(file)} has layout version ${version}, newer than the version ${LAYOUT_VERSION} this daemon knows, so it leaves the root alone.`, { version });
  }
  return {
    version,
    createdAt: typeof data.createdAt === 'string' ? data.createdAt : null,
    migratedFrom: typeof data.migratedFrom === 'string' && data.migratedFrom ? data.migratedFrom : null,
  };
}

export async function writeLayout(root, { version, createdAt, migratedFrom }) {
  const body = { version, createdAt };
  if (migratedFrom) body.migratedFrom = migratedFrom;
  await writeAtomic(layoutPaths(root).layout, `${JSON.stringify(body, null, 2)}\n`);
}

export async function seedDefaults(root, { defaultsDir, readmeFile, log = () => {} } = {}) {
  const paths = layoutPaths(root);
  for (const [key, value] of Object.entries(paths)) {
    await mkdir(key.endsWith('Dir') ? value : path.dirname(value), { recursive: true, mode: 0o700 });
  }
  const seeded = [];
  const readme = readmeFile ? await readOptional(readmeFile) : null;
  if (readme !== null) {
    const current = await readOptional(paths.readme);
    if (current === null || !current.equals(readme)) {
      await writeAtomic(paths.readme, readme);
      seeded.push('readme');
    }
  }
  for (const [key, name] of SEEDS) {
    if (!defaultsDir || await exists(paths[key])) continue;
    const bytes = await readOptional(path.join(defaultsDir, name));
    if (bytes === null) continue;
    await writeAtomic(paths[key], bytes);
    seeded.push(key);
  }
  if (seeded.length > 0) safeLog(log, { event: 'root_seeded', keys: seeded });
  return seeded;
}

export async function migrateFromRepo(root, { migrateFrom, log = () => {}, rename = fsRename } = {}) {
  const paths = layoutPaths(root);
  const v1 = v1Paths(root);
  if (!migrateFrom) return { moved: [], skipped: [], migratedFrom: null };
  const repo = absolute(migrateFrom, 'migrateFrom');

  // Plan: every pair's units (a source and its target), compared up front.
  const plan = [];
  const skipped = [];
  const conflicts = [];
  for (const pair of PAIRS) {
    const source = path.join(repo, pair.source);
    const target = pair.target(paths, v1);
    const units = pair.kind === 'briefs' ? await briefUnits(source, target) : await entryUnits(source, target);
    if (units.length === 0) {
      skipped.push({ key: pair.key, reason: 'missing' });
      continue;
    }
    for (const unit of units) {
      if (!unit.target) continue;
      const found = await compareUnit(unit);
      if (found.conflict) conflicts.push({ source: unit.reportSource ?? unit.source, target: unit.reportTarget ?? unit.target, file: found.file });
      unit.copy = found.copy;
    }
    plan.push({ key: pair.key, source, target, units });
  }
  if (conflicts.length > 0) {
    const sentences = conflicts.map(({ source, target, file }) => (
      `The root at ${path.dirname(paths.readme)} already holds ${joinFile(target, file)} with different contents than ${joinFile(source, file)}.`));
    throw new RootError('migration_conflict', sentences.join(' '), { pairs: conflicts });
  }

  // Copy, then verify every copy, before any source is renamed.
  for (const { units } of plan) {
    for (const unit of units) if (unit.target && unit.copy) await copyIntoPlace(unit.source, unit.target, rename);
  }
  for (const { units } of plan) {
    for (const unit of units) {
      if (!unit.target) continue;
      const found = await compareUnit(unit);
      if (found.conflict || found.copy) {
        const pair = { source: unit.reportSource ?? unit.source, target: unit.reportTarget ?? unit.target, file: found.file };
        throw new RootError('migration_conflict', `The copy of ${joinFile(pair.source, pair.file)} at ${joinFile(pair.target, pair.file)} does not match its source.`, { pairs: [pair] });
      }
      unit.files = found.files;
    }
  }

  const moved = [];
  for (const { key, source, target, units } of plan) {
    let files = 0;
    for (const unit of units) {
      if (unit.aside) {
        await mkdir(path.dirname(unit.aside), { recursive: true });
        await rename(unit.source, await freeName(unit.aside));
      } else {
        await rename(unit.source, await freeName(`${unit.source}.migrated`));
      }
      files += unit.files ?? 0;
    }
    moved.push(key);
    safeLog(log, { event: 'migration_moved', key, source, target, files });
  }
  safeLog(log, { event: 'migration_done', moved: moved.length, skipped: skipped.length });
  return { moved, skipped, migratedFrom: moved.length > 0 ? repo : null };
}

// Claims held by this process, so two claims made here cannot both win.
const held = new Set();

export async function claimLock(root) {
  const file = layoutPaths(root).lock;
  if (held.has(file)) throw locked(file, process.pid);
  held.add(file);
  try {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const content = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() });
    const claim = await claimPidFile(file, content);
    if (!claim.claimed) throw locked(file, claim.holder?.pid ?? null);
    const back = await readOptional(file);
    if (back === null || back.toString('utf8') !== content) throw locked(file, pidIn(back));
    let released = false;
    return {
      async release() {
        if (released) return;
        released = true;
        held.delete(file);
        const current = await readOptional(file);
        if (current !== null && current.toString('utf8') === content) await unlink(file).catch(() => {});
      },
    };
  } catch (error) {
    held.delete(file);
    throw error;
  }
}

export async function prepareRoot(root, { migrateFrom, defaultsDir, readmeFile, log = () => {}, rename } = {}) {
  const layout = await readLayout(root);
  if (layout?.version === LAYOUT_VERSION) {
    const seeded = await seedDefaults(root, { defaultsDir, readmeFile, log });
    return { created: false, moved: [], skipped: [], upgraded: [], seeded };
  }
  if (layout) {
    const upgrade = await upgradeV1(root, { log, rename });
    const seeded = await seedDefaults(root, { defaultsDir, readmeFile, log });
    await writeLayout(root, { ...layout, version: LAYOUT_VERSION });
    return { created: false, moved: [], skipped: [], upgraded: upgrade.moved, seeded };
  }
  const migration = await migrateFromRepo(root, { migrateFrom, log, rename });
  const upgrade = await upgradeV1(root, { log, rename });
  const seeded = await seedDefaults(root, { defaultsDir, readmeFile, log });
  await writeLayout(root, { version: LAYOUT_VERSION, createdAt: new Date().toISOString(), migratedFrom: migration.migratedFrom });
  return { created: true, moved: migration.moved, skipped: migration.skipped, upgraded: upgrade.moved, seeded };
}

export async function upgradeV1(root, { log = () => {}, rename = fsRename, now = () => new Date() } = {}) {
  const paths = layoutPaths(root);
  const v1 = v1Paths(root);

  // feeds/news is the upgrade's own when the root had a feed and no feed.json.
  const feedFile = path.join(paths.feedsDir, NEWS.id, 'feed.json');
  const creating = await exists(v1.feedRoot) && !(await exists(feedFile));

  const plan = [];
  const conflicts = [];
  for (const pair of UPGRADE_PAIRS) {
    const [unit] = await entryUnits(pair.source(v1), pair.target(paths));
    if (!unit) continue;
    if (pair.convert && (await lstat(unit.source)).isFile()) {
      unit.convert = pair.convert;
      unit.converting = creating;
    }
    const found = unit.convert ? await compareConverted(unit) : await compareUnit(unit);
    if (found.conflict) conflicts.push({ source: unit.source, target: unit.target, file: found.file });
    unit.copy = found.copy;
    plan.push({ key: pair.key, unit });
  }
  if (conflicts.length > 0) {
    const sentences = conflicts.map(({ source, target, file }) => (
      `The root at ${path.dirname(paths.readme)} already holds ${joinFile(target, file)} with different contents than ${joinFile(source, file)}.`));
    throw new RootError('migration_conflict', sentences.join(' '), { pairs: conflicts });
  }
  for (const { unit } of plan) {
    if (!unit.copy) continue;
    if (unit.converting) await copyConverted(unit, rename);
    else await copyIntoPlace(unit.source, unit.target, rename);
  }
  for (const { unit } of plan) {
    const found = unit.convert ? await compareConverted(unit) : await compareUnit(unit);
    if (found.conflict || found.copy) {
      const pair = { source: unit.source, target: unit.target, file: found.file };
      throw new RootError('migration_conflict', `The copy of ${joinFile(pair.source, pair.file)} at ${joinFile(pair.target, pair.file)} does not match its source.`, { pairs: [pair] });
    }
    unit.files = found.files;
  }

  // The feed's settings, once, when the root had a feed.
  if (creating && !(await exists(feedFile))) {
    await mkdir(path.join(paths.feedsDir, NEWS.id, 'items'), { recursive: true, mode: 0o700 });
    const at = now().toISOString();
    const feed = { version: 1, id: NEWS.id, name: NEWS.name, producer: NEWS.producer, sources: [], active: true, created: at, updated: at };
    await writeAtomic(feedFile, `${JSON.stringify(feed, null, 2)}\n`);
  }

  const moved = [];
  for (const { key, unit } of plan) {
    moved.push(key);
    safeLog(log, { event: 'upgrade_moved', key, source: unit.source, target: unit.target, files: unit.files ?? 0 });
  }
  const retired = [];
  for (const dir of [v1.feedRoot, v1.watchDir]) {
    if (!(await exists(dir))) continue;
    await rename(dir, await freeName(`${dir}.migrated`));
    retired.push(dir);
  }
  const agent = await retireAgent(paths, RETIRED_AGENT, log);
  for (const name of [`${RETIRED_AGENT}.json`, `${RETIRED_AGENT}.jsonl`]) {
    const file = path.join(paths.threadsDir, name);
    if (await exists(file)) await rename(file, await freeName(`${file}.migrated`));
  }
  const reads = await dropReadKey(paths.threadReads, RETIRED_AGENT, log);
  safeLog(log, { event: 'upgrade_done', from: 1, to: 2, moved: moved.length, retired: retired.length, agent, reads });
  return { moved, retired };
}

// Removes the agent `id` from the registry file, and from every `accepts`
// list, keeping the file as it was beside it. True when it removed one.
async function retireAgent(paths, id, log) {
  const raw = await readOptional(paths.registry);
  if (raw === null) return false;
  let document;
  try {
    document = JSON.parse(raw.toString('utf8'));
  } catch {
    document = null;
  }
  if (!isRecord(document) || !Array.isArray(document.agents)) {
    safeLog(log, { event: 'upgrade_registry_skipped', file: paths.registry });
    return false;
  }
  if (!document.agents.some((agent) => isRecord(agent) && agent.id === id)) return false;
  await writeAtomic(await freeName(`${paths.registry}.migrated`), raw);
  const agents = document.agents.filter((agent) => !(isRecord(agent) && agent.id === id)).map((agent) => (
    isRecord(agent) && Array.isArray(agent.accepts) && agent.accepts.includes(id)
      ? { ...agent, accepts: agent.accepts.filter((other) => other !== id) }
      : agent));
  await writeAtomic(paths.registry, `${JSON.stringify({ ...document, agents }, null, 2)}\n`);
  return true;
}

// Removes `id` from the thread read times. True when it removed one.
async function dropReadKey(file, id, log) {
  const raw = await readOptional(file);
  if (raw === null) return false;
  let reads;
  try {
    reads = JSON.parse(raw.toString('utf8'));
  } catch {
    reads = null;
  }
  if (!isRecord(reads)) {
    safeLog(log, { event: 'upgrade_reads_skipped', file });
    return false;
  }
  if (!Object.hasOwn(reads, id)) return false;
  const { [id]: _dropped, ...rest } = reads;
  await writeAtomic(file, `${JSON.stringify(rest, null, 2)}\n`);
  return true;
}

// A pair's units: the source itself when it is a file, link, or directory,
// else none.
async function entryUnits(source, target) {
  let stats;
  try {
    stats = await lstat(source);
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  return stats.isFile() || stats.isDirectory() || stats.isSymbolicLink() ? [{ source, target }] : [];
}

// The briefs directory's units: each data file goes to the root and then to
// briefs.migrated/ beside the directory; any other entry but the code goes
// straight to briefs.migrated/.
async function briefUnits(dir, targetDir) {
  let names;
  try {
    names = await readdir(dir);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return [];
    throw error;
  }
  const aside = `${dir}.migrated`;
  return names.sort().filter((name) => !BRIEF_CODE.has(name)).map((name) => {
    const unit = { source: path.join(dir, name), aside: path.join(aside, name), target: null };
    if (BRIEF_DATA.some((pattern) => pattern.test(name))) {
      Object.assign(unit, { target: path.join(targetDir, name), reportSource: dir, reportTarget: targetDir, reportFile: name });
    }
    return unit;
  });
}

// { conflict, copy, file, files }: copy when the target is missing or an
// empty directory, conflict when it differs from the source in any file.
async function compareUnit(unit) {
  const source = await listTree(unit.source);
  const target = await listTree(unit.target);
  const prefix = unit.reportFile ? `${unit.reportFile}` : '';
  const named = (rel) => (prefix ? (rel ? `${prefix}/${rel}` : prefix) : rel || path.basename(unit.source));
  if (target === null || (target.size === 1 && target.get('')?.type === 'dir' && source.get('')?.type === 'dir' && source.size > 1)) {
    return { conflict: false, copy: true, files: countFiles(source) };
  }
  // Files before directories, so a conflict names the file a directory lacks.
  const isDir = (rel) => (source.get(rel) ?? target.get(rel)).type === 'dir';
  const rels = [...new Set([...source.keys(), ...target.keys()])].sort();
  for (const rel of [...rels.filter((rel) => !isDir(rel)), ...rels.filter(isDir)]) {
    const a = source.get(rel);
    const b = target.get(rel);
    if (!a || !b || a.type !== b.type || a.mode !== b.mode || a.size !== b.size || a.hash !== b.hash || a.link !== b.link) {
      return { conflict: true, copy: false, file: named(rel) };
    }
  }
  return { conflict: false, copy: false, files: countFiles(source) };
}

// compareUnit for a run state file: the target may hold the source's bytes
// or their conversion, with the source's mode.
async function compareConverted(unit) {
  const name = path.basename(unit.source);
  let target;
  try {
    target = await lstat(unit.target);
  } catch (error) {
    if (error?.code === 'ENOENT') return { conflict: false, copy: true, files: 1 };
    throw error;
  }
  const source = await lstat(unit.source);
  if (target.isFile() && (target.mode & 0o7777) === (source.mode & 0o7777)) {
    const bytes = await readFile(unit.source);
    const held = await readFile(unit.target);
    if (held.equals(bytes) || held.equals(unit.convert(bytes))) return { conflict: false, copy: false, files: 1 };
  }
  return { conflict: true, copy: false, file: name };
}

// Writes the source's conversion beside the target with the source's mode,
// then renames it into place.
async function copyConverted(unit, rename) {
  await mkdir(path.dirname(unit.target), { recursive: true, mode: 0o700 });
  const temp = path.join(path.dirname(unit.target), `.${path.basename(unit.target)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    const source = await lstat(unit.source);
    await writeFile(temp, unit.convert(await readFile(unit.source)), { flag: 'wx', mode: 0o600 });
    await chmod(temp, source.mode & 0o7777);
    await rename(temp, unit.target);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

// Map<relative path, { type, mode, size, hash, link }> for a file, link, or
// directory tree, or null when it is missing. A directory's own entry is ''.
async function listTree(top) {
  let info;
  try {
    info = await lstat(top);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  const entries = new Map();
  const visit = async (file, rel, stats) => {
    if (stats.isDirectory()) {
      entries.set(rel, { type: 'dir' });
      for (const name of (await readdir(file)).sort()) {
        const child = path.join(file, name);
        await visit(child, rel ? `${rel}/${name}` : name, await lstat(child));
      }
    } else if (stats.isSymbolicLink()) {
      entries.set(rel, { type: 'link', link: await readlink(file) });
    } else if (stats.isFile()) {
      const hash = createHash('sha256').update(await readFile(file)).digest('hex');
      entries.set(rel, { type: 'file', mode: stats.mode & 0o7777, size: stats.size, hash });
    }
    // Sockets and FIFOs (a running Codex server's app.sock) are not data:
    // they are neither compared nor copied, and stay with the source.
  };
  await visit(top, '', info);
  return entries;
}

const countFiles = (tree) => [...tree.values()].filter((entry) => entry.type === 'file').length;

// Copies a file, link, or directory tree to a temporary name beside the
// target, keeping modes, then renames it into place (over an empty directory).
async function copyIntoPlace(source, target, rename) {
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    await copyTree(source, temp);
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function copyTree(source, target) {
  const stats = await lstat(source);
  if (stats.isDirectory()) {
    await mkdir(target, { mode: 0o700 });
    for (const name of await readdir(source)) await copyTree(path.join(source, name), path.join(target, name));
    await chmod(target, stats.mode & 0o7777);
  } else if (stats.isSymbolicLink()) {
    await symlink(await readlink(source), target);
  } else if (stats.isFile()) {
    await copyFile(source, target, constants.COPYFILE_EXCL);
    await chmod(target, stats.mode & 0o7777);
  }
}

// `wanted`, or wanted-2, wanted-3, … when it is taken, so a rename never
// replaces an earlier migration's leftovers.
async function freeName(wanted) {
  if (!(await exists(wanted))) return wanted;
  for (let index = 2; ; index += 1) {
    const candidate = `${wanted}-${index}`;
    if (!(await exists(candidate))) return candidate;
  }
}

async function writeAtomic(file, bytes) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await atomicWrite(path.dirname(file), path.basename(file), bytes);
}

async function readOptional(file) {
  try {
    return await readFile(file);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function exists(file) {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function locked(file, pid) {
  const holder = Number.isInteger(pid) ? `process ${pid}` : 'another process';
  return new RootError('root_locked', `The lock ${file} is held by ${holder}, so this daemon does not start over the same root.`, { pid });
}

function pidIn(bytes) {
  try {
    const content = JSON.parse(bytes?.toString('utf8') ?? 'null');
    return isRecord(content) && Number.isInteger(content.pid) ? content.pid : null;
  } catch {
    return null;
  }
}

function absolute(value, name) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new TypeError(`${name} must be an absolute path`);
  return path.resolve(value);
}

const joinFile = (base, file) => (file && file !== path.basename(base) ? path.join(base, file) : base);
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const safeLog = (log, entry) => { try { log(entry); } catch {} };
