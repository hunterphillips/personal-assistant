# Operations

Run all commands from the repository root. This runbook covers the dashboard user LaunchAgent on macOS, the systemd user unit on Linux (see Linux below), and the manual Tailscale cutover; the installer itself never changes Tailscale.

The installer and uninstaller pick their path from `DASHBOARD_JOB_RUNNER`: `launchd` on macOS and `systemd` elsewhere unless it names the other. The sections up to Linux describe the launchd path.

## Install

Run a dry run first. It renders and validates the plist in the data root's cache without changing `~/Library/LaunchAgents` or loading a job:

```sh
./bin/dashboard-install --dry-run --public-origin https://your-machine.your-tailnet.ts.net
```

The rendered plist is `~/.personal-assistant/cache/launchd/com.personal-assistant.dashboard.plist`. Inspect it, then install with the actual HTTPS origin for the existing tailnet hostname:

```sh
./bin/dashboard-install --public-origin https://your-machine.your-tailnet.ts.net
```

The installer creates only the `com.personal-assistant.dashboard` user LaunchAgent. It does not install or change Focus, the old brief server, or Tailscale Serve. It uses the data root `PERSONAL_ASSISTANT_HOME` names, or `~/.personal-assistant`, and writes `PERSONAL_ASSISTANT_HOME` into the job's environment only when it is set in its own.

The first start over a root without `layout.json` moves the checkout's data into it (see Data root below) and logs `migration_done`; read that in `~/.personal-assistant/log/dashboard.log`. The daemon refuses to start, and launchd keeps retrying it, while that move finds a conflict; the log names the paths.

The installer refuses to render or install when `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` is set in its environment. Persona turns must bill the Claude subscription, never an API key. Unset the variable and run it again. The server has the same guard: if it starts with either variable set, it creates no persona runtime, logs `adapters_disabled`, and every persona shows as unavailable with `api_key_in_env`.

## Verify

Check the dashboard's own health endpoint:

```sh
curl --fail --show-error http://127.0.0.1:4243/healthz
```

Confirm that the listener is bound only to loopback:

```sh
lsof -nP -iTCP:4243 -sTCP:LISTEN
```

The NAME column should read `127.0.0.1:4243 (LISTEN)`. If it reads `*:4243`, the server is listening on every interface; stop and fix that before going further.

Inspect the loaded user job:

```sh
launchctl print "gui/$(id -u)/com.personal-assistant.dashboard"
```

It should show `state = running` and a `pid` that matches the pid `lsof` reports for 4243.

## Logs

Standard output and standard error both go to `~/.personal-assistant/log/dashboard.log`. Each time the job starts, `bin/dashboard-start` renames the current log to `dashboard.log.1` if it is larger than 5 MiB, replacing the prior `.1` file. The check runs only at start, so the log can grow past 5 MiB while the server keeps running; it is rotated at the next restart. The installer creates `log/` with user-only permissions.

```sh
tail -f ~/.personal-assistant/log/dashboard.log
```

## Reinstall and job rollback

Run the install command again to reinstall. Before replacing an existing plist, the installer saves it as `~/.personal-assistant/cache/launchd/backup-<timestamp>.plist` and notes whether the job is loaded.

### Update

After pulling a new revision, run `npm ci` in `dashboard/app` before the installer. The app has two runtime dependencies (`@anthropic-ai/claude-agent-sdk` and `ws`), and the LaunchAgent does not install packages; a dashboard started without the SDK shows every persona as unavailable with `sdk_unavailable`, and one started without `ws` follows no Codex threads and reports `codex.reason` `ws_unavailable`.

If the job is loaded, the installer first asks the running dashboard for `GET /api/state` on 127.0.0.1, at the port recorded in the installed plist (the new `--port` only when no previous plist can be read). If any persona is busy or waiting on an answer, it stops without unloading anything and names those personas. Wait for them to finish, or pass `--force` to unload anyway. If the dashboard does not answer, the installer goes on. Codex sessions are not part of this check: their pending questions and approvals live on the app-server, not in the dashboard, and are replayed to it when it resumes the threads after the restart.

