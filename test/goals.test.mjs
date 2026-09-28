import assert from 'node:assert/strict';
import { cp, mkdir, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { LIMITS } from '../lib/config.mjs';
import { createGoals } from '../lib/goals.mjs';
import { tempDir } from './support/harness.mjs';

const FIXTURE_VAULT = fileURLToPath(new URL('./fixtures/vault/', import.meta.url));
const CURRENT = 'notes/current-priorities.md';
const LONG_TERM = 'notes/longterm-priorities.md';

function persona(cwd, overrides = {}) {
  return { id: 'second-brain', name: 'Second brain', kind: 'persona', cwd, provider: 'claude', routines: [], ...overrides };
}

// A registry whose agents can be swapped between reads.
function fakeRegistry(agents) {
  const registry = { agents, current: () => ({ ok: true, agents: registry.agents }) };
  return registry;
}

// A fresh copy of the fixture vault in a temp dir, so tests can change it.
async function vaultCopy(t) {
  const root = path.join(await tempDir(t), 'vault');
  await cp(FIXTURE_VAULT, root, { recursive: true });
  return root;
}

function goalsFor(root, { limits = LIMITS, log = () => {}, agents } = {}) {
  const registry = fakeRegistry(agents ?? [persona(root)]);
  return { goals: createGoals({ registry, limits, log }), registry };
}

function section(result, id) {
  return result.sections.find((entry) => entry.id === id);
}

function mentions(problems, needle) {
  return problems.filter((sentence) => sentence.includes(needle));
}

test('the fixture vault reads with no problems and the five sections in order', async (t) => {
  const root = await vaultCopy(t);
  const logs = [];
  const { goals } = goalsFor(root, { log: (entry) => logs.push(entry) });
  const result = await goals.read();
  assert.equal(result.agentId, 'second-brain');
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.sections.map((entry) => entry.id), ['now', 'later', 'not-now', 'long-term', 'goals']);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.sections[0].items[0].prose));
  assert.ok(!Number.isNaN(Date.parse(result.readAt)));
  assert.deepEqual(logs, []);
});

test('Now items take Now and Why out of their list and keep everything else in order', async (t) => {
  const { goals } = goalsFor(await vaultCopy(t));
  const now = section(await goals.read(), 'now');
  assert.equal(now.source, CURRENT);
  assert.equal(now.updated, '2026-03-04');
  const [garden, cello] = now.items;
  assert.equal(garden.id, 'now:ship-the-garden-planner');
  assert.equal(garden.title, 'Ship the garden planner');
  // Two- and three-space continuation lines join the item with one space.
  assert.equal(garden.now, 'sketch the three beds and order seeds before the frost date.');
  assert.equal(garden.why, 'fresh food from the yard by early summer.');
  assert.deepEqual(garden.prose, [
    // Wikilink alias and inline code flattened; the bare URL stays as text.
    { type: 'p', text: 'Plan the beds with the garden notes and run plan --dry first. Layout at https://example.com/beds for now.' },
    { type: 'list', items: ['A nested thought: folded into its parent', 'Keep the compost bin level.'] },
  ]);
  assert.equal(cello.now, 'finish the second etude.');
  assert.equal(cello.why, null);
  assert.deepEqual(cello.prose, [
    { type: 'p', text: 'Practise twenty minutes a day.' },
    { type: 'list', items: ['Book a lesson.'] },
  ]);
});

test('Later and Not now take bold titles and drop one separator', async (t) => {
  const { goals } = goalsFor(await vaultCopy(t));
  const result = await goals.read();
  const later = section(result, 'later').items;
  assert.deepEqual(later.map((item) => [item.id, item.title, item.prose]), [
    ['later:pottery-class', 'Pottery class', [{ type: 'p', text: 'sign up for the spring term at the community studio.' }]],
    ['later:kayak-trip', 'Kayak trip', [{ type: 'p', text: 'pick a river in May.' }]],
    ['later:bread', 'Bread', [{ type: 'p', text: 'learn a sourdough starter.' }]],
    ['later:reorganise-the-garage-shelves-one-weekend', null,
      [{ type: 'p', text: 'Reorganise the garage shelves one weekend soon.' }]],
  ]);
  const notNow = section(result, 'not-now').items;
  // The hyphens in a date after an em dash stay.
  assert.deepEqual(notNow.map((item) => [item.title, item.prose[0].text]), [
    ['Second language', '2026-10-01 at the earliest.'],
    ['Home studio', 'not until the cello sticks.'],
  ]);
});

