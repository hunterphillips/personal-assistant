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
//
// jobRunner (config.jobRunner, default 'launchd') picks the source. Under
// 'systemd' each label is a pair of user units, <label>.service and
// <label>.timer, and readPlist and launchctlList are never called. Each job
// then has source "systemd" (Focus scans still "focus"):
//   - available: the service's LoadState is "loaded"; otherwise the job
//     reads as an unreadable plist does (available: false, "unknown").
//   - outcome: "running" when the service is activating, or active with a
//     MainPID other than 0; "ok" when Result is "success"; "failed" for any
//     other Result. exitStatus is ExecMainStatus.
//   - lastRun: ExecMainStartTimestamp, else the log file's mtime.
//   - logPath: the path of StandardOutput=append:<path>, else of
//     StandardError=append:<path>, else null.
//   - schedule: from the timer's OnCalendar values; see describeTimer below.
//     No timer is "Schedule unavailable".
//   - failures24h and paused are null.
// Its default dependency:
//   systemctlShow(label, { signal }) -> Promise<{ service, timer } | null>
//     `systemctl --user show --timestamp=unix <label>.service <label>.timer
//     --property=...`, each unit's properties as strings (TimersCalendar a
//     list), or null for a unit systemd does not know. `show` prints a file
//     output as a bare "append", so the path is read from the unit file
//     (FragmentPath), %h expanded. null when the call fails or aborts; failures are logged
//     as { event: 'systemctl_error', label, error } once per distinct message.

import { execFile } from 'node:child_process';
import os from 'node:os';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

export const CONCURRENCY = 4;
export const FOCUS_SCAN_PREFIX = 'com.focus.scan-';
const FOCUS_OUTCOMES = new Set(['running', 'skipped', 'no change', 'wrote', 'failed', 'never ran']);
const PLIST_MAX_BUFFER = 256 * 1024;
const LAUNCHCTL_MAX_BUFFER = 64 * 1024;
const LAUNCHCTL_NOT_FOUND = 113;
const SYSTEMCTL_MAX_BUFFER = 64 * 1024;
const UNIT_FILE_MAX_BYTES = 64 * 1024;
const SYSTEMCTL_PROPERTIES = [
  'LoadState', 'ActiveState', 'MainPID', 'Result', 'ExecMainStatus', 'ExecMainStartTimestamp',
  'StandardOutput', 'StandardError', 'FragmentPath', 'TimersCalendar',
];
const CALENDAR_KEYS = new Set(['Minute', 'Hour', 'Weekday', 'Day', 'Month']);
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function createJobs({
  registry,
  launchAgentsDir,
  jobRunner = 'launchd',
  focus,
  timeouts,
  log = () => {},
  readPlist = (file, { signal } = {}) => defaultReadPlist(file, { timeoutMs: timeouts.launchctlMs, signal }),
  launchctlList,
  systemctlShow,
}) {
  const loggedErrors = new Set();
  const reporter = (event) => (label, error) => {
    const message = error?.message ?? String(error);
    if (loggedErrors.has(message)) return;
    loggedErrors.add(message);
    log({ event, label, error: message });
  };
  const reportLaunchctlError = reporter('launchctl_error');
  const reportSystemctlError = reporter('systemctl_error');
  const listLabel = launchctlList
    ?? ((label, { signal } = {}) => defaultLaunchctlList(label, { timeoutMs: timeouts.launchctlMs, onError: reportLaunchctlError, signal }));
  const showLabel = systemctlShow
    // systemctl shares launchctl's budget: one call to the job runner.
    ?? ((label, { signal } = {}) => defaultSystemctlShow(label, { timeoutMs: timeouts.launchctlMs, onError: reportSystemctlError, signal }));
  const source = jobRunner === 'systemd' ? 'systemd' : 'launchctl';

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
    if (!isRecord(plist)) return null;
    const logPath = stringOrNull(plist.StandardOutPath) ?? stringOrNull(plist.StandardErrorPath);
    const [logMtime, launchctl] = await Promise.all([mtimeOf(logPath), launchctlFor(label, signal)]);
    let outcome = 'unknown';
    if (!launchctl) outcome = 'not loaded';
    else if (launchctl.pid !== null && launchctl.pid !== undefined) outcome = 'running';
    else if (launchctl.lastExitStatus === 0) outcome = 'ok';
    else if (Number.isFinite(launchctl.lastExitStatus)) outcome = 'failed';
    return {
      schedule: describeSchedule(plist),
      logPath,
      lastRun: logMtime,
      outcome,
      exitStatus: launchctl?.lastExitStatus ?? null,
    };
  }

  // The same for one label under systemd: its service and timer units.
  async function inspectUnits(label, signal) {
    let units = null;
    try {
      units = await showLabel(label, { signal });
    } catch (error) {
      reportSystemctlError(label, error);
    }
    const service = units?.service;
    if (service?.LoadState !== 'loaded') return null;
    const logPath = appendPath(service.StandardOutput) ?? appendPath(service.StandardError);
    const startedAt = unixTimestamp(service.ExecMainStartTimestamp);
    let outcome = 'unknown';
    if (service.ActiveState === 'activating' || (service.ActiveState === 'active' && /^[1-9]\d*$/.test(service.MainPID ?? ''))) outcome = 'running';
    else if (service.Result === 'success') outcome = 'ok';
    else if (stringOrNull(service.Result)) outcome = 'failed';
    return {
      schedule: units.timer?.LoadState === 'loaded'
        ? describeTimer(units.timer.TimersCalendar ?? [])
        : { kind: 'unknown', text: 'Schedule unavailable' },
      logPath,
      lastRun: startedAt ?? await mtimeOf(logPath),
      outcome,
      exitStatus: /^-?\d+$/.test(service.ExecMainStatus ?? '') ? Number(service.ExecMainStatus) : null,
    };
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
      const inspectOne = source === 'systemd' ? inspectUnits : inspect;
      const results = await runLimited(jobs.map((job) => () => inspectOne(job.label, signal)), CONCURRENCY, signal);
      const status = await statusPromise;

      return {
        refreshedAt: new Date().toISOString(),
        focusAvailable: status !== null,
        jobs: jobs.map((job, index) => buildRoutine(job, results[index], status, source)),
      };
    },
  };
}

