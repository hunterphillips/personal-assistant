import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

import { TIMEOUTS } from '../lib/config.mjs';
import { createJobs, defaultLaunchctlList, defaultReadPlist, defaultSystemctlShow, unitsFromShow } from '../lib/jobs.mjs';
import { tempDir } from './support/harness.mjs';

const FIXTURES = fileURLToPath(new URL('./fixtures/launchd/', import.meta.url));
const LAUNCH_AGENTS = '/nonexistent/LaunchAgents';

function agent(id, jobs, name = id.toUpperCase()) {
  return { id, name, jobs };
}

function fakeRegistry(agents) {
  return { current: () => ({ ok: true, agents }) };
}

// Builds jobs over in-memory plists keyed by label and scripted launchctl
// answers keyed by label. A label with no plist entry reads as unreadable; a
// label with no launchctl entry is not loaded.
function jobsFor({ agents, plists = {}, launchctl = {}, focus = null, log, launchctlList, readPlist }) {
  return createJobs({
    registry: fakeRegistry(agents),
    launchAgentsDir: LAUNCH_AGENTS,
    focus,
    timeouts: TIMEOUTS,
    log,
    readPlist: readPlist ?? (async (file) => plists[path.basename(file, '.plist')] ?? null),
    launchctlList: launchctlList ?? (async (label) => launchctl[label] ?? null),
  });
}

async function one(plist, launchctl = { pid: null, lastExitStatus: 0 }) {
  const jobs = jobsFor({ agents: [agent('a', ['com.x.job'])], plists: { 'com.x.job': plist }, launchctl: { 'com.x.job': launchctl } });
  const { jobs: [job] } = await jobs.refresh();
  return job;
}

const SCHEDULES = [
  ['KeepAlive true', { KeepAlive: true, RunAtLoad: true }, 'always', 'Always on'],
  ['KeepAlive object', { KeepAlive: { SuccessfulExit: false } }, 'always', 'Always on'],
  ['RunAtLoad with no interval and no KeepAlive', { RunAtLoad: true }, 'once', 'Runs at login'],
  ['RunAtLoad with KeepAlive explicitly false', { RunAtLoad: true, KeepAlive: false }, 'once', 'Runs at login'],
  ['StartInterval in seconds', { StartInterval: 45 }, 'interval', 'Every 45 seconds'],
  ['StartInterval in minutes', { StartInterval: 900 }, 'interval', 'Every 15 minutes'],
  ['StartInterval in whole hours', { StartInterval: 7200 }, 'interval', 'Every 2 hours'],
  ['hourly', { StartCalendarInterval: { Minute: 35 } }, 'calendar', 'Hourly at :35'],
  ['daily', { StartCalendarInterval: { Hour: 2, Minute: 30 } }, 'calendar', 'Daily at 02:30'],
  ['daily at several times, sorted', {
    StartCalendarInterval: [{ Hour: 18, Minute: 15 }, { Hour: 6, Minute: 15 }, { Hour: 14, Minute: 15 }, { Hour: 10, Minute: 15 }],
  }, 'calendar', 'Daily at 06:15, 10:15, 14:15, 18:15'],
  ['weekdays', {
    StartCalendarInterval: [1, 2, 3, 4, 5].map((Weekday) => ({ Weekday, Hour: 6, Minute: 0 })),
  }, 'calendar', 'Weekdays at 06:00'],
  ['weekends', {
    StartCalendarInterval: [{ Weekday: 6, Hour: 9, Minute: 5 }, { Weekday: 0, Hour: 9, Minute: 5 }],
  }, 'calendar', 'Weekends at 09:05'],
  ['named weekdays, sorted Sun..Sat', {
    StartCalendarInterval: [{ Weekday: 3, Hour: 7, Minute: 0 }, { Weekday: 1, Hour: 7, Minute: 0 }],
  }, 'calendar', 'Mon, Wed at 07:00'],
  ['weekdays at mixed times', {
    StartCalendarInterval: [{ Weekday: 1, Hour: 7, Minute: 0 }, { Weekday: 2, Hour: 8, Minute: 0 }],
  }, 'calendar', 'Custom schedule'],
  ['monthly', { StartCalendarInterval: { Day: 1, Hour: 3, Minute: 0 } }, 'calendar', 'Monthly on the 1st at 03:00'],
  ['monthly on several days', {
    StartCalendarInterval: [{ Day: 22, Hour: 3, Minute: 0 }, { Day: 2, Hour: 3, Minute: 0 }, { Day: 13, Hour: 3, Minute: 0 }],
  }, 'calendar', 'Monthly on the 2nd, 13th, 22nd at 03:00'],
  ['Month set', { StartCalendarInterval: { Month: 1, Day: 1, Hour: 0, Minute: 0 } }, 'calendar', 'Custom schedule'],
  ['mixed shapes', { StartCalendarInterval: [{ Minute: 5 }, { Hour: 1, Minute: 0 }] }, 'calendar', 'Custom schedule'],
  ['no schedule keys', { Label: 'com.x.job', RunAtLoad: false }, 'unknown', 'No schedule'],
];

