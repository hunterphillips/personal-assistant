// The small markdown reader behind the Goals view (goals.mjs). It knows only
// the shapes the vault's priority and goal notes use; it is not a general
// markdown parser and renders nothing.
//
// splitLines(text) -> [line]
//   Drops a leading byte order mark, then splits on \n, dropping a trailing
//   \r from each line.
//
// parseFrontmatter(lines) -> { fields, bodyStart }
//   The block between a `---` on line 1 and the next `---` line. A key's
//   value is the raw text after the first `: `, trimmed; nothing is parsed as
//   YAML, so `#` is not a comment. With no opening or closing `---`, fields
//   is {} and bodyStart is 0.
//
// parseBlocks(lines, start) -> [block]
//   Blocks from line index `start` on, each carrying the line range it came
//   from (`start`, `end`, inclusive) and its raw, unflattened text:
//     { type: 'h', level, raw, start, end }
//     { type: 'p', raw, start, end }
//     { type: 'list', ordered, items: [{ raw, start, end }], start, end }
//   Consecutive non-blank lines form one paragraph, joined with single
//   spaces; an ordered-list marker numbered other than 1 continues an open
//   paragraph, as in CommonMark. A blank line ends a block, and so does a
//   thematic break (a line of three or more `-`, `*`, or `_`), which yields
//   nothing. A non-marker line while a list is open continues its last item;
//   a list item indented two or more spaces past the list's first item is
//   nested and folds into the item above it.
//
// flatten(raw) -> text
//   Inline markup to plain text: **x** -> x, `x` -> x (its content is left
//   alone), [[x]] -> x, [[x|y]] -> y, [text](url) -> text. Bare URLs stay.
//
// headingMatches(raw, name)
//   Prefix match, case-insensitive, with a trailing parenthetical ignored:
//   "Top 3 priorities (2026-07-07)" matches "Top 3 priorities".
//
// leadingBold(raw) -> { label, colon, rest } | null
//   The bold span a text starts with. `colon` is true when a colon closes
//   the label, inside or just outside the bold; it is removed from `label`
//   and from `rest`. `rest` is trimmed.
//
// slugify(text) -> slug
//   Lowercase, runs of non-alphanumerics to one hyphen, hyphens trimmed, at
//   most 60 characters; "item" when nothing remains.

const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*$/;
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const THEMATIC_BREAK = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const SLUG_MAX = 60;

export function splitLines(text) {
  return text.replace(/^\uFEFF/, '').split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
}

export function parseFrontmatter(lines) {
  if (lines[0]?.trimEnd() !== '---') return { fields: {}, bodyStart: 0 };
  const close = lines.findIndex((line, index) => index > 0 && line.trimEnd() === '---');
  if (close === -1) return { fields: {}, bodyStart: 0 };
  const fields = {};
  for (const line of lines.slice(1, close)) {
    const at = line.indexOf(': ');
    if (at <= 0) continue;
    const key = line.slice(0, at).trim();
    if (key && !Object.hasOwn(fields, key)) fields[key] = line.slice(at + 2).trim();
  }
  return { fields, bodyStart: close + 1 };
}

function indentOf(whitespace) {
  return whitespace.replace(/\t/g, '    ').length;
}

export function parseBlocks(lines, start = 0) {
  const blocks = [];
  let open = null;
  const close = () => {
    if (!open) return;
    if (open.type === 'p') {
      blocks.push({ type: 'p', raw: open.parts.join(' '), start: open.start, end: open.end });
    } else {
      blocks.push({
        type: 'list',
        ordered: open.ordered,
        items: open.items.map((item) => ({ raw: item.parts.join(' '), start: item.start, end: item.end })),
        start: open.start,
        end: open.end,
      });
    }
    open = null;
  };

  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === '') {
      close();
      continue;
    }
    if (THEMATIC_BREAK.test(line)) {
      close();
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      close();
      blocks.push({ type: 'h', level: heading[1].length, raw: heading[2].replace(/\s+#+$/, ''), start: index, end: index });
      continue;
    }
    const marker = LIST_ITEM.exec(line);
    const startsItem = marker && !(open?.type === 'p' && /\d/.test(marker[2]) && Number.parseInt(marker[2], 10) !== 1);
    if (startsItem) {
      const indent = indentOf(marker[1]);
      const text = marker[3].trim();
      if (open?.type === 'list' && indent >= open.baseIndent + 2) {
        const parent = open.items.at(-1);
        if (text) parent.parts.push(text);
        parent.end = index;
      } else if (open?.type === 'list') {
        open.items.push({ parts: text ? [text] : [], start: index, end: index });
      } else {
        close();
        open = {
          type: 'list',
          ordered: /\d/.test(marker[2]),
          baseIndent: indent,
          items: [{ parts: text ? [text] : [], start: index, end: index }],
          start: index,
          end: index,
        };
      }
      open.end = index;
      continue;
    }
    if (open?.type === 'list') {
      const item = open.items.at(-1);
      item.parts.push(line.trim());
      item.end = index;
      open.end = index;
    } else if (open?.type === 'p') {
      open.parts.push(line.trim());
      open.end = index;
    } else {
      open = { type: 'p', parts: [line.trim()], start: index, end: index };
    }
  }
  close();
  return blocks;
}

function flattenPlain(text) {
  return text
    .replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, '$2')
    .replace(/\[\[([^\]]*)\]\]/g, '$1')
    .replace(/\[([^\]]*)\]\(([^)\s]*)\)/g, '$1')
    .replace(/\*\*(.+?)\*\*/g, '$1');
}

export function flatten(raw) {
  // Code spans are cut out first so their content is left as written.
  return raw
    .split(/(`[^`]*`)/)
    .map((part, index) => (index % 2 === 1 ? part.slice(1, -1) : flattenPlain(part)))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

export function headingMatches(raw, name) {
  const text = flatten(raw).replace(/\s*\([^()]*\)\s*$/, '').toLowerCase();
  return text.startsWith(name.toLowerCase());
}

export function leadingBold(raw) {
  const match = /^\*\*(.+?)\*\*/.exec(raw);
  if (!match) return null;
  let label = match[1].trim();
  let rest = raw.slice(match[0].length);
  let colon = false;
  if (label.endsWith(':')) {
    label = label.slice(0, -1).trim();
    colon = true;
  } else if (/^\s*:/.test(rest)) {
    rest = rest.replace(/^\s*:/, '');
    colon = true;
  }
  return { label, colon, rest: rest.trim() };
}

export function slugify(text) {
  const slug = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug.slice(0, SLUG_MAX).replace(/-+$/, '') || 'item';
}
