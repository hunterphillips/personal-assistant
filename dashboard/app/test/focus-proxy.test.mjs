import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';

import { createFocusProxy } from '../lib/focus-proxy.mjs';
import { HttpError } from '../lib/http.mjs';
import { focusSourceAvailable, startIsolatedFocus } from './support/isolated-focus.mjs';
import { closeServer, freePort, listen, request, startApp, tempDir } from './support/harness.mjs';
import { startEarlyReplyFocus, startScriptedFocus } from './support/synthetic-focus.mjs';

const MiB = 1024 * 1024;

function putHeaders(app, extra = {}) {
  return { origin: app.origin, 'content-type': 'application/json', ...extra };
}

function assertJsonError(response, status) {
  assert.equal(response.status, status);
  assert.match(response.headers['content-type'], /^application\/json/);
  assert.deepEqual(Object.keys(response.json ?? {}), ['error']);
}

function withUpstreamTimeout(ms) {
  return (config) => ({ ...config, timeouts: { ...config.timeouts, upstreamMs: ms } });
}

async function appFor(t, upstream, options = {}) {
  return startApp(t, { ...options, env: { DASHBOARD_FOCUS_ORIGIN: upstream.origin, ...options.env } });
}

// A client that sends headers and part of a chunked body, then waits.
async function openChunkedPut(app) {
  const socket = net.connect(app.port, '127.0.0.1');
  await new Promise((resolve) => socket.once('connect', resolve));
  socket.on('error', () => {});
  let received = '';
  socket.on('data', (data) => { received += data; });
  const closed = new Promise((resolve) => socket.once('close', resolve));
  socket.write([
    'PUT /api/focus HTTP/1.1',
    `Host: ${app.authority}`,
    `Origin: ${app.origin}`,
    'Content-Type: application/json',
    'Transfer-Encoding: chunked',
    '',
    '',
  ].join('\r\n'));
  return {
    socket,
    closed,
    received: () => received,
    writeChunk(size) {
      socket.write(`${size.toString(16)}\r\n`);
      socket.write(Buffer.alloc(size, 0x61));
      socket.write('\r\n');
    },
  };
}

async function waitFor(predicate, ms = 2_000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > ms) return false;
    await delay(5);
  }
  return true;
}

test('GET /api/focus reaches upstream /api/focus and passes the response through', async (t) => {
  const upstream = await startScriptedFocus(t, (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Set-Cookie': 'x=1', 'X-Upstream': 'yes' });
    res.end('{"items":[]}');
  });
  const app = await appFor(t, upstream);
  const response = await request(app, 'GET', '/api/focus');
  assert.equal(response.status, 200);
  assert.equal(response.headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(response.text, '{"items":[]}');
  assert.equal(response.headers['set-cookie'], undefined);
  assert.equal(response.headers['x-upstream'], undefined);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.deepEqual(upstream.records.map((r) => [r.method, r.url]), [['GET', '/api/focus']]);
  assert.equal(upstream.records[0].headers.host, upstream.authority);
});

test('PUT /api/focus forwards the JSON body and content type once', async (t) => {
  const upstream = await startScriptedFocus(t, (_req, res, record) => {
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ echoed: JSON.parse(record.body) }));
  });
  const app = await appFor(t, upstream);
  const body = JSON.stringify({ updated: 'x', items: [{ id: 'a' }] });
  const response = await request(app, 'PUT', '/api/focus', { headers: putHeaders(app, { 'content-type': 'application/json; charset=utf-8' }), body });
  assert.equal(response.status, 200);
  assert.deepEqual(response.json, { echoed: JSON.parse(body) });
  assert.equal(upstream.records.length, 1);
  const [record] = upstream.records;
  assert.equal(record.method, 'PUT');
  assert.equal(record.url, '/api/focus');
  assert.equal(record.body, body);
  assert.equal(record.headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(record.headers['content-length'], String(Buffer.byteLength(body)));
});

test('a chunked PUT body arrives whole', async (t) => {
  const upstream = await startScriptedFocus(t);
  const app = await appFor(t, upstream);
  async function* parts() {
    yield '{"items":';
    yield '[1,2,3]}';
  }
  const response = await request(app, 'PUT', '/api/focus', { headers: putHeaders(app), body: parts() });
  assert.equal(response.status, 200);
  assert.equal(upstream.records[0].body, '{"items":[1,2,3]}');
});