It then unloads only `com.personal-assistant.dashboard` and waits up to 40 seconds for the old process to exit, which covers the shutdown below.

## Shutdown

On SIGTERM or SIGINT, as when launchd unloads the job, the dashboard:

1. Ends every event stream and refuses new persona messages, new threads, new event streams, and `POST /api/sessions/refresh` with 503 `shutting_down`.
2. Closes the adapters, both at once. The Claude adapter drains persona turns: a turn waiting on a question or approval is aborted at once, running turns get up to 30 seconds (`TIMEOUTS.drainMs`) to finish, and any still running are then aborted and given 2 seconds (`TIMEOUTS.abortGraceMs`) to end. The Codex adapter stops its poll and closes its socket; questions and approvals still open stay on the app-server, where the terminal can answer them and the next dashboard picks them up on resume.
3. Closes the cmux client's socket (`cmux.close()`), then stops the state hub, the registry poll, and the bindings poll.
4. Closes the server, giving open requests up to 5 seconds (`TIMEOUTS.shutdownMs`) before cutting them.

If all of that has not finished 38 seconds after the signal (the three waits plus one second), or if the shutdown itself fails, the process exits with status 1.

The installer then checks that nothing else answers on 127.0.0.1:4243. If something does, such as a manual `npm start`, it stops without writing the new plist and names the port. Stop that process and run the installer again.

If the new job cannot be bootstrapped, kicked off, or made healthy within about 10 seconds, or if the process listening on 4243 is not the job's own process, the installer unloads the new job, restores the saved plist, and exits non-zero. The restored job is loaded again only if it was loaded before the install. A job that was loaded without a plist file cannot be restored; the installer warns about this before it starts. These job-level rollback steps do not change Tailscale Serve.

## Uninstall

```sh
./bin/dashboard-uninstall
```

Uninstall unloads only `com.personal-assistant.dashboard` and removes only `~/Library/LaunchAgents/com.personal-assistant.dashboard.plist`. It preserves the source tree, the data root, Focus jobs, and all Tailscale settings.

## Linux

On Linux the dashboard runs as the systemd user service `com.personal-assistant.dashboard`. The same two scripts install and remove it, with the same flags, refusals (an API key in the environment, a Focus origin off loopback), busy-persona check, and health wait.

### Install

```sh
./bin/dashboard-install --dry-run --public-origin https://your-machine.your-tailnet.ts.net
./bin/dashboard-install --public-origin https://your-machine.your-tailnet.ts.net
```

The dry run renders the unit to `~/.personal-assistant/cache/systemd/com.personal-assistant.dashboard.service`, prints it, and prints the commands an install would run; it changes nothing else. The install copies it to `~/.config/systemd/user/com.personal-assistant.dashboard.service` and runs `systemctl --user daemon-reload` and `systemctl --user enable --now com.personal-assistant.dashboard`. It then waits for `/healthz` and checks that the process listening on the port is the unit's `MainPID` (from `ss -ltnp`, or `lsof` where `ss` is missing).

The unit runs `bin/dashboard-start` with the same environment the plist sets, restarts on failure, and starts with the user's session (`WantedBy=default.target`). With the default data root it names the log through `%h`, systemd's home folder.

### Lingering

A user service stops when its user's last session ends unless the account lingers. Before it changes anything, the installer reads `loginctl show-user $USER -p Linger` and says whether lingering is on, with a warning when it is off. It never changes the setting; turn it on once with:

```sh
sudo loginctl enable-linger "$USER"
```

### Verify and logs

```sh
systemctl --user status com.personal-assistant.dashboard
ss -ltnp 'sport = :4243'
tail -f ~/.personal-assistant/log/dashboard.log
```

The listener should read `127.0.0.1:4243`, and its pid should match the status's Main PID. The log is the same file as on macOS, rotated the same way by `bin/dashboard-start`.

### Reinstall and rollback

