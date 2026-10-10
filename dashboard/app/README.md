# Dashboard app

The assistant daemon and the tailnet-only hub it serves. A local Node server
on `127.0.0.1:4243`; Tailscale serves it to the tailnet over HTTPS. The page
is a shell with a rail of six views. Home is the Agents view at `/`; Feed
lists what the producers found; Focus and Goals are their own views;
Ideas lists the week's suggestions; Health lists the launchd jobs. The
Daily Brief opens from the header as an overlay over any view. Personas
run on the Claude Agent SDK, Codex threads are observed on a shared
app-server, and cmux terminals are listed with their state.
Focus runs in an iframe through a proxy to its own server. Briefs are read
from `briefs/` in the data root, and feedback is saved beside them.

Everything the daemon and the producers write lives in the data root,
`~/.personal-assistant/` or the absolute path `PERSONAL_ASSISTANT_HOME`
names, never in the repository: the registry, routines, threads,
settings, notifications, the Feed and Ideas stores and their criteria,
and the briefs. `docs/root-README.md` is its layout, copied into the root
as `README.md`; `docs/operations.md` covers the start and the move.

The plan is
`thoughts/shared/plans/2026-09-25-dashboard-assistant-daemon-implementation.md`
in the umbrella directory; Phases 1 to 4 shipped by 2026-09-28.

## Status

The LaunchAgent has been installed and Tailscale Serve has pointed at the
dashboard since 2026-09-23. The old brief server on 8765 is retired.
Operations are in [docs/operations.md](docs/operations.md).

## Routes

| Route | Purpose |
| --- | --- |
| `GET /`, `/agents`, `/focus`, `/brief`, `/feed`, `/goals`, `/ideas`, `/health` | The shell. `/` and `/agents` show the Agents view; `/feed` shows the Feed, `/brief` the Feed with the brief's overlay open, and `/health` shows Health. |
| `GET /routines`, `/routines/` | 302 to `/health`, keeping the query. Kept for one release while the jobs move from Agents to Health. |
| `GET /reading`, `/reading/` | 302 to `/feed`, keeping the query. Reading became the Feed when the brief moved to the overlay. |
| `GET /healthz` | `{"ok": true}` whenever the server is up, whatever Focus and the brief are doing. |
| `GET /api/state` | Checks Focus and the brief, then returns the state hub's snapshot (below). |
| `GET /api/events` | Server-Sent Events: the snapshot, then each change (below). |
| `POST /api/jobs/refresh` | Re-reads the jobs and answers `{"ok": true, "revision": N}`. |
| `GET /api/dashboard/status` | Focus and brief status (below). The shell no longer reads it; kept for one release. |
| `GET /assets/<name>` | Shell scripts and styles. |
| `GET /embedded/focus`, `/api/focus`, `/api/status`; `PUT /api/focus`; `POST /api/pause`, `/api/resume`, `/api/refresh` | Forwarded to Focus (below). |
| `POST /api/focus/changes` | Applies one change to the native Focus board and returns the fresh board. |
| `GET /api/focus/candidates` | The native Focus board's considered candidates and their current verdicts. |
| `GET /api/focus/instructions` | The native Focus board's rules, read as prose. |
| `POST /api/focus/instructions/propose` | Sends a rules change to the default agent. |
| `GET /api/brief/latest` | The newest brief as data (below). |
| `POST /api/brief/read` | Bodyless. Marks the newest brief read, so `brief.unread` in the snapshot goes false everywhere; `{"ok": true}` even when there is no ready brief to mark (below). |
| `GET /api/brief/<date>` | One date's brief as data. |
| `GET /api/brief/<date>/feedback` | The feedback saved for that date, or an empty draft. |
| `POST /api/brief/feedback` | Saves feedback for one brief. |
| `GET /api/brief/instructions` | The brief's rules file, read as prose (below). |
| `POST /api/brief/instructions/propose` | Sends a change to the rules to the agent Settings names as receiving the brief; 202 `{"ok": true, "agentId": "<id>"}` once the turn has started (below). |
| `POST /api/agents/<id>/send` | Sends `{"text": "...", "mentions": [...], "context": {...}}` to a persona (`mentions`, the agent ids the text names with @, and `context`, what quick chat sends along, are optional); 202 once the turn has started (below). |
| `POST /api/agents/<id>/answer` | Answers the persona's open question or approval, or a request forwarded to this thread (raised by another agent while answering a delegation that started here; the owner's adapter settles it). |
| `POST /api/agents/<id>/interrupt` | Stops the persona's turn. |
| `POST /api/agents/<id>/new-thread` | Starts the persona on a new session. |
| `POST /api/agents/<id>/model` | Sets the model and effort the persona's thread runs on: `{"model": "sonnet"}`, `{"effort": "low"}`, or both; null for a key returns it to the agent's default (below). |
| `GET /api/agents/<id>/thread` | The persona's cached messages. |
| `GET /api/agents/<id>/avatar` | The agent's picture with its content type and `Cache-Control: no-cache`, for an agent of any kind; 404 `no_avatar` when it has none, 404 `no_such_agent` for an id the registry does not list (Avatars, below). |
| `PUT /api/agents/<id>/settings` | Rewrites a persona's registry entry (name, role, group, description, folder, model, effort, permission level, who may message it, pinned) and answers the stored entry (below). |
| `POST /api/agents` | Adds a Claude persona to the registry from the same fields plus `id`; 201 with the stored entry (below). |
| `DELETE /api/agents/<id>` | Removes a persona from the registry with its routines and their runs logs; its thread stays on disk (below). |
| `POST /api/sessions/<id>/answer` | Answers a Codex thread's open question or approval (below). |
| `POST /api/sessions/<id>/interrupt` | Stops the Codex thread's running turn. |
| `GET /api/sessions/<id>/thread` | The Codex thread's recent messages, read from the app-server. |
| `POST /api/sessions/<id>/open-terminal` | Brings the session's recorded cmux terminal to the front. |
| `POST /api/sessions/refresh` | Re-reads the cmux inventory and the Codex catalogue now and answers `{"ok": true, "revision": N}`. |
| `GET /api/goals` | Priorities and goal notes read from the vault (below). |
| `POST /api/goals/propose` | Sends a new goal or a change to one to the second-brain persona; 202 `{"ok": true, "agentId": "second-brain"}` once the turn has started (below). |
| `GET /api/feeds` | The feeds, newest first: `{"feeds", "problems"}` (below). |
| `POST /api/feeds` | Creates a feed from `{"name", "note"}` and starts a suggestion run; 201 `{"ok": true, "feed", "suggesting"}`. |
| `GET /api/feeds/<id>` | The feed's runs and posts, newest first (below). |
| `PUT /api/feeds/<id>` | Changes any of `name`, `sources`, and `active`; `{"ok": true, "feed"}`. |
| `GET /api/feeds/<id>/note` | The feed's instructions: `{"text", "updated"}`. |
| `PUT /api/feeds/<id>/note` | Writes the instructions from `{"text"}`; `{"ok": true, "text", "updated"}`. |
| `POST /api/feeds/<id>/save`, `/unsave`, `/dismiss` | Marks one post from `{"id"}` and answers the fresh read. |
| `GET /api/feeds/<id>/suggestions` | The producer's suggested sources: `{"suggesting", "suggestions"}` (below). |
| `POST /api/feeds/<id>/suggest` | Starts a suggestion run; 202 `{"ok": true, "suggesting": true}` (below). |
| `POST /api/feeds/<id>/discuss` | Sends one post to the feed's producer; 202 `{"ok": true, "agentId"}` once the turn has started (below). |
| `GET /api/sources` | The sources, by name: `{"sources", "problems"}` (below). |
| `POST /api/sources` | Adds a source; 201 `{"ok": true, "source"}`. |
| `PUT /api/sources/<id>` | Changes any of `name`, `aliases`, `active`, `default`, and the kind's field; `{"ok": true, "source"}`. |
| `DELETE /api/sources/<id>` | Removes a source no feed lists; 409 `in_use` with `feeds` otherwise. |
| `POST /api/sources/discover` | `{"url"}`: the RSS or Atom feed the site links, or the address itself when it is a feed; `{"feed"}` or `{"feed": null}`. Writes nothing. |
| `GET /api/ideas` | The Ideas runs, marks, and producing agent, newest first, with `routine`: the id of the producer's ideas routine (its first routine whose instruction or name contains "ideas"), or null. The New ideas action runs it through `POST /api/routines/:id/run`. |
| `POST /api/ideas` | Adds a manual idea and returns the fresh Ideas store. |
| `POST /api/ideas/dismiss` | Dismisses an idea and returns the fresh Ideas store. |
| `POST /api/ideas/save` | Saves an idea that has not been started and returns the fresh Ideas store. |
| `POST /api/ideas/unsave` | Removes an idea's saved mark and returns the fresh Ideas store. |
| `POST /api/ideas/start` | Starts the pinned agent on an idea, marks it taken, and returns the fresh Ideas store. |
| `POST /api/ideas/refresh` | `{ "week": "YYYY-MM-DD" }`, a Monday. Refuses 503 `shutting_down`, 404 `no_routine`, 409 `busy`, or 409 `agent_unavailable` before writing anything; then marks the week's new produced ideas `replaced` (saved, taken, and manual ones stay) and runs the producer's ideas routine with a context naming the week and its saved titles. 202 `{ ok, replaced, ideas }`; a run the scheduler still refuses answers its refusal with `ideas`, the fresh store. |
| `GET /api/ideas/instructions` | The Ideas criteria, read as prose. |
| `POST /api/ideas/instructions/propose` | Sends a criteria change to the newest listed producer. |
| `PUT /api/settings` | Saves a partial patch of the settings (default model and effort, which agent receives the brief, which agent quick chat opens on, the default permission level) and answers the whole document (below). |
| `GET /api/routines` | The routines as the snapshot lists them (below). |
| `POST /api/routines` | Adds a routine from `{"name", "agent", "instruction", "schedule", "active"}`, `schedule` a cron line; 201 with the stored routine (below). |
| `PUT /api/routines/<id>` | Rewrites a routine from the same five keys and answers it. |
| `DELETE /api/routines/<id>` | Removes the routine and its runs log; `{"ok": true}`. |
| `GET /api/routines/<id>/runs` | The routine's newest ten runs, newest first (below). |
| `POST /api/routines/<id>/run` | Runs the routine now, outside its schedule; bodyless, or `{ "context": "<text>" }` (1 to 2000 characters, trimmed) added to the run's prompt after the instruction, any other body 400 `invalid_body`; 202 once the turn has started, 409 `busy` or `agent_unavailable` when it cannot (below). |
| `GET /api/notifications` | The notifications as the snapshot carries them: `{"open", "items"}` (below). |
| `POST /api/notifications/<id>/acknowledge` | Bodyless. Acknowledges one; `{"ok": true, "acknowledged": 1}`, or `0` when it already was; 404 `no_such_notification` when the store no longer keeps it. |
| `POST /api/notifications/acknowledge` | Bodyless. Acknowledges every open one; `{"ok": true, "acknowledged": <n>}`. |

`/focus/`, `/brief/`, `/feed/`, `/agents/`, `/goals/`, and `/health/` redirect to the
paths without the slash. A known path
with the wrong method is 405, and anything else is 404. Errors are JSON bodies of the form
`{"error": "<code>"}`. The comment at the top of each route module describes
what `lib/app.mjs` expects from it.

### Modules

