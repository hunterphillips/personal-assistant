import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import { DEFAULTS, SettingsError, createSettings, validatePatch } from '../lib/settings.mjs';
import { tempDir } from './support/harness.mjs';

const NOW = '2026-10-01T12:00:00.000Z';

async function setup(t, { file = 'settings.json', nested = false } = {}) {
  const dir = await tempDir(t);
  const settingsPath = path.join(dir, nested ? 'var' : '', file);
  const logs = [];
  const settings = createSettings({ path: settingsPath, log: (entry) => logs.push(entry), now: () => new Date(NOW) });
  const changes = [];
  settings.onChange((state) => changes.push(state));
  const read = async () => JSON.parse(await readFile(settingsPath, 'utf8'));
  return { dir, settingsPath, settings, logs, changes, read };
}

test('a missing file is the defaults and no error; load sets loadedAt', async (t) => {
  const { settings, settingsPath, logs } = await setup(t);
  assert.deepEqual(settings.current(), { ok: true, settings: DEFAULTS, error: null, loadedAt: null, path: settingsPath });
  await settings.load();
  assert.deepEqual(settings.current(), { ok: true, settings: DEFAULTS, error: null, loadedAt: NOW, path: settingsPath });
  assert.ok(Object.isFrozen(settings.current()) && Object.isFrozen(settings.current().settings.model));
  assert.deepEqual(logs, []);
  assert.deepEqual(DEFAULTS, { version: 1, model: { default: null, effort: null }, brief: { agent: null }, permission: { default: 'ask' }, quickChat: { agent: null } });
});

test('a valid file loads with every key present and nulls kept', async (t) => {
  const { settings, settingsPath } = await setup(t);
  await writeFile(settingsPath, JSON.stringify({ version: 1, model: { default: 'opus' }, brief: { agent: 'cfo' } }));
  await settings.load();
  assert.deepEqual(settings.current().settings, { version: 1, model: { default: 'opus', effort: null }, brief: { agent: 'cfo' }, permission: { default: 'ask' }, quickChat: { agent: null } });
  assert.equal(settings.current().ok, true);
});

test('permission.default is one of the three levels, never null, fills in as ask, and gains the key on the next write', async (t) => {
  const { settings, settingsPath, read } = await setup(t);
  await writeFile(settingsPath, JSON.stringify({ version: 1, model: {}, brief: {}, permission: { default: 'full' } }));
  await settings.load();
  assert.deepEqual(settings.current().settings.permission, { default: 'full' });

  // A file from before the key: ask, and the next write adds it.
  await writeFile(settingsPath, JSON.stringify({ version: 1, model: { default: 'opus' }, brief: { agent: 'cfo' } }));
  await settings.load();
  assert.deepEqual(settings.current().settings.permission, { default: 'ask' });
  await settings.update({ model: { effort: 'low' } });
  assert.deepEqual(await read(), { version: 1, model: { default: 'opus', effort: 'low' }, brief: { agent: 'cfo' }, permission: { default: 'ask' }, quickChat: { agent: null } });

  for (const [patch, code] of [
    [{ permission: { default: null } }, 'invalid_permission'],
    [{ permission: { default: 'bypass' } }, 'invalid_permission'],
    [{ permission: { default: 'Ask' } }, 'invalid_permission'],
    [{ permission: {} }, 'invalid_body'],
    [{ permission: { level: 'ask' } }, 'invalid_body'],
    [{ permission: 'ask' }, 'invalid_body'],
  ]) {
    await assert.rejects(settings.update(patch), (error) => error instanceof SettingsError && error.code === code, JSON.stringify(patch));
    assert.equal(validatePatch(patch), code);
  }
  assert.equal((await read()).permission.default, 'ask');

  const saved = await settings.update({ permission: { default: 'full' } });
  assert.deepEqual(saved.permission, { default: 'full' });
  assert.deepEqual((await read()).permission, { default: 'full' });

  // A file whose key is bad does not load.
  await writeFile(settingsPath, JSON.stringify({ version: 1, model: {}, brief: {}, permission: { default: 'bypass' } }));
  await settings.load();
  assert.equal(settings.current().ok, false);
  assert.match(settings.current().error, /permission\.default must be one of/);
  assert.deepEqual(settings.current().settings.permission, { default: 'full' }, 'the last good value stays');
});

