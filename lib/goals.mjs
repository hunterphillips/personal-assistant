// Goals: a read-only view of the priorities and goal notes in Hunter's vault.
// The vault root is the cwd of the registry agent `agentId` whose kind is
// "persona"; an agent of any other kind counts as absent. Three sources, all
// under that root:
//
//   notes/current-priorities.md   Now, Later, and Not now
//   notes/longterm-priorities.md  Long term: principle, Top 3, horizons
//   notes/goals/*.md              one goal per regular .md file directly in
//                                 the directory, sorted by name, at most
//                                 limits.goalsNotes; symlinks, directories,
//                                 and anything else are skipped
//
// The module never writes and runs nothing on a timer: the caller reads on
// demand. Markdown handling is in goals-markdown.mjs.
//
// createGoals({ registry, agentId = 'second-brain', limits, log }) returns:
//
//   read() -> Promise<result>
//     Never rejects. Single-flight: calls made while a read is running share
//     it. Cached by signature: the vault root, the lstat (type, mtimeMs,
//     size) of the two notes and of every goal note read, and the sorted
//     name list of notes/goals/. When the signature is unchanged the last
//     result object is returned without re-reading any file.
//
//     result, deeply frozen:
//       { agentId, readAt, problems: [sentence],
//         sections: [
//           { id: 'now', title: 'Now', source, updated,
//             items: [{ id, title, now, why, prose }] },
//           { id: 'later', title: 'Later', source, updated, items: [{ id, title, prose }] },
//           { id: 'not-now', title: 'Not now', source, updated, items: [{ id, title, prose }] },
//           { id: 'long-term', title: 'Long term', source, updated, principle,
//             items: [{ id, title }], horizons: [{ label, text }] },
//           { id: 'goals', title: 'Goals',
//             items: [{ id, title, horizon, what, why, prose, source, updated }] } ] }
//     - The five sections are always present, in this order; their items are
//       empty when a source is missing or the agent is absent.
//     - `source` is vault-relative; `updated` is the note's frontmatter
//       `updated`, else `created`, else null.
//     - `prose` is a list of blocks: { type: 'p', text }, { type: 'list',
//       items: [text] }, or { type: 'h', text }, inline markup flattened.
//     - When the agent is absent, agentId is null, problems holds one
//       sentence, and nothing is read.
//     - Each problem is one sentence naming the vault-relative path: a
//       missing file or directory, a file that is not regular or is over
//       limits.goalsFileBytes (checked from lstat and again on the bytes
//       read), more goal notes than limits.goalsNotes, and a section that
//       parses to nothing from a file that exists.
//
//   find(id) -> Promise<{ id, title, source, text } | null>
//     Reads (through the cache) and returns the item with that id, or null.
//     `text` is the item's original lines: a Now item's heading through the
//     line before the next `##`; a list item's lines, continuations
//     included; a goal note's body after the frontmatter. It is cut at
//     4 KiB on a line boundary, ending with the line
//     "(cut; the rest is in the file)". An untitled Later or Not now item's
//     title is its first six words.
//
// Ids: `now:`, `later:`, `not-now:`, `long-term:` plus a slug of the title
// (an untitled item's first six words), `goal:` plus a slug of the file
// stem; a repeated slug within a group gets `-2`, `-3`.
//
// Unexpected read failures (anything but a missing path or a non-regular
// file) are logged as { event: 'goals_read_error', path, error } and become
// a problem sentence.

import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import path from 'node:path';

import {
  flatten, headingMatches, leadingBold, parseBlocks, parseFrontmatter, slugify, splitLines,
} from './goals-markdown.mjs';

const CURRENT = 'notes/current-priorities.md';
const LONG_TERM = 'notes/longterm-priorities.md';
const GOALS_DIR = 'notes/goals';
const FIND_TEXT_BYTES = 4 * 1024;
const CUT_LINE = '(cut; the rest is in the file)';
const SEPARATOR = /^[—–:-]\s*/;

