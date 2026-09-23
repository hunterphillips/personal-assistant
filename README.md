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
response headers, body limits, `/healthz`, `/api/status`, and a placeholder
shell. Phase 2 replaced the Focus stub with a proxy (below).
`lib/brief-adapter.mjs` is still a stub that reports an empty state; phase 3
replaces it. The comment at the top of each route module describes what
`lib/app.mjs` expects from it.

### Focus proxy (phase 2)

`lib/focus-proxy.mjs` forwards two fixed routes to `DASHBOARD_FOCUS_ORIGIN`:
`/embedded/focus` to Focus's `GET /`, and `GET`/`PUT /api/focus` to
`/api/focus`. Focus's page fetches the absolute path `/api/focus`, so it works
unchanged inside the frame. The page is served with its own CSP that allows its
inline code and Google Fonts.

Upstream requests carry Host set to the Focus authority and only the JSON
content headers; cookies, credentials, hop-by-hop headers, Origin, and Referer
stay behind. Focus's own responses, including validation errors, pass through
with their status, content type, and body. Failures are JSON errors: refusal,
redirects, and responses over 2 MiB (HTML) or 4 MiB (JSON) are 502; no response
within 10 seconds is 504. A PUT is never retried. A PUT that times out after its
body was sent returns `upstream_timeout_uncertain`, because Focus may have
committed it.

The shell shows the Focus frame on every view until phase 4 adds view
switching. The write tests run the real Focus server from a temporary copy with
an invented board in a throwaway Git repository (`test/support/isolated-focus.mjs`);
they skip when the Focus checkout is missing.

## Commands

Requires Node 24 (`.nvmrc`).

- `npm start` runs the server.
- `npm run dev` runs it with `node --watch`.
- `npm test` runs the server tests with Node's test runner. The tests use
  ephemeral ports and temporary directories. They never contact ports 4242 or
  4243, never write to the real Focus board, and never read the real brief
  directory.
- `npm run check` syntax-checks every `.mjs` and `.js` file. It also confirms
  that each `/assets/<name>` in `public/index.html` is listed in
  `lib/assets.mjs` and exists in `public/`.

`@playwright/test` is a pinned dev dependency for the browser tests in phase 4.
Its browsers are not installed yet.

## Configuration

| Variable | Default | Notes |
| --- | --- | --- |
| `DASHBOARD_PORT` | `4243` | Startup fails if the port is taken. |
| `DASHBOARD_PUBLIC_ORIGIN` | unset | The tailnet `https://` origin. When set, its host is accepted as a Host header and it is accepted as an Origin. When unset, only `127.0.0.1:<port>` and `localhost:<port>` are accepted. |
| `DASHBOARD_BRIEFS_DIR` | `../../daily-brief/briefs` | Resolved from this directory, not the working directory. |
| `DASHBOARD_FOCUS_ORIGIN` | `http://127.0.0.1:4242` | Must be an `http://` loopback origin other than `127.0.0.1:<DASHBOARD_PORT>`. |

The server always binds `127.0.0.1`. PUT and POST requests must send JSON and
an `Origin` that matches the request's Host. Focus request bodies are capped at
1,000,000 bytes and feedback at 128 KiB. An oversized body gets a 413 as soon
as the limit is crossed, with `Connection: close`; the server then discards at
most 2 MiB more of the upload, for at most 2 seconds, before cutting the
connection. Logs record method, route, status, and duration; a response that
never completed is logged with status 0. They never contain request bodies or
brief text.

Real briefs, contributions, and feedback contain personal data. They stay in
`daily-brief/` and never enter this repository.
