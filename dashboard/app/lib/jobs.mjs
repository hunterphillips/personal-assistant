// Jobs: a read-only view of every scheduled job the registry names. Each
// agent's `jobs` are launchd labels; for each one this module reads the
// plist in config.launchAgentsDir (through `plutil`), asks `launchctl list`
// for its last exit status and PID, and, for Focus scans, reads Focus's own
// status. It never loads, starts, stops, or edits a job, and it runs nothing
// on a timer: the caller refreshes on demand.
//
// createJobs({ registry, launchAgentsDir, focus, timeouts, log,
//             readPlist, launchctlList }) returns:
//
//   refresh({ signal }) -> Promise<{ refreshedAt, focusAvailable, jobs }>
//     Builds one job per label on every agent in registry.current().
//     Per-label work (plist read, log stat, launchctl) runs at most
//     CONCURRENCY at a time. `signal` is threaded through to the plist and
//     launchctl subprocesses, so aborting also aborts any in-flight ones.
//     When `signal` aborts, no new work starts and the promise resolves at
//     once; every job not finished by then is returned with available:
//     false. Never rejects.
//
//     Labels starting with FOCUS_SCAN_PREFIX are Focus scans. When there is
//     at least one and `focus` is given, focus.fetchStatus() is called once,
//     bounded by timeouts.statusMs and the caller's signal. `focusAvailable`
//     is true only when that call returned a status.
//
//     Each job:
//       { label, agentId, agentName, name, schedule: { kind, text }, logPath,
//         lastRun, outcome, exitStatus, failures24h, paused, source, available }
//     - name: the label without the agent's shared owner prefix (the leading
//       dot segments common to all its labels, at most two, e.g. "com.hunter.");
//       the whole label when nothing would remain.
//     - schedule: from the plist; see describeSchedule below.
//     - logPath: StandardOutPath, else StandardErrorPath, else null.
//     - source "focus" (a Focus scan whose source is in the status): lastRun,
//       outcome ("running" | "skipped" | "no change" | "wrote" | "failed" |
//       "never ran"), failures24h, and paused come from the status.
//     - source "launchctl" (everything else): lastRun is the log file's mtime
//       (null when missing); outcome is "running" when launchctl reports a
//       PID, "ok" for exit status 0, "failed" for any other status, "not
//       loaded" when launchctl does not know the label, and "unknown" when
//       the plist could not be read (available: false; launchctl is skipped).
//       failures24h and paused are null.
//     Sorted by agent in registry order, then by label.
//
// Default dependencies (injected in tests):
//   readPlist(file, { signal }) -> Promise<object | null>
//     `plutil -convert json -o - <file>` after a `stat`, so a missing plist
//     costs no subprocess. null on any failure.
//   launchctlList(label, { signal }) -> Promise<{ pid, lastExitStatus } | null>
//     `launchctl list <label>`, parsed with regexes. null when the label is
//     not loaded (exit 113 or "Could not find service"), when the signal
//     aborted it, and on any other failure. Other failures, and any
//     rejection from an injected launchctlList, are logged as
//     { event: 'launchctl_error', label, error } once per distinct message.
// Both subprocesses run with timeout: timeouts.launchctlMs, a bounded
// maxBuffer, and are passed refresh()'s `signal`, so aborting a refresh also
// aborts them. Injected readPlist/launchctlList receive the same second
// argument; tests' fakes may ignore it.

import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import path from 'node:path';