test('/embedded/focus reaches upstream / with a child CSP; /focus is the shell and never reaches upstream', async (t) => {
  const page = '<!doctype html><p>focus board</p><script>fetch(\'/api/focus\')</script>';
  const upstream = await startScriptedFocus(t, (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(page);
  });
  const app = await appFor(t, upstream);

  const embedded = await request(app, 'GET', '/embedded/focus?theme=dark');
  assert.equal(embedded.status, 200);
  assert.match(embedded.headers['content-type'], /^text\/html/);
  assert.equal(embedded.text, page);
  const csp = embedded.headers['content-security-policy'];
  assert.match(csp, /script-src 'self' 'unsafe-inline'(;|$)/);
  assert.match(csp, /style-src 'self' 'unsafe-inline' https:\/\/fonts\.googleapis\.com(;|$)/);
  assert.match(csp, /font-src 'self' https:\/\/fonts\.gstatic\.com(;|$)/);
  assert.match(csp, /connect-src 'self'(;|$)/);
  assert.match(csp, /frame-ancestors 'self'(;|$)/);
  assert.equal(embedded.headers['x-frame-options'], 'SAMEORIGIN');

  const shell = await request(app, 'GET', '/focus');
  assert.equal(shell.status, 200);
  assert.doesNotMatch(shell.text, /focus board/);

  assert.deepEqual(upstream.records.map((r) => [r.method, r.url]), [['GET', '/']]);
  assert.equal(upstream.records[0].headers.host, upstream.authority);
});

test('upstream Host is the configured authority, including a localhost origin', async (t) => {
  const upstream = await startScriptedFocus(t);
  const origin = `http://localhost:${upstream.port}`;
  const app = await startApp(t, { env: { DASHBOARD_FOCUS_ORIGIN: origin } });
  assert.equal((await request(app, 'GET', '/api/focus')).status, 200);
  assert.equal(upstream.records[0].headers.host, `localhost:${upstream.port}`);
});

test('browser credentials, hop-by-hop headers, Origin and Referer are not forwarded', async (t) => {
  const upstream = await startScriptedFocus(t);
  const app = await appFor(t, upstream);
  const sent = {
    cookie: 'session=secret',
    authorization: 'Bearer secret',
    'proxy-authorization': 'Basic secret',
    'proxy-connection': 'keep-alive',
    connection: 'keep-alive, x-hop',
    'keep-alive': 'timeout=5',
    'x-hop': 'secret',
    te: 'trailers',
    upgrade: 'websocket',
    referer: `${app.origin}/focus`,
    'x-custom': 'secret',
  };
  await request(app, 'GET', '/api/focus', { headers: sent });
  await request(app, 'GET', '/embedded/focus', { headers: sent });
  await request(app, 'PUT', '/api/focus', { headers: putHeaders(app, sent), body: '{}' });
  // Trailer is only valid on a chunked request.
  async function* chunked() { yield '{}'; }
  const withTrailer = { ...sent, trailer: 'x-trail' };
  await request(app, 'PUT', '/api/focus', { headers: putHeaders(app, withTrailer), body: chunked() });
  assert.equal(upstream.records.length, 4);
  assert.equal(upstream.records[3].headers.trailer, undefined);
  for (const record of upstream.records) {
    for (const name of Object.keys(sent)) {
      if (name === 'connection') continue;
      assert.equal(record.headers[name], undefined, `${record.method} ${record.url} forwarded ${name}`);
    }
    assert.doesNotMatch(record.headers.connection ?? '', /x-hop|keep-alive/i);
    assert.equal(record.headers.origin, undefined);
    assert.equal(record.headers.host, upstream.authority);
  }
});

test('upstream error statuses pass through with content type and body', async (t) => {
  const upstream = await startScriptedFocus(t, (req, res) => {
    if (req.method === 'PUT') {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('refusing to write invalid focus.json');
    } else {
      res.writeHead(500, { 'Content-Type': 'application/json' }).end('{"error":"boom"}');
    }
  });
  const app = await appFor(t, upstream);
  const put = await request(app, 'PUT', '/api/focus', { headers: putHeaders(app), body: '{"items":"no"}' });
  assert.equal(put.status, 400);
  assert.equal(put.headers['content-type'], 'text/plain; charset=utf-8');
  assert.equal(put.text, 'refusing to write invalid focus.json');
  const get = await request(app, 'GET', '/api/focus');
  assert.equal(get.status, 500);
  assert.equal(get.text, '{"error":"boom"}');
});

test('a failing PUT is sent upstream exactly once', async (t) => {
  let count = 0;
  const upstream = await startScriptedFocus(t, (req, res) => {
    count += 1;
    if (count === 1) {
      res.writeHead(503, { 'Content-Type': 'text/plain' }).end('busy');
    } else {
      req.socket.destroy(); // a reset after the whole body was read
    }
  });
  const app = await appFor(t, upstream);
  const first = await request(app, 'PUT', '/api/focus', { headers: putHeaders(app), body: '{}' });
  assert.equal(first.status, 503);
  assert.equal(upstream.records.length, 1);

  const second = await request(app, 'PUT', '/api/focus', { headers: putHeaders(app), body: '{}' });
  assertJsonError(second, 502);
  await delay(50);
  assert.equal(upstream.records.length, 2);
  assert.equal(upstream.records.filter((r) => r.method === 'PUT').length, 2);
});

