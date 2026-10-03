// Entry point: load configuration, load the agent registry and the Codex
// terminal bindings, compose the jobs view, thread store, runtime
// adapters (Claude for personas, Codex for the shared app-server's threads),
// the cmux client, the routine store (loaded before the hub, so its
// snapshot lists them) and the scheduler that runs them, the notification
// store (loaded before the hub too), state hub, the Goals, Feed, and feed instructions
// readers, the settings store, the brief notices, and app, start the
// personas, seed the settings file on first start, post any brief notice
// not yet in the thread of the agent the settings name, start the
// scheduler (which closes runs the last process left open and catches
// up), listen on
// 127.0.0.1, and shut down within a bounded window on SIGTERM/SIGINT. Importing this module does nothing; `node server.mjs`
// runs main(). A missing or invalid registry does not stop startup; the hub
// reports it.
//
// Cost guard: when ANTHROPIC_API_KEY or OPENAI_API_KEY is set in the
// environment, no adapters are created (logged as adapters_disabled), so
// every persona is unavailable with lastError 'api_key_in_env'. Persona
// turns must bill the subscription, never an API key.
//
// Shutdown order: stop the scheduler (no new runs; in-flight runs are left
// to the next start to close), stop the notice timer, end event streams and refuse new sends (closeStreams),
// close each adapter (Claude drains running turns for up to drainMs, then
// aborts the rest and waits abortGraceMs for them; Codex closes its socket),
// close the cmux client's socket, close the hub, stop the registry and
// bindings polls, then close the server
// (shutdownMs grace). main() forces exit
// forcedExitMs(timeouts) after the signal: one second past that sum.

import http from 'node:http';
import path from 'node:path';

import { createApp, defaultLog } from './lib/app.mjs';
import { createBindings } from './lib/bindings.mjs';
import { createBriefRoutes } from './lib/brief-adapter.mjs';
import { createDelegation } from './lib/delegation.mjs';
import { createFeed } from './lib/feed.mjs';
import { createBriefInstructions } from './lib/brief-instructions.mjs';
import { createFeedInstructions } from './lib/feed-instructions.mjs';
import { ConfigError, loadConfig } from './lib/config.mjs';
import { createFocusProxy } from './lib/focus-proxy.mjs';
import { createGoals } from './lib/goals.mjs';
import { createHub } from './lib/hub.mjs';
import { createNotices } from './lib/notices.mjs';
import { NOTIFICATIONS_FILE, createNotifications } from './lib/notifications.mjs';
import { createReads } from './lib/reads.mjs';
import { createRegistry } from './lib/registry.mjs';
import { createRoutines } from './lib/routines.mjs';
import { createScheduler } from './lib/scheduler.mjs';
import { createJobs } from './lib/jobs.mjs';
import { createSettings } from './lib/settings.mjs';
import { createClaudeAdapter } from './lib/runtime/claude.mjs';
import { createCmux } from './lib/runtime/cmux.mjs';
import { createCodexAdapter } from './lib/runtime/codex.mjs';
import { createThreadStore } from './lib/threads.mjs';

const API_KEY_VARS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'];

// The Codex adapter is always created: it watches for the owner file itself
// and follows nothing until bin/codex-serve has written one. `turnTools`
// is the Claude adapter's per-turn hook; the server points it at the
// delegation service once the hub exists (delegation.mjs).
function defaultAdapters({ config, store, log, bindings, turnTools = null }) {
  return {
    claude: createClaudeAdapter({ store, config, log, turnTools }),
    codex: createCodexAdapter({
      ownerFile: path.join(config.codexDir, 'owner.json'),
      bound: () => bindings.current().keys(),
      log,
      timeouts: config.timeouts,
      limits: config.limits,
    }),
  };
}

