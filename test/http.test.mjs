import assert from 'node:assert/strict';
import net from 'node:net';
import { test } from 'node:test';

import { HttpError, buildChildCsp, sendError } from '../lib/http.mjs';
import { chunks, request, startApp, startSyntheticFocus } from './support/harness.mjs';

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
    async handleEmbedded(_req, res, params) {
      calls.push({ route: 'embedded', params });
      res.writeHead(200, { 'Content-Type': 'text/html' }).end('<p>invented</p>');
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

test('shell routes serve the same HTML with the shell CSP', async (t) => {
  const app = await startApp(t);
  const bodies = [];
  for (const path of ['/', '/focus', '/brief', '/?view=x']) {
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
  const upstream = await startSyntheticFocus(t);
  const app = await startApp(t, {
    env: { DASHBOARD_FOCUS_ORIGIN: upstream.origin, DASHBOARD_BRIEFS_DIR: '/nonexistent/dashboard-test/briefs' },
  });
  for (const path of ['/', '/focus', '/brief', '/healthz']) {
    assert.equal((await request(app, 'GET', path)).status, 200, path);
  }
  const status = await request(app, 'GET', '/api/status');
  assert.equal(status.status, 200);
  assert.deepEqual(status.json, { focus: { available: false }, brief: { state: 'empty' } });
  assertJsonError(await request(app, 'GET', '/embedded/focus'), 503);
  assertJsonError(await request(app, 'GET', '/api/focus'), 503);
  assertJsonError(await request(app, 'PUT', '/api/focus', {
    headers: { origin: app.origin, 'content-type': 'application/json' },
    body: '{"invented":true}',
  }), 503);
  assertJsonError(await request(app, 'POST', '/api/brief/feedback', {
    headers: { origin: app.origin, 'content-type': 'application/json' },
    body: '{}',
  }), 503);
  const latest = await request(app, 'GET', '/api/brief/latest');
  assert.equal(latest.status, 200);
  assert.deepEqual(latest.json, { state: 'empty' });
  assertJsonError(await request(app, 'GET', `/embedded/brief/2026-01-02?revision=${REVISION}`), 404);
  // The phase 1 stub never contacts the upstream.
  assert.deepEqual(upstream.requests, []);
});

test('status copies only non-content brief fields', async (t) => {
  const app = await startApp(t, { focus: consumingFocus(), brief: recordingBrief() });
  const response = await request(app, 'GET', '/api/status');
  assert.deepEqual(response.json, {
    focus: { available: true },
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
    const response = await request(app, 'GET', '/api/status');
    assert.equal(response.status, 200);
    assert.deepEqual(response.json, { focus: { available: false }, brief: { state: 'unavailable' } });
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
  await request(app, 'GET', '/api/status');
  assert.equal(aborted, true);
});

test('unknown routes and assets return 404 JSON', async (t) => {
  const app = await startApp(t);
  for (const path of ['/nope', '/save', '/index.html', '/assets/', '/assets/server.mjs', '/assets/index.html',
    '/assets/brief-bridge.js', '/embedded/brief/2026-02-30', '/embedded/brief/latest', '/api', '/public/index.html']) {
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
    ['POST', '/'], ['DELETE', '/healthz'], ['OPTIONS', '/focus'], ['PUT', '/api/status'], ['HEAD', '/api/status'],
    ['POST', '/api/focus'], ['DELETE', '/api/focus'], ['GET', '/api/brief/feedback'], ['PUT', '/api/brief/feedback'],
    ['POST', '/embedded/focus'], ['POST', '/api/brief/latest'], ['PATCH', '/assets/brief-bridge.js'],
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

test('Focus PUT bodies stream to the proxy and are capped at 1,000,000 bytes', async (t) => {
  const focus = consumingFocus();
  const app = await startApp(t, { focus });
  const headers = { origin: app.origin, 'content-type': 'application/json' };

  const ok = await request(app, 'PUT', '/api/focus', { headers, body: chunks(1_000_000) });
  assert.equal(ok.status, 200);
  assert.deepEqual(focus.received, [1_000_000]);

  const declared = await request(app, 'PUT', '/api/focus', { headers, body: Buffer.alloc(1_000_001) });
  assertJsonError(declared, 413);

  const streamed = await request(app, 'PUT', '/api/focus', { headers, body: chunks(3_000_000) });
  assertJsonError(streamed, 413);
  assert.deepEqual(focus.received, [1_000_000]);
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

test('embedded brief validates date and revision before the adapter', async (t) => {
  const brief = recordingBrief();
  const app = await startApp(t, { brief });
  assert.equal((await request(app, 'GET', `/embedded/brief/2024-02-29?revision=${REVISION}`)).status, 200);
  assert.deepEqual(brief.calls, [{ route: 'embedded', params: { date: '2024-02-29', revision: REVISION } }]);
  for (const query of ['', '?revision=', `?revision=${'A'.repeat(64)}`, `?revision=${'a'.repeat(63)}`, '?rev=x']) {
    assertJsonError(await request(app, 'GET', `/embedded/brief/2024-02-29${query}`), 400);
  }
  assertJsonError(await request(app, 'GET', `/embedded/brief/2023-02-29?revision=${REVISION}`), 404);
  assert.equal(brief.calls.length, 1);
});

test('handler failures become 500 JSON without details; HttpError keeps its status', async (t) => {
  const app = await startApp(t, {
    brief: {
      ...recordingBrief(),
      handleLatest: async () => { throw new Error('secret detail /Users/x/briefs'); },
      handleEmbedded: async () => { throw new HttpError(409, 'revision_conflict'); },
    },
  });
  const failed = await request(app, 'GET', '/api/brief/latest');
  assertJsonError(failed, 500);
  assert.doesNotMatch(failed.text, /secret|Users/);
  assertJsonError(await request(app, 'GET', `/embedded/brief/2026-01-02?revision=${REVISION}`), 409);
});

test('logs record route, status, and timing only', async (t) => {
  const brief = recordingBrief();
  const app = await startApp(t, { brief });
  await request(app, 'POST', '/api/brief/feedback', {
    headers: { origin: app.origin, 'content-type': 'application/json' },
    body: '{"note":"invented private words"}',
  });
  await request(app, 'GET', `/embedded/brief/2026-01-02?revision=${REVISION}`);
  await new Promise((resolve) => setImmediate(resolve));
  const text = JSON.stringify(app.logs);
  assert.doesNotMatch(text, /invented|private|revision=/);
  assert.ok(app.logs.some((entry) => entry.route === '/api/brief/feedback' && entry.status === 200 && typeof entry.ms === 'number'));
  assert.ok(app.logs.some((entry) => entry.route === '/embedded/brief/:date'));
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
