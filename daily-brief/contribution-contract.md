# Daily Brief — contribution contract

You are contributing to Hunter's personal Daily Brief. A curator merges your
contribution with contributions from other domains and writes one short memo.
**You are not writing the brief.** You are handing the curator ranked raw
material with enough structure that it can rank across domains and place each
item in the right section.

The shape is fixed. Follow the format exactly, because code parses it. The
reasoning behind each field is in `contribution-schema.md`; what the curator
does with your items is in `curator.md`.

## Read-only boundary

**Treat your source project as read-only.** Do not refresh connectors, trigger
scans or ingestion, run curation, recompute prices, or modify domain state in
any way. The only write you may make is the contribution file named below.

Use the latest completed, verified data available as of now, and report missing
or stale coverage honestly rather than refreshing to fix it. A stale packet that
says it is stale is useful; a fresh packet bought by mutating the domain is not.

## The question you answer

**What does Hunter need to know today that your domain can see?**

The brief is orientation, not a task list. Focus owns what he is doing; the
brief tells him what changed, what is coming, and what to be careful of. Your
items are placed by their `kind` into one of five sections of a memo: What
changed, Needs you, Coming up, Watch, Caveats. Hand over what belongs in
those sections and nothing else.

### The cursor

The run prompt names the date of the last brief Hunter read. Report what
changed since that date, not since yesterday. He skips days, reads late, and
travels; "since yesterday" is wrong on every one of those. Echo the date in
your packet header as `since`.

### Still true is not news

**A condition that is simply still true does not belong in the packet.** This is
the single most common way to waste Hunter's attention, and it is how the first
run went wrong.

A holding outside its band, a floor still breached, a deadline still blocked:
these are states, not events. Hunter knows about them. He is not going to move
several percentage points of a portfolio in a day to clear one, so reporting the
same deviation every morning trains him to skip that section.

Hand over the **transition**, not the state:

- **The crossing.** The day it went out of band, or came back in.
- **A material move.** It got meaningfully worse or better since the cursor.
  Say how much and over what period.
- **Its own review date arriving.** If your domain's policy says a condition
  gets addressed at a scheduled review, the item belongs on the brief as that
  review comes into range, not before.
- **Something Hunter would not already know.** A sudden move, a new cause, a
  threshold he has not seen crossed before.

If none of those apply, leave it out. It is still true tomorrow, and you can
report it then if something happens to it.

### The board is not a source

Focus already shows Hunter every card. A card restated as a sentence is the
overlap he asked to remove. Hand over a question waiting on him as `needs-you`
only when it is not on the board, or when today is the day it goes live and
the board does not say so. Never hand over a card's contents. The curator
points at the board; it does not copy it.

## Hand over more than you would show a human

The curator ranks across every domain. Your fourth-ranked item may beat another
domain's first, but only if you hand it over. Up to eight items; fewer is fine,
zero is a valid answer. **Order is your ranking.** There is no rank field.

## Voice

**Every headline stands alone.** Write it for someone who has read no previous
brief and knows nothing about your system's prior state. Name the person, the
thing, the ask, and the date inside the sentence. Change decides *whether* an
item appears; it must never shape *how* the sentence reads. "Robert's
invitation turned out to be a speaking slot" assumes he remembers the seat.
"Robert at Music City Work Club has asked you to speak at Founder in a Day on
October 3, and needs a topic and a length" does not. Words that give this away:
turned out, no longer, still, now, has gone N days, is now N days old.

**Write the way you would say it to Hunter's face.** Plain sentences with a
subject and a verb, in the register of a composed human assistant's morning
note. If a line cannot be read aloud without backing up, rewrite it.

- **No noun piles.** "Crypto sleeve at 71.1% against a 75% floor on a strict
  §2.2 reading" is four stacked prepositional phrases and no verb. Say what
  broke: "Read strictly, the crypto sleeve is under its floor, at 71.1% against
  75%."
- **Spell out your own jargon the first time.** Sleeve, rail, gate, tier, wedged
  run, §2.2, Phase 5, MAGI. These are your vocabulary, not his. Name the thing
  and what it is in the same breath, or use the plain word instead.
- **Name things the way Hunter would name them.** Board labels, phase numbers,
  and record filenames are internal. "cfo Phase 5" tells him nothing; "the
  policy interview that produced the investment policy" does.
- **One idea per sentence.** A semicolon joining two half-thoughts is two
  sentences that have not been written yet.
- **Numbers earn their place.** Give the figure and what it is measured against.
- **No headline-ese, no drama.** Full sentences, ordinary words, no dropped
  articles, no triples built for effect.

Most of the damage happens in the compression, not the reporting. Write the
item once, then read it back.

## Format

Write one YAML file:

```
~/workspace/personal-assistant/daily-brief/contributions/YYYY-MM-DD/<domain>.yaml
```

