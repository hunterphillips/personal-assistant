# Dashboard app

A local Node server that will become the single private entry point for Focus
and the Daily Brief. It listens on `127.0.0.1:4243`; Tailscale serves it to the
tailnet over HTTPS. The page is a shell with Home, Focus, and Daily Brief
views. Focus runs in an iframe through a proxy to its own server. Briefs are
read from `daily-brief/briefs/`, and feedback is saved beside them.

The plan is
`thoughts/shared/plans/2026-09-22-dashboard-integrated-hub-implementation.md`
in the umbrella directory.

## Status

Phase 1 is done: configuration, the route table, Host and Origin checks,
response headers, body limits, `/healthz`, `/api/dashboard/status`, and a placeholder
shell. Phase 2 replaced the Focus stub with a proxy (below). Phase 3 serves the
latest Daily Brief and saves its feedback. Phase 4 adds the shell (below). The
comment at the top of each route module describes what `lib/app.mjs` expects
from it.

Installing the LaunchAgent and the Tailscale cutover are in
[docs/operations.md](docs/operations.md).

### Focus proxy (phase 2)

`lib/focus-proxy.mjs` forwards a fixed set of routes to
`DASHBOARD_FOCUS_ORIGIN`, each to one upstream path. Nothing else is forwarded.

| Dashboard route | Focus route |
| --- | --- |
| `GET /embedded/focus` | `GET /` |
| `GET`, `PUT /api/focus` | same |
| `GET /api/status` | same |
| `POST /api/pause`, `/api/resume`, `/api/refresh` | same |

Focus's page calls these API paths as absolute paths, so inside the frame they
arrive at the dashboard, which forwards them. Its pause, resume, and refresh
buttons reach Focus this way. The dashboard's own status is at
`/api/dashboard/status`, which leaves `/api/status` to Focus. The page is
served with its own CSP that allows its inline code and Google Fonts.

The three control POSTs need the same exact `Origin` as other mutations but no
content type, and must have no body: a declared body gets 413 and a chunked one
gets 400.

Upstream requests carry Host set to the Focus authority and only the JSON
content headers; cookies, credentials, hop-by-hop headers, Origin, and Referer
stay behind. Focus's own responses, including validation errors, pass through
with their status, content type, and body. Failures are JSON errors: refusal,
a truncated response, redirects, and responses over 2 MiB (HTML) or 4 MiB
(JSON) are 502; no response within 10 seconds is 504. A PUT or POST is never
retried. One that times out after it was sent whole returns
`upstream_timeout_uncertain`, because Focus may have acted on it. A PUT
succeeds only when its body reached Focus whole; if Focus answers first, the
dashboard does not pass that answer on.

The write tests run the real Focus server from a temporary copy with
an invented board in a throwaway Git repository (`test/support/isolated-focus.mjs`);
they skip when the Focus checkout is missing.

### Shell (phase 4)

`public/index.html`, `public/shell.js`, and `public/styles.css` make up the
page served at `/`, `/focus`, and `/brief`. The navigation links are ordinary
links; the script switches views with the History API and handles Back and
Forward, and a reload or bookmark opens the same view. Each frame is created
the first time its view opens and stays in the page afterwards, hidden while
another view is shown, so Focus keeps its state and the brief keeps its
unsaved marks. The page has no inline script or style, as the shell CSP
requires.

The script reads `/api/dashboard/status` on every view change and every 30
seconds while the tab is visible, with a 5-second timeout. What it does with
the result:

- Focus not answering: the Focus view says "Focus is not responding." with
  Retry. A frame already open stays; otherwise none is created until Focus
  answers.
- A different brief date or revision than the open frame: "A newer brief is
  available." with "Load newer brief". The open frame stays until that is
  chosen.
- A brief state other than `ready`: "No brief has been generated yet." for
  `empty`, and "The latest brief file could not be read." for every other
  state. Focus is unaffected.
- The status request failing: "The dashboard is not responding." with Retry.

Wide screens get a navigation column; below 720px it becomes a row across the
top. The page is exactly one screen tall and each frame fills the rest, so the
child page does its own scrolling and keeps its fixed bar in view.

## Commands

Requires Node 24 (`.nvmrc`).

- `npm start` runs the server.
- `npm run dev` runs it with `node --watch`.
- `npm test` runs the server tests with Node's test runner. The tests use
  ephemeral ports and temporary directories. They never contact ports 4242 or
  4243, never write to the real Focus board, and never read the real brief
  directory.
- `npm run test:browser` runs the Playwright tests in `test/browser/` in
  desktop Chromium and in WebKit at an iPhone 13 size (390px wide, touch
  events on). Emulation does not test real touch hardware. Each test starts
  its own isolated Focus copy, the app over HTTP, and the same app over HTTPS
  with a throwaway self-signed certificate, all on ephemeral ports, with
  invented brief viewers in a temporary directory
  (`test/support/browser-server.mjs`). Only the HTTPS test's browser context
  accepts that certificate. Requests to any other host are blocked, and a CSP
  violation fails the test. Output goes to the ignored `test-results/`.
  Install the browsers once with `npx playwright install chromium webkit`.
- `npm run check` syntax-checks every `.mjs` and `.js` file. It also confirms
  that each `/assets/<name>` in `public/index.html` is listed in
  `lib/assets.mjs` and exists in `public/`.

Still checked by hand: dragging to reorder in Focus, keyboard focus
visibility, scrolling inside the frames, and a real phone after cutover.

## Configuration

| Variable | Default | Notes |
| --- | --- | --- |
| `DASHBOARD_PORT` | `4243` | Startup fails if the port is taken. |
| `DASHBOARD_PUBLIC_ORIGIN` | unset | The tailnet `https://` origin. When set, its host is accepted as a Host header and it is accepted as an Origin. When unset, only `127.0.0.1:<port>` and `localhost:<port>` are accepted. |
| `DASHBOARD_BRIEFS_DIR` | `../../daily-brief/briefs` | Resolved from this directory, not the working directory. |
| `DASHBOARD_FOCUS_ORIGIN` | `http://127.0.0.1:4242` | Must be an `http://` loopback origin other than `127.0.0.1:<DASHBOARD_PORT>`. |

The server always binds `127.0.0.1`. PUT and POST requests must send an
`Origin` that matches the request's Host, and JSON unless they are one of the
bodyless Focus controls. Focus request bodies are capped at
1,000,000 bytes and feedback at 128 KiB. An oversized body gets a 413 as soon
as the limit is crossed, with `Connection: close`; the server then discards at
most 2 MiB more of the upload, for at most 2 seconds, before cutting the
connection. Logs record method, route, status, and duration; a response that
never completed is logged with status 0. They never contain request bodies or
brief text.

Real briefs, contributions, and feedback contain personal data. They stay in
`daily-brief/` and never enter this repository.
