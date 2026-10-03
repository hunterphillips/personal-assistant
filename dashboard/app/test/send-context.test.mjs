// The quick chat context: its shape, the thread line, and the model's prompt.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DETAIL_MAX, LABEL_MAX, contextLine, contextPrompt, parseContext } from '../lib/send-context.mjs';

test('parseContext keeps a known view with a label and detail, trims them, and drops empty ones', () => {
  assert.deepEqual(parseContext({ view: 'health', label: ' Nightly sync ', detail: 'Outcome: Failed' }), {
    view: 'health', label: 'Nightly sync', detail: 'Outcome: Failed',
  });
  assert.deepEqual(parseContext({ view: 'focus' }), { view: 'focus' });
  assert.deepEqual(parseContext({ view: 'goals', label: '  ', detail: null }), { view: 'goals' });
  assert.deepEqual(parseContext({ view: 'feed', label: 'x'.repeat(LABEL_MAX), detail: 'y'.repeat(DETAIL_MAX) }).view, 'feed');
});

test('parseContext refuses an unknown view, another key, a non-string, or text over its cap', () => {
  for (const bad of [
    null, 'health', [], {}, { view: 'reading' }, { view: 'health', extra: 1 }, { view: 'health', label: 7 },
    { view: 'health', label: 'x'.repeat(LABEL_MAX + 1) }, { view: 'health', detail: 'y'.repeat(DETAIL_MAX + 1) },
  ]) {
    assert.equal(parseContext(bad), null, JSON.stringify(bad));
  }
});

test('the line names the view and the label; the prompt puts the context before the text', () => {
  assert.equal(contextLine({ view: 'health', label: 'Nightly sync' }), 'Sent from Health: Nightly sync');
  assert.equal(contextLine({ view: 'focus' }), 'Sent from Focus.');
  assert.equal(
    contextPrompt({ view: 'health', label: 'Nightly sync', detail: 'Outcome: Failed' }, 'Can you find a fix?'),
    'Hunter sent this from the Health view, looking at: Nightly sync\nOutcome: Failed\n\nCan you find a fix?',
  );
  assert.equal(contextPrompt({ view: 'goals' }, 'Hi'), 'Hunter sent this from the Goals view.\n\nHi');
});
