// State hub: one in-memory snapshot of what the dashboard knows (Focus
// health, the latest brief, the agent registry, persona state, coding
// sessions and the cmux terminals behind them, jobs, routines, and
// notifications), with a
// revision that bumps on every change and a subscriber list for the event
// stream. It owns no persistence and no refresh timers; callers decide when
// to refresh. Its only timers are the persona turn wall clocks.
//
// createHub({ registry, jobs, routines, schedule, timeZone, focus, brief,
//             timeouts, limits, adapters, store, bindings, cmux,
//             adaptersDisabled, settings, reads, notifications, models, home, log,
//             now }) returns:
//
//   snapshot() -> frozen
//     { revision,                 // integer, starts at 1, +1 on every change
//       updatedAt,                // ISO time of the last change
//       home,                     // the home directory, for showing paths
//       focus: { available },     // null until the first refreshStatus
//       brief,                    // exactly what /api/dashboard/status reports:
//                                 // { state, date?, revision? }, or
//                                 // { state: 'unknown' } before the first check
//       registry: { ok, error, loadedAt },
//       groups: [{ id, name }],    // the registry's group list, in order
//       agents: [{ id, name, role, description, group, kind, cwd, jobs, avatar,
//                  provider?, pinned?, builtin?, state, pending?, lastMessage?,
//                  lastError?, costUsd?, lastLineAt?, model?, permission?,
//                  accepts?, unread }],
//       sessions: [{ id, provider, threadId, cwd, projectId, title, state,
//                    pending, lastMessage, lastError, updatedAt, binding }
//                  | { id, provider: 'claude', kind: 'terminal', cwd, projectId,
//                      state, updatedAt, binding }],
//       codex: { available } | { available: false, reason },
//       cmux: { available, stale? } | { available: false, reason },
//       jobs: { refreshedAt, focusAvailable, refreshing, error, items },
//       routines: { items: [{ id, name, agent, instruction,
//                             schedule: { cron, text }, active, created,
//                             updated, nextAt, lastRun }] },
//       settings: { ok, error, model: { default, effort }, brief: { agent },
//                   permission: { default }, quickChat: { agent } },
//       notifications: { open, items: [{ id, agent, text, link, at,
//                                         acknowledgedAt }] },
//       models: [{ id, name }] }
//     An agent's cwd is the registry's, or null, and jobs is how many
//     launchd labels its registry jobs name; agents never carry the
//     jobs themselves. avatar is null or the agent's picture file's mtime
//     in ms as a string (avatars.mjs), for /api/agents/<id>/avatar?v=<it>;
//     read when the registry loads or changes and on refreshStatus, never
//     watched. Each object in it is frozen.
//     `home` is the `home` option, os.homedir() by default.
//     A non-persona agent has state null and no other runtime fields. A
//     persona (kind 'persona') has:
//       state        'idle' | 'busy' | 'waiting' | 'error' | 'unavailable'
//       pending      null or { requestId, kind, toolName, input, truncated }:
//                    an approval's input is its JSON text, cut to
//                    limits.requestInputBytes with truncated true when it is
//                    longer; a question's input is always the whole object
//                    with truncated false, since a question cut short cannot
//                    be answered (the tool bounds its size anyway).
//       lastMessage  null or { role, text, at, from? }, text cut to limits.previewChars
//                    (a message's `summary` stands in for its text when present;
//                    `from` is the sending agent's id on a message another
//                    agent sent)
//       lastError    null or a string
//       costUsd      null or the session's running total
//       needsYou     true when a routine of this agent last ended `waiting`
//                    (a card it raised went unanswered) and Hunter has not
//                    written in the thread since; derived from the store,
//                    never stored. Hunter's own message (a user message
//                    with neither `from` nor `routine`) clears it; the hub
//                    keeps `lastOwnMessageAt` per persona from `message`
//                    events, seeded from the thread cache at start.
//     A Claude persona also has:
//       model        { id, effort, source, default }: what its next turn
//                    runs on. id is a model id or alias or null, effort one
//                    of models.mjs EFFORTS or null; null means Claude Code's
//                    own default. source names the level that set either
//                    field: 'thread' (the thread's own choice, read from the
//                    adapter's state().model), 'agent' (the registry's
//                    `model` or `effort`), 'system' (settings), or 'default'
//                    when nothing is set anywhere. `default` is { id,
//                    effort } resolved without the thread level: what New
//                    thread returns to, so a view can mark it. `agent` is
//                    the registry's own { id, effort } (either null), for a
//                    form that edits them.
//       permission   { level, source, agent, default }: the level its next
//                    turn runs at (permissions.mjs PERMISSION_LEVELS).
//                    source is 'agent' (the registry's `permission`) or
//                    'system' (settings); agent is the registry's own
//                    level or null; default is the settings level, which
//                    always has a value.
//       accepts      the registry's `accepts` list or null (everyone), on
//                    every persona
//     `settings` is the settings store's view (settings.mjs): `ok` false
//     with `error` when the file could not be read, the last good values
//     either way. `models` is the model table (models.mjs) for the views.
//     `routines.items` are the routine store's routines (routines.mjs), in
//     registry agent order (an agent the registry does not list last, by
//     id) then by name, each with `nextAt`, the next occurrence
//     (schedule.mjs next() in `timeZone`) or null when the routine is
//     inactive or its agent is not a Claude persona, and `lastRun`, the
//     store's newest folded run or null. Rebuilt on the store's onChange,
//     on a registry change, and by runEnded(). Without a `routines` store
//     the list is empty.
//     `notifications` is the notification store's view (notifications.mjs):
//     every retained item, newest first, and the count still open. Rebuilt
//     on the store's onChange. Without a store it is { open: 0, items: [] }.
//     `sessions` is the union of every adapter's sessions() (adapter.mjs),
//     threads the dashboard follows but does not own, and the Claude
//     terminals cmux has registered (`cmux`, runtime/cmux.mjs), newest
//     first by updatedAt. Every row carries `projectId`: the id of the
//     registry project (kind 'project') whose cwd is the session's cwd or
//     a parent of it, the longest such cwd when several match, or null.
//     The view nests each session under that project. An adapter's row
//     carries its provider (the adapter kind), its cwd, state
//     and pending as for a persona (pending also carries `native: true`
//     when only the terminal can answer it), lastMessage cut to
//     limits.previewChars, and `binding`, the cmux { workspaceId,
//     surfaceId } recorded by bin/codex-new for that thread (from
//     `bindings`, bindings.mjs) plus `live`, true only while that surface
//     is in the last cmux inventory; or null with no record. A session's
//     state may also be 'unavailable' while its adapter has lost the
//     server. A terminal row (kind 'terminal', id 'claude:<cmux session
//     id>') comes from a cmux agent record whose agent is 'claude': its
//     cwd and updatedAt as cmux reports them, state 'busy' for cmux's
//     'running', 'idle' for 'idle', 'waiting' for 'needsInput', else
//     'unknown', and a binding that is always present, `live` false once
//     its surface is gone. A session id the inventory lists twice yields
//     one row, from the record with the newest updatedAt. Terminal rows
//     have no adapter: nothing here answers or interrupts them.
//     `codex` is adapters.codex.status(): whether the shared Codex
//     app-server is connected and, when not, why ('no_server',
//     'disconnected', 'ws_unavailable'); with no Codex adapter the reason
//     is `adaptersDisabled` when given, else 'no_adapter'.
//     `cmux` is the last inventory's availability: { available: true }
//     (with stale: true when the client is serving its last good answer),
//     or { available: false, reason } with the inventory's reason
//     ('not_running', 'no_password', 'auth_failed', 'error'),
//     'not_refreshed' before the first refreshSessions(), or 'no_client'
//     without a cmux client.
//
//   refreshStatus({ signal }) -> Promise<void>
//     Focus health (focus.checkHealth) and the latest brief
//     (brief.latestMetadata) in parallel, each bounded by timeouts.statusMs
//     with its own aborted signal on timeout. Single-flight: callers during a
//     run share it. Bumps only when `focus` or `brief` changed. `signal` only
//     stops that caller waiting; the shared run is not aborted. Never rejects.
//
//   refreshSessions({ signal }) -> Promise<void>
//     Refreshes the cmux inventory (cmux.refresh()) and the Codex catalogue
//     (adapters.codex.refresh(), when the adapter has one) in parallel, then
//     rebuilds `sessions` and `cmux` and commits what differs. The Codex
//     half is waited on for at most timeouts.statusMs: a slower poll goes
//     on in the adapter and lands as its `sessions` event. Single-flight:
//     callers during a run share it; `signal` only stops that caller
//     waiting. A refresh that throws is logged as sessions_refresh_error.
//     Never rejects. After close() it resolves at once and refreshes
//     nothing, so a late caller cannot reopen the cmux connection. Nothing
//     else refreshes the inventory: the event stream calls this while
//     streams are open (events.mjs) and the sessions refresh route calls
//     it on demand.
//
//   refreshJobs({ signal }) -> Promise<void>
//     Single-flight. Sets jobs.refreshing (bump), awaits
//     jobs.refresh({ signal }) with the first caller's signal, then
//     stores the result with refreshing false and error null (bump). If the
//     refresh throws, refreshing is false and error 'refresh_failed' (bump),
//     logged as { event: 'jobs_error', error }. Never rejects.
//
//   keepJobsCurrent()
//     Calls refreshJobs() now and every limits.jobsRefreshMs until close(),
//     so the rail's Health mark is current without Health open. Idempotent.
//
//   subscribe(fn) -> unsubscribe
//     fn({ revision, patch }) runs after every bump; `patch` holds only the
//     top-level content keys that changed (focus, brief, registry, agents,
//     sessions, codex, cmux, jobs, routines, settings, notifications), never revision or updatedAt. A throwing listener is logged
//     as { event: 'hub_listener_error', error } and the rest still run.
//
//   start() -> Promise<void>
//     For each registry persona whose provider has an adapter in `adapters`,
//     awaits adapter.start(agent) and seeds state, pending, lastError, and
//     costUsd from adapter.state(id), and lastMessage from the last message
//     in store.read(id) that is not a bookkeeping line (below). Until then a persona is 'unavailable' with
//     lastError null. A persona with no adapter for its provider stays
//     'unavailable' with lastError `adaptersDisabled` when given, else
//     'provider_unavailable'; one whose start rejects is 'unavailable' with
//     'sdk_unavailable' when the rejection carries that code,
//     'provider_unavailable' for 'not_supported' (the adapter runs no
//     personas, as Codex's does), else 'start_failed' (either logged as persona_start_error with the bounded
//     error message). Never rejects.
//     Adapter events then update the entry: thread.state -> state (and
//     lastError and costUsd from adapter.state, which the adapter clears
//     without an event); message -> lastMessage, except a bookkeeping
//     line (a system message with a `kind` other than `brief`, such as
//     setModel's `model` line), which leaves the thread's real last
//     message in place; request -> pending;
//     resolved -> pending null; usage -> costUsd; error -> lastError.
//     A request whose `chain[0]` is another started persona (it was
//     raised while answering a delegation) is also relayed: the hub keeps
//     { origin: chain[0], owner, from, chain } by requestId and lists the
//     request, projected as `pending` is plus `agent` (the owner's id), in
//     the origin's `forwarded`, oldest first. The origin's state and
//     pending are untouched. The relay is dropped on the request's
//     `resolved` (any outcome, and even when the owner's entry is gone),
//     when the registry drops the owner or the origin, when the owner's
//     thread.state turns error, and by dropRelaysTo. A request whose
//     origin has no entry is not relayed and is logged relay_dropped.
//
//   requestOwner(agentId, requestId) -> agentId | null
//     The owner of a request forwarded to agentId's thread, or null (an
//     agent's own requests are its adapter's business). The answer route
//     asks after the agent's own adapter refuses no_such_request.
//
//   dropRelaysTo(agentId)
//     Drops every relay whose origin is agentId and empties its
//     `forwarded`; the requests stay answerable in their owners' threads.
//     The new-thread route calls it after a successful reset.
//
//   avatar(id) -> Promise<{ type, body } | null>
//     The registry agent's picture, read now (avatars.mjs readAvatar), or
//     null when it has none or the registry does not list it.
//
//   persona(id) -> { agent, adapter } | null
//     The registry agent (with cwd) and its adapter, for a started persona.
//
//   runEnded(routineId)
//     Rebuilds `routines` (the routine's lastRun and nextAt) and the agent
//     views (the owner's needsYou) after the scheduler wrote a run line;
//     also called when a run starts.
//
//   modelFor(agentId) -> { id, effort }
//     The pair the agent's next turn runs on, resolved as the agent view's
//     `model` is (thread over agent over system); { id: null, effort: null }
//     for an agent that is not a Claude persona. The routes pass it to
//     adapter.send as { model, effort }.
//
//   permissionFor(agentId) -> level | null
//     The level the agent's next turn runs at, resolved as the agent view's
//     `permission` is (agent over system); null for an agent that is not a
//     Claude persona. The send route and a delegated hop pass it to
//     adapter.send as { permission }.
//
//   notify(agentId, message) -> Promise<message>
//     Appends `message` ({ role, text, ...fields }, `at` defaulting to now)
//     to the agent's thread through the store, so the daemon stays the
//     thread's only writer, then sets the persona's lastMessage from it
//     (`summary` over `text` when the message carries one) and commits.
//     A bookkeeping line (a delegation line) leaves lastMessage alone and
//     sets lastLineAt to its `at` instead, so an open thread view knows to
//     fetch again when a line lands outside the agent's own turn.
//     For a message from outside a turn: the morning brief notice
//     (notices.mjs). Rejects when there is no store or the store refuses
//     the message; an agentId that is not a listed persona still appends
//     (the store validates the id) but changes no snapshot.
//
//   session(id) -> { agent, adapter } | null
//     { id } and the adapter following that session, for a listed session;
//     `adapter` is null for a terminal row. Any event from an adapter whose
//     agentId is not a persona, and any bindings change, rebuilds
//     `sessions`, `codex`, and `cmux` and commits what differs.
//
//   clientCount() -> number of live subscribers
//   close()       unsubscribes from the registry, the bindings, and the
//                 adapters, clears the turn timers, and drops all subscribers. It does not close
//                 the adapters; the server does that first.
//
// A settings change (settings.onChange) replaces `settings` and `agents`.
//
// A registry change (registry.onChange) replaces `registry` and `agents`
// and, after start(), rebuilds `sessions` (their projectId may change);
// newly listed personas are started and removed ones dropped,
// and personas still listed keep their runtime state, session pointer
// included: a cwd change is only logged as { event: 'persona_cwd_changed',
// agentId }, and New thread is how the persona moves to the new directory.
//
// Turn wall clock: when a persona goes busy from idle or error, an unref'd
// timer of timeouts.turnMaxMs is armed; it keeps running while the persona
// waits on an answer. When it fires the hub calls adapter.interrupt(agent)
// and logs { event: 'persona_turn_timeout', agentId }; once the interrupt
// resolves, lastError is 'turn_timeout' so the snapshot says why the turn
// stopped, unless the turn was a routine's run (the interrupt resolves its
// { text, error, aborted }), whose end is the run's and not the thread's.
// The timer is cleared when the persona goes idle or error.

