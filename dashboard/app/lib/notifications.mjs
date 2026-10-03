// Notifications: what an agent judged worth Hunter's attention soon, raised
// with the notify tool (delegation.mjs) and shown as a count and a list in
// the header. One file, config.notificationsDir/notifications.jsonl (by
// default notifications/ at the repo root, gitignored because an agent may
// put a figure in a sentence), one JSON line per notification, oldest first:
//
//   { "id": "<uuid>", "agent": "cfo", "text": "One sentence.",
//     "link": "job:com.example.scan" | null, "at": "<ISO>",
//     "acknowledgedAt": "<ISO>" | null }
//
// `link` is null or one of agent:<id>, feed:<run>/<index>, brief:<date>,
// job:<label> (LINK below); the dashboard opens it. Raising appends a line;
// acknowledging and trimming rewrite the whole file atomically. The daemon
// is the file's only writer.
//
// createNotifications({ file, limits, log, now, randomUUID }) returns:
//
//   load() -> Promise<void>
//     Reads the file once; the server calls it before the hub starts. A
//     missing file is no notifications. A line that does not parse or
//     validate is skipped and logged as { event: 'notification_invalid',
//     line, reason }; the next rewrite drops it. Rejects only when the file
//     exists and cannot be read.
//   raise({ agent, text, link }) -> Promise<item>
//     Checks the fields (NotificationError: invalid_agent, empty_text,
//     text_too_long past limits.notificationTextChars, invalid_link), with
//     the text trimmed and its whitespace runs made single spaces, so it
//     stays one line in the list. Appends (dir 0700, file 0600). Past
//     limits.notificationsMax items it trims: oldest acknowledged first,
//     then oldest open, and rewrites the file.
//   acknowledge(ids) -> Promise<number>
//     Sets acknowledgedAt on each open item named; an id already
//     acknowledged is left as it is. Rejects no_such_notification when an
//     id is not retained, and changes nothing then. Answers how many
//     changed; rewrites only when one did.
//   acknowledgeAll() -> Promise<number>
//   view() -> { open, items }          every retained item, newest first,
//                                      and how many are unacknowledged
//   onChange(fn) -> unsubscribe        fn() after a raise or acknowledge that
//                                      changed something
//
// Writes run one at a time, in call order.

import { appendFile, chmod, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID as nodeRandomUUID } from 'node:crypto';

import { LIMITS } from './config.mjs';
import { AGENT_ID } from './registry.mjs';
import { atomicWrite } from './threads.mjs';

export const NOTIFICATION_ID = /^[A-Za-z0-9-]{1,64}$/;
export const NOTIFICATIONS_FILE = 'notifications.jsonl';
const FILE_BYTES = 4 * 1024 * 1024;
const KEYS = ['id', 'agent', 'text', 'link', 'at', 'acknowledgedAt'];

// The targets a link may name. A feed item is its run file's name without
// the extension and its position in that file's items, from 0; a job is
// its launchd label.
const LINK = {
  agent: AGENT_ID,
  feed: /^\d{4}-\d{2}-\d{2}-[a-z][a-z0-9-]*\/\d{1,4}$/,
  brief: /^\d{4}-\d{2}-\d{2}$/,
  job: /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/,
};

export class NotificationError extends Error {
  constructor(code) {
    super(code);
    this.name = 'NotificationError';
    this.code = code;
  }
}

// Whether `link` is null or a target the dashboard can open.
export function validLink(link) {
  if (link === null) return true;
  if (typeof link !== 'string') return false;
  const colon = link.indexOf(':');
  if (colon === -1) return false;
  const kind = link.slice(0, colon);
  return Object.hasOwn(LINK, kind) && LINK[kind].test(link.slice(colon + 1));
}

// The sentence as it is stored: trimmed, on one line.
export function cleanText(text) {
  return typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
}

