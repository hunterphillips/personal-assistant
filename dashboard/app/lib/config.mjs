// Configuration for the dashboard process. Everything is read from environment
// variables once, validated, and frozen. Every store defaults under the data
// root (layout.mjs); a relative override resolves from this source file's
// location, never from the working directory.
//
//   PERSONAL_ASSISTANT_HOME     the data root, an absolute path (default ~/.personal-assistant);
//                               config.home
//   DASHBOARD_MIGRATE_FROM      the checkout the first start moves its data out of, an
//                               absolute path (default the repository; empty for none);
//                               config.migrateFrom, null when empty
//   DASHBOARD_PORT              loopback port to bind (default 4243)
//   DASHBOARD_PUBLIC_ORIGIN     optional https:// tailnet origin; its host joins the
//                               Host and Origin allowlists
//   DASHBOARD_BRIEFS_DIR        generated brief directory (default <home>/briefs)
//   DASHBOARD_FEEDS_DIR         the feeds, one folder each (default <home>/feeds)
//   DASHBOARD_SOURCES_DIR       the sources the feeds read (default <home>/sources)
//   DASHBOARD_IDEAS_DIR         the Ideas runs the producers write (default <home>/ideas/items)
//   DASHBOARD_IDEAS_MARKS       the marks the Ideas view writes (default <home>/ideas/marks.json)
//   DASHBOARD_IDEAS_INSTRUCTIONS the criteria the ideas producer reads
//                               (default <home>/ideas/criteria.md)
//   DASHBOARD_BRIEF_INSTRUCTIONS the rules the brief's curator follows, a contract in the
//                               repository (default ../../daily-brief/curator.md)
//   DASHBOARD_FOCUS_ORIGIN      Focus server, http:// loopback only (default http://127.0.0.1:4242)
//   DASHBOARD_FOCUS_RUNS        the Focus job run records (default <home>/focus/runs)
//   DASHBOARD_FOCUS_GOOGLE      the Focus Google sign-in files (default <home>/focus/google)
//   DASHBOARD_FOCUS_SETTINGS    the Focus scan settings (default <home>/focus/settings.json)
//   DASHBOARD_PERSONAL_CONTEXT  the personal-context store (default ~/workspace/personal-context)
//   DASHBOARD_REGISTRY_PATH     agent registry JSON file (default <home>/registry/agents.json)
//   DASHBOARD_BUILTIN_PATH      the agents that are part of the dashboard, seeded into the
//                               registry when missing (default ../../registry/builtin.json;
//                               need not exist)
//   DASHBOARD_ROUTINES_DIR      the routine files and their runs log (default <home>/routines;
//                               need not exist)
//   DASHBOARD_NOTIFICATIONS_DIR the notifications file agents raise into (default
//                               <home>/notifications; need not exist)
//   DASHBOARD_LAUNCH_AGENTS_DIR directory holding launchd plists (default ~/Library/LaunchAgents)
//   DASHBOARD_JOB_RUNNER        what runs the registry's jobs, launchd or systemd (default
//                               launchd on macOS, systemd elsewhere); config.jobRunner
//   DASHBOARD_THREADS_DIR       persona session pointers and message caches (default
//                               <home>/threads); the read times sit beside it
//   DASHBOARD_SETTINGS_PATH     the settings file the interface writes (default
//                               <home>/settings.json; need not exist)
//   DASHBOARD_CODEX_DIR         the Codex owner file, socket, and terminal bindings written by
//                               bin/codex-serve and bin/codex-new (default <home>/codex)
//   DASHBOARD_CMUX_SOCKET_PATH_FILE  file cmux writes its socket path to while running
//                               (default ~/.local/state/cmux/last-socket-path)
//   DASHBOARD_CMUX_PASSWORD_FILE     file holding the cmux socket password
//                               (default ~/.local/state/cmux/socket-control-password)
//   DASHBOARD_CMUX_CLI          the cmux command-line binary, an absolute path
//                               (default /Applications/cmux.app/Contents/Resources/bin/cmux)

import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defaultHome, layoutPaths } from './layout.mjs';

export const APP_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