import os from 'node:os';

import { findAvatar, readAvatar } from './avatars.mjs';
import { LIMITS, TIMEOUTS, TIME_ZONE } from './config.mjs';
import { MODELS } from './models.mjs';
import * as defaultSchedule from './schedule.mjs';
import { DEFAULTS as SETTINGS_DEFAULTS } from './settings.mjs';
import { truncateUtf8 } from './threads.mjs';

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const REVISION = /^[0-9a-f]{64}$/;
const STATE_WORD = /^[a-z_]{1,40}$/;

export function createHub({
  registry, jobs, routines = null, schedule = defaultSchedule, timeZone = TIME_ZONE, focus, brief, timeouts, limits = LIMITS,
  adapters = {}, store = null, bindings = null, cmux = null, adaptersDisabled = null, settings = null, reads = null, notifications = null, models = MODELS,
  home = os.homedir(), log = () => {}, now = () => new Date(),
}) {
  const listeners = new Set();
  const settingsCurrent = () => settingsView(settings ? settings.current() : null);
  // agentId -> the picture's mtime as a string, or null (avatars.mjs).
  let avatars = avatarVersions(registry.current());
  const views = (current = registry.current()) => agentViews(current, personas, settingsCurrent(), routines, reads, avatars);
  const routinesCurrent = () => routinesView(registry.current(), routines, schedule, timeZone, now());
  const notificationsCurrent = () => (notifications ? notifications.view() : { open: 0, items: [] });
  const turnMaxMs = timeouts.turnMaxMs ?? TIMEOUTS.turnMaxMs;
  // agentId -> runtime entry for each registry persona (see personaEntry).
  const personas = new Map();
  const adapterUnsubscribes = [];
  let started = false;
  let closed = false;
  let state = deepFreeze({
    revision: 1,
    updatedAt: now().toISOString(),
    home,
    focus: { available: null },
    brief: { state: 'unknown' },
    ...registryFields(registry.current(), views),
    sessions: [],
    codex: codexStatus(adapters, adaptersDisabled),
    cmux: cmuxStatus(cmux),
    jobs: { refreshedAt: null, focusAvailable: null, refreshing: false, error: null, items: [] },
    routines: routinesCurrent(),
    settings: settingsCurrent(),
    notifications: notificationsCurrent(),
    models: models.map((model) => ({ id: model.id, name: model.name })),
  });
  let statusRun = null;
  let jobsRun = null;
  let sessionsRun = null;

  // Applies `patch` (top-level keys to replace), bumps, and notifies.
  function commit(patch) {
    const frozen = deepFreeze({ ...patch });
    const revision = state.revision + 1;
    state = Object.freeze({ ...state, ...frozen, revision, updatedAt: now().toISOString() });
    for (const fn of [...listeners]) {
      try {
        fn({ revision, patch: frozen });
      } catch (error) {
        log({ event: 'hub_listener_error', error: error?.message ?? String(error) });
      }
    }
  }

  function commitAgents() {
    const agents = views();
    if (!sameJson(agents, state.agents)) commit({ agents });
  }

  // Routines and the agent views that read them (needsYou), in one bump.
  function commitRoutines() {
    const patch = {};
    const current = routinesCurrent();
    if (!sameJson(current, state.routines)) patch.routines = current;
    const agents = views();
    if (!sameJson(agents, state.agents)) patch.agents = agents;
    if (Object.keys(patch).length > 0) commit(patch);
  }

  function commitSessions() {
    const patch = {};
    const sessions = sessionViews(adapters, bindings, limits, cmux, registry.current());
    if (!sameJson(sessions, state.sessions)) patch.sessions = sessions;
    const codex = codexStatus(adapters, adaptersDisabled);
    if (!sameJson(codex, state.codex)) patch.codex = codex;
    const terminals = cmuxStatus(cmux);
    if (!sameJson(terminals, state.cmux)) patch.cmux = terminals;
    if (Object.keys(patch).length > 0) commit(patch);
  }

  function adapterFor(agent) {
    return Object.hasOwn(adapters, agent.provider) ? adapters[agent.provider] : null;
  }

  // Brings the persona entries in line with the registry: starts new ones,
  // drops removed ones (and any whose provider changed), and refreshes the
  // agent object of the rest.
  function syncPersonas(agents) {
    const listed = new Map(agents.filter((agent) => agent.kind === 'persona').map((agent) => [agent.id, agent]));
    for (const [id, entry] of personas) {
      const agent = listed.get(id);
      if (!agent || agent.provider !== entry.agent.provider) {
        clearTimeout(entry.timer);
        personas.delete(id);
        dropRelaysWhere((relay) => relay.owner === id || relay.origin === id);
      } else {
        if (agent.cwd !== entry.agent.cwd) log({ event: 'persona_cwd_changed', agentId: id });
        entry.agent = agent;
      }
    }
    const starts = [];
    for (const [id, agent] of listed) {
      if (!personas.has(id)) starts.push(startPersona(agent));
    }
    return Promise.all(starts);
  }

  async function startPersona(agent) {
    const adapter = adapterFor(agent);
    const entry = personaEntry(agent, adapter);
    personas.set(agent.id, entry);
    if (!adapter) {
      entry.lastError = adaptersDisabled ?? 'provider_unavailable';
      return;
    }
    try {
      await adapter.start(agent);
    } catch (error) {
      const reason = error?.code === 'sdk_unavailable' ? 'sdk_unavailable'
        : error?.code === 'not_supported' ? 'provider_unavailable' : 'start_failed';
      const message = error?.cause?.message ?? error?.message ?? String(error);
      log({ event: 'persona_start_error', agentId: agent.id, reason, error: truncateUtf8(String(message), 500).text });
      if (personas.get(agent.id) === entry) entry.lastError = reason;
      return;
    }
    const cached = await lastCachedMessage(agent.id);
    if (closed || personas.get(agent.id) !== entry) return;
    const seeded = adapter.state(agent.id);
    entry.ready = true;
    entry.state = seeded.state;
    entry.pending = projectRequest(seeded.pending, limits);
    entry.lastError = seeded.lastError ?? null;
    entry.costUsd = seeded.costUsd ?? null;
    entry.lastMessage ??= cached.lastMessage;
    entry.lastOwnMessageAt ??= cached.lastOwnMessageAt;
    entry.lastReplyAt ??= cached.lastReplyAt;
    if (entry.state === 'busy' || entry.state === 'waiting') armTurnTimer(entry);
  }

  // The thread cache's last preview-worthy message, Hunter's last message,
  // and the newest reply, each null when there is none.
  async function lastCachedMessage(agentId) {
    if (!store) return { lastMessage: null, lastOwnMessageAt: null, lastReplyAt: null };
    try {
      const messages = await store.read(agentId);
      const last = messages.findLast(updatesPreview);
      const own = messages.findLast(isOwnMessage);
      const reply = messages.findLast(isReply);
      return {
        lastMessage: last ? preview(last, limits) : null,
        lastOwnMessageAt: typeof own?.at === 'string' ? own.at : null,
        lastReplyAt: typeof reply?.at === 'string' ? reply.at : null,
      };
    } catch (error) {
      log({ event: 'thread_cache_error', agentId, error: error?.message ?? String(error) });
      return { lastMessage: null, lastOwnMessageAt: null, lastReplyAt: null };
    }
  }

  function armTurnTimer(entry) {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      entry.timer = null;
      log({ event: 'persona_turn_timeout', agentId: entry.agent.id });
      entry.adapter.interrupt(entry.agent).then((ended) => {
        if (closed || personas.get(entry.agent.id) !== entry) return;
        if (ended && typeof ended === 'object') return;
        entry.lastError = 'turn_timeout';
        commitAgents();
      }, (error) => {
        log({ event: 'persona_interrupt_error', agentId: entry.agent.id, error: error?.message ?? String(error) });
      });
    }, turnMaxMs);
    entry.timer.unref?.();
  }

  // Relays: requestId -> { origin, owner, from, chain } for every open
  // request raised while answering a delegation, mirrored in the origin
  // entry's `forwarded`. The header describes when each is dropped.
  const relays = new Map();

  function dropRelaysWhere(matches) {
    let changed = false;
    for (const [requestId, relay] of relays) {
      if (!matches(relay, requestId)) continue;
      relays.delete(requestId);
      const origin = personas.get(relay.origin);
      if (origin) origin.forwarded = origin.forwarded.filter((item) => item.requestId !== requestId);
      changed = true;
    }
    return changed;
  }

  function relayRequest(entry, event) {
    const origin = Array.isArray(event.chain) ? event.chain[0] : undefined;
    if (typeof origin !== 'string' || origin === '' || origin === entry.agent.id) return;
    const target = personas.get(origin);
    if (!target) {
      log({ event: 'relay_dropped', agentId: entry.agent.id, origin, requestId: event.requestId });
      return;
    }
    const projected = projectRequest(event, limits);
    if (!projected) return;
    relays.set(event.requestId, { origin, owner: entry.agent.id, from: event.from ?? null, chain: [...event.chain] });
    target.forwarded = [...target.forwarded.filter((item) => item.requestId !== event.requestId), { ...projected, agent: entry.agent.id }];
  }

  function onAdapterEvent(adapter, event) {
    if (closed) return;
    // A settled request's relay goes even when its owner is no longer an
    // entry, so the origin's card never outlives the request.
    const relayDropped = event?.type === 'resolved' && dropRelaysWhere((_, requestId) => requestId === event.requestId);
    const entry = personas.get(event?.agentId);
    if (!entry) {
      if (relayDropped) commitAgents();
      if (typeof adapter.sessions === 'function') commitSessions();
      return;
    }
    if (!entry.ready || entry.adapter !== adapter) {
      if (relayDropped) commitAgents();
      return;
    }
    switch (event.type) {
      case 'thread.state': {
        const previous = entry.state;
        entry.state = event.state;
        const current = adapter.state(entry.agent.id);
        entry.lastError = current.lastError ?? null;
        entry.costUsd = current.costUsd ?? null;
        if (event.state === 'busy' && (previous === 'idle' || previous === 'error')) armTurnTimer(entry);
        if (event.state === 'idle' || event.state === 'error') {
          clearTimeout(entry.timer);
          entry.timer = null;
        }
        if (event.state === 'error') dropRelaysWhere((item) => item.owner === entry.agent.id);
        break;
      }
      case 'message':
        if (updatesPreview(event)) entry.lastMessage = preview(event, limits);
        if (isOwnMessage(event) && typeof event.at === 'string') entry.lastOwnMessageAt = event.at;
        if (isReply(event) && typeof event.at === 'string') entry.lastReplyAt = event.at;
        break;
      case 'request':
        entry.pending = projectRequest(event, limits);
        relayRequest(entry, event);
        break;
      case 'resolved':
        if (entry.pending?.requestId === event.requestId) {
          entry.pending = projectRequest(adapter.state(entry.agent.id).pending, limits);
        }
        break;
      case 'usage':
        entry.costUsd = typeof event.costUsd === 'number' ? event.costUsd : null;
        break;
      case 'error':
        entry.lastError = typeof event.message === 'string' ? event.message : 'error';
        break;
      default:
        return;
    }
    commitAgents();
  }

  const unsubscribeBindings = bindings ? bindings.onChange(() => {
    if (started && !closed) commitSessions();
  }) : () => {};

  const unsubscribeRegistry = registry.onChange((current) => {
    if (started && !closed) {
      const agents = current?.agents ?? [];
      const ensureReads = reads
        ? reads.ensure(agents.filter((agent) => agent.kind === 'persona').map((agent) => agent.id))
        : Promise.resolve();
      Promise.all([syncPersonas(agents), ensureReads]).then(() => {
        if (!closed) commitAgents();
      }, (error) => {
        log({ event: 'thread_reads_error', error: error?.message ?? String(error) });
      });
    }
    avatars = avatarVersions(current);
    commit({ ...registryFields(current, views), routines: routinesCurrent() });
    if (started && !closed) commitSessions();
  });

  const unsubscribeRoutines = routines && typeof routines.onChange === 'function' ? routines.onChange(() => {
    if (!closed) commitRoutines();
  }) : () => {};

  const unsubscribeNotifications = notifications && typeof notifications.onChange === 'function' ? notifications.onChange(() => {
    if (!closed) commit({ notifications: notificationsCurrent() });
  }) : () => {};

  const unsubscribeSettings = settings && typeof settings.onChange === 'function' ? settings.onChange(() => {
    if (closed) return;
    const patch = {};
    const view = settingsCurrent();
    if (!sameJson(view, state.settings)) patch.settings = view;
    const agents = views();
    if (!sameJson(agents, state.agents)) patch.agents = agents;
    if (Object.keys(patch).length > 0) commit(patch);
  }) : () => {};

  async function runStatus() {
    const budget = timeouts.statusMs;
    const [focusStatus, briefStatus] = await Promise.all([
      bounded((signal) => focus.checkHealth({ signal }), budget).then(
        (result) => ({ available: result?.available === true }),
        () => ({ available: false }),
      ),
      bounded((signal) => brief.latestMetadata({ signal }), budget).then(
        summarizeBrief,
        () => ({ state: 'unavailable' }),
      ),
    ]);
    const patch = {};
    if (!sameJson(focusStatus, state.focus)) patch.focus = focusStatus;
    if (!sameJson(briefStatus, state.brief)) patch.brief = briefStatus;
    // A picture added, replaced, or removed since the registry loaded.
    avatars = avatarVersions(registry.current());
    const agents = views();
    if (!sameJson(agents, state.agents)) patch.agents = agents;
    if (Object.keys(patch).length > 0) commit(patch);
  }

  async function runSessions() {
    const refreshes = [];
    if (cmux) refreshes.push(cmux.refresh());
    const codex = Object.hasOwn(adapters, 'codex') ? adapters.codex : null;
    if (typeof codex?.refresh === 'function') {
      // The poll keeps running past the budget; its outcome then arrives as
      // an adapter event, which rebuilds the list by itself.
      refreshes.push(settledWithin(codex.refresh(), timeouts.statusMs ?? TIMEOUTS.statusMs));
    }
    const outcomes = await Promise.allSettled(refreshes);
    for (const outcome of outcomes) {
      if (outcome.status === 'rejected') {
        log({ event: 'sessions_refresh_error', error: outcome.reason?.code ?? outcome.reason?.name ?? 'unknown' });
      }
    }
    if (!closed) commitSessions();
  }

  async function runJobs(signal) {
    commit({ jobs: { ...state.jobs, refreshing: true } });
    try {
      const result = await jobs.refresh({ signal });
      commit({
        jobs: {
          refreshedAt: result?.refreshedAt ?? null,
          focusAvailable: typeof result?.focusAvailable === 'boolean' ? result.focusAvailable : null,
          refreshing: false,
          error: null,
          items: Array.isArray(result?.jobs) ? result.jobs : [],
        },
      });
    } catch (error) {
      log({ event: 'jobs_error', error: error?.message ?? String(error) });
      commit({ jobs: { ...state.jobs, refreshing: false, error: 'refresh_failed' } });
    }
  }

  function refreshJobs({ signal } = {}) {
    jobsRun ??= runJobs(signal).finally(() => {
      jobsRun = null;
    });
    return jobsRun;
  }

  let jobsTimer = null;

  return {
    snapshot() {
      return state;
    },

    refreshStatus({ signal } = {}) {
      statusRun ??= runStatus()
        .catch((error) => log({ event: 'status_error', error: error?.message ?? String(error) }))
        .finally(() => {
          statusRun = null;
        });
      return untilAborted(statusRun, signal);
    },

    refreshSessions({ signal } = {}) {
      // After close() nothing may touch the cmux client again: a call would
      // reopen the connection close() just ended.
      if (closed) return Promise.resolve();
      sessionsRun ??= runSessions()
        .catch((error) => log({ event: 'sessions_refresh_error', error: error?.code ?? error?.name ?? 'unknown' }))
        .finally(() => {
          sessionsRun = null;
        });
      return untilAborted(sessionsRun, signal);
    },

    refreshJobs,

    // The rail's Health mark reads jobs from the snapshot on every view, so
    // the daemon refreshes them now and every limits.jobsRefreshMs instead of
    // waiting for Health to open. Idempotent; close() stops the interval.
    keepJobsCurrent() {
      if (closed || jobsTimer !== null) return;
      refreshJobs();
      jobsTimer = setInterval(() => {
        if (!closed) refreshJobs();
      }, limits.jobsRefreshMs ?? LIMITS.jobsRefreshMs);
      jobsTimer.unref?.();
    },

    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },

    async start() {
      if (started || closed) return;
      started = true;
      for (const adapter of Object.values(adapters)) {
        if (adapter) adapterUnsubscribes.push(adapter.subscribe((event) => onAdapterEvent(adapter, event)));
      }
      await syncPersonas(registry.current()?.agents ?? []);
      if (closed) return;
      commitAgents();
      commitSessions();
    },

    async markRead(id) {
      if (!reads) return;
      await reads.mark(id);
      if (!closed) commitAgents();
    },

    // The listed agent's picture, { type, body }, or null (avatars.mjs).
    async avatar(id) {
      const agent = (registry.current()?.agents ?? []).find((item) => item.id === id);
      return agent ? readAvatar(agent) : null;
    },

    persona(id) {
      const entry = personas.get(id);
      if (!entry || !entry.ready || !entry.adapter) return null;
      return { agent: entry.agent, adapter: entry.adapter };
    },

    runEnded() {
      if (!closed) commitRoutines();
    },

    requestOwner(agentId, requestId) {
      const relay = relays.get(requestId);
      return relay && relay.origin === agentId ? relay.owner : null;
    },

    dropRelaysTo(agentId) {
      if (closed) return;
      if (dropRelaysWhere((relay) => relay.origin === agentId)) commitAgents();
    },

    modelFor(agentId) {
      const agent = (registry.current()?.agents ?? []).find((item) => item.id === agentId);
      if (!agent || agent.kind !== 'persona' || agent.provider !== 'claude') return { id: null, effort: null };
      const { id, effort } = resolveModel(agent, threadChoice(personas.get(agentId)), settingsCurrent());
      return { id, effort };
    },

    permissionFor(agentId) {
      const agent = (registry.current()?.agents ?? []).find((item) => item.id === agentId);
      if (!agent || agent.kind !== 'persona' || agent.provider !== 'claude') return null;
      return resolvePermission(agent, settingsCurrent()).level;
    },

    async notify(agentId, message) {
      if (!store) throw new Error('no_store');
      const record = { ...message, at: typeof message?.at === 'string' ? message.at : now().toISOString() };
      await store.append(agentId, record);
      const entry = personas.get(agentId);
      if (entry && !closed) {
        if (updatesPreview(record)) entry.lastMessage = preview(record, limits);
        else entry.lastLineAt = record.at;
        if (isReply(record)) entry.lastReplyAt = record.at;
        commitAgents();
      }
      return record;
    },

    session(id) {
      const listed = state.sessions.find((session) => session.id === id);
      if (!listed) return null;
      for (const adapter of Object.values(adapters)) {
        if (typeof adapter?.sessions === 'function' && adapter.sessions().some((session) => session.id === id)) {
          return { agent: { id }, adapter };
        }
      }
      return listed.kind === 'terminal' ? { agent: { id }, adapter: null } : null;
    },

    clientCount() {
      return listeners.size;
    },

    close() {
      closed = true;
      if (jobsTimer !== null) clearInterval(jobsTimer);
      jobsTimer = null;
      unsubscribeRegistry();
      unsubscribeBindings();
      unsubscribeSettings();
      unsubscribeRoutines();
      unsubscribeNotifications();
      for (const unsubscribe of adapterUnsubscribes.splice(0)) unsubscribe();
      for (const entry of personas.values()) {
        clearTimeout(entry.timer);
        entry.timer = null;
      }
      listeners.clear();
    },
  };
}