test('schedules are described in plain words', async () => {
  for (const [name, plist, kind, text] of SCHEDULES) {
    const job = await one(plist);
    assert.deepEqual(job.schedule, { kind, text }, name);
  }
});

test('generic outcomes come from launchctl: running, ok, failed, not loaded', async () => {
  const plist = { StartCalendarInterval: { Minute: 0 } };
  const jobs = jobsFor({
    agents: [agent('a', ['com.x.running', 'com.x.ok', 'com.x.failed', 'com.x.gone'])],
    plists: { 'com.x.running': plist, 'com.x.ok': plist, 'com.x.failed': plist, 'com.x.gone': plist },
    launchctl: {
      'com.x.running': { pid: 92559, lastExitStatus: 0 },
      'com.x.ok': { pid: null, lastExitStatus: 0 },
      'com.x.failed': { pid: null, lastExitStatus: 78 },
    },
  });
  const byLabel = Object.fromEntries((await jobs.refresh()).jobs.map((r) => [r.label, r]));
  assert.equal(byLabel['com.x.running'].outcome, 'running');
  assert.equal(byLabel['com.x.ok'].outcome, 'ok');
  assert.equal(byLabel['com.x.ok'].exitStatus, 0);
  assert.equal(byLabel['com.x.failed'].outcome, 'failed');
  assert.equal(byLabel['com.x.failed'].exitStatus, 78);
  assert.equal(byLabel['com.x.gone'].outcome, 'not loaded');
  assert.equal(byLabel['com.x.gone'].exitStatus, null);
  for (const job of Object.values(byLabel)) {
    assert.equal(job.source, 'launchctl');
    assert.equal(job.available, true);
    assert.equal(job.failures24h, null);
    assert.equal(job.paused, null);
  }
});

test('an unreadable plist makes the job unavailable without asking launchctl', async () => {
  const asked = [];
  const jobs = jobsFor({
    agents: [agent('a', ['com.x.missing'])],
    launchctlList: async (label) => {
      asked.push(label);
      return { pid: null, lastExitStatus: 0 };
    },
  });
  const { jobs: [job] } = await jobs.refresh();
  assert.equal(job.available, false);
  assert.equal(job.outcome, 'unknown');
  assert.equal(job.schedule.kind, 'unknown');
  assert.deepEqual(asked, []);
});

const FOCUS_AGENT = agent('focus', ['com.focus.server', 'com.focus.scan-gmail', 'com.focus.scan-git'], 'Focus');
const FOCUS_PLISTS = {
  'com.focus.server': { KeepAlive: true },
  'com.focus.scan-gmail': { StartCalendarInterval: { Minute: 35 } },
  'com.focus.scan-git': { StartCalendarInterval: { Hour: 6, Minute: 15 } },
};
const FOCUS_LAUNCHCTL = {
  'com.focus.server': { pid: 10, lastExitStatus: 0 },
  'com.focus.scan-gmail': { pid: null, lastExitStatus: 0 },
  'com.focus.scan-git': { pid: null, lastExitStatus: 1 },
};

