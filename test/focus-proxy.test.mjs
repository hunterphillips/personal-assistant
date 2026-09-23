import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { createFocusProxy } from '../lib/focus-proxy.mjs';
import { focusSourceAvailable, startIsolatedFocus } from './support/isolated-focus.mjs';
import { freePort, request, startApp, tempDir } from './support/harness.mjs';
import { startScriptedFocus } from './support/synthetic-focus.mjs';

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

  const embedded = await request(app, 'GET', '/embedded/focus');
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
  for (const route of ['/', '/focus', '/brief', '/healthz', '/api/brief/latest']) {
    assert.equal((await request(app, 'GET', route)).status, 200, route);
  }
  const status = await request(app, 'GET', '/api/status');
  assert.equal(status.status, 200);
  assert.deepEqual(status.json.focus, { available: false });
});

test('status reports Focus available when upstream answers JSON', async (t) => {
  const upstream = await startScriptedFocus(t);
  const app = await appFor(t, upstream);
  const status = await request(app, 'GET', '/api/status');
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

test('checkHealth is bounded by the upstream timeout without a signal', async (t) => {
  const upstream = await startScriptedFocus(t, () => {});
  const app = await appFor(t, upstream, { configure: withUpstreamTimeout(100) });
  const started = Date.now();
  assert.deepEqual(await createFocusProxy(app.config).checkHealth({}), { available: false });
  assert.ok(Date.now() - started < 1_000);
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
  assert.deepEqual((await request(app, 'GET', '/api/status')).json.focus, { available: true });
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