test('a client disconnect mid-PUT aborts the upstream request', async (t) => {
  const upstream = await startScriptedFocus(t);
  const app = await appFor(t, upstream);
  const upload = await openChunkedPut(app);
  upload.writeChunk(200_000);
  assert.ok(await waitFor(() => (upstream.records[0]?.bytes ?? 0) > 0), 'upstream never received the body');
  upload.socket.destroy();
  const record = await Promise.race([upstream.records[0].closed, delay(1_000).then(() => null)]);
  assert.ok(record, 'upstream request was not closed after the client left');
  assert.equal(record.complete, false);
  assert.equal(upstream.records.length, 1);
  assert.equal((await request(app, 'GET', '/healthz')).status, 200);
});

test('a PUT body over the limit aborts the upstream and answers 413', async (t) => {
  const upstream = await startScriptedFocus(t);
  const app = await appFor(t, upstream);
  async function* big() {
    for (let i = 0; i < 40; i += 1) yield Buffer.alloc(64 * 1024, 0x61);
  }
  const response = await request(app, 'PUT', '/api/focus', { headers: putHeaders(app), body: big() });
  assertJsonError(response, 413);
  const record = await Promise.race([upstream.records[0].closed, delay(1_000).then(() => null)]);
  assert.ok(record, 'upstream request was not closed');
  assert.equal(record.complete, false);
  assert.ok(record.bytes <= 1_000_000);
});

// Serves one route that hands `body` (a stream the test controls) to the
// real proxy's handleApi as if it were a PUT body, and records the reply.
async function startProxyWithBody(t, upstream, body) {
  const app = await appFor(t, upstream);
  const proxy = createFocusProxy(app.config);
  const server = http.createServer((req, res) => {
    req.resume();
    proxy.handleApi({ method: 'PUT', headers: { 'content-type': 'application/json' } }, res, { body });
  });
  const port = await listen(server);
  t.after(() => closeServer(server));
  return { port };
}

const QUEUED = 32 * MiB;

// A destroyed upstream request drops what was still queued; one that was left
// to finish would deliver all of it before closing.
async function assertUpstreamDestroyed(connection) {
  connection.resume();
  const closed = await Promise.race([connection.closed, delay(2_000).then(() => null)]);
  assert.ok(closed, 'upstream connection stayed open');
  assert.ok(connection.bytes < QUEUED, `upstream received ${connection.bytes} bytes; the request was not destroyed`);
}

test('a body error after Focus has already answered still wins and aborts the upstream', async (t) => {
  const upstream = await startEarlyReplyFocus(t, { stopReading: true });
  const body = new PassThrough();
  const { port } = await startProxyWithBody(t, upstream, body);
  const pending = new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, agent: false }, (res) => {
      const parts = [];
      res.on('data', (chunk) => parts.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(parts).toString() }));
    }).on('error', reject);
  });
  // One write larger than the socket buffers hold, so most of it is still
  // queued in the proxy when Focus answers.
  body.write(Buffer.alloc(QUEUED, 0x61));
  assert.ok(await waitFor(() => upstream.connections[0]?.replied), 'upstream never answered');
  await delay(100);
  body.destroy(new HttpError(413, 'payload_too_large'));
  const reply = await pending;
  assert.equal(reply.status, 413);
  assert.deepEqual(JSON.parse(reply.text), { error: 'payload_too_large' });
  await assertUpstreamDestroyed(upstream.connections[0]);
});

test('a client that leaves after Focus has already answered aborts the upstream', async (t) => {
  const upstream = await startEarlyReplyFocus(t, { stopReading: true });
  const body = new PassThrough();
  const { port } = await startProxyWithBody(t, upstream, body);
  let answered = false;
  const client = http.get({ host: '127.0.0.1', port, agent: false }, () => { answered = true; });
  client.on('error', () => {});
  body.write(Buffer.alloc(QUEUED, 0x61));
  assert.ok(await waitFor(() => upstream.connections[0]?.replied), 'upstream never answered');
  await delay(100);
  assert.equal(answered, false, 'the client was answered before the body was sent whole');
  client.destroy();
  await delay(50);
  await assertUpstreamDestroyed(upstream.connections[0]);
});