Run the install again to reinstall. A previous unit is saved first as `~/.personal-assistant/cache/systemd/backup-<timestamp>.service`. If the service is running, the installer asks it whether any persona is busy (at the port in the installed unit), then stops it with `systemctl --user stop` and waits for it to go inactive. If the new service does not start, pass the health wait, or own the listener, the installer stops it (including one stuck restarting after a crash), puts the saved unit back, reloads systemd, clears the start limit a crash loop leaves behind (`systemctl --user reset-failed`), and starts the restored service only if it was running before; a unit that was not enabled before is disabled again. With no previous unit, it disables and removes the new one.

### Uninstall

```sh
./bin/dashboard-uninstall
```

It runs `systemctl --user disable --now com.personal-assistant.dashboard`, removes only that unit file, and reloads systemd. The data root, the source tree, and Tailscale are left alone.

### Tailscale

Tailscale Serve is set by hand, as on macOS: point it at `http://127.0.0.1:4243` and pass the resulting HTTPS origin as `--public-origin`.

## Data root

Everything the daemon writes while it is used lives in one folder outside the repository: `~/.personal-assistant/`, or the absolute path `PERSONAL_ASSISTANT_HOME` names. Its layout, who writes each file, the lock, and the migration are in `docs/root-README.md`, which the daemon copies into the root as `README.md`. Every store's `DASHBOARD_*` variable still overrides its own path.

At each start the daemon claims `daemon.lock` in the root and refuses, logging `root_locked` with the holder's pid, while another daemon holds it. It then prepares the root: on the first start, with no `layout.json` yet, it moves the data the checkout at `DASHBOARD_MIGRATE_FROM` holds (default this repository; empty for none) and renames each source `<source>.migrated`; a root at layout version 1 is upgraded to version 2, which moves the Feed into the feed `news` under `feeds/` and Watch's run state into `feeds/.run/`, renames `feed/` and `watch/` to `.migrated`, and takes Watch out of the registry (the root's `README.md` lists each step); on every start it seeds `ideas/criteria.md` from the repository's `defaults/` when it is missing. It logs `root` with the path, `migrateFrom`, and the layout version, and sets `PERSONAL_ASSISTANT_HOME` for every agent turn. A worktree or throwaway daemon sets `PERSONAL_ASSISTANT_HOME` to a folder of its own and `DASHBOARD_MIGRATE_FROM` to an empty value.

The brief run (`daily-brief/bin/run-brief`) and the feeds run (`feeds/run/run-feeds`) read the same variable, default `~/.personal-assistant` under `HOME`, and write their briefs, contributions, the feeds run's state, and the feeds' item files there; each prints the root first on `--dry-run`. Their launchd plists set only `HOME`, so a root elsewhere goes into each plist's `EnvironmentVariables` by hand. The feeds run exits with `reason=no-active-feeds` until a feed is active, and a feed without `note.md` fails with `reason=no-note`. `bin/codex-serve` and `bin/codex-new` keep their files under `codex/` in the root (`DASHBOARD_CODEX_DIR` overrides).

The feeds job is `com.personal-assistant.feeds` (`feeds/launchd/`, daily at 05:40). `daily-brief/bin/install-launchd` installs or refreshes it with the brief's jobs. To remove it:

```sh
launchctl bootout "gui/$(id -u)/com.personal-assistant.feeds"
rm ~/Library/LaunchAgents/com.personal-assistant.feeds.plist
```

## Persona threads

Each persona keeps two files in `threads/` under the data root (`DASHBOARD_THREADS_DIR`), readable only by this account:

- `<agent-id>.json` points at the persona's Claude session. It is the one durable file: without it, the next message starts a new session, and the old conversation is left behind in Claude Code's own transcripts under `~/.claude/projects/`.
- `<agent-id>.jsonl` is a display cache of the thread. It can be deleted; the thread view is then empty until new messages arrive.

Back up the data root to keep the session pointers. `POST /api/agents/<id>/new-thread` deletes both files for that persona.

`settings.json` in the data root (`DASHBOARD_SETTINGS_PATH`) holds what the Settings card on Health sets: the default model and effort for every agent's turns (null means Claude Code's own default), which agent's thread receives the morning brief notice, which agent quick chat opens on, and the default permission level (`ask`, `auto`, or `full`; a file from before the key loads as `ask`). The daemon writes it on first start, naming the first pinned Claude agent for the brief and the first built-in Claude agent (else the pinned one, else the first) for quick chat, and reads it once at each start. A file from before quick chat existed gains `quickChat` on the next start, logged `settings_migrated`; nothing else in it changes. If it is edited by hand into something the daemon cannot read, the daemon logs `settings_error`, runs on the last good values, and the card refuses saves until the file is fixed or deleted; deleting it makes the next start seed it again.

