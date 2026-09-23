// npm run check: syntax-check every .mjs/.js source file, then confirm every
// /assets/<name> the shell references is allowlisted and present in public/.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ASSETS } from '../lib/assets.mjs';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const skip = new Set(['node_modules', '.git', 'var', 'test-results', 'playwright-report']);
const problems = [];

function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (skip.has(entry.name)) return [];
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(mjs|js)$/.test(entry.name) ? [full] : [];
  });
}

const files = sourceFiles(root);
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) problems.push(`syntax: ${path.relative(root, file)}\n${result.stderr.trim()}`);
}

const shell = readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const referenced = new Set([...shell.matchAll(/\/assets\/([^"'\s)?#]+)/g)].map((match) => match[1]));
for (const name of referenced) {
  const asset = Object.hasOwn(ASSETS, name) ? ASSETS[name] : null;
  if (!asset) problems.push(`asset not allowlisted: /assets/${name}`);
  else if (!existsSync(path.join(root, 'public', asset.file))) problems.push(`asset file missing: public/${asset.file}`);
}

if (problems.length > 0) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(`check: ${files.length} source files parse; ${referenced.size} shell asset references resolve`);