const DEFAULT_PORT = 4243;
const DEFAULT_FOCUS_ORIGIN = 'http://127.0.0.1:4242';
const DEFAULT_BRIEF_INSTRUCTIONS = '../../daily-brief/curator.md';
const DEFAULT_BUILTIN_PATH = '../../registry/builtin.json';
// The repository the dashboard lives in: a built-in agent's folder.
const REPO_ROOT = path.resolve(APP_ROOT, '../..');
// Routine schedules run on this clock, following its changes. A constant
// until someone else runs the daemon (no configurability ahead of need).
export const TIME_ZONE = 'America/Chicago';
const DEFAULT_CMUX_CLI = '/Applications/cmux.app/Contents/Resources/bin/cmux';
const BIND_HOST = '127.0.0.1';
const JOB_RUNNERS = new Set(['launchd', 'systemd']);
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

export const LIMITS = Object.freeze({
  focusBodyBytes: 1_000_000,
  feedbackBodyBytes: 128 * 1024,
  eventStreams: 8, // concurrent GET /api/events streams
  turnMaxTurns: 25, // SDK maxTurns per persona turn
  messageTextBytes: 8 * 1024, // one thread message's text, UTF-8
  threadCacheMessages: 200, // messages kept in one thread cache
  threadCacheBytes: 1024 * 1024, // bytes kept in one thread cache
  sendTextBytes: 16 * 1024, // text of one message sent to a persona, UTF-8
  requestInputBytes: 16 * 1024, // a pending request's input as JSON in the snapshot
  previewChars: 200, // characters of a persona's last message in the snapshot
  codexThreads: 20, // most recent Codex threads listed and followed
  codexFrameBytes: 1024 * 1024, // a Codex app-server frame larger than this is dropped
  cmuxFrameBytes: 1024 * 1024, // one line from the cmux socket
  goalsFileBytes: 256 * 1024, // one vault note read by the Goals view
  goalsNotes: 50, // files read from the vault's notes/goals/
  feedFileBytes: 256 * 1024, // one feed run file read by the Feed view
  feedFiles: 30, // newest run files read per feed
  feedNoteBytes: 64 * 1024, // a feed's note.md: a safety bound, not a length rule
  feedBodyBytes: 16 * 1024, // one feeds or sources POST or PUT body, the note's excepted
  sourceFileBytes: 16 * 1024, // one sources/<id>.json or feeds/<id>/feed.json; marks.json is capped at feedFileBytes
  ideasFileBytes: 256 * 1024, // one ideas run, the marks, or the criteria file
  ideaTitleChars: 200, // one producer idea's title
  ideaBodyBytes: 16 * 1024, // one Ideas POST body
  focusChangeBytes: 16 * 1024, // one Focus board change body
  focusBoardBytes: 4 * 1024 * 1024, // the Focus board file
  focusChangesLines: 5000, // newest entries kept in the Focus change log
  focusRunLines: 200, // lines kept in one Focus job's runs log
  focusSettingsBytes: 16 * 1024, // the Focus settings file
  focusCandidatesMax: 25, // candidates kept from one Focus scan
  focusCandidateBytes: 256 * 1024, // one Focus candidates file
  briefInstructionsBytes: 64 * 1024, // the brief's rules file read by the Brief tab
  settingsBodyBytes: 4 * 1024, // one PUT /api/settings body
  agentBodyBytes: 16 * 1024, // one PUT /api/agents/:id/settings or POST /api/agents body
  delegationDepth: 2, // agents a message may pass through before the sender (delegation.mjs)
  delegationMessageChars: 4000, // characters of one ask tool message
  delegationReplyChars: 4000, // characters of a reply handed back to the sender's turn, or prepended to its next prompt
  delegationPendingReplies: 5, // replies carried into the sender's next turn
  routineBodyBytes: 16 * 1024, // one POST or PUT /api/routines body
  routineNameChars: 60, // a routine's name
  routineInstructionChars: 4000, // a routine's instruction
  routineRunLines: 200, // lines kept in one routine's runs log
  routineRunsShown: 10, // runs GET /api/routines/:id/runs answers
  routineReplyChars: 2000, // characters of a run's reply kept on its end line
  routineMissedMax: 100, // missed occurrences counted before the count is capped
  routineCatchupDays: 7, // how far back a routine's marker may reach on start
  routinesMax: 100, // routine files
  notificationsMax: 200, // notifications kept in the file; acknowledged ones roll off first
  notificationTextChars: 500, // one notification's sentence
  jobsRefreshMs: 5 * 60_000, // keep the rail's Health mark current without opening Health
});

