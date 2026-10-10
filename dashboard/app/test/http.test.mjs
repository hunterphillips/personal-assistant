import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';

import { HttpError, LINGER_LIMITS, buildChildCsp, limitRequestBody, sendError, sendJson } from '../lib/http.mjs';
import { chunks, closeServer, listen, request, startApp, startSyntheticFocus, tempDir } from './support/harness.mjs';

const REVISION = 'a'.repeat(64);

function assertCommonHeaders(response) {
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.equal(response.headers['referrer-policy'], 'no-referrer');
  assert.match(response.headers['content-security-policy'], /frame-ancestors 'self'/);
  assert.equal(response.headers['access-control-allow-origin'], undefined);
}

function assertJsonError(response, status) {
  assert.equal(response.status, status);
  assert.match(response.headers['content-type'], /^application\/json/);
  assert.equal(typeof response.json?.error, 'string');
  assert.deepEqual(Object.keys(response.json), ['error']);
  assert.doesNotMatch(response.text, /\bat .+:\d+:\d+/); // no stack frames
  assertCommonHeaders(response);
}

// Fakes that record what the router hands them.
function recordingBrief() {
  const calls = [];
  return {
    calls,
    async handleLatest(_req, res) {
      calls.push({ route: 'latest' });
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"state":"empty"}');
    },
    async handleBrief(_req, res, params) {
      calls.push({ route: 'brief', params });
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"state":"missing"}');
    },
    async handleFeedbackRead(_req, res, params) {
      calls.push({ route: 'feedback-read', params });
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"savedAt":null}');
    },
    async handleFeedback(_req, res, body) {
      calls.push({ route: 'feedback', body });
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"saved":true}');
    },
    async latestMetadata() {
      return { state: 'ready', date: '2026-01-02', revision: REVISION, text: 'invented content', items: [1] };
    },
  };
}

function consumingFocus() {
  const received = [];
  return {
    received,
    async handlePage(_req, res) {
      res.writeHead(200, { 'Content-Type': 'text/html' }).end('<p>invented</p>');
    },
    async handleApi(req, res, { body } = {}) {
      if (!body) {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
        return;
      }
      const parts = [];
      body.on('data', (chunk) => parts.push(chunk));
      body.on('error', (error) => sendError(res, error.status ?? 400, error.code ?? 'bad_request'));
      body.on('end', () => {
        received.push(Buffer.concat(parts).length);
        res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
      });
    },
    async checkHealth() {
      return { available: true };
    },
  };
}

const FOCUS_LIMIT = 1_000_000;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Opens a raw connection and sends a chunked request head. Returns the socket
// plus helpers to send body chunks and to collect everything the server sends.
async function openChunkedUpload(app, method, path) {
  const socket = net.connect(app.port, '127.0.0.1');
  await new Promise((resolve) => socket.once('connect', resolve));
  socket.on('error', () => {});
  let received = '';
  socket.on('data', (data) => { received += data; });
  const closed = new Promise((resolve) => socket.once('close', resolve));
  socket.write([
    `${method} ${path} HTTP/1.1`,
    `Host: ${app.authority}`,
    `Origin: ${app.origin}`,
    'Content-Type: application/json',
    'Transfer-Encoding: chunked',
    '',
    '',
  ].join('\r\n'));
  const writeChunk = (size) => {
    const ok = socket.write(`${size.toString(16)}\r\n`);
    socket.write(Buffer.alloc(size, 0x61));
    return socket.write('\r\n') && ok;
  };
  return { socket, closed, writeChunk, received: () => received };
}

// A synthetic Focus upstream that records how much of each PUT body arrived
// and whether it arrived whole or was cut off.
async function startRecordingUpstream(t) {
  const records = [];
  const server = http.createServer((req, res) => {
    const record = { bytes: 0, complete: false };
    record.closed = new Promise((resolve) => req.once('close', () => resolve(record)));
    records.push(record);
    req.on('data', (chunk) => { record.bytes += chunk.length; });
    req.on('end', () => {
      record.complete = true;
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ received: record.bytes }));
    });
  });
  const port = await listen(server);
  t.after(() => closeServer(server));
  return { port, records };
}