test('Focus scans take lastRun, outcome, failures, and paused from the Focus status', async () => {
  let calls = 0;
  const focus = {
    fetchStatus: async ({ signal }) => {
      calls += 1;
      assert.ok(signal instanceof AbortSignal);
      return {
        paused: true,
        running: [],
        sources: {
          gmail: { lastRun: '2026-09-25T13:35:04Z', lastOutcome: 'no change', failures24h: 3 },
          git: { lastRun: '2026-09-25T06:15:00Z', lastOutcome: 'wrote', failures24h: 0 },
        },
      };
    },
  };
  const result = await jobsFor({ agents: [FOCUS_AGENT], plists: FOCUS_PLISTS, launchctl: FOCUS_LAUNCHCTL, focus }).refresh();
  assert.equal(calls, 1);
  assert.equal(result.focusAvailable, true);
  const byLabel = Object.fromEntries(result.jobs.map((r) => [r.label, r]));
  assert.deepEqual(
    [byLabel['com.focus.scan-gmail'].source, byLabel['com.focus.scan-gmail'].lastRun, byLabel['com.focus.scan-gmail'].outcome,
      byLabel['com.focus.scan-gmail'].failures24h, byLabel['com.focus.scan-gmail'].paused],
    ['focus', '2026-09-25T13:35:04Z', 'no change', 3, true],
  );
  assert.equal(byLabel['com.focus.scan-git'].outcome, 'wrote');
  assert.equal(byLabel['com.focus.scan-git'].source, 'focus');
  // The server is not a scan source.
  assert.equal(byLabel['com.focus.server'].source, 'launchctl');
  assert.equal(byLabel['com.focus.server'].outcome, 'running');
  assert.equal(byLabel['com.focus.server'].paused, null);
});

test('a scan Focus reports as never ran keeps that outcome', async () => {
  const focus = {
    fetchStatus: async () => ({
      paused: false,
      sources: {
        gmail: { lastRun: null, lastOutcome: 'never ran', failures24h: 0 },
        git: { lastRun: null, lastOutcome: 'invented outcome', failures24h: 0 },
      },
    }),
  };
  const result = await jobsFor({ agents: [FOCUS_AGENT], plists: FOCUS_PLISTS, launchctl: FOCUS_LAUNCHCTL, focus }).refresh();
  const byLabel = Object.fromEntries(result.jobs.map((r) => [r.label, r]));
  assert.equal(byLabel['com.focus.scan-gmail'].outcome, 'never ran');
  assert.equal(byLabel['com.focus.scan-gmail'].lastRun, null);
  assert.equal(byLabel['com.focus.scan-git'].outcome, 'unknown');
});

test('without a Focus status every scan falls back to launchctl and focusAvailable is false', async () => {
  const result = await jobsFor({
    agents: [FOCUS_AGENT],
    plists: FOCUS_PLISTS,
    launchctl: FOCUS_LAUNCHCTL,
    focus: { fetchStatus: async () => null },
  }).refresh();
  assert.equal(result.focusAvailable, false);
  const byLabel = Object.fromEntries(result.jobs.map((r) => [r.label, r]));
  assert.equal(byLabel['com.focus.scan-gmail'].source, 'launchctl');
  assert.equal(byLabel['com.focus.scan-gmail'].outcome, 'ok');
  assert.equal(byLabel['com.focus.scan-gmail'].failures24h, null);
  assert.equal(byLabel['com.focus.scan-git'].outcome, 'failed');

  const unconfigured = await jobsFor({ agents: [FOCUS_AGENT], plists: FOCUS_PLISTS, launchctl: FOCUS_LAUNCHCTL }).refresh();
  assert.equal(unconfigured.focusAvailable, false);
  assert.ok(unconfigured.jobs.every((r) => r.source === 'launchctl'));
});

test('a scan whose source is missing from the Focus status falls back to launchctl', async () => {
  const focus = {
    fetchStatus: async () => ({ paused: false, sources: { gmail: { lastRun: '2026-09-25T13:35:04Z', lastOutcome: 'skipped', failures24h: 0 } } }),
  };
  const result = await jobsFor({ agents: [FOCUS_AGENT], plists: FOCUS_PLISTS, launchctl: FOCUS_LAUNCHCTL, focus }).refresh();
  const byLabel = Object.fromEntries(result.jobs.map((r) => [r.label, r]));
  assert.equal(byLabel['com.focus.scan-gmail'].source, 'focus');
  assert.equal(byLabel['com.focus.scan-gmail'].outcome, 'skipped');
  assert.equal(byLabel['com.focus.scan-git'].source, 'launchctl');
  assert.equal(byLabel['com.focus.scan-git'].outcome, 'failed');
  assert.equal(byLabel['com.focus.scan-git'].paused, null);
});