A persona turn is interrupted 30 minutes after it starts (`TIMEOUTS.turnMaxMs`), and that clock keeps running while the persona waits on an answer: a question raised 10 minutes in leaves 20 minutes to answer it. The persona then shows `turn_timeout` as its last error until its next turn. Changing a persona's `cwd` in the registry keeps its session pointer and its working folder until a new thread starts; New thread moves the persona to the new folder.

Agents message each other through the ask tool every turn carries (README, Delegation). An agent's `accepts` in the registry, edited from its settings, is what bounds who may message it; a message to an agent with a turn open is refused as busy, and a reply that takes longer than five seconds (`TIMEOUTS.delegationWaitMs`) lands in the sender's thread as a line when it arrives and is prepended to the sender's next turn. Replies waiting for that turn live in memory only: a restart drops them, and the lines in the thread remain. The log's `delegation_*` entries say what was asked of whom and how it ended.

## Running Codex sessions through the dashboard

The dashboard follows Codex threads on one shared `codex app-server` that you own from a terminal; it never starts that server itself. Both helpers read `DASHBOARD_CODEX_DIR` (default `codex/` under the data root).

1. In a cmux terminal you keep open, start the server:

   ```sh
   ./bin/codex-serve
   ```

   It prints the socket path and writes `codex/owner.json`; the dashboard notices the file within a few seconds and lists, under `sessions`, the threads the server holds in memory plus the newest 20 that `codex-new` recorded. It never touches threads open elsewhere (the VS Code extension, the ChatGPT app), which the server refuses to share anyway. Stop it with Ctrl-C: the owner file is removed at once and the server closes its socket within a second, but the server itself can take up to half a minute to exit while a TUI is still attached to it, and `codex-serve` waits for it. The dashboard reports the server gone (`codex.reason` `no_server`, an empty session list) about three seconds after the socket closes, once two reconnect attempts have found no socket, not when the process finally exits.

   If it says a server is already running, `owner.json` names a live pid. Usually that is another `codex-serve` in a terminal you still have open; use that one or stop it with Ctrl-C there. It can also be a server whose `codex-serve` was killed outright (a closed terminal, `kill -9`): the `codex app-server` child keeps running, holding the socket, and nothing removes the file. Confirm with `ps -p <pid>` from the message, then `kill <pid>` and start `codex-serve` again; it clears the stale file and socket itself once the pid is gone. Restarting `codex-serve` while the dashboard is connected is fine: it sees the new pid and socket and moves over.

2. In each new cmux terminal where you want a Codex thread, start it through the helper so the dashboard can find the terminal again:

   ```sh
   ./bin/codex-new --cwd ~/workspace/some/repo
   ```

   It opens the Codex TUI on the shared server and, once the TUI has started its thread (after the update nudge and the trust prompt, if they appear), records the thread with this cmux workspace and surface in `codex/bindings.json`; the dashboard lists it from then on and its "Open terminal" brings that exact terminal to the front while it stays open. When the TUI exits, the helper prints which thread it recorded, or that none was started. Run outside cmux it still works, but the record has no terminal and "Open terminal" stays unavailable for that thread. A thread started from a plain `codex` command, not on the shared server, is not seen by the dashboard at all.

   When driving the Codex TUI from cmux (`cmux send`), a trailing newline does not submit the prompt; it sits in the composer. Send the text, then `cmux send-key Enter`. A plain shell in the same terminal does take the newline.

   Start one `codex-new` per folder at a time. The server tells every client about every new thread, so two helpers waiting in the same folder could each record the other's thread. While one waits it holds a marker under `codex/waiting/`, and a second one in that folder refuses with "Another codex-new is waiting in this folder. Start it after that terminal reaches its prompt." Once the first TUI is at its prompt (its thread is recorded and the marker is gone), start the next. A marker left by a helper that died is ignored. If the helper says a thread is already bound to another terminal, the server announced a thread that another terminal owns; nothing is recorded, and that terminal keeps its record.