// Test-only reference for the phase 2 body contract: pipe the limited body into
// an upstream request, abort the upstream on a body error, and reply once.
function pipingFocus(upstreamPort) {
  return {
    async handlePage(_req, res) {
      sendError(res, 503, 'focus_unavailable');
    },
    async checkHealth() {
      return { available: true };
    },
    handleApi(_req, res, { body }) {
      return new Promise((resolve) => {
        let failed = false;
        const upstream = http.request({
          host: '127.0.0.1',
          port: upstreamPort,
          method: 'PUT',
          path: '/api/focus',
          headers: { 'content-type': 'application/json' },
          agent: false,
        });
        const fail = (status, code) => {
          if (failed) return;
          failed = true;
          upstream.destroy();
          sendError(res, status, code);
          resolve();
        };
        body.on('error', (error) => fail(error.status ?? 400, error.code ?? 'request_aborted'));
        upstream.on('error', () => fail(502, 'focus_unavailable'));
        upstream.on('response', (upstreamRes) => {
          const parts = [];
          upstreamRes.on('data', (chunk) => parts.push(chunk));
          upstreamRes.on('end', () => {
            if (!failed) sendJson(res, upstreamRes.statusCode, JSON.parse(Buffer.concat(parts)));
            resolve();
          });
        });
        body.pipe(upstream);
      });
    },
  };
}

test('shell routes serve the same HTML with the shell CSP', async (t) => {
  const app = await startApp(t);
  const bodies = [];
  for (const path of ['/', '/focus', '/feed', '/brief', '/?view=x']) {
    const response = await request(app, 'GET', path);
    assert.equal(response.status, 200, path);
    assert.match(response.headers['content-type'], /^text\/html/);
    assert.match(response.headers['content-security-policy'], /default-src 'self'/);
    assert.match(response.headers['content-security-policy'], /frame-src 'self'/);
    assertCommonHeaders(response);
    bodies.push(response.text);
  }
  assert.ok(bodies.every((body) => body === bodies[0] && body.includes('<main')));
});

test('trailing slashes on shell routes redirect to canonical paths', async (t) => {
  const app = await startApp(t);
  const focus = await request(app, 'GET', '/focus/');
  assert.equal(focus.status, 308);
  assert.equal(focus.headers.location, '/focus');
  const brief = await request(app, 'GET', '/brief/?a=1');
  assert.equal(brief.status, 308);
  assert.equal(brief.headers.location, '/brief?a=1');
  assert.equal((await request(app, 'GET', '/healthz/')).status, 404);
  const health = await request(app, 'GET', '/health/?a=1');
  assert.equal(health.status, 308);
  assert.equal(health.headers.location, '/health?a=1');
});

test('/reading moves to /feed, where the Feed now lives', async (t) => {
  const app = await startApp(t);
  for (const [path, location] of [['/reading', '/feed'], ['/reading/', '/feed'], ['/reading?a=1', '/feed?a=1']]) {
    const response = await request(app, 'GET', path);
    assert.equal(response.status, 302, path);
    assert.equal(response.headers.location, location, path);
  }
});

test('/health serves the shell, and /routines moves to it for one release', async (t) => {
  const app = await startApp(t);
  const health = await request(app, 'GET', '/health');
  assert.equal(health.status, 200);
  assert.match(health.headers['content-type'], /^text\/html/);
  assert.ok(health.text.includes('id="view-health"'));
  for (const [path, location] of [['/routines', '/health'], ['/routines/', '/health'], ['/routines?a=1', '/health?a=1'], ['/routines/?a=1', '/health?a=1']]) {
    const response = await request(app, 'GET', path);
    assert.equal(response.status, 302, path);
    assert.equal(response.headers.location, location, path);
  }
  assert.equal((await request(app, 'HEAD', '/routines')).status, 302);
});

