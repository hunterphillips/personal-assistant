# personal-assistant

Hunter's personal AI assistant system, and since 2026-09-29 the one working
root for building it. The dashboard in `dashboard/app/` is the assistant
daemon and the screen it serves; the agents it delegates to have their
own repos linked under `systems/`. Hunter's direction: build the system
and its interface until it is his daily driver, let use sharpen the
direction, and improve the subcomponents underneath. Work on any part of it
from here.

## The system

- **Interface**: `dashboard/app/`, a Node 24 daemon on 127.0.0.1:4243 behind
  Tailscale Serve, in Focus's theme since 2026-09-30. Every view sits under
  one header: the view's name and its actions on the left, and on the
  right Brief, Quick chat, a bell with the open notification count, and a
  menu with the theme (Light, Dark, or System) and Settings (one menu on a
  phone); the rail's chat icon carries a dot when an agent is waiting or
  has an unread reply, Health a mark when a job's last run failed; Quick
  chat opens any Claude agent's thread in a pane over any view, defaulting
  to Myos, and sends what Hunter is looking at as a context line. A rail
  of six views: Home is the Agents view (the Assistant pinned above the
  groups the registry lists, agents on the Claude Agent SDK, Codex
  threads on a shared app-server, Claude Code terminals in cmux; a gear
  opens each agent's settings beside its thread; on a desk the
  Assistant's thread opens by default, and each morning's brief lands in
  it as one collapsed line; messages render Markdown; a button under the
  composer picks the thread's model and effort; `@` mentions an agent;
  every Claude agent's turn carries two tools, `ask` (that messages
  another agent in its own thread, with the exchange shown in both and a
  card the receiver raises shown where the exchange started) and
  `notify` (that raises a notification in the header's list); each
  turn's prompt also names the agent, its registry name, role, and
  description; each agent runs at a permission level, Ask, Auto, or Full
  access, set in its gear panel; its routines, scheduled prompts the
  daemon runs itself as a turn in its thread at its level, are listed
  under its settings with a picker form and under the groups in the
  list; Myos is the built-in guide agent, seeded by the daemon, and any
  other agent can be deleted from its gear panel), Feed holds what the
  producers found (with images, and Discuss opening the Watch agent; its
  instructions send a change to Watch), the Daily Brief opens as an
  overlay from the header on any view (rendered from the run's brief
  JSON, with Approve, Dismiss, notes, and its own instructions), Focus is
  embedded through a proxy and takes the dashboard's theme, Goals reads
  the vault's priorities with add and edit going through the Second
  brain agent, Ideas lists what the weekly run on Myos suggests (at most
  five a week, from the criteria file), with Discuss opening quick chat,
  Start handing the idea to the pinned agent, Dismiss, and Add idea for
  his own; the ideas live in `ideas/items/`, the marks in
  `ideas/marks.json`, Health holds Settings (the default model, effort, and
  permission level, which agent receives the brief, which agent quick
  chat talks to) and lists the launchd jobs and their state. Every turn
  runs with the SDK's Claude Code preset system prompt. The design (the
  Assistant as the pinned agent, delegation, models, routines, and what
  comes next: Ideas) is
  `thoughts/shared/plans/2026-09-30-assistant-system-design.md`; the app
  header (quick chat, notifications, the brief as an overlay, the
  embedded assistant) is designed in
  `thoughts/shared/plans/2026-10-03-app-header-design.md` and built per
  `thoughts/shared/plans/2026-10-03-app-header-implementation.md`. The
  app README and `docs/operations.md` hold routes, snapshot shape,
  helpers, and setup.
