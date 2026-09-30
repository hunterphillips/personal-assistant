# Dashboard app

The assistant daemon and the tailnet-only hub it serves. A local Node server
on `127.0.0.1:4243`; Tailscale serves it to the tailnet over HTTPS. The page
is a shell with a rail of four views. Home is the Agents view at `/`, with
the routines beside it; Reading is the Daily Brief; Focus and Goals are their
own views. Personas run on the Claude Agent SDK, Codex threads are observed
on a shared app-server, and cmux terminals are listed with their state.
Focus runs in an iframe through a proxy to its own server. Briefs are read
from `daily-brief/briefs/`, and feedback is saved beside them.

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
| `GET /`, `/agents`, `/routines`, `/focus`, `/reading`, `/brief`, `/feed`, `/goals` | The shell. `/`, `/agents`, and `/routines` show the Agents view; `/reading` and `/brief` show Reading on its Brief tab and `/feed` on its Feed tab. |
| `GET /healthz` | `{"ok": true}` whenever the server is up, whatever Focus and the brief are doing. |
| `GET /api/state` | Checks Focus and the brief, then returns the state hub's snapshot (below). |
| `GET /api/events` | Server-Sent Events: the snapshot, then each change (below). |
| `POST /api/routines/refresh` | Re-reads the routines and answers `{"ok": true, "revision": N}`. |
| `GET /api/dashboard/status` | Focus and brief status (below). The shell no longer reads it; kept for one release. |
| `GET /assets/<name>` | Shell scripts, styles, and the brief bridge. |
| `GET /embedded/focus`, `/api/focus`, `/api/status`; `PUT /api/focus`; `POST /api/pause`, `/api/resume`, `/api/refresh` | Forwarded to Focus (below). |
| `GET /api/brief/latest` | Latest brief metadata. |
| `GET /embedded/brief/<date>?revision=<revision>` | One brief viewer. |
| `POST /api/brief/feedback` | Saves feedback for one brief. |
| `POST /api/agents/<id>/send` | Sends `{"text": "..."}` to a persona; 202 once the turn has started (below). |
| `POST /api/agents/<id>/answer` | Answers the persona's open question or approval. |
| `POST /api/agents/<id>/interrupt` | Stops the persona's turn. |
| `POST /api/agents/<id>/new-thread` | Starts the persona on a new session. |
| `GET /api/agents/<id>/thread` | The persona's cached messages. |
| `POST /api/sessions/<id>/answer` | Answers a Codex thread's open question or approval (below). |
| `POST /api/sessions/<id>/interrupt` | Stops the Codex thread's running turn. |
| `GET /api/sessions/<id>/thread` | The Codex thread's recent messages, read from the app-server. |
| `POST /api/sessions/<id>/open-terminal` | Brings the session's recorded cmux terminal to the front. |
| `POST /api/sessions/refresh` | Re-reads the cmux inventory and the Codex catalogue now and answers `{"ok": true, "revision": N}`. |
| `GET /api/goals` | Priorities and goal notes read from the vault (below). |
| `POST /api/goals/propose` | Sends a new goal or a change to one to the second-brain persona; 202 `{"ok": true, "agentId": "second-brain"}` once the turn has started (below). |
| `GET /api/feed` | The feed store's runs, newest first (below). |
| `POST /api/feed/discuss` | Sends one feed item to the watch persona; 202 `{"ok": true, "agentId": "watch"}` once the turn has started (below). |

`/focus/`, `/reading/`, `/brief/`, `/feed/`, `/routines/`, `/agents/`, and `/goals/` redirect to the
paths without the slash. A known path
with the wrong method is 405, and anything else is 404. Errors are JSON bodies of the form
`{"error": "<code>"}`. The comment at the top of each route module describes
what `lib/app.mjs` expects from it.

### Modules

