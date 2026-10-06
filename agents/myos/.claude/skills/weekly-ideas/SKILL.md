---
name: weekly-ideas
description: Produce the week's ideas for Hunter's attention. Invoke when the instruction is "Run the weekly-ideas skill" (the Weekly ideas routine on Myos, Mondays at 04:00).
---

# Weekly ideas

Paths below are under the data root, the folder `PERSONAL_ASSISTANT_HOME`
names, unless they say the repo; repo paths are from the repo root, two
folders up from Myos's folder.

## The week

The instruction may carry a week line, "Write this run's ideas for the
week of <Month D> (`week: "YYYY-MM-DD"` in the file).", followed by the
titles of that week's saved ideas. That is a refresh from the dashboard:
draw ideas for that week, write its `week` in the run file, and never
repeat a title the instruction lists as saved. With no week line, the
run is for this week and the file carries no `week`.

## Read

- `ideas/criteria.md`.
- `ideas/marks.json` and every id in every file in `ideas/items/`. Emit
  none of those ids. A dismissed idea is never rephrased under a new id.
- `systems/second-brain/notes/longterm-priorities.md` in the repo (the vault) and
  the goals it lists, as context for judging, not the test an idea
  must pass.
- `registry/agents.json` and `routines/`.
- `thoughts/shared/lanes/*/handoff.md` in the repo.
- The week's `feed/items/`.

## Judge

Weigh each candidate against `ideas/criteria.md`. An idea is about the
system: what it, one of its agents, or a new agent or tool could do.
Never an action for Hunter to take. `ideas/criteria.md` is Hunter's own
note; when it names a theme for the week, that takes precedence. Write
at most five in this run, whatever earlier runs this week wrote; a count
in `ideas/criteria.md` is a count per run. Draw across the seven kinds;
no kind needs an entry. Something already built, already running, or already in a plan is not
an idea.

## Write

`text` is one or two sentences under 200 characters that say what the idea
would do; the why belongs in Discuss.

One new file, `ideas/items/<today>-myos.json`, in the shape the repo's
`ideas/README.md` describes, with `"week": "YYYY-MM-DD"` beside `date`
when the instruction named a week. One item, for example:

```json
{ "id": "weekly-review-routine",
  "title": "A weekly review routine on the Assistant",
  "text": "What it would do, and why now, in one paragraph.",
  "kind": "workflow", "agents": ["assistant", "focus"], "source": null }
```

`id` is a slug of the title, unique across the store. Never edit an old
file. A run on a day whose week already has a file writes a new file for
today. When `ideas/items/<today>-myos.json` already exists, this run
writes `ideas/items/<today>-myos-2.json`, then `-3`, and so on; the
run's `producer` stays `myos`.

## Do not

No `notify`. No `ask`. No message to any other thread. No edit to
anything but the one file above.

## Reply

Exactly one sentence, with no idea content, naming the week written
for: "Wrote N ideas for the week of <Month D>."