test('an unreadable file keeps the last good settings, answers ok false, and logs once per message', async (t) => {
  const { settings, settingsPath, logs } = await setup(t);
  await writeFile(settingsPath, JSON.stringify({ version: 1, model: { effort: 'high' }, brief: { agent: null } }));
  await settings.load();
  for (const [content, error] of [
    ['{ not json', 'settings_invalid_json'],
    [JSON.stringify({ version: 2, model: {}, brief: {} }), 'settings_invalid: version must be 1'],
    [JSON.stringify({ version: 1, model: {}, brief: {}, extra: 1 }), 'settings_invalid: unknown key "extra"'],
    [JSON.stringify({ version: 1, model: { default: 7 }, brief: {} }), 'settings_invalid: model.default must be null or a non-empty string of at most 64 characters'],
    [JSON.stringify({ version: 1, model: { effort: 'turbo' }, brief: {} }), 'settings_invalid: model.effort must be null or one of low, medium, high, xhigh, max'],
    [JSON.stringify({ version: 1, model: {}, brief: { agent: '../x' } }), 'settings_invalid: brief.agent must be null or an agent id'],
    [JSON.stringify([1]), 'settings_invalid: must be a JSON object'],
    [`{"version":1,"model":{},"brief":{},"pad":"${'x'.repeat(64 * 1024)}"}`, 'settings_oversized'],
  ]) {
    await writeFile(settingsPath, content);
    await settings.load();
    assert.equal(settings.current().ok, false, error);
    assert.equal(settings.current().error, error);
    assert.deepEqual(settings.current().settings.model, { default: null, effort: 'high' });
  }
  assert.equal(logs.filter((e) => e.event === 'settings_error').length, 8);

  // The same problem twice logs once.
  await settings.load();
  assert.equal(logs.filter((e) => e.event === 'settings_error').length, 8);

  // A repaired file clears the error.
  await writeFile(settingsPath, JSON.stringify({ version: 1, model: {}, brief: {} }));
  await settings.load();
  assert.deepEqual(settings.current(), { ok: true, settings: DEFAULTS, error: null, loadedAt: NOW, path: settingsPath });
});

test('a directory at the path is an error, not a crash', async (t) => {
  const { settings, settingsPath } = await setup(t);
  await mkdir(settingsPath);
  await settings.load();
  assert.equal(settings.current().ok, false);
  assert.equal(settings.current().error, 'settings_not_a_file');
});

test('update merges, validates, writes atomically with mode 600, notifies, and answers the document', async (t) => {
  const { settings, settingsPath, dir, changes, read } = await setup(t, { nested: true });
  await settings.load();
  const saved = await settings.update({ model: { default: 'sonnet' } });
  assert.deepEqual(saved, { version: 1, model: { default: 'sonnet', effort: null }, brief: { agent: null }, permission: { default: 'ask' }, quickChat: { agent: null } });
  assert.ok(Object.isFrozen(saved));
  assert.deepEqual(await read(), saved);
  assert.equal((await stat(settingsPath)).mode & 0o777, 0o600);
  assert.equal((await stat(path.join(dir, 'var'))).mode & 0o777, 0o700);
  assert.deepEqual(await readdir(path.join(dir, 'var')), ['settings.json']);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].settings.model.default, 'sonnet');
  assert.equal(changes[0].ok, true);

  await settings.update({ model: { effort: 'low' }, brief: { agent: 'cfo' } });
  assert.deepEqual(settings.current().settings, { version: 1, model: { default: 'sonnet', effort: 'low' }, brief: { agent: 'cfo' }, permission: { default: 'ask' }, quickChat: { agent: null } });
  assert.deepEqual(await read(), settings.current().settings);
  await settings.update({ model: { default: null } });
  assert.deepEqual(settings.current().settings.model, { default: null, effort: 'low' });
  assert.equal(changes.length, 3);
  assert.match(await readFile(settingsPath, 'utf8'), /\n$/);
});

test('update refuses a bad patch with a code and writes nothing', async (t) => {
  const { settings, settingsPath, changes } = await setup(t);
  await settings.load();
  for (const [patch, code] of [
    [null, 'invalid_body'],
    ['x', 'invalid_body'],
    [{}, 'invalid_body'],
    [{ version: 1 }, 'invalid_body'],
    [{ model: {} }, 'invalid_body'],
    [{ model: { other: 1 } }, 'invalid_body'],
    [{ brief: null }, 'invalid_body'],
    [{ model: { default: '' } }, 'invalid_model'],
    [{ model: { default: 'x'.repeat(65) } }, 'invalid_model'],
    [{ model: { default: 3 } }, 'invalid_model'],
    [{ model: { effort: 'HIGH' } }, 'invalid_effort'],
    [{ brief: { agent: 'Not An Id' } }, 'invalid_agent'],
    [{ brief: { agent: 7 } }, 'invalid_agent'],
  ]) {
    await assert.rejects(settings.update(patch), (error) => error instanceof SettingsError && error.code === code, JSON.stringify(patch));
    assert.equal(validatePatch(patch), code);
  }
  assert.equal(validatePatch({ model: { default: 'opus', effort: 'max' }, brief: { agent: null } }), null);
  await assert.rejects(stat(settingsPath), { code: 'ENOENT' });
  assert.equal(changes.length, 0);
});

