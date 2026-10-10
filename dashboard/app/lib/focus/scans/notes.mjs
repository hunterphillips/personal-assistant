// Focus notes scan: walks the Second brain vault (skipping .git and .claude)
// for .md and .txt files modified in the last 3 days, newest first.
// scan({ vault, now, limits }) resolves the validated candidates, or throws
// ScanError('vault_unavailable') when the vault folder is not available. The
// priority notes are standing context for the curator and never candidates.
// Total `text` across all candidates is capped at 20 000 characters; once the
// budget is spent, later candidates still appear but without `text`. It never
// writes anything, the vault included.

import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { checkedCandidates, ScanError } from '../candidates.mjs';

const RECENT_MS = 3 * 24 * 60 * 60 * 1000;
const PER_FILE_TEXT_CAP = 4000;
const TOTAL_TEXT_BUDGET = 20_000;
const MAX_TITLE = 200;
const SKIP_DIRS = new Set(['.git', '.claude']);
const TEXT_EXTENSIONS = new Set(['.md', '.txt']);

function extOf(name) {
  const i = name.lastIndexOf('.');
  return i === -1 ? '' : name.slice(i).toLowerCase();
}

export function firstHeading(text) {
  const m = text.match(/^#{1,6}[ \t]+(.+?)[ \t]*$/m);
  return m ? m[1].trim() : null;
}

export function humanizeRelative(ms) {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function truncate(text, max) {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

async function walk(dir, skipFiles, out) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // permissions or a race: skip silently
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      await walk(join(dir, e.name), skipFiles, out);
      continue;
    }
    if (!e.isFile()) continue;
    if (!TEXT_EXTENSIONS.has(extOf(e.name))) continue;
    const full = join(dir, e.name);
    if (skipFiles.has(full)) continue;
    out.push(full);
  }
}

// Newest first; the text budget goes to the newest notes.
export function applyTextBudget(found) {
  const sorted = [...found].sort((a, b) => b.mtimeMs - a.mtimeMs);
  let remaining = TOTAL_TEXT_BUDGET;
  return sorted.map(({ candidate, text }) => {
    if (text.length <= remaining) {
      remaining -= text.length;
      return { ...candidate, text };
    }
    return candidate;
  });
}

export async function scan({ vault, now = Date.now, limits } = {}) {
  const root = vault.root();
  if (!root) throw new ScanError('vault_unavailable', 'The vault folder is not available.');
  const nowMs = typeof now === 'function' ? now() : Number(now);

  const files = [];
  await walk(root, new Set(vault.priorityFiles()), files);

  const found = [];
  for (const filePath of files) {
    let st;
    try {
      st = await stat(filePath);
    } catch {
      continue;
    }
    const ageMs = nowMs - st.mtimeMs;
    if (ageMs > RECENT_MS) continue;

    let content;
    try {
      content = await readFile(filePath, 'utf8');
    } catch {
      continue; // unreadable: skip silently
    }

    found.push({
      mtimeMs: st.mtimeMs,
      text: content.slice(0, PER_FILE_TEXT_CAP),
      candidate: {
        title: truncate(firstHeading(content) || basename(filePath), MAX_TITLE),
        source: 'notes',
        external_id: filePath,
        link: null,
        meta: `note · edited ${humanizeRelative(ageMs)}`,
      },
    });
  }

  // The validator allows at most focusCandidatesMax; the newest notes stay.
  const candidates = applyTextBudget(found).slice(0, limits.focusCandidatesMax);
  return checkedCandidates(candidates, limits);
}
