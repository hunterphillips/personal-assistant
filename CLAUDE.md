# personal-assistant

Hunter's personal AI assistant system, and since 2026-09-29 the one working
root for building it. The dashboard in `dashboard/app/` is the assistant
daemon and the screen it serves; the domain systems it delegates to are
separate repos linked under `systems/`. Hunter's direction: build the system
and its interface until it is his daily driver, let use sharpen the
direction, and improve the subcomponents underneath. Work on any part of it
from here.

## The system

- **Interface**: `dashboard/app/`, a Node 24 daemon on 127.0.0.1:4243 behind
  Tailscale Serve. A rail of four views: Home is the Agents view (domain
  personas on the Claude Agent SDK, Codex threads on a shared app-server,
  Claude Code terminals in cmux, each agent's routines), Reading holds the
  Daily Brief and, since 2026-09-29, the Feed (what the producers found,
  with Discuss opening the watch persona), Focus is embedded through a
  proxy, Goals reads the vault's priorities with add and edit going through
  the second-brain persona. Next in line: an Ideas view. Its README and
  `docs/operations.md` hold routes, snapshot shape, helpers, and setup.
- **Registry**: `registry/agents.json`, the personas and project folders the
  daemon runs and lists: role, description, group, cwd, provider, launchd
  labels. Absolute paths; the daemon keeps the last good copy on a bad edit.
- **Use cases**: `daily-brief/`, running every morning since 2026-09-27
  (gather one packet per domain, curate, build, verify), with the newsletter
  `watch` domain on Mondays; `feed/`, the store behind the Feed, which
  watch writes and the dashboard reads. A later weekly review or decision
  prep sits beside them with its own contract.
- **Domain systems**, each its own repo with its own CLAUDE.md, launchd jobs,
  and state. Working under the link loads that repo's instructions, and git
  commands run there act on that repo.
  - `systems/cfo` (`~/workspace/work/investing/cfo`): money. Drift against
    the investment policy, pending decisions, the daily snapshot.
  - `systems/focus` (`~/workspace/projects/AI/focus`): the attention board.
    Owns persistent task state; server on 4242.
  - `systems/second-brain` (`~/workspace/second-brain`): the vault. Its
    CLAUDE.md maps it. Its `notes/projects/*.md` frontmatter is also the
    project registry that routes `/brain` captures to repos.
  - `systems/personal-context` (`~/workspace/personal-context`): who Hunter
    is. Read it through the `ask-profile` skill.
  - Work: `~/workspace/work/nowgentic`, whose `catchup` brief the Daily Brief
    reads. The harness (skills, output style, agents) is `~/workspace/Claude`.
- Access: Hunter's own sessions and agents reach any of his local context
  from here, cfo included. Access boundaries apply to external callers, not
  to his own work.

## Orientation

1. `thoughts/shared/lanes/assistant/handoff.md`: the system and its
   interface. Current state, decisions, and what is next, including the
   Feed and Ideas views.
2. `thoughts/shared/lanes/daily-brief/handoff.md`: the brief. Scheduled since
   09-27 (`thoughts/shared/plans/2026-09-27-daily-brief-scheduled-run.md`),
   watch on Mondays (`2026-09-28-watch-domain.md`). On 2026-09-29 the writing
   rules collapsed to seven content rules after Hunter preferred a one-shot
   prompt's brief; do not add sentence-level prose rules back.
3. `thoughts/shared/research/2026-09-10-daily-brief-landscape.md`: read
   before changing the brief contract; most obvious improvements were
   considered and rejected there. `2026-09-20-scheduled-research-landscape.md`
   is the same for anything that watches sources on a schedule (the Feed).
4. `daily-brief/contribution-contract.md`, `contribution-schema.md`,
   `curator.md`: what a domain hands over and the curator's rules.

`thoughts/` is synced, never committed. Lanes are handoffs; each session
picks one up and ends by updating it.

## Structure

- `dashboard/app/`: the daemon. Two runtime dependencies (the Claude Agent
  SDK and `ws`); run `npm ci` after pulling. `var/` is local state.
- `dashboard/prototype/`: a static design study with illustrative data; its
  own repository, ignored here.
- `registry/agents.json`: the agent registry.
- `daily-brief/`: contract, schema, curator rules, `bin/run-brief` and its
  prompts, `launchd/`, `watch/`. `contributions/` and `briefs/` are outputs,
  gitignored; `build.py` and `check-viewer.mjs` beside the briefs are code.
- `feed/`: the feed store's README; `items/` is its output, gitignored.
- `systems/`: symlinks to the domain repos.
- `thoughts/shared/`: lanes, plans, research, tickets.

## Development

- Dashboard: `npm ci`, `npm run check`, `npm test`, `npm run test:browser`
  in `dashboard/app/`. The suites use fixtures, scripted servers, and an
  isolated Focus copy; never point them at ports 4242 or 4243, the real
  `daily-brief/briefs/`, the real cmux socket, or `~/.codex`. Build phases
  in a worktree beside the live checkout, then merge and reinstall back to
  back, since `public/` is served per request. Reinstall with
  `bin/dashboard-install` (see `docs/operations.md`).
- Brief: `daily-brief/bin/run-brief --dry-run`, `--force`, `--date <d>
  --stage <gather|curate|verify>`. Idempotent by date: it exits if a viewer
  exists. Never run it from a test against a real date.
- Domain repos: change them through `systems/<name>/` under that repo's own
  rules, and commit there.

## Cautions

- **Contributions and briefs carry exact financial figures and personal
  context.** Gitignored, local only. Never commit, publish, or send them.
- **Nothing invented reaches the dashboard.** It serves the newest viewer in
  `daily-brief/briefs/` as the real brief. Sample content goes in the
  scratchpad. Hunter read an invented sample as real on 2026-09-25.
- **Writes are narrow.** Contributors are read-only toward their repos and
  the curator toward all of them. The Daily Brief writes contribution files,
  briefs, and the feedback file saved beside a brief. The dashboard forwards
  Focus actions to Focus unchanged and holds no task state; Goals reads the
  vault and only messages the second-brain persona. Personas act under
  Hunter's inline approvals; the dashboard never sends a Codex turn and
  answers one request with one decision. Persona turns bill the Claude
  subscription; an API key in the daemon's environment disables personas.
- **Raw external content never reaches the curator.** A contributing domain
  summarizes it into a claim marked external.
- **One Daily Brief run, owned here.** Domains keep their own state current
  and produce no scheduled sub-briefs.
- **Dashboard copy** goes through `/writing`: plain nouns for labels,
  sentences for states, no interface metacommentary, no placeholders.
- Focus owns persistent task state. The brief may say Hunter owes someone a
  decision; it never becomes the store of record.