The socket path must stay under 104 bytes, the macOS limit for a Unix socket; `codex-serve` refuses one over 100. If the data root ever lives somewhere deep, pass `--socket` with a shorter path, in a directory you own: the server tightens the socket's directory to mode 0700 and fails with "Operation not permitted" in a shared one such as `/tmp` or `/private/tmp` (the same directory; `/tmp` is a symlink to it on macOS). The server is started with `features.default_mode_request_user_input=true` and `features.request_permissions_tool=true`; both are still marked under development in Codex 0.155.1, and both are required for questions and permission requests to reach the dashboard. The TUI does not announce them.

Answering from the dashboard sends only once-only decisions: a question's answers, `accept` or `decline` for a command or file change, and a permission grant limited to the request and the turn. Anything broader, such as a session-wide grant, is answered in the terminal, and the dashboard marks such requests as terminal only. If the socket drops while the server is up, the rows stay listed as `unavailable` and `codex.reason` is `disconnected` until the dashboard reconnects with backoff, lists and resumes the threads again, and any request still waiting is replayed to it.

A thread started moments ago is listed by its folder name, with no title, until its first turn: the server has not written it to disk yet, so the dashboard's resume fails and is retried every few seconds (up to every 30 seconds). Its first question arrives with the resume that succeeds, so it can trail the terminal by up to half a minute. Each failed attempt prints an `ERROR ... no rollout found` line in the `codex-serve` terminal; that is expected for a fresh thread.

`npm run verify:codex -- --yes` runs a live check on a disposable server and bills one short turn; use it after a Codex upgrade. `npm ci` must have been run: without `ws` the dashboard starts but reports `ws_unavailable` and follows nothing.

## Agent registry

The Agents view and the persona runtime read the agent registry from `registry/agents.json` in the data root. It is local data the dashboard writes and holds absolute paths. Set `DASHBOARD_REGISTRY_PATH` to use another file and `DASHBOARD_LAUNCH_AGENTS_DIR` to read plists from another directory (default `~/Library/LaunchAgents`). Health reads the jobs from launchd on macOS and from systemd elsewhere; `DASHBOARD_JOB_RUNNER` (`launchd` or `systemd`) overrides that. Under systemd a label names the user units `<label>.service` and `<label>.timer`, read with `systemctl --user show`; a label with no such service is listed as unavailable. The daemon checks the file every few seconds; if an edit leaves it unreadable or invalid, the daemon keeps the last good registry and reports the error in the state, and the Health view shows it above the jobs. An entry whose folder does not exist still loads and reads as unavailable ("CFO's folder is missing."), with its chat readable; the daemon re-checks the folders on every poll, so creating the folder makes the agent available within a few seconds. An agent's optional `permission` (`ask`, `auto`, `full`) is the level its turns run at; absent means the settings default. The gear panel writes it; the key on a project or Codex entry is accepted and ignored, as `model` is. An agent's picture is `avatar.png`, `avatar.jpg`, or `avatar.webp` in its `cwd` (first found wins), or the file the optional `avatar` key names (a path relative to the `cwd`, or absolute; for an agent whose folder is its own repository); PNG, JPEG, or WebP up to 512 KiB, never SVG; a file that cannot be used is logged once as `avatar_skipped` with its reason. `GET /api/agents/<id>/avatar` serves it, and an agent without one shows its initials. The daemon reads the file when the registry loads and on each status refresh, so a new picture shows on the next page load; the gear panel keeps the `avatar` key on a save.