export const CONCURRENCY = 4;
export const FOCUS_SCAN_PREFIX = 'com.focus.scan-';
const FOCUS_OUTCOMES = new Set(['running', 'skipped', 'no change', 'wrote', 'failed', 'never ran']);
const PLIST_MAX_BUFFER = 256 * 1024;
const LAUNCHCTL_MAX_BUFFER = 64 * 1024;
const LAUNCHCTL_NOT_FOUND = 113;
const CALENDAR_KEYS = new Set(['Minute', 'Hour', 'Weekday', 'Day', 'Month']);
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function createJobs({
  registry,
  launchAgentsDir,
  focus,
  timeouts,
  log = () => {},
  readPlist = (file, { signal } = {}) => defaultReadPlist(file, { timeoutMs: timeouts.launchctlMs, signal }),
  launchctlList,
}) {
  const loggedErrors = new Set();
  const reportLaunchctlError = (label, error) => {
    const message = error?.message ?? String(error);
    if (loggedErrors.has(message)) return;
    loggedErrors.add(message);
    log({ event: 'launchctl_error', label, error: message });
  };
  const listLabel = launchctlList
    ?? ((label, { signal } = {}) => defaultLaunchctlList(label, { timeoutMs: timeouts.launchctlMs, onError: reportLaunchctlError, signal }));

  async function launchctlFor(label, signal) {
    try {
      return await listLabel(label, { signal });
    } catch (error) {
      reportLaunchctlError(label, error);
      return null;
    }
  }

  // Everything about one label that does not depend on the Focus status.
  async function inspect(label, signal) {
    let plist = null;
    try {
      plist = await readPlist(path.join(launchAgentsDir, `${label}.plist`), { signal });
    } catch {
      plist = null;
    }
    if (!isRecord(plist)) return { plist: null };
    const logPath = stringOrNull(plist.StandardOutPath) ?? stringOrNull(plist.StandardErrorPath);
    const [logMtime, launchctl] = await Promise.all([mtimeOf(logPath), launchctlFor(label, signal)]);
    return { plist, logPath, logMtime, launchctl };
  }

  return {
    async refresh({ signal } = {}) {
      const agents = registry.current().agents;
      const jobs = [];
      for (const agent of agents) {
        const prefix = ownerPrefix(agent.jobs);
        for (const label of [...agent.jobs].sort(compareStrings)) {
          jobs.push({ agent, label, name: label.slice(prefix.length) || label });
        }
      }

      const needsFocus = focus && jobs.some((job) => job.label.startsWith(FOCUS_SCAN_PREFIX));
      const statusPromise = needsFocus ? fetchFocusStatus(focus, timeouts.statusMs, signal) : Promise.resolve(null);
      const results = await runLimited(jobs.map((job) => () => inspect(job.label, signal)), CONCURRENCY, signal);
      const status = await statusPromise;

      return {
        refreshedAt: new Date().toISOString(),
        focusAvailable: status !== null,
        jobs: jobs.map((job, index) => buildRoutine(job, results[index], status)),
      };
    },
  };
}

function buildRoutine({ agent, label, name }, result, status) {
  const job = {
    label,
    agentId: agent.id,
    agentName: agent.name,
    name,
    schedule: { kind: 'unknown', text: 'Schedule unavailable' },
    logPath: null,
    lastRun: null,
    outcome: 'unknown',
    exitStatus: null,
    failures24h: null,
    paused: null,
    source: 'launchctl',
    available: false,
  };
  if (!result?.plist) return job;

  const { plist, logPath, logMtime, launchctl } = result;
  job.available = true;
  job.schedule = describeSchedule(plist);
  job.logPath = logPath;
  job.exitStatus = launchctl?.lastExitStatus ?? null;

  const focusSource = focusSourceOf(label, status);
  if (focusSource) {
    job.source = 'focus';
    job.lastRun = stringOrNull(focusSource.lastRun);
    job.outcome = FOCUS_OUTCOMES.has(focusSource.lastOutcome) ? focusSource.lastOutcome : 'unknown';
    job.failures24h = Number.isFinite(focusSource.failures24h) ? focusSource.failures24h : null;
    job.paused = typeof status.paused === 'boolean' ? status.paused : null;
    return job;
  }

  job.lastRun = logMtime;
  if (!launchctl) job.outcome = 'not loaded';
  else if (launchctl.pid !== null && launchctl.pid !== undefined) job.outcome = 'running';
  else if (launchctl.lastExitStatus === 0) job.outcome = 'ok';
  else if (Number.isFinite(launchctl.lastExitStatus)) job.outcome = 'failed';
  return job;
}

function focusSourceOf(label, status) {
  if (!status || !label.startsWith(FOCUS_SCAN_PREFIX) || !isRecord(status.sources)) return null;
  const source = label.slice(FOCUS_SCAN_PREFIX.length);
  return Object.hasOwn(status.sources, source) && isRecord(status.sources[source]) ? status.sources[source] : null;
}

