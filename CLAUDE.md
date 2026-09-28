# personal-assistant

Umbrella project for Hunter's personal assistant surfaces. The dashboard in
`dashboard/app/` is the assistant daemon and the tailnet-only hub it serves.
A rail of four icons: Home is the Agents view (domain personas on the
Claude Agent SDK, Codex threads on a shared app-server, Claude Code
terminals in cmux, and each agent's routines), Reading holds the Daily
Brief, Focus is its own view, and Goals reads the vault's priorities with
add and edit going through the second-brain persona. It follows
`thoughts/shared/plans/2026-09-25-dashboard-assistant-daemon-implementation.md`
(Phases 1 to 4 shipped 2026-09-28). The September
18 Electron Control Tower plan is superseded; its runtime evidence was
reused. Start with the dashboard lane handoff.

The first use case is the Daily Brief, where domain systems each contribute what
became relevant and a curator ranks across domains and writes one short brief.

**The umbrella itself is undefined.** What the assistant is, how it is invoked,
which use cases it hosts, whether there is a shared runtime, and what the
always-on screen amounts to are all open and have not been worked through. The
daily brief was started first because it is concrete. Its choices are local to
it and should not be treated as the project's architecture until someone checks
whether they generalize.

`README.md` describes the project. Start there, then the lane handoff.

## Orientation

Read in this order when picking up work:

1. `thoughts/shared/lanes/daily-brief/handoff.md` — the brief: current state,
   decisions, what's next. **Aligned 2026-09-24**: Hunter answered the five
   brief-vs-Focus questions; the decisions are in §8 of
   `thoughts/shared/research/2026-09-24-brief-vs-focus.md`. The contract,
   schema, builder, and voice were rewritten against them on 09-25 and the
   first memo-format brief is live; the plan is
   `thoughts/shared/plans/2026-09-24-daily-brief-memo-format.md`.
   `thoughts/shared/lanes/architecture/handoff.md` — the project itself: what
   the assistant is (undefined), domain registry and tool-policy follow-ups.
   `thoughts/shared/lanes/dashboard/handoff.md` — dashboard state, decisions,
   and what is next. The daemon plan above records each phase's spike
   results; the 2026-09-28 research notes (`2026-09-28-codex-app-server-spike.md`,
   `2026-09-28-cmux-spike.md`, `2026-09-28-phase3-live-checks.md`) hold the
   verified Codex and cmux behaviour the runtime code relies on. The v1 hub
   design and plan (2026-09-20 and 2026-09-22) and the September 18 Control
   Tower plan are history.
2. `thoughts/shared/research/2026-09-10-daily-brief-landscape.md` — briefing
   craft, evaluation, compilation architecture, precedent, and the ten
   corrections that shaped the current design. **Read before changing the
   contract**; most obvious "improvements" were already considered and rejected
   there with reasons.
3. `daily-brief/contribution-contract.md` — the instruction each domain reads;
   `daily-brief/contribution-schema.md` — the YAML shape it produces and why;
   `daily-brief/curator.md` — the memo's sections and the curator's rules;
   `daily-brief/voice.md` — how the memo sounds. Every memo is written
   against it and audited with `writing` before it is built.

## Structure

One directory per use case; a later weekly review or decision prep sits beside
`daily-brief/` with its own contract and inputs.

- `dashboard/app/` — the dashboard daemon (Node 24; two runtime
  dependencies, the Claude Agent SDK and `ws`, so run `npm ci` after
  pulling); its own Git repository, run by a user LaunchAgent on
  127.0.0.1:4243. Routes, snapshot shape, the `bin/codex-serve` and
  `bin/codex-new` helpers, cmux setup, tests, and operations live in its
  README and `docs/operations.md`. Never run its tests against ports 4242,
  4243, the real `daily-brief/briefs/`, the real cmux socket, or Hunter's
  `~/.codex`; the suites use fixtures, scripted servers, and an isolated
  Focus copy. Its `var/` (persona threads, Codex owner and bindings, logs)
  is local state, gitignored.
- `registry/agents.json` — the agent registry the dashboard reads: personas
  and project folders with role, description, group, cwd, provider, and the
  launchd labels each owns. Umbrella config, unversioned, absolute paths;
  the daemon keeps the last good copy when an edit is bad.
- `dashboard/prototype/` — standalone static design study with illustrative data;
  its own Git repository and private Sites deployment. See its README for local preview.
- `daily-brief/contribution-contract.md`, `contribution-schema.md`,
  `run-prompts.md`, `curator.md`, `voice.md`, `watch/relevance.md` — tracked
- `daily-brief/bin/run-brief` — the scheduled run (gather, curate, build,
  verify), `bin/prompts/` the prompts it renders, `launchd/` its LaunchAgent
  (06:05 daily). `daily-brief/README.md` has the schedule and the hand-run
  flags.
- `daily-brief/contributions/YYYY-MM-DD/<domain>.yaml` — gitignored
- `daily-brief/briefs/` — gitignored; the curator writes `memo-<date>.md`,
  `build.py <date>` generates `<date>.md` and `viewer-<date>.html`, which
  the dashboard serves, and `check-viewer.mjs <date>` proves the viewer
  parses; `bin/run-brief` does all of this on a schedule since 2026-09-27.
  The per-date `build-<date>.py` scripts are history. The old
  `serve.py` on 8765 is retired; do not start it.
- `thoughts/` — synced, never committed (repo convention)

## Cautions

- **Contributions and briefs carry exact financial figures and personal
  context.** They are gitignored and stay local. Never commit them, never
  publish them as an artifact, never send them anywhere.
- **This project does not mutate domain systems.** Contributors are read-only
  toward their own repos; the curator is read-only toward all of them. The only
  Daily Brief writes are contribution files, briefs, and the feedback file
  the dashboard saves beside a brief. The dashboard forwards Hunter's own
  Focus actions to Focus unchanged and holds no task state. The Goals
  view reads the vault through the second-brain persona's cwd and never
  writes it; Add and Edit only send that persona a message. Personas act
  only under Hunter's inline approvals; the dashboard never sends a Codex
  turn, answers one request with one decision (never a session-wide
  grant), and never binds a terminal by guessing from a folder. Persona
  turns bill the Claude subscription; an API key in the daemon's or the
  installer's environment disables personas. Dashboard prototype
  interactions change only the mockup’s in-memory state.
- **Raw external content never reaches the curator.** Email and web material is
  summarized into a claim by the contributing domain and marked as external in
  origin.
- **There is one Daily Brief run, owned by this project.** Domain schedules keep
  their own state current; they do not produce scheduled sub-briefs. The
  coordinator requests grounded packets, applies a deadline, and publishes a
  degraded brief when a provider is stale or unavailable.
- **Nothing invented reaches the dashboard.** It serves the newest viewer in
  `daily-brief/briefs/` as the real brief; sample or placeholder content
  goes in the scratchpad, never there. Hunter read an invented sample as
  real on 2026-09-25.
- **Dashboard copy:** Hunter accepted the initial layout direction but rejected
  interface metacommentary. Use `/writing`; delete decorative filler and keep
  design rationale out of user-facing screens. The dashboard handoff has examples.
- **`run-brief` is idempotent by date.** It exits if a viewer for the date
  exists; `--force` rebuilds and skips the freshness wait. Never run it from
  a test against a real date; the timeout test in the plan uses a far date
  and deletes its output.
- **The umbrella is not a Git repo.** `dashboard/app/` and
  `dashboard/prototype/` each have their own repository.

## Boundaries with other projects

The brief describes why something matters; **Focus owns persistent task state**.
The brief may say Hunter owes someone a decision today, but it never becomes the
store of record for tasks. Contributors live in their own repos
(`~/workspace/work/investing/cfo`, `~/workspace/projects/AI/focus`,
`~/workspace/second-brain`) and the work section is read from the existing
`catchup` brief in `~/workspace/work/nowgentic/.claude/catchup/`.