- `lib/app.mjs` routes requests, checks Host and Origin, logs, and serves the shell, assets, health, status, state, and jobs refresh.
- `lib/agent-routes.mjs` serves the persona routes under `/api/agents/` and the session routes under `/api/sessions/`.
- `lib/goals-routes.mjs` serves the Goals routes over `lib/goals.mjs`, which reads the vault.
- `lib/routine-routes.mjs` serves the routine routes over `lib/routines.mjs`, the routine files and their runs logs, and `lib/schedule.mjs`, the cron subset and its occurrences in Chicago time; `lib/scheduler.mjs` runs them.
- `lib/notification-routes.mjs` serves the notification routes over `lib/notifications.mjs`, the notifications file.
- `lib/feed-routes.mjs` serves the feed routes over `lib/feeds.mjs`, the feed folders, and `lib/source-routes.mjs` the source routes over `lib/sources.mjs`, the source files.
- `lib/ideas-routes.mjs` serves Ideas over `lib/ideas.mjs` and `ideas/criteria.md`; `ideasRoutine()` finds the producer's ideas routine.
- `lib/brief-instructions.mjs` reads the brief's rules file and serves the two routes under `/api/brief/instructions`; `lib/instructions.mjs` is the prose reader the brief's rules and the Ideas criteria share, and `lib/instructions-routes.mjs` their two routes.
- `lib/events.mjs` serves `/api/events` and closes the streams at shutdown.
- `lib/http.mjs` holds the response, error, and request-body helpers the route modules share.
- `lib/focus-proxy.mjs` forwards the Focus routes.
- `lib/brief-adapter.mjs` serves the brief routes over `lib/briefs.mjs` and `lib/feedback.mjs`.
- `lib/hub.mjs` keeps the state snapshot and its subscribers.
- `lib/builtins.mjs` seeds the built-in agents from `registry/builtin.json` at start and picks the agent a setting falls to.
- `lib/avatars.mjs` finds an agent's picture in its folder or at its registry `avatar` path; `public/avatar.js` draws it, or the agent's initials, wherever an agent is named.
- `lib/registry.mjs` and `lib/jobs.mjs` read the agent registry and its launchd jobs; `lib/launchd.mjs` renders the plist for `bin/dashboard-install`.
- `lib/threads.mjs` and `lib/runtime/` hold the persona thread files, the two runtime adapters (`claude.mjs` runs personas, `codex.mjs` follows the shared Codex app-server's threads), and the cmux client (`cmux.mjs`).
- `lib/bindings.mjs` reads the terminal bindings `bin/codex-new` records.
- `lib/config.mjs` and `lib/assets.mjs` hold configuration and the asset allowlist.

`lib/root.mjs` prepares the data root before any store starts: it claims
`daemon.lock`, moves the data the checkout at `DASHBOARD_MIGRATE_FROM` holds
into a root without `layout.json` once, renaming each source to
`.migrated`, seeds the criteria files from `defaults/` and the root's
`README.md` from `docs/root-README.md`, and writes `layout.json` last.
`lib/layout.mjs` holds the layout table, which `lib/config.mjs` derives
every store default from.

### Dashboard status

`GET /api/dashboard/status` always answers 200 with

```json
{ "focus": { "available": true }, "brief": { "state": "ready", "date": "2026-09-21", "revision": "<64 hex>" } }
```

`focus.available` is false when Focus does not answer its health check in
time. `brief.state` is `ready`, `empty` (the briefs directory holds no brief),
`unavailable` (the directory cannot be read, or the check timed out),
`missing` (the newest date has a viewer page but no `brief-<date>.json`), or
a state naming why the latest file cannot be served, such as `unreadable`,
`unsupported`, or `oversized`. `date` is present when a latest
file was found, and `revision` when it could be hashed. The two checks run in
parallel under a time limit, so a slow Focus cannot hold the answer back for
long. The body never contains brief text.

The status route now asks the state hub for a refresh and answers from its
snapshot; concurrent requests share one check. It stays for one release.

### State and events

`lib/hub.mjs` keeps one snapshot in memory:

```json
{ "revision": 7, "updatedAt": "<ISO>", "home": "/Users/hunter",
  "focus": { "available": true, "native": true, "updated": "<ISO>" },
  "brief": { "state": "ready", "date": "2026-09-21", "revision": "<64 hex>", "unread": false },
  "registry": { "ok": true, "error": null, "loadedAt": "<ISO>" },
  "groups": [{ "id": "work", "name": "Work" }, { "id": "personal", "name": "Personal" }],
  "agents": [{ "id": "cfo", "name": "CFO", "role": "Money", "description": "...", "group": "work", "kind": "persona",
               "cwd": "/Users/hunter/workspace/work/investing/cfo", "jobs": 1, "avatar": "1759622400000", "provider": "claude",
               "state": "idle", "pending": null, "forwarded": [], "needsYou": false, "lastMessage": { "role": "assistant", "text": "...", "at": "<ISO>" },
               "lastError": null, "costUsd": 0.42, "lastLineAt": null, "model": { "id": "opus", "effort": null, "source": "agent", "default": { "id": "opus", "effort": null }, "agent": { "id": "opus", "effort": null } },
               "permission": { "level": "full", "source": "agent", "agent": "full", "default": "ask" }, "accepts": null },
             { "id": "assistant", "name": "Assistant", "role": "Assistant", "description": "...", "group": "personal", "kind": "persona",
               "cwd": "/Users/hunter/workspace/personal-assistant", "jobs": 1, "avatar": null, "provider": "claude", "pinned": true,
               "state": "idle", "pending": null, "forwarded": [], "needsYou": false, "lastMessage": null, "lastError": null, "costUsd": null, "lastLineAt": null,
               "model": { "id": null, "effort": null, "source": "default", "default": { "id": null, "effort": null }, "agent": { "id": null, "effort": null } },
               "permission": { "level": "ask", "source": "system", "agent": null, "default": "ask" }, "accepts": null }],
  "sessions": [{ "id": "codex:01a0e7dd-55cc-7722-b4e4-a0bc4169a2b3", "provider": "codex", "threadId": "01a0e7dd-55cc-7722-b4e4-a0bc4169a2b3",
                 "cwd": "/Users/hunter/workspace/x", "projectId": "x", "title": "Fix the flaky test", "state": "waiting",
                 "pending": { "requestId": "2", "kind": "question", "toolName": "requestUserInput", "input": { "...": "..." }, "truncated": false },
                 "lastMessage": { "role": "assistant", "text": "...", "at": "<ISO>" }, "lastError": null, "updatedAt": "<ISO>",
                 "binding": { "workspaceId": "...", "surfaceId": "...", "live": true } },
               { "id": "claude:a9d25355-6056-4302-9146-5d905cb8cec5", "provider": "claude", "kind": "terminal",
                 "cwd": "/Users/hunter/workspace/y", "projectId": null, "state": "busy", "updatedAt": "<ISO>",
                 "binding": { "workspaceId": "...", "surfaceId": "...", "live": true } }],
  "codex": { "available": true },
  "cmux": { "available": true },
  "jobs": { "refreshedAt": "<ISO>", "focusAvailable": true, "refreshing": false, "error": null, "items": [] },
  "routines": { "items": [{ "id": "daily-drift", "name": "Daily drift", "agent": "cfo", "instruction": "...",
                            "schedule": { "cron": "30 6 * * 1-5", "text": "Weekdays at 6:30" }, "active": true,
                            "created": "<ISO>", "updated": "<ISO>", "nextAt": "<ISO>",
                            "lastRun": { "run": "<uuid>", "occurrence": "<ISO>", "trigger": "schedule", "startedAt": "<ISO>", "endedAt": "<ISO>", "outcome": "finished", "reply": "...", "truncated": false, "detail": null } }] },
  "settings": { "ok": true, "error": null, "model": { "default": null, "effort": null }, "brief": { "agent": "assistant" }, "permission": { "default": "ask" }, "quickChat": { "agent": "myos" } },
  "notifications": { "open": 1, "items": [{ "id": "<uuid>", "agent": "cfo", "text": "...", "link": "job:com.example.drift", "at": "<ISO>", "acknowledgedAt": null }] },
  "models": [{ "id": "fable", "name": "Fable" }, { "id": "opus", "name": "Opus" }, { "id": "sonnet", "name": "Sonnet" }, { "id": "haiku", "name": "Haiku" }] }
```

`revision` goes up by one on every change. `home` is the home directory,
which the Agents view shortens to `~` in the paths it shows. `focus` and
`brief` hold what the status route reports (`available` is null and
`state` is `unknown` before the first check). `focus.native` says the board
file exists under the data root, and `focus.updated` is that document's
stamp when the native board is active. `brief.unread` is true when
the newest brief's date is newer than `brief-reads.json`'s `read` date (or
nothing has been read yet), present only while `state` is `ready`; `POST
/api/brief/read` marks the newest brief read (below). Every agent carries its
registry `cwd` (a string, or null when the registry has none), which the
Agents view shows as the agent's folder, and `jobs`, how many launchd
labels its registry `jobs` name; agents leave out `jobs` itself. A
persona also carries
its runtime state (see Personas below); any other kind has `state: null`.
`sessions` lists the coding sessions the dashboard follows but does not
own: the Codex threads on the shared app-server and the Claude terminals
cmux has registered, each row's shape under Sessions in the snapshot
below. `codex` says whether the shared app-server
is connected and, when not, why: `{ "available": false, "reason": ... }`
with `no_server` (no `owner.json`, or its pid is gone), `disconnected`
(a server is known but the socket is down; the rows are kept as
`unavailable` meanwhile), `ws_unavailable` (the `ws` package is not
installed), `no_adapter`, or `api_key_in_env`. `cmux` says the same for
the cmux inventory (its reasons are listed with the rows). `jobs.items` is empty
until the first refresh; a failed refresh keeps the previous items and sets
`error` to `refresh_failed`. `GET /api/state` refreshes Focus and the brief
the same way the status route does (one shared check, bounded by
`statusMs`) and returns the snapshot, so the shell can mount a frame from
what it fetched.

`GET /api/events` is a Server-Sent Events stream:

- `event: snapshot` first, with the whole snapshot and `id:` set to its
  revision. The server checks Focus and the brief before sending it, for at
  most `statusMs`.
- `event: delta` for each change, with `id:` set to the new revision and data
  `{ "revision": N, "patch": { ... } }`. `patch` holds only the top-level keys
  that changed. The server keeps no history and ignores `Last-Event-ID`: a
  client that sees a revision gap fetches `/api/state` again.
- `event: reload` (data `{}`) when the client read too slowly and deltas were
  dropped; the client fetches `/api/state` again.
- `event: bye` (data `{}`) when the server shuts down.
- `: ping` every 25 seconds.

At most 8 streams are open at once; the ninth gets 503 `too_many_streams` with
`Retry-After: 5`. While any stream is open, the server checks Focus and the
brief every 30 seconds and sends a delta only when the answer changed.
A stream is logged once, as `stream_closed`, when it ends. Once the server
has begun shutting down, a new stream request gets 503 `shutting_down`.

`POST /api/jobs/refresh` follows the rules for the Focus controls: exact
`Origin`, no body. It answers once the refresh has finished. `ok` means the
control ran, not that the refresh worked; a failed refresh shows up in the
state as `jobs.error`. A successful `POST /api/pause` or `/api/resume` also starts
a jobs refresh.

### Routines

A routine is a scheduled prompt to one agent, kept as a file the daemon
writes (`lib/routines.mjs`, one `<id>.json` under `routines/` in the data
root, `DASHBOARD_ROUTINES_DIR`). `routines.items` lists them in registry
agent order, then by name. Each item carries:

- `id`: a slug of the name when it was created (`daily-drift`), with a
  four-character suffix when that slug was taken. It never changes.
- `name`, `agent` (the registry id), `instruction` (the prompt the run
  sends), `active`.
- `schedule`: `{ cron, text }`. `cron` is the normalized five-field line
  (`lib/schedule.mjs`; minute, hour, day of the month, month, day of the
  week; steps of five minutes or more, lists, ranges, and weekday names),
  and `text` the daemon's words for it, "Weekdays at 6:30".
- `created`, `updated`: `updated` moves on every save, an Active toggle
  included.
- `nextAt`: the next occurrence in America/Chicago (`TIME_ZONE` in
  `lib/config.mjs`), or null while the routine is inactive or its agent is
  not a Claude persona.
- `lastRun`: the newest run from the routine's log, or null. A run is
  `{ run, occurrence, trigger, startedAt, endedAt?, outcome?, reply?, truncated?, detail?, cards? }`:
  `trigger` is `schedule`, `catchup`, or `test`, `outcome` is `finished`,
  `waiting`, `failed`, `busy`, or `interrupted`; a `busy` line has no
  `run`, and a missed line is `{ outcome: "missed", count, from, to }`.
  `reply` is the resolved text, capped at `LIMITS.routineReplyChars`, with
  `truncated: true` when cut; `detail` carries the failure or `interrupted`.
  The scheduler writes these lines (Routines under Personas).

The items change on a write through the routes, on a registry change (an
agent that leaves takes its routines' `nextAt` with it), and when a run
ends; each is one revision with a `routines` patch, plus `agents` when a
persona's `needsYou` moved. `GET /api/routines/<id>/runs` reads the newest
ten runs from the log, newest first, as `lastRun` is shaped.

### Notifications

A notification is a sentence an agent judged worth Hunter's attention
soon, raised with the `notify` tool (Delegation, under Personas). The
store (`lib/notifications.mjs`) is one file,
`notifications/notifications.jsonl` in the data root
(`DASHBOARD_NOTIFICATIONS_DIR`), user-only because a sentence may carry
a figure: one JSON line per notification, `{ id, agent, text, link, at,
acknowledgedAt }`, oldest first. `link` is null or what the header opens:
`agent:<id>` (the agent's thread), `feed:<run>/<index>` (the Feed
scrolled to the item at that position in the run file `<run>.json`, from
0, or saying the post is gone when it is dismissed), `brief:<date>` (that date's brief in the overlay), or `job:<label>` (Health with
that job selected). Raising appends a line; acknowledging rewrites the
file atomically. Past `LIMITS.notificationsMax` (200) the oldest
acknowledged items roll off first, then the oldest open ones. A line the
daemon cannot read is skipped and logged `notification_invalid`.

`notifications` in the snapshot holds every kept item, newest first, and
`open`, how many are unacknowledged; each raise or acknowledge is one
revision with a `notifications` patch. The header shows `open` beside
Notifications when it is above zero, on a desk and on a phone alike, and
the list under the header shows the
open items with Acknowledge, Acknowledge all, and the acknowledged ones
under a divider. A card up, a run that ended waiting, an unopened reply,
and a failed job never become notifications; they are the rail's marks.

### Daily Brief

The morning run writes `brief-<YYYY-MM-DD>.json` beside the viewer page it
keeps for the record (`daily-brief/briefs/build.py`):

```json
{ "date": "2026-09-21", "title": "text", "words": 420,
  "opening": { "id": "opening", "text": "Markdown" },
  "sections": [{ "id": "money", "label": "Money",
                 "items": [{ "id": "money-1", "text": "Markdown" }] }] }
```

`opening` is null when the memo has none. The latest brief is the newest
date among `brief-<date>.json` and `viewer-<date>.html`; a newest date with
only a viewer is `missing`, never an older brief. The reader
(`lib/briefs.mjs`) refuses a file over 2 MiB, a symbolic link, and any file
that is not exactly this shape: the date must match the name, ids are
unique, at most 20 sections of 40 items and 200 items in all, each text at
most 8,000 characters. A refused file is shown as unavailable, never in
part. Its revision is the SHA-256 of the file's bytes.

`GET /api/brief/latest` answers `{ "state": "ready", "date", "revision",
"title", "words", "opening", "sections" }`, or `{ "state", "date", "error"
}` when the newest date cannot be shown, or `{ "state": "empty" }`. A briefs
directory that cannot be read is a 503 `brief_directory_unavailable`. `GET
/api/brief/<date>` answers the same for one date; a date with no data is
`{ "state": "missing", "date", "error": "brief_not_found" }`, and a date
that is not a real calendar date is 404.

`POST /api/brief/read` takes no body. It reads the newest brief itself
(never the cached snapshot, so a read right after a brief appears is never
missed), records its date in `brief-reads.json` under the data root
(`lib/brief-reads.mjs`), and answers `{"ok": true}`. When the newest brief
is not ready there is nothing to mark, and it still answers `{"ok": true}`.
The overlay (`public/brief-overlay.js`) calls it once it has rendered the
newest brief, never for an older date opened by itself.

`POST /api/brief/feedback` takes JSON with exactly these keys:

```json
{ "date": "2026-09-21", "revision": "<64 hex>", "overall": "text",
  "items": [{ "id": "money-1", "mark": "approved", "note": "text" }] }
```

`mark` is `approved`, `dismissed`, or `null`. `items` must name each item in
that brief once, the opening included. `overall` is capped at 8,000
characters, each note at 4,000, and the list at 200 items; beyond those it
is 413. A revision that no longer matches the file is 409
`revision_conflict`. On success the server writes two files beside the
brief, both 0600, replacing any earlier ones for that date, with one save
per date at a time: `feedback-<date>.md`, which the curator reads the next
morning (each item under its section label as `- <id>: APPROVED`, the
paragraph's text quoted under it, and its note), and `feedback-<date>.json`,
the request with `savedAt`, which `GET /api/brief/<date>/feedback` returns.
With nothing saved that route answers `{ "date", "revision": null,
"overall": "", "items": [], "savedAt": null }`.

The overlay (`public/brief-overlay.js`) opens from the header's Brief entry
on any view, from Open brief on the morning line in a thread, and from a
notification's `brief:` link. It shows the date and title, the opening,
and each section with its items in the dashboard's Markdown and a serif
face, with Approve, Dismiss, and Note under each item and an overall note
and Save at the end. Save sends every item; the saved time, unsaved
changes, and a refused save each read as one sentence under it. The
overlay reads back the saved feedback when it opens, keeps unsaved marks
while the page is open, offers "Load newer brief" when the snapshot names
a newer one, and closes with Close, Escape, or a click on the backdrop
outside the sheet. A brief it cannot show
reads "The brief for <date> could not be opened." or "No brief has been
generated yet." The viewer pages stay on disk; nothing serves them.

`GET /api/brief/instructions` reads the rules the curator follows,
`daily-brief/curator.md` (`DASHBOARD_BRIEF_INSTRUCTIONS`), and answers

```json
{ "path": "daily-brief/curator.md", "updated": "<ISO or null>", "problem": null,
  "blocks": [{ "type": "h", "text": "..." }, { "type": "p", "text": "..." },
             { "type": "list", "ordered": true, "items": ["..."] },
             { "type": "table", "head": ["..."], "rows": [["..."]] }] }
```

`updated` is the file's modification time. The blocks come from the Goals
markdown reader, with inline markup flattened; a paragraph of `|` rows under
a delimiter row becomes a table. A file that is missing, not a regular
file, or over 64 KiB gives no blocks and one `problem` sentence naming the
brief instructions file. Reads are cached by the file's lstat and happen
only on request.

`POST /api/brief/instructions/propose` takes `{"text": "..."}` and sends the
agent Settings names under "Brief goes to" one message asking it to change
the rules and say what changed; the shell then opens its thread. With "No
thread" chosen there, it falls back to the first pinned Claude persona,
else the first built-in one. It refuses with 400 `invalid_body`, 400
`invalid_text` (blank), 413 `payload_too_large` (over the send limit), 503
`shutting_down`, 409 `no_brief_agent` (no agent is named and neither
fallback exists), 404 `no_such_agent` (the named id is not a persona in the
registry), 409 `persona_unavailable`, then the persona send refusals (409
`busy` and the rest). The dashboard never writes the file; the agent does.

Instructions in the overlay's bar opens these rules above the brief with a
box for the change; the sentence
under the heading names the agent the change goes to, or says that none
receives the brief.

### Goals

`GET /api/goals` reads three sources under the second-brain persona's cwd:
`notes/current-priorities.md`, `notes/longterm-priorities.md`, and each
`notes/goals/*.md`. `POST /api/goals/propose` takes
`{"kind": "add", "text": "..."}` or
`{"kind": "edit", "target": "goal:podcast", "text": "..."}`, sends the text
to the second-brain persona as a new message, and the shell opens that
persona's thread. The dashboard never writes the vault; the persona does, in its own
turn.

### Feeds and sources

A feed is a folder under `feeds/` in the data root (`DASHBOARD_FEEDS_DIR`):
`feed.json` (its name, the agent that produces it, its sources, and whether
it runs), `note.md` (Hunter's instructions), `items/` (one file per run),
and `marks.json`. A source is one file under `sources/`
(`DASHBOARD_SOURCES_DIR`): an RSS feed (`url`), a newsletter's sender
(`sender`), a file, or a folder (`path`). RSS and email sources are
incoming; files and folders are context. The dashboard writes `feed.json`,
`note.md`, `marks.json`, and the sources; the producer only adds item
files.

`GET /api/feeds/<id>` answers

```json
{ "feed": { "id": "news", "name": "News", "producer": "scout", "sources": [], "active": true, "...": "..." },
  "readAt": "<ISO>", "problems": [],
  "runs": [{ "id": "2026-10-09", "producer": "scout", "date": "2026-10-09", "since": "2026-10-08",
             "generatedAt": "<ISO>", "read": ["latent-space"],
             "items": [{ "id": "news/2026-10-09/1", "title": "...", "sources": ["latent-space"], "url": "https://...",
                         "summary": "...", "takeaway": "...", "insights": "...", "kept": true,
                         "image": "https://...", "status": "new", "position": 0 }] }] }
```

Runs are the newest 30 files named `<date>.json`, or `<date>-<producer>.json`
from before feeds, regular files only. A file over 256 KiB, not JSON, or not
a run is left out with one problem sentence; an item without its id, title,
`http` or `https` URL, summary, and sources, or with an id already used, is
left out and counted in one sentence per run. An older item's `source`
string is split on "/" and ","; each name becomes the id of the source with
that name or alias (any case, trimmed; a name wins over another source's
alias), or stays as written. A takeaway over 240 characters or insights
over 2,000 are dropped and the item kept. A dismissed post is left out;
`status` is `saved` or `new`. `position` is the post's index in the run
file's `items`, from 0, the index a `feed:<run>/<index>` notification link
names; a dismissed or left-out post before it does not shift it. `image` is the story's picture when it is an
`http` or `https` URL, shown under the summary from the story's own host
with no referrer, which is why the shell CSP allows `http:` and `https:`
images.

`POST /api/feeds` starts a feed with the sources marked `default` and the
producer the oldest feed names. `PUT /api/feeds/<id>` refuses a source id
that is not registered with 400 `unknown_source` and the ids. The note is
written directly, up to 64 KiB (413 `note_too_large`), with no agent turn.

`POST /api/feeds/<id>/discuss` takes `{"id": "news/2026-10-09/1"}`, sends
the post's title, sources by name, link, summary, takeaway, and insights to
the feed's producer as a new message asking it to read the link and say
what it says and why it was picked, and the shell opens that agent's
thread. It refuses with 400 `invalid_body`, 503 `shutting_down`, 404
`no_such_feed`, 404 `no_such_agent`, 409 `persona_unavailable`, 404
`no_such_item`, then the persona send refusals (409 `busy` and the rest).

A suggestion run is a test run of the producer's Suggest sources routine,
which follows Scout's `suggest-sources` skill: a session of its own in the
producer's folder, its reply kept under the routine's Last runs. The
daemon creates the routine, inactive, the first time it needs one. Before
each run it removes the feed's `suggestions.json`, which the run writes
once. `suggestions` is `null` when there is no file or the file is not
valid (logged as `feed_suggestions_invalid`); otherwise `{ "at", "sources" }`
with each suggested source that is registered, active, and not on the
feed, as `{ "id", "name", "kind", "role", "why" }`. `suggesting` is true
from the run's start until its end line is in the routine's log. Suggest
refuses with 503 `shutting_down`, 404 `no_such_feed`, 503 `not_yet`, 409
`busy` (a run for the feed is out, or the producer has a turn open), 409
`agent_unavailable`, then the scheduler's refusals.

`GET /api/sources` lists every source with its `role` (`incoming` or
`context`) and, for a file or folder, `missing` when the path is not there.
A source's id is its name as a slug, with `-2` on a collision (`discover`
is never an id). `aliases`, optional on `POST` and `PUT`, lists other names
the source has gone by, so old posts filed under a former name count under
it: at most 20, each 1 to 200 characters on one line, stored trimmed with
repeats (in any case) dropped; `[]` removes them, and a source without any
has no `aliases` key. There is no screen for them yet. A refused body is
400 `invalid_body` with `detail` naming the field.

`POST /api/sources/discover` (`lib/discover.mjs`) fetches an http or https
address as `feed/bin/enrich` fetches a page: 6 seconds, at most 512 KB,
redirects followed. It answers the address when it serves RSS or Atom,
else the first `<link rel="alternate">` of type `application/rss+xml` or
`application/atom+xml`, else `null`; a failure is `null` too. Another
scheme is 400 `invalid_body`.

The Feed's header holds New feed and the settings gear (the agent
settings' gear). Both open `public/feed-settings.js`'s sheet beside the
posts, over them on a phone. Settings shows the open feed's instructions
(`note.md`, saved with `PUT /api/feeds/<id>/note`) and its active sources,
incoming then context, each a checkbox that saves the feed's `sources` at
once. Manage sources lists every source with Active, "Default for new
feeds", and Delete, and Add source: a newsletter's site is looked up with
discover and saved as RSS when it has a feed, else as email once the
sender is given; an RSS or blog address must lead to a feed; a file or
folder takes an absolute path. Under the sources, Suggested lists the
producer's picks with their reasons and an Add button each, and Suggest
runs it again. New feed takes a name and instructions and opens the feed
on its tab with its settings, where its suggestions appear.

### Ideas

Each idea row ends in two buttons. The bookmark saves the idea through
`POST /api/ideas/save`, and on a saved idea it is filled and unsaves it
through `POST /api/ideas/unsave`; its label is Save or Unsave and
`aria-pressed` says whether the idea is saved. On a desk it shows on the
row's hover and focus, and a saved row always shows it; on a phone it is
always shown. A started idea has no bookmark. The `…` menu beside it holds
Discuss, Start or "Started with" the agent, and Dismiss.

### Focus proxy

`lib/focus-proxy.mjs` forwards a fixed set of routes to
`DASHBOARD_FOCUS_ORIGIN`, each to one upstream path. Nothing else is forwarded.
When `focus/board.json` exists under the data root, the native board routes
take precedence over the proxy's `GET /api/focus`.

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

### Jobs

`lib/jobs.mjs` lists every job named in the agent registry's `jobs`.
`DASHBOARD_JOB_RUNNER` picks how it reads them: `launchd` (the default on
macOS) or `systemd` (the default elsewhere). Under launchd, for each label
it reads the plist from `DASHBOARD_LAUNCH_AGENTS_DIR` with
`plutil`, asks `launchctl list` for the last exit status and PID, and takes
the log file's modification time as the last run. Under systemd each label
is a pair of user units, `<label>.service` and `<label>.timer`, read with
`systemctl --user show --timestamp=unix` (systemd 251 or later): a service systemd does not know reads as
unavailable, `Result` and `ExecMainStatus` give the outcome,
`ExecMainStartTimestamp` the last run, the unit file's
`StandardOutput=append:` path the log, and the timer's `OnCalendar` values
the schedule, in the same words as a plist's. Focus scans
(`com.focus.scan-*`) use Focus's `/api/status` instead when Focus answers. The
module only reads: it never loads, starts, or stops a job, and it runs only
when asked.

A job is a launchd plist an agent's repo owns; a routine (a scheduled
prompt the daemon runs itself) is a different thing and never appears
here. The snapshot's `jobs` key, `public/jobs.js`, and
`POST /api/jobs/refresh` carry the name; `/routines` still redirects to
`/health` for one release.

### Shell

`public/index.html`, `public/shell.js`, `public/panel.js` (the side
panel), `public/agents.js`,
`public/thread-view.js` (one thread's column, mounted by the Agents view
and quick chat), `public/quick-chat.js`, `public/markdown.js`, `public/jobs.js`, `public/goals.js`,
`public/feed.js`, `public/feed-settings.js` (the Feed's settings sheet),
`public/instructions.js` (the instructions panel Ideas and the brief share), `public/notifications.js` (the header's count
and list), `public/brief-overlay.js` (the brief), and `public/styles.css`
make up the page served at `/`, `/agents`, `/brief`, `/feed`, `/focus`,
`/goals`, and `/health`. The Agents view is the page at `/`; `/agents`
shows the same view. `/feed` shows the Feed, `/brief` the Feed with the
brief's overlay open (the address becomes `/feed`), `/focus` Focus,
`/goals` Goals, and `/health` Health. The server redirects the old
`/routines` to `/health` and `/reading` to `/feed`. The navigation is a
rail of six icon links, Home, Feed, Focus, Goals, Ideas, and Health; a
path the shell does not know lands on Agents. Between the rail and every
view sits a side panel (`aside#panel`) holding one section per view: the
view's own list (agents with search, Feed sources, Goals areas, Health
jobs, Ideas: Saved and weeks) or Now (agents waiting, open notifications, today's
brief), which a view without its own, Focus, shows. `public/panel.js`
draws Now from every state and opens a row's target through the shell.
Its toggle, "Hide side panel" or "Show side
panel", comes first in the header, before the view's title, on every view.
From 720px the toggle collapses the panel on every view and the choice is
kept in `localStorage` under `dashboard.panelHidden` (an old
`dashboard.agentsListHidden` is read once and removed). Dragging the
panel's right edge, or its arrow keys, sets its width from 220 to 480px,
kept under `dashboard.panelWidth`; a double-click puts it back to 288.
Below 720px the
panel is a drawer from the left over a scrim, between the header and the
bottom bar: the toggle opens it, and the scrim, Escape, or another view
closes it; nothing stores it. The script switches views
with the History API and handles
Back and Forward, and a reload or bookmark opens the same view. The Focus
frame is created the first time its view opens and stays in the page
afterwards, hidden while another view is shown, so Focus keeps its state. The page has no inline script or style, as the
shell CSP requires.

The shell keeps one copy of the state and gets it from the event stream.
While the tab is visible it holds an `EventSource` on `/api/events`, and it
closes it when the tab is hidden. A `snapshot` replaces the copy. A `delta`
whose revision is one more than the copy's is merged in, key by key; any
other revision means deltas were missed, and the shell fetches `/api/state`
instead. `reload` also fetches `/api/state`. After `bye` the shell closes
the stream and opens a new one half a second later.

The browser's own `EventSource` stops for good on any answer other than
200, including the 503 a stopping server sends, so the shell reconnects
itself. On any stream error it closes the stream and tries again after 1,
2, 4, 8, and then every 15 seconds; a snapshot resets the delay. Until a
snapshot arrives it fetches `/api/state` every 30 seconds, so the views keep
up. When a second attempt in a row has failed, the page shows "The
dashboard is not responding." with Retry, which reconnects at once. Every
view change also fetches `/api/state`, with a 5-second timeout.

The Focus frame is created only from state that has just arrived: a
snapshot, a delta that changes `focus`, or a finished `/api/state` fetch,
never the copy kept since. When Focus does not answer, the Focus view says
"Focus is not responding." with Retry. A frame already open stays;
otherwise none is created until Focus answers.

The frame stays hidden until its page loads. If the page comes back as a
JSON error, such as a 502 from Focus, the frame stays hidden, the view
shows its notice, and the state is fetched again at once. Retry reloads
it.

Wide screens get a navigation column; below 720px it becomes a row across the
top. The page is exactly one screen tall and each frame fills the rest, so the
child page does its own scrolling and keeps its fixed bar in view.

### Agents view

The Agents view is the page at `/`. It lists every registry agent under
the registry's groups (`groups` in the file, in that order, with those
names; a group an agent names that the file leaves out follows them under
its id with the first letter raised), in registry order within a group:
its avatar (Avatars, below) and name, the provider's icon, and for a
persona its last message with a relative time. The role is not shown on
the row, but the search matches it. Each icon is a Simple Icons file
under `public/providers/` (CC0; `NOTICE` there names the source), served
as `/assets/provider-<id>.svg`, titled and labelled with the provider's
name; a provider with no icon shows its name as a text chip. A row wanting Hunter shows an amber dot beside its
name, titled and labelled "Waiting for you" (a question or approval open)
or "Needs you" (a routine's run left a card unanswered and nothing has
been written in the thread since; Routines under Personas) rather than a
text chip. Otherwise a line gives its state: "Working" during a turn,
"The last turn failed", or "Unavailable". A persona marked `pinned` in
the registry sits above the groups under no heading. A project folder or system agent shows its
description instead and opens nothing. Choosing a persona opens its thread
and puts `?agent=<id>` in the URL (`/?agent=cfo`; `/agents?agent=cfo` opens
the same thread), so a reload or a shared link lands on the same thread;
Back and Forward move between threads. From 720px the list and the pane
beside it sit side by side; with no agent in the URL the pane holds the
first pinned persona's thread (the URL stays `/`, so Back leaves the page
and a row click still adds its entry), or reads "Choose an agent to open
its thread." when nothing is pinned. On a phone nothing opens by itself:
Agents with no agent open opens the side panel's drawer on the list,
choosing a row closes it, and a thread takes the whole width with an "All
agents" link that opens the drawer again. The launchd jobs, the registry error, and the lines for
the Codex server and cmux are on the Health view; the Agents view says only
what each row needs.

