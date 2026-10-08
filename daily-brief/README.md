# Daily Brief

The scheduled run is `bin/run-brief`. It gathers one packet per domain,
curates the memo, builds the viewer the dashboard serves, and verifies it.
The plan and its decisions:
`thoughts/shared/plans/2026-09-27-daily-brief-scheduled-run.md`.

## Schedule (America/Chicago)

| Time | Job | Repo |
|---|---|---|
| 05:30 | `com.hunter.cfo.daily`, cfo's snapshot | `~/workspace/work/investing/cfo/launchd/` |
| 05:50 | `com.focus.scan-notes` | `~/workspace/projects/AI/focus/launchd/` |
| 05:40 | `com.personal-assistant.watch`, the newsletter packet | `launchd/` here |
| 06:05 | `com.personal-assistant.daily-brief` | `launchd/` here |

A normal morning finishes around 06:45. The runner does not trust the
clock: it waits up to 30 minutes for cfo's snapshot log and Focus's
`last-notes.json`, then proceeds and
lists whatever is still missing in `run.yaml` among the day's contributions, which
the memo reports under "Things to note".

If the Mac is asleep, launchd fires every missed job at wake, and the wait
above puts them back in order. A Mac that is shut down does not catch up.

Staying awake is two pieces. A machine-wide power schedule (root, one for
the whole machine) wakes the Mac at 05:00; it has to be plugged in. That
wake is a dark wake and lasts seconds on its own, so
`com.personal-assistant.morning-hold` (`launchd/` here) fires at it and
runs `caffeinate -uis -t 10800`: a full wake with network, held until
08:00, with the lid open or closed. On battery the hold is not honored and
the morning plays out as before: jobs fire at whatever wake comes next, and
a run waits for the network through dark wakes and gives up only after five
minutes awake with none (`reason=no-network` in the log). Opening the lid
usually lets it finish.
Before 2026-10-02 nothing held the wake, and the brief only ran on mornings
Hunter opened the lid. To check or change the wake:

```
sudo pmset repeat wakeorpoweron MTWRFSU 05:00:00
pmset -g sched
```

## Running by hand

```
daily-brief/bin/run-brief --dry-run            # print what would run
daily-brief/bin/run-brief --force              # today, skip the freshness wait, rebuild if built
daily-brief/bin/run-brief --date 2026-09-27 --stage curate   # rerun one stage
```

Stages are `gather`, `curate`, `verify`. Without `--force` a date that
already has a viewer and valid brief data exits without running. Models:
opus for cfo, focus, and second-brain; `claude-sonnet-5-5` at `--effort
high` for the curator (Hunter's pick, 09-29;
`DAILY_BRIEF_EFFORT_curator` overrides); sonnet for calendar.
`DAILY_BRIEF_MODEL_<domain>=sonnet` overrides one for a run (hyphens become
underscores: `DAILY_BRIEF_MODEL_second_brain`). Timeouts:
`DAILY_BRIEF_WAIT_SECONDS`, `DAILY_BRIEF_GATHER_SECONDS`,
`DAILY_BRIEF_CURATE_SECONDS`.

The prompts each session receives are in `bin/prompts/`. The contract and
curator rules they point at are the files beside this README.

## Watch

`feeds/run/run-feeds` runs daily at 05:40 over every active feed in the
data root: it reads each feed's sources (RSS directly, newsletters from
Gmail, files and folders as context), triages the stories against the
shared rules and the feed's note, writes the feed's posts, and after the
last feed writes one packet, `feeds/.run/packets/<date>.yaml`, domain
`watch`, with every feed's kept posts. A day where no feed found anything
new writes no packet. The next brief run copies the newest packet not in
`feeds/.run/state.json`'s `reported` in as `watch.yaml` and marks it after
a successful build. `feeds/README.md` has the run, the shapes, and the
hand-run flags.

## Where things land

Everything the run writes, except the logs, lives in the data root:
`PERSONAL_ASSISTANT_HOME`, default `~/.personal-assistant`, which both
scripts read from the environment (the plists set only `HOME`). The
contracts, prompts, `briefs/build.py`, and `briefs/check-viewer.mjs` stay
here; the run calls the last two with `--dir <root>/briefs`. A dry run
prints the root first.

- `briefs/contributions/<date>/` — `cfo.yaml`, `focus.yaml`, `second-brain.yaml`,
  `calendar.yaml`, `run.yaml`, and `watch.yaml` when a packet is pending.
- `briefs/memo-<date>.md` — the curator's memo; `<date>.md`,
  `viewer-<date>.html`, `brief-<date>.json`, and `notice-<date>.json` built
  from it. The structured brief has one item per paragraph or list block.
  The dashboard serves the newest viewer and posts the notice (the opening
  and the memo, or `state: failed` when the run ended without a viewer) once
  into the Assistant's thread.
  Feedback saves beside it as `feedback-<date>.md`. The run's lock is
  `briefs/.run.lock`.
- `feeds/.run/` — the feeds run's packets, overflow, seen list, and
  `state.json`, whose `reported` list the brief run updates.
- `~/Library/Logs/daily-brief.log` — one line per run:
  `exit= date= cursor= stage= packets= stubs= waited= took= viewer= notice=`.
- `~/Library/Logs/daily-brief/<date>-<domain>.log` — each session's output,
  mode 600. `<date>-verify.log` is the builder's.

## Pausing

```
launchctl disable gui/$(id -u)/com.personal-assistant.daily-brief
launchctl enable  gui/$(id -u)/com.personal-assistant.daily-brief
```

Editing the plist: change `launchd/com.personal-assistant.daily-brief.plist`,
then `bin/install-launchd`.