test('HEAD returns headers without a body for shell and health routes', async (t) => {
  const app = await startApp(t);
  for (const path of ['/', '/focus', '/healthz']) {
    const get = await request(app, 'GET', path);
    const head = await request(app, 'HEAD', path);
    assert.equal(head.status, 200, path);
    assert.equal(head.text, '');
    assert.equal(head.headers['content-length'], get.headers['content-length']);
  }
});

test('healthz reports process health only', async (t) => {
  const app = await startApp(t);
  const response = await request(app, 'GET', '/healthz');
  assert.equal(response.status, 200);
  assert.deepEqual(response.json, { ok: true });
  assertCommonHeaders(response);
});

test('missing briefs and unavailable Focus do not affect health or shell', async (t) => {
  // Nothing listens on the default Focus origin that startApp picks.
  const app = await startApp(t, {
    env: { DASHBOARD_BRIEFS_DIR: path.join(await tempDir(t), 'missing') },
  });
  for (const path of ['/', '/focus', '/feed', '/brief', '/healthz']) {
    assert.equal((await request(app, 'GET', path)).status, 200, path);
  }
  const status = await request(app, 'GET', '/api/dashboard/status');
  assert.equal(status.status, 200);
  assert.deepEqual(status.json, { focus: { available: false, native: false }, brief: { state: 'unavailable' } });
  assertJsonError(await request(app, 'GET', '/embedded/focus'), 502);
  assertJsonError(await request(app, 'GET', '/api/focus'), 502);
  assertJsonError(await request(app, 'PUT', '/api/focus', {
    headers: { origin: app.origin, 'content-type': 'application/json' },
    body: '{"invented":true}',
  }), 502);
  const feedback = await request(app, 'POST', '/api/brief/feedback', {
    headers: { origin: app.origin, 'content-type': 'application/json' },
    body: '{}',
  });
  assertJsonError(feedback, 400);
  assert.deepEqual(feedback.json, { error: 'invalid_feedback' });
  const latest = await request(app, 'GET', '/api/brief/latest');
  assertJsonError(latest, 503);
  assert.deepEqual(latest.json, { error: 'brief_directory_unavailable' });
  assert.deepEqual((await request(app, 'GET', '/api/brief/2026-01-02')).json,
    { state: 'missing', date: '2026-01-02', error: 'brief_not_found' });
});

test('a readable briefs directory with no candidates reports empty', async (t) => {
  const app = await startApp(t, { env: { DASHBOARD_BRIEFS_DIR: await tempDir(t) } });
  const status = await request(app, 'GET', '/api/dashboard/status');
  assert.equal(status.status, 200);
  assert.deepEqual(status.json.brief, { state: 'empty' });
  const latest = await request(app, 'GET', '/api/brief/latest');
  assert.equal(latest.status, 200);
  assert.deepEqual(latest.json, { state: 'empty' });
});

test('status copies only non-content brief fields', async (t) => {
  const app = await startApp(t, { focus: consumingFocus(), brief: recordingBrief() });
  const response = await request(app, 'GET', '/api/dashboard/status');
  assert.deepEqual(response.json, {
    focus: { available: true, native: false },
    brief: { state: 'ready', date: '2026-01-02', revision: REVISION },
  });
});

test('status survives dependencies that throw or hang', async (t) => {
  const never = () => new Promise(() => {});
  const cases = [
    { focus: { checkHealth: () => { throw new Error('sync'); } }, brief: { latestMetadata: () => Promise.reject(new Error('async')) } },
    { focus: { checkHealth: never }, brief: { latestMetadata: never } },
    { focus: { checkHealth: async () => 'garbage' }, brief: { latestMetadata: async () => ({ state: 'Not A Word <b>' }) } },
  ];
  for (const deps of cases) {
    const app = await startApp(t, {
      ...deps,
      configure: (config) => ({ ...config, timeouts: { ...config.timeouts, statusMs: 50 } }),
    });
    const started = Date.now();
    const response = await request(app, 'GET', '/api/dashboard/status');
    assert.equal(response.status, 200);
    assert.deepEqual(response.json, { focus: { available: false, native: false }, brief: { state: 'unavailable' } });
    assert.ok(Date.now() - started < 1_000);
  }
});