test('a generic job\'s lastRun is its log file\'s mtime, and null when the log is missing', async (t) => {
  const dir = await tempDir(t);
  const logPath = path.join(dir, 'job.log');
  await writeFile(logPath, 'ran\n');
  const when = new Date('2026-09-24T06:00:00.000Z');
  await utimes(logPath, when, when);
  const jobs = jobsFor({
    agents: [agent('a', ['com.x.logged', 'com.x.unlogged', 'com.x.nolog'])],
    plists: {
      'com.x.logged': { StandardOutPath: logPath, StartCalendarInterval: { Minute: 0 } },
      'com.x.unlogged': { StandardOutPath: path.join(dir, 'missing.log'), StartCalendarInterval: { Minute: 0 } },
      'com.x.nolog': { StartCalendarInterval: { Minute: 0 } },
    },
  });
  const byLabel = Object.fromEntries((await jobs.refresh()).jobs.map((r) => [r.label, r]));
  assert.equal(byLabel['com.x.logged'].lastRun, when.toISOString());
  assert.equal(byLabel['com.x.logged'].logPath, logPath);
  assert.equal(byLabel['com.x.unlogged'].lastRun, null);
  assert.equal(byLabel['com.x.nolog'].lastRun, null);
  assert.equal(byLabel['com.x.nolog'].logPath, null);
});

test('no more than four labels are inspected at once', async () => {
  const labels = Array.from({ length: 12 }, (_, i) => `com.x.job-${String(i).padStart(2, '0')}`);
  let inFlight = 0;
  let peak = 0;
  const track = async (value) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await delay(5);
    inFlight -= 1;
    return value;
  };
  const jobs = jobsFor({
    agents: [agent('a', labels.slice(0, 6)), agent('b', labels.slice(6))],
    readPlist: () => track({ StartCalendarInterval: { Minute: 0 } }),
    launchctlList: () => track({ pid: null, lastExitStatus: 0 }),
  });
  const result = await jobs.refresh();
  assert.equal(result.jobs.length, 12);
  assert.ok(result.jobs.every((r) => r.outcome === 'ok'));
  assert.ok(peak <= 4, `peak in flight was ${peak}`);
  assert.ok(peak > 1, 'work did not run concurrently');
});

test('an abort mid-refresh resolves at once and marks unfinished jobs unavailable', async () => {
  const labels = Array.from({ length: 12 }, (_, i) => `com.x.job-${String(i).padStart(2, '0')}`);
  const reads = [];
  const hang = new Promise(() => {});
  const controller = new AbortController();
  const jobs = jobsFor({
    agents: [agent('a', labels)],
    readPlist: async (file) => {
      reads.push(file);
      return { StartCalendarInterval: { Minute: 0 } };
    },
    // The first four finish; the rest never answer.
    launchctlList: async (label) => (labels.indexOf(label) < 4 ? { pid: null, lastExitStatus: 0 } : hang),
  });
  const pending = jobs.refresh({ signal: controller.signal });
  await delay(20);
  const readsAtAbort = reads.length;
  assert.equal(readsAtAbort, 8, 'four finished and four are stuck');
  controller.abort();
  const result = await Promise.race([pending, delay(1_000).then(() => 'timeout')]);
  assert.notEqual(result, 'timeout');
  const byLabel = Object.fromEntries(result.jobs.map((r) => [r.label, r]));
  for (const label of labels.slice(0, 4)) assert.equal(byLabel[label].available, true, label);
  for (const label of labels.slice(4)) {
    assert.equal(byLabel[label].available, false, label);
    assert.equal(byLabel[label].outcome, 'unknown', label);
  }
  await delay(20);
  assert.equal(reads.length, readsAtAbort, 'new work started after the abort');
});

