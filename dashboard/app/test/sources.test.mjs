import assert from 'node:assert/strict';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import { LIMITS } from '../lib/config.mjs';
import { ALIASES_MAX, ALIAS_MAX, SourcesError, createSources } from '../lib/sources.mjs';
import { tempDir } from './support/harness.mjs';

const AT = '2026-10-08T12:00:00.000Z';

async function store(t, { usedBy, limits = LIMITS, log } = {}) {
  const root = await tempDir(t);
  const dir = path.join(root, 'sources');
  const sources = createSources({ dir, limits, now: () => new Date(AT), ...(usedBy ? { usedBy } : {}), ...(log ? { log } : {}) });
  return { root, dir, sources };
}

test('each kind is created with its field, its role, and the defaults; the file is the stored shape', async (t) => {
  const { root, dir, sources } = await store(t);
  const notes = path.join(root, 'notes');
  await mkdir(notes);
  await writeFile(path.join(notes, 'priorities.md'), 'Invented.\n');

  const rss = await sources.create({ name: 'Latent Space', kind: 'rss', url: 'https://www.latent.space/feed' });
  assert.deepEqual(rss, {
    version: 1, id: 'latent-space', name: 'Latent Space', kind: 'rss', url: 'https://www.latent.space/feed',
    active: true, default: false, created: AT, updated: AT, role: 'incoming',
  });
  const email = await sources.create({ name: 'Axios Nashville', kind: 'email', sender: ' nashville@axios.com ', active: false });
  assert.deepEqual([email.id, email.sender, email.active, email.role], ['axios-nashville', 'nashville@axios.com', false, 'incoming']);
  const file = await sources.create({ name: 'Priorities', kind: 'file', path: path.join(notes, 'priorities.md'), default: true });
  assert.deepEqual([file.role, file.missing, file.default], ['context', false, true]);
  const folder = await sources.create({ name: 'Projects', kind: 'folder', path: `${notes}/` });
  assert.deepEqual([folder.path, folder.missing], [notes, false]);

  const stored = JSON.parse(await readFile(path.join(dir, 'latent-space.json'), 'utf8'));
  assert.deepEqual(Object.keys(stored), ['version', 'id', 'name', 'kind', 'url', 'active', 'default', 'created', 'updated']);
  assert.equal((await lstat(path.join(dir, 'latent-space.json'))).mode & 0o777, 0o600);
  assert.deepEqual((await readdir(dir)).sort(), ['axios-nashville.json', 'latent-space.json', 'priorities.json', 'projects.json']);

  const { sources: listed, problems } = await sources.read();
  assert.deepEqual(problems, []);
  assert.deepEqual(listed.map((source) => source.id), ['axios-nashville', 'latent-space', 'priorities', 'projects']);
  assert.deepEqual(await sources.get('priorities'), file);
  assert.equal(await sources.get('nope'), null);
  assert.equal(await sources.get('../x'), null);
});

test('a file or folder that is not there is reported missing, never refused', async (t) => {
  const { root, sources } = await store(t);
  const gone = await sources.create({ name: 'Gone', kind: 'file', path: path.join(root, 'nowhere.md') });
  assert.equal(gone.missing, true);
  // A folder path that holds a file, and a file path that is a folder.
  await writeFile(path.join(root, 'plain.md'), 'x');
  assert.equal((await sources.create({ name: 'Not a folder', kind: 'folder', path: path.join(root, 'plain.md') })).missing, true);
  assert.equal((await sources.create({ name: 'Not a file', kind: 'file', path: root })).missing, true);
  assert.ok(!('missing' in (await sources.create({ name: 'Feed', kind: 'rss', url: 'https://example.com/feed' }))));
});

