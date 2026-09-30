// State hub: one in-memory snapshot of what the dashboard knows (Focus
// health, the latest brief, the agent registry, persona state, coding
// sessions and the cmux terminals behind them, and routines), with a
// revision that bumps on every change and a subscriber list for the event
// stream. It owns no persistence and no refresh timers; callers decide when
// to refresh. Its only timers are the persona turn wall clocks.
//
// createHub({ registry, routines, focus, brief, timeouts, limits, adapters,
//             store, bindings, cmux, adaptersDisabled, home, log, now }) returns:
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
//       agents: [{ id, name, role, description, group, kind, cwd, jobs,
//                  provider?, model?, pinned?, state, pending?, lastMessage?,
//                  lastError?, costUsd? }],
//       sessions: [{ id, provider, threadId, cwd, projectId, title, state,
//                    pending, lastMessage, lastError, updatedAt, binding }
//                  | { id, provider: 'claude', kind: 'terminal', cwd, projectId,
//                      state, updatedAt, binding }],
//       codex: { available } | { available: false, reason },
//       cmux: { available, stale? } | { available: false, reason },
//       routines: { refreshedAt, focusAvailable, refreshing, error, items } }
//     An agent's cwd is the registry's, or null, and jobs is how many
//     launchd labels its registry routines name; agents never carry the
//     routines themselves. Each object in it is frozen.
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
//       lastMessage  null or { role, text, at }, text cut to limits.previewChars
//                    (a message's `summary` stands in for its text when present)
//       lastError    null or a string
//       costUsd      null or the session's running total
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
//   refreshRoutines({ signal }) -> Promise<void>
//     Single-flight. Sets routines.refreshing (bump), awaits
//     routines.refresh({ signal }) with the first caller's signal, then
//     stores the result with refreshing false and error null (bump). If the
//     refresh throws, refreshing is false and error 'refresh_failed' (bump),
//     logged as { event: 'routines_error', error }. Never rejects.
//
//   subscribe(fn) -> unsubscribe
//     fn({ revision, patch }) runs after every bump; `patch` holds only the
//     top-level content keys that changed (focus, brief, registry, agents,
//     sessions, codex, cmux, routines), never revision or updatedAt. A throwing listener is logged
//     as { event: 'hub_listener_error', error } and the rest still run.
//
//   start() -> Promise<void>
//     For each registry persona whose provider has an adapter in `adapters`,
//     awaits adapter.start(agent) and seeds state, pending, lastError, and
//     costUsd from adapter.state(id), and lastMessage from the last message
//     in store.read(id). Until then a persona is 'unavailable' with
//     lastError null. A persona with no adapter for its provider stays
//     'unavailable' with lastError `adaptersDisabled` when given, else
//     'provider_unavailable'; one whose start rejects is 'unavailable' with
//     'sdk_unavailable' when the rejection carries that code,
//     'provider_unavailable' for 'not_supported' (the adapter runs no
//     personas, as Codex's does), else 'start_failed' (either logged as persona_start_error with the bounded
//     error message). Never rejects.
//     Adapter events then update the entry: thread.state -> state (and
//     lastError and costUsd from adapter.state, which the adapter clears
//     without an event); message -> lastMessage; request -> pending;
//     resolved -> pending null; usage -> costUsd; error -> lastError.
//
//   persona(id) -> { agent, adapter } | null
//     The registry agent (with cwd) and its adapter, for a started persona.
//
//   notify(agentId, message) -> Promise<message>
//     Appends `message` ({ role, text, ...fields }, `at` defaulting to now)
//     to the agent's thread through the store, so the daemon stays the
//     thread's only writer, then sets the persona's lastMessage from it
//     (`summary` over `text` when the message carries one) and commits.
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
// stopped. The timer is cleared when the persona goes idle or error.

import os from 'node:os';

import { LIMITS, TIMEOUTS } from './config.mjs';
import { truncateUtf8 } from './threads.mjs';

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const REVISION = /^[0-9a-f]{64}$/;
const STATE_WORD = /^[a-z_]{1,40}$/;