`registry/builtin.json` (`DASHBOARD_BUILTIN_PATH`, tracked) lists the agents that are part of the dashboard, Myos and Scout, in the registry's shape without `cwd`; an entry may name a `folder` relative to this repository (Myos's is `agents/myos`). At each start, before the hub, the daemon adds any of them the registry lacks (including into a registry file that does not exist yet) with that folder, or this repository without one, as the absolute `cwd`, and the first listed group when theirs is not listed, and logs `builtins_seeded`. It skips a registry that is unreadable or fails validation (fixed by hand), and logs `builtins_error` when `registry/builtin.json` cannot be read. The entry carries `builtin: true`: it can be edited like any agent but not deleted from the dashboard, and an entry deleted by hand comes back on the next start. Deleting any other persona from its gear panel (`DELETE /api/agents/<id>`) rewrites the registry, removes its routines and runs logs, and leaves `threads/` alone, so re-adding the id restores the thread.

Goals needs a `second-brain` agent in the registry and reads its notes from that agent's cwd. The Feed reads `feeds/` and `sources/` under the data root (`DASHBOARD_FEEDS_DIR`, `DASHBOARD_SOURCES_DIR`); Discuss needs the agent a feed names as its producer. Ideas reads `ideas/items/`, `ideas/marks.json`, and `ideas/criteria.md` under the data root (`DASHBOARD_IDEAS_DIR`, `DASHBOARD_IDEAS_MARKS`, `DASHBOARD_IDEAS_INSTRUCTIONS`); a change proposed from either instructions panel names the criteria file by its absolute path; its routes are `GET` and `POST /api/ideas`, `POST /api/ideas/dismiss`, `POST /api/ideas/save`, `POST /api/ideas/unsave`, `POST /api/ideas/start`, `POST /api/ideas/refresh`, and the two `/api/ideas/instructions` routes. `GET /api/ideas` answers with `producer` and `routine`, the id of the producer's first routine whose instruction or name contains "ideas", or null; the New ideas header action runs that routine now through `POST /api/routines/:id/run` and is disabled when `routine` is null. Each week heading's refresh button posts `POST /api/ideas/refresh` with that week's Monday: the week's new produced ideas get a `replaced` mark in `ideas/marks.json` (nothing is deleted from any file) and the routine runs with `{ context }`, a line naming the week and its saved titles, which the run's start line in the runs log keeps. The brief's overlay reads `brief-<date>.json` from the briefs directory and `daily-brief/curator.md` (`DASHBOARD_BRIEF_INSTRUCTIONS`) as the brief's rules; a change proposed there goes to the agent Settings names under "Brief goes to", or, with "No thread" chosen, to the first pinned Claude agent, else the first built-in one.

## Routines

Routines, the scheduled prompts the daemon runs itself, are files under `routines/` in the data root (`DASHBOARD_ROUTINES_DIR`), one `<id>.json` each, written by the daemon through the dashboard. The daemon reads the directory once at start; a file it cannot read is logged `routine_invalid` and left alone, and the directory is created, user-only, on the first write. Each routine's runs are an append-only log at `routines/runs/<id>.jsonl`, kept to the newest 200 lines; deleting a routine deletes its log. Each run is a session of its own in the agent's folder, and its reply is recorded on the run's log line. Back up `routines/` with the registry; a lost runs log costs only the run history and the catch-up marker, so the next tick treats the routine as new. At start the daemon closes any run the last process left open as `interrupted`, then catches up: occurrences missed in the last seven days become one `missed` line and the latest one runs, so a routine due while the daemon was down runs once it is back. Stopping the daemon mid-run leaves that turn to the shutdown's drain and the run's line open. Routines are made and changed from the agent's settings panel in the dashboard, which never shows the cron line: the form offers a cadence and a time and composes the line. A line typed into a file by hand still loads and runs, but opens in the form at the picker's defaults, and saving from there replaces it.

The Weekly ideas routine on Myos runs the `weekly-ideas` skill from `agents/myos/.claude/skills/`, Mondays at 04:00, and writes `ideas/items/<date>-myos.json` (a second run that day writes `<date>-myos-2.json`, and so on) with at most five ideas a run; New ideas runs it on demand, and a week's refresh runs it for that week with `week` in the file.

## Notifications

