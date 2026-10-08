// The data root's layout: where each file the product writes lives under the
// root. It imports nothing of the app's, so config.mjs, the installer, and
// the Codex helpers read the same table root.mjs migrates and seeds by.
//
// The root is ~/.personal-assistant/ unless PERSONAL_ASSISTANT_HOME names
// another absolute path (defaultHome()).
//
// layoutPaths(root) -> frozen { key: absolute path }, layout version 1.

import os from 'node:os';
import path from 'node:path';

export const LAYOUT_VERSION = 1;

const LAYOUT = {
  readme: 'README.md',
  layout: 'layout.json',
  lock: 'daemon.lock',
  settings: 'settings.json',
  threadReads: 'thread-reads.json',
  briefReads: 'brief-reads.json',
  registry: 'registry/agents.json',
  routinesDir: 'routines',
  threadsDir: 'threads',
  codexDir: 'codex',
  notificationsDir: 'notifications',
  feedDir: 'feed/items',
  feedInstructions: 'feed/relevance.md',
  ideasDir: 'ideas/items',
  ideasMarks: 'ideas/marks.json',
  ideasInstructions: 'ideas/criteria.md',
  briefsDir: 'briefs',
  contributionsDir: 'briefs/contributions',
  watchDir: 'watch',
  logDir: 'log',
  cacheDir: 'cache',
};

export function defaultHome() {
  return path.join(os.homedir(), '.personal-assistant');
}

export function layoutPaths(root) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw new TypeError('root must be an absolute path');
  const base = path.resolve(root);
  return Object.freeze(Object.fromEntries(Object.entries(LAYOUT).map(([key, rel]) => [key, path.join(base, rel)])));
}