test('validation per kind names the field', async (t) => {
  const { sources } = await store(t);
  const cases = [
    [null, 'the body must be an object'],
    [{ name: 'X', kind: 'youtube', url: 'https://example.com' }, 'kind must be one of rss, email, file, folder'],
    [{ name: 'X', kind: 'rss' }, 'missing field "url"'],
    [{ kind: 'rss', url: 'https://example.com' }, 'missing field "name"'],
    [{ name: '', kind: 'rss', url: 'https://example.com' }, 'name must be 1 to 80 characters on one line'],
    [{ name: 'a\nb', kind: 'rss', url: 'https://example.com' }, 'name must be 1 to 80 characters on one line'],
    [{ name: 'x'.repeat(81), kind: 'rss', url: 'https://example.com' }, 'name must be 1 to 80 characters on one line'],
    [{ name: 'X', kind: 'rss', url: 'ftp://example.com/feed' }, 'url must be an http or https address'],
    [{ name: 'X', kind: 'rss', url: 'not a url' }, 'url must be an http or https address'],
    [{ name: 'X', kind: 'rss', url: 'https://example.com', sender: 'a@b.co' }, 'sender is not a field of rss sources'],
    [{ name: 'X', kind: 'email', sender: 'no-at-sign' }, 'sender must be an email address'],
    [{ name: 'X', kind: 'email', sender: 'a@localhost' }, 'sender must be an email address'],
    [{ name: 'X', kind: 'email', sender: 'a b@example.com' }, 'sender must be an email address'],
    [{ name: 'X', kind: 'file', path: 'relative/notes.md' }, 'path must be an absolute path'],
    [{ name: 'X', kind: 'folder', path: 42 }, 'path must be an absolute path'],
    [{ name: 'X', kind: 'rss', url: 'https://example.com', active: 'yes' }, 'active must be true or false'],
    [{ name: 'X', kind: 'rss', url: 'https://example.com', default: 1 }, 'default must be true or false'],
    [{ name: 'X', kind: 'rss', url: 'https://example.com', role: 'incoming' }, 'unknown field "role"'],
  ];
  for (const [fields, detail] of cases) {
    await assert.rejects(sources.create(fields), (error) => {
      assert.ok(error instanceof SourcesError);
      assert.deepEqual([error.code, error.detail], ['invalid_body', { detail }], JSON.stringify(fields));
      return true;
    });
  }
  assert.deepEqual(await sources.list(), []);
});

test('ids are the slugged name, with -2 and -3 on a collision', async (t) => {
  const { sources } = await store(t);
  const ids = [];
  for (const name of ['Simon Willison', 'simon willison', 'Simon  Willison!', '???']) {
    ids.push((await sources.create({ name, kind: 'rss', url: 'https://simonwillison.net/atom/everything/' })).id);
  }
  assert.deepEqual(ids, ['simon-willison', 'simon-willison-2', 'simon-willison-3', 'source']);
});

test('update changes the name, switches, and the kind field, never the kind or another kind\'s field', async (t) => {
  const { sources } = await store(t);
  await sources.create({ name: 'Hacker Newsletter', kind: 'email', sender: 'kale@hackernewsletter.com' });
  const updated = await sources.update('hacker-newsletter', { name: 'HN', active: false, default: true, sender: 'other@example.com' });
  assert.deepEqual([updated.id, updated.name, updated.active, updated.default, updated.sender, updated.kind],
    ['hacker-newsletter', 'HN', false, true, 'other@example.com', 'email']);
  for (const [fields, detail] of [
    [{}, 'the body names no field'],
    [{ kind: 'rss' }, 'kind cannot change'],
    [{ url: 'https://example.com' }, 'url is not a field of email sources'],
    [{ sender: 'bad' }, 'sender must be an email address'],
    [{ id: 'x' }, 'unknown field "id"'],
  ]) {
    await assert.rejects(sources.update('hacker-newsletter', fields), (error) => error.code === 'invalid_body' && error.detail.detail === detail, detail);
  }
  await assert.rejects(sources.update('nope', { active: true }), { code: 'no_such_source' });
});

test('aliases are stored trimmed without repeats in any case, after the name, and [] removes them', async (t) => {
  const { dir, sources } = await store(t);
  const created = await sources.create({ name: 'Daily B', kind: 'rss', url: 'https://example.com/b.xml', aliases: [' Weekly A / Daily B ', 'daily b (weekly a)', 'Daily B (Weekly A)'] });
  assert.deepEqual(created.aliases, ['Weekly A / Daily B', 'daily b (weekly a)']);
  const file = () => readFile(path.join(dir, 'daily-b.json'), 'utf8').then(JSON.parse);
  assert.deepEqual(Object.keys(await file()), ['version', 'id', 'name', 'aliases', 'kind', 'url', 'active', 'default', 'created', 'updated']);
  assert.deepEqual((await sources.update('daily-b', { aliases: ['Old B'] })).aliases, ['Old B']);
  assert.deepEqual((await sources.get('daily-b')).aliases, ['Old B']);
  const cleared = await sources.update('daily-b', { aliases: [] });
  assert.ok(!('aliases' in cleared));
  assert.ok(!('aliases' in (await file())));
  assert.ok(!('aliases' in (await sources.create({ name: 'Plain', kind: 'rss', url: 'https://example.com/p.xml' }))));
});