test('a repeated identical launchctl error is logged once', async () => {
  const logs = [];
  const labels = ['com.x.one', 'com.x.two', 'com.x.three'];
  const plist = { StartCalendarInterval: { Minute: 0 } };
  const jobs = jobsFor({
    agents: [agent('a', labels)],
    plists: Object.fromEntries(labels.map((label) => [label, plist])),
    launchctlList: async () => {
      throw new Error('launchctl timed out');
    },
    log: (entry) => logs.push(entry),
  });
  const first = await jobs.refresh();
  await jobs.refresh();
  assert.ok(first.jobs.every((r) => r.outcome === 'not loaded'));
  const errors = logs.filter((entry) => entry.event === 'launchctl_error');
  assert.equal(errors.length, 1);
  assert.ok(labels.includes(errors[0].label));
  assert.match(errors[0].error, /timed out/);
});

test('jobs are ordered by agent in registry order, then by label, with the owner prefix trimmed from names', async () => {
  const agents = [
    agent('second-brain', ['com.hunter.brain-refresh', 'com.hunter.brain-drain'], 'Second brain'),
    agent('cfo', ['com.hunter.cfo.daily'], 'CFO'),
    FOCUS_AGENT,
    agent('bare', ['standalone'], 'Bare'),
  ];
  const plists = new Proxy({}, { get: () => ({ StartCalendarInterval: { Minute: 0 } }) });
  const result = await jobsFor({ agents, plists }).refresh();
  assert.deepEqual(result.jobs.map((r) => [r.agentId, r.label, r.name]), [
    ['second-brain', 'com.hunter.brain-drain', 'brain-drain'],
    ['second-brain', 'com.hunter.brain-refresh', 'brain-refresh'],
    ['cfo', 'com.hunter.cfo.daily', 'cfo.daily'],
    ['focus', 'com.focus.scan-git', 'scan-git'],
    ['focus', 'com.focus.scan-gmail', 'scan-gmail'],
    ['focus', 'com.focus.server', 'server'],
    ['bare', 'standalone', 'standalone'],
  ]);
  assert.equal(result.jobs[2].agentName, 'CFO');
  assert.ok(!Number.isNaN(Date.parse(result.refreshedAt)));
});

test('plists are read from the LaunchAgents directory by label', async () => {
  const files = [];
  await createJobs({
    registry: fakeRegistry([agent('a', ['com.x.job'])]),
    launchAgentsDir: '/somewhere/LaunchAgents',
    focus: null,
    timeouts: TIMEOUTS,
    readPlist: async (file) => {
      files.push(file);
      return null;
    },
    launchctlList: async () => null,
  }).refresh();
  assert.deepEqual(files, ['/somewhere/LaunchAgents/com.x.job.plist']);
});

// defaultLaunchctlList with a scripted execFile; the real launchctl is never run.
function scriptedRun(reply) {
  const calls = [];
  const run = (command, args, options, callback) => {
    calls.push({ command, args, options });
    const { error = null, stdout = '', stderr = '' } = reply(args);
    setImmediate(() => callback(error, stdout, stderr));
  };
  return { run, calls };
}

test('defaultLaunchctlList parses PID and LastExitStatus, and a missing service is null without a log', async () => {
  const running = scriptedRun(() => ({
    stdout: '{\n\t"Label" = "com.focus.scan-gmail";\n\t"LastExitStatus" = 0;\n\t"PID" = 92559;\n\t"Program" = "/bin/sh";\n};\n',
  }));
  assert.deepEqual(await defaultLaunchctlList('com.focus.scan-gmail', { timeoutMs: 100, run: running.run }), { pid: 92559, lastExitStatus: 0 });
  assert.deepEqual(running.calls[0].args, ['list', 'com.focus.scan-gmail']);
  assert.equal(running.calls[0].options.timeout, 100);
  assert.ok(running.calls[0].options.maxBuffer > 0);

  const idle = scriptedRun(() => ({ stdout: '{\n\t"LastExitStatus" = 256;\n};\n' }));
  assert.deepEqual(await defaultLaunchctlList('x', { timeoutMs: 100, run: idle.run }), { pid: null, lastExitStatus: 256 });

  const errors = [];
  const missing = scriptedRun(() => ({
    error: Object.assign(new Error('Command failed'), { code: 113 }),
    stderr: 'Could not find service "com.nope" in domain for port\n',
  }));
  assert.equal(await defaultLaunchctlList('com.nope', { timeoutMs: 100, run: missing.run, onError: (...args) => errors.push(args) }), null);
  assert.deepEqual(errors, []);

  const broken = scriptedRun(() => ({ error: Object.assign(new Error('spawn launchctl EACCES'), { code: 'EACCES' }) }));
  assert.equal(await defaultLaunchctlList('com.x', { timeoutMs: 100, run: broken.run, onError: (...args) => errors.push(args) }), null);
  assert.equal(errors.length, 1);
});

