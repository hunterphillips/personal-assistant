# Personal assistant

The words every screen, plan, and session uses for Hunter's assistant. A
consumer product's vocabulary: if a term would need explaining to a new
user, it is the wrong term. Definitions say what a thing is, not how it is
built.

## Language

**Agent**:
Something Hunter can talk to that has a name, a description, a folder it
works in, and a thread. Its instructions are the CLAUDE.md in its folder:
its own repo's, or `agents/<id>/` for one that lives in this repo. CFO,
Focus, Second brain, Scout, and the Assistant are agents.
_Avoid_: persona, domain, domain persona, domain system, bot

**Assistant**:
The agent Hunter pins and talks to by default. Its prompt makes it a
generalist: it reads anything and hands judgment to the agent that owns
it. Otherwise an agent like any other; any agent can be pinned, and more
than one can be.
_Avoid_: orchestrator, chief of staff, router, system, main agent

**Group**:
A heading agents are listed under, such as Work or Personal. Any name;
the registry sets the order and labels. Not a permission boundary.
_Avoid_: category, team, workspace

**Thread**:
One agent's conversation, continuing across days. Hunter and other agents
write into it; it is also the record of what the agent did. The word in
code and docs; on screen it is a chat ("New chat", "Quick chat").
_Avoid_: session, conversation (as a noun for the object)

**Delegation**:
One agent asking another, in the other's thread, on Hunter's behalf or its
own.
_Avoid_: handoff, dispatch, routing

**Mention**:
An agent named with `@` in a message; a reference, not a delivery.

**Routine**:
A scheduled prompt to one agent, with a name, an instruction, a schedule in
words, and an active switch. Owned by the agent, stored here.
Its runs and their replies are listed under the agent's settings, never in
the thread.
_Avoid_: job, cron, scheduled task, launchd

**Job**:
A scheduled program: one an agent's repo runs on its own (a launchd plist
on the Mac, a systemd timer on the server), or one the dashboard runs
itself, such as Focus's scans and curate. Shown in Health, never edited
from the interface.
_Avoid_: routine, cron, task

**Scan**:
A job that reads one source for Focus (Calendar, Gmail, GitHub, or the
vault's notes) and keeps what it found as candidates. It judges nothing
and changes nothing.
_Avoid_: sync, import, crawl

**Curate**:
The job that changes the Focus board from the scans' candidates, under
Focus's rules: after a scan finds something new, once each morning over
the whole board, and on Refresh. Paused from the Curation switch in
Focus's gear, where the scans keep running.
_Avoid_: rejudge, triage, sort

**Brief**:
The Daily Brief: the morning memo the run writes at 06:05. Read in the
overlay that opens from the header on any view; announced as one line in
the Assistant's thread.
_Avoid_: digest, newsletter, report

**Feed**:
A named set of posts an agent finds each morning from the feed's sources,
kept or dropped by the feed's instructions, each with Discuss. The Feed
view shows each feed as a tab.
_Avoid_: digest, stream

**Source**:
Something a feed reads: an RSS feed, a newsletter's sender, a file, or a
folder. Incoming sources bring posts; files and folders are context.
Kept once and shared by any feed that lists it.
_Avoid_: input, channel, subscription

**Scout**:
The built-in agent that produces the feeds and answers Discuss on a post.
It replaced Watch, which read newsletters for the one Feed and is retired.
_Avoid_: Watch, newsletter agent

**Ideas**:
Suggestions about the system as a whole, in their own view, that Hunter
looks at on purpose: a weekly run on Myos against `ideas/criteria.md`,
and his own typed in. Never a message.
_Avoid_: offers, suggestions feed, recommendations

**Health**:
The view of the system's own state: jobs and their outcomes, what is
unavailable, and Settings.
_Avoid_: status, ops, admin

**Settings**:
Where defaults live: the system's default model and effort, which agent
receives the brief, and, per agent, its own name, description, folder,
model, and who may message it (everyone unless Hunter narrows it).
_Avoid_: config, configuration, preferences

**Model**:
Which Claude an agent's turn runs on, with an effort level. Chosen in
Settings as a system default, per agent, and in the composer for a thread.

**Registry**:
The file that lists the agents. The one source of truth; written through
the interface (an agent's settings, New agent), never by hand in a
session. A hand edit between sessions still loads.
_Avoid_: agents.json (in prose), manifest

**Vault**:
Hunter's second brain: notes about him and what he has decided. Second
brain is the agent that holds it.
_Avoid_: notes repo, memory store