test('status aborts the signal given to a hanging dependency', async (t) => {
  let aborted = false;
  const app = await startApp(t, {
    focus: {
      checkHealth: ({ signal }) => new Promise(() => signal.addEventListener('abort', () => { aborted = true; })),
    },
    brief: recordingBrief(),
    configure: (config) => ({ ...config, timeouts: { ...config.timeouts, statusMs: 30 } }),
  });
  await request(app, 'GET', '/api/dashboard/status');
  assert.equal(aborted, true);
});

test('unknown routes and assets return 404 JSON', async (t) => {
  const app = await startApp(t);
  for (const path of ['/nope', '/save', '/index.html', '/assets/', '/assets/server.mjs', '/assets/index.html',
    '/assets/nope.js', '/embedded/brief/2026-01-02', '/api/brief/2026-02-30', '/api/brief/2026-01-02/other', '/api/brief/latest/feedback', '/api', '/public/index.html']) {
    assertJsonError(await request(app, 'GET', path), 404);
  }
});

test('traversal and encoded paths are rejected without reaching files', async (t) => {
  const app = await startApp(t);
  for (const path of [
    '/assets/../server.mjs',
    '/assets/%2e%2e/server.mjs',
    '/assets/%2E%2E%2Fserver.mjs',
    '/assets/..%2fserver.mjs',
    '/assets/..%5cserver.mjs',
    '/assets/.%2e/lib/app.mjs',
    '/%2e%2e/%2e%2e/etc/passwd',
    '/./focus',
    '//focus',
    '/focus%2F',
    '/assets\\..\\server.mjs',
    'http://evil.example/focus',
  ]) {
    const response = await request(app, 'GET', path);
    assert.ok([400, 404].includes(response.status), `${path} -> ${response.status}`);
    assertJsonError(response, response.status);
    assert.doesNotMatch(response.text, /import|createApp/);
  }
});

test('wrong or missing Host is refused', async (t) => {
  const app = await startApp(t);
  for (const host of ['evil.example', `127.0.0.1:${app.port + 1}`, '127.0.0.1', 'box.example.ts.net', '']) {
    assertJsonError(await request(app, 'GET', '/', { headers: { host } }), 421);
  }
  // Node's parser rejects a Host-less HTTP/1.1 request before the app runs.
  assert.equal((await request(app, 'GET', '/healthz', { headers: { host: null } })).status, 400);
  assert.equal((await request(app, 'GET', '/', { headers: { host: `localhost:${app.port}` } })).status, 200);
});

test('configured public host is accepted', async (t) => {
  const app = await startApp(t, { env: { DASHBOARD_PUBLIC_ORIGIN: 'https://box.example.ts.net' } });
  assert.equal((await request(app, 'GET', '/', { headers: { host: 'box.example.ts.net' } })).status, 200);
});

test('unsupported methods return 405 with Allow', async (t) => {
  const app = await startApp(t);
  const cases = [
    ['POST', '/'], ['DELETE', '/healthz'], ['OPTIONS', '/focus'], ['POST', '/health'], ['POST', '/routines'],
    ['PUT', '/api/dashboard/status'], ['HEAD', '/api/dashboard/status'], ['PUT', '/api/status'], ['HEAD', '/api/status'],
    ['GET', '/api/pause'], ['PUT', '/api/resume'], ['DELETE', '/api/refresh'],
    ['POST', '/api/focus'], ['DELETE', '/api/focus'], ['GET', '/api/brief/feedback'], ['PUT', '/api/brief/feedback'],
    ['POST', '/embedded/focus'], ['POST', '/api/brief/latest'], ['PATCH', '/assets/brief-overlay.js'],
    ['POST', '/api/brief/2026-01-02'], ['PUT', '/api/brief/2026-01-02/feedback'],
  ];
  for (const [method, path] of cases) {
    const response = await request(app, method, path, {
      headers: { origin: app.origin, 'content-type': 'application/json' },
    });
    assert.equal(response.status, 405, `${method} ${path}`);
    assert.ok(response.headers.allow, `${method} ${path}`);
    if (method !== 'HEAD') assertJsonError(response, 405);
  }
});

