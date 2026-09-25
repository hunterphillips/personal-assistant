// State hub: one in-memory snapshot of what the dashboard knows (Focus
// health, the latest brief, the agent registry, persona state, and
// routines), with a revision that bumps on every change and a subscriber
// list for the event stream. It owns no persistence and no refresh timers;
// callers decide when to refresh. Its only timers are the persona turn wall
// clocks.
//
// createHub({ registry, routines, focus, brief, timeouts, limits, adapters,
//             store, adaptersDisabled, log, now }) returns:
//
//   snapshot() -> frozen
//     { revision,                 // integer, starts at 1, +1 on every change
//       updatedAt,                // ISO time of the last change
//       focus: { available },     // null until the first refreshStatus
//       brief,                    // exactly what /api/dashboard/status reports:
//                                 // { state, date?, revision? }, or
//                                 // { state: 'unknown' } before the first check
//       registry: { ok, error, loadedAt },
//       agents: [{ id, name, role, description, group, kind, provider?, model?,
//                  state, pending?, lastMessage?, lastError?, costUsd? }],
//       routines: { refreshedAt, focusAvailable, refreshing, error, items } }
//     Agents never carry cwd or routines. Each object in it is frozen.
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
//       lastError    null or a string
//       costUsd      null or the session's running total
//
//   refreshStatus({ signal }) -> Promise<void>
//     Focus health (focus.checkHealth) and the latest brief
//     (brief.latestMetadata) in parallel, each bounded by timeouts.statusMs
//     with its own aborted signal on timeout. Single-flight: callers during a
//     run share it. Bumps only when `focus` or `brief` changed. `signal` only
//     stops that caller waiting; the shared run is not aborted. Never rejects.
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
//     routines), never revision or updatedAt. A throwing listener is logged
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
//     'sdk_unavailable' when the rejection carries that code, else
//     'start_failed' (either logged as persona_start_error with the bounded
//     error message). Never rejects.
//     Adapter events then update the entry: thread.state -> state (and
//     lastError and costUsd from adapter.state, which the adapter clears
//     without an event); message -> lastMessage; request -> pending;
//     resolved -> pending null; usage -> costUsd; error -> lastError.
//
//   persona(id) -> { agent, adapter } | null
//     The registry agent (with cwd) and its adapter, for a started persona.
//
//   clientCount() -> number of live subscribers
//   close()       unsubscribes from the registry and the adapters, clears the
//                 turn timers, and drops all subscribers. It does not close
//                 the adapters; the server does that first.
//
// A registry change (registry.onChange) replaces `registry` and `agents`;
// after start(), newly listed personas are started and removed ones dropped,
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

import { LIMITS, TIMEOUTS } from './config.mjs';
import { truncateUtf8 } from './threads.mjs';

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const REVISION = /^[0-9a-f]{64}$/;
const STATE_WORD = /^[a-z_]{1,40}$/;

export function createHub({
  registry, routines, focus, brief, timeouts, limits = LIMITS, adapters = {}, store = null,
  adaptersDisabled = null, log = () => {}, now = () => new Date(),
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
    focus: { available: null },
    brief: { state: 'unknown' },
    ...registryFields(registry.current(), personas),
    routines: { refreshedAt: null, focusAvailable: null, refreshing: false, error: null, items: [] },
  });
  let statusRun = null;
  let routinesRun = null;

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
      const reason = error?.code === 'sdk_unavailable' ? 'sdk_unavailable' : 'start_failed';
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
    const entry = personas.get(event?.agentId);
    if (closed || !entry || !entry.ready || entry.adapter !== adapter) return;
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

  const unsubscribeRegistry = registry.onChange((current) => {
    if (started && !closed) {
      syncPersonas(current?.agents ?? []).then(() => {
        if (!closed) commitAgents();
      });
    }
    commit(registryFields(current, personas));
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
      if (!closed) commitAgents();
    },

    persona(id) {
      const entry = personas.get(id);
      if (!entry || !entry.ready || !entry.adapter) return null;
      return { agent: entry.agent, adapter: entry.adapter };
    },

    clientCount() {
      return listeners.size;
    },

    close() {
      closed = true;
      unsubscribeRegistry();
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
    };
    if (agent.provider !== undefined) view.provider = agent.provider;
    if (agent.model !== undefined) view.model = agent.model;
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

function preview(message, limits) {
  if (!message || typeof message.text !== 'string') return null;
  return {
    role: message.role,
    text: Array.from(message.text).slice(0, limits.previewChars).join(''),
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
  return { requestId: request.requestId, kind: request.kind, toolName: request.toolName, input, truncated };
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
