// State hub: one in-memory snapshot of what the dashboard knows (Focus
// health, the latest brief, the agent registry, and routines), with a
// revision that bumps on every change and a subscriber list for the event
// stream. It owns no timers and no persistence; callers decide when to
// refresh.
//
// createHub({ registry, routines, focus, brief, timeouts, log, now }) returns:
//
//   snapshot() -> frozen
//     { revision,                 // integer, starts at 1, +1 on every change
//       updatedAt,                // ISO time of the last change
//       focus: { available },     // null until the first refreshStatus
//       brief,                    // exactly what /api/dashboard/status reports:
//                                 // { state, date?, revision? }, or
//                                 // { state: 'unknown' } before the first check
//       registry: { ok, error, loadedAt },
//       agents: [{ id, name, role, description, group, kind, provider?, model? }],
//       routines: { refreshedAt, focusAvailable, refreshing, error, items } }
//     Agents never carry cwd or routines. Each object in it is frozen.
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
//   clientCount() -> number of live subscribers
//   close()       unsubscribes from the registry and drops all subscribers.
//
// A registry change (registry.onChange) replaces `registry` and `agents`.

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const REVISION = /^[0-9a-f]{64}$/;
const STATE_WORD = /^[a-z_]{1,40}$/;

export function createHub({ registry, routines, focus, brief, timeouts, log = () => {}, now = () => new Date() }) {
  const listeners = new Set();
  let state = deepFreeze({
    revision: 1,
    updatedAt: now().toISOString(),
    focus: { available: null },
    brief: { state: 'unknown' },
    ...registryFields(registry.current()),
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

  const unsubscribeRegistry = registry.onChange((current) => commit(registryFields(current)));

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

    clientCount() {
      return listeners.size;
    },

    close() {
      unsubscribeRegistry();
      listeners.clear();
    },
  };
}

function registryFields(current) {
  return {
    registry: { ok: current?.ok === true, error: current?.error ?? null, loadedAt: current?.loadedAt ?? null },
    agents: (current?.agents ?? []).map((agent) => {
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
      return view;
    }),
  };
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