test('mutations require an exact Origin matching the request authority', async (t) => {
  const brief = recordingBrief();
  const focus = consumingFocus();
  const app = await startApp(t, { brief, focus, env: { DASHBOARD_PUBLIC_ORIGIN: 'https://box.example.ts.net' } });
  const json = { 'content-type': 'application/json' };
  const badOrigins = [undefined, 'null', 'http://evil.example', `http://127.0.0.1:${app.port}/`,
    `http://localhost:${app.port}`, 'https://box.example.ts.net', `https://127.0.0.1:${app.port}`];
  for (const origin of badOrigins) {
    const headers = origin === undefined ? json : { ...json, origin };
    assertJsonError(await request(app, 'POST', '/api/brief/feedback', { headers, body: '{}' }), 403);
    assertJsonError(await request(app, 'PUT', '/api/focus', { headers, body: '{}' }), 403);
  }
  // The public origin is accepted only with the public Host.
  const publicPost = await request(app, 'POST', '/api/brief/feedback', {
    headers: { ...json, host: 'box.example.ts.net', origin: 'https://box.example.ts.net' },
    body: '{}',
  });
  assert.equal(publicPost.status, 200);
  assert.equal(brief.calls.length, 1);
  assert.equal(focus.received.length, 0);
});

test('mutations require a JSON content type', async (t) => {
  const brief = recordingBrief();
  const app = await startApp(t, { brief });
  for (const type of [undefined, 'text/plain', 'application/x-www-form-urlencoded', 'application/jsonx']) {
    const headers = type ? { origin: app.origin, 'content-type': type } : { origin: app.origin };
    assertJsonError(await request(app, 'POST', '/api/brief/feedback', { headers, body: '{}' }), 415);
    assertJsonError(await request(app, 'PUT', '/api/focus', { headers, body: '{}' }), 415);
  }
  const ok = await request(app, 'POST', '/api/brief/feedback', {
    headers: { origin: app.origin, 'content-type': 'Application/JSON; charset=utf-8' },
    body: '{"date":"2026-01-02"}',
  });
  assert.equal(ok.status, 200);
  assert.deepEqual(brief.calls, [{ route: 'feedback', body: { date: '2026-01-02' } }]);
});

test('malformed feedback JSON is a 400 and never reaches the handler', async (t) => {
  const brief = recordingBrief();
  const app = await startApp(t, { brief });
  const headers = { origin: app.origin, 'content-type': 'application/json' };
  for (const body of ['{', '', 'undefined', '{"a":1}}', '\u0000']) {
    assertJsonError(await request(app, 'POST', '/api/brief/feedback', { headers, body }), 400);
  }
  assert.equal(brief.calls.length, 0);
});

test('feedback bodies are capped at 128 KiB', async (t) => {
  const brief = recordingBrief();
  const app = await startApp(t, { brief });
  const headers = { origin: app.origin, 'content-type': 'application/json' };
  const limit = 128 * 1024;

  const atLimit = JSON.stringify({ note: 'x'.repeat(limit - 11) });
  assert.equal(Buffer.byteLength(atLimit), limit);
  assert.equal((await request(app, 'POST', '/api/brief/feedback', { headers, body: atLimit })).status, 200);

  const declared = await request(app, 'POST', '/api/brief/feedback', { headers, body: 'x'.repeat(limit + 1) });
  assertJsonError(declared, 413);

  // A body declared far beyond the drain allowance is refused without waiting for it.
  const huge = await request(app, 'POST', '/api/brief/feedback', {
    headers: { ...headers, 'content-length': String(1024 ** 3) },
  });
  assertJsonError(huge, 413);

  const streamed = await request(app, 'POST', '/api/brief/feedback', { headers, body: chunks(limit * 4, 16 * 1024) });
  assertJsonError(streamed, 413);
  assert.equal(brief.calls.length, 1);
});

