// Vault: Focus's read-only view of the Second brain persona's working tree.
// createVault({ registry, agentId, limits }) returns the current root, bounded
// priority and project-state context, community senders and groups, and the
// priority paths excluded by the notes scan. Missing or non-persona agents and
// missing or non-directory roots produce null, empty strings, and empty arrays.
// It never writes the vault and never reads profile data.

import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const MAX_BLOCK_CHARS = 12_000;
const PRIORITY_RELATIVE = Object.freeze([
  'notes/current-priorities.md',
  'notes/longterm-priorities.md',
  'notes/communities.md',
]);
const SENDER_RE = /`([^`\s]+@[^`\s]+|@?[a-z0-9.-]+\.[a-z]{2,})`/gi;

export function createVault({ registry, agentId = 'second-brain', limits: _limits }) {
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

  function readProjectState(now = new Date()) {
    const vaultRoot = root();
    if (!vaultRoot) return '';
    const date = now instanceof Date ? now : new Date(now);
    return readBlocks([
      path.join(vaultRoot, 'notes/projects-overview.md'),
      path.join(vaultRoot, `log/audit-${date.toISOString().slice(0, 7)}.md`),
    ]);
  }

  function readCommunities() {
    const files = priorityFiles();
    if (files.length === 0) return '';
    try {
      return readFileSync(files[2], 'utf8');
    } catch {
      return '';
    }
  }

  return Object.freeze({
    root, readPriorities, readProjectState, communitySenders, communityGroups, priorityFiles,
  });
}

function readBlocks(files) {
  const blocks = [];
  for (const file of files) {
    try {
      const text = readFileSync(file, 'utf8').trim().slice(0, MAX_BLOCK_CHARS);
      blocks.push(`--- ${file} ---\n${text}`);
    } catch {
      // One absent context note does not discard the others.
    }
  }
  return blocks.join('\n\n');
}
