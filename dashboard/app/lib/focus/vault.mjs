// Vault: Focus's read-only view of the Second brain agent's working tree.
// createVault({ registry, agentId, now }) returns the current root, bounded
// priority and project-state context, community senders and groups, and the
// priority paths excluded by the notes scan. A missing agent, one of another
// kind, and a missing or non-directory root produce null, empty strings, and
// empty arrays. Only regular files are read; a symlink or a FIFO reads as
// absent. It never writes the vault and never reads profile data.

import {
  closeSync, constants, fstatSync, openSync, readFileSync, statSync,
} from 'node:fs';
import path from 'node:path';

const MAX_BLOCK_CHARS = 12_000;
const PRIORITY_RELATIVE = Object.freeze([
  'notes/current-priorities.md',
  'notes/longterm-priorities.md',
  'notes/communities.md',
]);
const SENDER_RE = /`([^`\s]+@[^`\s]+|@?[a-z0-9.-]+\.[a-z]{2,})`/gi;

export function createVault({ registry, agentId = 'second-brain', now = () => new Date() }) {
  function root() {
    const agent = (registry.current()?.agents ?? [])
      .find((entry) => entry.id === agentId && entry.kind === 'persona');
    if (!agent?.cwd) return null;
    try {
      return statSync(agent.cwd).isDirectory() ? agent.cwd : null;
    } catch {
      return null;
    }
  }

  function priorityFiles() {
    const vaultRoot = root();
    if (!vaultRoot) return Object.freeze([]);
    return Object.freeze(PRIORITY_RELATIVE.map((relative) => path.join(vaultRoot, relative)));
  }

  function readPriorities() {
    return readBlocks(priorityFiles());
  }

  function communitySenders() {
    const text = readCommunities();
    if (!text) return Object.freeze([]);
    const out = new Set();
    for (const match of text.matchAll(SENDER_RE)) out.add(match[1].replace(/^@/, ''));
    return Object.freeze([...out]);
  }

  function communityGroups() {
    const text = readCommunities();
    if (!text) return Object.freeze([]);
    const blocks = [];
    let current = null;
    for (const line of text.split('\n')) {
      if (/^\s*[-*]\s+/.test(line)) {
        current = { lines: [] };
        blocks.push(current);
      } else if (!current || !/^\s+\S/.test(line)) {
        current = null;
      }
      if (current) current.lines.push(line);
      else blocks.push({ lines: [line] });
    }

    const groups = [];
    const seen = new Set();
    for (const block of blocks) {
      const body = block.lines.join(' ');
      const bold = body.match(/\*\*([^*]+)\*\*/);
      const name = bold ? bold[1].trim() : null;
      for (const match of body.matchAll(SENDER_RE)) {
        const email = match[1].replace(/^@/, '');
        if (seen.has(email)) continue;
        seen.add(email);
        groups.push(Object.freeze({ name, email }));
      }
    }
    return Object.freeze(groups);
  }

  function readProjectState(at = typeof now === 'function' ? now() : now) {
    const vaultRoot = root();
    if (!vaultRoot) return '';
    const date = at instanceof Date ? at : new Date(at);
    return readBlocks([
      path.join(vaultRoot, 'notes/projects-overview.md'),
      path.join(vaultRoot, `log/audit-${date.toISOString().slice(0, 7)}.md`),
    ]);
  }

  function readCommunities() {
    const files = priorityFiles();
    if (files.length === 0) return '';
    return readRegular(files[2]) ?? '';
  }

  return Object.freeze({
    root, readPriorities, readProjectState, communitySenders, communityGroups, priorityFiles,
  });
}

function readBlocks(files) {
  const blocks = [];
  for (const file of files) {
    // One absent context note does not discard the others.
    const text = readRegular(file);
    if (text !== null) blocks.push(`--- ${file} ---\n${text.trim().slice(0, MAX_BLOCK_CHARS)}`);
  }
  return blocks.join('\n\n');
}

// The file's text, or null when it is missing or not a regular file. The open
// neither follows a symlink nor waits on a FIFO's writer.
function readRegular(file) {
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    if (!fstatSync(fd).isFile()) return null;
    return readFileSync(fd, 'utf8');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