test('Focus answering and closing before the PUT body is sent is a prompt 502, never its early answer', async (t) => {
  const upstream = await startEarlyReplyFocus(t);
  const app = await appFor(t, upstream);
  const upload = await openChunkedPut(app);
  const started = Date.now();
  upload.writeChunk(100_000);
  await Promise.race([upload.closed, waitFor(() => upload.received().includes('\r\n\r\n'), 3_000)]);
  assert.match(upload.received(), /^HTTP\/1\.1 502 /);
  assert.match(upload.received(), /"upstream_early_response"/);
  assert.doesNotMatch(upload.received(), /early":1/);
  assert.ok(Date.now() - started < 2_000);
  const connection = await Promise.race([upstream.connections[0].closed, delay(1_000).then(() => null)]);
  assert.ok(connection, 'upstream connection stayed open');
  upload.socket.destroy();
});

test('an upstream that closes after part of its response is a 502 on every Focus route', async (t) => {
  const upstream = await startScriptedFocus(t, (req, res) => {
    const type = req.url === '/' ? 'text/html' : 'application/json';
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': 1000 });
    res.write('{"partial":', () => setTimeout(() => res.socket.destroy(), 10));
  });
  const app = await appFor(t, upstream);
  assertJsonError(await request(app, 'GET', '/embedded/focus'), 502);
  assertJsonError(await request(app, 'GET', '/api/focus'), 502);
  assertJsonError(await request(app, 'GET', '/api/status'), 502);
  assertJsonError(await request(app, 'PUT', '/api/focus', { headers: putHeaders(app), body: '{}' }), 502);
  assertJsonError(await request(app, 'POST', '/api/refresh', { headers: { origin: app.origin } }), 502);
  assert.equal((await request(app, 'GET', '/healthz')).status, 200);
});

test('responses over the HTML and JSON size limits become 502', async (t) => {
  const sizes = { '/': 2 * MiB + 1, '/api/focus': 4 * MiB + 1 };
  let chunked = false;
  const upstream = await startScriptedFocus(t, (req, res) => {
    const size = sizes[req.url];
    const type = req.url === '/' ? 'text/html' : 'application/json';
    if (chunked) {
      res.writeHead(200, { 'Content-Type': type });
      for (let sent = 0; sent < size; sent += 256 * 1024) res.write(Buffer.alloc(Math.min(256 * 1024, size - sent), 0x20));
      res.end();
    } else {
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': size }).end(Buffer.alloc(size, 0x20));
    }
  });
  const app = await appFor(t, upstream);
  for (const mode of [false, true]) {
    chunked = mode;
    assertJsonError(await request(app, 'GET', '/embedded/focus'), 502);
    assertJsonError(await request(app, 'GET', '/api/focus'), 502);
  }

  // At the limit is fine.
  sizes['/'] = 2 * MiB;
  sizes['/api/focus'] = 4 * MiB;
  assert.equal((await request(app, 'GET', '/embedded/focus')).status, 200);
  assert.equal((await request(app, 'GET', '/api/focus')).status, 200);
});

test('upstream refusal is 502 on every Focus route', async (t) => {
  const app = await startApp(t, { env: { DASHBOARD_FOCUS_ORIGIN: `http://127.0.0.1:${await freePort()}` } });
  assertJsonError(await request(app, 'GET', '/embedded/focus'), 502);
  assertJsonError(await request(app, 'GET', '/api/focus'), 502);
  assertJsonError(await request(app, 'PUT', '/api/focus', { headers: putHeaders(app), body: '{}' }), 502);
});

test('upstream timeout is 504, and a PUT timeout is reported as uncertain without a retry', async (t) => {
  const upstream = await startScriptedFocus(t, () => {}); // reads the body, never answers
  const app = await appFor(t, upstream, { configure: withUpstreamTimeout(200) });
  const get = await request(app, 'GET', '/api/focus');
  assertJsonError(get, 504);
  const page = await request(app, 'GET', '/embedded/focus');
  assertJsonError(page, 504);
  assert.equal(page.json.error, get.json.error);

  const put = await request(app, 'PUT', '/api/focus', { headers: putHeaders(app), body: '{}' });
  assertJsonError(put, 504);
  assert.notEqual(put.json.error, get.json.error);
  await delay(300);
  assert.equal(upstream.records.filter((r) => r.method === 'PUT').length, 1);
});

test('an upstream redirect is a 502 and is never followed', async (t) => {
  const upstream = await startScriptedFocus(t, (_req, res) => {
    res.writeHead(302, { Location: '/elsewhere' }).end();
  });
  const app = await appFor(t, upstream);
  assertJsonError(await request(app, 'GET', '/embedded/focus'), 502);
  assertJsonError(await request(app, 'GET', '/api/focus'), 502);
  assertJsonError(await request(app, 'PUT', '/api/focus', { headers: putHeaders(app), body: '{}' }), 502);
  assert.deepEqual(upstream.records.map((r) => r.url), ['/', '/api/focus', '/api/focus']);
});

test('non-HTML page and non-JSON API responses are 502', async (t) => {
  const upstream = await startScriptedFocus(t, (req, res) => {
    const type = req.url === '/' ? 'application/json' : 'text/html';
    res.writeHead(200, { 'Content-Type': type }).end('<script>x</script>');
  });
  const app = await appFor(t, upstream);
  assertJsonError(await request(app, 'GET', '/embedded/focus'), 502);
  assertJsonError(await request(app, 'GET', '/api/focus'), 502);
});

test('with nothing listening on the Focus origin, shell and brief routes answer and status reports Focus unavailable', async (t) => {
  const app = await startApp(t, {
    env: {
      DASHBOARD_FOCUS_ORIGIN: `http://127.0.0.1:${await freePort()}`,
      DASHBOARD_BRIEFS_DIR: path.join(await tempDir(t), 'missing'),
    },
  });
  for (const route of ['/', '/focus', '/feed', '/brief', '/healthz']) {
    assert.equal((await request(app, 'GET', route)).status, 200, route);
  }
  const latest = await request(app, 'GET', '/api/brief/latest');
  assert.equal(latest.status, 503);
  assert.match(latest.headers['content-type'], /^application\/json/);
  assert.deepEqual(latest.json, { error: 'brief_directory_unavailable' });
  const status = await request(app, 'GET', '/api/dashboard/status');
  assert.equal(status.status, 200);
  assert.deepEqual(status.json.focus, { available: false });
});

test('status reports Focus available when upstream answers JSON', async (t) => {
  const upstream = await startScriptedFocus(t);
  const app = await appFor(t, upstream);
  const status = await request(app, 'GET', '/api/dashboard/status');
  assert.deepEqual(status.json.focus, { available: true });
  assert.deepEqual(upstream.records.map((r) => [r.method, r.url]), [['GET', '/api/focus']]);
});

test('checkHealth stops when its signal aborts', async (t) => {
  const upstream = await startScriptedFocus(t, () => {}); // never answers
  const app = await appFor(t, upstream);
  const proxy = createFocusProxy(app.config);

  const controller = new AbortController();
  const started = Date.now();
  const pending = proxy.checkHealth({ signal: controller.signal });
  assert.ok(await waitFor(() => upstream.records.length === 1), 'health check never reached upstream');
  controller.abort();
  assert.deepEqual(await pending, { available: false });
  assert.ok(Date.now() - started < 1_000);
  const record = await Promise.race([upstream.records[0].closed, delay(1_000).then(() => null)]);
  assert.ok(record, 'upstream connection stayed open after abort');

  const aborted = AbortSignal.abort();
  assert.deepEqual(await proxy.checkHealth({ signal: aborted }), { available: false });
  assert.equal(upstream.records.length, 1);
});

test('checkHealth reports a truncated response as unavailable', async (t) => {
  let chunked = false;
  const upstream = await startScriptedFocus(t, (_req, res) => {
    res.writeHead(200, chunked ? { 'Content-Type': 'application/json' } : { 'Content-Type': 'application/json', 'Content-Length': 1000 });
    res.write('{"items":[', () => setTimeout(() => res.socket.destroy(), 10));
  });
  const app = await appFor(t, upstream);
  const proxy = createFocusProxy(app.config);
  assert.deepEqual(await proxy.checkHealth({}), { available: false });
  chunked = true;
  assert.deepEqual(await proxy.checkHealth({}), { available: false });
  assert.deepEqual((await request(app, 'GET', '/api/dashboard/status')).json.focus, { available: false });
});

test('checkHealth reads the whole response and Focus sees a clean close', async (t) => {
  const body = JSON.stringify({ items: Array.from({ length: 5_000 }, (_, i) => ({ id: `item-${i}`, title: 'x'.repeat(80) })) });
  const upstream = await startScriptedFocus(t, (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(body);
  });
  const app = await appFor(t, upstream);
  const proxy = createFocusProxy(app.config);
  for (let i = 0; i < 3; i += 1) assert.deepEqual(await proxy.checkHealth({}), { available: true });
  for (const record of upstream.records) {
    const closed = await Promise.race([record.socketClosed, delay(1_000).then(() => null)]);
    assert.ok(closed, 'health check connection stayed open');
    assert.deepEqual(closed, { hadError: false, errorCode: undefined });
  }
});

test('checkHealth is bounded by the upstream timeout without a signal', async (t) => {
  const upstream = await startScriptedFocus(t, () => {});
  const app = await appFor(t, upstream, { configure: withUpstreamTimeout(100) });
  const started = Date.now();
  assert.deepEqual(await createFocusProxy(app.config).checkHealth({}), { available: false });
  assert.ok(Date.now() - started < 1_000);
});

const FOCUS_STATUS = {
  paused: false,
  running: ['gmail'],
  sources: { gmail: { lastRun: '2026-09-25T13:35:04Z', lastOutcome: 'no change', failures24h: 3 } },
};

test('fetchStatus returns the parsed Focus status from upstream /api/status', async (t) => {
  const upstream = await startScriptedFocus(t, (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(FOCUS_STATUS));
  });
  const app = await appFor(t, upstream);
  assert.deepEqual(await createFocusProxy(app.config).fetchStatus(), FOCUS_STATUS);
  assert.deepEqual(upstream.records.map((r) => [r.method, r.url]), [['GET', '/api/status']]);
  assert.equal(upstream.records[0].headers.host, upstream.authority);
});

