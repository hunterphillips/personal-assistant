// The morning notice: the brief run writes notice-<date>.json beside the
// viewer ({ date, state: 'ready' | 'failed', opening, memo? }, build.py and
// run-brief), and this module posts each one into the Assistant's thread
// once per date and state. The run never calls the daemon; the daemon reads
// the file on start, on each event stream connect, and once a minute while
// a stream is open (events.mjs drives the timer), so a page left open
// through 06:05 still sees the line.
//
// createNotices({ briefsDir, threadsDir, hub, agentId, limits, log, now })
// returns:
//
//   reconcile() -> Promise<void>
//     Lists notice-<date>.json in briefsDir, keeps the newest two dates by
//     name (an older unposted notice is ignored on purpose: a week of
//     downtime posts two lines, not seven), reads each, and posts every
//     (date, state) pair not yet in <threadsDir>/brief-notices.json, oldest
//     date first, through hub.notify(agentId, message). The message is
//     { role: 'system', kind: 'brief', date, state, summary, text, at }:
//     `summary` is the opening's first sentence cut to SUMMARY_CHARS, and
//     `text` the memo for a ready notice (the opening when it has none) or
//     the opening for a failed one; the store cuts text to
//     limits.messageTextBytes. A pair is recorded after its append
//     succeeds; the posted file is written atomically (mode 600).
//     Concurrent callers share one run. When hub.persona(agentId) is null
//     (the agent has not started, or its adapter is missing) nothing is
//     posted, `notice_skipped` is logged, and the next reconcile retries. A
//     malformed or oversized file is logged as `notice_invalid` and skipped,
//     never deleted; a missing briefs directory posts nothing. Never rejects:
//     a failed read, append, or record is logged as `notice_error`.
//   start(intervalMs = 60_000)  runs reconcile() on an unref'd interval;
//                               idempotent while running
//   stop()                      clears the interval
//   running() -> boolean        whether the interval is armed

import { mkdir, open, readdir, readFile, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

import { isCalendarDate } from './briefs.mjs';
import { LIMITS } from './config.mjs';

export const SUMMARY_CHARS = 300;
export const NOTICE_FILE_BYTES = 64 * 1024;
export const POSTED_FILE = 'brief-notices.json';
const NOTICE_NAME = /^notice-(\d{4}-\d{2}-\d{2})\.json$/;
const STATES = new Set(['ready', 'failed']);
const KEEP_DATES = 2;

export function createNotices({
  briefsDir, threadsDir, hub, agentId = 'assistant', limits = LIMITS, log = () => {}, now = () => new Date(),
}) {
  const briefsRoot = path.resolve(briefsDir);
  const postedFile = path.join(path.resolve(threadsDir), POSTED_FILE);
  let run = null;
  let timer = null;

  async function reconcile() {
    run ??= reconcileOnce().catch((error) => {
      log({ event: 'notice_error', error: error?.message ?? String(error) });
    }).finally(() => {
      run = null;
    });
    return run;
  }

  async function reconcileOnce() {
    const dates = await listDates();
    if (dates.length === 0) return;
    const posted = await readPosted();
    for (const date of dates) {
      const notice = await readNotice(date);
      if (!notice) continue;
      if (posted[date]?.includes(notice.state)) continue;
      if (!hub.persona(agentId)) {
        log({ event: 'notice_skipped', agentId, date, state: notice.state, reason: 'agent_not_started' });
        return;
      }
      await hub.notify(agentId, {
        role: 'system',
        kind: 'brief',
        date,
        state: notice.state,
        summary: firstSentence(notice.opening),
        text: notice.state === 'ready' && notice.memo ? notice.memo : notice.opening,
        at: now().toISOString(),
      });
      posted[date] = [...(posted[date] ?? []), notice.state];
      await writePosted(posted);
      log({ event: 'notice_posted', agentId, date, state: notice.state });
    }
  }

  // The newest KEEP_DATES notice dates, oldest first.
  async function listDates() {
    let entries;
    try {
      entries = await readdir(briefsRoot, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
    const dates = [];
    for (const entry of entries) {
      const match = NOTICE_NAME.exec(entry.name);
      if (match && entry.isFile() && isCalendarDate(match[1])) dates.push(match[1]);
    }
    return dates.sort().slice(-KEEP_DATES);
  }

  async function readNotice(date) {
    const file = path.join(briefsRoot, `notice-${date}.json`);
    let parsed;
    try {
      const info = await stat(file);
      if (info.size > NOTICE_FILE_BYTES) {
        log({ event: 'notice_invalid', date, reason: 'too_large' });
        return null;
      }
      parsed = JSON.parse(await readFile(file, 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      log({ event: 'notice_invalid', date, reason: error instanceof SyntaxError ? 'bad_json' : 'unreadable' });
      return null;
    }
    const reason = validate(parsed, date);
    if (reason) {
      log({ event: 'notice_invalid', date, reason });
      return null;
    }
    return { state: parsed.state, opening: parsed.opening.trim(), memo: typeof parsed.memo === 'string' ? parsed.memo.trim() : '' };
  }

  async function readPosted() {
    let text;
    try {
      text = await readFile(postedFile, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return {};
      throw error;
    }
    try {
      const parsed = JSON.parse(text);
      const posted = isRecord(parsed?.posted) ? parsed.posted : null;
      if (!posted) throw new Error('shape');
      const clean = {};
      for (const [date, states] of Object.entries(posted)) {
        if (isCalendarDate(date) && Array.isArray(states)) clean[date] = states.filter((state) => STATES.has(state));
      }
      return clean;
    } catch {
      log({ event: 'notice_posted_invalid' });
      return {};
    }
  }

  async function writePosted(posted) {
    const dir = path.dirname(postedFile);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const tmp = path.join(dir, `.${POSTED_FILE}.${randomBytes(6).toString('hex')}.tmp`);
    const handle = await open(tmp, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify({ version: 1, posted }, null, 2)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(tmp, postedFile);
    } catch (error) {
      await unlink(tmp).catch(() => {});
      throw error;
    }
  }

  return {
    reconcile,
    start(intervalMs = 60_000) {
      if (timer) return;
      timer = setInterval(() => { reconcile(); }, intervalMs);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    running: () => timer !== null,
  };
}

// The first sentence of `text` (up to the first . ! or ? followed by a
// space or the end), whitespace collapsed, cut to SUMMARY_CHARS characters.
export function firstSentence(text) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  const match = /^.*?[.!?](?=\s|$)/.exec(flat);
  const sentence = match ? match[0] : flat;
  return Array.from(sentence).slice(0, SUMMARY_CHARS).join('');
}

function validate(parsed, date) {
  if (!isRecord(parsed)) return 'not_an_object';
  if (parsed.date !== date) return 'date_mismatch';
  if (!STATES.has(parsed.state)) return 'bad_state';
  if (typeof parsed.opening !== 'string' || parsed.opening.trim() === '') return 'no_opening';
  if (parsed.memo !== undefined && typeof parsed.memo !== 'string') return 'bad_memo';
  return null;
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