export function createNotifications({
  file, limits = LIMITS, log = () => {}, now = () => new Date(), randomUUID = nodeRandomUUID,
}) {
  const target = path.resolve(file);
  const root = path.dirname(target);
  const name = path.basename(target);
  const listeners = new Set();
  let items = []; // oldest first, each frozen
  let writing = Promise.resolve();

  function changed() {
    for (const fn of [...listeners]) {
      try {
        fn();
      } catch (error) {
        log({ event: 'notifications_listener_error', error: error?.message ?? String(error) });
      }
    }
  }

  function serialized(task) {
    const run = writing.then(task, task);
    writing = run.catch(() => {});
    return run;
  }

  async function ensureDir() {
    await mkdir(root, { recursive: true, mode: 0o700 });
    await chmod(root, 0o700);
  }

  async function rewrite(next) {
    await ensureDir();
    await atomicWrite(root, name, next.map((item) => `${JSON.stringify(item)}\n`).join(''));
  }

  // At most limits.notificationsMax, dropping the oldest acknowledged items
  // before any open one.
  function trimmed(list) {
    const max = limits.notificationsMax;
    if (list.length <= max) return list;
    let excess = list.length - max;
    const drop = new Set();
    for (const item of list) {
      if (excess === 0) break;
      if (item.acknowledgedAt !== null) {
        drop.add(item);
        excess -= 1;
      }
    }
    for (const item of list) {
      if (excess === 0) break;
      if (!drop.has(item)) {
        drop.add(item);
        excess -= 1;
      }
    }
    return list.filter((item) => !drop.has(item));
  }

  async function load() {
    let text;
    try {
      text = await readFile(target, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    if (Buffer.byteLength(text) > FILE_BYTES) {
      log({ event: 'notification_invalid', line: null, reason: 'too_large' });
      return;
    }
    const loaded = [];
    const seen = new Set();
    text.split('\n').forEach((raw, index) => {
      if (raw.trim() === '') return;
      let value;
      try {
        value = JSON.parse(raw);
      } catch {
        log({ event: 'notification_invalid', line: index + 1, reason: 'bad_json' });
        return;
      }
      const reason = problem(value, seen);
      if (reason) {
        log({ event: 'notification_invalid', line: index + 1, reason });
        return;
      }
      seen.add(value.id);
      loaded.push(Object.freeze(Object.fromEntries(KEYS.map((key) => [key, value[key]]))));
    });
    items = trimmed(loaded);
  }

  function problem(value, seen) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return 'not_an_object';
    if (typeof value.id !== 'string' || !NOTIFICATION_ID.test(value.id) || seen.has(value.id)) return 'bad_id';
    if (typeof value.agent !== 'string' || !AGENT_ID.test(value.agent)) return 'bad_agent';
    const text = cleanText(value.text);
    if (text === '' || text !== value.text || Array.from(text).length > limits.notificationTextChars) return 'bad_text';
    if (!validLink(value.link ?? null) || !('link' in value)) return 'bad_link';
    if (!isIso(value.at)) return 'bad_at';
    if (value.acknowledgedAt !== null && !isIso(value.acknowledgedAt)) return 'bad_acknowledged_at';
    return null;
  }

  function acknowledgeWhere(pick) {
    return serialized(async () => {
      const at = now().toISOString();
      let count = 0;
      const next = items.map((item) => {
        if (item.acknowledgedAt !== null || !pick(item)) return item;
        count += 1;
        return Object.freeze({ ...item, acknowledgedAt: at });
      });
      if (count === 0) return 0;
      await rewrite(next);
      items = next;
      changed();
      return count;
    });
  }

  return {
    load,

    raise({ agent, text, link = null } = {}) {
      return serialized(async () => {
        if (typeof agent !== 'string' || !AGENT_ID.test(agent)) throw new NotificationError('invalid_agent');
        const sentence = cleanText(text);
        if (sentence === '') throw new NotificationError('empty_text');
        if (Array.from(sentence).length > limits.notificationTextChars) throw new NotificationError('text_too_long');
        const opens = link === undefined || link === '' ? null : link;
        if (!validLink(opens)) throw new NotificationError('invalid_link');
        const item = Object.freeze({ id: randomUUID(), agent, text: sentence, link: opens, at: now().toISOString(), acknowledgedAt: null });
        const next = trimmed([...items, item]);
        if (next.length === items.length + 1) {
          await ensureDir();
          await appendFile(target, `${JSON.stringify(item)}\n`, { encoding: 'utf8', mode: 0o600 });
        } else {
          await rewrite(next);
        }
        items = next;
        changed();
        return item;
      });
    },

    acknowledge(ids) {
      const wanted = new Set(Array.isArray(ids) ? ids : [ids]);
      for (const id of wanted) {
        if (!items.some((item) => item.id === id)) return Promise.reject(new NotificationError('no_such_notification'));
      }
      return acknowledgeWhere((item) => wanted.has(item.id));
    },

    acknowledgeAll() {
      return acknowledgeWhere(() => true);
    },

    view() {
      const list = [...items].reverse().map((item) => ({ ...item }));
      return { open: list.filter((item) => item.acknowledgedAt === null).length, items: list };
    },

    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

function isIso(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}
