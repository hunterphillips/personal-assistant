# Personal assistant

The words every screen, plan, and session uses for Hunter's assistant. A
consumer product's vocabulary: if a term would need explaining to a new
user, it is the wrong term. Definitions say what a thing is, not how it is
built.

## Language

**Agent**:
Something Hunter can talk to that has a name, a description, a folder it
works in, and a thread. CFO, Focus, Second brain, Watch, and the Assistant
are agents.
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
write into it; it is also the record of what the agent did.
_Avoid_: session, chat, conversation (as a noun for the object)

**Delegation**:
One agent asking another, in the other's thread, on Hunter's behalf or its
own.
_Avoid_: handoff, dispatch, routing

**Mention**:
An agent named with `@` in a message; a reference, not a delivery.

**Routine**:
A scheduled prompt to one agent, with a name, an instruction, a schedule in
words, and an active switch. Owned by the agent, stored here.
_Avoid_: job, cron, scheduled task, launchd

**Job**:
A scheduled program an agent's repo runs on its own (a launchd plist).
Shown in Health, never edited from the interface.
_Avoid_: routine, scan, daemon

**Brief**:
The Daily Brief: the morning memo the run writes at 06:05. Read in Reading;
announced as one line in the Assistant's thread.
_Avoid_: digest, newsletter, report

**Feed**:
What Watch and later producers found, as posts with Discuss. Read in
Reading.
_Avoid_: news, digest, stream

**Ideas**:
Suggestions about the system as a whole, in their own view, that Hunter
looks at on purpose. Never a message.
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