export function createGoals({ registry, agentId = 'second-brain', limits, log = () => {} }) {
  let cache = null; // { signature, result, index }
  let inFlight = null;

  async function load() {
    const agent = (registry.current()?.agents ?? [])
      .find((entry) => entry.id === agentId && entry.kind === 'persona');
    if (!agent) {
      if (cache?.signature === 'absent') return cache.result;
      const result = assemble({
        agentId: null,
        problems: [`Goals needs a persona named ${agentId} in the registry.`],
        current: null,
        longTerm: null,
        goals: [],
      });
      cache = { signature: 'absent', result: result.result, index: result.index };
      return cache.result;
    }

    const root = agent.cwd;
    const scan = await scanSources(root, limits, log);
    const signature = JSON.stringify([root, scan.current, scan.longTerm, scan.goals]);
    if (cache?.signature === signature) return cache.result;

    const problems = [...scan.problems];
    const readNote = (rel, stats) => readSource(root, rel, stats, limits.goalsFileBytes, problems, log);
    const currentText = await readNote(CURRENT, scan.current);
    const longTermText = await readNote(LONG_TERM, scan.longTerm);
    const current = currentText === null ? null : parseCurrent(currentText, problems);
    const longTerm = longTermText === null ? null : parseLongTerm(longTermText, problems);
    const goals = [];
    for (const file of scan.goals.files) {
      const rel = `${GOALS_DIR}/${file.name}`;
      const text = await readNote(rel, file.stats);
      if (text !== null) goals.push(parseGoal(text, rel, file.name.slice(0, -'.md'.length)));
    }

    const built = assemble({ agentId, problems, current, longTerm, goals });
    cache = { signature, result: built.result, index: built.index };
    return cache.result;
  }

  async function safeLoad() {
    try {
      return await load();
    } catch (error) {
      log({ event: 'goals_read_error', path: null, error: error?.message ?? String(error) });
      return assemble({ agentId, problems: ['The vault could not be read.'], current: null, longTerm: null, goals: [] }).result;
    }
  }

  function read() {
    if (!inFlight) inFlight = safeLoad().finally(() => { inFlight = null; });
    return inFlight;
  }

  async function find(id) {
    await read();
    return cache?.index.get(id) ?? null;
  }

  return { read, find };
}

// lstat of every source and the goals directory's listing; this is all the
// signature needs, and everything is cheap.
async function scanSources(root, limits, log) {
  const problems = [];
  const current = await statOf(path.join(root, CURRENT));
  const longTerm = await statOf(path.join(root, LONG_TERM));
  const goals = { state: 'ok', names: [], files: [] };
  let entries = [];
  try {
    entries = await readdir(path.join(root, GOALS_DIR), { withFileTypes: true });
  } catch (error) {
    goals.state = error.code === 'ENOENT' ? 'missing' : error.code === 'ENOTDIR' ? 'not-dir' : 'error';
    if (goals.state === 'error') log({ event: 'goals_read_error', path: GOALS_DIR, error: error?.message ?? String(error) });
    problems.push(goals.state === 'missing' ? `${GOALS_DIR} is missing.`
      : goals.state === 'not-dir' ? `${GOALS_DIR} is not a directory.` : `${GOALS_DIR} could not be read.`);
  }
  goals.names = entries.map((entry) => entry.name).sort(compareStrings);
  const listed = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.md') && entry.name.length > 3)
    .map((entry) => entry.name).sort(compareStrings);
  if (listed.length > limits.goalsNotes) {
    problems.push(`${GOALS_DIR} has ${listed.length} notes; only the first ${limits.goalsNotes} by name are shown.`);
  }
  for (const name of listed.slice(0, limits.goalsNotes)) {
    goals.files.push({ name, stats: await statOf(path.join(root, GOALS_DIR, name)) });
  }
  return { current, longTerm, goals, problems };
}

async function statOf(file) {
  try {
    const stats = await lstat(file);
    return { kind: stats.isFile() ? 'file' : 'other', mtimeMs: stats.mtimeMs, size: stats.size };
  } catch (error) {
    return { kind: error.code === 'ENOENT' || error.code === 'ENOTDIR' ? 'missing' : 'error', code: error.code ?? null };
  }
}

// The note's text, or null with a problem pushed. Opened without following a
// symlink and read to at most one byte past the cap.
async function readSource(root, rel, stats, maxBytes, problems, log) {
  const tooLarge = `${rel} is larger than ${Math.floor(maxBytes / 1024)} KiB.`;
  if (stats.kind === 'missing') return pushNull(problems, `${rel} is missing.`);
  if (stats.kind === 'other') return pushNull(problems, `${rel} is not a regular file.`);
  if (stats.kind === 'file' && stats.size > maxBytes) return pushNull(problems, tooLarge);
  let handle;
  try {
    handle = await open(path.join(root, rel), constants.O_RDONLY | constants.O_NOFOLLOW);
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > maxBytes) return pushNull(problems, tooLarge);
    return buffer.subarray(0, length).toString('utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return pushNull(problems, `${rel} is missing.`);
    if (error.code === 'ELOOP' || error.code === 'EISDIR') return pushNull(problems, `${rel} is not a regular file.`);
    log({ event: 'goals_read_error', path: rel, error: error?.message ?? String(error) });
    return pushNull(problems, `${rel} could not be read.`);
  } finally {
    await handle?.close().catch(() => {});
  }
}