- **Registry**: `registry/agents.json`, the agents and project folders the
  daemon runs and lists: role, description, group, cwd, provider, model
  and effort, `accepts` (who may message it), launchd labels, `pinned`,
  `builtin` (seeded from `registry/builtin.json`, no Delete); plus the
  `groups` list that sets group order and labels. Local data the
  dashboard writes, never committed; back it up when moving machines.
  Absolute paths; the daemon keeps the last good copy on a bad edit. Since 2026-10-02 the
  dashboard writes it (an agent's settings, New agent) as 2-space JSON in
  the schema's key order; hand edits still load.
- **Use cases**: `daily-brief/`, running every morning since 2026-09-27
  (gather one packet per domain, curate, build, verify), with the newsletter
  `watch` domain daily; `feed/`, the store behind the Feed, which
  watch writes and the dashboard reads. A later weekly review or decision
  prep sits beside them with its own contract.
- **The agents' repos**, each its own repo with its own CLAUDE.md, launchd
  jobs, and state (CFO, Focus, Second brain, personal-context; Watch lives
  here). Working under the link loads that repo's instructions, and git
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
  - The harness (skills, output style, agents) is `~/workspace/Claude`.
- Access: Hunter's own sessions and agents reach any of his local context
  from here, CFO included. Access boundaries apply to external callers, not
  to his own work.

## Words

`CONTEXT.md` is the glossary. Everything that talks is an agent; the
Assistant is the pinned agent; routines are scheduled prompts and jobs are
launchd plists. No "domains" or "personas" in replies, specs, or copy; the
registry's `kind: persona` and the brief contract's "domain" (one
contribution per domain) are code words until they are renamed.

## Orientation

1. `thoughts/shared/lanes/assistant/handoff.md`: the system and its
   interface. Current state, decisions, and what is next. The design it
   builds toward is `thoughts/shared/plans/2026-09-30-assistant-system-design.md`;
   its twenty decisions are settled and its behaviors B1 to B22 are what
   plans and issues cite. Routines there means scheduled prompts to an
   agent; the launchd jobs are "jobs" and live in Health.
2. `thoughts/shared/lanes/daily-brief/handoff.md`: the brief. Scheduled since
   09-27 (`thoughts/shared/plans/2026-09-27-daily-brief-scheduled-run.md`),
   watch daily since 2026-10-01 (`2026-09-28-watch-domain.md`). On 2026-09-29 the writing
   rules collapsed to a few content rules after Hunter preferred a one-shot
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

- `dashboard/app/`: the daemon. Three runtime dependencies (the Claude Agent
  SDK, `ws`, and `zod`); run `npm ci` after pulling. `var/` is local state.
- `dashboard/prototype/`: a static design study with illustrative data; its
  own repository, ignored here.
- `registry/agents.json`: the agent registry, local data gitignored like
  `routines/`; `registry/builtin.json`, the committed built-in agents it is
  seeded from.
- `routines/`: one file per routine, written by the dashboard; local data,
  gitignored, never committed; `runs/` beside them holds the runs logs,
  gitignored too.
- `notifications/`: the notifications store, gitignored.
- `daily-brief/`: contract, schema, curator rules, `bin/run-brief` and its
  prompts, `launchd/`, `watch/`. `contributions/` and `briefs/` are outputs,
  gitignored; each build writes the viewer and `brief-<date>.json`;
  `build.py` and `check-viewer.mjs` beside the briefs are code.
- `feed/`: the feed store's README; `items/` is its output, gitignored.
- `ideas/`: the store's README and criteria; `items/` and `marks.json`
  are outputs, gitignored.
- `agents/`: one folder per agent that lives in this repo (Assistant,
  Watch, Myos), its CLAUDE.md and skills; the folder is the agent's `cwd`.
- `systems/`: symlinks to the agents' repos.
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
  --stage <gather|curate|verify>`. Idempotent by date: it exits only when the
  viewer and valid brief data exist. Never run it from a test against a real
  date.
- The agents' repos: change them through `systems/<name>/` under that repo's own
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
  vault and only messages the Second brain agent. The dashboard writes
  Ideas marks and manual ideas; Myos's weekly run writes one run file.
  Agents act under Hunter's inline approvals; the dashboard never sends a
  Codex turn and answers one request with one decision. Agent turns bill
  the Claude subscription; an API key in the daemon's environment
  disables them.
- **Raw external content never reaches the curator.** A contributing domain
  summarizes it into a claim marked external.
- **One Daily Brief run, owned here.** The agents keep their own state current
  and produce no scheduled sub-briefs.
- **Dashboard copy** goes through `/writing`: plain nouns for labels,
  sentences for states, no interface metacommentary, no placeholders.
- **Factory PRs are reviewed locally before merging**: worktree, the three
  suites, screenshots on a throwaway port, then merge, pull, and reinstall.
  Two PRs that touch the same files are merged through one local review
  branch. Nothing watches PRs between sessions; pickup lists them.
- Focus owns persistent task state. The brief may say Hunter owes someone a
  decision; it never becomes the store of record.