async function fetchFocusStatus(focus, statusMs, signal) {
  const bound = signal ? AbortSignal.any([signal, AbortSignal.timeout(statusMs)]) : AbortSignal.timeout(statusMs);
  try {
    const status = await focus.fetchStatus({ signal: bound });
    return isRecord(status) ? status : null;
  } catch {
    return null;
  }
}

// Runs tasks with at most `limit` in flight. Resolves with one result per
// task; when `signal` aborts it resolves at once, leaving undefined for every
// task that had not finished, and starts nothing further.
function runLimited(tasks, limit, signal) {
  return new Promise((resolve) => {
    const results = new Array(tasks.length);
    let next = 0;
    let running = 0;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      signal?.removeEventListener('abort', finish);
      resolve(results);
    };
    const launch = () => {
      if (done) return;
      if (signal?.aborted) {
        finish();
        return;
      }
      while (running < limit && next < tasks.length) {
        const index = next;
        next += 1;
        running += 1;
        Promise.resolve()
          .then(tasks[index])
          .then((value) => {
            if (!done) results[index] = value;
          }, () => {})
          .finally(() => {
            running -= 1;
            launch();
          });
      }
      if (running === 0 && next >= tasks.length) finish();
    };
    signal?.addEventListener('abort', finish, { once: true });
    launch();
  });
}

// The leading dot segments shared by every label, at most two (the
// reverse-DNS owner, such as "com.hunter."), as a string ending in ".".
function ownerPrefix(labels) {
  if (labels.length === 0) return '';
  const split = labels.map((label) => label.split('.'));
  const shared = [];
  for (let i = 0; i < 2; i += 1) {
    const segment = split[0][i];
    if (segment === undefined || !split.every((parts) => parts[i] === segment && parts.length > i + 1)) break;
    shared.push(segment);
  }
  return shared.length > 0 ? `${shared.join('.')}.` : '';
}

// Plain-words schedule from a launchd plist:
//   KeepAlive truthy                                      always    "Always on"
//   RunAtLoad true, no interval, no calendar, no KeepAlive once      "Runs at login"
//   StartInterval N                                       interval  "Every N seconds|minutes|hours"
//   StartCalendarInterval (dict or array of dicts)        calendar  "Hourly at :MM", "Daily at HH:MM, ...",
//                                                                    "Weekdays at", "Weekends at", "Mon, Wed at",
//                                                                    "Monthly on the 1st at", or "Custom schedule"
//   none of these                                         unknown   "No schedule"
export function describeSchedule(plist) {
  const hasInterval = plist.StartInterval !== undefined;
  const hasCalendar = plist.StartCalendarInterval !== undefined;
  if (isTruthyKeepAlive(plist.KeepAlive)) {
    return { kind: 'always', text: 'Always on' };
  }
  if (plist.RunAtLoad === true && !hasInterval && !hasCalendar) {
    return { kind: 'once', text: 'Runs at login' };
  }
  if (hasInterval) return { kind: 'interval', text: describeInterval(plist.StartInterval) };
  if (hasCalendar) return { kind: 'calendar', text: describeCalendar(plist.StartCalendarInterval) };
  return { kind: 'unknown', text: 'No schedule' };
}

function isTruthyKeepAlive(value) {
  return value === true || isRecord(value);
}

function describeInterval(seconds) {
  if (!Number.isInteger(seconds) || seconds <= 0) return 'Custom schedule';
  if (seconds >= 3600 && seconds % 3600 === 0) return every(seconds / 3600, 'hour');
  if (seconds >= 60 && seconds % 60 === 0) return every(seconds / 60, 'minute');
  return every(seconds, 'second');
}

function every(count, unit) {
  return count === 1 ? `Every ${unit}` : `Every ${count} ${unit}s`;
}

const CUSTOM = 'Custom schedule';

