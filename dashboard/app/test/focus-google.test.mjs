// Google access is exercised entirely with temporary credentials and scripted
// fetch replies; no test can contact Google.

import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import { ScanError } from '../lib/focus/candidates.mjs';
import { createGoogle } from '../lib/focus/google.mjs';
import { tempDir } from './support/harness.mjs';

const NOW = Date.parse('2026-09-24T12:00:00Z');
const later = (ms) => new Date(NOW + ms).toISOString();
const withCode = (code) => (error) => error instanceof ScanError && error.code === code && typeof error.detail === 'string';
const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => body });

async function seed(t, token = {}) {
  const dir = path.join(await tempDir(t), 'google');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'client.json'), JSON.stringify({ installed: { client_id: 'cid', client_secret: 'secret' } }));
  await writeFile(path.join(dir, 'token.json'), JSON.stringify({
    access_token: 'at-old', refresh_token: 'rt', expires_at: later(60 * 60_000), ...token,
  }));
  return dir;
}

function scriptedFetch(handlers) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const handler = handlers.shift();
    assert.ok(handler, `unexpected fetch: ${url}`);
    return handler(String(url), init);
  };
  fetch.calls = calls;
  return fetch;
}

test('a fresh token is used without a refresh', async (t) => {
  const fetch = scriptedFetch([(_url, init) => {
    assert.equal(init.headers.authorization, 'Bearer at-old');
    return reply(200, '{"ok":true}');
  }]);
  const google = createGoogle({ dir: await seed(t), fetch, now: () => NOW });
  assert.equal(google.hasToken(), true);
  assert.deepEqual(await google.gapi('https://example.test/v1/thing'), { ok: true });
  assert.equal(fetch.calls.length, 1);
  assert.ok(Object.isFrozen(google));
});

test('a token inside the five-minute skew refreshes and is rewritten mode 0600', async (t) => {
  const dir = await seed(t, { expires_at: later(2 * 60_000) });
  const logs = [];
  const fetch = scriptedFetch([
    (_url, init) => {
      assert.match(init.body, /grant_type=refresh_token/);
      return reply(200, '{"access_token":"at-new","expires_in":3599}');
    },
    (_url, init) => {
      assert.equal(init.headers.authorization, 'Bearer at-new');
      return reply(200, '{"ok":true}');
    },
  ]);
  const google = createGoogle({ dir, fetch, now: () => NOW, log: (entry) => logs.push(entry) });
  assert.deepEqual(await google.gapi('https://example.test/v1/thing'), { ok: true });
  const saved = JSON.parse(await readFile(path.join(dir, 'token.json'), 'utf8'));
  assert.equal(saved.refresh_token, 'rt');
  assert.equal(saved.expires_at, new Date(NOW + 3599_000).toISOString());
  assert.equal((await stat(path.join(dir, 'token.json'))).mode & 0o777, 0o600);
  assert.deepEqual(logs, [{ event: 'focus_google_refreshed' }]);
});

test('two calls that find the token stale share one token request', async (t) => {
  const dir = await seed(t, { expires_at: later(-60_000) });
  const calls = [];
  let releaseToken;
  const tokenReply = new Promise((resolve) => { releaseToken = resolve; });
  const fetch = async (url, init = {}) => {
    calls.push(String(url));
    if (String(url) === 'https://oauth2.googleapis.com/token') {
      await tokenReply;
      return reply(200, '{"access_token":"at-new","expires_in":3600}');
    }
    assert.equal(init.headers.authorization, 'Bearer at-new');
    return reply(200, '{"ok":true}');
  };
  const google = createGoogle({ dir, fetch, now: () => NOW });
  const both = Promise.all([
    google.gapi('https://example.test/v1/a'),
    google.gapi('https://example.test/v1/b'),
  ]);
  await new Promise((resolve) => setImmediate(resolve));
  releaseToken();
  assert.deepEqual(await both, [{ ok: true }, { ok: true }]);
  assert.equal(calls.filter((url) => url === 'https://oauth2.googleapis.com/token').length, 1);
  assert.equal(calls.length, 3);
  assert.deepEqual(await readdir(dir), ['client.json', 'token.json'], 'no temp file is left behind');
});