export const TIMEOUTS = Object.freeze({
  headersMs: 10_000, // client must finish sending headers
  requestMs: 30_000, // client must finish sending the whole request
  keepAliveMs: 5_000,
  upstreamMs: 10_000, // Focus proxy budget per request (phase 2)
  statusMs: 2_000, // per-dependency budget for the hub's status refresh
  shutdownMs: 5_000, // SIGTERM grace before open connections are cut
  launchctlMs: 3_000, // budget for one launchctl call
  heartbeatMs: 25_000, // comment ping on each open event stream
  statusPollMs: 30_000, // status refresh while any event stream is open
  noticePollMs: 60_000, // brief notice check while any event stream is open (notices.mjs)
  delegationWaitMs: 5_000, // how long the ask tool waits for the receiver before answering pending (delegation.mjs)
  drainMs: 30_000, // wait for busy persona turns at shutdown
  abortGraceMs: 2_000, // wait for aborted turns to end after the drain
  requestMaxAgeMs: 30 * 60_000, // a question or approval unanswered this long is denied
  turnMaxMs: 30 * 60_000, // a persona turn, waiting included, is interrupted after this
  codexPollMs: 3_000, // owner and bindings files are checked this often
  codexReconnectMs: 1_000, // first wait before reconnecting to the Codex app-server
  codexReconnectMaxMs: 30_000, // the reconnect wait doubles up to this
  codexRpcMs: 15_000, // one request to the Codex app-server must be answered within this
  sessionsPollMs: 10_000, // cmux inventory and Codex catalogue refresh while any event stream is open
  cmuxRequestMs: 5_000, // the cmux auth handshake, and separately each socket request
  cmuxSessionsMs: 5_000, // budget for one `cmux sessions list --json`
  cmuxStaleMs: 5 * 60_000, // a cached cmux inventory is served stale for at most this long
  routineTickMs: 30_000, // the scheduler asks what is due this often (scheduler.mjs)
  focusScanMs: 60_000, // one Focus scan
  focusCurateMs: 300_000, // one Focus curate pass
  focusTickMs: 30_000, // the Focus scheduler's due check
});

