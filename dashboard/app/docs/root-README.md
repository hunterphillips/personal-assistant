# The data root

This folder holds everything the personal assistant writes while it is used:
the agent registry, routines and their runs, threads, notifications, settings,
the Feed and Ideas stores, the briefs, and the two criteria files. The code
lives in its repository; the data lives here, as plain files you can read.

## What is where

| Path | What it holds |
| --- | --- |
| `README.md` | This file. |
| `layout.json` | The layout's version, when the root was created, and the checkout its data came from. |
| `daemon.lock` | The running daemon's pid and start time. |
| `settings.json` | The dashboard's settings. |
| `thread-reads.json` | When each agent's thread was last read. |
| `registry/agents.json` | The agent registry. |
| `routines/` | One `<id>.json` per routine, and `runs/<id>.jsonl` with each routine's runs. |
| `threads/` | Each agent's thread, `<id>.json` and `<id>.jsonl`, and `brief-notices.json`. |
| `codex/` | `bindings.json` and its `bindings.lock`, `owner.json`, the server's `app.sock`, and `waiting/` for the Codex threads. |
| `notifications/` | `notifications.jsonl`. |
| `feed/items/` | One `<date>-<producer>.json` per run of a Feed producer. |
| `feed/relevance.md` | Hunter's criteria for the Feed. |
| `ideas/items/` | One `<date>-<producer>.json` per run of an Ideas producer. |
| `ideas/marks.json` | The marks on ideas: taken, dismissed, saved, replaced. |
| `ideas/criteria.md` | Hunter's criteria for Ideas. |
| `briefs/` | Each day's brief, memo, viewer, brief data, notice, and feedback, and the run lock. |
| `briefs/contributions/` | Each day's contributions, one folder per date. |
| `watch/` | Watch's `packets/`, `overflow/`, `seen.jsonl`, `state.json`, and its run lock. |
| `log/` | `dashboard.log`, and under `checkout/` the log the checkout held before the move. |
| `cache/` | The rendered launchd plist and its backups under `launchd/` (the checkout's under `launchd/checkout/`), and `ops/`. |

## Who writes what

The daemon owns every file that is edited after it is created. A producer, a
scheduled run that adds something, only creates its own run files, such as a
new file under `feed/items/` or `ideas/items/`, and never edits one that
exists. The brief run writes `briefs/` and marks a packet reported in
`watch/state.json`; Watch writes `watch/` and its Feed file.

`layout.json` names the layout version. A daemon that finds a version newer
than the one it knows leaves the root alone.

`log/` and `cache/` can be rebuilt and are left out of backups. Everything
else is the record; back it up when moving machines.

## Where the root is

`~/.personal-assistant/`, unless `PERSONAL_ASSISTANT_HOME` names another
absolute path. The daemon sets that variable for every agent turn and
routine it runs, so an agent finds this file at
`$PERSONAL_ASSISTANT_HOME/README.md`. Agents change daemon-owned files only
through the dashboard's routes and tools. The brief run and Watch read the
variable from their own environment, with the same default.

## The lock

While a daemon runs it holds `daemon.lock`. A second daemon started over the
same root logs `root_locked` with the holder's pid and exits. A lock whose
process has died is taken over at the next start.

## The move from the checkout

A daemon that finds no `layout.json` moves the data the repository checkout
held before this folder existed: it copies each source here, checks every
copied file against its source, and renames the source to
`<source>.migrated` beside itself. The briefs' data files go to
`daily-brief/briefs.migrated/`, and the brief's code stays where it is. When a
file here already differs from its source, the daemon names both and does
not start until one of them is removed or made to match. `layout.json` is
written last, so a move cut off midway runs again cleanly. Nothing is
deleted; remove the `.migrated` paths once the dashboard has run from here
for a week.

## Backups and moving machines

Time Machine keeps this folder. Leave `log/` and `cache/` out:

```sh
tmutil addexclusion ~/.personal-assistant/log ~/.personal-assistant/cache
```

To move to another Mac, stop the daemon and copy the whole folder to the
same place there. There is no git history here and never a remote: the
briefs and contributions carry exact financial figures.
