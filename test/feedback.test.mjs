import assert from 'node:assert/strict';
import { lstat, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import {
  FeedbackError,
  createFeedbackWriter,
  createKeyedQueue,
  renderFeedbackMarkdown,
  validateFeedbackForArtifact,
  validateFeedbackRequest,
} from '../lib/feedback.mjs';
import { tempDir } from './support/harness.mjs';

const REVISION = 'a'.repeat(64);
const artifact = {
  date: '2026-09-15',
  revision: REVISION,
  items: [
    { id: 'alpha', section: 'Needs you', text: 'Invented item text.', shape: 'text' },
    { id: 'beta', section: 'Money', text: 'Invented legacy line.', shape: 'lede' },
  ],
};

function feedback(overrides = {}) {
  return {
    date: artifact.date,
    revision: REVISION,
    overall: '',
    items: [
      { id: 'alpha', mark: 'approved', note: '' },
      { id: 'beta', mark: null, note: '' },
    ],
    ...overrides,
  };
}

test('feedback validation accepts the exact contract', () => {
  assert.deepEqual(validateFeedbackForArtifact(validateFeedbackRequest(feedback()), artifact), feedback());
});

test('feedback validation rejects unknown fields, bad marks, duplicates, and unknown or missing IDs', () => {
  const invalid = [
    null,
    { ...feedback(), filename: 'viewer-2026-09-15.html' },
    { ...feedback(), date: '../2026-09-15' },
    { ...feedback(), revision: 'A'.repeat(64) },
    { ...feedback(), items: [{ id: 'alpha', mark: 'maybe', note: '' }, feedback().items[1]] },
    { ...feedback(), items: [{ id: 'alpha', mark: null, note: '', markdown: '# injected' }, feedback().items[1]] },
    { ...feedback(), items: [{ id: 'alpha', mark: null, note: '' }, { id: 'alpha', mark: null, note: '' }] },
  ];
  for (const value of invalid) assert.throws(() => validateFeedbackRequest(value), FeedbackError);
  assert.throws(() => validateFeedbackForArtifact(validateFeedbackRequest(feedback({
    items: [{ id: 'alpha', mark: null, note: '' }, { id: 'unknown', mark: null, note: '' }],
  })), artifact), /feedback_items_mismatch/);
  assert.throws(() => validateFeedbackForArtifact(validateFeedbackRequest(feedback({
    items: [{ id: 'alpha', mark: null, note: '' }],
  })), artifact), /feedback_items_mismatch/);
});

test('feedback size limits reject rather than truncate', () => {
  const cases = [
    feedback({ overall: 'x'.repeat(8_001) }),
    feedback({ items: [{ id: 'alpha', mark: null, note: 'x'.repeat(4_001) }, feedback().items[1]] }),
    feedback({ items: Array.from({ length: 201 }, (_, index) => ({ id: `id-${index}`, mark: null, note: '' })) }),
  ];
  for (const value of cases) {
    assert.throws(() => validateFeedbackRequest(value),
      (error) => error instanceof FeedbackError && error.status === 413 && error.code === 'feedback_too_large');
  }
});

test('Markdown uses existing vocabulary, legacy lede text, and indented multiline notes', () => {
  const value = validateFeedbackForArtifact(validateFeedbackRequest(feedback({
    overall: '  Useful overall thought.  ',
    items: [
      { id: 'alpha', mark: 'approved', note: 'First line\nsecond line\n\nlast line' },
      { id: 'beta', mark: 'dismissed', note: '' },
    ],
  })), artifact);
  assert.equal(renderFeedbackMarkdown(artifact, value), [
    '# Brief feedback — 2026-09-15',
    '',
    '## Overall',
    '',
    'Useful overall thought.',
    '',
    '## Needs you',
    '',
    '- APPROVED — Invented item text.',
    '  - note: First line',
    '    second line',
    '    ',
    '    last line',
    '## Money',
    '',
    '- DISMISSED — Invented legacy line.',
    '',
  ].join('\n'));
});

test('whitespace-only notes emit no note line and item text stays on one line', () => {
  const multiline = {
    ...artifact,
    items: [
      { id: 'alpha', section: 'Needs you', text: 'Invented first\nsecond\r\nthird\u2028fourth', shape: 'text' },
      artifact.items[1],
    ],
  };
  const markdown = renderFeedbackMarkdown(multiline, feedback({
    items: [
      { id: 'alpha', mark: 'approved', note: '  \n\t ' },
      { id: 'beta', mark: null, note: '' },
    ],
  }));
  assert.match(markdown, /^- APPROVED — Invented first second third fourth$/m);
  assert.doesNotMatch(markdown, /note:/);
});

test('empty feedback renders every artifact item with no mark and a trailing newline', () => {
  const empty = feedback({
    items: artifact.items.map((item) => ({ id: item.id, mark: null, note: '' })),
  });
  const markdown = renderFeedbackMarkdown(artifact, empty);
  assert.match(markdown, /^# Brief feedback — 2026-09-15\n\n## Needs you\n\n- no mark/);
  assert.match(markdown, /- no mark — Invented legacy line\.\n$/);
});

test('keyed queue runs same-date saves in call order and the later save wins whole', async (t) => {
  const dir = await tempDir(t);
  const writer = createFeedbackWriter(dir);
  const run = createKeyedQueue();
  const first = '# first\n' + 'a'.repeat(200_000);
  const second = '# second\n' + 'b'.repeat(200_000);
  const events = [];
  let releaseFirst;
  const gate = new Promise((resolve) => { releaseFirst = resolve; });
  const saves = Promise.all([
    run('2026-09-15', async () => {
      events.push('first:start');
      await gate;
      await writer.save('2026-09-15', first);
      events.push('first:end');
    }),
    run('2026-09-15', async () => {
      events.push('second:start');
      await writer.save('2026-09-15', second);
      events.push('second:end');
    }),
  ]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['first:start']);
  releaseFirst();
  await saves;
  assert.deepEqual(events, ['first:start', 'first:end', 'second:start', 'second:end']);
  assert.equal(await readFile(path.join(dir, 'feedback-2026-09-15.md'), 'utf8'), second);
  assert.deepEqual((await readdir(dir)).filter((name) => name.endsWith('.tmp')), []);
});

test('keyed queue continues after a failed task and does not block other dates', async () => {
  const run = createKeyedQueue();
  const order = [];
  const failed = run('2026-09-15', async () => { throw new Error('invented failure'); });
  const next = run('2026-09-15', async () => { order.push('same-date'); });
  const other = run('2026-09-14', async () => { order.push('other-date'); });
  await assert.rejects(failed, /invented failure/);
  await Promise.all([next, other]);
  assert.deepEqual(order.sort(), ['other-date', 'same-date']);
});

test('writer derives only the validated feedback filename and creates mode 0600', async (t) => {
  const dir = await tempDir(t);
  const writer = createFeedbackWriter(dir);
  await writer.save('2026-09-15', '# invented\n');
  assert.deepEqual(await readdir(dir), ['feedback-2026-09-15.md']);
  const stats = await lstat(path.join(dir, 'feedback-2026-09-15.md'));
  assert.equal(stats.mode & 0o777, 0o600);
  await assert.rejects(writer.save('../viewer-2026-09-15.html', 'overwrite'), FeedbackError);
  assert.deepEqual(await readdir(dir), ['feedback-2026-09-15.md']);
});

test('symlink feedback target is rejected without following it', async (t) => {
  const dir = await tempDir(t);
  const victim = path.join(dir, 'unrelated.md');
  await writeFile(victim, 'keep me');
  await symlink(victim, path.join(dir, 'feedback-2026-09-15.md'));
  await assert.rejects(createFeedbackWriter(dir).save('2026-09-15', 'replacement'),
    (error) => error.status === 500);
  assert.equal(await readFile(victim, 'utf8'), 'keep me');
});

test('failed rename leaves existing feedback unchanged and cleans only its temporary file', async (t) => {
  const dir = await tempDir(t);
  const target = path.join(dir, 'feedback-2026-09-15.md');
  const unrelated = path.join(dir, '.unrelated.tmp');
  await writeFile(target, 'old feedback');
  await writeFile(unrelated, 'do not clean');
  const writer = createFeedbackWriter(dir, {
    async rename() {
      const error = new Error('invented rename failure');
      error.code = 'EIO';
      throw error;
    },
  });
  await assert.rejects(writer.save('2026-09-15', 'new feedback'),
    (error) => error.status === 500 && error.code === 'feedback_write_failed');
  assert.equal(await readFile(target, 'utf8'), 'old feedback');
  assert.equal(await readFile(unrelated, 'utf8'), 'do not clean');
  assert.deepEqual((await readdir(dir)).filter((name) => name.startsWith('.feedback-')), []);
});

test('a failed exclusive open never unlinks the path it tried to create', async (t) => {
  const dir = await tempDir(t);
  const attempted = [];
  const unlinked = [];
  const writer = createFeedbackWriter(dir, {
    async open(file) {
      attempted.push(file);
      await writeFile(file, 'owned by someone else');
      const error = new Error('invented permission failure');
      error.code = 'EACCES';
      throw error;
    },
    async unlink(file) { unlinked.push(file); },
  });
  await assert.rejects(writer.save('2026-09-15', 'new feedback'),
    (error) => error.status === 500 && error.code === 'feedback_write_failed');
  assert.equal(attempted.length, 1);
  assert.deepEqual(unlinked, []);
  assert.equal(await readFile(attempted[0], 'utf8'), 'owned by someone else');
});

test('repeated temporary-name collisions give up without unlinking existing files', async (t) => {
  const dir = await tempDir(t);
  const attempted = [];
  const unlinked = [];
  const writer = createFeedbackWriter(dir, {
    async open(file) {
      attempted.push(file);
      const error = new Error('invented collision');
      error.code = 'EEXIST';
      throw error;
    },
    async unlink(file) { unlinked.push(file); },
  });
  await assert.rejects(writer.save('2026-09-15', 'new feedback'), (error) => error.status === 500);
  assert.equal(attempted.length, 8);
  assert.deepEqual(unlinked, []);
});
