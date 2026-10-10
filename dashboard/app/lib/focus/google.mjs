// Google: read-only OAuth-backed access to Gmail and Calendar.
// createGoogle({ dir, fetch, now, log }) returns a frozen client with token
// presence, one authenticated GET, a bounded page collector, and an explicit
// refresh. It reads client.json and token.json under dir and only rewrites the
// token after a refresh; it never requests a write-capable Google scope.

import {
  chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';

export const SCOPES = Object.freeze([
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/calendar.readonly',
]);

export const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const TOKEN_URL = 'https://oauth2.googleapis.com/token';

const EXPIRY_SKEW_MS = 5 * 60 * 1000;

export function googlePaths(dir) {
  return Object.freeze({
    client: path.join(dir, 'client.json'),
    token: path.join(dir, 'token.json'),
  });
}

function readJson(file, what) {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    throw new Error(`google: no ${what} file at ${file} — run bin/focus-google-auth`);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`google: ${what} file at ${file} is not JSON: ${error.message}`);
  }
}

export function readGoogleClient(dir) {
  const { client } = googlePaths(dir);
  const document = readJson(client, 'client');
  const credentials = document.installed || document.web || document;
  if (!credentials.client_id || !credentials.client_secret) {
    throw new Error(`google: client file at ${client} has no client_id/client_secret`);
  }
  return Object.freeze({
    client_id: credentials.client_id,
    client_secret: credentials.client_secret,
  });
}

export function readGoogleToken(dir) {
  return readJson(googlePaths(dir).token, 'token');
}

export function writeGoogleToken(dir, token) {
  const { token: file } = googlePaths(dir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify(token, null, 2)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return token;
}

export async function requestGoogleToken(params, { fetch = globalThis.fetch, signal } = {}) {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
    signal,
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`google: token request failed (${response.status}): ${body}`);
  try {
    return JSON.parse(body);
  } catch (error) {
    throw new Error(`google: token response is not JSON: ${error.message}`);
  }
}

export function createGoogle({ dir, fetch = globalThis.fetch, now = Date.now, log: rawLog = () => {} }) {
  const paths = googlePaths(dir);
  const time = () => (typeof now === 'function' ? now() : now);
  const log = (entry) => {
    try {
      rawLog(entry);
    } catch {
      // Logging cannot turn a successful refresh into a failed scan.
    }
  };

  function hasToken() {
    return existsSync(paths.token);
  }

  async function refresh({ signal } = {}) {
    const token = readGoogleToken(dir);
    if (!token.refresh_token) {
      throw new Error(`google: token file at ${paths.token} has no refresh_token — run bin/focus-google-auth`);
    }
    const { client_id, client_secret } = readGoogleClient(dir);
    const data = await requestGoogleToken(
      { client_id, client_secret, refresh_token: token.refresh_token, grant_type: 'refresh_token' },
      { fetch, signal },
    );
    const next = {
      ...token,
      access_token: data.access_token,
      token_type: data.token_type ?? token.token_type ?? 'Bearer',
      scope: data.scope ?? token.scope,
      expires_at: new Date(time() + (Number(data.expires_in) || 3600) * 1000).toISOString(),
    };
    writeGoogleToken(dir, next);
    log({ event: 'focus_google_refreshed' });
    return next.access_token;
  }

  async function accessToken({ force = false, signal } = {}) {
    if (force) return refresh({ signal });
    const token = readGoogleToken(dir);
    const expiresAt = Date.parse(token.expires_at ?? '');
    if (token.access_token && Number.isFinite(expiresAt) && expiresAt - time() > EXPIRY_SKEW_MS) {
      return token.access_token;
    }
    return refresh({ signal });
  }

  async function gapi(url, params = {}, { signal } = {}) {
    const target = buildUrl(url, params);
    const get = (token) => fetch(target.toString(), {
      headers: { authorization: `Bearer ${token}` },
      signal,
    });

    let response = await get(await accessToken({ signal }));
    if (response.status === 401) response = await get(await accessToken({ force: true, signal }));
    const body = await response.text();
    if (!response.ok) {
      throw new Error(`google: GET ${target.pathname} failed (${response.status}): ${body.slice(0, 500)}`);
    }
    try {
      return JSON.parse(body);
    } catch (error) {
      throw new Error(`google: GET ${target.pathname} returned non-JSON: ${error.message}`);
    }
  }

  // Google list endpoints used by Focus have one top-level array. Remember its
  // name from the first page so later pages cannot accidentally change shape.
  async function gapiPages(url, params = {}, { maxPages = 1, signal } = {}) {
    const out = [];
    let pageToken;
    let collectionKey = null;
    for (let page = 0; page < maxPages; page += 1) {
      const data = await gapi(url, { ...params, pageToken }, { signal });
      if (collectionKey === null) {
        const arrays = Object.keys(data).filter((key) => Array.isArray(data[key]));
        if (arrays.length !== 1) {
          throw new Error(`google: GET ${new URL(url).pathname} returned ${arrays.length} collection fields`);
        }
        [collectionKey] = arrays;
      }
      if (!Array.isArray(data[collectionKey])) {
        throw new Error(`google: GET ${new URL(url).pathname} omitted collection ${collectionKey}`);
      }
      out.push(...data[collectionKey]);
      pageToken = data.nextPageToken;
      if (!pageToken) break;
    }
    return out;
  }

  return Object.freeze({ hasToken, gapi, gapiPages, refresh });
}

function buildUrl(url, params) {
  const target = new URL(url);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) target.searchParams.append(key, String(item));
    } else {
      target.searchParams.set(key, String(value));
    }
  }
  return target;
}