test('Long term reads the quoted principle, the Top 3 list under a dated heading, and the horizons', async (t) => {
  const { goals } = goalsFor(await vaultCopy(t));
  const longTerm = section(await goals.read(), 'long-term');
  assert.equal(longTerm.source, LONG_TERM);
  assert.equal(longTerm.updated, '2026-02-03');
  assert.equal(longTerm.principle, 'Make things by hand and share them with friends.');
  assert.deepEqual(longTerm.items.map((item) => item.title), [
    'A workshop of my own',
    'Steady savings (or a path to them)',
    'A garden that feeds the household most of the year',
  ]);
  assert.equal(longTerm.items[0].id, 'long-term:a-workshop-of-my-own');
  // Colon outside and inside the bold label; an unlabeled item is skipped.
  assert.deepEqual(longTerm.horizons, [
    { label: '1 yr', text: 'a finished garden.' },
    { label: '5 yrs', text: 'a small workshop.' },
  ]);
});

test('a principle in curly quotes reads the same', async (t) => {
  const root = await vaultCopy(t);
  const file = path.join(root, LONG_TERM);
  const text = await readFile(file, 'utf8');
  await writeFile(file, text.replace('"Make things by hand', '“Make things by hand').replace('friends."', 'friends.”'));
  const { goals } = goalsFor(root);
  assert.equal(section(await goals.read(), 'long-term').principle, 'Make things by hand and share them with friends.');
});

test('goal notes list regular .md files by name and skip everything else', async (t) => {
  const root = await vaultCopy(t);
  await symlink(path.join(root, 'notes/goals/boat.md'), path.join(root, 'notes/goals/alias.md'));
  const { goals } = goalsFor(root);
  const result = await goals.read();
  assert.deepEqual(result.problems, []);
  const items = section(result, 'goals').items;
  assert.deepEqual(items.map((item) => item.id), ['goal:bee-keeping', 'goal:boat', 'goal:untitled-idea', 'goal:zine']);

  const [bees, boat, untitled, zine] = items;
  assert.equal(bees.title, 'Bee keeping');
  assert.equal(bees.source, 'notes/goals/bee-keeping.md');
  assert.equal(bees.updated, '2026-02-10');
  assert.equal(bees.horizon, 'long-term #someday'); // `#` is not a comment
  assert.equal(bees.what, 'keep two hives in the back corner of the garden.');
  assert.equal(bees.why, 'pollination and honey.');
  assert.deepEqual(bees.prose, [
    { type: 'p', text: 'Read bee-basics and try hive --check each week.' },
    { type: 'h', text: 'First steps' },
    { type: 'list', items: ['Find a local club.', 'Buy a suit.'] },
  ]);

  // Missing Why: still listed, the field is null; updated falls back to created.
  assert.equal(boat.what, 'a small wooden rowing boat.');
  assert.equal(boat.why, null);
  assert.equal(boat.updated, '2026-02-05');

  assert.equal(untitled.title, 'untitled-idea');
  assert.equal(untitled.horizon, null);

  // Neither label: both null, headings kept as h blocks.
  assert.equal(zine.what, null);
  assert.equal(zine.why, null);
  assert.deepEqual(zine.prose.map((block) => block.type), ['p', 'h', 'p', 'h', 'p']);
  assert.deepEqual(zine.prose[1], { type: 'h', text: 'Issue one' });
});

test('file order wins over the usual section order, and repeated titles get -2', async (t) => {
  const root = await vaultCopy(t);
  await writeFile(path.join(root, CURRENT), [
    '## Deliberately not now', '', '- **Same** — one', '- **Same** — two', '',
    '## 2. Repeat', '', 'Second in the file.', '',
    '## Later', '', '- Plain item', '',
    '## 1. Repeat', '', 'Fourth in the file.', '',
  ].join('\n'));
  const { goals } = goalsFor(root);
  const result = await goals.read();
  const now = section(result, 'now').items;
  assert.deepEqual(now.map((item) => [item.id, item.prose[0].text]), [
    ['now:repeat', 'Second in the file.'],
    ['now:repeat-2', 'Fourth in the file.'],
  ]);
  assert.deepEqual(section(result, 'not-now').items.map((item) => item.id), ['not-now:same', 'not-now:same-2']);
  assert.deepEqual(section(result, 'later').items.map((item) => item.id), ['later:plain-item']);
  assert.equal(section(result, 'now').updated, null);
});

