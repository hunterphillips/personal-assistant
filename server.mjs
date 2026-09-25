// Entry point: load configuration, load the agent registry, compose the
// routines view, thread store, persona adapters, state hub, and app, start
// the personas, listen on 127.0.0.1, and shut down within a bounded window
// on SIGTERM/SIGINT. Importing this module does nothing; `node server.mjs`
// runs main(). A missing or invalid registry does not stop startup; the hub
// reports it.
//
// Cost guard: when ANTHROPIC_API_KEY or OPENAI_API_KEY is set in the
// environment, no adapters are created (logged as adapters_disabled), so
// every persona is unavailable with lastError 'api_key_in_env'. Persona
// turns must bill the subscription, never an API key.
//
// Shutdown order: end event streams and refuse new sends (closeStreams),
// close each adapter (which drains running turns for up to drainMs), close
// the hub, stop the registry, then close the server (shutdownMs grace).
// main() forces exit drainMs + shutdownMs after the signal.

import http from 'node:http';

import { createApp, defaultLog } from './lib/app.mjs';
import { createBriefRoutes } from './lib/brief-adapter.mjs';
import { ConfigError, loadConfig } from './lib/config.mjs';
import { createFocusProxy } from './lib/focus-proxy.mjs';
import { createHub } from './lib/hub.mjs';
import { createRegistry } from './lib/registry.mjs';
import { createRoutines } from './lib/routines.mjs';
import { createClaudeAdapter } from './lib/runtime/claude.mjs';
import { createThreadStore } from './lib/threads.mjs';

const API_KEY_VARS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'];

function defaultAdapters({ config, store, log }) {
  return { claude: createClaudeAdapter({ store, config, log }) };
}

// Starts the dashboard and resolves once it is listening. Rejects on invalid
// configuration or a port already in use; it never picks another port.
// `createAdapters({ config, store, log })` returns the adapters by provider;
// tests pass fakes. It is not called when an API key is in `env`.
export async function startDashboard({ env = process.env, log, createAdapters = defaultAdapters } = {}) {
  const config = loadConfig(env);
  const focus = createFocusProxy(config);
  const brief = createBriefRoutes(config);
  const logEntry = log ?? defaultLog;
  const registry = createRegistry({ path: config.registryPath, log: logEntry });
  const routines = createRoutines({
    registry,
    launchAgentsDir: config.launchAgentsDir,
    focus,
    timeouts: config.timeouts,
    log: logEntry,
  });
  const store = createThreadStore({ dir: config.threadsDir, limits: config.limits, log: logEntry });
  const apiKeyInEnv = API_KEY_VARS.some((name) => typeof env[name] === 'string' && env[name] !== '');
  let adapters = {};
  if (apiKeyInEnv) {
    logEntry({ event: 'adapters_disabled', reason: 'api_key_in_env' });
  } else {
    adapters = createAdapters({ config, store, log: logEntry });
  }
  const hub = createHub({
    registry,
    routines,
    focus,
    brief,
    timeouts: config.timeouts,
    limits: config.limits,
    adapters,
    store,
    adaptersDisabled: apiKeyInEnv ? 'api_key_in_env' : null,
    log: logEntry,
  });
  const app = createApp({ config, focus, brief, hub, store, log: logEntry });
  const server = http.createServer(app);
  server.headersTimeout = config.timeouts.headersMs;
  server.requestTimeout = config.timeouts.requestMs;
  server.keepAliveTimeout = config.timeouts.keepAliveMs;

  const shutdownState = async () => {
    app.closeStreams();
    await Promise.all(Object.values(adapters).map((adapter) => adapter.close()));
    hub.close();
    registry.stop();
  };

  await registry.start();
  await hub.start();
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
    setTimeout(() => process.exit(1), config.timeouts.drainMs + config.timeouts.shutdownMs).unref();
    close().then(() => process.exit(0));
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

if (import.meta.main) await main();
