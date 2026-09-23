// Configuration for the dashboard process. Everything is read from environment
// variables once, validated, and frozen. Defaults resolve from this source
// file's location, never from the working directory.
//
//   DASHBOARD_PORT           loopback port to bind (default 4243)
//   DASHBOARD_PUBLIC_ORIGIN  optional https:// tailnet origin; its host joins the
//                            Host and Origin allowlists
//   DASHBOARD_BRIEFS_DIR     generated brief directory (default ../../daily-brief/briefs)
//   DASHBOARD_FOCUS_ORIGIN   Focus server, http:// loopback only (default http://127.0.0.1:4242)

import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

const DEFAULT_PORT = 4243;
const DEFAULT_FOCUS_ORIGIN = 'http://127.0.0.1:4242';
const DEFAULT_BRIEFS_DIR = '../../daily-brief/briefs';
const BIND_HOST = '127.0.0.1';
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

export const LIMITS = Object.freeze({
  focusBodyBytes: 1_000_000,
  feedbackBodyBytes: 128 * 1024,
});

export const TIMEOUTS = Object.freeze({
  headersMs: 10_000, // client must finish sending headers
  requestMs: 30_000, // client must finish sending the whole request
  keepAliveMs: 5_000,
  upstreamMs: 10_000, // Focus proxy budget per request (phase 2)
  statusMs: 2_000, // per-dependency budget inside /api/dashboard/status
  shutdownMs: 5_000, // SIGTERM grace before open connections are cut
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
  const briefsDir = parseDirectory(env.DASHBOARD_BRIEFS_DIR, DEFAULT_BRIEFS_DIR);

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

function parseDirectory(value, fallback) {
  return path.resolve(APP_ROOT, isUnset(value) ? fallback : value);
}