function describeCalendar(value) {
  const entries = Array.isArray(value) ? value : [value];
  if (entries.length === 0 || !entries.every(isCalendarEntry)) return CUSTOM;
  const shape = (entry) => Object.keys(entry).sort().join(',');
  const shapes = new Set(entries.map(shape));
  if (shapes.size !== 1) return CUSTOM;
  const [only] = shapes;

  if (only === 'Minute') {
    return entries.length === 1 ? `Hourly at :${pad(entries[0].Minute)}` : CUSTOM;
  }
  if (only === 'Hour,Minute') {
    const times = [...new Set(entries.map(clock))].sort();
    return `Daily at ${times.join(', ')}`;
  }
  if (only === 'Hour,Minute,Weekday') {
    const times = new Set(entries.map(clock));
    if (times.size !== 1) return CUSTOM;
    const [time] = times;
    const days = [...new Set(entries.map((entry) => entry.Weekday % 7))].sort((a, b) => a - b);
    const key = days.join(',');
    if (key === '1,2,3,4,5') return `Weekdays at ${time}`;
    if (key === '0,6') return `Weekends at ${time}`;
    return `${days.map((day) => DAY_NAMES[day]).join(', ')} at ${time}`;
  }
  if (only === 'Day,Hour,Minute') {
    const times = new Set(entries.map(clock));
    if (times.size !== 1) return CUSTOM;
    const [time] = times;
    const days = [...new Set(entries.map((entry) => entry.Day))].sort((a, b) => a - b);
    return `Monthly on the ${days.map(ordinal).join(', ')} at ${time}`;
  }
  return CUSTOM;
}

const CALENDAR_RANGES = { Minute: [0, 59], Hour: [0, 23], Weekday: [0, 7], Day: [1, 31], Month: [1, 12] };

function isCalendarEntry(entry) {
  if (!isRecord(entry)) return false;
  const keys = Object.keys(entry);
  return keys.length > 0 && keys.every((key) => {
    if (!CALENDAR_KEYS.has(key)) return false;
    const [min, max] = CALENDAR_RANGES[key];
    return Number.isInteger(entry[key]) && entry[key] >= min && entry[key] <= max;
  });
}

function clock(entry) {
  return `${pad(entry.Hour)}:${pad(entry.Minute)}`;
}

function pad(value) {
  return String(value).padStart(2, '0');
}

function ordinal(day) {
  const teen = day % 100 >= 11 && day % 100 <= 13;
  const suffix = teen ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[day % 10] ?? 'th');
  return `${day}${suffix}`;
}

export async function defaultReadPlist(file, { timeoutMs, run = execFile, signal } = {}) {
  try {
    const stats = await stat(file);
    if (!stats.isFile()) return null;
  } catch {
    return null;
  }
  try {
    const { stdout } = await runFile(run, 'plutil', ['-convert', 'json', '-o', '-', file], {
      timeout: timeoutMs,
      maxBuffer: PLIST_MAX_BUFFER,
      signal,
    });
    const parsed = JSON.parse(stdout);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function defaultLaunchctlList(label, { timeoutMs, run = execFile, onError = () => {}, signal } = {}) {
  let stdout;
  try {
    ({ stdout } = await runFile(run, 'launchctl', ['list', label], {
      timeout: timeoutMs,
      maxBuffer: LAUNCHCTL_MAX_BUFFER,
      signal,
    }));
  } catch (error) {
    const text = `${error?.stdout ?? ''}${error?.stderr ?? ''}`;
    // Not loaded, or the caller aborted: both are expected, neither is logged.
    if (error?.name === 'AbortError' || error?.code === LAUNCHCTL_NOT_FOUND || text.includes('Could not find service')) return null;
    onError(label, error);
    return null;
  }
  const exit = /"LastExitStatus"\s*=\s*(-?\d+);/.exec(stdout);
  const pid = /"PID"\s*=\s*(\d+);/.exec(stdout);
  return {
    pid: pid ? Number(pid[1]) : null,
    lastExitStatus: exit ? Number(exit[1]) : null,
  };
}

// execFile as a promise that keeps stdout/stderr on the error, with the
// callback signature so tests can pass a fake.
function runFile(run, command, args, options) {
  return new Promise((resolve, reject) => {
    run(command, args, { ...options, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

async function mtimeOf(file) {
  if (!file) return null;
  try {
    return (await stat(file)).mtime.toISOString();
  } catch {
    return null;
  }
}

function stringOrNull(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function compareStrings(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}
