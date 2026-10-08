// The server-side read mark for the newest Daily Brief: one small JSON file,
// written atomically, so a phone and a desk agree on whether the Brief
// button's dot should show. It holds only the date of the newest brief whose
// overlay has been opened; the hub (hub.mjs) compares it against the newest
// brief's own date to decide `unread`. A missing file is never written on
// load, only on the first mark, so a brand-new root has no file and the hub
// treats the newest existing brief as unread until it is opened.
//
// createBriefReads({ file, log }) returns:
//
//   load() -> Promise<void>
//     Reads the file once. A missing file leaves read() answering null; an
//     unreadable or malformed one is logged (brief_reads_invalid) and
//     treated the same, never thrown.
//
//   read() -> string | null
//     The YYYY-MM-DD last marked read, or null before any mark (or load()).
//
//   mark(date) -> Promise<string>
//     Records `date` (a real calendar date; isCalendarDate) as read and
//     writes the file. Throws invalid_date for anything else, and
//     brief_reads_not_loaded if load() has not run.

import { constants } from 'node:fs';
import { chmod, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { isCalendarDate } from './briefs.mjs';
import { atomicWrite } from './threads.mjs';

function parse(raw) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (typeof value.read !== 'string' || !isCalendarDate(value.read)) return null;
  return value.read;
}

export function createBriefReads({ file, log = () => {} }) {
  const target = path.resolve(file);
  const root = path.dirname(target);
  const name = path.basename(target);
  let read = null;
  let loaded = false;
  let write = Promise.resolve();

  async function save() {
    await mkdir(root, { recursive: true, mode: 0o700 });
    await chmod(root, 0o700);
    await atomicWrite(root, name, `${JSON.stringify({ version: 1, read }, null, 2)}\n`);
  }

  function queuedSave() {
    write = write.then(save, save);
    return write;
  }

  return {
    async load() {
      if (loaded) return;
      let raw = null;
      try {
        raw = await readFile(target, { encoding: 'utf8', flag: constants.O_RDONLY | constants.O_NOFOLLOW });
      } catch (error) {
        if (error?.code !== 'ENOENT') log({ event: 'brief_reads_error', error: error?.message ?? String(error) });
      }
      if (raw !== null) {
        const parsed = parse(raw);
        if (parsed === null) log({ event: 'brief_reads_invalid' });
        read = parsed;
      }
      loaded = true;
    },

    read() {
      return read;
    },

    async mark(date) {
      if (!loaded) throw new Error('brief_reads_not_loaded');
      if (!isCalendarDate(date)) throw new Error('invalid_date');
      read = date;
      await queuedSave();
      return read;
    },
  };
}
