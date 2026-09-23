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
shell. `lib/focus-proxy.mjs` and `lib/brief-adapter.mjs` are stubs: Focus
routes return 503, and the brief routes report an empty state. Phases 2 and 3
replace them. The comment at the top of each file describes what `lib/app.mjs`
expects from it.

## Commands

Requires Node 24 (`.nvmrc`).

- `npm start` runs the server.
- `npm run dev` runs it with `node --watch`.
- `npm test` runs the server tests with Node's test runner. The tests use
  ephemeral ports and temporary directories. They never contact ports 4242 or
  4243, and they never read the real brief directory.
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
