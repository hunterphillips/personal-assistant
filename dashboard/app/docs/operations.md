# Operations

Run all commands from the repository root. This runbook covers the dashboard user LaunchAgent and the manual Tailscale cutover; the installer itself never changes Tailscale.

## Install

Run a dry run first. It renders and validates the plist inside the application without changing `~/Library/LaunchAgents` or loading a job:

```sh
./bin/dashboard-install --dry-run --public-origin https://your-machine.your-tailnet.ts.net
```

The rendered plist is `var/launchd/com.personal-assistant.dashboard.plist`. Inspect it, then install with the actual HTTPS origin for the existing tailnet hostname:

```sh
./bin/dashboard-install --public-origin https://your-machine.your-tailnet.ts.net
```

The installer creates only the `com.personal-assistant.dashboard` user LaunchAgent. It does not install or change Focus, the old brief server, or Tailscale Serve.

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

Standard output and standard error both go to `var/log/dashboard.log`. Each time the job starts, `bin/dashboard-start` renames the current log to `dashboard.log.1` if it is larger than 5 MiB, replacing the prior `.1` file. The check runs only at start, so the log can grow past 5 MiB while the server keeps running; it is rotated at the next restart. The installer creates `var/log/` with user-only permissions.

```sh
tail -f var/log/dashboard.log
```

## Reinstall and job rollback

Run the install command again to reinstall. Before replacing an existing plist, the installer saves it as `var/launchd/backup-<timestamp>.plist` and notes whether the job is loaded.

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

Uninstall unloads only `com.personal-assistant.dashboard` and removes only `~/Library/LaunchAgents/com.personal-assistant.dashboard.plist`. It preserves the source tree, `var/`, logs, briefs, feedback, Focus jobs, and all Tailscale settings.

## Persona threads

Each persona keeps two files in `var/threads/` (`DASHBOARD_THREADS_DIR`), readable only by this account:

- `<agent-id>.json` points at the persona's Claude session. It is the one durable file: without it, the next message starts a new session, and the old conversation is left behind in Claude Code's own transcripts under `~/.claude/projects/`.
- `<agent-id>.jsonl` is a display cache of the thread. It can be deleted; the thread view is then empty until new messages arrive.

Back up `var/` to keep the session pointers. `POST /api/agents/<id>/new-thread` deletes both files for that persona.

`var/settings.json` (`DASHBOARD_SETTINGS_PATH`) holds what the Settings card on Health sets: the default model and effort for every agent's turns (null means Claude Code's own default), which agent's thread receives the morning brief notice, and the default permission level (`ask`, `auto`, or `full`; a file from before the key loads as `ask`). The daemon writes it on first start, naming the first pinned Claude agent, and reads it once at each start. If it is edited by hand into something the daemon cannot read, the daemon logs `settings_error`, runs on the last good values, and the card refuses saves until the file is fixed or deleted; deleting it makes the next start seed it again.

A persona turn is interrupted 30 minutes after it starts (`TIMEOUTS.turnMaxMs`), and that clock keeps running while the persona waits on an answer: a question raised 10 minutes in leaves 20 minutes to answer it. The persona then shows `turn_timeout` as its last error until its next turn. Changing a persona's `cwd` in the registry keeps its session pointer and its working folder until a new thread starts; New thread moves the persona to the new folder.

Agents message each other through the ask tool every turn carries (README, Delegation). An agent's `accepts` in the registry, edited from its settings, is what bounds who may message it; a message to an agent with a turn open is refused as busy, and a reply that takes longer than five seconds (`TIMEOUTS.delegationWaitMs`) lands in the sender's thread as a line when it arrives and is prepended to the sender's next turn. Replies waiting for that turn live in memory only: a restart drops them, and the lines in the thread remain. The log's `delegation_*` entries say what was asked of whom and how it ended.

## Running Codex sessions through the dashboard

The dashboard follows Codex threads on one shared `codex app-server` that you own from a terminal; it never starts that server itself. Both helpers read `DASHBOARD_CODEX_DIR` (default `var/codex`).

1. In a cmux terminal you keep open, start the server:

   ```sh
   ./bin/codex-serve
   ```

   It prints the socket path and writes `var/codex/owner.json`; the dashboard notices the file within a few seconds and lists, under `sessions`, the threads the server holds in memory plus the newest 20 that `codex-new` recorded. It never touches threads open elsewhere (the VS Code extension, the ChatGPT app), which the server refuses to share anyway. Stop it with Ctrl-C: the owner file is removed at once and the server closes its socket within a second, but the server itself can take up to half a minute to exit while a TUI is still attached to it, and `codex-serve` waits for it. The dashboard reports the server gone (`codex.reason` `no_server`, an empty session list) about three seconds after the socket closes, once two reconnect attempts have found no socket, not when the process finally exits.

   If it says a server is already running, `owner.json` names a live pid. Usually that is another `codex-serve` in a terminal you still have open; use that one or stop it with Ctrl-C there. It can also be a server whose `codex-serve` was killed outright (a closed terminal, `kill -9`): the `codex app-server` child keeps running, holding the socket, and nothing removes the file. Confirm with `ps -p <pid>` from the message, then `kill <pid>` and start `codex-serve` again; it clears the stale file and socket itself once the pid is gone. Restarting `codex-serve` while the dashboard is connected is fine: it sees the new pid and socket and moves over.