function personaEntry(agent, adapter) {
  return {
    agent, adapter, ready: false, state: 'unavailable', pending: null, forwarded: [], lastMessage: null,
    lastError: null, costUsd: null, lastLineAt: null, lastOwnMessageAt: null, lastReplyAt: null, timer: null,
  };
}

function registryFields(current, views) {
  return {
    registry: { ok: current?.ok === true, error: current?.error ?? null, loadedAt: current?.loadedAt ?? null },
    groups: (current?.groups ?? []).map((group) => ({ id: group.id, name: group.name })),
    agents: views(current),
  };
}

// The snapshot's `routines`: the store's routines in registry agent order
// then by name, each with its next occurrence and newest run.
function routinesView(current, store, schedule, zone, now) {
  if (!store) return { items: [] };
  const agents = current?.agents ?? [];
  const order = new Map(agents.map((agent, index) => [agent.id, index]));
  const claude = new Set(agents.filter((agent) => agent.kind === 'persona' && agent.provider === 'claude').map((agent) => agent.id));
  const items = store.current().map((routine) => {
    const cron = routine.active && claude.has(routine.agent) ? schedule.parseCron(routine.schedule.cron) : null;
    const nextAt = cron ? schedule.next(cron, now, zone) : null;
    return {
      id: routine.id,
      name: routine.name,
      agent: routine.agent,
      instruction: routine.instruction,
      schedule: { cron: routine.schedule.cron, text: routine.schedule.text },
      active: routine.active,
      created: routine.created,
      updated: routine.updated,
      nextAt: nextAt ? nextAt.toISOString() : null,
      lastRun: store.lastRun(routine.id),
    };
  });
  items.sort((a, b) => {
    const byAgent = (order.get(a.agent) ?? Infinity) - (order.get(b.agent) ?? Infinity);
    if (byAgent !== 0) return byAgent;
    if (a.agent !== b.agent) return a.agent < b.agent ? -1 : 1;
    return a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1);
  });
  return { items };
}

