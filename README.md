# Dashboard app

A local Node server that will become the single private entry point for Focus
and the Daily Brief. It listens on `127.0.0.1:4243`; Tailscale serves it to the
tailnet over HTTPS. The page is a shell with Home, Agents, Routines, Focus, and
Daily Brief views. Focus runs in an iframe through a proxy to its own server.
Briefs are read from `daily-brief/briefs/`, and feedback is saved beside them.

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
| `GET /`, `/focus`, `/brief`, `/routines`, `/agents`, `/goals` | The shell. |
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

`/focus/`, `/brief/`, `/routines/`, `/agents/`, and `/goals/` redirect to the
paths without the slash. A known path
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

The status route now asks the state hub for a refresh and answers from its
snapshot; concurrent requests share one check. It stays for one release.

### State and events

`lib/hub.mjs` keeps one snapshot in memory:

```json
{ "revision": 7, "updatedAt": "<ISO>",
  "focus": { "available": true },
  "brief": { "state": "ready", "date": "2026-09-21", "revision": "<64 hex>" },
  "registry": { "ok": true, "error": null, "loadedAt": "<ISO>" },
  "agents": [{ "id": "cfo", "name": "CFO", "role": "Money", "description": "...", "group": "work", "kind": "persona", "provider": "claude",
               "state": "idle", "pending": null, "lastMessage": { "role": "assistant", "text": "...", "at": "<ISO>" },
               "lastError": null, "costUsd": 0.42 }],
  "routines": { "refreshedAt": "<ISO>", "focusAvailable": true, "refreshing": false, "error": null, "items": [] } }
```

`revision` goes up by one on every change. `focus` and `brief` hold what the
status route reports (`available` is null and `state` is `unknown` before the
first check). Agents leave out `cwd` and `routines`. A persona also carries
its runtime state (see Personas below); any other kind has `state: null`.
`routines.items` is empty
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
`public/routines.js`, and `public/styles.css` make up the page served at
`/`, `/agents`, `/routines`, `/focus`, and `/brief`. `/goals` serves the
same page, which shows Home there, as it does for any path it does not
know. The navigation links are
ordinary links; the script switches views with the History API and handles
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

Home links to Agents, Routines, Focus, and the Daily Brief. Under Agents it
names who is waiting for an answer ("CFO is waiting for you"), or counts the
agents; under Routines it shows the number of routines, or "Not refreshed
yet" before the first refresh.

Wide screens get a navigation column; below 720px it becomes a row across the
top. The page is exactly one screen tall and each frame fills the rest, so the
child page does its own scrolling and keeps its fixed bar in view.

### Routines view

