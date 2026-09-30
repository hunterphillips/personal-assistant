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
//   DASHBOARD_FOCUS_ORIGIN      Focus server, http:// loopback only (default http://127.0.0.1:4242)
//   DASHBOARD_REGISTRY_PATH     agent registry JSON file (default ../../registry/agents.json)
//   DASHBOARD_LAUNCH_AGENTS_DIR directory holding launchd plists (default ~/Library/LaunchAgents)
//   DASHBOARD_THREADS_DIR       persona session pointers and message caches (default var/threads)
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
const DEFAULT_REGISTRY_PATH = '../../registry/agents.json';
const DEFAULT_THREADS_DIR = 'var/threads';
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
  feedInstructionsBytes: 64 * 1024, // the feed's criteria file read by the Feed view
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
  const registryPath = parsePath(env.DASHBOARD_REGISTRY_PATH, DEFAULT_REGISTRY_PATH);
  // The default is already absolute, so path.resolve keeps it as-is; only a
  // relative override is resolved from APP_ROOT.
  const launchAgentsDir = parsePath(env.DASHBOARD_LAUNCH_AGENTS_DIR, path.join(os.homedir(), 'Library', 'LaunchAgents'));
  const threadsDir = parsePath(env.DASHBOARD_THREADS_DIR, DEFAULT_THREADS_DIR);
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
    registryPath,
    launchAgentsDir,
    threadsDir,
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