Agents raise notifications with the `notify` tool into one file, `notifications/notifications.jsonl` in the data root (`DASHBOARD_NOTIFICATIONS_DIR`), one JSON line each. The directory is user-only, since a sentence may carry a figure; it is created on the first raise. The daemon reads the file once at start, skips and logs (`notification_invalid`) any line it cannot read, and keeps at most 200 notifications, rolling off the oldest acknowledged ones first. Routes: `GET /api/notifications`, `POST /api/notifications/<id>/acknowledge`, and `POST /api/notifications/acknowledge` (all); the snapshot carries them under `notifications`. To clear the list, stop the daemon and delete the file; nothing else reads it. To raise a test one, ask an agent in its thread to notify you; it appears under the header's Notifications in every open browser.

## cmux

The dashboard reads cmux's terminals and agent sessions over cmux's own socket. cmux's default socket mode admits only processes cmux started, so the daemon cannot connect until this is done once. Verified on 2026-09-28 with cmux 0.64.25; the app was quit throughout.

1. Back up `~/.config/cmux/cmux.json` beside itself (`cmux.json.bak-<date>`), then add one active key to it, keeping everything else:

   ```json
   "automation": { "socketControlMode": "password" },
   ```

   `cmux config doctor` should report the file valid with `automation` among its keys.