test('aliases that are not a list of short one-line names are refused on create and update', async (t) => {
  const { sources } = await store(t);
  await sources.create({ name: 'Daily B', kind: 'rss', url: 'https://example.com/b.xml' });
  const detail = `aliases must be a list of at most ${ALIASES_MAX} names, each 1 to ${ALIAS_MAX} characters on one line`;
  for (const aliases of [
    'Weekly A', null, [''], ['  '], [7], ['a\nb'], ['x'.repeat(ALIAS_MAX + 1)],
    Array.from({ length: ALIASES_MAX + 1 }, (_, n) => `Name ${n}`),
  ]) {
    await assert.rejects(sources.create({ name: 'X', kind: 'rss', url: 'https://example.com/x.xml', aliases }),
      (error) => error.code === 'invalid_body' && error.detail.detail === detail, JSON.stringify(aliases));
    await assert.rejects(sources.update('daily-b', { aliases }),
      (error) => error.code === 'invalid_body' && error.detail.detail === detail, JSON.stringify(aliases));
  }
  assert.deepEqual((await sources.update('daily-b', { aliases: ['x'.repeat(ALIAS_MAX), ...Array.from({ length: ALIASES_MAX - 1 }, (_, n) => `Name ${n}`)] })).aliases.length, ALIASES_MAX);
  assert.deepEqual((await sources.list()).map((source) => source.id), ['daily-b']);
});

test('remove refuses while a feed lists the source, naming the feeds', async (t) => {
  const using = new Map([['latent-space', ['news', 'work']]]);
  const { dir, sources } = await store(t, { usedBy: async (id) => using.get(id) ?? [] });
  await sources.create({ name: 'Latent Space', kind: 'rss', url: 'https://www.latent.space/feed' });
  await sources.create({ name: 'Spare', kind: 'rss', url: 'https://example.com/feed' });
  await assert.rejects(sources.remove('latent-space'), (error) => {
    assert.deepEqual([error.code, error.detail], ['in_use', { feeds: ['news', 'work'] }]);
    return true;
  });
  await sources.remove('spare');
  assert.deepEqual(await readdir(dir), ['latent-space.json']);
  await assert.rejects(sources.remove('spare'), { code: 'no_such_source' });
});

test('files that are not sources are each one problem and left out', async (t) => {
  const { dir, sources } = await store(t, { limits: { ...LIMITS, sourceFileBytes: 1024 } });
  await sources.create({ name: 'Good', kind: 'rss', url: 'https://example.com/feed' });
  await writeFile(path.join(dir, 'broken.json'), '{ not json');
  await writeFile(path.join(dir, 'wrong-id.json'), JSON.stringify({ ...JSON.parse(await readFile(path.join(dir, 'good.json'), 'utf8')), id: 'other' }));
  await writeFile(path.join(dir, 'no-field.json'), JSON.stringify({ version: 1, id: 'no-field', name: 'X', kind: 'rss', active: true, default: false, created: AT, updated: AT }));
  await writeFile(path.join(dir, 'big.json'), 'x'.repeat(2048));
  await writeFile(path.join(dir, 'Notes.txt'), 'ignored');
  const { sources: listed, problems } = await sources.read();
  assert.deepEqual(listed.map((source) => source.id), ['good']);
  assert.deepEqual(problems, ['big.json is larger than 1 KiB.', 'broken.json is not JSON.', 'no-field.json is not a source.', 'wrong-id.json is not a source.']);
  // An id taken by a broken file is still taken.
  assert.equal((await sources.create({ name: 'Broken', kind: 'rss', url: 'https://example.com/feed' })).id, 'broken-2');
});

test('a missing directory is no sources and no problem; concurrent creates get distinct ids', async (t) => {
  const { sources } = await store(t);
  assert.deepEqual(await sources.read(), { sources: [], problems: [] });
  const made = await Promise.all([1, 2, 3].map(() => sources.create({ name: 'Same', kind: 'rss', url: 'https://example.com/feed' })));
  assert.deepEqual(made.map((source) => source.id).sort(), ['same', 'same-2', 'same-3']);
});