test('an empty notes/goals lists nothing; a missing one is one problem', async (t) => {
  const root = await vaultCopy(t);
  await rm(path.join(root, 'notes/goals'), { recursive: true });
  await mkdir(path.join(root, 'notes/goals'));
  const empty = await goalsFor(root).goals.read();
  assert.deepEqual(empty.problems, []);
  assert.deepEqual(section(empty, 'goals').items, []);

  await rm(path.join(root, 'notes/goals'), { recursive: true });
  const missing = await goalsFor(root).goals.read();
  assert.equal(missing.problems.length, 1);
  assert.equal(mentions(missing.problems, 'notes/goals').length, 1);
  assert.equal(section(missing, 'now').items.length, 2);
});

test('a missing priorities file is one problem and the rest still parses', async (t) => {
  const root = await vaultCopy(t);
  await rm(path.join(root, CURRENT));
  const result = await goalsFor(root).goals.read();
  assert.equal(result.problems.length, 1);
  assert.equal(mentions(result.problems, CURRENT).length, 1);
  for (const id of ['now', 'later', 'not-now']) assert.deepEqual(section(result, id).items, []);
  assert.equal(section(result, 'long-term').items.length, 3);
  assert.equal(section(result, 'goals').items.length, 4);
});

test('a section that parses to nothing is a problem naming its file', async (t) => {
  const root = await vaultCopy(t);
  await writeFile(path.join(root, LONG_TERM), '# Long-term priorities\n\n## Horizons\n\n- **1 yr**: something.\n');
  const result = await goalsFor(root).goals.read();
  assert.equal(result.problems.length, 1);
  assert.equal(mentions(result.problems, LONG_TERM).length, 1);
  assert.equal(section(result, 'long-term').horizons.length, 1);
});

test('a missing Later, Deliberately not now, Horizons, or principle is not a problem', async (t) => {
  const root = await vaultCopy(t);
  await writeFile(path.join(root, CURRENT), '# Current priorities\n\n## 1. Ship the garden planner\n\nDo it.\n');
  await writeFile(path.join(root, LONG_TERM), [
    '# Long-term priorities', '', '## Top 3 priorities', '', '1. A workshop of my own', '',
  ].join('\n'));
  const result = await goalsFor(root).goals.read();
  assert.deepEqual(result.problems, []);
  assert.deepEqual(section(result, 'later').items, []);
  assert.deepEqual(section(result, 'not-now').items, []);
  assert.equal(section(result, 'long-term').principle, null);
  assert.deepEqual(section(result, 'long-term').horizons, []);
});

test('no numbered sections in current-priorities.md is a problem naming that file', async (t) => {
  const root = await vaultCopy(t);
  await writeFile(path.join(root, CURRENT), [
    '# Current priorities', '', '## Later', '', '- Plain item', '',
  ].join('\n'));
  const result = await goalsFor(root).goals.read();
  assert.equal(result.problems.length, 1);
  assert.equal(mentions(result.problems, CURRENT).length, 1);
  assert.deepEqual(section(result, 'now').items, []);
  assert.deepEqual(section(result, 'later').items.map((item) => item.id), ['later:plain-item']);
});

test('a file over the byte cap is one problem and is not read', async (t) => {
  const root = await vaultCopy(t);
  const limits = { ...LIMITS, goalsFileBytes: 2048 };
  await writeFile(path.join(root, 'notes/goals/huge.md'), `# Huge\n\n${'x'.repeat(4096)}\n`);
  const result = await goalsFor(root, { limits }).goals.read();
  assert.equal(result.problems.length, 1);
  assert.equal(mentions(result.problems, 'notes/goals/huge.md').length, 1);
  assert.ok(!section(result, 'goals').items.some((item) => item.id === 'goal:huge'));
  assert.equal(section(result, 'now').items.length, 2);
});

test('more goal notes than the limit reads the first ones by name', async (t) => {
  const root = await vaultCopy(t);
  await rm(path.join(root, 'notes/goals'), { recursive: true });
  await mkdir(path.join(root, 'notes/goals'));
  const count = LIMITS.goalsNotes + 2;
  for (let index = 0; index < count; index += 1) {
    const name = `g${String(index).padStart(3, '0')}`;
    await writeFile(path.join(root, 'notes/goals', `${name}.md`), `# Goal ${index}\n`);
  }
  const result = await goalsFor(root).goals.read();
  const items = section(result, 'goals').items;
  assert.equal(items.length, LIMITS.goalsNotes);
  assert.equal(items[0].id, 'goal:g000');
  assert.equal(items.at(-1).id, `goal:g${String(LIMITS.goalsNotes - 1).padStart(3, '0')}`);
  assert.equal(mentions(result.problems, 'notes/goals').length, 1);
});

