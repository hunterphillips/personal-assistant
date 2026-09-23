// Test helpers: ephemeral loopback servers, temporary directories, and a raw
// HTTP client that sends paths and headers exactly as given.

import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createApp } from '../../lib/app.mjs';
import { createBriefRoutes } from '../../lib/brief-adapter.mjs';
import { loadConfig } from '../../lib/config.mjs';
import { createFocusProxy } from '../../lib/focus-proxy.mjs';

export async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}

export async function closeServer(server) {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}

export async function freePort() {
  const server = http.createServer();
  const port = await listen(server);
  await closeServer(server);
  return port;
}

export async function tempDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dashboard-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

// A synthetic Focus upstream that records every request it receives and
// answers once the request body has been read.
export async function startSyntheticFocus(t) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url });
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"synthetic":true}');
    });
  });
  const port = await listen(server);
  t.after(() => closeServer(server));
  return { origin: `http://127.0.0.1:${port}`, requests };
}

// Starts the app on an ephemeral port. `focus` and `brief` default to the
// real phase 1 modules; tests may pass fakes. `configure` may adjust config.
export async function startApp(t, { env = {}, focus, brief, configure = (c) => c } = {}) {
  const server = http.createServer();
  const port = await listen(server);
  const briefsDir = env.DASHBOARD_BRIEFS_DIR ?? path.join(await tempDir(t), 'briefs-missing');
  const focusOrigin = env.DASHBOARD_FOCUS_ORIGIN ?? `http://127.0.0.1:${await freePort()}`;
  const config = configure(loadConfig({
    ...env,
    DASHBOARD_PORT: String(port),
    DASHBOARD_BRIEFS_DIR: briefsDir,
    DASHBOARD_FOCUS_ORIGIN: focusOrigin,
  }));
  const logs = [];
  server.on('request', createApp({
    config,
    focus: focus ?? createFocusProxy(config),
    brief: brief ?? createBriefRoutes(config),
    log: (entry) => logs.push(entry),
  }));
  t.after(() => closeServer(server));
  const authority = `127.0.0.1:${port}`;
  return { port, config, logs, authority, origin: `http://${authority}` };
}

// Sends one request. `headers.host` defaults to the app authority; pass
// host: null to omit it. `body` may be a string/Buffer or an async iterable.
export function request(app, method, path, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const finalHeaders = { host: app.authority, ...headers };
    if (finalHeaders.host === null) delete finalHeaders.host;
    const req = http.request({
      host: '127.0.0.1',
      port: app.port,
      method,
      path,
      headers: finalHeaders,
      setHost: false,
      agent: false,
    });
    let responded = false;
    req.on('response', (res) => {
      responded = true;
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json;
        try {
          json = JSON.parse(text);
        } catch {
          json = undefined;
        }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
      res.on('error', reject);
    });
    // The server may answer and close while the body is still being sent.
    req.on('error', (error) => {
      if (!responded) reject(error);
    });
    if (body && typeof body[Symbol.asyncIterator] === 'function' && !Buffer.isBuffer(body)) {
      (async () => {
        for await (const chunk of body) {
          if (responded || req.destroyed) break;
          if (!req.write(chunk)) await writable(req);
        }
        req.end();
      })().catch(() => {});
    } else {
      req.end(body);
    }
  });
}

function writable(req) {
  return new Promise((resolve) => {
    const done = () => {
      req.off('drain', done).off('close', done);
      resolve();
    };
    req.on('drain', done).on('close', done);
  });
}

export async function* chunks(total, size = 64 * 1024) {
  for (let sent = 0; sent < total; sent += size) {
    yield Buffer.alloc(Math.min(size, total - sent), 0x61);
  }
}
