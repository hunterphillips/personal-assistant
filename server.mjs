// Entry point: load configuration, load the agent registry, compose the
// routines view, state hub, and app, listen on 127.0.0.1, and shut down
// within a bounded window on SIGTERM/SIGINT. Importing this module does
// nothing; `node server.mjs` runs main(). A missing or invalid registry does
// not stop startup; the hub reports it.

import http from 'node:http';

import { createApp, defaultLog } from './lib/app.mjs';
import { createBriefRoutes } from './lib/brief-adapter.mjs';
import { ConfigError, loadConfig } from './lib/config.mjs';
import { createFocusProxy } from './lib/focus-proxy.mjs';
import { createHub } from './lib/hub.mjs';
import { createRegistry } from './lib/registry.mjs';
import { createRoutines } from './lib/routines.mjs';

// Starts the dashboard and resolves once it is listening. Rejects on invalid
// configuration or a port already in use; it never picks another port.
export async function startDashboard({ env = process.env, log } = {}) {
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
  const hub = createHub({ registry, routines, focus, brief, timeouts: config.timeouts, log: logEntry });
  const app = createApp({ config, focus, brief, hub, log: logEntry });
  const server = http.createServer(app);
  server.headersTimeout = config.timeouts.headersMs;
  server.requestTimeout = config.timeouts.requestMs;
  server.keepAliveTimeout = config.timeouts.keepAliveMs;

  const shutdownState = () => {
    app.closeStreams();
    hub.close();
    registry.stop();
  };

  await registry.start();
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen({ host: config.bindHost, port: config.port, exclusive: true }, () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch (error) {
    shutdownState();
    throw error;
  }

  let closing;
  const close = () => (closing ??= (shutdownState(), closeServer(server, config.timeouts.shutdownMs)));
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
    setTimeout(() => process.exit(1), config.timeouts.shutdownMs + 1_000).unref();
    close().then(() => process.exit(0));
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

if (import.meta.main) await main();
