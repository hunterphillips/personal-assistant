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

The LaunchAgent has been installed and Tailscale Serve has pointed at the
dashboard since 2026-09-23. The old brief server on 8765 is retired.
Operations are in [docs/operations.md](docs/operations.md).

## Routes

| Route | Purpose |
| --- | --- |
| `GET /`, `/focus`, `/brief` | The shell. |
| `GET /healthz` | `{"ok": true}` whenever the server is up, whatever Focus and the brief are doing. |
| `GET /api/dashboard/status` | What the shell polls (below). |
| `GET /assets/<name>` | Shell script, styles, and the brief bridge. |
| `GET /embedded/focus`, `/api/focus`, `/api/status`; `PUT /api/focus`; `POST /api/pause`, `/api/resume`, `/api/refresh` | Forwarded to Focus (below). |
| `GET /api/brief/latest` | Latest brief metadata. |
| `GET /embedded/brief/<date>?revision=<revision>` | One brief viewer. |
| `POST /api/brief/feedback` | Saves feedback for one brief. |

`/focus/` and `/brief/` redirect to the paths without the slash. A known path
with the wrong method is 405, and anything else is 404. Errors are JSON bodies of the form
`{"error": "<code>"}`. The comment at the top of each route module describes
what `lib/app.mjs` expects from it.

### Dashboard status

`GET /api/dashboard/status` always answers 200 with

```json
{ "focus": { "available": true }, "brief": { "state": "ready", "date": "2026-09-21", "revision": "<64 hex>" } }
```

`focus.available` is false when Focus does not answer its health check in
time. `brief.state` is `ready`, `empty` (the briefs directory holds no brief),
`unavailable` (the directory cannot be read, or the check timed out), or a
state naming why the latest file cannot be served, such as `unreadable`,
`unsupported`, `incomplete`, or `oversized`. `date` is present when a latest
file was found, and `revision` when it could be hashed. The two checks run in
parallel under a time limit, so a slow Focus cannot hold the answer back for
long. The body never contains brief text.

### Daily Brief

The latest brief is the `viewer-<YYYY-MM-DD>.html` file with the newest date in
the briefs directory. Its revision is the SHA-256 of the file.

`GET /api/brief/latest` returns the same `state`, `date`, and `revision` as the
status route, plus `url` (`/embedded/brief/<date>?revision=<revision>`) when the
state is `ready`. A briefs directory that cannot be read is a 503
`brief_directory_unavailable`.

`GET /embedded/brief/<date>?revision=<revision>` serves that viewer, adapted to
save through the dashboard, with its own CSP. A date that is not a real
calendar date is 404, and a revision that is not 64 lowercase hex characters
is 400. If the file
on disk no longer has that revision, the answer is 409 `revision_conflict`
rather than a different brief; the shell then reads the status again and
offers the newer one.

`POST /api/brief/feedback` takes JSON with exactly these keys:

```json
{ "date": "2026-09-21", "revision": "<64 hex>", "overall": "text",
  "items": [{ "id": "item-id", "mark": "approved", "note": "text" }] }
```

`mark` is `approved`, `dismissed`, or `null`. `items` must name each item in
that brief once. `overall` is capped at 8,000 characters, each note at 4,000,
and the list at 200 items; beyond those it is 413. A revision that no longer
matches the file is 409. On success the server writes
`feedback-<date>.md` beside the viewer, replacing any earlier one for that
date, with one write per date at a time.

### Focus proxy

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

### Routines

`lib/routines.mjs` lists every job named in the agent registry's `routines`.
For each label it reads the plist from `DASHBOARD_LAUNCH_AGENTS_DIR` with
`plutil`, asks `launchctl list` for the last exit status and PID, and takes
the log file's modification time as the last run. Focus scans
(`com.focus.scan-*`) use Focus's `/api/status` instead when Focus answers. The
module only reads: it never loads, starts, or stops a job, and it runs only
when asked.

### Shell

`public/index.html`, `public/shell.js`, and `public/styles.css` make up the
page served at `/`, `/focus`, and `/brief`. The navigation links are ordinary
links; the script switches views with the History API and handles Back and
Forward, and a reload or bookmark opens the same view. Each frame is created
the first time its view opens and stays in the page afterwards, hidden while
another view is shown, so Focus keeps its state and the brief keeps its
unsaved marks. The page has no inline script or style, as the shell CSP
requires.

The script reads `/api/dashboard/status` on every view change and every 30
seconds while the tab is visible, with a 5-second timeout. A frame is created
only from an answer that has just arrived, never from the one kept since the
previous check. What it does with the result:

- Focus not answering: the Focus view says "Focus is not responding." with
  Retry. A frame already open stays; otherwise none is created until Focus
  answers.
- A different brief date or revision than the open frame: "A newer brief is
  available." with "Load newer brief", which reads the status again and loads
  what it names. The open frame stays until that is chosen.
- A brief state other than `ready`: "No brief has been generated yet." for
  `empty`, "The brief for <date> could not be opened." when the status names a
  date, and "The latest brief file could not be read." otherwise. Focus is
  unaffected.
- The status request failing: "The dashboard is not responding." with Retry.

A frame stays hidden until its page loads. If the page comes back as a JSON
error, such as a 409 for a brief replaced under the same date or a 502 from
Focus, the frame stays hidden, the view shows its notice, and the status is
read again at once. Retry reloads that frame.

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
| `DASHBOARD_REGISTRY_PATH` | `../../registry/agents.json` | Agent registry JSON file. Resolved from this directory, not the working directory; does not need to exist at startup. |
| `DASHBOARD_LAUNCH_AGENTS_DIR` | `~/Library/LaunchAgents` | Directory holding launchd plists; does not need to exist at startup. |

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
