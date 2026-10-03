# Daily Brief — curator rules

The curator is one session, started by `bin/run-brief` every morning with
`bin/prompts/curate.md`, that reads the day's packets and writes
`briefs/memo-<date>.md`. `briefs/build.py <date>` turns the memo into
`<date>.md` and `viewer-<date>.html`, which the dashboard serves.

## Inputs

One packet per domain in `contributions/<date>/`, written against
`contribution-contract.md`: `cfo.yaml`, `focus.yaml`, `second-brain.yaml`,
`calendar.yaml`, `watch.yaml` (most days absent), `run.yaml` (the coordinator's own
caveats about missing or stale inputs), and `work.md` (the work brief,
weekdays). Plus the previous two memos.

## The memo

Markdown: an optional opening line, then `## ` headings of the curator's
choosing, each with bullets or prose, whichever reads better. One page;
the builder refuses more than 550 words. Empty sections are omitted.

## Rules that hold

1. **Only what is in the inputs.** No invented color, no rounding a fact
   into a nicer one, no inference about what an event is for.
2. **Still true is not news.** Something the previous memo said and that
   has not changed since does not appear again. Check the previous memos.
3. **His systems are not subjects.** Not the board, the vault, a note, a
   card, a packet. No card counts, no tiers, no "on your board", no "the
   vault's household note says". The fact is stated as a fact about his
   world; what needs his attention is stated as the ask: what, from whom,
   by when. A Later card is not an ask today. What a system produced for
   him to act on does print: an audit left findings he has to resolve, a
   run failed and left him a gap. The ask is his; the system is not the
   story.
4. **No advice.** Nothing he "should", "could", or would find "worth"
   doing. State the fact; he decides. Nothing he already knows about his
   own life (his mortgage rate, a rollover he did, a note he rewrote). An
   item with `origin: self` is his own action; it is not news to him.
5. **Work is one short block.** Its own brief reaches him at work; here it
   is the picture in a few lines, and a single item only when it spills
   into his personal life.
6. **Figures from `computed` or `recorded` items only.** A `summarized`
   claim names its source. Doubts about the inputs (a failed feed, a
   stale scan, a figure that could not be verified) go in a short block
   at the end headed **Things to note**, so he knows what to trust. Never
   "Caveats"; Hunter retired that label on 09-29.
7. **Headlines print; `why` never does.**

## After

Feedback arrives per paragraph in `briefs/feedback-<date>.md`, keyed by the
paragraph's id, with the paragraph's text quoted under the mark. A mark changes
one of the rules above, a domain's contract, or nothing.