The Routines view has one card for each agent that has routines, in
registry order, with the agent's name and role. Each routine is a row with
its name, schedule, last run, and outcome, and Focus scans with failures in
the last 24 hours also show how many. Times under a day are relative ("12
minutes ago"); older ones read "Yesterday 21:00" or "Sep 3 21:00". The
header shows when the routines were last refreshed and has a Refresh button,
which reads "Refreshing…" while a refresh runs.

Routines are refreshed only on demand: when the view opens and the last
refresh is missing or more than 60 seconds old, and when Refresh is chosen.
The Focus card shows "Paused" when any scan is paused, and a Pause or
Resume button that posts to the forwarded `/api/pause` or `/api/resume`;
the server then refreshes the routines, and the card follows the state. If
the request gets no answer, or the proxy answers 502 or 504 because Focus
gave none, the card says "Focus did not respond."; any other error status
is Focus's own and shows "Focus reported an error." The message clears on the
next attempt or when the state shows the scans paused or resumed. A
registry that cannot be read (followed by the registry's error), a failed
refresh, and an empty list each get one plain sentence, and when Focus did
not answer during the refresh the Focus card says its rows come from
launchd. While the view is hidden its cards are not rebuilt; opening it
renders the latest state.

### Agents view

The Agents view lists every registry agent under Work and Personal, in
registry order: name, role, provider (Claude or Codex), and for a persona
its last message with a relative time, plus a line for its state: "Waiting
for you" on a question or approval, "Working" during a turn, "The last turn
failed", or "Unavailable". A project folder or system agent shows its
description instead and opens nothing. Choosing a persona opens its thread
and puts `?agent=<id>` in the URL, so a reload or a shared link lands on the
same thread; Back and Forward move between threads. From 720px the list and
the thread sit side by side; on a phone the list comes first and the thread
takes the whole width with an "All agents" link back.

The thread is read from `GET /api/agents/<id>/thread` when it opens and
again whenever the state shows a new last message or a turn that started or
ended, so it follows the turn without reconstructing it from deltas. Your
messages sit on the right, the persona's on the left, and "New thread"
markers in the middle. While the persona works, the pane says so and offers
Interrupt. A question becomes one card per question with its options
(label and description), an Other field, and Answer, which posts one answer
per question; an approval is a card with the tool name, its input as
monospaced JSON (marked "Input cut short." when the snapshot cut it),
and Allow and Deny. The composer is labelled "Message <name>"; Send is off,
with the reason under it, while the persona is working, waiting on an
answer, or unavailable. A failed turn shows the adapter's sentence above
the messages ("The stored session could not be resumed. Start a new
thread."), and an unavailable persona shows why under the composer, as a
sentence rather than a code. New thread asks for confirmation inline before
posting. A refused Send, Answer, Interrupt, or New thread is reported under
the composer until the next attempt; a `no_such_request` refusal also
fetches the state again.

## Personas

A persona is a long-lived Claude session whose working directory is the
agent's repo. `lib/runtime/claude.mjs` runs persona turns through
`@anthropic-ai/claude-agent-sdk`, the app's one runtime dependency, pinned to
an exact version and loaded on the first turn. The comment at the top of the
module lists its methods and events. The routes below are wired to it and
the Agents view (above) drives them.

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
  unavailable: `provider_unavailable` (no runtime for its provider, such as
  `codex` today), `api_key_in_env`, or `start_failed` (its session pointer
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
persona that is unavailable (`provider_unavailable`, `api_key_in_env`, or
`start_failed`) is 409 `persona_unavailable`. POSTs follow the usual rules:
exact `Origin`, JSON for `send` and `answer`, no body for `interrupt` and
`new-thread`.

| Route | Success | Refusals |
| --- | --- | --- |
| `POST send` `{"text": "..."}` | 202 `{"ok": true}` | 400 `invalid_text` (missing or blank), 413 over 16 KiB, 409 `busy`, 503 `shutting_down` |
| `POST answer` `{"requestId", "answers"}` or `{"requestId", "decision"}` | 200 `{"ok": true}` | 400 `invalid_answer`, 409 `no_such_request` |
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

On SIGTERM the server ends the event streams and refuses new sends and new
threads with 503 `shutting_down`, then drains the personas: turns waiting on
an answer are aborted at once, running turns get up to 30 seconds
(`TIMEOUTS.drainMs`), and the rest are aborted and given 2 seconds
(`TIMEOUTS.abortGraceMs`) to end. Then it closes the hub and the registry
poll, and finally the server, which cuts requests still open after 5 seconds
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
| `DASHBOARD_THREADS_DIR` | `var/threads` | Persona session pointers and message caches. Resolved from this directory; created on the first write. |

The server always binds `127.0.0.1`. PUT and POST requests must send an
`Origin` that matches the request's Host, and JSON unless they are one of the
bodyless Focus controls. Focus request bodies are capped at
1,000,000 bytes and feedback at 128 KiB. An oversized body gets a 413 as soon
as the limit is crossed, with `Connection: close`; the server then discards at
most 2 MiB more of the upload, for at most 2 seconds, before cutting the
connection. The event stream limits (`LIMITS.eventStreams`, 8;
`TIMEOUTS.heartbeatMs`, 25 seconds; `TIMEOUTS.statusPollMs`, 30 seconds) are
constants in `lib/config.mjs`, not environment variables. Logs record method, route, status, and duration; a response that
never completed is logged with status 0. They never contain request bodies or
brief text.

Real briefs, contributions, and feedback contain personal data. They stay in
`daily-brief/` and never enter this repository.