// Whether a routine of the agent last ended waiting on a card Hunter never
// answered, and he has not written in the thread since.
function needsYou(agentId, entry, store) {
  if (!store) return false;
  const since = entry?.lastOwnMessageAt ?? '';
  for (const routine of store.current()) {
    if (routine.agent !== agentId) continue;
    const last = store.lastRun(routine.id);
    if (last?.outcome === 'waiting' && typeof last.endedAt === 'string' && last.endedAt > since) return true;
  }
  return false;
}

// Hunter's own message in a thread: a user message neither another agent
// nor a routine sent.
function isOwnMessage(message) {
  return message?.role === 'user' && !message.from && !message.routine;
}

// Lines that count as replies. Current writers use assistant for model text;
// system/brief for the morning line; system/delegation with finished or
// failed; and system/routine with finished or failed when an ending line is
// written. Sent, waiting, model, and Hunter's own lines do not.
const END_STATES = new Set(['finished', 'failed']);
function isReply(message) {
  if (message?.role === 'assistant') return true;
  if (message?.role !== 'system') return false;
  if (message.kind === 'brief') return true;
  if (message.kind === 'delegation') return END_STATES.has(message.state);
  return message.kind === 'routine' && END_STATES.has(message.state);
}

// The snapshot's `settings`: the store's view, or the defaults when the hub
// runs without a store (tests, or a daemon built without one).
function settingsView(current) {
  const settings = current?.settings ?? SETTINGS_DEFAULTS;
  return {
    ok: current ? current.ok === true : true,
    error: current?.error ?? null,
    model: { default: settings.model?.default ?? null, effort: settings.model?.effort ?? null },
    brief: { agent: settings.brief?.agent ?? null },
    permission: { default: settings.permission?.default ?? SETTINGS_DEFAULTS.permission.default },
    quickChat: { agent: settings.quickChat?.agent ?? null },
  };
}

