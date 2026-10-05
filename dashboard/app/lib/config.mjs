// Configuration for the dashboard process. Everything is read from environment
// variables once, validated, and frozen. Defaults resolve from this source
// file's location, never from the working directory.
//
//   DASHBOARD_PORT              loopback port to bind (default 4243)
//   DASHBOARD_PUBLIC_ORIGIN     optional https:// tailnet origin; its host joins the
//                               Host and Origin allowlists
//   DASHBOARD_BRIEFS_DIR        generated brief directory (default ../../daily-brief/briefs)
//   DASHBOARD_FEED_DIR          the feed store the producers write (default ../../feed/items)
//   DASHBOARD_FEED_INSTRUCTIONS the criteria file the watch job reads
//                               (default ../../daily-brief/watch/relevance.md)
//   DASHBOARD_BRIEF_INSTRUCTIONS the rules the brief's curator follows
//                               (default ../../daily-brief/curator.md)
//   DASHBOARD_FOCUS_ORIGIN      Focus server, http:// loopback only (default http://127.0.0.1:4242)
//   DASHBOARD_REGISTRY_PATH     agent registry JSON file (default ../../registry/agents.json)
//   DASHBOARD_BUILTIN_PATH      the agents that are part of the dashboard, seeded into the
//                               registry when missing (default ../../registry/builtin.json;
//                               need not exist)
//   DASHBOARD_ROUTINES_DIR      the routine files and their runs log (default ../../routines,
//                               beside registry/; need not exist)
//   DASHBOARD_NOTIFICATIONS_DIR the notifications file agents raise into (default
//                               ../../notifications, beside registry/; need not exist)
//   DASHBOARD_LAUNCH_AGENTS_DIR directory holding launchd plists (default ~/Library/LaunchAgents)
//   DASHBOARD_THREADS_DIR       persona session pointers and message caches (default var/threads)
//   DASHBOARD_SETTINGS_PATH     the settings file the interface writes (default var/settings.json;
//                               need not exist)
//   DASHBOARD_CODEX_DIR         the Codex owner file, socket, and terminal bindings written by
//                               bin/codex-serve and bin/codex-new (default var/codex)
//   DASHBOARD_CMUX_SOCKET_PATH_FILE  file cmux writes its socket path to while running
//                               (default ~/.local/state/cmux/last-socket-path)
//   DASHBOARD_CMUX_PASSWORD_FILE     file holding the cmux socket password
//                               (default ~/.local/state/cmux/socket-control-password)
//   DASHBOARD_CMUX_CLI          the cmux command-line binary, an absolute path
//                               (default /Applications/cmux.app/Contents/Resources/bin/cmux)

import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

const DEFAULT_PORT = 4243;
const DEFAULT_FOCUS_ORIGIN = 'http://127.0.0.1:4242';
const DEFAULT_BRIEFS_DIR = '../../daily-brief/briefs';
const DEFAULT_FEED_DIR = '../../feed/items';
const DEFAULT_FEED_INSTRUCTIONS = '../../daily-brief/watch/relevance.md';
const DEFAULT_IDEAS_DIR = '../../ideas/items';
const DEFAULT_IDEAS_MARKS = '../../ideas/marks.json';
const DEFAULT_IDEAS_INSTRUCTIONS = '../../ideas/criteria.md';
const DEFAULT_BRIEF_INSTRUCTIONS = '../../daily-brief/curator.md';
const DEFAULT_REGISTRY_PATH = '../../registry/agents.json';
const DEFAULT_ROUTINES_DIR = '../../routines';
const DEFAULT_NOTIFICATIONS_DIR = '../../notifications';
const DEFAULT_BUILTIN_PATH = '../../registry/builtin.json';
// The repository the dashboard lives in: a built-in agent's folder.
const REPO_ROOT = path.resolve(APP_ROOT, '../..');
// Routine schedules run on this clock, following its changes. A constant
// until someone else runs the daemon (no configurability ahead of need).
export const TIME_ZONE = 'America/Chicago';
const DEFAULT_THREADS_DIR = 'var/threads';
const DEFAULT_SETTINGS_PATH = 'var/settings.json';
export const DEFAULT_CODEX_DIR = 'var/codex';
const DEFAULT_CMUX_CLI = '/Applications/cmux.app/Contents/Resources/bin/cmux';
const BIND_HOST = '127.0.0.1';
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
  feedFiles: 30, // newest feed run files read
  ideasFileBytes: 256 * 1024, // one ideas run, the marks, or the criteria file
  ideaTitleChars: 200, // one producer idea's title
  ideaBodyBytes: 16 * 1024, // one Ideas POST body
  feedInstructionsBytes: 64 * 1024, // the feed's criteria file read by the Feed view
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
});

