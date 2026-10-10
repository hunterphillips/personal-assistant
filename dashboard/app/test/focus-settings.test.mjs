import assert from 'node:assert/strict';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import { createFocusSettings, SettingsError } from '../lib/focus/settings.mjs';
import { tempDir } from './support/harness.mjs';

const LIMITS = { focusSettingsBytes: 16 * 1024 };

async function setup(t) {
  const dir = await tempDir(t);
  const file = path.join(dir, 'focus/settings.json');
  await mkdir(path.dirname(file), { recursive: true });
  const logs = [];
  const settings = createFocusSettings({ file, limits: LIMITS, log: (entry) => logs.push(entry) });
  return { file, logs, settings };
}

test('a missing Focus settings file reads as the seeded defaults', async (t) => {
  const { settings } = await setup(t);
  await settings.load();
  assert.deepEqual(settings.current(), {
    paused: false,
    schedules: {
      calendar: '5 * * * *', gmail: '35 * * * *', git: '15 6,10,14,18 * * *',
      notes: '45 5,7,11,15,19 * * *', rejudge: '30 5 * * *',
    },
    model: { id: null, effort: null }, problem: null,
  });
  assert.ok(Object.isFrozen(settings.current().schedules));
});

test('valid settings load and invalid, oversized, or malformed files fall back without overwrite', async (t) => {
  const valid = await setup(t);
  await writeFile(valid.file, JSON.stringify({
    version: 1, paused: true,
    schedules: {
      calendar: '5 * * * *', gmail: '35 * * * *', git: '15 6,10,14,18 * * *',
      notes: '45 5,7,11,15,19 * * *', rejudge: '30 5 * * *',
    },
    model: { id: 'claude-opus-4-1', effort: 'high' },
  }));
  await valid.settings.load();
  assert.equal(valid.settings.current().paused, true);
  assert.deepEqual(valid.settings.current().model, { id: 'claude-opus-4-1', effort: 'high' });

  for (const [body, problem] of [
    ['{', 'The settings file could not be read, so curation is paused.'],
    [JSON.stringify({ version: 1 }), /^The Focus settings file is invalid: /],
    ['x'.repeat(LIMITS.focusSettingsBytes + 1), 'The Focus settings file is too large.'],
  ]) {
    const found = await setup(t);
    await writeFile(found.file, body);
    await found.settings.load();
    assert.equal(found.settings.current().paused, true);
    if (typeof problem === 'string') assert.equal(found.settings.current().problem, problem);
    else assert.match(found.settings.current().problem, problem);
    await assert.rejects(found.settings.update({ paused: true }), { code: 'settings_invalid' });
    assert.equal(await readFile(found.file, 'utf8'), body);
  }
});

test('update writes paused and model atomically, notifies, and refuses schedules', async (t) => {
  const { file, settings } = await setup(t);
  await settings.load();
  const seen = [];
  const unsubscribe = settings.onChange((value) => seen.push(value));
  const first = await settings.update({ paused: true, model: { id: 'sonnet', effort: 'medium' } });
  await settings.update({ model: { id: null, effort: null } });
  unsubscribe();
  assert.equal(first.paused, true);
  assert.deepEqual(first.model, { id: 'sonnet', effort: 'medium' });
  assert.equal(seen.length, 2);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), {
    version: 1, paused: true, schedules: first.schedules, model: { id: null, effort: null },
  });
  await assert.rejects(settings.update({ schedules: { calendar: '0 * * * *' } }), (error) => error instanceof SettingsError && error.code === 'read_only');
  for (const [patch, code] of [
    [{ paused: 'yes' }, 'invalid_paused'], [{ model: { id: '' } }, 'invalid_model'],
    [{ model: { effort: 'extreme' } }, 'invalid_effort'],
  ]) await assert.rejects(settings.update(patch), { code });
});

test('update loads first and never overwrites an invalid hand edit', async (t) => {
  const { file, settings } = await setup(t);
  await writeFile(file, '{');
  await assert.rejects(settings.update({ paused: true }), { code: 'settings_invalid' });
  assert.equal(await readFile(file, 'utf8'), '{');
});
