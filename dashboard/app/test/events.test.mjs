import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fakeCmux, fakeRoutines, request, startApp, startSyntheticFocus } from './support/harness.mjs';
import { openEvents } from './support/sse.mjs';

const REVISION = 'b'.repeat(64);

// Status dependencies that answer at once and count Focus health checks.
function countingStatus() {
  const counts = { health: 0 };
  return {
    counts,
    focus: { checkHealth: async () => { counts.health += 1; return { available: true }; } },
    brief: { latestMetadata: async () => ({ state: 'ready', date: '2026-09-25', revision: REVISION }) },
  };
}

function withTimeouts(timeouts) {
  return (config) => ({ ...config, timeouts: { ...config.timeouts, ...timeouts } });
}

async function startStreamingApp(t, options = {}) {
  const status = countingStatus();
  const app = await startApp(t, { focus: status.focus, brief: status.brief, ...options });
  return { ...app, counts: status.counts };
}

async function waitFor(condition, ms = 2_000) {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function open(t, app) {
  const stream = await openEvents(app);
  t.after(() => stream.close?.());
  return stream;
}

test('a stream opens with SSE headers and a snapshot whose id is its revision', async (t) => {
  const app = await startStreamingApp(t);
  const stream = await open(t, app);
  assert.equal(stream.status, 200);
  assert.equal(stream.headers['content-type'], 'text/event-stream; charset=utf-8');
  assert.equal(stream.headers['cache-control'], 'no-store');
  assert.equal(stream.headers['x-accel-buffering'], 'no');
  assert.equal(stream.headers.connection, 'keep-alive');
  const first = await stream.next();
  assert.equal(first.event, 'snapshot');
  assert.equal(first.id, String(first.data.revision));
  assert.deepEqual(first.data.focus, { available: true });
  assert.deepEqual(first.data.brief, { state: 'ready', date: '2026-09-25', revision: REVISION });
  assert.equal(first.data.revision, app.hub.snapshot().revision);
});

test('a routines refresh reaches an open stream as deltas', async (t) => {
  const app = await startStreamingApp(t, { routines: fakeRoutines([{ label: 'com.invented.job' }]) });
  const stream = await open(t, app);
  const snapshot = await stream.next();
  await app.hub.refreshRoutines();
  const refreshing = await stream.next();
  const done = await stream.next();
  assert.deepEqual([refreshing.event, done.event], ['delta', 'delta']);
  assert.equal(Number(refreshing.id), snapshot.data.revision + 1);
  assert.equal(Number(done.id), snapshot.data.revision + 2);
  assert.deepEqual(Object.keys(done.data.patch), ['routines']);
  assert.equal(done.data.revision, Number(done.id));
  assert.deepEqual(done.data.patch.routines.items, [{ label: 'com.invented.job' }]);
});

test('a stream that stops reading drops deltas and gets one reload after drain', async (t) => {
  const big = Array.from({ length: 200 }, (_, i) => ({ label: `com.invented.job-${i}`, note: 'x'.repeat(4_000) }));
  const app = await startStreamingApp(t, { routines: fakeRoutines(big) });
  const stream = await open(t, app);
  await stream.next();
  stream.pause();
  const emitted = 40;
  for (let i = 0; i < emitted / 2; i += 1) await app.hub.refreshRoutines();
  stream.resume();
  const events = [];
  for (;;) {
    const next = await stream.next(500).catch(() => null);
    if (!next) break;
    events.push(next);
  }
  const deltas = events.filter((e) => e.event === 'delta');
  assert.ok(deltas.length < emitted, `${deltas.length} deltas of ${emitted}`);
  assert.equal(events.filter((e) => e.event === 'reload').length, 1);
  assert.deepEqual(events.at(-1), { event: 'reload', data: {} });
});

test('an open stream receives heartbeats', async (t) => {
  const app = await startStreamingApp(t, { configure: withTimeouts({ heartbeatMs: 20 }) });
  const stream = await open(t, app);
  await stream.next();
  assert.deepEqual(await stream.next(), { comment: 'ping' });
});

test('a client disconnect frees its subscription and logs stream_closed', async (t) => {
  const app = await startStreamingApp(t);
  const stream = await open(t, app);
  await stream.next();
  assert.equal(app.hub.clientCount(), 1);
  await stream.close();
  await waitFor(() => app.hub.clientCount() === 0);
  await waitFor(() => app.logs.some((entry) => entry.event === 'stream_closed'));
  const entry = app.logs.find((e) => e.event === 'stream_closed');
  assert.equal(entry.route, 'events');
  assert.equal(entry.status, 200);
  assert.equal(typeof entry.ms, 'number');
  assert.equal(app.logs.some((e) => e.event === 'response_incomplete'), false);
});

test('streams beyond the limit get 503 too_many_streams', async (t) => {
  const app = await startStreamingApp(t);
  const streams = [];
  for (let i = 0; i < app.config.limits.eventStreams; i += 1) {
    const stream = await open(t, app);
    await stream.next();
    streams.push(stream);
  }
  const refused = await openEvents(app);
  assert.equal(refused.status, 503);
  assert.equal(refused.headers['retry-after'], '5');
  assert.deepEqual(JSON.parse(refused.body), { error: 'too_many_streams' });
  await streams[0].close();
  await waitFor(() => app.hub.clientCount() === streams.length - 1);
  const again = await open(t, app);
  assert.equal(again.status, 200);
});

test('the events route is GET only', async (t) => {
  const app = await startStreamingApp(t);
  for (const method of ['POST', 'HEAD', 'PUT']) {
    const response = await request(app, method, '/api/events', { headers: { origin: app.origin } });
    assert.equal(response.status, 405, method);
    assert.equal(response.headers.allow, 'GET');
  }
});

test('closeStreams ends open streams with bye and refuses new ones', async (t) => {
  const app = await startStreamingApp(t);
  const stream = await open(t, app);
  await stream.next();
  app.handler.closeStreams();
  assert.deepEqual(await stream.next(), { event: 'bye', data: {} });
  await stream.closed;
  const refused = await openEvents(app);
  assert.equal(refused.status, 503);
});

test('the shared status poll runs only while a stream is open', async (t) => {
  const app = await startStreamingApp(t, { configure: withTimeouts({ statusPollMs: 15 }) });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(app.counts.health, 0);

  const first = await open(t, app);
  const second = await open(t, app);
  await Promise.all([first.next(), second.next()]);
  const opened = app.counts.health;
  await waitFor(() => app.counts.health >= opened + 3);

  await first.close();
  const oneLeft = app.counts.health;
  await waitFor(() => app.counts.health >= oneLeft + 2);

  await second.close();
  await waitFor(() => app.hub.clientCount() === 0);
  const closed = app.counts.health;
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.ok(app.counts.health <= closed + 1, 'polling stopped with the last stream');
});

test('the sessions poll refreshes cmux once when the first stream opens, then on its interval, and stops with the last stream', async (t) => {
  const cmux = fakeCmux({ available: false, reason: 'not_running', stale: false, workspaces: [], surfaces: [], agents: [] });
  const app = await startStreamingApp(t, { cmux, configure: withTimeouts({ sessionsPollMs: 15 }) });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(cmux.refreshes, 0);
  assert.deepEqual(app.hub.snapshot().cmux, { available: false, reason: 'not_refreshed' });

  const first = await open(t, app);
  const second = await open(t, app);
  await Promise.all([first.next(), second.next()]);
  await waitFor(() => cmux.refreshes >= 4);
  assert.deepEqual(app.hub.snapshot().cmux, { available: false, reason: 'not_running' });

  await first.close();
  const oneLeft = cmux.refreshes;
  await waitFor(() => cmux.refreshes >= oneLeft + 2);

  await second.close();
  await waitFor(() => app.hub.clientCount() === 0);
  const closed = cmux.refreshes;
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.ok(cmux.refreshes <= closed + 1, 'polling stopped with the last stream');
});

test('GET /api/state checks Focus and the brief, then returns the hub snapshot', async (t) => {
  const app = await startStreamingApp(t);
  const response = await request(app, 'GET', '/api/state');
  assert.equal(app.counts.health, 1);
  assert.deepEqual(response.json.focus, { available: true });
  assert.equal(response.status, 200);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.match(response.headers['content-type'], /^application\/json/);
  for (const key of ['revision', 'updatedAt', 'focus', 'brief', 'registry', 'agents', 'routines']) {
    assert.ok(key in response.json, key);
  }
  assert.deepEqual(response.json, JSON.parse(JSON.stringify(app.hub.snapshot())));
  assert.equal((await request(app, 'POST', '/api/state', { headers: { origin: app.origin } })).status, 405);
});

test('POST /api/routines/refresh needs an exact Origin and no body', async (t) => {
  const app = await startStreamingApp(t);
  const missing = await request(app, 'POST', '/api/routines/refresh');
  assert.equal(missing.status, 403);
  assert.deepEqual(missing.json, { error: 'forbidden_origin' });
  const foreign = await request(app, 'POST', '/api/routines/refresh', { headers: { origin: 'http://example.com' } });
  assert.equal(foreign.status, 403);
  const declared = await request(app, 'POST', '/api/routines/refresh', { headers: { origin: app.origin }, body: 'x' });
  assert.equal(declared.status, 413);
  const chunked = await request(app, 'POST', '/api/routines/refresh', {
    headers: { origin: app.origin, 'transfer-encoding': 'chunked' },
    body: 'x',
  });
  assert.equal(chunked.status, 400);
  assert.equal(app.routines.calls, 0);
});

test('POST /api/routines/refresh refreshes and returns the new revision', async (t) => {
  const app = await startStreamingApp(t);
  const before = app.hub.snapshot().revision;
  const response = await request(app, 'POST', '/api/routines/refresh', { headers: { origin: app.origin } });
  assert.equal(response.status, 200);
  assert.equal(response.json.ok, true);
  assert.ok(response.json.revision > before);
  assert.equal(response.json.revision, app.hub.snapshot().revision);
  assert.equal(app.routines.calls, 1);
  assert.equal(app.hub.snapshot().routines.refreshing, false);
});

test('a successful forwarded pause or resume refreshes routines', async (t) => {
  const upstream = await startSyntheticFocus(t);
  const app = await startApp(t, { env: { DASHBOARD_FOCUS_ORIGIN: upstream.origin } });
  const pause = await request(app, 'POST', '/api/pause', { headers: { origin: app.origin } });
  assert.equal(pause.status, 200);
  await waitFor(() => app.routines.calls === 1);
  await request(app, 'POST', '/api/resume', { headers: { origin: app.origin } });
  await waitFor(() => app.routines.calls === 2);
  await request(app, 'POST', '/api/refresh', { headers: { origin: app.origin } });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(app.routines.calls, 2);
});

test('a failed forwarded pause does not refresh routines', async (t) => {
  // Nothing listens on the Focus origin startApp picks, so the proxy answers 502.
  const app = await startApp(t);
  const pause = await request(app, 'POST', '/api/pause', { headers: { origin: app.origin } });
  assert.equal(pause.status, 502);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(app.routines.calls, 0);
});

test('the new shell paths serve the shell and their slash forms redirect', async (t) => {
  const app = await startStreamingApp(t);
  const shell = await request(app, 'GET', '/');
  for (const view of ['/health', '/agents', '/goals', '/reading']) {
    const response = await request(app, 'GET', view);
    assert.equal(response.status, 200, view);
    assert.equal(response.text, shell.text);
    assert.equal(response.headers['content-security-policy'], shell.headers['content-security-policy']);
    const slash = await request(app, 'GET', `${view}/?a=1`);
    assert.equal(slash.status, 308);
    assert.equal(slash.headers.location, `${view}?a=1`);
  }
});

// Brief notices (notices.mjs) as the event stream drives them.
function fakeNotices() {
  const fake = {
    reconciles: 0,
    starts: [],
    stops: 0,
    running: false,
    reconcile: async () => { fake.reconciles += 1; },
    start(intervalMs) { fake.starts.push(intervalMs); fake.running = true; },
    stop() { fake.stops += 1; fake.running = false; },
  };
  return fake;
}

test('a connect reconciles the brief notice after the status refresh, and the open-stream count rises and falls', async (t) => {
  const notices = fakeNotices();
  const app = await startStreamingApp(t, { notices, configure: withTimeouts({ noticePollMs: 12_345 }) });
  assert.equal(app.handler.openStreams(), 0);
  assert.equal(notices.reconciles, 0);

  const first = await open(t, app);
  await first.next();
  assert.equal(app.handler.openStreams(), 1);
  await waitFor(() => notices.reconciles === 1);
  assert.equal(app.counts.health, 1);
  assert.deepEqual(notices.starts, [12_345]);

  const second = await open(t, app);
  await second.next();
  assert.equal(app.handler.openStreams(), 2);
  await waitFor(() => notices.reconciles === 2);
  assert.deepEqual(notices.starts, [12_345], 'the timer starts once for the first stream');

  first.close();
  await first.closed;
  await waitFor(() => app.handler.openStreams() === 1);
  assert.equal(notices.stops, 0);

  second.close();
  await second.closed;
  await waitFor(() => app.handler.openStreams() === 0);
  assert.equal(notices.stops, 1);
  assert.equal(notices.running, false);
});

test('closing the streams for shutdown stops the notice timer', async (t) => {
  const notices = fakeNotices();
  const app = await startStreamingApp(t, { notices });
  const stream = await open(t, app);
  await stream.next();
  assert.equal(notices.running, true);
  app.handler.closeStreams();
  await stream.closed;
  assert.equal(notices.running, false);
  assert.equal(app.handler.openStreams(), 0);
});