function pushNull(problems, sentence) {
  problems.push(sentence);
  return null;
}

// Level-2 sections, each with its heading block, the blocks under it, and
// the last line before the next heading of level 1 or 2.
function sectionsOf(blocks, lineCount) {
  const sections = [];
  let open = null;
  for (const block of blocks) {
    if (block.type === 'h' && block.level <= 2) {
      if (open) open.end = block.start - 1;
      open = block.level === 2 ? { heading: block, blocks: [], end: lineCount - 1 } : null;
      if (open) sections.push(open);
    } else if (open) {
      open.blocks.push(block);
    }
  }
  return sections;
}

function linesText(lines, start, end) {
  const slice = lines.slice(start, end + 1);
  while (slice.length > 0 && slice.at(-1).trim() === '') slice.pop();
  while (slice.length > 0 && slice[0].trim() === '') slice.shift();
  return slice.join('\n');
}

function proseBlock(block) {
  if (block.type === 'list') return { type: 'list', items: block.items.map((item) => flatten(item.raw)) };
  return { type: block.type, text: flatten(block.raw) };
}

function firstWords(text) {
  return text.split(/\s+/).filter(Boolean).slice(0, 6).join(' ');
}

function parseNote(text) {
  const lines = splitLines(text);
  const { fields, bodyStart } = parseFrontmatter(lines);
  const blocks = parseBlocks(lines, bodyStart);
  return { lines, fields, bodyStart, blocks, updated: fields.updated || fields.created || null };
}

function parseCurrent(text, problems) {
  const note = parseNote(text);
  const sections = sectionsOf(note.blocks, note.lines.length);
  const now = [];
  for (const section of sections) {
    const numbered = /^\d+[.)]\s+(.+)$/.exec(flatten(section.heading.raw));
    if (!numbered) continue;
    let nowText = null;
    let why = null;
    const prose = [];
    for (const block of section.blocks) {
      if (block.type !== 'list') {
        prose.push(proseBlock(block));
        continue;
      }
      const kept = [];
      for (const item of block.items) {
        const bold = leadingBold(item.raw);
        const label = bold?.colon ? bold.label.toLowerCase() : null;
        if (label === 'now' && nowText === null) nowText = flatten(bold.rest);
        else if (label === 'why' && why === null) why = flatten(bold.rest);
        else kept.push(flatten(item.raw));
      }
      if (kept.length > 0) prose.push({ type: 'list', items: kept });
    }
    now.push({
      item: { title: numbered[1], now: nowText, why, prose },
      text: linesText(note.lines, section.heading.start, section.end),
    });
  }
  if (now.length === 0) problems.push(`${CURRENT} has no numbered priorities.`);
  return {
    updated: note.updated,
    now,
    later: listGroup(note, sections, 'Later', problems),
    notNow: listGroup(note, sections, 'Deliberately not now', problems),
  };
}

// One item per top-level list item under the named heading.
function listGroup(note, sections, heading, problems) {
  const section = sections.find((candidate) => headingMatches(candidate.heading.raw, heading));
  if (!section) {
    problems.push(`${CURRENT} has no ${heading} section.`);
    return [];
  }
  const items = [];
  for (const block of section.blocks) {
    if (block.type !== 'list') continue;
    for (const listItem of block.items) {
      const bold = leadingBold(listItem.raw);
      let title = null;
      let body = flatten(listItem.raw);
      if (bold && bold.label) {
        title = flatten(bold.label);
        body = flatten(bold.colon ? bold.rest : bold.rest.replace(SEPARATOR, ''));
      }
      items.push({
        item: { title, prose: body ? [{ type: 'p', text: body }] : [] },
        slugSource: title ?? firstWords(flatten(listItem.raw)),
        text: linesText(note.lines, listItem.start, listItem.end),
      });
    }
  }
  if (items.length === 0) problems.push(`${CURRENT} has no items under ${heading}.`);
  return items;
}

