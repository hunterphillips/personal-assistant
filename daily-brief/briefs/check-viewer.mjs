#!/usr/bin/env node
// Prove a built viewer parses with the dashboard's real parser.
//
//   node check-viewer.mjs 2026-09-25 [--dir PATH]
//
// Loads viewer-<date>.html from the briefs directory (or --dir) through
// dashboard/app/lib/briefs.mjs and prints one line per item. Exits nonzero on
// any BriefArtifactError. Dev-only; nothing in the dashboard depends on it.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBriefArtifact, BriefArtifactError } from '../../dashboard/app/lib/briefs.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const date = args[0];
const dirFlag = args.indexOf('--dir');
const dir = dirFlag === -1 ? here : args[dirFlag + 1];

if (!date) {
  console.error('usage: check-viewer.mjs YYYY-MM-DD [--dir PATH]');
  process.exit(2);
}

try {
  const artifact = await loadBriefArtifact(dir, date);
  console.log(`viewer-${date}.html parses: ${artifact.items.length} items, revision ${artifact.revision.slice(0, 12)}`);
  for (const item of artifact.items) console.log(`  ${item.section.padEnd(13)} ${item.id}`);
} catch (error) {
  if (error instanceof BriefArtifactError) {
    console.error(`check-viewer: ${error.state} / ${error.code}`);
    process.exit(1);
  }
  throw error;
}