test('an aborted launchctl call is null and not logged', async () => {
  const errors = [];
  const aborted = scriptedRun(() => ({ error: Object.assign(new Error('The operation was aborted'), { name: 'AbortError', code: 'ABORT_ERR' }) }));
  const controller = new AbortController();
  controller.abort();
  assert.equal(await defaultLaunchctlList('com.x', {
    timeoutMs: 100, run: aborted.run, signal: controller.signal, onError: (...args) => errors.push(args),
  }), null);
  assert.deepEqual(errors, []);
});

const hasPlutil = !spawnSync('plutil', ['-help']).error;

test('defaultReadPlist converts a real plist with plutil (opt-in: needs plutil)', async (t) => {
  if (!hasPlutil) {
    t.skip('plutil is not on PATH');
    return;
  }
  const plist = await defaultReadPlist(path.join(FIXTURES, 'com.example.sample.plist'), { timeoutMs: TIMEOUTS.launchctlMs });
  assert.equal(plist.Label, 'com.example.sample');
  assert.deepEqual(plist.StartCalendarInterval, [{ Hour: 6, Minute: 15 }, { Hour: 18, Minute: 15 }]);
  assert.equal(plist.RunAtLoad, false);
  assert.equal(await defaultReadPlist(path.join(FIXTURES, 'missing.plist'), { timeoutMs: TIMEOUTS.launchctlMs }), null);
});

// systemd: scripted `systemctl show` output from test/fixtures/systemd/,
// fed through the default reader, so the parsing is the real one.
const SYSTEMD_FIXTURES = fileURLToPath(new URL('./fixtures/systemd/', import.meta.url));

function showFixture(name) {
  return readFileSync(path.join(SYSTEMD_FIXTURES, name), 'utf8').replaceAll('@FIXTURES@', SYSTEMD_FIXTURES.replace(/\/$/, ''));
}

// The ok fixture's service with a timer whose OnCalendar values are `specs`.
function withCalendars(specs) {
  const [service] = showFixture('ok.txt').split('\n\n');
  const calendars = specs.map((spec) => `TimersCalendar={ OnCalendar=${spec} ; next_elapse=@1791697200 }\n`).join('');
  return `${service}\n\n${calendars}LoadState=loaded\nActiveState=active\n`;
}

function systemdJobsFor({ agents, show, log, focus = null }) {
  const forbidden = async () => assert.fail('the launchd source must not be read under systemd');
  return createJobs({
    registry: fakeRegistry(agents),
    launchAgentsDir: LAUNCH_AGENTS,
    jobRunner: 'systemd',
    focus,
    timeouts: TIMEOUTS,
    log,
    readPlist: forbidden,
    launchctlList: forbidden,
    systemctlShow: show,
  });
}

async function systemdOne(stdout) {
  const scripted = scriptedRun(() => ({ stdout }));
  const jobs = systemdJobsFor({
    agents: [agent('a', ['com.x.job'])],
    show: (label, { signal }) => defaultSystemctlShow(label, { timeoutMs: 100, run: scripted.run, signal }),
  });
  const { jobs: [job] } = await jobs.refresh();
  return job;
}

