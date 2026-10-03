// Per-agent thread read times. The file is one small JSON object written
// atomically because every browser must derive unread from the same state.
// A missing or unreadable entry is seeded to now, so upgrades and newly
// registered agents never light up for old thread history.

import { constants } from 'node:fs';
import { chmod, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { AGENT_ID } from './registry.mjs';
import { atomicWrite } from './threads.mjs';

function validIso(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function parse(raw) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const result = {};
  for (const [id, at] of Object.entries(value)) {
    if (!AGENT_ID.test(id) || !validIso(at)) return null;
    result[id] = at;
  }
  return result;
}

export function createReads({ file, log = () => {}, now = () => new Date() }) {
  const target = path.resolve(file);
  const root = path.dirname(target);
  const name = path.basename(target);
  let values = {};
  let loaded = false;
  let write = Promise.resolve();

  async function save() {
    await mkdir(root, { recursive: true, mode: 0o700 });
    await chmod(root, 0o700);
    await atomicWrite(root, name, `${JSON.stringify(values, null, 2)}\n`);
  }

  function queuedSave() {
    write = write.then(save, save);
    return write;
  }

  async function ensure(ids) {
    if (!loaded) throw new Error('reads_not_loaded');
    const at = now().toISOString();
    let changed = false;
    for (const id of ids) {
      if (!AGENT_ID.test(id) || Object.hasOwn(values, id)) continue;
      values[id] = at;
      changed = true;
    }
    if (changed) await queuedSave();
    return changed;
  }

  return {
    async load(ids = []) {
      if (loaded) return;
      let raw = null;
      try {
        raw = await readFile(target, { encoding: 'utf8', flag: constants.O_RDONLY | constants.O_NOFOLLOW });
      } catch (error) {
        if (error?.code !== 'ENOENT') log({ event: 'thread_reads_error', error: error?.message ?? String(error) });
      }
      const parsed = raw === null ? {} : parse(raw);
      if (raw !== null && !parsed) log({ event: 'thread_reads_invalid' });
      values = parsed ?? {};
      loaded = true;
      const changed = await ensure(ids);
      if (raw === null && !changed) await queuedSave();
    },

    ensure,

    readAt(id) {
      return Object.hasOwn(values, id) ? values[id] : null;
    },

    async mark(id) {
      if (!loaded) throw new Error('reads_not_loaded');
      if (!AGENT_ID.test(id)) throw new Error('invalid_agent_id');
      values[id] = now().toISOString();
      await queuedSave();
      return values[id];
    },

    current() {
      return { ...values };
    },
  };
}