Under the groups, a collapsed "Routines" heading opens to every routine
(Routines under State) grouped under its agent's name in registry order:
the routine's name, the chip its row in the panel carries (below), its
schedule in the daemon's words, and the next fire, "Next at 6:30
tomorrow" ("today", a weekday within the week, "on Oct 12" beyond it), or
nothing while it is off. A row opens the agent's thread with the panel on
that routine's form. "No agent has a routine yet." when there is none; the
heading is hidden while the registry cannot be read. Whether it is open
lasts until the page reloads.

#### Sessions

The snapshot's coding sessions (see Sessions in the snapshot) are rows
too. Each sits under the project row its `projectId` names, indented,
newest first; sessions under no project sit in an "Other sessions" group
after Personal. A session row shows its provider icon, a title (a Codex
thread's title, else the last segment of its folder; a Claude terminal
always uses the folder), the folder with the home directory as `~`, and a
relative time. A session wanting Hunter shows the same amber dot beside
its name, titled and labelled "Waiting for you", in place of a state
line; otherwise the line reads "Working" during a turn, "The last turn
failed", "Server stopped" while the Codex server is down, or "Terminal
closed" when the terminal it was started in has gone. A Codex thread with
an open turn says the turn, since it can still be answered here; a Claude
terminal that has closed says only that. When there are no sessions and both the
Codex server and cmux are off, one sentence ends the list: "No coding
sessions. Start the Codex server or open a terminal in cmux." With only
one of them off the list says nothing; the Health view carries one
line per source that is off, above its heading ("The Codex server is not
running.", "The Codex server disconnected.", "Codex sessions are off
until npm ci runs.", "cmux is not running.", "cmux refused the
connection. Check the socket password.", or "cmux is not reachable."),
and nothing while both answer.

A session's id goes in `?agent=` like an agent's (`/?agent=codex%3A<threadId>`;
the plain `codex:` form works too), and the phone flow is the same. An id
that is not in the snapshot shows "That session is not listed."

A Codex session opens the thread pane: its title and provider icon, its
folder, the messages from `GET /api/sessions/<id>/thread` (fetched on the
same occasions as a persona's), the working or waiting line with
Interrupt (`POST /api/sessions/<id>/interrupt`), and a question or
approval card that posts to `POST /api/sessions/<id>/answer`; a Codex
question's answers are keyed by its question ids; a question whose
`isOther` is false has no Other field, and one whose `isSecret` is true
takes its Other answer in a password field. There is no New thread
and no cost line, and in place of the composer one
sentence: "Type to this thread in its terminal." An approval
shows what it asks as parts when the input carries them, in place of the
JSON: the command and its folder, the files of a change, the permissions
asked for (one line per path with its access, and "network"), and the
reason given; the heading reads "<title> wants to run a command", "wants
to change files", or "asks for permission", and for a request of a kind
the view does not know, "<title> is waiting on the terminal". A request
only the terminal can answer (`native`) shows no Allow, Deny, or Answer,
and says "Answer this one in the terminal." While the server is down the
pane says "The Codex server disconnected." above the empty message area;
after a failed turn it says "The last turn failed." (the server's own
error text stays in the log). A refusal is reported under the pane as
for a persona ("Answer this one in the terminal." for `not_supported`,
"The Codex server is not connected." for `unavailable`, "That session is
no longer listed." for `no_such_session`).

A Claude terminal opens a pane with the folder name, the Claude icon, and
the folder, then its state: "Claude is working.", "Claude is idle.",
"Claude is waiting for you.", "Claude has not reported its state.", or
"The terminal is closed." It has no messages, no request, no Interrupt,
and no composer. Its cmux workspace and surface ids are never shown.

Both panes have an "Open terminal" button in the header. It is enabled
only when the session's `binding` names a terminal, that terminal is
`live`, and `cmux.available` is true; otherwise it is disabled with the
reason beneath it, in this order: "This thread was not started with
codex-new, so its terminal is not known." (no binding, or one recorded
outside cmux), the cmux sentence above (cmux off), or "That terminal is
closed." (not live). Choosing it posts to
`POST /api/sessions/<id>/open-terminal`; a 200 shows nothing, since the
terminal now has the focus, and a refusal puts its sentence beneath the
button until the next attempt or another session is chosen (`unbound`,
`terminal_closed`, `cmux_unavailable` with its reason, `focus_failed` as
"That terminal is closed." for `not_found`, the cmux sentence for
`not_running`, `no_password`, or `auth_failed`, else "cmux could not open
that terminal.").

#### Settings

A gear, named "Details", sits in the thread header of every agent (not a
coding session) and opens the agent's settings in a panel: from 720px a
300px column at the right of the thread, which narrows to make room, and
under 720px a sheet over the whole thread. The panel's chevron ("Close
details") or Escape inside it closes the panel and puts the keyboard back
on the gear; on a phone, opening it puts the keyboard on the chevron. It
stays open while other agents are chosen and is closed after a reload; the
state is kept in memory only.

For a persona the panel is a form over its registry entry: Name, Role,
Group (the registry's groups, then the groups agents name that the file
leaves out, then "New group…", which shows a Group name field; the group's
id is the name slugged, lowercase with runs of anything else as one
hyphen, and a slug already listed joins that group), Description, Folder
(the registry `cwd` with the home directory as `~`, expanded on save),
Model and Effort (each a select whose first option is "Default (Sonnet)"
or "Default (Claude Code)", the system default from Settings, then the
model table or the five levels), Permissions (a select whose first option
is "System default (Ask)", naming the level Settings holds, then Ask,
Auto, and Full access, with one sentence under it for the level in force:
"Asks before each tool that is not already allowed.", "Claude decides,
and asks only when it is unsure.", or "Runs every tool without asking.";
the level shows nowhere else, so the row and the header carry no chip for
it; a Codex persona reads "Codex, its own
settings" in place of the three), Who may message (checkboxes: "Everyone"
first, then "No one", then the other personas; Everyone, No one, and the
names each exclude the rest, and none chosen is everyone; "No one" writes
`accepts: []`), and Pinned. Save is off until a field changed
and sends one `PUT /api/agents/<id>/settings`; Cancel puts the values
back. The row, the header, and the form follow the registry change through
the snapshot. A refused save lists the validator's problems under the form
("name must be a non-empty string of at most 40 characters") until the
next edit; a saved folder change adds "The folder applies when a new thread
starts." The jobs sentence (see Jobs) follows the form. Edits made
elsewhere while the form holds unsaved changes leave the form alone.

For a Claude persona a "Routines" heading follows the jobs sentence: the
agent's routines as rows (name; a chip, "Off" while inactive, "Not yet
run", or the last run's outcome: "Finished", "Waiting for you", "Failed",
"Skipped" for `busy`, "Interrupted", "Missed", "Running"; the schedule in
the daemon's words and the last run's time), "No routines yet." when there
are none, and "Add routine". A row or the button swaps the settings form
for the routine's form, headed by the routine's name or "New routine" with
a chevron back to the list: Name, Instruction, When, Active, Save (Create
for a new one, off until a field changed) and Cancel. When is a cadence
select, "Every day", "Weekdays", "Weekends", "Every week on…" (which adds
Mon to Sun checkboxes), "Every hour", "Every 30 minutes", and "Every month
on the…" (which adds a day from 1 to 28), with a time beside it for every
cadence but the hourly two. The form composes the five-field line from
these and sends it; the line shows nowhere, and a stored line the picker
has no shape for (a hand-edited file) opens the picker at its defaults
under "The saved schedule is not one the picker offers. Saving replaces
it." Problems list under the form before anything is sent ("Give the
routine a name.", "Say what the routine asks CFO to do.", "Choose at least
one day.", "Choose a time.", "Choose a day of the month from 1 to 28.");
a refusal shows one sentence for its code, the schedule one as "That
schedule could not be saved. Choose when it runs and a time." A saved
routine's form adds Test run and Delete (an inline "Delete <name>? Its runs
go with it." with Delete routine and Cancel, as New thread confirms) and "Last runs",
the newest ten from `GET /api/routines/<id>/runs`: the outcome chip, the
occurrence's time, and a sentence, "Test run." or "Ran late, after the
dashboard was down." first when it applies, then "Replied in 48 seconds.",
"CFO wanted to run Bash." or "CFO asked: <question>" for a run that ended
waiting on a card, "The turn failed.", "The agent was not started.", "The
agent was already working.", "The dashboard stopped during the run.",
"One fire was missed." or "<n> fires were missed.", or "Running now.". A
non-empty reply appears beneath that sentence, on one line when short and
collapsed under its first line when long. A refused test run says "CFO is
still working. Wait for the reply." or "CFO
is unavailable." The form stays as it is while snapshots arrive, and
closes when another agent is chosen.

At the panel's foot, below the routines, a persona shows Delete unless
the registry marks it `builtin` (Myos, part of the dashboard). Delete asks
inline: "Delete CFO? This removes it from the registry with its routines
and their runs. Its thread stays on disk.", followed by "The brief will go
to Myos." or "Quick chat will talk to Myos." when Settings names the agent
for either ("No agent will receive the brief." or "Quick chat will have no
agent." when no Claude agent is left), with Delete and Cancel. Confirming
sends `DELETE /api/agents/<id>` and, on success, closes the panel and the
thread. The daemon strips the id from every other agent's `accepts` (a
list left empty stays empty, so it still means no one), removes the
agent's routines and their runs logs, and moves the brief or quick chat to
the first built-in Claude agent, else the pinned one, else the first. The
thread files and the session stay, so an agent added again under the same
id finds its thread. Refusals, each one sentence under the button: 409
`builtin` ("Myos is part of the dashboard and cannot be deleted."), 409
`busy` while a turn runs or waits on a card ("CFO is in the middle of a
turn. Delete it once the turn ends."), 409 `not_agent` for a project or
system entry, 404 `no_such_agent`, 409 `registry_invalid`, and 503
`shutting_down`.

A project or system entry stays read-only: Role, Group, Provider, and
Folder, each left out with its label when the registry has no value, then
the description as written, and the jobs sentence.

"New agent", at the foot of the list, opens the same form empty in the
panel (on a phone it covers the list's place; on a desk it opens beside
whatever thread is open, or beside an empty column headed "New agent"):
Name, an Id that fills from the name until it is typed, Role, the first
listed group, Description, an empty Folder, the system defaults for Model
and Effort, Everyone, and not pinned. Create posts `POST /api/agents`; on
201 the new agent's thread opens with "No messages yet." Cancel, the
chevron, Escape, or choosing a row leaves the form. The button is hidden
while the registry cannot be read.

A thread shows no job rows. Under the description the panel counts the
agent's launchd jobs in one sentence, "CFO runs 1 job.", linking to
`/health` (see Health view), from the agent's `jobs` in the snapshot, so it
needs no refresh; an agent with none has no sentence.

The thread is read from `GET /api/agents/<id>/thread` when it opens and
again whenever the state shows a new last message or a turn that started or
ended, so it follows the turn without reconstructing it from deltas. Your
messages sit on the right, the persona's on the left, and "New thread"
markers in the middle. A message another agent sent (a `user` message
with `from`, the sender's registry id) sits on the left under the sender's
name, which links to the sender's thread, and previews in the row as
"<Sender>: ..." the way yours read "You: ...". An "@Name" in a message
whose `mentions` lists that agent's id renders as a pill. A `system`
message with `kind: 'delegation'` is a centered line about an exchange
between agents, its `state` one of `sent` ("Messaged CFO"), `busy`,
`refused` (with `reason`), `waiting`, `failed`, or `finished`, the last a
collapsed "CFO replied: <summary>" row that opens to the reply; the agent's
name links to its thread. The daemon posts them as the ask tool runs
(Delegation, below). Every message, and the brief notice's memo, renders
its Markdown (`public/markdown.js`): paragraphs with their line breaks,
headings, bulleted and numbered lists nested by indent, bold, italic,
inline code, fenced code blocks, blockquotes, rules, and http, https, and
mailto links, which open in a new tab. Raw HTML and any other link render
as text. The row preview and the notice's summary strip the markers. While the persona works or waits on an answer, the
pane says so and offers Interrupt, which ends the turn and denies any open
request. A question becomes one card per question with its options
(label and description), an Other field, and Answer, which posts one answer
per question; an approval is a card with the tool name, its input as
monospaced JSON (marked "Input cut short." when the snapshot cut it),
and Allow and Deny. The composer is labelled "Message <name>"; Send is off,
with the reason under it, while the persona is working, waiting on an
answer, or unavailable. A failed turn shows the adapter's sentence above
the messages ("The stored session could not be resumed. Start a new
thread."), a turn the clock stopped shows "The last turn ran too long and
was stopped." there until the next turn, and an unavailable persona shows
why under the composer, as a sentence rather than a code. New thread asks
for confirmation inline before posting. A refused Send, Answer, Interrupt,
or New thread is reported under the composer until the next attempt; a
`no_such_request` refusal also fetches the state again. If the thread
cannot be read again after a change, the messages already shown stay, with
a Retry line above them. A draft typed for one persona is kept while another
thread is open.

Under the input, a Claude persona's thread shows the model and effort its
next turn runs on ("Opus · High", "Sonnet", or "Claude Code default").
The button opens a picker: the model table's names with the agent's
default marked, the five effort levels, and "Use the agent's default",
which is on only while the thread has a choice of its own. A choice posts
at once and the thread gets a line ("Now on Sonnet, low effort."); during
a turn the change is refused with "Wait for the turn to finish before
changing the model." under the composer. New thread drops the choice. At
phone width the picker is a sheet along the bottom. A Codex agent shows
"Codex, its own settings" in its place.

Typing `@` at the start of a word in the input opens a list over it of
the other agents that take messages, in the Agents list's order, narrowed
as letters follow (by name, id, role, or a word of the name). Up and Down
move, Enter or Tab chooses, Escape closes, and a click or tap chooses;
the chosen name goes in as `@CFO ` and Enter then sends as usual. On send
the view works out which agents the text names (`@Name` or `@id` as a
whole token, case-insensitive, the longest name winning, code skipped)
and posts them as `mentions`, so the bubble shows them as pills and the
agent's prompt names them. A mention is a reference, not a delivery: the
agent decides whether to message the agent named. On a phone the list
sits over the input the same way, so what is typed stays in view.

### Quick chat

Quick chat in the header (in the menu on a phone) opens a pane on the
right of any view: over the view on a desk, across the width on a phone.
At its top a button names the agent; it starts on the agent Settings
names under "Quick chat talks to", and a choice made in it holds for the
browser session. The button opens a search over every Claude agent, one
row each with its name and role, filtered as you type by either
(ignoring case); Up and Down move, Enter or a click chooses and loads
that agent's thread, and Escape closes the search and leaves the pane
open. With nothing matching it says "No agent matches." Below the picker
is the same thread column the
Agents view renders, bound to the same thread, so a message sent from
either shows in both. A draft typed in the pane is in the Agents view's
composer when that agent opens there. Escape or Close closes the pane.
Showing an agent's thread in the pane marks its reply read.

The first message after the pane opens, or after the view under it
changes, carries `context`: Health's selected job (name, label, agent,
schedule, last run, outcome), the Feed item whose top edge is highest in
the list, the Agents view's open agent and its state, or the view's name
alone on Focus and Goals. While the brief's overlay is open it wins over
the view under it: the context is the brief's date and the item at the
top of the sheet (its section's label and text). The overlay covers the
header, so a pane already open stays open and above the overlay, carrying
the brief's context instead; Escape closes the pane first. The adapter records it as a
system line (`kind: 'context'`) before the message, shown as a collapsed
"Sent from Health: <job>" that opens to the detail, and the agent's prompt
starts "Hunter sent this from the Health view, looking at: <job>" with the
detail under it. The message itself is recorded as typed.

### Health view

The Health view, at `/health` and the last entry on the rail, opens with
the Settings card and then lists the launchd jobs of every registry entry
under the heading "Jobs". It scrolls on its own, in a 720px column.

The Settings card has five rows, each a select. "Default model" offers
"Claude Code default" and the model table's names (Fable, Opus, Sonnet,
Haiku); "Default effort" offers "Claude Code default" and the five levels
(Low, Medium, High, Extra high, Max); "Brief goes to" offers "No thread"
and every Claude agent by name; "Quick chat talks to" offers every Claude
agent by name (and "No one" only while nothing is set), the agent the
header's quick chat opens on; "Default permissions" offers Ask, Auto, and
Full access, seeded Ask, with the level's sentence under it (the same
three as the gear panel's). A value the lists do not carry (a model id
typed into the file by hand, an agent since removed) shows as itself.
Changing a select sends one `PUT /api/settings`; the selects are disabled
until it answers, "Saved." shows under the rows for three seconds, and the
new values arrive through the state as on every other page. A refusal puts
a sentence there instead and the selects return to the state's values:
"That agent is not registered." (404), "That permission level is not
offered." (400), "The settings file could not be
read. Fix or delete it." (409, also shown on its own whenever the file is
unreadable), or "Settings could not be saved." for anything else. When no
agent receives the brief the card says "No agent receives the brief." On a
phone each label sits above its select. There is one card for each agent that has
jobs, in registry order, with the agent's name and role. Each job is a row
with its name, schedule, last run, and outcome, and Focus scans with
failures in the last 24 hours also show how many. Times under a day are
relative ("12 minutes ago"); older ones read "Yesterday 21:00" or "Sep 3
21:00". The header shows when the jobs were last refreshed and has a
Refresh button, which reads "Refreshing…" while a refresh runs. Above the
heading is one line per source that is off (see Sessions under the Agents
view), and nothing while both answer.

Jobs are refreshed only on demand: when the view opens and the last
refresh is missing or more than 60 seconds old, and when Refresh is chosen.
The Focus card shows "Paused" when any scan is paused, and a Pause or
Resume button that posts to the forwarded `/api/pause` or `/api/resume`;
the server then refreshes the jobs, and the card follows the state. If the
request gets no answer, or the proxy answers 502 or 504 because Focus gave
none, the card says "Focus did not respond."; any other error status is
Focus's own and shows "Focus reported an error." The message clears on the
next attempt or when the state shows the scans paused or resumed. A
registry that cannot be read ("The registry could not be read." followed
by the registry's error), a failed refresh ("Jobs could not be
refreshed."), and an empty list ("No jobs are registered.") each get one
plain sentence, and when Focus did not answer during the refresh the Focus
card says its rows come from the job runner. While the view is off screen its
cards are not rebuilt; opening it renders the latest state.

## Personas

A persona is a long-lived Claude session whose working directory is the
agent's repo. `lib/runtime/claude.mjs` runs persona turns through
`@anthropic-ai/claude-agent-sdk`, pinned to an exact version and loaded once
when the personas start; the app's only other runtime dependency is `ws`,
pinned the same way and used only by the Codex runtime. Bumping the pin
means re-running `scripts/spike-claude-sdk.mjs` and confirming the
`apiKeySource` it reports is still `none`. The adapter contract, its methods
and events, is in `lib/runtime/adapter.mjs`. The routes below are wired to
it and the Agents view (above) drives them.

### Agent folders

An agent that lives in this repo (the Assistant, Scout, Myos) has its own
folder under `agents/<id>/` as its registry `cwd`, with a `CLAUDE.md` that
says what it does. A turn there loads that file, every `CLAUDE.md` above
it up to the repo root, and skills from the folder's `.claude/skills/` and
the root's. `.claude/settings.json` and `.mcp.json` are read from the
folder only and are not inherited from the root. A built-in agent names
its folder in `registry/builtin.json` as `folder`, relative to the repo.

A registry entry whose `cwd` does not exist, or is not a directory, still
loads; only a `cwd` that is not an absolute path is a problem that rejects
the file. `lib/registry.mjs` marks the entry `folderMissing: true`, and the
hub never starts such a persona: it is `unavailable` with `lastError`
`folder_missing`, the row says "Folder missing", and the composer says
"CFO's folder is missing." Its chat still opens and reads from the thread
cache; a send is 409 `persona_unavailable`, and a routine's run fails with
`agent_unavailable`, as for any persona that is not started. Every poll
re-checks the loaded entries' folders, so a folder created later (or one
that goes away) takes effect within a few seconds without touching the file.

### Avatars

Each agent has a round picture beside its name in the agents list (the
pinned agent included), the thread header, quick chat's picker (its
button and each row), the notifications list, the lines of a delegation,
and a message another agent sends. The picture is the first of
`avatar.png`, `avatar.jpg`, and `avatar.webp` found in the agent's folder
(its registry `cwd`), or, when the registry entry has an `avatar` key, that path,
relative to the `cwd` or absolute, for an agent whose folder is its own
repository. A path that does not resolve does not fall back to the
lookup. PNG, JPEG, and WebP only, judged by extension (no SVG), at most
512 KiB. Anything else, a missing file, or a bad path shows the agent's
initials instead, and a file that was found or named but cannot be used
is logged once as `avatar_skipped` with the agent's id and a reason
(`missing`, `wrong_type`, `not_a_file`, or `too_large`). The initials
are the first letters of the first two words of the agent's name, or the
first two letters of a one-word name, on one of the `--badge-0` to
`--badge-5` colors the Feed's source circles use, chosen from the
agent's id so it never changes.

The snapshot's agent entry carries `avatar`: null, or the picture's
modification time in milliseconds as a string. The client loads
`/api/agents/<id>/avatar?v=<avatar>`, so a replaced file is a new URL.
The daemon reads the file when the registry loads or changes and on each
status refresh (every `/api/state` and `/api/dashboard/status`); nothing
watches it, so a picture added to a folder shows the next time the page
loads its state.

### State in the snapshot

At startup the hub starts each persona in the registry and follows its
events. Each persona in `agents` carries:

- `state`: `idle`, `busy`, `waiting` (on a question or approval), `error`
  (the last turn failed), or `unavailable`.
- `pending`: null, or the open request as `{ requestId, kind, toolName,
  input, truncated }`. `kind` is `question` or `approval`. An approval's
  `input` is the tool input as JSON text; over 16 KiB it becomes the first
  16 KiB of that text, with `truncated: true`. A question's `input` is the
  object, never cut, so every question and option is there to answer.
- `forwarded`: the open requests other agents raised while answering a
  delegation that started in this thread, each shaped as `pending` is plus
  `agent`, the owner's id, oldest first; `[]` when none. A relay never
  changes this agent's `state` or `pending`. It is dropped when the request
  resolves (any outcome), when the owner's turn fails, when the registry
  drops either agent, and by New thread on this thread.
- `needsYou`: true when a routine of this agent last ended `waiting`, on a
  card never answered, and nothing has been written in the thread since
  by Hunter himself (a user message with neither `from` nor `routine`).
  Derived from the runs log and the thread, never stored.
- `lastMessage`: null, or `{ role, text, at, from? }` with the first 200
  characters (a brief notice's `summary` stands in for its text; `from` is
  the sending agent's id when another agent sent the message). At
  startup it comes from the thread cache. A bookkeeping line (a system
  message with a `kind` other than `brief`, such as the model line) never
  becomes it, on an event or at startup: the row keeps the thread's real
  last message.
- `lastError`: null, or why the last turn failed or why the persona is
  unavailable: `provider_unavailable` (its provider runs no personas; a
  `codex` persona stays unavailable, since Codex threads are followed as
  sessions instead), `api_key_in_env`, `sdk_unavailable` (the SDK package
  could not be loaded; run `npm ci`), `start_failed` (its session pointer
  could not be read), or `folder_missing` (its registry `cwd` is not a
  directory; Agent folders, above).
- `costUsd`: null, or the session's running total.
- `lastLineAt`: null, or when the daemon last wrote a line into the thread
  outside the agent's own turn that is not its last message: a
  delegation line landing after a pending reply. The thread view fetches
  again when it changes.
- `model` (Claude personas only): `{ id, effort, source, default, agent }`,
  what the next turn runs on. `id` is a model id or alias or null, `effort` one
  of `low`, `medium`, `high`, `xhigh`, `max`, or null; null means Claude
  Code's own default. Each resolves on its own: the thread's own choice
  over the registry's `model` over the settings' `model.default`, and the
  thread's choice over the settings' `model.effort` for effort. `source`
  names the level that set either: `thread`, `agent`, `system`, or
  `default` when none did. `default` is the pair without the thread's
  choice, what New thread or "Use the agent's default" returns to. `agent`
  is the registry's own `model` and `effort`, null where the entry sets
  none; the settings form edits that pair.
- `permission` (Claude personas only): `{ level, source, agent, default }`,
  the level the next turn runs at: `ask`, `auto`, or `full`
  (`lib/permissions.mjs`). The registry's `permission` over the settings'
  `permission.default`, which always has a value; `source` is `agent` or
  `system`. `agent` is the registry's own level or null, and `default` the
  settings level; the settings form edits the first and the Settings card
  the second. What each level does is under Turns.
- `accepts` (personas): the registry's `accepts` list, or null for
  everyone. The settings form edits it, and the ask tool enforces it
  (Delegation, below).

The snapshot's `settings` is the settings file's view (`lib/settings.mjs`,
below): `ok` false with `error` when the file could not be read, and the
last good values either way. `models` is the model table
(`lib/models.mjs`), `[{ id, name }]` in display order; the ids are the
Claude Code aliases (`fable`, `opus`, `sonnet`, `haiku`), which follow each
family's current model, each confirmed with `claude -p --model <id>`.

A persona whose turn runs longer than 30 minutes (`TIMEOUTS.turnMaxMs`) is
interrupted, the timeout is logged as `persona_turn_timeout`, and its
`lastError` reads `turn_timeout` until the next turn. The clock covers the
whole turn, including time spent waiting on an answer, so a question raised
at minute 10 has 20 minutes left. Personas added to the registry are
started; removed ones are dropped. A persona whose `cwd` changes in the
registry keeps its session pointer and its working folder (logged as
`persona_cwd_changed`): the adapter pins the folder when the persona starts
or first takes a turn and moves it only on New thread, so an old session is
never resumed in a new folder.

### Persona routes

Each route names the agent by its registry id. An id not in the registry is
404 `no_such_agent`; an agent of another kind is 409 `not_a_persona`; a
persona that is unavailable (`provider_unavailable`, `api_key_in_env`,
`sdk_unavailable`, `start_failed`, or `folder_missing`) is 409
`persona_unavailable`, except that `thread` still reads for
`folder_missing`. POSTs follow the usual rules:
exact `Origin`, JSON for `send` and `answer`, no body for `interrupt` and
`new-thread`.

| Route | Success | Refusals |
| --- | --- | --- |
| `POST send` `{"text": "...", "mentions"?: ["cfo"]}` | 202 `{"ok": true}` | 400 `invalid_body` (JSON that is not an object), 400 `invalid_text` (missing or blank), 400 `invalid_mentions` (not an array of at most 20 agent ids; ids the registry does not list are dropped, not refused), 400 `invalid_context` (not `{ view, label?, detail? }` with `view` one of agents, feed, brief, focus, goals, health, `label` at most 200 characters, `detail` at most 2000), 413 `payload_too_large` over 16 KiB of text or 32 KiB of body, 409 `busy`, 503 `shutting_down` |
| `POST answer` `{"requestId", "answers"}` or `{"requestId", "decision"}` | 200 `{"ok": true}` | 400 `invalid_answer`, 413 `payload_too_large` over 32 KiB, 409 `no_such_request` |
| `POST interrupt` | 200 `{"ok": true}` | |
| `POST new-thread` | 200 `{"ok": true}` | 409 `busy`, 503 `shutting_down`, 500 `thread_reset_failed` |
| `GET thread` | 200 `{"messages": [...]}` | |

`send` answers as soon as the turn has started and never waits for it; the
reply and any questions arrive in the state. `answers` maps question text to
a label or a list of labels; `decision` is `allow` or `deny`. `interrupt`
answers before the turn has wound down. `thread` returns the cached messages,
oldest first.

### Cost guards

Persona turns must bill the Claude subscription. Two guards stand in front
of the adapter's own refusal of an API-key turn:

- If `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` is set when the server starts,
  it creates no persona runtime and logs `adapters_disabled`; every persona
  is unavailable with `api_key_in_env`.
- `bin/dashboard-install` refuses to render or install while either is set
  in its environment.

### Shutdown

On SIGTERM or SIGINT the server ends the event streams and refuses new
sends, new threads, new event streams, and `POST /api/sessions/refresh`
with 503 `shutting_down`, then closes the adapters in parallel: the Claude
adapter drains the personas (turns waiting on an answer are aborted at
once, running turns get up to 30 seconds (`TIMEOUTS.drainMs`), and the rest
are aborted and given 2 seconds (`TIMEOUTS.abortGraceMs`) to end), and the
Codex adapter stops its poll and closes its socket, leaving pending
requests on the app-server. Then it closes the cmux client's socket
(`cmux.close()`), the hub, the registry poll, and the bindings poll, and
finally the server, which cuts requests still open after 5 seconds
(`TIMEOUTS.shutdownMs`). The process exits with status 1 if all of this has
not finished 38 seconds after the signal (those three, plus one second), or
if the shutdown itself fails. The installer refuses to unload a dashboard
with busy or waiting personas unless given `--force`, and waits up to 40
seconds for it to exit; see [docs/operations.md](docs/operations.md).

### Thread files

`lib/threads.mjs` keeps two files per agent in `DASHBOARD_THREADS_DIR`
(created with mode 0700; the files are 0600):

- `<agent-id>.json` holds the session id, when it was first seen, and the
  thread's own `model` and `effort` when one was chosen (each absent
  otherwise). It is the only durable file a persona has here, and it is
  replaced atomically (temporary file, fsync, rename). A choice made before
  the first message is kept with a null session id. If the file is lost,
  the next message starts a new session. The transcript itself stays with Claude Code under
  `~/.claude/projects/`.
- `<agent-id>.jsonl` is a display cache of the thread, one message per line.
  It is capped at 200 messages and 1 MiB; past either cap it is rewritten
  with the newest messages that fit under both. Message text is cut at
  8 KiB and marked `truncated`. A partial last line left by a crash is
  skipped on read. Losing this file only empties the thread view.
- `brief-notices.json` records which morning notices `lib/notices.mjs` has
  posted into the thread of the agent the settings name (`brief.agent`),
  as `{ version: 1, posted: { "<date>": ["ready", "failed"] } }`, replaced
  atomically. With "No thread" chosen (`brief.agent: null`), nothing is
  posted (logged as `notice_skipped` with reason `no_target`) and the
  pair is recorded here anyway, as handled: choosing a thread again later
  never backfills a notice from while none was set, only later ones post.
  (A named agent that has not started yet is different: that pair is left
  unposted, logged with reason `agent_not_started`, and does post once the
  agent starts.) The brief run writes
  `notice-<date>.json` beside each viewer; the daemon reads the newest two
  on start, on each event stream connect, and once a minute while a stream
  is open, and posts every date and state not recorded here as a system
  message with `kind: 'brief'`, `date`, `state`, `summary`, and the memo
  as `text`. Delete this file and the two newest notices post again.

The agent id must match the registry's id pattern before any path is built.

### Settings file

`lib/settings.mjs` owns one file, `DASHBOARD_SETTINGS_PATH`:

```json
{ "version": 1, "model": { "default": null, "effort": null }, "brief": { "agent": "assistant" }, "permission": { "default": "ask" } }
```

`model.default` and `model.effort` are the system level of the resolution
above; `brief.agent` is the agent whose thread receives the morning notice,
or null for no one; `permission.default` is the level an agent's turns run
at when its registry entry sets none, one of `ask`, `auto`, `full`, never
null. A file from before the key loads as `ask` and gains the key on its
next write. The daemon reads the file once at start. On the first
start, when there is no file, it writes this document with `brief.agent`
set to the first pinned Claude persona in the registry (or null) and logs
`settings_seeded`; no agent id lives in code. A present file is left alone.

A file that cannot be read (bad JSON, a version other than 1, an unknown
key, a bad value, over 64 KiB) is logged once as `settings_error`, the
last good values stay in force, and the snapshot's `settings.ok` is false.
Saves are then refused with 409 `settings_invalid` until the file is fixed
or deleted, so a hand edit is never overwritten by a merge over the last
good copy.

`PUT /api/settings` takes a partial patch, `{ model?: { default?,
effort? }, brief?: { agent? }, permission?: { default? }, quickChat?: {
agent? } }`, in a body of at most 4 KiB with a
same-origin `Origin` and a JSON content type. The store merges it, writes
the file atomically (temporary file with mode 0600, rename; the directory is
created 0700), and answers 200 `{ ok: true, settings }` with the whole
document; the hub then commits `settings` and the agent views that moved.
Refusals, in order: 400 `invalid_body` (not an object, empty, or keys other
than the five), 400 `invalid_model` (not null or 1 to 64 characters), 400
`invalid_effort`, 400 `invalid_agent` (not null or an agent id), 400
`invalid_permission` (not one of the three levels; null is refused), 400
`invalid_quick_chat_agent` (not null or an agent id), 404
`no_such_agent` (`brief.agent` or `quickChat.agent` names no Claude persona
in the registry; null is allowed),
409 `settings_invalid`, 503 `shutting_down`, 500 `settings_write_failed`
(logged as `settings_write_error`).

### Registry writes

`PUT /api/agents/<id>/settings`, `POST /api/agents`, and `DELETE
/api/agents/<id>` (`lib/agent-settings-routes.mjs`) are the three routes
that write the registry file, through `registry.write(mutate)` in `lib/registry.mjs`. A
body carries every field: `name`, `role`, `group`, `description`, `cwd`
(absolute), `model` (null or an id or alias), `effort` (null or a level),
`accepts` (null or a list of agent ids; null means everyone and writes no
key, an empty list means no one and writes `accepts: []`, a non-empty list
writes only those named), `pinned` (boolean), and
for a create `id`; `permission` (`ask`, `auto`, `full`, or null for the
settings default, which writes no key) may be left out, so a body from
before the control existed still saves, and a level that is not one of
the three is 400 `invalid_permission`; `newGroup: { id, name }` adds a group whose id no
listed group has (one that does joins it) and `group` must equal its id.
A created agent is kind `persona` on `claude`; project and system entries
are still hand edits. The entry is written in the schema's key order with
its `jobs`, an `avatar` path, and a `builtin` flag kept (no body sets either), and the whole file as 2-space JSON with a trailing
newline, so a dashboard write reads as a small diff; unrelated top-level
keys are kept. The write is atomic (a temp file beside the registry,
renamed over it, with the file's mode kept), the registry reloads at
once, and the hub picks the change up through `registry.onChange`: an
edited agent lands in one snapshot revision, a new one in two
(unavailable, then idle once its adapter has started). Writes are
serialized. A missing file is created by the first valid write (mode
0644); a file that does not load is not written over.

Refusals, in order: 400 `invalid_body`, 404 `no_such_agent`, 409
`not_editable` (not a persona), 409 `duplicate_id` (create), 409
`registry_invalid` with `{ "problems": [...] }` while the file on disk
does not load (fix or delete it by hand), 503 `shutting_down`, then 400
`invalid_registry` with `{ "problems": [...] }` when the validator refuses
the result (each string names the field and the rule; the only error body
in the app that carries detail, since the form shows the reason), and 500
`registry_write_failed` (logged as `registry_write_error`). The body is
capped at `limits.agentBodyBytes` (16 KiB; 413 `payload_too_large`). A
changed `cwd` applies when the agent's next thread starts, since the
adapter pins a thread's folder; the response then carries `"note":
"cwd_applies_on_new_thread"`. Without a writable registry (tests pass a
read-only fake) both routes are 404.

### Turns

- One turn per persona at a time. A second message while a turn is running
  is refused as `busy` before the SDK is called, because two resumes of one
  session both succeed and split its history.
- A routine's run runs in a session of its own in the agent's folder, with
  the same options and tools, at the agent's level (Routines, below).
- Each turn resumes the stored session in the thread's pinned folder with
  `maxTurns` 25 and the SDK permission mode the agent's level maps to
  (`permission` in the snapshot, the registry's level over the settings
  default; `lib/permissions.mjs`), so the global `auto` mode never applies
  on its own and the tools hook cannot change it. Every turn also runs
  with the Claude Code preset system prompt, so an agent behaves as its
  repo's CLAUDE.md expects; CLAUDE.md itself loads through the default
  setting sources. The preset carries an `append` from the agent's
  registry entry: "You are Myos, one of Hunter's agents in his personal
  assistant system. Your role: Guide. In your own words: …", so an
  agent knows which entry it is whatever its folder holds. The SDK records it on a
  session's first request, so it reaches an existing thread, and a rename
  takes effect, only after New thread:

  | Level | `permissionMode` | Also |
  | --- | --- | --- |
  | `ask` | `default` | |
  | `auto` | `auto` | |
  | `full` | `bypassPermissions` | `allowDangerouslySkipPermissions: true` |

  Ask raises a card for every tool outside the allow rules; Auto lets
  Claude Code's classifier decide and raises a card only when it is unsure;
  Full access never raises an approval card. A `canUseTool` callback is
  passed at every level; without one the SDK removes `AskUserQuestion`,
  and at Full access a question the model puts to Hunter still comes
  through as a card. A delegated hop runs at the receiver's level. The
  `persona_init` log line carries the mode the SDK took beside the level
  requested; when they differ (Auto is per model, and
  `permissions.disableAutoMode` can refuse it) one
  `persona_permission_mismatch` line names both and the turn goes on. A
  level that is not one of the three is refused `invalid_permission`.
- Each turn runs on the model and effort the hub resolves for the agent
  (`model` in the snapshot, the thread's choice first): `model` and
  `effort` are passed to the SDK only when set, so a null leaves Claude
  Code's own default in force. A model the CLI rejects ends the turn in
  error with the CLI's explanation, which names the model, as `lastError`.
- `POST /api/agents/<id>/model` takes `{ model?, effort? }` with at least
  one key; a present key replaces the thread's choice, null returns it to
  the agent's default, an absent key keeps it. It writes the pointer and a
  system line (`{ kind: 'model', model, effort }`) into the cache and
  answers `{ ok: true, model: { id, effort, source } }`. Refusals: 409
  `busy` while a turn runs, 400 `invalid_model` (not null or 1 to 64
  characters) or `invalid_effort`, 409 `not_supported` for a Codex agent,
  503 `shutting_down`.
- `AskUserQuestion` becomes a question. Any other tool that needs
  permission becomes an approval that carries the tool name and its full
  input. The turn waits for an answer. After 30 minutes without one, the
  request is denied with "No answer within 30 minutes". The turn clock
  keeps running while it waits, so the whole turn, waiting included, is
  bounded by `turnMaxMs`. The persona stays busy after a denial until the
  SDK reports the turn's result, since the model keeps working.
- A request raised during a delegated turn is also shown in the thread the
  exchange started in (`forwarded` in the snapshot), and an answer posted to
  either thread settles it once. The route tries the thread's own adapter
  first and, when that refuses `no_such_request`, the owner the hub names
  for the forwarded card.
- Interrupt aborts the turn and denies any open request. New thread is
  refused while a turn runs or the server is shutting down; otherwise it
  deletes both files, and the cache starts again with a "New thread" line.
  New thread also drops the cards forwarded to the thread; they stay
  answerable in their owners' threads.
- The result message's `total_cost_usd` is a running total for the
  session, not the cost of one turn. It is reported with the token usage
  and the list of denied tool calls.
- If a stored session cannot be resumed, the turn fails with "The stored
  session could not be resumed. Start a new thread." The pointer is kept
  until New thread clears it.
- A turn that would bill an API key (the SDK reports an `apiKeySource` other
  than `none`) is aborted at once and fails with "Refused: this turn would
  bill an API key", naming the source.
- A result that arrives before the session's init message (a startup
  failure) never replaces the stored pointer.
- At shutdown, new messages and new threads are refused as
  `shutting_down`. Turns waiting on an answer are aborted at once, running
  turns get up to 30 seconds to finish, and any still running are aborted
  and given 2 seconds to end.

### Delegation

Every Claude agent's turn carries one in-process MCP server, `agents`,
with one tool, `ask({ to, message })` (`lib/delegation.mjs`). The adapter
attaches it through its `turnTools` hook (`lib/runtime/claude.mjs`): the
hook's result is copied by name, `mcpServers` and `allowedTools`, never
spread, so it cannot change `permissionMode` or anything else about the
turn. The tool's description lists the other agents that take messages
from the sender (`accepts` absent or null means everyone), with each one's
id, name, role, and description. The sender is the agent whose turn is
running; the tool's arguments cannot name another.

The same server carries `notify({ text, link? })` when the daemon has a
notification store: one sentence (at most
`LIMITS.notificationTextChars`, 500) and an optional link (Notifications,
above), raised under the agent whose turn is running and answered with
the id. An empty or long sentence or a link in no known shape is refused
to the model in one sentence and nothing is stored. Nothing is posted in
any thread. Both tools are in `allowedTools`, so neither raises a card.

- The message runs as a turn of the receiver through its own adapter. The
  receiver's thread shows it as written, with `from` the sender's id, and
  the model gets `From <sender>, an agent in this system (not the user):
  <message>`. Replies the receiver gives are its own messages in its
  thread; the sender's thread gets lines.
- Lines in the sender's thread are system messages with
  `kind: 'delegation'`, `state`, `to`, `text`, `summary`, and
  `delegationId` (a refusal carries `reason` instead): `sent` ("Messaged
  CFO"), `busy` (the receiver has a turn open), `waiting` (the receiver
  raised a question or approval; the line links to its thread), `finished` (`text` is the reply, `summary`
  its first sentence; the view prefixes "CFO replied:"), `failed` (the
  turn ended with no text after an error, an interrupt, or a timeout), and
  `refused` with reason `unknown`, `not_an_agent` (a project folder),
  `unavailable`, `not_allowed`, `cycle` (the receiver is the sender or
  already in the chain), or `depth`. The sentences are the ones the view
  renders; a line never becomes the row's preview.
- The checks run in that order: unknown, not an agent, unavailable,
  accepts, cycle, depth; then the receiver's adapter refuses `busy`
  before any await.
- A question or approval the receiver raises is relayed by the hub to the
  thread the exchange started in (`chain[0]`), under the receiver's name,
  with "Asked while answering you." beneath the title; the agent in the
  middle of a two-hop exchange keeps only its waiting line. Allowing or
  answering it from either thread settles it for both.
- A routine run's `ask` is quiet: it posts no lines to the sender's thread,
  queues no late reply, and takes no pending replies into the run. The
  receiver's thread and a card it raises still behave as above.
- The tool waits `delegationWaitMs` for the receiver's turn to end and
  answers with the reply text alone. Past that it answers "<name> is
  still working. The reply will arrive in this thread." (what the tool
  answers is prose the model may repeat, so it carries no id); the
  finished or failed line posts when the turn ends, and the reply is kept
  for the sender's next own turn (a turn the user starts, never a hop from
  another agent), for the session the ask was made in (New thread drops
  it), at most `delegationPendingReplies` newest. That turn's prompt
  starts with "Replies that arrived since your last turn:" and one
  `From <name> (<delegationId>): <reply>` per reply, then the user's text;
  the thread shows only the text. The replies count as delivered once the
  turn's init arrives; a turn that fails before it offers them again.
- When the user's message mentions agents, the prompt ends with
  "Agents mentioned: <Name> (id `<id>`), ..." so the model has each id.
- Nothing here throws into the SDK: a line the store refuses or any other
  failure is logged as `delegation_error` and answered as a sentence. The
  log also carries `delegation_sent`, `delegation_refused` (reason), and
  `delegation_finished` (status, `waitedMs`, `inline`). A hook that throws
  is logged as `persona_tools_error` and the turn runs without the tool.

### Routines

A routine (Routines under State, above) runs through `lib/scheduler.mjs`
in a fresh session of its own in the agent's current folder. The model gets
`Routine "<name>" (a scheduled run, not the user): <instruction>` followed
by `You may ask other agents. Your reply is recorded in this routine's log,
not shown as a message; if something in it needs Hunter's attention, use
notify.` The turn resolves `{ text, error, aborted }`; it does not resume or
write a session pointer or thread cache, and it emits no message event. It
uses the model, effort, tools, and permission level the hub resolves for the
agent. A card it raises is the agent's own `pending`, answered as any other;
a hop's card is forwarded to the agent's thread as any delegation's is. The
`persona_init` log line carries `routine: <id>`.

A run failure belongs to the run: the end line carries its `detail`, no
thread error event or `lastError` is set, and the agent returns to idle. A
run's quiet `ask` leaves no sender lines or queued late reply and does not
take pending replies from earlier turns. The waiting line described below
is the only routine message a new run can append to the thread.

The scheduler ticks every 30 seconds (`TIMEOUTS.routineTickMs`). For each
active routine whose agent is a Claude persona, the marker is the newest
of the runs log's newest occurrence, the routine's `updated`, and seven
days ago (`LIMITS.routineCatchupDays`); when the latest occurrence at or
before now is after the marker, the occurrences between them become one
`missed` line (`count` up to `LIMITS.routineMissedMax`, with `capped`
when the cap stopped it) and the latest runs, with `trigger` `schedule`
when it is under a minute old and `catchup` when the daemon was down for
it. A run leaves one line whatever happens, so a busy or failed fire
still moves the marker; an edit or a reactivation bumps `updated`, so
nothing from before it is due. Runs the last process left open are
closed as `interrupted` when the daemon starts. `POST
/api/routines/<id>/run` is a run outside the schedule, `trigger` `test`
with `occurrence` null, so it never moves the marker; it answers 409
`busy` while the agent has a turn open and 409 `agent_unavailable` when
it is not started, writing nothing. A run given a `context` carries it on
its start line, so Last runs shows it.

Each run's end line may carry `reply`, cut at `LIMITS.routineReplyChars`
with `truncated: true`, and `detail`. Its outcome is `finished` when the turn ended with every card
answered, `waiting` when a card was raised and not answered (it expired,
the turn was interrupted, or it was still open when the turn ended),
`failed` when the turn errored or the agent was not started
(`detail: agent_unavailable`), `busy` when the agent had a turn open at
the occurrence, and `interrupted` with `detail: interrupted` when the
detached turn was aborted. A run the daemon left open is also closed as
`interrupted` without that detail. The
end line lists the cards as `{ agent, kind, toolName, summary, resolved }`.
On the first card of a run the scheduler posts one line to the agent's
thread, `{ role: "system", kind: "routine", state: "waiting", routine,
agent, toolName, summary, text }`, "CFO is waiting for you during Daily
drift." with the input's first 120 characters as `text`; it is
bookkeeping (`lastLineAt`), never the row's preview. The thread renders it
centered like a delegation line, opening to `text`. A run that ended
`waiting` sets the agent's `needsYou` until Hunter writes in the thread.
The log line `routine_run` carries the routine, agent, trigger, outcome,
and duration; `routine_log_error` and `routine_line_error` a run line or
thread line the store refused; `routine_tick_error` a tick that threw.
None carries the instruction, the prompt, or a tool input.

### What runs without a card

Only tool calls that reach `canUseTool` produce a card. These do not:

- Tools covered by allow rules in `~/.claude/settings.json` or the repo's
  `.claude/settings*.json`. Today that is the global test, build, lint, and
  typecheck commands in every repo, plus `git worktree`, `git branch`, and
  `git push` in nowgentic.
- File reads inside the working directory and read-only shell commands.
- Skills. The Skill tool never asks, though tools a skill then calls go
  through the usual checks.
- The ask tool (`mcp__agents__ask`), which the daemon names in
  `allowedTools` on every turn. Its bounds are the daemon's, not a card.
- Every tool, for an agent at Full access (Turns, above): the SDK skips
  the permission checks, so no approval card is raised. A question the
  model asks still shows.

Subagents are not on this list. Their tool prompts reach the same callback
(the SDK passes the subagent's `agentID` in the callback options), so they
raise cards like the parent's.

The audit behind this list is
`thoughts/shared/research/2026-09-25-claude-sdk-spike.md` in the umbrella
directory.

### Limits

| Constant | Value | Meaning |
| --- | --- | --- |
| `LIMITS.turnMaxTurns` | 25 | SDK `maxTurns` for one persona turn |
| `LIMITS.messageTextBytes` | 8 KiB | Text kept per message, in events and the cache |
| `LIMITS.threadCacheMessages` | 200 | Messages kept per cache file |
| `LIMITS.threadCacheBytes` | 1 MiB | Bytes kept per cache file |
| `TIMEOUTS.requestMaxAgeMs` | 30 minutes | An unanswered question or approval is denied |
| `LIMITS.sendTextBytes` | 16 KiB | Text of one message sent to a persona |
| `LIMITS.requestInputBytes` | 16 KiB | A pending approval's input, as JSON, in the snapshot; questions are never cut |
| `LIMITS.previewChars` | 200 | Characters of a persona's last message in the snapshot |
| `TIMEOUTS.drainMs` | 30 seconds | Wait for running turns at shutdown |
| `TIMEOUTS.abortGraceMs` | 2 seconds | Wait for aborted turns to end after the drain |
| `TIMEOUTS.turnMaxMs` | 30 minutes | A persona turn, time waiting on an answer included, is interrupted after this |
| `LIMITS.notificationsMax` | 200 | Notifications kept; acknowledged ones roll off first |
| `LIMITS.notificationTextChars` | 500 | Characters of one notification's sentence |
| `LIMITS.delegationDepth` | 2 | Agents a message may pass through before the sender: the user asks A, A may ask B, B may ask C, C may not ask |
| `LIMITS.delegationMessageChars` | 4000 | Characters of one ask tool message |
| `LIMITS.delegationReplyChars` | 4000 | Characters of a reply handed back to the sender's turn or prepended to its next prompt |
| `LIMITS.delegationPendingReplies` | 5 | Replies carried into the sender's next turn |
| `TIMEOUTS.delegationWaitMs` | 5 seconds | How long the ask tool waits for the receiver before answering pending |
| `LIMITS.codexThreads` | 20 | Codex threads listed and followed; past that the oldest idle unbound thread is dropped |
| `LIMITS.codexFrameBytes` | 1 MiB | One frame from the Codex app-server; a larger one is dropped |
| `TIMEOUTS.codexPollMs` | 3 seconds | How often the Codex adapter checks `owner.json` and the daemon checks `bindings.json` |
| `TIMEOUTS.codexReconnectMs` | 1 second | First wait before reconnecting to the Codex app-server |
| `TIMEOUTS.codexReconnectMaxMs` | 30 seconds | The reconnect wait doubles up to this |
| `TIMEOUTS.codexRpcMs` | 15 seconds | One request to the Codex app-server must be answered within this |
| `TIMEOUTS.sessionsPollMs` | 10 seconds | The cmux inventory and Codex catalogue refresh while any event stream is open |
| `TIMEOUTS.cmuxRequestMs` | 5 seconds | The cmux auth handshake, and separately each socket request |
| `TIMEOUTS.cmuxSessionsMs` | 5 seconds | One `cmux sessions list --json` |
| `TIMEOUTS.cmuxStaleMs` | 5 minutes | How long a cached cmux inventory is served stale after a transient failure |
| `LIMITS.cmuxFrameBytes` | 1 MiB | One line from the cmux socket; a longer one drops the connection |

## Runtimes

`lib/runtime/` holds one module per program the daemon talks to. The
Claude persona adapter is described under Personas above.

### cmux

`lib/runtime/cmux.mjs` lists the terminals open in cmux and the agent
sessions cmux has registered, and focuses one exact terminal. The hub
reads its inventory into `sessions` and `cmux` (see Sessions in the
snapshot) and the `open-terminal` route calls its focus.

cmux only admits processes it started itself unless its socket mode is
changed, so the daemon needs one setting made once: in
`~/.config/cmux/cmux.json`, `automation.socketControlMode` set to
`password`, and a password file. Verified on 2026-09-28 with cmux 0.64.25:
a file written to `~/Library/Application Support/cmux/socket-control-password`
before launch is adopted and moved by cmux to
`~/.local/state/cmux/socket-control-password`, where it stays across quits;
nothing was set in cmux's Settings. From a shell, `cmux ping` then answers
`PONG` with no password flag or variable. The steps are in
[docs/operations.md](docs/operations.md).

Every call starts by reading two files. cmux writes its socket path to
`~/.local/state/cmux/last-socket-path` (`DASHBOARD_CMUX_SOCKET_PATH_FILE`)
on launch and deletes it on quit, so a missing file means cmux is not
running. The password comes from `DASHBOARD_CMUX_PASSWORD_FILE`, by default
the state file above. The password is sent as the first line of a new
connection and then dropped; it never appears in a log entry, an error, or
an answer. The handshake and each later request get their own
`TIMEOUTS.cmuxRequestMs`.

The module speaks to cmux two ways:

- Over its Unix socket, one connection shared by every call: `auth
  <password>`, then newline-delimited JSON-RPC. `workspace.list` and
  `surface.list` (once per workspace) build the inventory;
  `surface.focus`, always with both the workspace and the surface id,
  focuses; `system.identify` reads the focused surface back.
- `cmux sessions list --json`, run as a subprocess with `CMUX_QUIET=1`,
  lists the agent sessions. It reads cmux's hook store and needs no
  socket. The binary is `DASHBOARD_CMUX_CLI`, by default the one inside
  the app bundle, because the LaunchAgent's `PATH` does not include
  `/opt/homebrew/bin`, where the cask links `cmux` for shells. A missing
  binary is logged once as `cmux_cli_missing`. A session appears in the
  listing only when its agent was started from a cmux terminal (cmux's
  wrapper on `PATH` registers it); one started from another terminal is
  invisible to the dashboard.

`inventory()` answers

```json
{ "available": true, "stale": false, "refreshedAt": "<ISO>",
  "workspaces": [{ "id": "<uuid>", "name": "~", "cwd": "/Users/hunter" }],
  "surfaces": [{ "id": "<uuid>", "workspaceId": "<uuid>", "paneId": "<uuid>", "title": "Terminal", "cwd": "/Users/hunter" }],
  "agents": [{ "sessionId": "<uuid>", "agent": "claude", "state": "running", "cwd": "/Users/hunter/repo",
               "workspaceId": "<uuid>", "surfaceId": "<uuid>", "startedAt": "<ISO>", "updatedAt": "<ISO>", "live": true }] }
```

`state` is cmux's `agent_lifecycle`: `running` (working, or sitting at
an empty prompt), `idle`, or `needsInput`. `live` is true only when the
agent's surface is in the listing under the agent's workspace; a false
one is a terminal that has closed, and the view should say so instead of
offering to open it. When cmux cannot be reached the lists are empty and
`available` is false with a `reason`: `not_running`, `no_password`,
`auth_failed` (a refused password, or the default socket mode; logged
once, not per call), or `error`. A timeout, a dropped or refused
connection, an oversize frame, a listing that fails to parse, a
`surface.list` reply without its array or for another workspace than the
one asked for (`surface.list` with no workspace answers for the selected
one, so the reply's `workspace_id` is checked), or every workspace
answering `not_found`, is transient: after at least one good answer it
returns that answer again with `stale: true`, for up to
`TIMEOUTS.cmuxStaleMs`, then `error`. Answers are frozen.

`focus({ workspaceId, surfaceId })` lists that workspace's surfaces
again, and unless the surface is there it answers `{ "ok": false,
"reason": "not_found" }` without asking cmux to focus anything. Otherwise
it focuses and reads the focused surface back with `system.identify`.
cmux answers `surface.focus` before the focus has landed, so the read-back
is repeated up to five times, 100 ms apart (about half a second in all,
and never past `TIMEOUTS.cmuxRequestMs`). The answer is
`{ "ok": true, "verified": true }` as soon as one read-back names the
surface asked for, and `verified` false when the last one still names
another. The other reasons are the inventory's.

There is no push yet. cmux advertises `events.stream`, but the spike
recorded the CLI's view of it, not the socket request or how event frames
share a connection with replies. `refresh()` is the call the hub's
`refreshSessions()` makes: the event stream calls it once when its first
stream opens and every `TIMEOUTS.sessionsPollMs` (10 seconds) while any
stream is open, and `POST /api/sessions/refresh` calls it on demand.
Nothing polls while no browser has the dashboard open.

The module never starts cmux, never creates, closes, or moves a surface,
never sends text or keys, never focuses a surface it did not just see in
the workspace it was given, and never binds a terminal to a session by
guessing from a working directory.

## Codex sessions

Codex threads are not personas. Hunter drives them from their own terminals;
the dashboard follows them on a shared `codex app-server`, shows their state,
and answers their questions and approvals. Nothing here starts a Codex turn.
The protocol was verified on Codex 0.155.1
(`thoughts/shared/research/2026-09-28-codex-app-server-spike.md` in the
umbrella directory); the two feature flags it needs,
`features.default_mode_request_user_input` and
`features.request_permissions_tool`, are still marked under development and
are passed per launch by `bin/codex-serve`.

### Helpers

- `bin/codex-serve` owns the server. Run it in a terminal you keep open: it
  starts `codex app-server --listen unix:///<absolute path>/codex/app.sock`
  (the path is resolved to an absolute one first) with both
  feature flags, writes `codex/owner.json` (`socket`, `pid`,
  `startedAt`, `codexVersion`), and removes that file when the server
  stops: on Ctrl-C, SIGTERM, or SIGHUP the file goes first, then the
  signal is forwarded and the helper waits for the server to exit, which
  can take half a minute while a TUI is attached. It refuses while
  `owner.json` names a running process, and it
  refuses a socket path over 100 bytes, since macOS allows 104 for a Unix
  socket path; that is why the socket lives under `codex/` in the data root
  rather than a deeper directory. `--socket PATH` overrides the path.
- `bin/codex-new [--cwd DIR]` opens the Codex TUI on that server in the
  given working directory (default: the current one) and records the
  thread it starts. It connects to the server, runs
  `codex --remote unix://<socket> -C <cwd>`, waits for the
  `thread/started` notification whose cwd is that directory, writes the
  thread to `codex/bindings.json` with the cmux workspace and surface
  ids from `CMUX_WORKSPACE_ID` and `CMUX_SURFACE_ID`, drops its own
  connection, and exits with the TUI's status. The TUI must start the
  thread: one started over the socket has no rollout until its first
  turn, and `codex … resume <id>` on it fails with "no rollout found".
  The wait lasts as long as the TUI runs, because the thread is only
  started once the update nudge and the trust prompt are answered; the
  outcome is printed after the TUI exits. Outside cmux the ids are
  recorded as null and the helper says so; "Open terminal" is then
  unavailable for that thread. The file keeps the 200 newest records.
  One launcher waits per folder at a time: the server announces every
  new thread to every client, so a second launcher in the same folder
  could adopt the first one's thread. While waiting, the helper holds
  `codex/waiting/<sha256 of the real cwd>.json` with its pid, and
  another launcher that finds it held by a live pid refuses before
  starting anything ("Another codex-new is waiting in this folder");
  a marker whose pid is gone is taken over. The marker is removed once
  the thread is recorded or the TUI exits. A thread `bindings.json`
  already binds to other surface ids is left alone, and the helper says
  so. Writers to `bindings.json` take turns through `bindings.lock`
  beside it.

Both read `DASHBOARD_CODEX_DIR` (default `codex/` in the data root,
created with mode 0700) so they agree with the daemon.

### Runtime

`lib/runtime/codex.mjs` checks `owner.json` every 3 seconds
(`TIMEOUTS.codexPollMs`). A missing file, or one whose `pid` is no longer
running, means no server: the connection is dropped, `sessions` becomes
empty, and `codex.reason` is `no_server`. So does a socket that is not
there: two consecutive connection attempts failing with `ENOENT` or
`ECONNREFUSED` (the server closed its socket on Ctrl-C but is still
exiting, or its owner file outlived it) are logged once as
`codex_server_gone` and clear the rows; the file is still polled, and
nothing is retried until it changes. A file that appears, or that
names a new socket or pid (a `codex-serve` restart), starts a connection
to it: `ws` over the Unix socket with compression off, `initialize` with
`experimentalApi` on, then `initialized`. `ws` is loaded on first use, so
a checkout without `npm ci` still starts and reports `ws_unavailable`.

The catalogue is the union of two sets, re-read on every poll while
connected: the threads in `thread/loaded/list` (what the server holds in
memory for any client, including the TUI) and the newest 20 threads
recorded in `bindings.json` by `bin/codex-new`. Nothing else is resumed:
`thread/list` covers every thread in the local store, including ones open
in other app-servers (the VS Code extension, the ChatGPT app), and
resuming those fails with a thread-store conflict. A `thread/started`
notification adopts a thread at once; the poll catches one whose
notification was missed. Each followed thread is resumed with
`excludeTurns: true`, which subscribes the connection to it and, for a
thread still waiting on a question or approval, replays that request with
its original id, and its newest turn is read through `thread/turns/list`
for the last message and the running turn id. A thread that leaves both
sets, or is archived, is dropped.

A fresh thread has no rollout until its first turn, so its resume fails
with "no rollout found"; while the thread is loaded the adapter keeps the
row and retries with a doubling wait (6, 12, 24, then 30 seconds), and the
question from its first turn arrives with the resume that succeeds. The
same failure for a thread that is only bound means it does not exist on
this server; that, like any other resume failure (a timeout, an rpc
error), drops the thread for the rest of the connection and is logged
once. The next connection tries every thread afresh, so a transient
failure never loses a bound thread for the daemon's lifetime. Rows are capped
at 20 (`LIMITS.codexThreads`): past that, the oldest idle unbound thread
with nothing pending is evicted and skipped until the next connection;
busy, waiting, and bound threads are never evicted.

Reconnect rule: when the socket closes, every row goes `unavailable` with
`lastError` `server_gone` and `codex.reason` becomes `disconnected`; the
adapter reconnects after 1 second, doubling up to 30 seconds
(`TIMEOUTS.codexReconnectMs`, `codexReconnectMaxMs`), then lists and
resumes again, which restores the rows that are still loaded or bound and
drops the rest. Pending requests belong to the thread, not the
connection, so the server replays them on resume; the adapter keys every
reply by thread and request id and sends it on the current connection. A
request the server has since resolved, from the terminal or otherwise, is
`no_such_request`. Writes are never retried. A frame over 1 MiB
(`LIMITS.codexFrameBytes`) is dropped with an error and never parsed.

Replies are the narrowest the protocol allows. A question is answered
with `{ answers: { <questionId>: { answers: [text] } } }`, every question
at once. A command or file-change approval is `accept` or `decline`;
`acceptForSession`, policy amendments, and other grants are never sent. A
permission request is denied with an empty profile for the turn or granted
with exactly the permissions it asked for, also for the turn. A request
the dashboard cannot express (a command approval whose available decisions
lack `accept`, an MCP elicitation, or a request type this build does not
know) is shown with `native: true` and must be answered in the terminal;
answering it here is refused as `not_supported`.

### Sessions in the snapshot

`sessions` lists two kinds of row, newest first by `updatedAt`.

Every row carries `projectId`: the id of the registry project (kind
`project`) whose `cwd` is the session's cwd or a parent of it, the deepest
such project when several qualify, or null. The match is on the path
strings as given, not their real paths: a session in a symlinked or
otherwise differently spelled directory sits under no project. The
Agents view nests the row under that project. A registry change rebuilds
the list, so the ids follow an edit.

A Codex thread carries `id` (`codex:<threadId>`), `provider` `codex`,
`threadId`, `cwd`, `title` (the thread's name, else the first line of its
preview; null until the first resume, and the view then shows the
folder), `state` (`idle`,
`busy` while a turn runs, `waiting` on a question or approval, `error`
after a failed turn, `unavailable` while the connection is down), `pending` in the same
form as a persona's plus `native` when only the terminal can answer,
`lastMessage` cut to 200 characters, `lastError`, `updatedAt`, and
`binding`: the `{ workspaceId, surfaceId }` that `bin/codex-new` recorded
in `bindings.json`, plus `live`, true only while that exact surface is in
the last cmux inventory; null when nothing was recorded.

A Claude terminal, one cmux agent record whose `agent` is `claude`, carries
`id` (`claude:<cmux session id>`), `provider` `claude`, `kind` `terminal`,
`cwd` and `updatedAt` as cmux reports them, `state` (`busy` for cmux's
`running`, which is also an empty prompt, `idle` for `idle`, `waiting`
for `needsInput`, else `unknown`), and a `binding` that is always
present, its `live` false once the terminal has closed. A session id the
listing carries twice is one row, from the record with the newest
`updatedAt`. Terminal rows have no adapter: the dashboard
cannot answer, interrupt, or read them, only open their terminal. Codex
agent records in the cmux listing are ignored; the Codex adapter is the
source for those threads.

`cmux` beside `codex` says whether the inventory could be read:
`{ "available": true }` (with `"stale": true` while the client serves its
last good answer after a transient failure), or `{ "available": false,
"reason" }` with the client's reason (`not_running`, `no_password`,
`auth_failed`, `error`), `not_refreshed` before the first refresh, or
`no_client`.

The list, `codex`, and `cmux` are rebuilt on every adapter event, every
bindings change, and every `refreshSessions()`, which refreshes the cmux
inventory and asks the Codex adapter for one poll now, in parallel
(single-flight); the Codex poll is waited on for at most
`TIMEOUTS.statusMs` (2 seconds), and one that runs longer lands later as
an adapter event. A new
revision is committed only when something differs. The inventory is
refreshed when the first event stream opens, every 10 seconds while any
stream is open, and on `POST /api/sessions/refresh`; without an open
stream the last inventory stands, so `binding.live` may be out of date
until a stream opens again. The Codex adapter does not wait for that: it
polls `owner.json` and its catalogue every 3 seconds on its own, so the
interval only brings a poll forward. A refresh that throws is logged as
`sessions_refresh_error`. Once the hub is closed, `refreshSessions()`
does nothing, so shutdown never reopens the cmux connection, and the
route answers 503 `shutting_down`.

### Session routes

Each route names the session by its id, `codex:<threadId>` or
`claude:<cmux session id>`; an id not in `sessions` is 404
`no_such_session`, as is a thread the adapter dropped after the snapshot
listed it. POSTs follow the usual rules: exact `Origin`, JSON for
`answer`, no body for `interrupt`, `open-terminal`, and
`/api/sessions/refresh`.

| Route | Success | Refusals |
| --- | --- | --- |
| `POST answer` `{"requestId", "answers"}` or `{"requestId", "decision"}` | 200 `{"ok": true}` | 400 `invalid_answer`, 409 `no_such_request`, 409 `not_supported` (answer it in the terminal, or a terminal row) |
| `POST interrupt` | 200 `{"ok": true}` | 409 `not_supported` (a terminal row) |
| `GET thread` | 200 `{"messages": [...]}` | 503 `unavailable` (no connection), 404 `no_such_session` (dropped since it was listed), 409 `not_supported` (a terminal row) |
| `POST open-terminal` | 200 `{"ok": true, "verified"}` | 409 `unbound`, 503 `cmux_unavailable` (with `reason`), 409 `terminal_closed`, 502 `focus_failed` (with `reason`) |
| `POST /api/sessions/refresh` | 200 `{"ok": true, "revision"}` | 503 `shutting_down` |

`answers` maps a question's id (or its text) to a string or a list of
strings; `decision` is `allow` or `deny`. `thread` reads the user and
assistant messages of the last 20 turns from the app-server each time and
answers the newest 200 of them (`LIMITS.threadCacheMessages`); nothing is
cached to disk. There is no `send` and no `new-thread` for a session.

`open-terminal` focuses the cmux surface in the row's `binding` and
nothing else: it refuses `unbound` when the row has no recorded terminal,
`cmux_unavailable` (with the snapshot's `cmux.reason`, or `no_client`
when the dashboard runs without a cmux client) while the inventory
cannot be read, and `terminal_closed` when the bound surface was not in
the last inventory; otherwise it asks the client to focus that exact
workspace and surface, which lists the workspace again first, and answers
`verified` true when cmux reports that surface focused afterwards (read
back up to five times over about half a second, since the focus lands
after cmux's reply), or
`focus_failed` with the client's reason (`not_found`, `not_running`,
`no_password`, `auth_failed`, `error`). No route ever picks a terminal by
its working directory. `POST /api/sessions/refresh` refreshes the cmux
inventory and the Codex catalogue now and answers the revision after
that, as `/api/jobs/refresh` does for jobs; it waits for the
Codex poll no longer than `TIMEOUTS.statusMs` and answers with the
revision it has then.

### Logs

The Codex runtime logs, each with the fields named:

- `codex_server_found` (socket, pid, codexVersion), `codex_server_gone`
  (socket, pid, reason: `owner` when the file went or its pid died,
  `socket` when two connections in a row found no socket),
  `codex_owner_unreadable` (error code),
  `codex_owner_invalid` (reason: `oversized`, `json`, `shape`);
- `codex_ws_unavailable` (once), `codex_connect_error` (error code),
  `codex_socket_error` (error code), `codex_connected` (socket,
  codexVersion), `codex_initialize_error` (error: `timeout`,
  `rpc_error`, `connection_closed`), `codex_disconnected` (socket);
- `codex_catalogue` (threads, added, dropped; only when the set changes),
  `codex_catalogue_evicted` (threads), `codex_resume_error` (threadId,
  error: `not_persisted`, `timeout`, `rpc_error`, or `connection_closed`,
  and retry; logged once per thread), `codex_bound_error` (error code);
- `codex_request` (threadId, method, native), `codex_request_ignored`
  (method; a request for a thread it does not follow), `codex_answer`
  (threadId, method, outcome), `codex_interrupt` (threadId);
- `codex_frame_dropped` (bytes), `codex_frame_invalid`,
  `codex_write_error` (method, error code), `codex_poll_error` (error
  code), and `runtime_listener_error`.

None of them carries message text, question text, tool input, file paths
from a request, or a server's error message; errors are logged as codes.

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
  the invented brief JSON in a temporary directory, an in-memory registry
  and jobs, and personas on a fake Claude adapter over a thread store
  in that directory (`test/support/browser-server.mjs`). Shared fixtures are in
  `test/support/browser-test.mjs`. Only the HTTPS test's browser context
  accepts that certificate. Requests to any other host are blocked, and a CSP
  violation fails the test. Output goes to the ignored `test-results/`.
  Install the browsers once with `npx playwright install chromium webkit`.
- `npm run check` syntax-checks every `.mjs` and `.js` file. It also confirms
  that each `/assets/<name>` in `public/index.html` is listed in
  `lib/assets.mjs` and exists in `public/`.
- `node scripts/spike-claude-sdk.mjs` re-runs the Phase 2 SDK spike under
  `SPIKE_ROOT`; it spends subscription usage. See the research note.
- `npm run verify:codex -- --yes` starts a disposable real `codex app-server`
  on a temporary socket, connects an adapter, creates one thread from a
  second client (as the TUI does) and reports how the adapter came to
  list it, asks one question through the adapter, answers it, archives the
  thread, stops the server, and prints the Node, `ws`, and Codex versions.
  It runs one short model turn on the Codex subscription and refuses
  without `--yes`. `--model NAME` picks the model; `--record FILE` writes
  the versions, the outcome, and every frame on the adapter's connections.

Still checked by hand: dragging to reorder in Focus, keyboard focus
visibility, scrolling inside the frames, and a real phone after cutover.

## Configuration

| Variable | Default | Notes |
| --- | --- | --- |
| `PERSONAL_ASSISTANT_HOME` | `~/.personal-assistant` | The data root, an absolute path. Every store default below that names `<root>` derives from it, and the daemon sets it for every agent turn. |
| `DASHBOARD_MIGRATE_FROM` | this repository | The checkout the first start over a new root moves its data out of, an absolute path. Empty moves nothing; every test harness and throwaway instance sets it empty. |
| `DASHBOARD_PORT` | `4243` | Startup fails if the port is taken. |
| `DASHBOARD_PUBLIC_ORIGIN` | unset | The tailnet `https://` origin. When set, its host is accepted as a Host header and it is accepted as an Origin. When unset, only `127.0.0.1:<port>` and `localhost:<port>` are accepted. |
| `DASHBOARD_BRIEFS_DIR` | `<root>/briefs` | The briefs. A relative override resolves from this directory, not the working directory, as for every path below. |
| `DASHBOARD_FEEDS_DIR` | `<root>/feeds` | The feeds, one folder each; does not need to exist at startup. |
| `DASHBOARD_SOURCES_DIR` | `<root>/sources` | The sources the feeds read; does not need to exist at startup. |
| `DASHBOARD_IDEAS_DIR` | `<root>/ideas/items` | The Ideas runs the producers write; does not need to exist at startup. |
| `DASHBOARD_IDEAS_MARKS` | `<root>/ideas/marks.json` | The marks the Ideas view writes. |
| `DASHBOARD_IDEAS_INSTRUCTIONS` | `<root>/ideas/criteria.md` | The criteria the ideas producer reads; seeded from `defaults/ideas-criteria.md` when missing. |
| `DASHBOARD_BRIEF_INSTRUCTIONS` | `../../daily-brief/curator.md` | The rules the brief's curator follows, shown from Instructions in the brief's overlay. Resolved from this directory; does not need to exist at startup. |
| `DASHBOARD_FOCUS_ORIGIN` | `http://127.0.0.1:4242` | Must be an `http://` loopback origin other than `127.0.0.1:<DASHBOARD_PORT>`. |
| `DASHBOARD_REGISTRY_PATH` | `<root>/registry/agents.json` | Agent registry JSON file; does not need to exist at startup. |
| `DASHBOARD_LAUNCH_AGENTS_DIR` | `~/Library/LaunchAgents` | Directory holding launchd plists; does not need to exist at startup. |
| `DASHBOARD_JOB_RUNNER` | `launchd` on macOS, `systemd` elsewhere | What runs the registry's jobs, and so where Health reads them: launchd plists or systemd user units. Any other value refuses to start. |
| `DASHBOARD_THREADS_DIR` | `<root>/threads` | Persona session pointers and message caches; the read times are `thread-reads.json` beside the directory. |
| `DASHBOARD_SETTINGS_PATH` | `<root>/settings.json` | The settings file the interface writes (below); written on first start. |
| `DASHBOARD_ROUTINES_DIR` | `<root>/routines` | The routine files and, under `runs/`, their logs. |
| `DASHBOARD_NOTIFICATIONS_DIR` | `<root>/notifications` | The notifications file agents raise into. |
| `DASHBOARD_CODEX_DIR` | `<root>/codex` | The Codex socket, `owner.json`, `bindings.json` and its `bindings.lock`, and the `waiting/` markers, shared with `bin/codex-serve` and `bin/codex-new`. |
| `DASHBOARD_CMUX_SOCKET_PATH_FILE` | `~/.local/state/cmux/last-socket-path` | File cmux writes its socket path to while it runs. Missing means cmux is not running. |
| `DASHBOARD_CMUX_PASSWORD_FILE` | `~/.local/state/cmux/socket-control-password` | The cmux socket password, where cmux keeps it. Read on each call, never logged. |
| `DASHBOARD_CMUX_CLI` | `/Applications/cmux.app/Contents/Resources/bin/cmux` | The cmux binary for `sessions list`. The LaunchAgent's `PATH` has no `cmux`. |

The server always binds `127.0.0.1`. PUT and POST requests must send an
`Origin` that matches the request's Host, and JSON unless they are one of the
bodyless Focus controls. Focus request bodies are capped at
1,000,000 bytes, feedback at 128 KiB, and a routine at 16 KiB. An oversized body gets a 413 as soon
as the limit is crossed, with `Connection: close`; the server then discards at
most 2 MiB more of the upload, for at most 2 seconds, before cutting the
connection. The event stream limits (`LIMITS.eventStreams`, 8;
`TIMEOUTS.heartbeatMs`, 25 seconds; `TIMEOUTS.statusPollMs`, 30 seconds;
`TIMEOUTS.sessionsPollMs`, 10 seconds) are
constants in `lib/config.mjs`, not environment variables. Logs record method, route, status, and duration; a response that
never completed is logged with status 0. They also carry the persona events:
`persona_init`, `persona_usage`, `persona_turn_error` (with bounded error
text and, for a failure before init, the CLI's last 2 KiB of stderr),
`persona_api_key_refused`, `persona_start_error`, `persona_interrupt`,
`persona_turn_aborted`, `persona_turn_timeout`, `persona_cwd_changed`, and
`thread_resume_failed`, the Codex events listed under Codex sessions, the
hub's `sessions_refresh_error` (an error code), `hub_listener_error`, and
`thread_cache_error`, the routine store's `routine_invalid` (a file it
skipped), the routes' `routine_write_error`, the notification store's
`notification_invalid` (a line it skipped) and `notifications_load_error`,
the notify tool's `notification_raised` and `notification_error`, the
notification routes' `notification_write_error`, the scheduler's
`routine_run`, `routine_log_error`, `routine_line_error`, and
`routine_tick_error`, the bindings reader's `bindings_error` and
`bindings_listener_error`, and the cmux events
`cmux_auth_failed`, `cmux_inventory_error`, `cmux_frame_too_large`,
`cmux_surface_list_shape`, `cmux_record_skipped`, `cmux_cli_missing`, and
`cmux_focus` (workspace and surface ids with the outcome).
They never contain request bodies, brief text, persona messages, tool
inputs, or the cmux password.

Real briefs, contributions, and feedback contain personal data. They stay in
the data root's `briefs/` and never enter this repository.