// Starts the dashboard and resolves once it is listening. Rejects on invalid
// configuration or a port already in use; it never picks another port.
// `createAdapters({ config, store, log, bindings, turnTools })` returns the adapters by provider;
// tests pass fakes. It is not called when an API key is in `env`. `timeouts`
// overrides entries of the configured timeouts; tests shorten polls with it.
export async function startDashboard({ env = process.env, log, createAdapters = defaultAdapters, timeouts = null } = {}) {
  const loaded = loadConfig(env);
  const config = timeouts ? Object.freeze({ ...loaded, timeouts: Object.freeze({ ...loaded.timeouts, ...timeouts }) }) : loaded;
  const focus = createFocusProxy(config);
  const brief = createBriefRoutes(config);
  const logEntry = log ?? defaultLog;
  const registry = createRegistry({ path: config.registryPath, log: logEntry });
  const bindings = createBindings({ path: path.join(config.codexDir, 'bindings.json'), pollMs: config.timeouts.codexPollMs, log: logEntry });
  const jobs = createJobs({
    registry,
    launchAgentsDir: config.launchAgentsDir,
    focus,
    timeouts: config.timeouts,
    log: logEntry,
  });
  const store = createThreadStore({ dir: config.threadsDir, limits: config.limits, log: logEntry });
  // Keep the read store beside the thread directory so test and throwaway
  // instances inherit the same isolation from DASHBOARD_THREADS_DIR.
  const reads = createReads({ file: path.join(path.dirname(config.threadsDir), 'thread-reads.json'), log: logEntry });
  const apiKeyInEnv = API_KEY_VARS.some((name) => typeof env[name] === 'string' && env[name] !== '');
  let adapters = {};
  // Assigned once the hub exists; the adapters are created first because
  // the hub takes them, and the hook is only called from a turn.
  let delegation = null;
  const turnTools = (agent, context) => (delegation ? delegation.toolsFor(agent, context) : null);
  if (apiKeyInEnv) {
    logEntry({ event: 'adapters_disabled', reason: 'api_key_in_env' });
  } else {
    adapters = createAdapters({ config, store, log: logEntry, bindings, turnTools });
  }
  // The cmux client is not a model runtime, so the cost guard leaves it be.
  // It reads nothing until the first refresh.
  const cmux = createCmux({
    socketPathFile: config.cmuxSocketPathFile,
    passwordFile: config.cmuxPasswordFile,
    cli: config.cmuxCli,
    log: logEntry,
    timeouts: config.timeouts,
    limits: config.limits,
  });
  const settings = createSettings({ path: config.settingsPath, log: logEntry });
  await settings.load();
  const routines = createRoutines({ dir: config.routinesDir, limits: config.limits, log: logEntry });
  await routines.load();
  const notifications = createNotifications({
    file: path.join(config.notificationsDir, NOTIFICATIONS_FILE), limits: config.limits, log: logEntry,
  });
  // An unreadable file leaves the list empty rather than the daemon down.
  await notifications.load().catch((error) => logEntry({ event: 'notifications_load_error', error: error?.message ?? String(error) }));
  const hub = createHub({
    registry,
    jobs,
    routines,
    timeZone: config.timeZone,
    focus,
    brief,
    timeouts: config.timeouts,
    limits: config.limits,
    adapters,
    store,
    bindings,
    cmux,
    adaptersDisabled: apiKeyInEnv ? 'api_key_in_env' : null,
    settings,
    reads,
    notifications,
    log: logEntry,
  });
  delegation = createDelegation({ hub, registry, notifications, limits: config.limits, timeouts: config.timeouts, log: logEntry });
  const scheduler = createScheduler({ routines, hub, zone: config.timeZone, timeouts: config.timeouts, limits: config.limits, log: logEntry });
  const goals = createGoals({ registry, limits: config.limits, log: logEntry });
  const feed = createFeed({ dir: config.feedDir, limits: config.limits, log: logEntry });
  const feedInstructions = createFeedInstructions({ file: config.feedInstructionsPath, limits: config.limits, log: logEntry });
  const briefInstructions = createBriefInstructions({ file: config.briefInstructionsPath, limits: config.limits, log: logEntry });
  const notices = createNotices({
    briefsDir: config.briefsDir,
    threadsDir: config.threadsDir,
    hub,
    target: () => settings.current().settings.brief.agent,
    limits: config.limits,
    log: logEntry,
  });
  const app = createApp({
    config, focus, brief, hub, store, cmux, goals, feed, feedInstructions, briefInstructions, notices, settings, registry, routines,
    scheduler, notifications, log: logEntry,
  });
  const server = http.createServer(app);
  server.headersTimeout = config.timeouts.headersMs;
  server.requestTimeout = config.timeouts.requestMs;
  server.keepAliveTimeout = config.timeouts.keepAliveMs;

  const shutdownState = async () => {
    scheduler.stop();
    notices.stop();
    app.closeStreams();
    await Promise.all(Object.values(adapters).map((adapter) => adapter.close()));
    cmux.close();
    hub.close();
    registry.stop();
    bindings.stop();
  };

  await Promise.all([registry.start(), bindings.start()]);
  await reads.load((registry.current()?.agents ?? []).filter((agent) => agent.kind === 'persona').map((agent) => agent.id));
  await seedSettings({ settings, registry, log: logEntry });
  await hub.start();
  hub.keepJobsCurrent();
  // The brief notice waiting since the last run, if any; never fatal.
  await notices.reconcile();
  await scheduler.start();
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen({ host: config.bindHost, port: config.port, exclusive: true }, () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch (error) {
    await shutdownState();
    throw error;
  }

  let closing;
  const close = () => (closing ??= shutdownState().then(() => closeServer(server, config.timeouts.shutdownMs)));
  return { server, config, close };
}

// First start: when there is no settings file yet, write the defaults with
// the brief going to the first pinned Claude persona the registry lists (or
// no one), so no agent id lives in code. A present file is left alone, and
// a failure to write is logged, never fatal: the daemon runs on defaults.
async function seedSettings({ settings, registry, log }) {
  const agents = registry.current()?.agents ?? [];
  const target = agents.find((agent) => agent.kind === 'persona' && agent.provider === 'claude' && agent.pinned === true) ?? null;
  try {
    const wrote = await settings.seed({ brief: { agent: target?.id ?? null } });
    if (wrote) log({ event: 'settings_seeded', agent: target?.id ?? null });
  } catch (error) {
    log({ event: 'settings_seed_error', error: error?.message ?? String(error) });
  }
}

// How long main() gives the orderly shutdown before it forces the exit: the
// drain, the abort grace, and the server's grace, plus one second of slack.
export function forcedExitMs(timeouts) {
  return timeouts.drainMs + timeouts.abortGraceMs + timeouts.shutdownMs + 1_000;
}

// Stops accepting connections, lets in-flight requests finish, and cuts any
// that remain after `graceMs`.
function closeServer(server, graceMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => server.closeAllConnections(), graceMs);
    timer.unref();
    server.close(() => {
      clearTimeout(timer);
      resolve();
    });
    server.closeIdleConnections();
  });
}

async function main() {
  let dashboard;
  try {
    dashboard = await startDashboard();
  } catch (error) {
    if (error instanceof ConfigError) console.error(`dashboard: invalid configuration: ${error.message}`);
    else if (error.code === 'EADDRINUSE') console.error(`dashboard: port already in use: ${error.port}`);
    else console.error(`dashboard: failed to start: ${error.code ?? error.name}`);
    process.exitCode = 1;
    return;
  }

  const { server, config, close } = dashboard;
  console.log(`dashboard: listening on http://${config.bindHost}:${config.port}`);
  server.on('error', (error) => {
    console.error(`dashboard: server error: ${error.code ?? error.name}`);
    process.exit(1);
  });

  const stop = (signal) => {
    console.log(`dashboard: ${signal} received, shutting down`);
    setTimeout(() => process.exit(1), forcedExitMs(config.timeouts)).unref();
    close().then(() => process.exit(0), (error) => {
      console.error(`dashboard: shutdown failed: ${error?.message ?? error}`);
      process.exit(1);
    });
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

if (import.meta.main) await main();
