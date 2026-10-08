---
name: suggest-sources
description: Suggest registered sources for one feed. Invoke when the instruction is "Run the suggest-sources skill for the feed the context names." (the Suggest sources routine, run by the dashboard when a feed is created or Suggest is pressed).
---

# Suggest sources

Paths below are under the data root, the folder `PERSONAL_ASSISTANT_HOME`
names.

## The feed

The run's context names the feed: `The feed id is "<id>".` With no feed
id, or no folder `feeds/<id>/`, write nothing and reply that the run named
no feed.

If `feeds/<id>/suggestions.json` already exists, stop: write nothing and
reply that suggestions are already there. The dashboard removes the file
before each run.

## Read

- `feeds/<id>/note.md`: the feed's instructions, what it is for.
- `feeds/<id>/feed.json`: its `sources`, the ids already on the feed.
- Every `sources/*.json`: each source's `id`, `name`, `kind`, its
  address or path, and `active`. `rss` and `email` sources are incoming
  (what a feed reads); `file` and `folder` sources are context (what a
  feed judges against).

A context source's file or folder may be read to judge whether it fits.
Read nothing else.

## Pick

From the active sources not already on the feed, pick the ones the
instructions would want: incoming sources that carry what the feed is
for, and context sources that tell it what matters. At most eight. None
is a fine answer when nothing fits.

For each, one sentence in plain language on why it fits this feed, under
300 characters.

## Write

One new file, `feeds/<id>/suggestions.json`, written once:

```json
{ "version": 1, "at": "<now, ISO 8601>",
  "sources": [{ "id": "<source id>", "why": "One sentence." }] }
```

`sources` may be empty. No other key, no id twice. Never edit or create
any other file: the feed, its note, and the sources are the dashboard's.

## Reply

One line: how many sources were suggested, or why none were.
