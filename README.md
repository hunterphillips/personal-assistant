# personal-assistant

Umbrella project for Hunter's personal assistant surfaces. First use case is the
**Daily Brief**: domain systems each contribute what became relevant, a curator
ranks across domains and writes one short brief.

The dashboard is the assistant daemon and the tailnet-only hub it serves.
A rail of four icons: Home is the Agents view (domain personas Hunter
messages and answers inline, his coding sessions as Codex threads on a
shared server and Claude Code terminals in cmux, and each agent's
routines), Reading holds the Daily Brief, Focus is its own view, and Goals
reads the vault's priorities and goal notes with add and edit going through
the second-brain persona. The direction took Meta Muse and GrokBot as reference; a
clickable design study lives in `dashboard/prototype/` as visual reference.
Current state and decisions live in `thoughts/shared/lanes/dashboard/handoff.md`.

Deliberately thin. This holds the contract, the assembler, and the outputs. It
does not hold shared libraries, and the domain systems keep their own repos.

**The umbrella is undefined.** What the assistant is, how it is invoked, which
use cases it hosts and in what order, and whether there is a shared runtime are
all open. The daily brief is the first concrete piece, not a template for the
rest.

## Surfaces and their boundaries

Working sketch, not a settled design. The brief/Focus boundary is the only part
that has been argued through.

| Surface | Answers | Owns |
| --- | --- | --- |
| Daily Brief | What changed, what matters today, what might surprise me | Nothing persistent; read once |
| Focus | Given that, what am I doing now | Canonical persistent task state |
| Personal assistant | The conversation between surfaces, plus later jobs (weekly review, decision prep, financial check-ins) | The screen and the curator |

The brief may say Hunter owes someone a decision today. It must not become the
store of record for tasks; that is Focus. The boundary is ownership, not
vocabulary.

## Contributors

| Domain | Repo | Contributes |
| --- | --- | --- |
| cfo | `~/workspace/work/investing/cfo` | Money: drift vs IPS, pending decisions, thresholds, time-boxed windows |
| focus | `~/workspace/projects/AI/focus` | The attention board: what became relevant, what aged, what was dismissed |
| second-brain | `~/workspace/second-brain` | Personal context: priorities, open commitments, contradictions, staleness |
| nowgentic (work) | `~/workspace/work/nowgentic` | Condensed work section, read from the existing `catchup` brief |

Contributors hand over ranked items, not finished prose. A domain that ranks and
truncates for its own reader hides items that would have won across domains.

Work is the exception, in the opposite direction. Its own brief already reaches
Hunter's work Slack, so repeating individual items here duplicates something he
has read. **Work gets one to three sentences, or nothing** — a condensed picture
or the single item that matters today. A work item only earns its own line when
it spills into his personal life for a specific reason.

## Layout

One directory per use case. The daily brief is the first; a weekly review or
decision prep would sit beside it with its own contract and its own inputs.

- `daily-brief/contribution-contract.md` — what a contribution is and what each item carries
- `daily-brief/contribution-schema.md` — the YAML shape, derived from the first three runs
- `daily-brief/run-prompts.md` — the one-line prompt pasted into each domain repo
- `daily-brief/curator.md` — the curator's seven content rules; headings and shape are the model's
- `daily-brief/watch/` — the newsletter domain: `contribute` runs Mondays, `relevance.md` holds its sources and survival criteria
- `daily-brief/bin/run-brief` — the scheduled morning run; `daily-brief/README.md` has the schedule and flags
- `daily-brief/contributions/YYYY-MM-DD/<domain>.yaml` — a day's raw contributions
- `daily-brief/briefs/` — `memo-<date>.md` written by the curator, `build.py` that turns it into `<date>.md` and the `viewer-<date>.html` the dashboard serves, and the feedback files saved beside them

## Handling

Contribution and brief files carry exact financial figures and personal context.
They are gitignored and stay local. If persistent contributions are ever kept
long-term, revisit whether they should carry only material conditions and
rounded deltas, with exact figures staying in cfo.

## Status

The dashboard in `dashboard/app/` is installed as a
user LaunchAgent and is what the tailnet URL serves since 2026-09-23. Phases
1 to 3 of the
[daemon plan](thoughts/shared/plans/2026-09-25-dashboard-assistant-daemon-implementation.md)
shipped by 2026-09-28: the agent registry and routines, persona threads on
the Claude Agent SDK, the Agents home screen, Codex threads on a shared
app-server started with `bin/codex-serve` and bound to cmux terminals with
`bin/codex-new`, and cmux inventory with "Open terminal". Phase 4 shipped
the same day: the icon rail and the Goals view, a read-only view over the
vault's priority notes whose add and edit send the second-brain persona a
message. Focus keeps its
own interface and state, embedded through an internal proxy; the dashboard
serves the Daily Brief and saves its feedback directly; the port 8765 viewer
is retired. Operations, cmux setup, and the remaining live checks are in
`dashboard/app/docs/operations.md` and the
[dashboard handoff](thoughts/shared/lanes/dashboard/handoff.md).

The September 18 Control Tower research (Codex, Claude, and cmux runtime
evidence) fed the daemon plan; its Electron/TypeScript
[plan](thoughts/shared/plans/2026-09-18-dashboard-control-tower-implementation.md)
is superseded.

The Daily Brief ran by hand from 2026-09-10 and has run itself every
morning since 2026-09-27: `daily-brief/bin/run-brief` gathers one packet per
domain, curates, builds, and publishes to the dashboard by about 06:45, after
the catchup, cfo, and Focus jobs it depends on. On 2026-09-24 the briefs were
found to overlap the Focus board, and Hunter decided the split: Focus is
actions, the brief is orientation and never restates the board (§8 of
`thoughts/shared/research/2026-09-24-brief-vs-focus.md`). A `watch` domain
distills five newsletters weekly. On 2026-09-29 Hunter preferred a one-shot
prompt's brief to the rule-stacked memo, so the voice file and fixed labels
were retired; the curator now writes from a ten-line prompt and seven content
rules on Sonnet 5.5.
State and open threads live in `thoughts/shared/lanes/daily-brief/handoff.md`.