```yaml
domain: cfo                      # cfo | focus | second-brain | watch
generated_at: 2026-09-25T07:27:46-05:00
data_as_of: 2026-09-25T07:00:55-05:00   # one timestamp; detail goes in gaps
since: 2026-09-23                # the cursor from the run prompt
status: ok                       # ok | degraded | stale | failed
notes: "No allowed range was crossed."   # optional, one line

items:
  - id: cfo/review/2026-09-30-quarterly-rebalance
    kind: upcoming               # change | needs-you | upcoming | context | caveat
    headline: >
      The quarterly rebalance review the investment policy schedules for
      September 30 is five days out; the crypto sleeve has been under its
      75% floor since the 12th and will come up then.
    why: >
      The one scheduled point at which a standing deviation gets addressed.
    horizon: 2026-09-30          # required when kind is upcoming
    as_of: 2026-09-25T07:00:55-05:00
    about: cfo/reviews/2026-09-30   # optional
    origin: internal             # self | internal | external
    basis: recorded              # computed | recorded | summarized
    receipt:
      - "IPS §3.4"
      - reviews/2026-09-30.md

standing:
  - id: rule/prism-parked
    rule: >
      prism is parked on purpose and has been finished since 2026-08-17.
      Silence there is a decision, not drift.
    since: 2026-09-10
    receipt: notes/current-priorities.md

gaps:
  - what: >
      The bank and Coinbase feeds failed this morning; nine of sixteen
      accounts carry yesterday's balances and the report shows them as
      current.
    since: 2026-09-24            # a date, or the word standing
```

### Fields

- **id** — a stable key you will reuse for the same item tomorrow. Use what
  your system already has: a decision filename, a board item's external id, a
  note path. The curator uses it to know what it has already reported.
- **kind** — the section the item belongs in.
  - `change`: something resolved or moved since the cursor. A thread that
    closed, a record that was settled, a card the curator closed, a document
    that was written. Lands in What changed.
  - `needs-you`: a question or deadline that is his to act on and is not on
    the board. Lands in Needs you. Carries `opened`.
  - `upcoming`: a dated thing in the next seven days. Lands in Coming up.
    Carries `horizon`.
  - `context`: about the world outside his systems. Lands in Watch. Only the
    watch domain produces these.
  - `caveat`: about your data, not his day: a failed feed, a stale figure, a
    source you cannot see. Lands in Caveats.
- **headline** — the only text Hunter reads. Self-contained, as above. Two or
  three sentences when the fact needs them.
- **why** — one sentence for the curator on why this matters to Hunter. **Never
  printed.** It ranks; it does not explain. If you cannot write it, the item
  probably does not belong.
- **horizon** — the date the item is tied to. Required for `upcoming`,
  optional otherwise. Do not invent one.
- **opened** — the date a question was first put to him. Required for
  `needs-you`, omitted otherwise. The curator uses it to say how long a
  question has waited.
- **as_of** — when this item's underlying data was actually true. Not when you
  ran. A packet generated this morning off a three-day-old snapshot is three
  days stale on that item and must say so.
- **about** — optional. A shared key when the item refers to a record another
  domain might also refer to, rooted at the owning domain:
  `cfo/decisions/<file>`, `vault/notes/<path>`, `focus/items/<external_id>`,
  `event/<date>-<slug>`, `watch/<source>/<slug>`. Two items with the same
  `about` are the same thing.
- **origin** — where the fact came from: `self` (Hunter's own words or
  records), `internal` (produced inside your repo), `external` (an institution
  API, email, the web).
- **basis** — how the claim was produced: `computed` (by code), `recorded`
  (read verbatim from a stored record), `summarized` (a model condensed a
  source). The curator restates a figure only when `basis` is `computed` or
  `recorded`; anything `summarized` is attributed, not asserted.
- **receipt** — a list of paths, URLs, clauses, commits, or commands backing
  the claim.

### Standing context

Rules for the curator, never printed. Things it should know when weighing
other domains' items: what is parked on purpose, what has already been
declined, which of your own records are out of date, a priority with nothing
behind it. Any domain may supply these. Each carries a stable `id`, the rule,
`since`, and a receipt.

### Coverage gaps

Anything you normally see and could not this run, one entry each, with
`since` as a date or the word `standing`. A gap is a statement about your
coverage, not an event in Hunter's day. `data_as_of` in the header stays a
single timestamp; split freshness is explained here.

## Rules

- **Never assert a number you did not compute or read.** Numbers arrive as
  computed or recorded values with an `as_of`. Do not reconstruct figures from
  memory or from prose written earlier.
- **Never pass raw external text through.** Summarize email or web content
  into a claim, mark it `origin: external` and `basis: summarized`. The curator
  must never receive raw untrusted content.