function parseLongTerm(text, problems) {
  const note = parseNote(text);
  const sections = sectionsOf(note.blocks, note.lines.length);

  let principle = null;
  for (const block of note.blocks) {
    if (block.type !== 'p') continue;
    const bold = leadingBold(block.raw);
    if (!bold || !bold.label.toLowerCase().startsWith('guiding principle')) continue;
    const quoted = /"([^"]+)"|“([^”]+)”/.exec(bold.rest);
    principle = quoted ? flatten(quoted[1] ?? quoted[2]) : null;
    break;
  }

  const items = [];
  const top = sections.find((section) => headingMatches(section.heading.raw, 'Top 3 priorities'));
  const lists = top ? top.blocks.filter((block) => block.type === 'list') : [];
  const list = lists.find((block) => block.ordered) ?? lists[0];
  for (const listItem of list?.items ?? []) {
    items.push({ item: { title: flatten(listItem.raw) }, text: linesText(note.lines, listItem.start, listItem.end) });
  }
  if (items.length === 0) problems.push(`${LONG_TERM} has no Top 3 priorities section.`);

  const horizons = [];
  const horizonSection = sections.find((section) => headingMatches(section.heading.raw, 'Horizons'));
  for (const block of horizonSection?.blocks ?? []) {
    if (block.type !== 'list') continue;
    for (const listItem of block.items) {
      const bold = leadingBold(listItem.raw);
      if (bold?.colon && bold.label) horizons.push({ label: flatten(bold.label), text: flatten(bold.rest) });
    }
  }
  if (horizons.length === 0) problems.push(`${LONG_TERM} has no Horizons section.`);

  return { updated: note.updated, principle, items, horizons };
}

function parseGoal(text, rel, stem) {
  const note = parseNote(text);
  let title = null;
  let what = null;
  let why = null;
  const prose = [];
  for (const block of note.blocks) {
    if (block.type === 'h' && block.level === 1 && title === null) {
      title = flatten(block.raw);
      continue;
    }
    if (block.type === 'p') {
      const bold = leadingBold(block.raw);
      const label = bold?.colon ? bold.label.toLowerCase() : null;
      if (label === 'what' && what === null) {
        what = flatten(bold.rest);
        continue;
      }
      if (label === 'why' && why === null) {
        why = flatten(bold.rest);
        continue;
      }
    }
    prose.push(proseBlock(block));
  }
  return {
    item: {
      title: title || stem,
      horizon: note.fields.horizon || null,
      what,
      why,
      prose,
      source: rel,
      updated: note.updated,
    },
    slugSource: stem,
    text: linesText(note.lines, note.bodyStart, note.lines.length - 1),
  };
}

// Gives every item its id, builds the find() index, and freezes the result.
function assemble({ agentId, problems, current, longTerm, goals }) {
  const index = new Map();
  const identify = (group, entries, source) => {
    const seen = new Map();
    return entries.map((entry) => {
      const slug = slugify(entry.slugSource ?? entry.item.title ?? '');
      const count = (seen.get(slug) ?? 0) + 1;
      seen.set(slug, count);
      const id = `${group}:${slug}${count > 1 ? `-${count}` : ''}`;
      index.set(id, Object.freeze({
        id,
        title: entry.item.title ?? entry.slugSource,
        source: source ?? entry.item.source,
        text: cutText(entry.text),
      }));
      return { id, ...entry.item };
    });
  };
  const result = {
    agentId,
    readAt: new Date().toISOString(),
    problems,
    sections: [
      { id: 'now', title: 'Now', source: CURRENT, updated: current?.updated ?? null,
        items: identify('now', current?.now ?? [], CURRENT) },
      { id: 'later', title: 'Later', source: CURRENT, updated: current?.updated ?? null,
        items: identify('later', current?.later ?? [], CURRENT) },
      { id: 'not-now', title: 'Not now', source: CURRENT, updated: current?.updated ?? null,
        items: identify('not-now', current?.notNow ?? [], CURRENT) },
      { id: 'long-term', title: 'Long term', source: LONG_TERM, updated: longTerm?.updated ?? null,
        principle: longTerm?.principle ?? null,
        items: identify('long-term', longTerm?.items ?? [], LONG_TERM),
        horizons: longTerm?.horizons ?? [] },
      { id: 'goals', title: 'Goals', items: identify('goal', goals, null) },
    ],
  };
  return { result: deepFreeze(result), index };
}

function cutText(text) {
  if (Buffer.byteLength(text) <= FIND_TEXT_BYTES) return text;
  const budget = FIND_TEXT_BYTES - Buffer.byteLength(CUT_LINE) - 1;
  const kept = [];
  let used = 0;
  for (const line of text.split('\n')) {
    const cost = Buffer.byteLength(line) + 1;
    if (used + cost > budget) break;
    kept.push(line);
    used += cost;
  }
  if (kept.length === 0) {
    // One line longer than the budget: keep as many whole characters as fit.
    let partial = '';
    let bytes = 0;
    for (const char of text) {
      bytes += Buffer.byteLength(char);
      if (bytes + 1 > budget) break;
      partial += char;
    }
    kept.push(partial);
  }
  return [...kept, CUT_LINE].join('\n');
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function compareStrings(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}