test('a 401 buys exactly one forced refresh and one retry', async (t) => {
  const fetch = scriptedFetch([
    (_url, init) => {
      assert.equal(init.headers.authorization, 'Bearer at-old');
      return reply(401, 'expired');
    },
    () => reply(200, '{"access_token":"at-new","expires_in":3600}'),
    (_url, init) => {
      assert.equal(init.headers.authorization, 'Bearer at-new');
      return reply(200, '{"ok":true}');
    },
  ]);
  const google = createGoogle({ dir: await seed(t), fetch, now: () => NOW });
  assert.deepEqual(await google.gapi('https://example.test/v1/thing'), { ok: true });
  assert.equal(fetch.calls.length, 3);
});

test('query arrays repeat their key and signals reach fetch', async (t) => {
  const controller = new AbortController();
  const fetch = scriptedFetch([(url, init) => {
    const target = new URL(url);
    assert.equal(target.searchParams.get('q'), 'in:inbox a b');
    assert.deepEqual(target.searchParams.getAll('metadataHeaders'), ['From', 'To']);
    assert.equal(target.searchParams.has('nothing'), false);
    assert.equal(init.signal, controller.signal);
    return reply(200, '{}');
  }]);
  const google = createGoogle({ dir: await seed(t), fetch, now: () => NOW });
  await google.gapi('https://example.test/v1/threads', {
    q: 'in:inbox a b', metadataHeaders: ['From', 'To'], nothing: null,
  }, { signal: controller.signal });
});

test('gapiPages collects the named field and stops at maxPages', async (t) => {
  const fetch = scriptedFetch([
    () => reply(200, '{"threads":[{"id":"a"}],"nextPageToken":"p2"}'),
    (url) => {
      assert.equal(new URL(url).searchParams.get('pageToken'), 'p2');
      return reply(200, '{"threads":[{"id":"b"}],"nextPageToken":"p3"}');
    },
  ]);
  const google = createGoogle({ dir: await seed(t), fetch, now: () => NOW });
  const threads = await google.gapiPages('https://example.test/v1/threads', {}, { key: 'threads', maxPages: 2 });
  assert.deepEqual(threads.map((thread) => thread.id), ['a', 'b']);
  assert.equal(fetch.calls.length, 2);
});

test('gapiPages returns nothing when a page leaves the field out', async (t) => {
  const fetch = scriptedFetch([() => reply(200, '{"resultSizeEstimate":0}')]);
  const google = createGoogle({ dir: await seed(t), fetch, now: () => NOW });
  const threads = await google.gapiPages('https://example.test/v1/threads', { q: 'nothing' }, { key: 'threads', maxPages: 3 });
  assert.deepEqual(threads, []);
  assert.equal(fetch.calls.length, 1);
});

test('a missing token file or a token without a refresh token is google_signed_out', async (t) => {
  const missingDir = path.join(await tempDir(t), 'missing');
  const missing = createGoogle({ dir: missingDir, fetch: scriptedFetch([]), now: () => NOW });
  assert.equal(missing.hasToken(), false);
  await assert.rejects(() => missing.gapi('https://example.test/v1/thing'), withCode('google_signed_out'));

  const dir = await seed(t, { refresh_token: undefined, expires_at: later(-60_000) });
  const noRefresh = createGoogle({ dir, fetch: scriptedFetch([]), now: () => NOW });
  await assert.rejects(() => noRefresh.gapi('https://example.test/v1/thing'), withCode('google_signed_out'));
});

test('the token endpoint answering 400 or 401 is google_reauth', async (t) => {
  for (const [status, body] of [[400, '{"error":"invalid_grant"}'], [401, '{"error":"unauthorized_client"}']]) {
    const google = createGoogle({
      dir: await seed(t, { expires_at: later(-60_000) }),
      fetch: scriptedFetch([() => reply(status, body)]),
      now: () => NOW,
    });
    await assert.rejects(() => google.gapi('https://example.test/v1/thing'), withCode('google_reauth'));
  }
});

test('other statuses, non-JSON bodies, and network errors are google_failed', async (t) => {
  const stale = { expires_at: later(-60_000) };
  const cases = [
    [{}, [() => reply(403, '{"error":"insufficient scope"}')]],
    [{}, [() => reply(200, 'not json')]],
    [{}, [() => { throw new TypeError('fetch failed'); }]],
    [stale, [() => reply(500, 'backend error')]],
    [stale, [() => reply(200, 'not json')]],
    [stale, [() => { throw new TypeError('fetch failed'); }]],
  ];
  for (const [token, handlers] of cases) {
    const google = createGoogle({ dir: await seed(t, token), fetch: scriptedFetch(handlers), now: () => NOW });
    await assert.rejects(() => google.gapi('https://example.test/v1/thing'), withCode('google_failed'));
  }
});