function buildRoutine({ agent, label, name }, result, status, source) {
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
    source,
    available: false,
  };
  if (!result) return job;

  job.available = true;
  job.schedule = result.schedule;
  job.logPath = result.logPath;
  job.exitStatus = result.exitStatus;

  const focusSource = focusSourceOf(label, status);
  if (focusSource) {
    job.source = 'focus';
    job.lastRun = stringOrNull(focusSource.lastRun);
    job.outcome = FOCUS_OUTCOMES.has(focusSource.lastOutcome) ? focusSource.lastOutcome : 'unknown';
    job.failures24h = Number.isFinite(focusSource.failures24h) ? focusSource.failures24h : null;
    job.paused = typeof status.paused === 'boolean' ? status.paused : null;
    return job;
  }

  job.lastRun = result.lastRun;
  job.outcome = result.outcome;
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

// Plain-words schedule from a systemd timer's OnCalendar values, in the
// same English as a plist's StartCalendarInterval: each value, as systemd
// normalizes it, becomes the plist entries it means and describeCalendar
// words them.
//   *-*-* 05:40:00             Daily at 05:40 (several values: several times)
//   Mon..Fri *-*-* 05:15:00    Weekdays at 05:15 (also Sat,Sun and Mon,Wed)
//   *-*-* *:05:00              Hourly at :05
//   *-*-01 03:00:00            Monthly on the 1st at 03:00
// Anything else, or no calendar at all, is "Custom schedule".
export function describeTimer(calendars) {
  const entries = [];
  for (const calendar of calendars) {
    const spec = /^\{ OnCalendar=(.+?) ; /.exec(calendar)?.[1];
    const parsed = spec ? calendarEntries(spec) : null;
    if (!parsed) return { kind: 'custom', text: CUSTOM };
    entries.push(...parsed);
  }
  const text = entries.length > 0 ? describeCalendar(entries) : CUSTOM;
  return text === CUSTOM ? { kind: 'custom', text } : { kind: 'calendar', text };
}

const SYSTEMD_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function calendarEntries(spec) {
  const match = /^(?:([A-Za-z.,]+) )?\*-\*-(\*|\d{1,2}) (\*|\d{1,2}):(\d{1,2}):00$/.exec(spec);
  if (!match) return null;
  const [, dayList, day, hour, minute] = match;
  if (hour === '*') return dayList || day !== '*' ? null : [{ Minute: Number(minute) }];
  const base = { Hour: Number(hour), Minute: Number(minute) };
  if (day !== '*') base.Day = Number(day);
  if (!dayList) return [base];
  const days = weekdays(dayList);
  return days ? days.map((Weekday) => ({ ...base, Weekday })) : null;
}

// "Mon..Fri" or "Sat,Sun" as plist weekdays (Mon 1 .. Sun 7).
function weekdays(list) {
  const days = [];
  for (const part of list.split(',')) {
    const [from, to = from, ...rest] = part.split('..');
    const start = SYSTEMD_DAYS.indexOf(from);
    const end = SYSTEMD_DAYS.indexOf(to);
    if (rest.length > 0 || start < 0 || end < start) return null;
    for (let day = start; day <= end; day += 1) days.push(day + 1);
  }
  return days;
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

export async function defaultSystemctlShow(label, { timeoutMs, run = execFile, onError = () => {}, signal } = {}) {
  let stdout;
  try {
    ({ stdout } = await runFile(run, 'systemctl', [
      '--user', 'show', '--timestamp=unix', `${label}.service`, `${label}.timer`, `--property=${SYSTEMCTL_PROPERTIES.join(',')}`,
    ], { timeout: timeoutMs, maxBuffer: SYSTEMCTL_MAX_BUFFER, signal }));
  } catch (error) {
    if (error?.name !== 'AbortError') onError(label, error);
    return null;
  }
  const units = unitsFromShow(stdout);
  const { service } = units;
  if (service) {
    for (const key of ['StandardOutput', 'StandardError']) {
      if (service[key] === 'append') service[key] = (await unitFileOutput(service.FragmentPath, key)) ?? service[key];
    }
  }
  return units;
}

// `systemctl show` output for a service and its timer, in that order, as
// { service, timer }: each unit's properties, null when systemd does not
// know it. TimersCalendar, which repeats, is a list.
export function unitsFromShow(stdout) {
  const blocks = stdout.split(/\n\s*\n/).map((block) => {
    const properties = { TimersCalendar: [] };
    for (const line of block.split('\n')) {
      const at = line.indexOf('=');
      if (at <= 0) continue;
      const key = line.slice(0, at);
      const value = line.slice(at + 1);
      if (key === 'TimersCalendar') properties.TimersCalendar.push(value);
      else properties[key] = value;
    }
    return properties.LoadState && properties.LoadState !== 'not-found' ? properties : null;
  });
  return { service: blocks[0] ?? null, timer: blocks[1] ?? null };
}

// The last `<key>=append:<path>` the unit file sets, as "append:<path>",
// with %h expanded to the home directory; a path that still holds a
// specifier or is not absolute is null.
async function unitFileOutput(file, key) {
  if (!stringOrNull(file) || !path.isAbsolute(file)) return null;
  let text;
  try {
    const stats = await stat(file);
    if (!stats.isFile() || stats.size > UNIT_FILE_MAX_BYTES) return null;
    text = await readFile(file, 'utf8');
  } catch {
    return null;
  }
  let value = null;
  for (const line of text.split('\n')) {
    const match = new RegExp(`^\\s*${key}\\s*=\\s*(append:.+?)\\s*$`).exec(line);
    if (match) value = match[1];
  }
  const logPath = value?.slice('append:'.length).replaceAll('%h', os.homedir());
  return logPath && path.isAbsolute(logPath) && !logPath.includes('%') ? `append:${logPath}` : null;
}

function appendPath(value) {
  return typeof value === 'string' && value.startsWith('append:') ? stringOrNull(value.slice('append:'.length)) : null;
}

// ExecMainStartTimestamp under --timestamp=unix ("@<seconds>") as ISO.
function unixTimestamp(value) {
  const match = /^@(\d+)$/.exec(value ?? '');
  return match && Number(match[1]) > 0 ? new Date(Number(match[1]) * 1000).toISOString() : null;
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
