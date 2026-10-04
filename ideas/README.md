# Ideas

The store behind Ideas holds suggestions worth Hunter's attention. Producers
write run files. The dashboard reads them and writes marks. Run files are
append-only.

## Files

`items/<date>-<producer>.json` is one producer run. The date is a calendar
date. The producer in the file name is an agent id, or `manual` for Hunter's
own ideas.

```json
{ "producer": "myos", "date": "2026-10-04", "generated_at": "2026-10-04T09:00:00-05:00",
  "items": [
    { "id": "weekly-review-routine",
      "title": "A weekly review routine on the Assistant",
      "text": "What it would do, and why now, in one paragraph.",
      "kind": "workflow", "agents": ["assistant", "focus"],
      "source": null } ] }
```

- `id` is a lowercase slug of at most 80 characters. It matches
  `^[a-z0-9][a-z0-9-]{0,79}$` and is unique across the store.
- `title` is required and non-empty.
- `text` is a string. Only a manual idea may leave it empty.
- `kind` is `workflow`, `view`, `app`, `tool`, `skill`, `plugin`, `task`, or
  null.
- `agents` is a list of registry ids.
- `source` is an `http` or `https` URL, or null.

`marks.json` records dashboard actions by id:

```json
{ "weekly-review-routine":
  { "status": "taken", "at": "2026-10-04T14:12:00.000Z", "agent": "assistant" } }
```

The status is `taken` or `dismissed`. A taken mark names the agent when one
accepted the idea. Only the dashboard writes this file.

## Producers

A run reads the vault's `notes/longterm-priorities.md`, the agent registry,
`thoughts/shared/lanes/*/handoff.md`, and that week's `feed/items/`. It also
reads `marks.json` and every existing idea id, then emits none of those ids.

A producer writes one new run file and never edits an old one. It never calls
`notify`. Its reply in its thread is exactly one sentence with no idea
content, for example: "Wrote 4 ideas for the week of October 5."

The dashboard returns the newest 30 runs. The reader and its limits are
in `dashboard/app/lib/ideas.mjs`.
