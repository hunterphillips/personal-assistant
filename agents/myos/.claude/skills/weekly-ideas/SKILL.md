---
name: weekly-ideas
description: Produce the week's ideas for Hunter's attention. Invoke when the instruction is "Run the weekly-ideas skill" (the Weekly ideas routine on Myos, Mondays at 04:00).
---

# Weekly ideas

Paths below are from the repo root, two folders up from this folder.

## Read

- `ideas/criteria.md`.
- `ideas/marks.json` and every id in every file in `ideas/items/`. Emit
  none of those ids. A dismissed idea is never rephrased under a new id.
- `systems/second-brain/notes/longterm-priorities.md` (the vault) and
  the goals it lists, as context for judging, not the test an idea
  must pass.
- `registry/agents.json`.
- `thoughts/shared/lanes/*/handoff.md`.
- This week's `feed/items/`.

## Judge

Weigh each candidate against `ideas/criteria.md`. An idea is about the
system: what it, one of its agents, or a new agent or tool could do.
Never an action for Hunter to take. `ideas/criteria.md` is Hunter's own
note; when it names a theme for the week, that takes precedence. Write
at most five in this run, whatever earlier runs this week wrote. Draw across the seven kinds; no kind needs an entry.
Something already built, already running, or already in a plan is not
an idea.

## Write

`text` is one or two sentences under 200 characters that say what the idea
would do; the why belongs in Discuss.

One new file, `ideas/items/<today>-myos.json`, in the shape
`ideas/README.md` describes. One item, for example:

```json
{ "id": "weekly-review-routine",
  "title": "A weekly review routine on the Assistant",
  "text": "What it would do, and why now, in one paragraph.",
  "kind": "workflow", "agents": ["assistant", "focus"], "source": null }
```

`id` is a slug of the title. Never edit an old file. A run on a day
whose week already has a file writes a new file for today. If
`ideas/items/<today>-myos.json` already exists, write nothing and say so
in the reply.

## Do not

No `notify`. No `ask`. No message to any other thread. No edit to
anything but the one file above.

## Reply

Exactly one sentence, with no idea content: "Wrote N ideas for the week
of <Month D>."