// The thread's own choice as the adapter holds it ({ id, effort } from
// state().model), or null for a persona that is not started or whose
// provider has no per-thread choice.
function threadChoice(entry) {
  if (!entry?.ready || !entry.adapter) return null;
  const choice = entry.adapter.state(entry.agent.id)?.model;
  return choice && typeof choice === 'object' ? { model: choice.id ?? null, effort: choice.effort ?? null } : null;
}

// What a Claude persona's next turn runs on. `thread` is the thread's own
// choice ({ model, effort }, either null) or null; the registry's `model`
// is the agent level; the settings are the system level. The id and the
// effort resolve separately, and `source` is the highest level that set
// either.
function resolveModel(agent, thread, settingsState) {
  const levels = [
    ['thread', thread?.model ?? null, thread?.effort ?? null],
    ['agent', typeof agent.model === 'string' && agent.model !== '' ? agent.model : null, typeof agent.effort === 'string' ? agent.effort : null],
    ['system', settingsState.model.default, settingsState.model.effort],
  ];
  let id = null;
  let effort = null;
  let source = 'default';
  for (const [name, levelId, levelEffort] of levels) {
    const setsId = id === null && levelId !== null;
    const setsEffort = effort === null && levelEffort !== null;
    if ((setsId || setsEffort) && source === 'default') source = name;
    if (setsId) id = levelId;
    if (setsEffort) effort = levelEffort;
  }
  return { id, effort, source };
}

