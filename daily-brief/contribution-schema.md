# Daily Brief — contribution schema

Derived 2026-09-13 from the three contribution runs of 2026-09-10 through
2026-09-12 and Hunter's marks on the briefs curated from them. Revised
2026-09-24 when the brief was realigned as a memo: `kind` became the section
an item lands in, and `needs_hunter`, `event`, and `decision` were retired.
The decisions behind the revision are in §8 of
`thoughts/shared/research/2026-09-24-brief-vs-focus.md`. This is the shape the
assembler parses.

## Format

One YAML file per domain per day:

```
~/.personal-assistant/briefs/contributions/YYYY-MM-DD/<domain>.yaml
```

YAML because the assembler is code. Domains are agents writing files, so
structure costs them nothing, and the human-readable rendering is the brief
itself.

## Packet

```yaml
domain: cfo                      # cfo | focus | second-brain | watch
generated_at: 2026-09-25T07:27:46-05:00
data_as_of: 2026-09-25T07:00:55-05:00   # a timestamp, not a paragraph
since: 2026-09-23                # the cursor: date of the last brief Hunter read
status: ok                       # ok | degraded | stale | failed
notes: "No allowed range was crossed."   # optional, one line
items: [...]
standing: [...]
gaps: [...]
```

`data_as_of` is the primary source's freshness and must be a single timestamp.
Twice cfo wrote a paragraph here to explain a split freshness; that detail
belongs in `gaps`, and the header carries the older of the two times.

`since` is new. It echoes the cursor the run prompt supplied, so a packet
says which window it covers. The 09-10 research asked for a last-consumed
cursor because "since yesterday" is wrong whenever Hunter skips a day, reads
late, or regenerates.

## Items

Ordered. Position is the domain's ranking. Ceiling of eight; the runs settled
at three to seven.

```yaml
- id: cfo/review/2026-09-30-quarterly-rebalance
  kind: upcoming                 # change | needs-you | upcoming | context | caveat
  headline: >
    The quarterly rebalance review the investment policy schedules for
    September 30 is five days out; the crypto sleeve has been under its 75%
    floor since the 12th and will come up then.
  why: >
    The one scheduled point at which a standing deviation gets addressed.
  horizon: 2026-09-30            # required for upcoming
  opened: 2026-09-19             # required for needs-you
  as_of: 2026-09-25T07:00:55-05:00
  about: cfo/reviews/2026-09-30  # optional
  origin: internal               # self | internal | external
  basis: recorded                # computed | recorded | summarized
  receipt:
    - "IPS §3.4"
    - reviews/2026-09-30.md
```

### Field by field

**id** — a stable key the domain will reuse for the same item tomorrow.
Without it the assembler cannot know an item was reported before, and
still-true-is-not-news cannot be enforced in code. cfo's decision filenames,
focus's `external_id`, and vault note paths all already serve.

**kind** — the memo section the item lands in. Five values:

| kind | Section | Carries |
|---|---|---|
| `change` | What changed | |
| `needs-you` | Needs you | `opened` |
| `upcoming` | Coming up | `horizon` |
| `context` | Watch | |
| `caveat` | Caveats | |

The Today section has no kind; the curator reads the calendar directly.
Routing by `kind` means the domain says where an item belongs and the
assembler only orders within sections. Under the old shape the curator
reclassified at least one item by hand in every run.

**headline** — the sentence Hunter reads. Self-contained, names who, what, the
ask, and the date; never phrased as a change from yesterday. May run to two or
three sentences when the fact needs them. The brief prints this and nothing
else.

**why** — ranking input for the assembler, never printed. Every consequence
sentence Hunter flagged as slop was this field passed through.

**horizon** — the date an item is tied to. Required for `upcoming`, where it
orders Coming up; optional elsewhere.

**opened** — required for `needs-you`. Age is `today - opened`. Hunter's rule
from the 13th still holds: a question open one day and one open ten days are
different items, and the curator says how long it has waited.

**as_of** — a single timestamp. Prose about freshness goes in `gaps`.

**about** — optional. A shared key when the item refers to a record that
another domain might also refer to. Every run had cross-domain duplicates:
the Berryman meeting twice, the cash decision three times. When two items
carry the same `about`, dedupe is deterministic; when they do not, the
synthesis step still has to judge.

**origin, basis** — required. The assembler enforces that a figure may be
restated only when `basis` is `computed` or `recorded`; `summarized` claims
are attributed to their source. Every watch item is `external` and
`summarized` by construction.

**receipt** — always a list.

### Retired

**needs_hunter** — retired 2026-09-24. It answered "is the ball in his
court," which is Focus's question. Under the memo the section says what an
item needs: `needs-you` is the only kind that asks anything of him, and the
brief caps that section at three lines.

**event** and **decision** — retired 2026-09-24 as kinds. `event` split into
`change` (it happened) and `upcoming` (it is dated ahead). `decision` was task
state, which Focus owns; a question that is not on the board and needs him is
`needs-you`, and one that is on the board is not a brief item at all.

## Standing context

Separate from items. Rules for the assembler, never printed. second-brain
invented the heading on its own in the second run and the curator used every
entry; before that the same content arrived as items and had to be sorted out
by hand.

```yaml
standing:
  - id: rule/prism-parked
    rule: >
      prism is parked on purpose and has been finished since 2026-08-17.
      Silence there is a decision, not drift.
    since: 2026-09-10
    receipt: notes/current-priorities.md
```

Any domain may supply these; in practice second-brain supplies most.

## Coverage gaps

Structured, not prose. The assembler renders degraded state and Caveats from
them.

```yaml
gaps:
  - what: >
      The bank and Coinbase feeds failed this morning; nine of sixteen
      accounts carry yesterday's balances and the report shows them as
      current.
    since: 2026-09-24          # a date, or the word standing
```

## Calendar

Not a packet. The assembler reads Hunter's personal Google calendars
directly: today's events for the Today section, the next seven days for
Coming up. Until the assembler exists the curator session does the same
through its calendar connector.

## What the assembler derives, so domains do not

Section assembly from `kind`; the age of a `needs-you` item from `opened`;
the three-line cap on Needs you and the pointer at the board; dedupe across
`about` keys; whether an `id` was already reported and how long ago; the
Caveats section from `gaps` and `caveat` items; omission of a section with
nothing in it; the degraded line from `status`; the word count. Domains
report; the run decides.

## Open

- The `about` key vocabulary. Path-like strings rooted at the owning domain
  (`cfo/decisions/...`, `vault/notes/...`, `focus/items/<external_id>`) is the
  proposal; it needs one round of use. Watch items use
  `watch/<source>/<slug>`, where the slug names the story, so the fourteen-day
  dedupe has a key.
- Whether focus's one `needs-you` pointer item (count plus top card) needs
  `opened`. Proposal: no; it is a pointer, not a question. Settle after the
  first memo run.