test('the real Focus proxy answers over-limit and aborted PUT bodies and keeps serving', async (t) => {
  const upstream = await startSyntheticFocus(t);
  const app = await startApp(t, { env: { DASHBOARD_FOCUS_ORIGIN: upstream.origin } });
  const headers = { origin: app.origin, 'content-type': 'application/json' };

  assert.equal((await request(app, 'PUT', '/api/focus', { headers, body: chunks(FOCUS_LIMIT) })).status, 200);

  const streamed = await request(app, 'PUT', '/api/focus', { headers, body: chunks(FOCUS_LIMIT + 200_000) });
  assertJsonError(streamed, 413);
  assert.equal(streamed.headers.connection, 'close');

  const declared = await request(app, 'PUT', '/api/focus', { headers, body: Buffer.alloc(FOCUS_LIMIT + 1) });
  assertJsonError(declared, 413);
  assert.equal(declared.headers.connection, 'close');

  // Client disconnects partway through the body.
  const upload = await openChunkedUpload(app, 'PUT', '/api/focus');
  upload.writeChunk(300_000);
  await delay(20);
  upload.socket.destroy();
  await upload.closed;
  await delay(20);

  assert.equal((await request(app, 'GET', '/healthz')).status, 200);
  const focusLogs = app.logs.filter((entry) => entry.route === '/api/focus');
  assert.deepEqual(focusLogs.map((entry) => entry.status), [200, 413, 413, 0]);
  assert.equal(focusLogs[3].event, 'response_incomplete');
});

test('early 413 replies reach clients that are still uploading', async (t) => {
  const upstream = await startSyntheticFocus(t);
  const app = await startApp(t, { env: { DASHBOARD_FOCUS_ORIGIN: upstream.origin } });
  const headers = { origin: app.origin, 'content-type': 'application/json' };
  for (let i = 0; i < 10; i += 1) {
    assertJsonError(await request(app, 'PUT', '/api/focus', { headers, body: chunks(1_200_000) }), 413);
    assertJsonError(await request(app, 'PUT', '/api/focus', { headers, body: Buffer.alloc(1_200_000) }), 413);
    assertJsonError(await request(app, 'POST', '/api/brief/feedback', { headers, body: chunks(200 * 1024, 16 * 1024) }), 413);
    assertJsonError(await request(app, 'POST', '/api/brief/feedback', { headers, body: Buffer.alloc(200 * 1024) }), 413);
  }
  assert.equal((await request(app, 'GET', '/healthz')).status, 200);
});

test('a client that keeps uploading past the drain allowance is disconnected', async (t) => {
  // A live synthetic upstream, so the Focus reply is the proxy's own 413 and
  // not a 502 from a refused connection.
  const upstream = await startSyntheticFocus(t);
  const app = await startApp(t, { env: { DASHBOARD_FOCUS_ORIGIN: upstream.origin } });
  for (const route of ['/api/focus', '/api/brief/feedback']) {
    const upload = await openChunkedUpload(app, route === '/api/focus' ? 'PUT' : 'POST', route);
    let sent = 0;
    let open = true;
    upload.closed.then(() => { open = false; });
    const started = Date.now();
    while (open && Date.now() - started < 10_000) {
      sent += 64 * 1024;
      if (!upload.writeChunk(64 * 1024)) await Promise.race([delay(5), upload.closed]);
    }
    assert.equal(open, false, `${route} connection was not closed`);
    assert.match(upload.received(), /^HTTP\/1\.1 413 /, route);
    assert.ok(Date.now() - started < LINGER_LIMITS.ms + 1_000, `${route} took ${Date.now() - started} ms`);
    assert.ok(sent < FOCUS_LIMIT + LINGER_LIMITS.bytes + 16 * 1024 * 1024);
  }
  assert.equal((await request(app, 'GET', '/healthz')).status, 200);
});

test('a client that stops sending after crossing the limit is disconnected after the linger window', async (t) => {
  const upstream = await startSyntheticFocus(t);
  const app = await startApp(t, { env: { DASHBOARD_FOCUS_ORIGIN: upstream.origin } });
  const upload = await openChunkedUpload(app, 'PUT', '/api/focus');
  upload.writeChunk(FOCUS_LIMIT + 100);
  const started = Date.now();
  await Promise.race([upload.closed, delay(LINGER_LIMITS.ms + 2_000)]);
  assert.equal(upload.socket.destroyed, true, 'connection left open');
  assert.match(upload.received(), /^HTTP\/1\.1 413 /);
  assert.ok(Date.now() - started < LINGER_LIMITS.ms + 1_000);
});