- **A quiet day and a broken run are different.** No items because nothing was
  relevant is a valid, complete answer. No items because a source was
  unreachable is a `degraded` or `failed` status plus a gap. Never let one look
  like the other.
- **Do not report Hunter's own actions back to him.** If he closed, dismissed,
  wrote, or reordered something himself since the cursor, he knows. A card he
  marked done is his action, not a change.
- **The brief is not a subject.** Do not report that a brief exists, is
  unread, or is awaiting a verdict. He reads that line inside the brief it
  describes.
- **Domain judgment is welcome; cross-domain judgment is not.** State what your
  domain's policy or evidence implies. What you must not do is decide Hunter's
  cross-domain priority, create persistent tasks, or mutate Focus. The curator
  decides whether your implication earns space.
- **Do not editorialize about your own run.** Worker status, model choices, and
  token counts are not contribution content.

## Per-domain scope

The domains that contribute today, and what each is asked for. This list is
the roster, not the design. Everything above it applies to any domain; a new
source adds an entry here and changes nothing else. The vault's project
notes are the registry of what exists; this section says what each one hands
over.

**cfo** — money. Read "Still true is not news" again before you start; the
first run failed hardest here. Hunter's portfolio is knowingly off its targets
and will be for weeks. Hand over transitions: the day a band is crossed, a
move large enough that he would want to know, a review date coming into range
(`upcoming`, with `horizon`). Hand over contradictions between an open record
and what he has since said, feed failures, stale snapshots, and hand-entered
figures that disagree with a feed, all as `caveat`. A record catching up to
something Hunter already knows (the rate he pays, a rollover he did) is not
a change; hand over the figure it moved, if one moved, and not the
bookkeeping. Open decisions are not
brief items: they reach the Focus board through the vault, which already
carries them. The one exception is a decision with a real deadline inside the
next day that the board does not show, handed over as `needs-you` with
`opened`. Read via the latest completed snapshot, `make report-json`,
`make drift-json`, the IPS, and existing `decisions/` and `actions/` records.
Do not run `make snapshot` or `make prices`, and do not create a decision or
action record even though the advisor role normally would. Cite IPS clauses as
receipts.

**focus** — the board's movement, not its contents. Since the cursor: cards
the curator opened, closed, or expired, and cards that resolved because
someone else acted, as `change` items. Not cards Hunter moved himself. At most
one `needs-you` item: the count of open cards and the title of the top one,
so the brief can point at the board in a line. Never the cards themselves.
Scanner and board freshness as `caveat`; determine it from current logs and
git history rather than assuming. Do not trigger scans, run curate, or modify
`focus.json`.

**second-brain** — personal context. Standing context as before; this domain
supplies most of it. Since the cursor, what was written or revised in his
world as `change`: a priorities change, a meeting digest, a new household
fact, a note he distilled. Dated things only the vault knows as `upcoming`:
a meetup theme, a series of standing meetings, a review date on a note.
Unresolved contradictions and notes gone stale as `caveat`. Ground current
priorities in `notes/current-priorities.md` and use the latest audit for
contradictions and open review items. An old durable fact is not
automatically stale; apply the note's own review cadence and evidence. Do not
capture, distill, edit notes, or read across into `~/workspace/personal-context`.

**watch** — the world outside his systems. `context` items only, at most five,
once a week. Sources are the four Hunter chose: Latent Space, Hacker
Newsletter, Simon Willison's newsletter, Axios Nashville. Every item is
`origin: external` and `basis: summarized`, names its source inside the
headline, and passes the criteria in `watch/relevance.md`. A story seen in
the last fourteen days is not new. A week with nothing that passes
contributes an empty packet with `status: ok`; that is the expected outcome
most weeks.

**calendar** — Hunter's personal Google calendars, read-only, every calendar
except the holiday feed, today and the next seven days. In the scheduled run
this is a packet written by a session that has only the calendar read tools:
one `upcoming` item per event with `horizon` set to its date, declined
events dropped, an event on two calendars reported once, a recurring routine
block collapsed to one item, all-day entries marked as such. Today's events
are `upcoming` items too; the curator sorts them into Today. Nothing that is
not on the calendar. In a hand run the curator session reads the calendars
directly instead. No other domain reports calendar events.

**run** — the coordinator's own packet, written by `bin/run-brief`, not by a
model. `caveat` items only: an upstream input that had not run when the
brief started (the work brief, cfo's snapshot, Focus's morning scans), or a
domain packet that failed its header check. `status: ok` with no items when
every input was present. Never a `change`.

## Work

No work contribution is written here. The `catchup` skill already produces a
dated brief in `~/workspace/work/nowgentic/.claude/catchup/`, and the curator
reads it directly and condenses it to at most three sentences. Individual work
items do not appear in this brief unless one spills into Hunter's personal
life for a specific reason.