export function createHub({
  registry, routines, focus, brief, timeouts, limits = LIMITS, adapters = {}, store = null, bindings = null, cmux = null,
  adaptersDisabled = null, home = os.homedir(), log = () => {}, now = () => new Date(),
}) {
  const listeners = new Set();
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
    ...registryFields(registry.current(), personas),
    sessions: [],
    codex: codexStatus(adapters, adaptersDisabled),
    cmux: cmuxStatus(cmux),
    routines: { refreshedAt: null, focusAvailable: null, refreshing: false, error: null, items: [] },
  });
  let statusRun = null;
  let routinesRun = null;
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
    const agents = agentViews(registry.current(), personas);
    if (!sameJson(agents, state.agents)) commit({ agents });
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
    const lastMessage = await lastCachedMessage(agent.id);
    if (closed || personas.get(agent.id) !== entry) return;
    const seeded = adapter.state(agent.id);
    entry.ready = true;
    entry.state = seeded.state;
    entry.pending = projectRequest(seeded.pending, limits);
    entry.lastError = seeded.lastError ?? null;
    entry.costUsd = seeded.costUsd ?? null;
    entry.lastMessage ??= lastMessage;
    if (entry.state === 'busy' || entry.state === 'waiting') armTurnTimer(entry);
  }

  async function lastCachedMessage(agentId) {
    if (!store) return null;
    try {
      const messages = await store.read(agentId);
      const last = messages.at(-1);
      return last ? preview(last, limits) : null;
    } catch (error) {
      log({ event: 'thread_cache_error', agentId, error: error?.message ?? String(error) });
      return null;
    }
  }

  function armTurnTimer(entry) {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      entry.timer = null;
      log({ event: 'persona_turn_timeout', agentId: entry.agent.id });
      entry.adapter.interrupt(entry.agent).then(() => {
        if (closed || personas.get(entry.agent.id) !== entry) return;
        entry.lastError = 'turn_timeout';
        commitAgents();
      }, (error) => {
        log({ event: 'persona_interrupt_error', agentId: entry.agent.id, error: error?.message ?? String(error) });
      });
    }, turnMaxMs);
    entry.timer.unref?.();
  }

  function onAdapterEvent(adapter, event) {
    if (closed) return;
    const entry = personas.get(event?.agentId);
    if (!entry) {
      if (typeof adapter.sessions === 'function') commitSessions();
      return;
    }
    if (!entry.ready || entry.adapter !== adapter) return;
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
        break;
      }
      case 'message':
        entry.lastMessage = preview(event, limits);
        break;
      case 'request':
        entry.pending = projectRequest(event, limits);
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
      syncPersonas(current?.agents ?? []).then(() => {
        if (!closed) commitAgents();
      });
    }
    commit(registryFields(current, personas));
    if (started && !closed) commitSessions();
  });

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

  async function runRoutines(signal) {
    commit({ routines: { ...state.routines, refreshing: true } });
    try {
      const result = await routines.refresh({ signal });
      commit({
        routines: {
          refreshedAt: result?.refreshedAt ?? null,
          focusAvailable: typeof result?.focusAvailable === 'boolean' ? result.focusAvailable : null,
          refreshing: false,
          error: null,
          items: Array.isArray(result?.routines) ? result.routines : [],
        },
      });
    } catch (error) {
      log({ event: 'routines_error', error: error?.message ?? String(error) });
      commit({ routines: { ...state.routines, refreshing: false, error: 'refresh_failed' } });
    }
  }

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

    refreshRoutines({ signal } = {}) {
      routinesRun ??= runRoutines(signal).finally(() => {
        routinesRun = null;
      });
      return routinesRun;
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

    persona(id) {
      const entry = personas.get(id);
      if (!entry || !entry.ready || !entry.adapter) return null;
      return { agent: entry.agent, adapter: entry.adapter };
    },

    async notify(agentId, message) {
      if (!store) throw new Error('no_store');
      const record = { ...message, at: typeof message?.at === 'string' ? message.at : now().toISOString() };
      await store.append(agentId, record);
      const entry = personas.get(agentId);
      if (entry && !closed) {
        entry.lastMessage = preview(record, limits);
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
      unsubscribeRegistry();
      unsubscribeBindings();
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
    agent, adapter, ready: false, state: 'unavailable', pending: null, lastMessage: null,
    lastError: null, costUsd: null, timer: null,
  };
}

function registryFields(current, personas) {
  return {
    registry: { ok: current?.ok === true, error: current?.error ?? null, loadedAt: current?.loadedAt ?? null },
    groups: (current?.groups ?? []).map((group) => ({ id: group.id, name: group.name })),
    agents: agentViews(current, personas),
  };
}

function agentViews(current, personas) {
  return (current?.agents ?? []).map((agent) => {
    const view = {
      id: agent.id,
      name: agent.name,
      role: agent.role,
      description: agent.description,
      group: agent.group,
      kind: agent.kind,
      cwd: typeof agent.cwd === 'string' ? agent.cwd : null,
      jobs: Array.isArray(agent.routines) ? agent.routines.length : 0,
    };
    if (agent.provider !== undefined) view.provider = agent.provider;
    if (agent.model !== undefined) view.model = agent.model;
    if (agent.pinned === true) view.pinned = true;
    if (agent.kind !== 'persona') {
      view.state = null;
      return view;
    }
    const entry = personas.get(agent.id);
    view.state = entry?.state ?? 'unavailable';
    view.pending = entry?.pending ?? null;
    view.lastMessage = entry?.lastMessage ?? null;
    view.lastError = entry?.lastError ?? null;
    view.costUsd = entry?.costUsd ?? null;
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

// The snapshot's lastMessage: a message's summary when it carries one (a
// brief notice), else its text, cut to limits.previewChars.
function preview(message, limits) {
  if (!message || typeof message.text !== 'string') return null;
  const text = typeof message.summary === 'string' && message.summary !== '' ? message.summary : message.text;
  return {
    role: message.role,
    text: Array.from(text).slice(0, limits.previewChars).join(''),
    at: typeof message.at === 'string' ? message.at : null,
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