test('fetchStatus returns null for a non-JSON reply, a non-object body, or unparseable JSON', async (t) => {
  const replies = [
    ['text/html', '<p>status</p>'],
    ['application/json', '[1,2,3]'],
    ['application/json', 'null'],
    ['application/json', '{"paused":'],
  ];
  let index = 0;
  const upstream = await startScriptedFocus(t, (_req, res) => {
    const [type, text] = replies[index];
    res.writeHead(200, { 'Content-Type': type }).end(text);
  });
  const app = await appFor(t, upstream);
  const proxy = createFocusProxy(app.config);
  for (index = 0; index < replies.length; index += 1) {
    assert.equal(await proxy.fetchStatus(), null, replies[index].join(' '));
  }
});

test('fetchStatus returns null for a non-200 reply', async (t) => {
  const upstream = await startScriptedFocus(t, (_req, res) => {
    res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify(FOCUS_STATUS));
  });
  const app = await appFor(t, upstream);
  assert.equal(await createFocusProxy(app.config).fetchStatus(), null);
});

test('fetchStatus returns null when Focus does not answer in time or the signal aborts', async (t) => {
  const upstream = await startScriptedFocus(t, () => {});
  const app = await appFor(t, upstream, { configure: withUpstreamTimeout(100) });
  const proxy = createFocusProxy(app.config);
  const started = Date.now();
  assert.equal(await proxy.fetchStatus(), null);
  assert.ok(Date.now() - started < 1_000);

  const controller = new AbortController();
  const pending = proxy.fetchStatus({ signal: controller.signal });
  controller.abort();
  assert.equal(await pending, null);
  assert.equal(await proxy.fetchStatus({ signal: AbortSignal.abort() }), null);
});

