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

After pulling a new revision, run `npm ci` in `dashboard/app` before the installer. The app has two runtime dependencies (`@anthropic-ai/claude-agent-sdk` and `ws`), and the LaunchAgent does not install packages; a dashboard started without the SDK shows every persona as unavailable with `sdk_unavailable`, and one started without `ws` does not start at all.

If the job is loaded, the installer first asks the running dashboard for `GET /api/state` on 127.0.0.1, at the port recorded in the installed plist (the new `--port` only when no previous plist can be read). If any persona is busy or waiting on an answer, it stops without unloading anything and names those personas. Wait for them to finish, or pass `--force` to unload anyway. If the dashboard does not answer, the installer goes on.

It then unloads only `com.personal-assistant.dashboard` and waits up to 40 seconds for the old process to exit, which covers the shutdown below.

## Shutdown

On SIGTERM or SIGINT, as when launchd unloads the job, the dashboard:

1. Ends every event stream and refuses new persona messages and new threads with 503 `shutting_down`.
2. Drains persona turns. A turn waiting on a question or approval is aborted at once. Running turns get up to 30 seconds (`TIMEOUTS.drainMs`) to finish; any still running are then aborted and given 2 seconds (`TIMEOUTS.abortGraceMs`) to end.
3. Stops the state hub and the registry poll.
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

A persona turn is interrupted 30 minutes after it starts (`TIMEOUTS.turnMaxMs`), and that clock keeps running while the persona waits on an answer: a question raised 10 minutes in leaves 20 minutes to answer it. The persona then shows `turn_timeout` as its last error until its next turn. Changing a persona's `cwd` in the registry keeps its session pointer; if the next turn cannot resume, start a new thread.

## Running Codex sessions through the dashboard

The dashboard follows Codex threads on one shared `codex app-server` that you own from a terminal; it never starts that server itself. Both helpers read `DASHBOARD_CODEX_DIR` (default `var/codex`).

1. In a cmux terminal you keep open, start the server:

   ```sh
   ./bin/codex-serve
   ```

   It prints the socket path and writes `var/codex/owner.json`; the dashboard notices the file within a few seconds and lists the 20 most recently updated threads under `sessions`. Stop it with Ctrl-C; the owner file is removed and the dashboard's session list empties until the next start. If it says a server is already running, another `codex-serve` owns the socket; use that one or stop it first.

2. In each new cmux terminal where you want a Codex thread, start it through the helper so the dashboard can find the terminal again:

   ```sh
   ./bin/codex-new --cwd ~/workspace/some/repo
   ```

   It creates the thread on the shared server, records the cmux workspace and surface in `var/codex/bindings.json`, and opens the Codex TUI on that thread. Run outside cmux it still works, but the record has no terminal and "Open terminal" stays unavailable for that thread. A thread started from a plain `codex` command, not on the shared server, is not seen by the dashboard at all.

The socket path must stay under 104 bytes, the macOS limit for a Unix socket; `codex-serve` refuses one over 100. If the checkout ever lives somewhere deep, pass `--socket` with a shorter path. The server is started with `features.default_mode_request_user_input=true` and `features.request_permissions_tool=true`; both are still marked under development in Codex 0.155.1, so each thread prints a warning about them, and both are required for questions and permission requests to reach the dashboard.

Answering from the dashboard sends only once-only decisions: a question's answers, `accept` or `decline` for a command or file change, and a permission grant limited to the request and the turn. Anything broader, such as a session-wide grant, is answered in the terminal, and the dashboard marks such requests as terminal only. If the server goes away, the dashboard reconnects with backoff, lists and resumes the threads again, and any request still waiting is replayed to it.

`npm run verify:codex -- --yes` runs a live check on a disposable server and bills one short turn; use it after a Codex upgrade.

## Agent registry

The Routines and Agents views and the persona runtime read the agent registry from `personal-assistant/registry/agents.json`, outside this repository. It is unversioned local configuration and holds absolute paths, so it is not committed anywhere. Set `DASHBOARD_REGISTRY_PATH` to use another file (default `../../registry/agents.json`, resolved from the app directory) and `DASHBOARD_LAUNCH_AGENTS_DIR` to read plists from another directory (default `~/Library/LaunchAgents`). The daemon checks the file every few seconds; if an edit leaves it unreadable or invalid, the daemon keeps the last good registry and reports the error in the state, and the Routines view shows it. Back up `registry/` with the rest of `personal-assistant/`.

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
6. From another tailnet device, load the existing HTTPS hostname and both direct routes (/focus, /brief). Verify the shell, touch layout, same-origin API requests, and real feedback saving. Hunter performs one intended Focus action and one intended feedback save; inspect their normal local outputs without inventing tasks on the live board. Confirm there is one exposed HTTPS service and no Funnel entry.
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