test('systemd outcomes: running, ok, failed, and an unknown unit, without reading a plist or launchctl', async () => {
  const running = await systemdOne(showFixture('running.txt'));
  assert.deepEqual([running.source, running.available, running.outcome, running.exitStatus, running.lastRun],
    ['systemd', true, 'running', 0, '2026-10-10T05:40:00.000Z']);
  assert.deepEqual([running.failures24h, running.paused], [null, null]);

  const activating = await systemdOne(showFixture('failed.txt').replace('ActiveState=failed', 'ActiveState=activating'));
  assert.equal(activating.outcome, 'running');
  const activeWithoutPid = await systemdOne(showFixture('ok.txt').replace('ActiveState=inactive', 'ActiveState=active'));
  assert.equal(activeWithoutPid.outcome, 'ok');

  const ok = await systemdOne(showFixture('ok.txt'));
  assert.deepEqual([ok.outcome, ok.exitStatus, ok.lastRun], ['ok', 0, '2026-10-10T05:40:00.000Z']);

  const failed = await systemdOne(showFixture('failed.txt'));
  assert.deepEqual([failed.outcome, failed.exitStatus], ['failed', 2]);

  const unknown = await systemdOne(showFixture('unknown.txt'));
  assert.deepEqual(unknown, {
    label: 'com.x.job', agentId: 'a', agentName: 'A', name: 'job',
    schedule: { kind: 'unknown', text: 'Schedule unavailable' }, logPath: null, lastRun: null,
    outcome: 'unknown', exitStatus: null, failures24h: null, paused: null, source: 'systemd', available: false,
  });
});

test('systemd schedules are described from the timer in the same words as plists', async () => {
  const forms = [
    [['*-*-* 05:40:00'], 'calendar', 'Daily at 05:40'],
    [['*-*-* 18:15:00', '*-*-* 06:15:00'], 'calendar', 'Daily at 06:15, 18:15'],
    [['Mon..Fri *-*-* 05:15:00'], 'calendar', 'Weekdays at 05:15'],
    [['Sat,Sun *-*-* 09:05:00'], 'calendar', 'Weekends at 09:05'],
    [['Mon,Wed *-*-* 07:00:00'], 'calendar', 'Mon, Wed at 07:00'],
    [['*-*-* *:05:00'], 'calendar', 'Hourly at :05'],
    [['*-*-01 03:00:00'], 'calendar', 'Monthly on the 1st at 03:00'],
    [['*-*-* 05:40:30'], 'custom', 'Custom schedule'],
    [['*-01-01 00:00:00'], 'custom', 'Custom schedule'],
    [['*-*-* 05:40:00', 'Mon *-*-* 06:00:00'], 'custom', 'Custom schedule'],
    [[], 'custom', 'Custom schedule'],
  ];
  for (const [specs, kind, text] of forms) {
    const job = await systemdOne(withCalendars(specs));
    assert.deepEqual(job.schedule, { kind, text }, specs.join(' | '));
  }
  const noTimer = await systemdOne(showFixture('no-timer.txt'));
  assert.deepEqual([noTimer.available, noTimer.schedule], [true, { kind: 'unknown', text: 'Schedule unavailable' }]);
});

test('a systemd job\'s logPath is the append: path from its unit file, and lastRun falls back to the log\'s mtime', async (t) => {
  const ok = await systemdOne(showFixture('ok.txt'));
  assert.equal(ok.logPath, '/nonexistent/logs/sample.out.log');
  const errOnly = await systemdOne(showFixture('ok.txt').replace('StandardOutput=append', 'StandardOutput=journal'));
  assert.equal(errOnly.logPath, '/nonexistent/logs/sample.err.log');
  const inherit = await systemdOne(showFixture('running.txt'));
  assert.equal(inherit.logPath, null);
  assert.deepEqual(unitsFromShow('StandardOutput=append:/var/log/x.log\nLoadState=loaded\n').service.StandardOutput, 'append:/var/log/x.log');

  const dir = await tempDir(t);
  const log = path.join(dir, 'sample.log');
  await writeFile(log, 'ran\n');
  const when = new Date('2026-10-01T05:40:00.000Z');
  await utimes(log, when, when);
  const unit = path.join(dir, 'com.x.job.service');
  await writeFile(unit, `[Service]\nStandardOutput=append:${log}\n`);
  const neverStarted = await systemdOne(showFixture('no-timer.txt')
    .replace('StandardOutput=inherit', 'StandardOutput=append')
    .replace('FragmentPath=/nonexistent/com.example.sample.service', `FragmentPath=${unit}`));
  assert.deepEqual([neverStarted.logPath, neverStarted.lastRun], [log, when.toISOString()]);

  const fromUnit = async (line) => {
    await writeFile(unit, `[Service]\n${line}\n`);
    return (await systemdOne(showFixture('no-timer.txt')
      .replace('StandardOutput=inherit', 'StandardOutput=append')
      .replace('FragmentPath=/nonexistent/com.example.sample.service', `FragmentPath=${unit}`))).logPath;
  };
  assert.equal(await fromUnit('StandardOutput=append:%h/logs/feeds.log'), path.join(os.homedir(), 'logs/feeds.log'));
  assert.equal(await fromUnit('StandardOutput=append:%t/feeds.log'), null);
  assert.equal(await fromUnit('StandardOutput=append:logs/feeds.log'), null);
});