// The level a Claude persona's next turn runs at: the registry's
// `permission` when set, else the settings default, which always has a
// value.
function resolvePermission(agent, settingsState) {
  if (typeof agent.permission === 'string' && agent.permission !== '') return { level: agent.permission, source: 'agent' };
  return { level: settingsState.permission.default, source: 'system' };
}

// agentId -> String(mtime ms) of the agent's picture, or null.
function avatarVersions(current) {
  const versions = {};
  for (const agent of current?.agents ?? []) {
    const found = findAvatar(agent);
    versions[agent.id] = found ? String(Math.trunc(found.mtimeMs)) : null;
  }
  return versions;
}

function agentViews(current, personas, settingsState, routines = null, reads = null, avatars = {}) {
  return (current?.agents ?? []).map((agent) => {
    const view = {
      id: agent.id,
      name: agent.name,
      role: agent.role,
      description: agent.description,
      group: agent.group,
      kind: agent.kind,
      cwd: typeof agent.cwd === 'string' ? agent.cwd : null,
      jobs: Array.isArray(agent.jobs) ? agent.jobs.length : 0,
      avatar: avatars[agent.id] ?? null,
    };
    if (agent.provider !== undefined) view.provider = agent.provider;
    if (agent.pinned === true) view.pinned = true;
    // Part of the dashboard (registry.mjs): the panel offers no Delete.
    if (agent.builtin === true) view.builtin = true;
    if (agent.kind !== 'persona') {
      view.state = null;
      return view;
    }
    const entry = personas.get(agent.id);
    view.state = entry?.state ?? 'unavailable';
    view.pending = entry?.pending ?? null;
    view.forwarded = entry ? entry.forwarded.map((item) => ({ ...item })) : [];
    view.needsYou = needsYou(agent.id, entry, routines);
    view.lastMessage = entry?.lastMessage ?? null;
    view.lastError = entry?.lastError ?? null;
    view.costUsd = entry?.costUsd ?? null;
    view.lastLineAt = entry?.lastLineAt ?? null;
    const readAt = reads?.readAt(agent.id) ?? null;
    view.unread = typeof entry?.lastReplyAt === 'string' && typeof readAt === 'string' && entry.lastReplyAt > readAt;
    if (agent.provider === 'claude') {
      const base = resolveModel(agent, null, settingsState);
      view.model = {
        ...resolveModel(agent, threadChoice(entry), settingsState),
        default: { id: base.id, effort: base.effort },
        agent: { id: typeof agent.model === 'string' && agent.model !== '' ? agent.model : null, effort: typeof agent.effort === 'string' ? agent.effort : null },
      };
      view.permission = {
        ...resolvePermission(agent, settingsState),
        agent: typeof agent.permission === 'string' && agent.permission !== '' ? agent.permission : null,
        default: settingsState.permission.default,
      };
    }
    if (agent.provider !== undefined) {
      view.accepts = Array.isArray(agent.accepts) ? [...agent.accepts] : null;
    }
    return view;
  });
}