test('the limited body errors as soon as the limit is crossed, before the upload ends', async () => {
  const source = new PassThrough();
  const limited = limitRequestBody(source, 10);
  const failed = new Promise((resolve) => limited.once('error', resolve));
  const passed = [];
  limited.on('data', (chunk) => passed.push(chunk));
  source.write(Buffer.alloc(10));
  source.write(Buffer.alloc(1));
  // The source never ends; the error must not wait for the rest of the body.
  const error = await Promise.race([failed, delay(500).then(() => null)]);
  assert.ok(error, 'no error while the upload was still open');
  assert.equal(error.status, 413);
  assert.equal(Buffer.concat(passed).length, 10);
});

test('piping contract: a body exactly at the limit reaches the upstream whole', async (t) => {
  const upstream = await startRecordingUpstream(t);
  const app = await startApp(t, { focus: pipingFocus(upstream.port) });
  const headers = { origin: app.origin, 'content-type': 'application/json' };
  const response = await request(app, 'PUT', '/api/focus', { headers, body: chunks(FOCUS_LIMIT, 50_000) });
  assert.equal(response.status, 200);
  assert.deepEqual(response.json, { received: FOCUS_LIMIT });
  assert.equal(upstream.records.length, 1);
  assert.equal(upstream.records[0].complete, true);
  assert.equal(upstream.records[0].bytes, FOCUS_LIMIT);
});

test('piping contract: crossing the limit aborts the upstream and the client gets 413', async (t) => {
  const upstream = await startRecordingUpstream(t);
  const app = await startApp(t, { focus: pipingFocus(upstream.port) });
  const headers = { origin: app.origin, 'content-type': 'application/json' };
  // The client would send 20 MB but stops once it sees the reply.
  const response = await request(app, 'PUT', '/api/focus', { headers, body: chunks(20_000_000) });
  assertJsonError(response, 413);
  assert.equal(upstream.records.length, 1);
  const record = await Promise.race([upstream.records[0].closed, delay(1_000).then(() => null)]);
  assert.ok(record, 'upstream request was not closed promptly');
  assert.equal(record.complete, false);
  assert.ok(record.bytes <= FOCUS_LIMIT, `upstream saw ${record.bytes} bytes`);
});

test('piping contract: a client abort mid-body destroys the upstream request', async (t) => {
  const upstream = await startRecordingUpstream(t);
  const app = await startApp(t, { focus: pipingFocus(upstream.port) });
  const upload = await openChunkedUpload(app, 'PUT', '/api/focus');
  upload.writeChunk(300_000);
  const started = Date.now();
  while ((upstream.records[0]?.bytes ?? 0) === 0 && Date.now() - started < 2_000) await delay(5);
  assert.ok(upstream.records[0]?.bytes > 0, 'upstream never received the body');
  upload.socket.destroy();
  const record = await Promise.race([upstream.records[0].closed, delay(1_000).then(() => null)]);
  assert.ok(record, 'upstream request was not closed after the client left');
  assert.equal(record.complete, false);
  assert.equal((await request(app, 'GET', '/healthz')).status, 200);
});

test('early refusals of a body-bearing request close the connection cleanly', async (t) => {
  const app = await startApp(t);
  const response = await request(app, 'PUT', '/api/focus', {
    headers: { origin: 'http://evil.example', 'content-type': 'application/json' },
    body: chunks(600_000),
  });
  assertJsonError(response, 403);
  assert.equal(response.headers.connection, 'close');
  const log = app.logs.find((entry) => entry.route === '/api/focus');
  assert.deepEqual(Object.keys(log).sort(), ['method', 'ms', 'route', 'status']);
  assert.equal(log.status, 403);
});