export class ConfigError extends Error {
  constructor(problems) {
    super(problems.join('; '));
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

export function loadConfig(env = process.env) {
  const problems = [];
  const port = parsePort(env.DASHBOARD_PORT, problems);
  const publicOrigin = parsePublicOrigin(env.DASHBOARD_PUBLIC_ORIGIN, problems);
  const focusOrigin = parseFocusOrigin(env.DASHBOARD_FOCUS_ORIGIN, problems);
  const briefsDir = parsePath(env.DASHBOARD_BRIEFS_DIR, DEFAULT_BRIEFS_DIR);
  const feedDir = parsePath(env.DASHBOARD_FEED_DIR, DEFAULT_FEED_DIR);
  const feedInstructionsPath = parsePath(env.DASHBOARD_FEED_INSTRUCTIONS, DEFAULT_FEED_INSTRUCTIONS);
  const ideasDir = path.resolve(APP_ROOT, DEFAULT_IDEAS_DIR);
  const ideasMarksPath = path.resolve(APP_ROOT, DEFAULT_IDEAS_MARKS);
  const ideasInstructionsPath = path.resolve(APP_ROOT, DEFAULT_IDEAS_INSTRUCTIONS);
  const briefInstructionsPath = parsePath(env.DASHBOARD_BRIEF_INSTRUCTIONS, DEFAULT_BRIEF_INSTRUCTIONS);
  const registryPath = parsePath(env.DASHBOARD_REGISTRY_PATH, DEFAULT_REGISTRY_PATH);
  const routinesDir = parsePath(env.DASHBOARD_ROUTINES_DIR, DEFAULT_ROUTINES_DIR);
  const notificationsDir = parsePath(env.DASHBOARD_NOTIFICATIONS_DIR, DEFAULT_NOTIFICATIONS_DIR);
  const builtinPath = parsePath(env.DASHBOARD_BUILTIN_PATH, DEFAULT_BUILTIN_PATH);
  // The default is already absolute, so path.resolve keeps it as-is; only a
  // relative override is resolved from APP_ROOT.
  const launchAgentsDir = parsePath(env.DASHBOARD_LAUNCH_AGENTS_DIR, path.join(os.homedir(), 'Library', 'LaunchAgents'));
  const threadsDir = parsePath(env.DASHBOARD_THREADS_DIR, DEFAULT_THREADS_DIR);
  const settingsPath = parsePath(env.DASHBOARD_SETTINGS_PATH, DEFAULT_SETTINGS_PATH);
  const codexDir = codexDirFrom(env);
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
    publicDir: path.join(APP_ROOT, 'public'),
    bindHost: BIND_HOST,
    port,
    publicOrigin: publicOrigin ? publicOrigin.origin : null,
    focusOrigin: focusOrigin.origin,
    briefsDir,
    feedDir,
    feedInstructionsPath,
    ideasDir,
    ideasMarksPath,
    ideasInstructionsPath,
    briefInstructionsPath,
    registryPath,
    builtinPath,
    repoRoot: REPO_ROOT,
    routinesDir,
    notificationsDir,
    timeZone: TIME_ZONE,
    launchAgentsDir,
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

// The Codex directory, for the daemon and for the two helper scripts, which
// run outside loadConfig() and must agree with it.
export function codexDirFrom(env = process.env) {
  return parsePath(env.DASHBOARD_CODEX_DIR, DEFAULT_CODEX_DIR);
}

function parsePath(value, fallback) {
  return path.resolve(APP_ROOT, isUnset(value) ? fallback : value);
}
