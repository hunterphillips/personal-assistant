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
| `codex/` | `bindings.json`, `owner.json`, and `waiting/` for the Codex threads. |
| `notifications/` | `notifications.jsonl`. |
| `feed/items/` | One `<date>-<producer>.json` per run of a Feed producer. |
| `feed/relevance.md` | Hunter's criteria for the Feed. |
| `ideas/items/` | One `<date>-<producer>.json` per run of an Ideas producer. |
| `ideas/marks.json` | The marks on ideas: taken, dismissed, saved, replaced. |
| `ideas/criteria.md` | Hunter's criteria for Ideas. |
| `briefs/` | Each day's brief, memo, viewer, brief data, notice, and feedback, and the run lock. |
| `briefs/contributions/` | Each day's contributions, one folder per date. |
| `watch/` | Watch's `packets/`, `overflow/`, `seen.jsonl`, and `state.json`. |
| `log/` | `dashboard.log`. |
| `cache/` | The rendered launchd plist and its backups under `launchd/`, and `ops/`. |

## Who writes what

The daemon owns every file that is edited after it is created. A producer, a
scheduled run that adds something, only creates its own run files, such as a
new file under `feed/items/` or `ideas/items/`, and never edits one that
exists.

`layout.json` names the layout version. A daemon that finds a version newer
than the one it knows leaves the root alone.

`log/` and `cache/` can be rebuilt and are left out of backups. Everything
else is the record; back it up when moving machines.
