// Agent avatars: the round picture shown wherever an agent is named. An
// agent's picture is the registry's `avatar` path (relative to its cwd, or
// absolute) when set, otherwise the first of avatar.png, avatar.jpg, and
// avatar.webp found in its cwd. Only PNG, JPEG, and WebP by extension (no
// SVG), at most AVATAR_MAX_BYTES; anything else, a missing file, or a bad
// path is no picture, and the client draws initials instead. An `avatar`
// path that does not resolve does not fall through to the lookup.
//
// The `avatar` path is registry input, which only a hand edit sets (no
// route body carries it), so it may name any file the daemon can read;
// only the extension and the size limit what is served.
//
// inspectAvatar(agent) -> { picture } | { reason } | null
//   Synchronous; stats the file each call, so the hub reads it when the
//   registry loads and on a status refresh, and the route reads it again
//   on each request. No watcher. `picture` is { file, type, mtimeMs, size };
//   `reason` says why a file that was named or found cannot be used:
//   'missing' (an `avatar` path with nothing there), 'wrong_type',
//   'not_a_file', or 'too_large'. null when there is simply no picture.
//
// findAvatar(agent) -> picture | null
//
// readAvatar(agent) -> Promise<{ type, body } | null>
//   The picture's bytes, re-checked against the cap after the read.

import { statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const AVATAR_MAX_BYTES = 512 * 1024;
const LOOKUP = ['avatar.png', 'avatar.jpg', 'avatar.webp'];
const TYPES = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
]);

export function inspectAvatar(agent) {
  if (!agent || typeof agent.cwd !== 'string') return null;
  if (typeof agent.avatar === 'string') return picture(path.resolve(agent.cwd, agent.avatar));
  for (const name of LOOKUP) {
    const file = path.join(agent.cwd, name);
    if (exists(file)) return picture(file);
  }
  return null;
}

export function findAvatar(agent) {
  return inspectAvatar(agent)?.picture ?? null;
}

export async function readAvatar(agent) {
  const found = findAvatar(agent);
  if (!found) return null;
  let body;
  try {
    body = await readFile(found.file);
  } catch {
    return null;
  }
  if (body.length > AVATAR_MAX_BYTES) return null;
  return { type: found.type, body };
}

function picture(file) {
  const type = TYPES.get(path.extname(file).toLowerCase());
  if (!type) return { reason: 'wrong_type' };
  let stats;
  try {
    stats = statSync(file);
  } catch {
    return { reason: 'missing' };
  }
  if (!stats.isFile()) return { reason: 'not_a_file' };
  if (stats.size > AVATAR_MAX_BYTES) return { reason: 'too_large' };
  return { picture: { file, type, mtimeMs: stats.mtimeMs, size: stats.size } };
}

function exists(file) {
  try {
    statSync(file);
    return true;
  } catch {
    return false;
  }
}
