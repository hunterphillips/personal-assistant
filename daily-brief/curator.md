# Daily Brief — curator rules

What the curator does with the packets. The curator is a session in this
repo, started by `bin/run-brief` every morning with `bin/prompts/curate.md`,
or by hand; these rules are what it follows.

## Inputs

- One packet per domain in `contributions/<date>/`, written against
  `contribution-contract.md`. Validate each by reading it; a packet that
  breaks the schema is reported in the lane handoff, not silently fixed.
- The calendar: `contributions/<date>/calendar.yaml` in the scheduled run,
  one `upcoming` item per event; in a hand run, Hunter's personal Google
  calendars read directly: today, and the next seven days, every calendar
  except the holiday feed, dropping events he has declined.
- The day's work brief: `contributions/<date>/work.md`, copied by the run
  from `~/workspace/work/nowgentic/.claude/catchup/`; absent on weekends.
- `contributions/<date>/run.yaml`: the coordinator's caveats about inputs
  that were missing or stale when the run started. They go in Caveats.
- The cursor: the date of the last brief Hunter read. It goes into the run
  prompt and every packet echoes it.

## The memo

One file, `briefs/memo-<date>.md`, written through the `writing` skill.
`briefs/build.py <date>` turns it into `<date>.md` and `viewer-<date>.html`,
which the dashboard serves.

The first paragraph is one sentence with no heading: the day in a line. Then
these sections, in this order, each a `##` heading followed by prose:

| Section | Contents |
|---|---|
| Today | The calendar read as a whole: appointments, the evening thing, the open stretch. |
| What changed | Threads closed, cards done by the curator or resolved by others, cfo items settled, work merged. Things that resolved without him. |
| Needs you | At most three lines. Points at Focus ("three cards open in Focus, the first is the zoom-out pass") plus any real deadline the board does not carry. Never restates a card. In the memo the board is always "Focus". |
| Coming up | Dated things in the next seven days, from the calendar and from `upcoming` items. |
| Watch | The newsletter digest, from the watch packet. Most weeks absent. |
| Caveats | Where the brief's own inputs are unreliable today: a stale feed, a source that did not respond, a figure that could not be verified. |

A section with nothing in it is omitted, heading and all. A quiet day is the
opening sentence and two short paragraphs.

## Rules

- **500 words, hard.** No target below it. The builder refuses a longer memo.
- **Headlines print; `why` never does.** Every consequence sentence Hunter
  has flagged was a `why` field passed through.
- **Items stand alone.** Read cold, never as a diff from yesterday. Change
  decides whether something appears, not how the sentence reads.
- **The board is pointed at, not copied.** If a packet hands over a card's
  contents, drop it.
- **Work is one to three sentences**, inside What changed or Needs you. It is
  never its own section; individual work items do not appear unless one
  spills into his personal life for a specific reason.
- **Figures are restated only from `computed` or `recorded` items.** A
  `summarized` claim is attributed to its source.
- **Still true is not news.** An item reported in an earlier brief and
  unchanged since does not appear again. Until the assembler keeps a
  last-reported memory, the curator checks the previous memo by hand.
- **Standing context is read, never printed.**
- **A record catching up is not a change.** A domain settling a fact
  Hunter already knows (his mortgage rate, a rollover he did) does not
  appear. If the settlement moved a figure he acts on, the moved figure
  appears; the bookkeeping never does.
- **The memo is composed from the packets, not assembled from them.**
  Headlines are the facts, not the sentences. Relate items that share a
  cause or a date, and write calendar entries with Hunter as the subject.
  `voice.md` has the shapes to avoid.
- **Labels are the six above, exactly.** No others, and no label that
  describes its own role.

## Voice

`voice.md`, every time. The opening line names a fact, never a scene.
Nothing in the memo that is not in an input. Write, audit against the
`writing` skill's humanizer checklist, then read the opening line once more
cold before building.

## After

Tell Hunter the memo is up. Feedback arrives per section in
`briefs/feedback-<date>.md`; each mark either changes the curator's ranking
or goes back to a domain's contract, and the lane handoff records which.
