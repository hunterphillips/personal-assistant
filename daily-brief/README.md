# Daily Brief

The scheduled run is `bin/run-brief`. It gathers one packet per domain,
curates the memo, builds the viewer the dashboard serves, and verifies it.
The plan and its decisions:
`thoughts/shared/plans/2026-09-27-daily-brief-scheduled-run.md`.

## Schedule (America/Chicago)

| Time | Job | Repo |
|---|---|---|
| 05:15 Mon-Fri | `com.hunter.catchup.daily`, the work brief | `~/workspace/work/nowgentic/.claude/bin/` |
| 05:30 | `com.hunter.cfo.daily`, cfo's snapshot | `~/workspace/work/investing/cfo/launchd/` |
| 05:50 | `com.focus.scan-notes`, `com.focus.scan-work` | `~/workspace/projects/AI/focus/launchd/` |
| 06:05 | `com.personal-assistant.daily-brief` | `launchd/` here |

A normal morning finishes around 06:45. The runner does not trust the
clock: it waits up to 30 minutes for today's catchup file, cfo's snapshot
log, and Focus's `last-notes.json` and `last-work.json`, then proceeds and
lists whatever is still missing in `contributions/<date>/run.yaml`, which
the memo reports under Caveats.

If the Mac is asleep, launchd fires every missed job at wake, and the wait
above puts them back in order. A Mac that is shut down does not catch up.
The runner is wrapped in `caffeinate -is`, so once it starts the Mac stays
awake until it finishes. Waking a sleeping Mac on schedule is a separate,
machine-wide power setting (root, one schedule for the whole machine). Apple
documents it as working only when the Mac is plugged in. Set on 2026-09-28,
not yet observed with the lid closed. You do not have to check: a run that
starts more than 30 minutes after 06:05 on its own date adds a Caveats line
to the memo saying when it was built. To check or change the wake:

```
sudo pmset repeat wakeorpoweron MTWRFSU 05:10:00
pmset -g sched
```

## Running by hand

```
daily-brief/bin/run-brief --dry-run            # print what would run
daily-brief/bin/run-brief --force              # today, skip the freshness wait, rebuild if built
daily-brief/bin/run-brief --date 2026-09-27 --stage curate   # rerun one stage
```

Stages are `gather`, `curate`, `verify`. Without `--force` a date that
already has a viewer exits without running. Models: opus for cfo, focus,
second-brain, and the curator; sonnet for calendar.
`DAILY_BRIEF_MODEL_<domain>=sonnet` overrides one for a run (hyphens become
underscores: `DAILY_BRIEF_MODEL_second_brain`). Timeouts:
`DAILY_BRIEF_WAIT_SECONDS`, `DAILY_BRIEF_GATHER_SECONDS`,
`DAILY_BRIEF_CURATE_SECONDS`.

The prompts each session receives are in `bin/prompts/`. The contract,
curator rules, and voice they point at are the files beside this README.

## Where things land

- `contributions/<date>/` — `cfo.yaml`, `focus.yaml`, `second-brain.yaml`,
  `calendar.yaml`, `run.yaml`, and `work.md` on weekdays. Gitignored.
- `briefs/memo-<date>.md` — the curator's memo; `<date>.md` and
  `viewer-<date>.html` built from it. The dashboard serves the newest viewer.
  Feedback saves beside it as `feedback-<date>.md`. Gitignored.
- `~/Library/Logs/daily-brief.log` — one line per run:
  `exit= date= cursor= stage= packets= stubs= waited= took= viewer=`.
- `~/Library/Logs/daily-brief/<date>-<domain>.log` — each session's output,
  mode 600. `<date>-verify.log` is the builder's.

## Pausing

```
launchctl disable gui/$(id -u)/com.personal-assistant.daily-brief
launchctl enable  gui/$(id -u)/com.personal-assistant.daily-brief
```

Editing the plist: change `launchd/com.personal-assistant.daily-brief.plist`,
then `bin/install-launchd`.