2. In each new cmux terminal where you want a Codex thread, start it through the helper so the dashboard can find the terminal again:

   ```sh
   ./bin/codex-new --cwd ~/workspace/some/repo
   ```

   It opens the Codex TUI on the shared server and, once the TUI has started its thread (after the update nudge and the trust prompt, if they appear), records the thread with this cmux workspace and surface in `var/codex/bindings.json`; the dashboard lists it from then on and its "Open terminal" brings that exact terminal to the front while it stays open. When the TUI exits, the helper prints which thread it recorded, or that none was started. Run outside cmux it still works, but the record has no terminal and "Open terminal" stays unavailable for that thread. A thread started from a plain `codex` command, not on the shared server, is not seen by the dashboard at all.

   When driving the Codex TUI from cmux (`cmux send`), a trailing newline does not submit the prompt; it sits in the composer. Send the text, then `cmux send-key Enter`. A plain shell in the same terminal does take the newline.

   Start one `codex-new` per folder at a time. The server tells every client about every new thread, so two helpers waiting in the same folder could each record the other's thread. While one waits it holds a marker under `var/codex/waiting/`, and a second one in that folder refuses with "Another codex-new is waiting in this folder. Start it after that terminal reaches its prompt." Once the first TUI is at its prompt (its thread is recorded and the marker is gone), start the next. A marker left by a helper that died is ignored. If the helper says a thread is already bound to another terminal, the server announced a thread that another terminal owns; nothing is recorded, and that terminal keeps its record.

The socket path must stay under 104 bytes, the macOS limit for a Unix socket; `codex-serve` refuses one over 100. If the checkout ever lives somewhere deep, pass `--socket` with a shorter path, in a directory you own: the server tightens the socket's directory to mode 0700 and fails with "Operation not permitted" in a shared one such as `/tmp` or `/private/tmp` (the same directory; `/tmp` is a symlink to it on macOS). The server is started with `features.default_mode_request_user_input=true` and `features.request_permissions_tool=true`; both are still marked under development in Codex 0.155.1, and both are required for questions and permission requests to reach the dashboard. The TUI does not announce them.

Answering from the dashboard sends only once-only decisions: a question's answers, `accept` or `decline` for a command or file change, and a permission grant limited to the request and the turn. Anything broader, such as a session-wide grant, is answered in the terminal, and the dashboard marks such requests as terminal only. If the socket drops while the server is up, the rows stay listed as `unavailable` and `codex.reason` is `disconnected` until the dashboard reconnects with backoff, lists and resumes the threads again, and any request still waiting is replayed to it.

A thread started moments ago is listed by its folder name, with no title, until its first turn: the server has not written it to disk yet, so the dashboard's resume fails and is retried every few seconds (up to every 30 seconds). Its first question arrives with the resume that succeeds, so it can trail the terminal by up to half a minute. Each failed attempt prints an `ERROR ... no rollout found` line in the `codex-serve` terminal; that is expected for a fresh thread.

`npm run verify:codex -- --yes` runs a live check on a disposable server and bills one short turn; use it after a Codex upgrade. `npm ci` must have been run: without `ws` the dashboard starts but reports `ws_unavailable` and follows nothing.

## Agent registry

The Agents view and the persona runtime read the agent registry from `personal-assistant/registry/agents.json`, outside the app directory. It is tracked in the umbrella repository and holds absolute paths. Set `DASHBOARD_REGISTRY_PATH` to use another file (default `../../registry/agents.json`, resolved from the app directory) and `DASHBOARD_LAUNCH_AGENTS_DIR` to read plists from another directory (default `~/Library/LaunchAgents`). The daemon checks the file every few seconds; if an edit leaves it unreadable or invalid, the daemon keeps the last good registry and reports the error in the state, and the Health view shows it above the jobs. An agent's optional `permission` (`ask`, `auto`, `full`) is the level its turns run at; absent means the settings default. The gear panel writes it; the key on a project or Codex entry is accepted and ignored, as `model` is.

Goals needs a `second-brain` persona in the registry and reads its notes from that persona's cwd. The Feed reads `feed/items/` at the umbrella root (`DASHBOARD_FEED_DIR`) and `daily-brief/watch/relevance.md` (`DASHBOARD_FEED_INSTRUCTIONS`); its Discuss and its Feed instructions composer need a `watch` persona.

## Routines

Routines, the scheduled prompts the daemon runs itself, are files under `personal-assistant/routines/` (`DASHBOARD_ROUTINES_DIR`, default `../../routines` from the app directory), one `<id>.json` each, written by the daemon through the dashboard and tracked in the umbrella repository like the registry. The daemon reads the directory once at start; a file it cannot read is logged `routine_invalid` and left alone, and the directory is created, user-only, on the first write. Each routine's runs are an append-only log at `routines/runs/<id>.jsonl`, kept to the newest 200 lines and ignored by git; deleting a routine deletes its log. Back up `routines/` with the registry; a lost runs log costs only the run history and the catch-up marker, so the next tick treats the routine as new.

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
6. From another tailnet device, load the existing HTTPS hostname and the direct routes (/focus, /reading, /goals). Verify the shell, touch layout, same-origin API requests, and real feedback saving. Hunter performs one intended Focus action and one intended feedback save; inspect their normal local outputs without inventing tasks on the live board. Confirm there is one exposed HTTPS service and no Funnel entry.
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