test('fetchStatus returns null for a reply over the JSON size limit', async (t) => {
  let chunked = false;
  const size = 4 * MiB + 1;
  const upstream = await startScriptedFocus(t, (_req, res) => {
    if (chunked) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      for (let sent = 0; sent < size; sent += 256 * 1024) res.write(Buffer.alloc(Math.min(256 * 1024, size - sent), 0x20));
      res.end();
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': size }).end(Buffer.alloc(size, 0x20));
    }
  });
  const app = await appFor(t, upstream);
  const proxy = createFocusProxy(app.config);
  assert.equal(await proxy.fetchStatus(), null);
  chunked = true;
  assert.equal(await proxy.fetchStatus(), null);
});

// Focus's own status and scan controls, called by its page at absolute paths.
const CONTROLS = [
  ['GET', '/api/status', 200, 'application/json; charset=utf-8', '{"paused":false,"running":[]}'],
  ['GET', '/api/candidates', 200, 'application/json; charset=utf-8', '{"sources":[]}'],
  ['POST', '/api/pause', 200, 'application/json; charset=utf-8', '{"paused":true,"running":[]}'],
  ['POST', '/api/resume', 500, 'text/plain; charset=utf-8', 'launchctl refused'],
  ['POST', '/api/refresh', 202, 'application/json; charset=utf-8', '{"paused":false,"running":["gmail"]}'],
];

test('Focus status and control routes reach the same upstream path and pass the reply through', async (t) => {
  const replies = new Map(CONTROLS.map(([method, url, status, type, text]) => [`${method} ${url}`, { status, type, text }]));
  const upstream = await startScriptedFocus(t, (req, res) => {
    const reply = replies.get(`${req.method} ${req.url}`);
    res.writeHead(reply.status, { 'Content-Type': reply.type }).end(reply.text);
  });
  const app = await appFor(t, upstream);
  for (const [method, url, status, type, text] of CONTROLS) {
    // As Focus's page sends them: no body and no content type.
    const headers = method === 'POST' ? { origin: app.origin, 'content-length': '0' } : {};
    const response = await request(app, method, url, { headers });
    assert.equal(response.status, status, url);
    assert.equal(response.headers['content-type'], type, url);
    assert.equal(response.text, text, url);
    assert.equal(response.headers['cache-control'], 'no-store');
  }
  assert.deepEqual(upstream.records.map((r) => [r.method, r.url]), CONTROLS.map(([method, url]) => [method, url]));
  for (const record of upstream.records) {
    assert.equal(record.headers.host, upstream.authority);
    assert.equal(record.headers.origin, undefined);
    assert.equal(record.headers['content-type'], undefined);
    assert.equal(record.body, '');
    if (record.method === 'POST') assert.equal(record.headers['content-length'], '0');
  }
});

test('a refresh already running passes through as 409', async (t) => {
  const upstream = await startScriptedFocus(t, (_req, res) => {
    res.writeHead(409, { 'Content-Type': 'application/json' }).end('{"running":["gmail"]}');
  });
  const app = await appFor(t, upstream);
  const response = await request(app, 'POST', '/api/refresh', { headers: { origin: app.origin } });
  assert.equal(response.status, 409);
  assert.deepEqual(response.json, { running: ['gmail'] });
});

