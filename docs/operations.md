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

Run the install command again to reinstall. Before replacing an existing plist, the installer saves it as `var/launchd/backup-<timestamp>.plist`, notes whether the job is loaded, and unloads only `com.personal-assistant.dashboard`, waiting up to 10 seconds for the old process to exit.

The installer then checks that nothing else answers on 127.0.0.1:4243. If something does, such as a manual `npm start`, it stops without writing the new plist and names the port. Stop that process and run the installer again.

If the new job cannot be bootstrapped, kicked off, or made healthy within about 10 seconds, or if the process listening on 4243 is not the job's own process, the installer unloads the new job, restores the saved plist, and exits non-zero. The restored job is loaded again only if it was loaded before the install. A job that was loaded without a plist file cannot be restored; the installer warns about this before it starts. These job-level rollback steps do not change Tailscale Serve.

## Uninstall

```sh
./bin/dashboard-uninstall
```

Uninstall unloads only `com.personal-assistant.dashboard` and removes only `~/Library/LaunchAgents/com.personal-assistant.dashboard.plist`. It preserves the source tree, `var/`, logs, briefs, feedback, Focus jobs, and all Tailscale settings.

## Agent registry

The Routines view reads the agent registry from `personal-assistant/registry/agents.json`, outside this repository. It is unversioned local configuration and holds absolute paths, so it is not committed anywhere. Set `DASHBOARD_REGISTRY_PATH` to use another file (default `../../registry/agents.json`, resolved from the app directory) and `DASHBOARD_LAUNCH_AGENTS_DIR` to read plists from another directory (default `~/Library/LaunchAgents`). The daemon checks the file every few seconds; if an edit leaves it unreadable or invalid, the daemon keeps the last good registry and reports the error in the state, and the Routines view shows it. Back up `registry/` with the rest of `personal-assistant/`.

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