2. Write a random password to `~/Library/Application Support/cmux/socket-control-password` with mode 600, for example `(umask 077; openssl rand -hex 32 > "$HOME/Library/Application Support/cmux/socket-control-password")`. Settings is not involved; nothing needs to be typed there.
3. Launch cmux normally. On launch it moves that file to `~/.local/state/cmux/socket-control-password` (still mode 600) and keeps it there across quits. That is the file the daemon reads (`DASHBOARD_CMUX_PASSWORD_FILE`).
4. From a terminal that is not inside cmux, `cmux ping` should print `PONG` with no password flag or variable; `cmux --password wrong ping` should print `Error: ERROR: Invalid password`. The shell needs `cmux` on `PATH` (`/opt/homebrew/bin/cmux`, the cask's link into the app bundle). The daemon does not use `PATH`: it runs the bundle binary at `DASHBOARD_CMUX_CLI`.

The daemon never starts cmux. While cmux is not running, or before the steps above, the module reports why (`not_running`, `no_password`, or `auth_failed`) and lists nothing; a refused password is logged once as `cmux_auth_failed` and tried again on the next call, so fixing the file or the setting needs no dashboard restart. Set `DASHBOARD_CMUX_SOCKET_PATH_FILE`, `DASHBOARD_CMUX_PASSWORD_FILE`, or `DASHBOARD_CMUX_CLI` if cmux keeps a file or its binary elsewhere; a missing binary is logged once as `cmux_cli_missing`.

Only agents started from a cmux terminal appear: cmux registers `claude` through a wrapper it puts on `PATH`, and the daemon reads that register with `cmux sessions list --json`. A Claude session started from another terminal has no row.

The daemon reads cmux only while a browser has the dashboard open. When the first event stream opens it refreshes the inventory once, then every 10 seconds (`TIMEOUTS.sessionsPollMs`) while any stream stays open, and once more on each `POST /api/sessions/refresh`; with no stream open it reads nothing, and the last inventory stands until the next. One refresh is one `workspace.list` and one `surface.list` per workspace over the socket, all on the daemon's single connection (each request bounded by `TIMEOUTS.cmuxRequestMs`, 5 seconds), plus one `cmux sessions list --json` subprocess (bounded by `TIMEOUTS.cmuxSessionsMs`, 5 seconds), which is the larger of the two costs. The same pass asks the Codex adapter for a poll now, but that adapter already polls its owner file and catalogue every 3 seconds (`TIMEOUTS.codexPollMs`) on its own, stream or no stream; the interval only brings one poll forward. Refreshes never overlap: a slow one is shared by the callers that arrive during it. A refresh that fails keeps the last good listing for up to five minutes, marked `stale` in the snapshot's `cmux`. Each refresh commits a new revision only when something in `sessions` or `cmux` changed, so an idle cmux costs the streams nothing.

"Open terminal" in the dashboard is `POST /api/sessions/<id>/open-terminal`. It focuses the exact workspace and surface recorded for the session (by `bin/codex-new` for a Codex thread, by cmux itself for a Claude terminal), never one chosen by folder, and refuses when nothing was recorded (`unbound`), when cmux cannot be reached (`cmux_unavailable`, with the inventory's reason, or `no_client` when the dashboard runs without a cmux client), or when that terminal is no longer in the inventory (`terminal_closed`). Every focus is logged as `cmux_focus` with the ids and the outcome.

## Node path after upgrades

The plist records the absolute Node executable selected during installation. After upgrading or removing that Node installation, reinstall with Node 24 or newer so the plist points at the current executable. Normally the installer uses the Node process running it; an explicit executable can be selected with `--node /absolute/path/to/node`.

## Cutover procedure

These are steps Hunter runs manually. They change Tailscale Serve and eventually stop the old brief server; the installer does neither.

1. Finish phases 1–4 locally. Re-check listeners, `tailscale serve status --json`, `tailscale funnel status --json`, and the existing Focus LaunchAgent. Record the exact pre-cutover mapping in a private local operations record. If it differs from the expected single root mapping to 4242, reconcile the runbook before changing it; do not reset all Serve settings.
2. Install the dashboard LaunchAgent with the actual HTTPS public origin. Verify it serves 4243 after a `launchctl kickstart`, stays loopback-only, and reports its own health independently of child availability.
3. Preserve unsaved brief drafts from the old browser origin (http://localhost:8765) using its existing Save/Copy controls. Moving to the tailnet origin cannot carry localStorage automatically. Existing feedback files remain in place. Keep the old server available while this is checked; do not delete browser storage.
4. Check that the dashboard accepts the tailnet host name before Tailscale sends it traffic. Use the host from the public origin the LaunchAgent was installed with:

   ```sh
   curl -sS -o /dev/null -w '%{http_code}\n' -H 'Host: your-machine.your-tailnet.ts.net' http://127.0.0.1:4243/healthz
   curl -sS -o /dev/null -w '%{http_code}\n' -H 'Host: some-other-host.example' http://127.0.0.1:4243/healthz
   ```

   The first should print 200. The second uses a host that is not configured and should print 421, which shows the Host check is in force. If the first prints 421, the tailnet host does not match the public origin the job was installed with; reinstall with the right origin before going on.
5. Replace the HTTPS root mapping with the dashboard:

   ```sh
   tailscale serve --bg --https=443 http://127.0.0.1:4243
   tailscale serve status --json
   tailscale funnel status --json
   ```

   If the tailnet URL then answers 421 or 403, Tailscale is presenting a different Host or Origin than the one configured. Roll back as described under Rollback, then correct the origin and reinstall.
6. From another tailnet device, load the existing HTTPS hostname and the direct routes (/focus, /feed, /goals). Verify the shell, touch layout, same-origin API requests, and real feedback saving. Hunter performs one intended Focus action and one intended feedback save; inspect their normal local outputs without inventing tasks on the live board. Confirm there is one exposed HTTPS service and no Funnel entry.
7. Only after those checks, identify the current 8765 listener by PID, command, and working directory (`lsof -nP -iTCP:8765 -sTCP:LISTEN`). Stop that exact `serve.py` process gracefully; confirm 8765 is closed while 4242/4243 and the dashboard URL remain healthy. Keep `serve.py`, viewers, builders, briefs, and feedback for rollback.
8. Check service recovery after login/restart when a suitable opportunity occurs. The app is available while the Mac is awake and the user LaunchAgent is loaded; this does not add an always-on host or machine-sleep policy.

## Rollback

If the integrated URL fails, restore Focus at the existing root:

```sh
tailscale serve --bg --https=443 http://127.0.0.1:4242
tailscale serve status --json
tailscale funnel status --json
```

Verify Focus remotely. If the brief server was stopped, and 8765 is still free, restart it with `python3 serve.py` from `~/workspace/personal-assistant/daily-brief/briefs/`. Do not overwrite saved feedback or clear either origin's drafts. The dashboard can remain running locally for diagnosis; stop only its own LaunchAgent if necessary. The preflight snapshot takes precedence if the original Serve mapping changed before rollout.
