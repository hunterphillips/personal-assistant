#!/usr/bin/env node
// Prove a built brief loads with the dashboard's real reader.
//
//   node check-viewer.mjs 2026-09-25 [--dir PATH]
//
// Loads brief-<date>.json from the briefs directory (or --dir) through
// dashboard/app/lib/briefs.mjs and prints one line per item. Exits nonzero on
// any BriefArtifactError. Dev-only; nothing in the dashboard depends on it.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBrief, BriefArtifactError } from '../../dashboard/app/lib/briefs.mjs';

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
  const brief = await loadBrief(dir, date);
  const count = brief.sections.reduce((n, s) => n + s.items.length, brief.opening ? 1 : 0);
  console.log(`brief-${date}.json loads: ${count} items, revision ${brief.revision.slice(0, 12)}`);
  if (brief.opening) console.log(`  ${'opening'.padEnd(13)} ${brief.opening.id}`);
  for (const section of brief.sections) {
    for (const item of section.items) console.log(`  ${section.label.slice(0, 12).padEnd(13)} ${item.id}`);
  }
} catch (error) {
  if (error instanceof BriefArtifactError) {
    console.error(`check-viewer: ${error.state} / ${error.code}`);
    process.exit(1);
  }
  throw error;
}