test('a client that disconnects mid-body does not reach the handler or break the server', async (t) => {
  const brief = recordingBrief();
  const app = await startApp(t, { brief });
  const socket = net.connect(app.port, '127.0.0.1');
  await new Promise((resolve) => socket.once('connect', resolve));
  socket.write([
    'POST /api/brief/feedback HTTP/1.1',
    `Host: ${app.authority}`,
    `Origin: ${app.origin}`,
    'Content-Type: application/json',
    'Content-Length: 1000',
    '',
    '{"partial":',
  ].join('\r\n'));
  await new Promise((resolve) => setTimeout(resolve, 20));
  socket.destroy();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(brief.calls.length, 0);
  assert.equal((await request(app, 'GET', '/healthz')).status, 200);
});

test('Focus GET reaches the proxy without a body stream', async (t) => {
  const app = await startApp(t, { focus: consumingFocus() });
  assert.equal((await request(app, 'GET', '/api/focus')).status, 200);
  assert.equal((await request(app, 'GET', '/embedded/focus')).status, 200);
});

test('brief date routes validate the date before the adapter', async (t) => {
  const brief = recordingBrief();
  const app = await startApp(t, { brief });
  assert.equal((await request(app, 'GET', '/api/brief/2024-02-29')).status, 200);
  assert.equal((await request(app, 'GET', '/api/brief/2024-02-29/feedback')).status, 200);
  assert.deepEqual(brief.calls, [
    { route: 'brief', params: { date: '2024-02-29' } },
    { route: 'feedback-read', params: { date: '2024-02-29' } },
  ]);
  for (const path of ['/api/brief/2023-02-29', '/api/brief/2024-2-29', '/api/brief/2023-02-29/feedback']) {
    assertJsonError(await request(app, 'GET', path), 404);
  }
  assert.equal(brief.calls.length, 2);
});

test('handler failures become 500 JSON without details; HttpError keeps its status', async (t) => {
  const app = await startApp(t, {
    brief: {
      ...recordingBrief(),
      handleLatest: async () => { throw new Error('secret detail /Users/x/briefs'); },
      handleBrief: async () => { throw new HttpError(409, 'revision_conflict'); },
    },
  });
  const failed = await request(app, 'GET', '/api/brief/latest');
  assertJsonError(failed, 500);
  assert.doesNotMatch(failed.text, /secret|Users/);
  assertJsonError(await request(app, 'GET', '/api/brief/2026-01-02'), 409);
});

test('logs record route, status, and timing only', async (t) => {
  const brief = recordingBrief();
  const app = await startApp(t, { brief });
  await request(app, 'POST', '/api/brief/feedback', {
    headers: { origin: app.origin, 'content-type': 'application/json' },
    body: '{"note":"invented private words"}',
  });
  await request(app, 'GET', '/api/brief/2026-01-02/feedback');
  await new Promise((resolve) => setImmediate(resolve));
  const text = JSON.stringify(app.logs);
  assert.doesNotMatch(text, /invented|private|2026-01-02/);
  assert.ok(app.logs.some((entry) => entry.route === '/api/brief/feedback' && entry.status === 200 && typeof entry.ms === 'number'));
  assert.ok(app.logs.some((entry) => entry.route === '/api/brief/:date/feedback'));
});

test('child CSP helper builds a same-origin framing policy', () => {
  const policy = buildChildCsp({
    inlineScripts: true,
    inlineStyles: true,
    styleSources: ['https://fonts.googleapis.com'],
    fontSources: ['https://fonts.gstatic.com'],
  });
  assert.match(policy, /script-src 'self' 'unsafe-inline'/);
  assert.match(policy, /style-src 'self' 'unsafe-inline' https:\/\/fonts\.googleapis\.com/);
  assert.match(policy, /font-src 'self' https:\/\/fonts\.gstatic\.com/);
  assert.match(policy, /frame-ancestors 'self'/);
  assert.doesNotMatch(buildChildCsp(), /unsafe-inline/);
  assert.throws(() => buildChildCsp({ fontSources: ["https://x.example; script-src *"] }), TypeError);
  assert.throws(() => buildChildCsp({ styleSources: ['http://fonts.googleapis.com'] }), TypeError);
});