test('control POSTs need an exact Origin and no body, and never reach Focus otherwise', async (t) => {
  const upstream = await startScriptedFocus(t);
  const app = await appFor(t, upstream);
  for (const url of ['/api/pause', '/api/resume', '/api/refresh']) {
    assertJsonError(await request(app, 'POST', url), 403);
    assertJsonError(await request(app, 'POST', url, { headers: { origin: 'http://evil.example' } }), 403);
    assertJsonError(await request(app, 'POST', url, { headers: { origin: app.origin, 'content-type': 'application/json' }, body: '{}' }), 413);
    async function* chunked() { yield 'x'; }
    assertJsonError(await request(app, 'POST', url, { headers: { origin: app.origin }, body: chunked() }), 400);
  }
  assert.equal(upstream.records.length, 0);
  // A JSON content type is not required, but is not refused either.
  const typed = await request(app, 'POST', '/api/pause', { headers: { origin: app.origin, 'content-type': 'application/json' } });
  assert.equal(typed.status, 200);
  assert.equal(upstream.records.length, 1);
});

test('only the listed Focus paths and methods are forwarded', async (t) => {
  const upstream = await startScriptedFocus(t);
  const app = await appFor(t, upstream);
  for (const url of ['/api/whatever', '/api/focus/extra', '/api/pause/now', '/api/statuses', '/api/dashboard']) {
    assertJsonError(await request(app, 'GET', url), 404);
    assertJsonError(await request(app, 'POST', url, { headers: { origin: app.origin } }), 404);
  }
  for (const [method, url] of [['POST', '/api/status'], ['PUT', '/api/status'], ['HEAD', '/api/status'], ['GET', '/api/pause'], ['PUT', '/api/refresh'], ['DELETE', '/api/resume']]) {
    const response = await request(app, method, url, { headers: { origin: app.origin } });
    assert.equal(response.status, 405, `${method} ${url}`);
  }
  assert.equal(upstream.records.length, 0);

  // The proxy itself refuses anything outside its list without contacting Focus.
  const proxy = createFocusProxy(app.config);
  const refusal = await new Promise((resolve) => {
    const res = { headersSent: false, req: null, setHeader() {}, writeHead(status) { this.statusCode = status; }, end() { resolve(this.statusCode); } };
    proxy.handleControl({ method: 'GET', headers: {} }, res, { path: '/api/focus' });
  });
  assert.equal(refusal, 404);
  assert.equal(upstream.records.length, 0);
});

test('the dashboard status moved to /api/dashboard/status; /api/status is Focus\'s', async (t) => {
  const upstream = await startScriptedFocus(t, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ from: req.url }));
  });
  const app = await appFor(t, upstream);
  const dashboard = await request(app, 'GET', '/api/dashboard/status');
  assert.deepEqual(dashboard.json.focus, { available: true });
  assert.deepEqual(upstream.records.map((r) => r.url), ['/api/focus']);
  const focus = await request(app, 'GET', '/api/status');
  assert.deepEqual(focus.json, { from: '/api/status' });
});

// The real Focus server, copied into a temporary Git repository.
const isolated = { skip: focusSourceAvailable() ? false : 'Focus checkout not found' };

test('isolated Focus: page and API load through the proxy', isolated, async (t) => {
  const focus = await startIsolatedFocus(t);
  const app = await startApp(t, { env: { DASHBOARD_FOCUS_ORIGIN: focus.origin } });
  const page = await request(app, 'GET', '/embedded/focus');
  assert.equal(page.status, 200);
  assert.match(page.headers['content-type'], /^text\/html/);
  assert.ok(page.text.includes("fetch('/api/focus'"), 'Focus markup missing');
  const api = await request(app, 'GET', '/api/focus');
  assert.equal(api.status, 200);
  assert.deepEqual(api.json.items.map((item) => item.id), ['fixture-a', 'fixture-b']);
  assert.deepEqual((await request(app, 'GET', '/api/dashboard/status')).json.focus, { available: true });
});

test('isolated Focus: the fixture is its own Git repository', isolated, async (t) => {
  const focus = await startIsolatedFocus(t);
  assert.equal(focus.git('rev-parse', '--show-toplevel').trim(), focus.dir);
  assert.equal(focus.git('config', '--get', 'core.hooksPath').trim(), path.join(focus.dir, '.git', 'no-hooks'));
});