test('update refuses settings_invalid while the file is unreadable, so a hand edit is never overwritten', async (t) => {
  const { settings, settingsPath, read } = await setup(t);
  await writeFile(settingsPath, '{ broken');
  await settings.load();
  await assert.rejects(settings.update({ model: { default: 'opus' } }), { code: 'settings_invalid' });
  assert.equal(await readFile(settingsPath, 'utf8'), '{ broken');

  await writeFile(settingsPath, JSON.stringify({ version: 1, model: {}, brief: {} }));
  await settings.load();
  await settings.update({ model: { default: 'opus' } });
  assert.equal((await read()).model.default, 'opus');
});

test('concurrent updates apply in order over one another', async (t) => {
  const { settings, read } = await setup(t);
  await settings.load();
  await Promise.all([
    settings.update({ model: { default: 'opus' } }),
    settings.update({ model: { effort: 'high' } }),
    settings.update({ brief: { agent: 'cfo' } }),
  ]);
  assert.deepEqual(await read(), { version: 1, model: { default: 'opus', effort: 'high' }, brief: { agent: 'cfo' }, permission: { default: 'ask' }, quickChat: { agent: null } });
});

test('seed writes the defaults with the given values only when the file is missing', async (t) => {
  const { settings, read, changes } = await setup(t, { nested: true });
  await settings.load();
  assert.equal(await settings.seed({ brief: { agent: 'assistant' } }), true);
  assert.deepEqual(await read(), { version: 1, model: { default: null, effort: null }, brief: { agent: 'assistant' }, permission: { default: 'ask' }, quickChat: { agent: null } });
  assert.equal(settings.current().settings.brief.agent, 'assistant');
  assert.equal(changes.length, 1);

  assert.equal(await settings.seed({ brief: { agent: 'other' } }), false);
  assert.equal((await read()).brief.agent, 'assistant');
  assert.equal(changes.length, 1);

  // A present but broken file is left alone too.
  const broken = await setup(t, { file: 'broken.json' });
  await writeFile(broken.settingsPath, '{');
  await broken.settings.load();
  assert.equal(await broken.settings.seed({ brief: { agent: 'assistant' } }), false);
  assert.equal(await readFile(broken.settingsPath, 'utf8'), '{');
  assert.equal(broken.settings.current().ok, false);
});

test('a listener that throws is logged and the rest still run', async (t) => {
  const { settings, logs } = await setup(t);
  await settings.load();
  settings.onChange(() => { throw new Error('listener broke'); });
  let ran = false;
  const off = settings.onChange(() => { ran = true; });
  await settings.update({ model: { default: 'opus' } });
  assert.equal(ran, true);
  assert.ok(logs.some((e) => e.event === 'settings_listener_error' && e.error === 'listener broke'));
  off();
  ran = false;
  await settings.update({ model: { default: 'haiku' } });
  assert.equal(ran, false);
});

test('quickChat.agent is null or an agent id, with its own refusal code', async (t) => {
  const { settings, read } = await setup(t);
  await settings.load();
  assert.equal(validatePatch({ quickChat: { agent: 'Not An Id' } }), 'invalid_quick_chat_agent');
  assert.equal(validatePatch({ quickChat: { agent: 3 } }), 'invalid_quick_chat_agent');
  assert.equal(validatePatch({ quickChat: { other: 'x' } }), 'invalid_body');
  assert.equal(validatePatch({ quickChat: { agent: null } }), null);
  await assert.rejects(settings.update({ quickChat: { agent: 'Bad' } }), { code: 'invalid_quick_chat_agent' });
  await settings.update({ quickChat: { agent: 'myos' } });
  assert.deepEqual((await read()).quickChat, { agent: 'myos' });
  assert.deepEqual(settings.current().settings.quickChat, { agent: 'myos' });
});

test('addMissing adds a key a file from before it lacks, once, and leaves a missing or broken file alone', async (t) => {
  const { settings, settingsPath, read, changes } = await setup(t);
  await settings.load();
  assert.equal(await settings.addMissing({ quickChat: { agent: 'myos' } }), false, 'a missing file is seed()\'s');

  const before = { version: 1, model: { default: 'opus', effort: null }, brief: { agent: 'cfo' }, permission: { default: 'auto' } };
  await writeFile(settingsPath, JSON.stringify(before));
  await settings.load();
  assert.deepEqual(settings.current().settings.quickChat, { agent: null }, 'loads with the key filled');
  assert.equal(await settings.addMissing({ quickChat: { agent: 'myos' } }), true);
  assert.deepEqual(await read(), { ...before, quickChat: { agent: 'myos' } });
  assert.equal((await stat(settingsPath)).mode & 0o777, 0o600);
  assert.equal(changes.at(-1).settings.quickChat.agent, 'myos');

  // Present, even as null, is never overwritten.
  await settings.update({ quickChat: { agent: null } });
  assert.equal(await settings.addMissing({ quickChat: { agent: 'myos' } }), false);
  assert.deepEqual((await read()).quickChat, { agent: null });

  await writeFile(settingsPath, '{ broken');
  await settings.load();
  assert.equal(await settings.addMissing({ quickChat: { agent: 'myos' } }), false);
  assert.equal(await readFile(settingsPath, 'utf8'), '{ broken');
});