test('defaultSystemctlShow asks for the service and timer user units, and a failure is null and logged', async () => {
  const scripted = scriptedRun(() => ({ stdout: showFixture('unknown.txt') }));
  assert.deepEqual(await defaultSystemctlShow('com.x.job', { timeoutMs: 100, run: scripted.run }), { service: null, timer: null });
  const { command, args, options } = scripted.calls[0];
  assert.equal(command, 'systemctl');
  assert.deepEqual(args.slice(0, 5), ['--user', 'show', '--timestamp=unix', 'com.x.job.service', 'com.x.job.timer']);
  assert.match(args[5], /^--property=.*LoadState.*TimersCalendar/);
  assert.equal(options.timeout, 100);

  const errors = [];
  const broken = scriptedRun(() => ({ error: Object.assign(new Error('Failed to connect to bus'), { code: 1 }) }));
  assert.equal(await defaultSystemctlShow('com.x.job', { timeoutMs: 100, run: broken.run, onError: (...args) => errors.push(args) }), null);
  assert.equal(errors.length, 1);
  const aborted = scriptedRun(() => ({ error: Object.assign(new Error('aborted'), { name: 'AbortError' }) }));
  assert.equal(await defaultSystemctlShow('com.x.job', { timeoutMs: 100, run: aborted.run, onError: (...args) => errors.push(args) }), null);
  assert.equal(errors.length, 1);
});

test('under systemd a failing systemctl leaves every job unavailable and is logged once', async () => {
  const logs = [];
  const jobs = systemdJobsFor({
    agents: [agent('a', ['com.x.one', 'com.x.two'])],
    show: async () => { throw new Error('systemctl missing'); },
    log: (entry) => logs.push(entry),
  });
  const { jobs: list } = await jobs.refresh();
  assert.deepEqual(list.map((job) => [job.available, job.outcome, job.source]), [[false, 'unknown', 'systemd'], [false, 'unknown', 'systemd']]);
  assert.deepEqual(logs, [{ event: 'systemctl_error', label: 'com.x.one', error: 'systemctl missing' }]);
});

test('under systemd a Focus scan still takes its state from Focus', async () => {
  const jobs = systemdJobsFor({
    agents: [agent('focus', ['com.focus.scan-gmail'])],
    show: async () => unitsFromShow(showFixture('ok.txt')),
    focus: { fetchStatus: async () => ({ paused: false, sources: { gmail: { lastRun: '2026-10-08T06:00:00.000Z', lastOutcome: 'wrote', failures24h: 0 } } }) },
  });
  const { focusAvailable, jobs: [job] } = await jobs.refresh();
  assert.equal(focusAvailable, true);
  assert.deepEqual([job.source, job.outcome, job.lastRun, job.failures24h, job.paused], ['focus', 'wrote', '2026-10-08T06:00:00.000Z', 0, false]);
});

test('on a host with no such units the real systemctl lists each job as unavailable (needs systemctl)', async (t) => {
  if (spawnSync('systemctl', ['--version']).status !== 0) {
    t.skip('systemctl is not available');
    return;
  }
  const jobs = systemdJobsFor({ agents: [agent('a', ['com.personal-assistant.test-nonexistent-job'])] });
  const { jobs: [job] } = await jobs.refresh();
  assert.deepEqual([job.available, job.outcome, job.source], [false, 'unknown', 'systemd']);
});