- `lib/app.mjs` routes requests, checks Host and Origin, logs, and serves the shell, assets, health, status, state, and routines refresh.
- `lib/agent-routes.mjs` serves the persona routes under `/api/agents/` and the session routes under `/api/sessions/`.
- `lib/goals-routes.mjs` serves the Goals routes over `lib/goals.mjs`, which reads the vault.
- `lib/feed-routes.mjs` serves the Feed routes over `lib/feed.mjs`, which reads the feed store.
- `lib/events.mjs` serves `/api/events` and closes the streams at shutdown.
- `lib/http.mjs` holds the response, error, and request-body helpers the route modules share.
- `lib/focus-proxy.mjs` forwards the Focus routes.
- `lib/brief-adapter.mjs` serves the brief routes over `lib/briefs.mjs` and `lib/feedback.mjs`.
- `lib/hub.mjs` keeps the state snapshot and its subscribers.
- `lib/registry.mjs` and `lib/routines.mjs` read the agent registry and its launchd jobs; `lib/launchd.mjs` renders the plist for `bin/dashboard-install`.
- `lib/threads.mjs` and `lib/runtime/` hold the persona thread files, the two runtime adapters (`claude.mjs` runs personas, `codex.mjs` follows the shared Codex app-server's threads), and the cmux client (`cmux.mjs`).
- `lib/bindings.mjs` reads the terminal bindings `bin/codex-new` records.
- `lib/config.mjs` and `lib/assets.mjs` hold configuration and the asset allowlist.

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

The status route now asks the state hub for a refresh and answers from its
snapshot; concurrent requests share one check. It stays for one release.

### State and events

`lib/hub.mjs` keeps one snapshot in memory:

```json
{ "revision": 7, "updatedAt": "<ISO>", "home": "/Users/hunter",
  "focus": { "available": true },
  "brief": { "state": "ready", "date": "2026-09-21", "revision": "<64 hex>" },
  "registry": { "ok": true, "error": null, "loadedAt": "<ISO>" },
  "agents": [{ "id": "cfo", "name": "CFO", "role": "Money", "description": "...", "group": "work", "kind": "persona",
               "cwd": "/Users/hunter/workspace/work/investing/cfo", "provider": "claude", "state": "idle", "pending": null, "lastMessage": { "role": "assistant", "text": "...", "at": "<ISO>" },
               "lastError": null, "costUsd": 0.42 }],
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
  "routines": { "refreshedAt": "<ISO>", "focusAvailable": true, "refreshing": false, "error": null, "items": [] } }
```

`revision` goes up by one on every change. `home` is the home directory,
which the Agents view shortens to `~` in the paths it shows. `focus` and
`brief` hold what the status route reports (`available` is null and
`state` is `unknown` before the first check). Every agent carries its
registry `cwd` (a string, or null when the registry has none), which the
Agents view shows as the agent's folder; agents leave out `routines`. A
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
the cmux inventory (its reasons are listed with the rows). `routines.items` is empty
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

`POST /api/routines/refresh` follows the rules for the Focus controls: exact
`Origin`, no body. It answers once the refresh has finished. `ok` means the
control ran, not that the refresh worked; a failed refresh shows up in the
state as `routines.error`. A successful `POST /api/pause` or `/api/resume` also starts
a routines refresh.

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
rather than a different brief; the shell then fetches the state again and
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

### Goals

`GET /api/goals` reads three sources under the second-brain persona's cwd:
`notes/current-priorities.md`, `notes/longterm-priorities.md`, and each
`notes/goals/*.md`. `POST /api/goals/propose` takes
`{"kind": "add", "text": "..."}` or
`{"kind": "edit", "target": "goal:podcast", "text": "..."}`, sends the text
to the second-brain persona as a new message, and the shell opens that
persona's thread. The dashboard never writes the vault; the persona does, in its own
turn.

### Feed

`GET /api/feed` reads the feed store, `feed/items/` at the umbrella root
(`DASHBOARD_FEED_DIR`; `feed/README.md` describes the files), and answers

```json
{ "agentId": "watch", "readAt": "<ISO>", "problems": [],
  "runs": [{ "id": "2026-09-28-watch", "producer": "watch", "date": "2026-09-28", "since": "2026-09-14",
             "generatedAt": "<ISO>",
             "items": [{ "id": "watch/2026-09-28/1", "title": "...", "source": "...", "url": "https://...",
                         "summary": "...", "test": 5, "kept": true }] }] }
```

Runs are the newest 30 files by name, regular files only. A file that is
over 256 KiB, not JSON, or not a run is left out with one problem sentence;
an item without its five text fields, with a URL that is not `http` or
`https`, or with an id already used is left out and counted in one sentence
per run. A missing directory is one problem and no runs. Reads are cached by
the files' lstat and happen only on request.

`POST /api/feed/discuss` takes `{"id": "watch/2026-09-28/1"}`, sends the
item's title, source, link, and summary to the watch persona as a new
message asking it to read the link and say what it found, and the shell
opens that persona's thread. It refuses with 400 `invalid_body`, 503
`shutting_down`, 404 `no_such_agent` (no `watch` persona in the registry),
409 `persona_unavailable`, 404 `no_such_item`, then the persona send
refusals (409 `busy` and the rest). The dashboard never writes the store;
the producers do.

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

`public/index.html`, `public/shell.js`, `public/agents.js`,
`public/routines.js`, `public/goals.js`, and `public/styles.css` make up the
page served at `/`, `/agents`, `/routines`, `/reading`, `/brief`, `/focus`,
and `/goals`. The Agents view is the page at `/`; `/agents` shows the same
view and `/routines` shows it with the routines overview open. `/reading`
and `/brief` show the Reading view, `/focus` Focus, and `/goals` Goals. The
navigation is a rail of four icon links, Home, Reading, Focus, and Goals;
a path the shell does not know lands on Agents. The script switches views
with the History API and handles
Back and Forward, and a reload or bookmark opens the same view. Each frame
is created the first time its view opens and stays in the page afterwards,
hidden while another view is shown, so Focus keeps its state and the brief
keeps its unsaved marks. The page has no inline script or style, as the
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

A frame is created only from state that has just arrived: a snapshot, a
delta that changes `focus` or `brief`, or a finished `/api/state` fetch,
never the copy kept since. What the shell does with `focus` and `brief`:

- Focus not answering: the Focus view says "Focus is not responding." with
  Retry. A frame already open stays; otherwise none is created until Focus
  answers.
- A different brief date or revision than the open frame: "A newer brief is
  available." with "Load newer brief", which fetches `/api/state` and loads
  what it names. The open frame stays until that is chosen.
- A brief state other than `ready`: "No brief has been generated yet." for
  `empty`, "The brief for <date> could not be opened." when the state names a
  date, and "The latest brief file could not be read." otherwise. Focus is
  unaffected.

A frame stays hidden until its page loads. If the page comes back as a JSON
error, such as a 409 for a brief replaced under the same date or a 502 from
Focus, the frame stays hidden, the view shows its notice, and the state is
fetched again at once. Retry reloads that frame.

Wide screens get a navigation column; below 720px it becomes a row across the
top. The page is exactly one screen tall and each frame fills the rest, so the
child page does its own scrolling and keeps its fixed bar in view.

### Agents view

The Agents view is the page at `/`. It lists every registry agent under
Work and Personal, in registry order: name, role, provider (Claude or
Codex), and for a persona its last message with a relative time, plus a
line for its state: "Waiting for you" on a question or approval, "Working"
during a turn, "The last turn failed", or "Unavailable". A project folder
or system agent shows its description instead and opens nothing. Choosing
a persona opens its thread and puts `?agent=<id>` in the URL (`/?agent=cfo`;
`/agents?agent=cfo` opens the same thread), so a reload or a shared link
lands on the same thread; Back and Forward move between threads. From
720px the list and the pane beside it sit side by side, and the pane shows
the routines overview until a persona is chosen. On a phone the list comes
first, a Routines row at its top (with the number of routines once they
have been read) opens the overview at `/routines`, and a thread or the
overview takes the whole width with an "All agents" link back.

#### Sessions

The snapshot's coding sessions (see Sessions in the snapshot) are rows
too. Each sits under the project row its `projectId` names, indented,
newest first; sessions under no project sit in an "Other sessions" group
after Personal. A session row shows its provider chip, a title (a Codex
thread's title, else the last segment of its folder; a Claude terminal
always uses the folder), the folder with the home directory as `~`, a
relative time, and a state line: "Waiting for you" on a question or
approval, "Working" during a turn, "The last turn failed", "Server
stopped" while the Codex server is down, or "Terminal closed" when the
terminal it was started in has gone. A Codex thread with an open turn
says the turn, since it can still be answered here; a Claude terminal
that has closed says only that. When there are no sessions and both the
Codex server and cmux are off, one sentence ends the list: "No coding
sessions. Start the Codex server or open a terminal in cmux." With only
one of them off the list says nothing; the routines overview carries one
line per source that is off, above its heading ("The Codex server is not
running.", "The Codex server disconnected.", "Codex sessions are off
until npm ci runs.", "cmux is not running.", "cmux refused the
connection. Check the socket password.", or "cmux is not reachable."),
and nothing while both answer.

A session's id goes in `?agent=` like an agent's (`/?agent=codex%3A<threadId>`;
the plain `codex:` form works too), and the phone flow is the same. An id
that is not in the snapshot shows "That session is not listed."

A Codex session opens the thread pane: its title and provider chip, its
folder, the messages from `GET /api/sessions/<id>/thread` (fetched on the
same occasions as a persona's), the working or waiting line with
Interrupt (`POST /api/sessions/<id>/interrupt`), and a question or
approval card that posts to `POST /api/sessions/<id>/answer`; a Codex
question's answers are keyed by its question ids; a question whose
`isOther` is false has no Other field, and one whose `isSecret` is true
takes its Other answer in a password field. There is no New thread,
no cost line, and no routines toggle, and in place of the composer one
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

A Claude terminal opens a pane with the folder name, the Claude chip, and
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

Under "Settings" come the agent's name, then Role, Group ("Work" or
"Personal"), Provider ("Claude" or "Codex"), and Folder (the snapshot's
`cwd` with the home directory as `~`), each left out with its label when
the registry has no value, then the registry description as written, and
the jobs sentence (see Routines). Nothing in it is editable.

#### Routines

The overview has one card for each agent that has routines, in registry
order, with the agent's name and role. Each routine is a row with its name,
schedule, last run, and outcome, and Focus scans with failures in the last
24 hours also show how many. Times under a day are relative ("12 minutes
ago"); older ones read "Yesterday 21:00" or "Sep 3 21:00". The header shows
when the routines were last refreshed and has a Refresh button, which reads
"Refreshing…" while a refresh runs.

A thread shows no routine rows. Its settings panel (below) counts the
agent's jobs in one sentence, "CFO runs 1 job.", linking to `/health`, from
the same routines state; an agent with none has no sentence.

Routines are refreshed only on demand: when the overview opens and the
last refresh is missing or more than 60 seconds old,
and when Refresh is chosen. The Focus card shows "Paused" when any scan is
paused, and a Pause or Resume button that posts to the forwarded
`/api/pause` or `/api/resume`; the server then refreshes the routines, and
the card follows the state. If the request gets no answer, or the proxy
answers 502 or 504 because Focus gave none, the card says "Focus did not
respond."; any other error status is Focus's own and shows "Focus reported
an error." The message clears on the next attempt or when the state shows
the scans paused or resumed. A registry that cannot be read (followed by
the registry's error), a failed refresh, and an empty list each get one
plain sentence, and when Focus did not answer during the refresh the Focus
card says its rows come from launchd. While the overview is off screen its
cards are not rebuilt; opening it renders the latest state.

The thread is read from `GET /api/agents/<id>/thread` when it opens and
again whenever the state shows a new last message or a turn that started or
ended, so it follows the turn without reconstructing it from deltas. Your
messages sit on the right, the persona's on the left, and "New thread"
markers in the middle. While the persona works or waits on an answer, the
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
- `lastMessage`: null, or `{ role, text, at }` with the first 200
  characters. At startup it comes from the thread cache.
- `lastError`: null, or why the last turn failed or why the persona is
  unavailable: `provider_unavailable` (its provider runs no personas; a
  `codex` persona stays unavailable, since Codex threads are followed as
  sessions instead), `api_key_in_env`, `sdk_unavailable` (the SDK package
  could not be loaded; run `npm ci`), or `start_failed` (its session pointer
  could not be read).
- `costUsd`: null, or the session's running total.

A persona whose turn runs longer than 30 minutes (`TIMEOUTS.turnMaxMs`) is
interrupted, the timeout is logged as `persona_turn_timeout`, and its
`lastError` reads `turn_timeout` until the next turn. The clock covers the
whole turn, including time spent waiting on an answer, so a question raised
at minute 10 has 20 minutes left. Personas added to the registry are
started; removed ones are dropped. A persona whose `cwd` changes in the
registry keeps its session pointer (logged as `persona_cwd_changed`), so its
next turn may fail to resume; New thread is the fix.

### Persona routes

Each route names the agent by its registry id. An id not in the registry is
404 `no_such_agent`; an agent of another kind is 409 `not_a_persona`; a
persona that is unavailable (`provider_unavailable`, `api_key_in_env`,
`sdk_unavailable`, or `start_failed`) is 409 `persona_unavailable`. POSTs follow the usual rules:
exact `Origin`, JSON for `send` and `answer`, no body for `interrupt` and
`new-thread`.

| Route | Success | Refusals |
| --- | --- | --- |
| `POST send` `{"text": "..."}` | 202 `{"ok": true}` | 400 `invalid_body` (JSON that is not an object), 400 `invalid_text` (missing or blank), 413 `payload_too_large` over 16 KiB of text or 32 KiB of body, 409 `busy`, 503 `shutting_down` |
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

- `<agent-id>.json` holds the session id and when it was first seen. It is
  the only durable file a persona has here, and it is replaced atomically
  (temporary file, fsync, rename). If it is lost, the next message starts a
  new session. The transcript itself stays with Claude Code under
  `~/.claude/projects/`.
- `<agent-id>.jsonl` is a display cache of the thread, one message per line.
  It is capped at 200 messages and 1 MiB; past either cap it is rewritten
  with the newest messages that fit under both. Message text is cut at
  8 KiB and marked `truncated`. A partial last line left by a crash is
  skipped on read. Losing this file only empties the thread view.

The agent id must match the registry's id pattern before any path is built.

### Turns

- One turn per persona at a time. A second message while a turn is running
  is refused as `busy` before the SDK is called, because two resumes of one
  session both succeed and split its history.
- Each turn resumes the stored session and passes `permissionMode:
  'default'`, so the global `auto` mode never applies, and `maxTurns` 25.
  It also passes a `canUseTool` callback on every turn; without one the SDK
  removes `AskUserQuestion`.
- `AskUserQuestion` becomes a question. Any other tool that needs
  permission becomes an approval that carries the tool name and its full
  input. The turn waits for an answer. After 30 minutes without one, the
  request is denied with "No answer within 30 minutes". The turn clock
  keeps running while it waits, so the whole turn, waiting included, is
  bounded by `turnMaxMs`. The persona stays busy after a denial until the
  SDK reports the turn's result, since the model keeps working.
- Interrupt aborts the turn and denies any open request. New thread is
  refused while a turn runs or the server is shutting down; otherwise it
  deletes both files, and the cache starts again with a "New thread" line.
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

### What runs without a card

Only tool calls that reach `canUseTool` produce a card. These do not:

- Tools covered by allow rules in `~/.claude/settings.json` or the repo's
  `.claude/settings*.json`. Today that is the global test, build, lint, and
  typecheck commands in every repo, plus `git worktree`, `git branch`, and
  `git push` in nowgentic.
- File reads inside the working directory and read-only shell commands.
- Skills. The Skill tool never asks, though tools a skill then calls go
  through the usual checks.

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
  starts `codex app-server --listen unix:///<absolute path>/var/codex/app.sock`
  (the path is resolved to an absolute one first) with both
  feature flags, writes `var/codex/owner.json` (`socket`, `pid`,
  `startedAt`, `codexVersion`), and removes that file when the server
  stops: on Ctrl-C, SIGTERM, or SIGHUP the file goes first, then the
  signal is forwarded and the helper waits for the server to exit, which
  can take half a minute while a TUI is attached. It refuses while
  `owner.json` names a running process, and it
  refuses a socket path over 100 bytes, since macOS allows 104 for a Unix
  socket path; that is why the socket lives under `var/codex/` rather than a
  deeper directory. `--socket PATH` overrides the path.
- `bin/codex-new [--cwd DIR]` opens the Codex TUI on that server in the
  given working directory (default: the current one) and records the
  thread it starts. It connects to the server, runs
  `codex --remote unix://<socket> -C <cwd>`, waits for the
  `thread/started` notification whose cwd is that directory, writes the
  thread to `var/codex/bindings.json` with the cmux workspace and surface
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
  `var/codex/waiting/<sha256 of the real cwd>.json` with its pid, and
  another launcher that finds it held by a live pid refuses before
  starting anything ("Another codex-new is waiting in this folder");
  a marker whose pid is gone is taken over. The marker is removed once
  the thread is recorded or the TUI exits. A thread `bindings.json`
  already binds to other surface ids is left alone, and the helper says
  so. Writers to `bindings.json` take turns through `bindings.lock`
  beside it.

Both read `DASHBOARD_CODEX_DIR` (default `var/codex`, created with mode
0700) so they agree with the daemon.

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
that, as `/api/routines/refresh` does for routines; it waits for the
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
  invented brief viewers in a temporary directory, an in-memory registry
  and routines, and personas on a fake Claude adapter over a thread store
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
| `DASHBOARD_PORT` | `4243` | Startup fails if the port is taken. |
| `DASHBOARD_PUBLIC_ORIGIN` | unset | The tailnet `https://` origin. When set, its host is accepted as a Host header and it is accepted as an Origin. When unset, only `127.0.0.1:<port>` and `localhost:<port>` are accepted. |
| `DASHBOARD_BRIEFS_DIR` | `../../daily-brief/briefs` | Resolved from this directory, not the working directory. |
| `DASHBOARD_FEED_DIR` | `../../feed/items` | The feed store the producers write. Resolved from this directory; does not need to exist at startup. |
| `DASHBOARD_FOCUS_ORIGIN` | `http://127.0.0.1:4242` | Must be an `http://` loopback origin other than `127.0.0.1:<DASHBOARD_PORT>`. |
| `DASHBOARD_REGISTRY_PATH` | `../../registry/agents.json` | Agent registry JSON file. Resolved from this directory, not the working directory; does not need to exist at startup. |
| `DASHBOARD_LAUNCH_AGENTS_DIR` | `~/Library/LaunchAgents` | Directory holding launchd plists; does not need to exist at startup. |
| `DASHBOARD_THREADS_DIR` | `var/threads` | Persona session pointers and message caches. Resolved from this directory; created on the first write. |
| `DASHBOARD_CODEX_DIR` | `var/codex` | The Codex socket, `owner.json`, `bindings.json` and its `bindings.lock`, and the `waiting/` markers, shared with `bin/codex-serve` and `bin/codex-new`. Resolved from this directory. |
| `DASHBOARD_CMUX_SOCKET_PATH_FILE` | `~/.local/state/cmux/last-socket-path` | File cmux writes its socket path to while it runs. Missing means cmux is not running. |
| `DASHBOARD_CMUX_PASSWORD_FILE` | `~/.local/state/cmux/socket-control-password` | The cmux socket password, where cmux keeps it. Read on each call, never logged. |
| `DASHBOARD_CMUX_CLI` | `/Applications/cmux.app/Contents/Resources/bin/cmux` | The cmux binary for `sessions list`. The LaunchAgent's `PATH` has no `cmux`. |

The server always binds `127.0.0.1`. PUT and POST requests must send an
`Origin` that matches the request's Host, and JSON unless they are one of the
bodyless Focus controls. Focus request bodies are capped at
1,000,000 bytes and feedback at 128 KiB. An oversized body gets a 413 as soon
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
`thread_cache_error`, the bindings reader's `bindings_error` and
`bindings_listener_error`, and the cmux events
`cmux_auth_failed`, `cmux_inventory_error`, `cmux_frame_too_large`,
`cmux_surface_list_shape`, `cmux_record_skipped`, `cmux_cli_missing`, and
`cmux_focus` (workspace and surface ids with the outcome).
They never contain request bodies, brief text, persona messages, tool
inputs, or the cmux password.

Real briefs, contributions, and feedback contain personal data. They stay in
`daily-brief/` and never enter this repository.
