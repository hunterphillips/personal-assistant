# The data root

This folder holds everything the personal assistant writes while it is used:
the agent registry, routines and their runs, threads, notifications, settings,
the feeds and their sources, the Ideas store, the briefs, and the Ideas
criteria. The code
lives in its repository; the data lives here, as plain files you can read.

## What is where

| Path | What it holds |
| --- | --- |
| `README.md` | This file. |
| `layout.json` | The layout's version, when the root was created, and the checkout its data came from. |
| `daemon.lock` | The running daemon's pid and start time. |
| `settings.json` | The dashboard's settings. |
| `thread-reads.json` | When each agent's thread was last read. |
| `brief-reads.json` | The date of the newest brief whose overlay has been opened. |
| `registry/agents.json` | The agent registry. |
| `routines/` | One `<id>.json` per routine, and `runs/<id>.jsonl` with each routine's runs. |
| `threads/` | Each agent's thread, `<id>.json` and `<id>.jsonl`, and `brief-notices.json`. |
| `codex/` | `bindings.json` and its `bindings.lock`, `owner.json`, the server's `app.sock`, and `waiting/` for the Codex threads. |
| `notifications/` | `notifications.jsonl`. |
| `feeds/<id>/feed.json` | A feed's name, the agent that produces it, its sources, and whether it runs. |
| `feeds/<id>/note.md` | Hunter's instructions for the feed. |
| `feeds/<id>/items/` | One `<date>.json` per run of the feed's producer; older runs are `<date>-<producer>.json`. |
| `feeds/<id>/marks.json` | The marks on the feed's posts: saved, dismissed. |
| `feeds/<id>/suggestions.json` | The sources the producer suggests for the feed, each with a reason. |
| `feeds/.run/` | The feeds producer's state: `packets/`, `overflow/`, `seen.jsonl`, `state.json`, and its run lock. |
| `sources/` | One `<id>.json` per source a feed can read: an RSS feed, a newsletter's sender, a file, or a folder. Its optional `aliases` are names it went by before, which old posts still carry. |
| `ideas/items/` | One `<date>-<producer>.json` per run of an Ideas producer. |
| `ideas/marks.json` | The marks on ideas: taken, dismissed, saved, replaced. |
| `ideas/criteria.md` | Hunter's criteria for Ideas. |
| `briefs/` | Each day's brief, memo, viewer, brief data, notice, and feedback, and the run lock. |
| `briefs/contributions/` | Each day's contributions, one folder per date. |
| `log/` | `dashboard.log`, and under `checkout/` the log the checkout held before the move. |
| `cache/` | The rendered launchd plist and its backups under `launchd/` (the checkout's under `launchd/checkout/`), and `ops/`. |

## Who writes what

The daemon owns every file that is edited after it is created: a feed's
`feed.json`, `note.md`, and `marks.json`, and every file in `sources/`. A
producer, a scheduled run that adds something, only creates its own run
files, such as a new file under `feeds/<id>/items/` or `ideas/items/`, and
never edits one that exists. A suggestion run writes a feed's
`suggestions.json` once; the daemon removes it before the next run. The feeds run writes `feeds/.run/` and its
feeds' item files; the brief run writes `briefs/` and marks a packet
reported in `feeds/.run/state.json`.

`layout.json` names the layout version. A daemon that finds a version newer
than the one it knows leaves the root alone.

`log/` and `cache/` can be rebuilt and are left out of backups. Everything
else is the record; back it up when moving machines.

## Where the root is

`~/.personal-assistant/`, unless `PERSONAL_ASSISTANT_HOME` names another
absolute path. The daemon sets that variable for every agent turn and
routine it runs, so an agent finds this file at
`$PERSONAL_ASSISTANT_HOME/README.md`. Agents change daemon-owned files only
through the dashboard's routes and tools. The brief run and the feeds run
read the variable from their own environment, with the same default.

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

## The upgrade to version 2

A daemon that finds version 1 in `layout.json` moves the one Feed into the
feed `news`: `feed/items/` to `feeds/news/items/`, `feed/relevance.md` to
`feeds/news/note.md`, and Watch's `packets/`, `overflow/`, `seen.jsonl`,
and `state.json` to `feeds/.run/`. It copies and checks each one as the
move from the checkout does, giving each seen line `"feed": "news"` and
moving `state.json`'s `last_run` to `feeds.news.last_run` when it creates
the feed, writes `feeds/news/feed.json`, and renames
`feed/` and `watch/` to `feed.migrated/` and `watch.migrated/`. Watch leaves
the registry, which is kept as it was in `registry/agents.json.migrated`;
its thread files are renamed `threads/watch.json.migrated` and
`threads/watch.jsonl.migrated`, and Scout, the agent that produces the
feeds, is added at the same start. A conflict names both paths and stops
the start, as the move does. Version 2 is written last.

## Backups and moving machines

Time Machine keeps this folder. Leave `log/` and `cache/` out:

```sh
tmutil addexclusion ~/.personal-assistant/log ~/.personal-assistant/cache
```

To move to another Mac, stop the daemon and copy the whole folder to the
same place there. There is no git history here and never a remote: the
briefs and contributions carry exact financial figures.