// cmux agent_lifecycle -> a session state; anything else is 'unknown'.
const TERMINAL_STATES = new Map([['running', 'busy'], ['idle', 'idle'], ['needsInput', 'waiting']]);

// The inventory's agent records, one per sessionId: when cmux lists a
// session twice, the record with the newest updatedAt stands (a null
// updatedAt loses to any string; the first seen wins a tie).
function uniqueAgents(agents) {
  const byId = new Map();
  for (const agent of agents) {
    const seen = byId.get(agent.sessionId);
    if (!seen || (agent.updatedAt ?? '') > (seen.updatedAt ?? '')) byId.set(agent.sessionId, agent);
  }
  return [...byId.values()];
}

function sessionViews(adapters, bindings, limits, cmux, current) {
  const bound = bindings?.current() ?? new Map();
  const inventory = cmux?.current() ?? null;
  const surfaces = new Set(inventory?.available ? inventory.surfaces.map((surface) => surfaceKey(surface.workspaceId, surface.id)) : []);
  const projects = (current?.agents ?? []).filter((agent) => agent.kind === 'project' && typeof agent.cwd === 'string');
  const views = [];
  for (const adapter of Object.values(adapters)) {
    if (typeof adapter?.sessions !== 'function') continue;
    for (const session of adapter.sessions()) {
      const binding = bound.get(session.threadId);
      views.push({
        id: session.id,
        provider: adapter.kind,
        threadId: session.threadId,
        cwd: session.cwd ?? null,
        projectId: projectFor(session.cwd, projects),
        title: session.title ?? null,
        state: session.state,
        pending: projectRequest(session.pending, limits),
        lastMessage: preview(session.lastMessage, limits),
        lastError: session.lastError ?? null,
        updatedAt: session.updatedAt ?? null,
        binding: binding ? {
          workspaceId: binding.workspaceId,
          surfaceId: binding.surfaceId,
          live: surfaces.has(surfaceKey(binding.workspaceId, binding.surfaceId)),
        } : null,
      });
    }
  }
  for (const agent of uniqueAgents(inventory?.agents ?? [])) {
    if (agent.agent !== 'claude') continue;
    views.push({
      id: `claude:${agent.sessionId}`,
      provider: 'claude',
      kind: 'terminal',
      cwd: agent.cwd ?? null,
      projectId: projectFor(agent.cwd, projects),
      state: TERMINAL_STATES.get(agent.state) ?? 'unknown',
      updatedAt: agent.updatedAt ?? null,
      binding: { workspaceId: agent.workspaceId, surfaceId: agent.surfaceId, live: agent.live === true },
    });
  }
  return views.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
}