test('isolated Focus: status and scan controls work through the proxy', isolated, async (t) => {
  const focus = await startIsolatedFocus(t);
  const app = await startApp(t, { env: { DASHBOARD_FOCUS_ORIGIN: focus.origin } });
  const page = await request(app, 'GET', '/embedded/focus');
  assert.ok(page.text.includes("fetch('/api/status'"), 'Focus page no longer calls /api/status');
  const status = await request(app, 'GET', '/api/status');
  assert.equal(status.status, 200);
  assert.ok(Array.isArray(status.json.running));
  // The scan runner is a stub that exits at once.
  const refresh = await request(app, 'POST', '/api/refresh', { headers: { origin: app.origin } });
  assert.ok([202, 409].includes(refresh.status), `refresh answered ${refresh.status}`);
  assert.ok(Array.isArray(refresh.json.running));
  // The fixture's bin/focus-pause is a stub that exits 1, so Focus reports
  // its 500 and launchd is never touched.
  const pause = await request(app, 'POST', '/api/pause', { headers: { origin: app.origin } });
  assert.equal(pause.status, 500);
  assert.match(pause.headers['content-type'], /^text\/plain/);
  assert.match(pause.text, /fixture stub: focus-pause/);
});

test('isolated Focus: the launchd scripts are the fixture\'s own stubs', isolated, async (t) => {
  const focus = await startIsolatedFocus(t);
  for (const name of ['focus-pause', 'focus-resume']) {
    const stub = await readFile(path.join(focus.dir, 'bin', name), 'utf8');
    assert.match(stub, new RegExp(`fixture stub: ${name}`));
    assert.equal((await stat(path.join(focus.dir, 'bin', name))).mode & 0o777, 0o700);
  }
  assert.deepEqual((await readdir(path.join(focus.dir, 'bin'))).sort(), ['focus-pause', 'focus-resume']);
});

// Every absolute API path the Focus page calls must be one the dashboard
// forwards, or it would 404 inside the frame.
const FORWARDED_FOCUS_PATHS = new Set(['/api/focus', '/api/status', '/api/candidates', '/api/pause', '/api/resume', '/api/refresh']);

test('isolated Focus: every API path the page calls is forwarded', isolated, async (t) => {
  const focus = await startIsolatedFocus(t);
  const html = await readFile(path.join(focus.dir, 'ui', 'index.html'), 'utf8');
  const called = new Set();
  // fetch('/…') with a literal path, and any '/api/…' literal, which covers
  // paths kept in a variable and passed to fetch later.
  for (const match of html.matchAll(/\bfetch\(\s*(['"`])(\/[^'"`]*)\1/g)) called.add(match[2]);
  for (const match of html.matchAll(/(['"`])(\/api\/[^'"`]*)\1/g)) called.add(match[2]);
  const paths = [...called].map((value) => value.split(/[?#]/)[0]);
  assert.ok(paths.length > 0, 'found no API paths in the Focus page');
  const missing = paths.filter((value) => !FORWARDED_FOCUS_PATHS.has(value));
  assert.deepEqual(missing, [], `Focus calls paths the dashboard does not forward: ${missing.join(', ')}`);
  for (const expected of ['/api/focus', '/api/status', '/api/pause', '/api/resume', '/api/refresh']) {
    assert.ok(paths.includes(expected), `Focus page no longer calls ${expected}`);
  }
});

test('isolated Focus: a valid PUT writes focus.json and commits with a manual: subject', isolated, async (t) => {
  const focus = await startIsolatedFocus(t);
  const app = await startApp(t, { env: { DASHBOARD_FOCUS_ORIGIN: focus.origin } });
  const before = await focus.readDoc();
  const subjectsBefore = focus.commitSubjects();
  const next = {
    ...before,
    items: [...before.items, {
      id: 'fixture-c', title: 'Invented task C', source: 'manual', tier: 'tomorrow', now: false, status: 'open',
      created: before.updated, updated: before.updated,
    }],
  };
  const response = await request(app, 'PUT', '/api/focus', { headers: putHeaders(app), body: JSON.stringify(next) });
  assert.equal(response.status, 200);
  assert.ok(response.json.items.some((item) => item.id === 'fixture-c'));
  const after = await focus.readDoc();
  assert.ok(after.items.some((item) => item.id === 'fixture-c'));
  const subjects = focus.commitSubjects();
  assert.equal(subjects.length, subjectsBefore.length + 1);
  assert.match(subjects[0], /^manual: /);
});

test('isolated Focus: an invalid PUT returns Focus\'s error and changes nothing', isolated, async (t) => {
  const focus = await startIsolatedFocus(t);
  const app = await startApp(t, { env: { DASHBOARD_FOCUS_ORIGIN: focus.origin } });
  const raw = await focus.readRaw();
  const subjects = focus.commitSubjects();
  const doc = JSON.parse(raw);
  // An invalid tier would also be refused, but Focus's commit-message code
  // throws on it before validation runs; a bad source reaches the validator.
  doc.items[1] = { ...doc.items[1], source: 'nowhere' };
  const response = await request(app, 'PUT', '/api/focus', { headers: putHeaders(app), body: JSON.stringify(doc) });
  assert.equal(response.status, 400);
  assert.match(response.headers['content-type'], /^text\/plain/);
  assert.match(response.text, /source/);
  assert.equal(await focus.readRaw(), raw);
  assert.deepEqual(focus.commitSubjects(), subjects);
});
