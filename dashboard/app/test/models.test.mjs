import assert from 'node:assert/strict';
import { test } from 'node:test';

import { EFFORTS, MODELS, effortName, isEffort, modelName } from '../lib/models.mjs';

test('the model table lists the four Claude Code aliases with display names, frozen', () => {
  assert.deepEqual(MODELS, [
    { id: 'fable', name: 'Fable' },
    { id: 'opus', name: 'Opus' },
    { id: 'sonnet', name: 'Sonnet' },
    { id: 'haiku', name: 'Haiku' },
  ]);
  assert.ok(Object.isFrozen(MODELS) && MODELS.every((model) => Object.isFrozen(model)));
  assert.deepEqual(EFFORTS, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.ok(Object.isFrozen(EFFORTS));
});

test('modelName answers the display name, or the id itself for one not listed', () => {
  assert.equal(modelName('opus'), 'Opus');
  assert.equal(modelName('claude-sonnet-4-5'), 'claude-sonnet-4-5');
  assert.equal(modelName(null), '');
  assert.equal(effortName('xhigh'), 'Extra high');
  assert.equal(effortName('other'), 'other');
});

test('isEffort accepts the SDK levels only', () => {
  for (const level of EFFORTS) assert.equal(isEffort(level), true);
  assert.equal(isEffort('HIGH'), false);
  assert.equal(isEffort(''), false);
  assert.equal(isEffort(null), false);
  assert.equal(isEffort(3), false);
});