export class ConfigError extends Error {
  constructor(problems) {
    super(problems.join('; '));
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

export function loadConfig(env = process.env, { platform = process.platform } = {}) {
  const problems = [];
  const jobRunner = parseJobRunner(env.DASHBOARD_JOB_RUNNER, platform, problems);
  const port = parsePort(env.DASHBOARD_PORT, problems);
  const publicOrigin = parsePublicOrigin(env.DASHBOARD_PUBLIC_ORIGIN, problems);
  const focusOrigin = parseFocusOrigin(env.DASHBOARD_FOCUS_ORIGIN, problems);
  const home = parseHome(env, problems);
  const migrateFrom = parseMigrateFrom(env.DASHBOARD_MIGRATE_FROM, problems);
  const root = layoutPaths(home ?? defaultHome());
  const briefsDir = parsePath(env.DASHBOARD_BRIEFS_DIR, root.briefsDir);
  const briefReadsPath = parsePath(env.DASHBOARD_BRIEF_READS_PATH, root.briefReads);
  const feedsDir = parsePath(env.DASHBOARD_FEEDS_DIR, root.feedsDir);
  const sourcesDir = parsePath(env.DASHBOARD_SOURCES_DIR, root.sourcesDir);
  const ideasDir = parsePath(env.DASHBOARD_IDEAS_DIR, root.ideasDir);
  const ideasMarksPath = parsePath(env.DASHBOARD_IDEAS_MARKS, root.ideasMarks);
  const ideasInstructionsPath = parsePath(env.DASHBOARD_IDEAS_INSTRUCTIONS, root.ideasInstructions);
  const focusBoardPath = parsePath(env.DASHBOARD_FOCUS_BOARD, root.focusBoard);
  const focusChangesPath = parsePath(env.DASHBOARD_FOCUS_CHANGES, root.focusChanges);
  const focusCandidatesDir = parsePath(env.DASHBOARD_FOCUS_CANDIDATES, root.focusCandidates);
  const focusRunsDir = parsePath(env.DASHBOARD_FOCUS_RUNS, root.focusRuns);
  const focusGoogleDir = parsePath(env.DASHBOARD_FOCUS_GOOGLE, root.focusGoogle);
  const focusSettingsPath = parsePath(env.DASHBOARD_FOCUS_SETTINGS, root.focusSettings);
  const focusRulesPath = parsePath(env.DASHBOARD_FOCUS_RULES, root.focusRules);
  const personalContextDir = parsePath(env.DASHBOARD_PERSONAL_CONTEXT, path.join(os.homedir(), 'workspace', 'personal-context'));
  const briefInstructionsPath = parsePath(env.DASHBOARD_BRIEF_INSTRUCTIONS, DEFAULT_BRIEF_INSTRUCTIONS);
  const registryPath = parsePath(env.DASHBOARD_REGISTRY_PATH, root.registry);
  const routinesDir = parsePath(env.DASHBOARD_ROUTINES_DIR, root.routinesDir);
  const notificationsDir = parsePath(env.DASHBOARD_NOTIFICATIONS_DIR, root.notificationsDir);
  const builtinPath = parsePath(env.DASHBOARD_BUILTIN_PATH, DEFAULT_BUILTIN_PATH);
  // The default is already absolute, so path.resolve keeps it as-is; only a
  // relative override is resolved from APP_ROOT.
  const launchAgentsDir = parsePath(env.DASHBOARD_LAUNCH_AGENTS_DIR, path.join(os.homedir(), 'Library', 'LaunchAgents'));
  const threadsDir = parsePath(env.DASHBOARD_THREADS_DIR, root.threadsDir);
  const settingsPath = parsePath(env.DASHBOARD_SETTINGS_PATH, root.settings);
  const codexDir = parsePath(env.DASHBOARD_CODEX_DIR, root.codexDir);
  const cmuxSocketPathFile = parsePath(env.DASHBOARD_CMUX_SOCKET_PATH_FILE,
    path.join(os.homedir(), '.local', 'state', 'cmux', 'last-socket-path'));
  const cmuxPasswordFile = parsePath(env.DASHBOARD_CMUX_PASSWORD_FILE,
    path.join(os.homedir(), '.local', 'state', 'cmux', 'socket-control-password'));
  const cmuxCli = parsePath(env.DASHBOARD_CMUX_CLI, DEFAULT_CMUX_CLI);

  // Only the exact bound authority is refused; another loopback name or a
  // different address with the same port is a different socket.
  if (focusOrigin && port && focusOrigin.host === `${BIND_HOST}:${port}`) {
    problems.push('DASHBOARD_FOCUS_ORIGIN must not point at the dashboard itself');
  }
  if (problems.length > 0) throw new ConfigError(problems);

  const localAuthorities = [`127.0.0.1:${port}`, `localhost:${port}`];
  const allowedHosts = [...localAuthorities];
  const allowedOrigins = localAuthorities.map((authority) => `http://${authority}`);
  if (publicOrigin) {
    allowedHosts.push(publicOrigin.host);
    allowedOrigins.push(publicOrigin.origin);
  }

  return Object.freeze({
    appRoot: APP_ROOT,
    home,
    migrateFrom,
    // The seeds a new root starts from, and the README written into it.
    defaultsDir: path.join(REPO_ROOT, 'defaults'),
    rootReadme: path.join(APP_ROOT, 'docs', 'root-README.md'),
    publicDir: path.join(APP_ROOT, 'public'),
    bindHost: BIND_HOST,
    port,
    publicOrigin: publicOrigin ? publicOrigin.origin : null,
    focusOrigin: focusOrigin.origin,
    briefsDir,
    briefReadsPath,
    feedsDir,
    sourcesDir,
    ideasDir,
    ideasMarksPath,
    ideasInstructionsPath,
    focusBoardPath,
    focusChangesPath,
    focusCandidatesDir,
    focusRunsDir,
    focusGoogleDir,
    focusSettingsPath,
    focusRulesPath,
    personalContextDir,
    briefInstructionsPath,
    registryPath,
    builtinPath,
    repoRoot: REPO_ROOT,
    routinesDir,
    notificationsDir,
    timeZone: TIME_ZONE,
    launchAgentsDir,
    jobRunner,
    threadsDir,
    settingsPath,
    codexDir,
    cmuxSocketPathFile,
    cmuxPasswordFile,
    cmuxCli,
    allowedHosts: Object.freeze(allowedHosts),
    allowedOrigins: Object.freeze(allowedOrigins),
    limits: LIMITS,
    timeouts: TIMEOUTS,
  });
}

function isUnset(value) {
  return value === undefined || value === '';
}

function parsePort(value, problems) {
  if (isUnset(value)) return DEFAULT_PORT;
  const port = /^\d{1,5}$/.test(value) ? Number(value) : NaN;
  if (!(port >= 1 && port <= 65535)) {
    problems.push('DASHBOARD_PORT must be an integer from 1 to 65535');
    return null;
  }
  return port;
}

// Parses a bare origin: scheme, host, optional port, nothing else.
function parseOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const bare = url.username === '' && url.password === '' && url.pathname === '/' &&
    url.search === '' && url.hash === '' && (value === url.origin || value === `${url.origin}/`);
  return bare ? url : null;
}

function parsePublicOrigin(value, problems) {
  if (isUnset(value)) return null;
  const url = parseOrigin(value);
  if (!url || url.protocol !== 'https:') {
    problems.push('DASHBOARD_PUBLIC_ORIGIN must be a bare https:// origin');
    return null;
  }
  return { origin: url.origin, host: url.host };
}

function parseFocusOrigin(value, problems) {
  const url = parseOrigin(isUnset(value) ? DEFAULT_FOCUS_ORIGIN : value);
  if (!url || url.protocol !== 'http:' || !LOOPBACK_HOSTNAMES.has(url.hostname)) {
    problems.push('DASHBOARD_FOCUS_ORIGIN must be a bare http:// loopback origin');
    return null;
  }
  return { origin: url.origin, host: `${url.hostname}:${url.port || 80}` };
}

function parseJobRunner(value, platform, problems) {
  if (isUnset(value)) return platform === 'darwin' ? 'launchd' : 'systemd';
  if (!JOB_RUNNERS.has(value)) {
    problems.push('DASHBOARD_JOB_RUNNER must be launchd or systemd');
    return null;
  }
  return value;
}

// PERSONAL_ASSISTANT_HOME: unset or empty is the default root; anything
// else must be absolute, since a relative root would follow the working
// directory.
function parseHome(env, problems) {
  const value = env.PERSONAL_ASSISTANT_HOME;
  if (isUnset(value)) return defaultHome();
  if (!path.isAbsolute(value)) {
    problems.push('PERSONAL_ASSISTANT_HOME must be an absolute path');
    return null;
  }
  return path.resolve(value);
}

// DASHBOARD_MIGRATE_FROM: unset is the repository this file lives in; an
// empty value is no migration (null), which every test harness sets.
function parseMigrateFrom(value, problems) {
  if (value === undefined) return REPO_ROOT;
  if (value === '') return null;
  if (!path.isAbsolute(value)) {
    problems.push('DASHBOARD_MIGRATE_FROM must be an absolute path or empty');
    return null;
  }
  return path.resolve(value);
}

// The Codex directory, for the daemon and for the two helper scripts, which
// run outside loadConfig() and must agree with it.
export function codexDirFrom(env = process.env) {
  const problems = [];
  const home = parseHome(env, problems);
  if (problems.length > 0) throw new ConfigError(problems);
  return parsePath(env.DASHBOARD_CODEX_DIR, layoutPaths(home).codexDir);
}

// The job runner, for the installer and uninstaller, which run outside
// loadConfig() and must agree with it.
export function jobRunnerFrom(env = process.env, platform = process.platform) {
  const problems = [];
  const jobRunner = parseJobRunner(env.DASHBOARD_JOB_RUNNER, platform, problems);
  if (problems.length > 0) throw new ConfigError(problems);
  return jobRunner;
}

function parsePath(value, fallback) {
  return path.resolve(APP_ROOT, isUnset(value) ? fallback : value);
}
