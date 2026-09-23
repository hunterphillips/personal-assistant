// Servers for the browser tests. startHub() starts, on ephemeral loopback
// ports only:
//   - an isolated copy of Focus with an invented board (isolated-focus.mjs),
//     or nothing at all when the Focus checkout is missing;
//   - the dashboard app over plain HTTP; and
//   - the same app handler behind HTTPS with a throwaway self-signed
//     certificate, with DASHBOARD_PUBLIC_ORIGIN set to that https origin so
//     its Host and Origin pass the app's checks.
// Briefs live in a new temporary directory and are invented by
// writeBrief(). Nothing here reads the real briefs directory or connects to
// ports 4242 or 4243. stop() closes everything and removes the temporary
// directories.

import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';

import { createApp } from '../../lib/app.mjs';
import { createBriefRoutes } from '../../lib/brief-adapter.mjs';
import { loadConfig } from '../../lib/config.mjs';
import { createFocusProxy } from '../../lib/focus-proxy.mjs';
import { closeServer, freePort, listen } from './harness.mjs';
import { focusSourceAvailable, startIsolatedFocus } from './isolated-focus.mjs';

const FORBIDDEN_PORTS = new Set([4242, 4243]);

export { focusSourceAvailable };

export async function startHub({ withFocus = true } = {}) {
  const cleanups = [];
  const context = { after: (fn) => cleanups.push(fn) };
  const stop = async () => {
    while (cleanups.length > 0) await cleanups.pop()().catch(() => {});
  };

  try {
    const root = await mkdtemp(path.join(os.tmpdir(), 'dashboard-browser-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const briefsDir = path.join(root, 'briefs');
    await mkdir(briefsDir);

    const focus = withFocus && focusSourceAvailable() ? await startIsolatedFocus(context) : null;
    const focusOrigin = focus?.origin ?? `http://127.0.0.1:${await freePort()}`;

    const certificate = await selfSignedCertificate(root);
    const plain = http.createServer();
    const secure = https.createServer(certificate);
    const plainPort = await listen(plain);
    cleanups.push(() => closeServer(plain));
    const securePort = await listen(secure);
    cleanups.push(() => closeServer(secure));
    for (const port of [plainPort, securePort, Number(new URL(focusOrigin).port)]) {
      if (FORBIDDEN_PORTS.has(port)) throw new Error(`refusing to use port ${port}`);
    }

    const config = loadConfig({
      DASHBOARD_PORT: String(plainPort),
      DASHBOARD_PUBLIC_ORIGIN: `https://localhost:${securePort}`,
      DASHBOARD_BRIEFS_DIR: briefsDir,
      DASHBOARD_FOCUS_ORIGIN: focusOrigin,
    });
    const handler = createApp({
      config,
      focus: createFocusProxy(config),
      brief: createBriefRoutes(config),
      log: () => {},
    });
    plain.on('request', handler);
    secure.on('request', handler);

    return {
      origin: `http://127.0.0.1:${plainPort}`,
      secureOrigin: `https://localhost:${securePort}`,
      briefsDir,
      focus,
      writeBrief: (date, options) => writeFile(path.join(briefsDir, `viewer-${date}.html`), inventedViewer({ date, ...options })),
      writeRawBrief: (date, html) => writeFile(path.join(briefsDir, `viewer-${date}.html`), html),
      readFeedback: (date) => readFile(path.join(briefsDir, `feedback-${date}.md`), 'utf8'),
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}

async function selfSignedCertificate(root) {
  const dir = path.join(root, 'tls');
  await mkdir(dir, { mode: 0o700 });
  const key = path.join(dir, 'key.pem');
  const cert = path.join(dir, 'cert.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=localhost', '-days', '1',
    '-keyout', key, '-out', cert,
  ], { stdio: 'ignore' });
  return { key: await readFile(key), cert: await readFile(cert) };
}

export const DEFAULT_ITEMS = Object.freeze([
  { sec: 'Needs you', id: 'invented-one', text: 'Invented item one.' },
  { sec: 'Needs you', id: 'invented-two', text: 'Invented item two.' },
  { sec: 'Later', id: 'invented-three', text: 'Invented item three.' },
]);

// An invented viewer in the generated layout the adapter accepts: one inline
// script, ITEMS then KEY, marks kept in localStorage under KEY, and a fixed
// bar with Save, Copy, and Clear. Its own saveOut downloads a file, so a
// download during a test means the bridge did not take over Save. The page
// is taller than any test viewport so its own scrolling is exercised.
export function inventedViewer({ date, items = DEFAULT_ITEMS, heading = `Daily Brief — ${date}` }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${heading}</title>
<style>
body { margin: 0; font-family: Georgia, serif; }
.page { padding: 16px 16px 140px; }
.item { min-height: 320px; padding: 12px 0; border-bottom: 1px solid #ddd; }
.item button[aria-pressed="true"] { font-weight: 700; }
.bar { position: fixed; left: 0; right: 0; bottom: 0; display: flex; flex-wrap: wrap; gap: 8px; padding: 10px 16px; background: #fff; border-top: 1px solid #ccc; }
</style>
</head>
<body>
<div class="page">
  <h1>${heading}</h1>
  <div id="brief"></div>
  <div class="overall"><textarea id="overall" rows="3" aria-label="Overall"></textarea></div>
</div>
<div class="bar">
  <span id="status">No marks yet</span>
  <button class="save" onclick="saveOut()">Save feedback</button>
  <button class="ghost" onclick="copyOut()">Copy instead</button>
  <button class="ghost" onclick="clearAll()">Clear</button>
</div>
<script>
const ITEMS = ${JSON.stringify(items)};
const KEY = 'db-items-${date}';
let fb = {};
try { fb = JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { fb = {}; }
function persist() {
  try { localStorage.setItem(KEY, JSON.stringify(fb)); } catch (e) {}
  const count = Object.keys(fb).filter(function (id) { return fb[id] && fb[id].m; }).length;
  document.getElementById('status').textContent = count ? count + ' marked' : 'No marks yet';
}
function mark(id, m) {
  const value = Object.assign({}, fb[id]);
  value.m = value.m === m ? null : m;
  fb[id] = value;
  persist();
  render();
}
function render() {
  document.getElementById('brief').innerHTML = ITEMS.map(function (item) {
    const m = fb[item.id] && fb[item.id].m;
    return '<div class="item" data-id="' + item.id + '"><p>' + item.text + '</p>' +
      '<button data-mark="a" aria-pressed="' + (m === 'a') + '" onclick="mark(\\'' + item.id + '\\', \\'a\\')">Approve</button> ' +
      '<button data-mark="d" aria-pressed="' + (m === 'd') + '" onclick="mark(\\'' + item.id + '\\', \\'d\\')">Dismiss</button></div>';
  }).join('');
}
function saveOut() {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([JSON.stringify(fb)], { type: 'text/markdown' }));
  link.download = 'feedback-${date}.md';
  document.body.appendChild(link);
  link.click();
  link.remove();
}
function copyOut() {}
function clearAll() { fb = {}; persist(); render(); }
render();
persist();
</script>
</body>
</html>
`;
}