test('a second-brain agent that is not a persona, or no agent at all, reads nothing', async (t) => {
  const root = await vaultCopy(t);
  for (const agents of [[persona(root, { kind: 'project' })], [persona(root, { id: 'cfo' })], []]) {
    const result = await goalsFor(root, { agents }).goals.read();
    assert.equal(result.agentId, null);
    assert.equal(result.problems.length, 1);
    assert.ok(result.sections.every((entry) => entry.items.length === 0));
  }
});

test('the cache returns the same object until a source or the vault root changes', async (t) => {
  const root = await vaultCopy(t);
  const { goals, registry } = goalsFor(root);
  const first = await goals.read();
  assert.equal(await goals.read(), first);

  // mtime only.
  const note = path.join(root, 'notes/goals/zine.md');
  await utimes(note, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'));
  const second = await goals.read();
  assert.notEqual(second, first);
  assert.equal(await goals.read(), second);

  // size.
  const current = path.join(root, CURRENT);
  await writeFile(current, `${await readFile(current, 'utf8')}\n`);
  const third = await goals.read();
  assert.notEqual(third, second);

  // A new name in notes/goals.
  await writeFile(path.join(root, 'notes/goals/notes2.txt'), 'x');
  const fourth = await goals.read();
  assert.notEqual(fourth, third);

  // The registry points somewhere else.
  const other = await vaultCopy(t);
  registry.agents = [persona(other)];
  const fifth = await goals.read();
  assert.notEqual(fifth, fourth);
  assert.equal(await goals.read(), fifth);
});

test('concurrent reads share one read', async (t) => {
  const { goals } = goalsFor(await vaultCopy(t));
  const [a, b] = await Promise.all([goals.read(), goals.read()]);
  assert.equal(a, b);
});

test('find returns the original lines of each kind of item', async (t) => {
  const { goals } = goalsFor(await vaultCopy(t));
  const cello = await goals.find('now:learn-the-cello');
  assert.deepEqual(cello, {
    id: 'now:learn-the-cello',
    title: 'Learn the cello',
    source: CURRENT,
    text: '## 2. Learn the cello\n\nPractise twenty minutes a day.\n\n- **Now:** finish the second etude.\n- Book a lesson.',
  });
  assert.ok(Object.isFrozen(cello));

  const pottery = await goals.find('later:pottery-class');
  assert.equal(pottery.text, '- **Pottery class** — sign up for the spring\n  term at the community studio.');

  const untitled = await goals.find('later:reorganise-the-garage-shelves-one-weekend');
  assert.equal(untitled.title, 'Reorganise the garage shelves one weekend');

  const garden = await goals.find('long-term:a-garden-that-feeds-the-household-most-of-the-year');
  assert.equal(garden.source, LONG_TERM);
  assert.equal(garden.text, '3. A garden that feeds the\n   household most of the year');

  const boat = await goals.find('goal:boat');
  assert.deepEqual(boat, {
    id: 'goal:boat',
    title: 'Build a boat',
    source: 'notes/goals/boat.md',
    text: '# Build a boat\n\n**What:** a small wooden rowing boat.\n\nNeeds a garage first.',
  });

  assert.equal(await goals.find('goal:nothing-here'), null);
  assert.equal(await goals.find('now:ship'), null);
});

test('find cuts a long item at 4 KiB on a line boundary', async (t) => {
  const root = await vaultCopy(t);
  const lines = Array.from({ length: 200 }, (_, index) => `Line ${index} ${'y'.repeat(40)}`);
  await writeFile(path.join(root, 'notes/goals/long.md'), `# Long\n\n${lines.join('\n')}\n`);
  const { text } = await goalsFor(root).goals.find('goal:long');
  assert.ok(Buffer.byteLength(text) <= 4096);
  const kept = text.split('\n');
  assert.equal(kept.at(-1), '(cut; the rest is in the file)');
  assert.equal(kept[0], '# Long');
  // Every kept line is whole.
  for (const line of kept.slice(2, -1)) assert.ok(lines.includes(line), line);
});