// The project whose cwd is `cwd` or a parent of it; the deepest one wins.
function projectFor(cwd, projects) {
  if (typeof cwd !== 'string') return null;
  let best = null;
  for (const project of projects) {
    const root = project.cwd.replace(/\/+$/, '');
    if (cwd !== root && !cwd.startsWith(`${root}/`)) continue;
    if (!best || root.length > best.root.length) best = { root, id: project.id };
  }
  return best?.id ?? null;
}

// Surface ids are compared without regard to case, as cmux.mjs does. A
// binding with a null id never matches.
function surfaceKey(workspaceId, surfaceId) {
  if (typeof workspaceId !== 'string' || typeof surfaceId !== 'string') return null;
  return `${workspaceId}/${surfaceId}`.toUpperCase();
}

// The cmux client's last inventory in snapshot form.
function cmuxStatus(cmux) {
  if (!cmux) return { available: false, reason: 'no_client' };
  const inventory = cmux.current();
  if (!inventory) return { available: false, reason: 'not_refreshed' };
  if (inventory.available === true) return inventory.stale === true ? { available: true, stale: true } : { available: true };
  const reason = typeof inventory.reason === 'string' && STATE_WORD.test(inventory.reason) ? inventory.reason : 'unknown';
  return { available: false, reason };
}

// The Codex adapter's connection status in snapshot form.
function codexStatus(adapters, adaptersDisabled) {
  const adapter = Object.hasOwn(adapters, 'codex') ? adapters.codex : null;
  if (!adapter) return { available: false, reason: adaptersDisabled ?? 'no_adapter' };
  const status = typeof adapter.status === 'function' ? adapter.status() : null;
  if (status?.available === true) return { available: true };
  const reason = typeof status?.reason === 'string' && STATE_WORD.test(status.reason) ? status.reason : 'unknown';
  return { available: false, reason };
}

// Whether a message becomes the snapshot's lastMessage. A bookkeeping line
// (a system message with a `kind` other than `brief`: the model line, and
// any later line the daemon writes about the thread) does not, so the row
// keeps the thread's real last message. The brief notice and the plain
// 'New thread' line do.
function updatesPreview(message) {
  return !(message?.role === 'system' && typeof message.kind === 'string' && message.kind !== 'brief');
}

// The snapshot's lastMessage: a message's summary when it carries one (a
// brief notice), else its text, cut to limits.previewChars.
function preview(message, limits) {
  if (!message || typeof message.text !== 'string') return null;
  const text = typeof message.summary === 'string' && message.summary !== '' ? message.summary : message.text;
  return {
    role: message.role,
    text: Array.from(text).slice(0, limits.previewChars).join(''),
    at: typeof message.at === 'string' ? message.at : null,
    ...(typeof message.from === 'string' && message.from !== '' ? { from: message.from } : {}),
  };
}

// The snapshot form of an open request. An approval's input JSON over
// limits.requestInputBytes is cut on a character boundary and flagged. A
// question's input is kept whole (as a copy, so the snapshot never freezes
// the adapter's object): every question and option must reach the client
// for it to be answerable.
function projectRequest(request, limits) {
  if (!request || typeof request.requestId !== 'string') return null;
  let json;
  try {
    json = JSON.stringify(request.input ?? null) ?? 'null';
  } catch {
    json = 'null';
  }
  let input = json;
  let truncated = false;
  if (request.kind === 'question') {
    input = JSON.parse(json);
  } else if (Buffer.byteLength(json, 'utf8') > limits.requestInputBytes) {
    input = truncateUtf8(json, limits.requestInputBytes).text;
    truncated = true;
  }
  const view = { requestId: request.requestId, kind: request.kind, toolName: request.toolName, input, truncated };
  if (request.native === true) view.native = true;
  return view;
}

// Resolves when `promise` settles or `signal` aborts, whichever is first.
function untilAborted(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      signal.removeEventListener('abort', done);
      resolve();
    };
    signal.addEventListener('abort', done);
    promise.then(done, done);
  });
}

// Settles as `promise` does, or resolves once `ms` has passed, whichever
// comes first; the promise itself is left running.
function settledWithin(promise, ms) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Runs task(signal) and settles within `ms`, aborting the signal on timeout.
// A synchronous throw becomes a rejection.
function bounded(task, ms) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('timeout'));
    }, ms);
  });
  const work = Promise.resolve().then(() => task(controller.signal));
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

// Copies only non-content fields from brief metadata.
function summarizeBrief(metadata) {
  if (!metadata || typeof metadata.state !== 'string' || !STATE_WORD.test(metadata.state)) {
    return { state: 'unavailable' };
  }
  const summary = { state: metadata.state };
  if (typeof metadata.date === 'string' && isCalendarDate(metadata.date)) summary.date = metadata.date;
  if (typeof metadata.revision === 'string' && REVISION.test(metadata.revision)) summary.revision = metadata.revision;
  return summary;
}

export function isCalendarDate(value) {
  const match = DATE.exec(value);
  if (!match) return false;
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

// Both sides are small objects built in a fixed key order.
function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
