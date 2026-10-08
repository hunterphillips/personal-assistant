// The scheduler: runs routines (routines.mjs) on their schedules
// (schedule.mjs), catches up what was missed while the daemon was down,
// and writes each run's outcome to the routine's runs log. A run is a send
// with `routine`, which the adapter runs detached (runtime/adapter.mjs): a
// session of its own, at the agent's own permission level, on the model and
// effort the hub resolves for it, that leaves nothing in the agent's
// thread. The prompt the model gets is
//   Routine "<name>" (a scheduled run, not the user): <instruction>
//
//   <context, when the run was given one>
//
//   You may ask other agents. Your reply is recorded in this routine's log,
//   not shown as a message; if something in it needs Hunter's attention,
//   use notify.
// The reply lands on the run's end line. The one thing a run may append to
// the thread is the waiting line below, where its card gets answered.
//
// createScheduler({ routines, hub, schedule, zone, timeouts, limits, log,
//                   now, setTimeout, clearTimeout, randomUUID })
// returns:
//
//   start() -> Promise<void>
//     Closes every run the log still shows open (a start line without an
//     end) with { run, endedAt, outcome: 'interrupted' }, since its turn
//     died with the last process; runs one tick; then arms an unref'd
//     timer of timeouts.routineTickMs between ticks.
//   stop()
//     Clears the timer and detaches every in-flight run, so a turn the
//     shutdown then aborts leaves its start line open for the next start().
//   tick() -> Promise<void>
//     Single-flight. For every active routine whose agent is a Claude
//     persona in the registry: marker = the newest of the log's marker
//     (routines.marker), the routine's `updated`, and now minus
//     limits.routineCatchupDays; latest = schedule.previous(cron, now).
//     Nothing when latest is null or not after the marker. Otherwise the
//     occurrences strictly between them, up to limits.routineMissedMax,
//     are one line { outcome: 'missed', count, from, to, capped? }, and
//     latest is run with trigger 'schedule' when it is under two ticks old,
//     else 'catchup'. The line a run leaves carries the occurrence, so a
//     busy or failed fire still moves the marker; an inactive routine is
//     skipped without a line; an edit or a reactivation bumps `updated`,
//     so nothing from before it is due.
//   run(id, occurrence, trigger, { context }?) -> Promise<{ ok: true, run } | { ok: false, reason }>
//     Resolves once the turn has started or been refused, never when it
//     ends; `run` is the id its log lines share. With no started persona for the agent (hub.persona null) the
//     reason is 'agent_unavailable'; with the agent busy or waiting, or the
//     send refused, 'busy'; an unknown id is 'no_such_routine'. A
//     scheduled or catch-up refusal writes its line ({ occurrence,
//     trigger, outcome: 'busy' } or { ..., outcome: 'failed', detail });
//     a test run writes none. An accepted run writes
//     { run, occurrence, trigger, startedAt, context? }, follows the agent's adapter
//     from before the send for every `request` and `resolved` event whose
//     agentId is the agent or whose chain starts with it (a hop's card,
//     which the hub forwards to this thread), and posts one line to the
//     agent's thread on the first request through hub.notify:
//     { role: 'system', kind: 'routine', state: 'waiting', routine,
//       agent: <whose card>, toolName, summary: '<Agent> is waiting for
//       you during <name>.', text: <the input's first 120 characters> }.
//     When the turn ends, the end line { run, endedAt, outcome, reply?,
//     truncated?, detail?, cards? }: outcome is 'waiting' when any card was
//     raised and not answered (resolved expired or interrupted, or not
//     resolved), else 'interrupted' when the send resolved `aborted`, else
//     'failed' when it rejected, resolved an `error`, or the agent's
//     adapter emitted an error, else 'finished'. `reply` is the resolved
//     text cut to limits.routineReplyChars (with `truncated: true` when
//     cut), omitted when empty; `detail` is the error on 'failed' and
//     'interrupted' on 'interrupted'; cards as
//     [{ agent, kind, toolName, summary, resolved }]. Each run is logged
//     routine_run { routineId, agentId, trigger, outcome, ms }, and
//     hub.runEnded(id) follows every line.
//   testRun(id, { context }?) -> Promise<{ ok: true, run } | { ok: false, reason }>
//     run(id, null, 'test', { context }): a run outside the schedule whose line has
//     occurrence null, so it never moves the marker.
//
// Log lines: routine_run, routine_tick_error (a tick that threw),
// routine_log_error (a run line the store refused), and
// routine_line_error (a thread line the store refused). None carries the
// instruction, the prompt, or a tool input.

import { randomUUID as nodeRandomUUID } from 'node:crypto';

import { LIMITS, TIME_ZONE, TIMEOUTS } from './config.mjs';
import * as defaultSchedule from './schedule.mjs';

const ACCEPTED = Symbol('accepted');
const SUMMARY_CHARS = 120;
const UNANSWERED = new Set([null, 'expired', 'interrupted']);

export function createScheduler({
  routines, hub, schedule = defaultSchedule, zone = TIME_ZONE, timeouts = TIMEOUTS, limits = LIMITS, log = () => {},
  now = () => new Date(), setTimeout: setTimer = globalThis.setTimeout, clearTimeout: clearTimer = globalThis.clearTimeout,
  randomUUID = nodeRandomUUID,
}) {
  let started = false;
  let stopped = false;
  let timer = null;
  let ticking = null;
  const inFlight = new Set();

  async function append(id, line) {
    try {
      await routines.appendRun(id, line);
    } catch (error) {
      log({ event: 'routine_log_error', routineId: id, error: error?.code ?? error?.message ?? String(error) });
      return false;
    }
    hub.runEnded(id);
    return true;
  }

  function arm() {
    if (stopped) return;
    timer = setTimer(() => {
      timer = null;
      tick().finally(arm);
    }, timeouts.routineTickMs);
    timer?.unref?.();
  }

  function claudePersona(agentId) {
    return hub.snapshot().agents.find((agent) => agent.id === agentId && agent.kind === 'persona' && agent.provider === 'claude') ?? null;
  }

  function markerFor(routine, at) {
    const candidates = [routines.marker(routine.id), routine.updated, new Date(at.getTime() - limits.routineCatchupDays * 86_400_000).toISOString()];
    return new Date(Math.max(...candidates.filter((value) => typeof value === 'string').map((value) => Date.parse(value))));
  }

  async function runTick() {
    if (stopped) return;
    const at = now();
    for (const routine of routines.current()) {
      if (stopped) return;
      if (!routine.active || !claudePersona(routine.agent)) continue;
      const cron = schedule.parseCron(routine.schedule.cron);
      if (!cron) continue;
      const marker = markerFor(routine, at);
      const latest = schedule.previous(cron, at, zone);
      if (!latest || latest.getTime() <= marker.getTime()) continue;
      const missed = schedule.count(cron, marker, new Date(latest.getTime() - 1), zone, limits.routineMissedMax);
      if (missed > 0) {
        await append(routine.id, {
          outcome: 'missed', count: missed, from: marker.toISOString(), to: latest.toISOString(),
          ...(missed >= limits.routineMissedMax ? { capped: true } : {}),
        });
      }
      const trigger = at.getTime() - latest.getTime() < 2 * timeouts.routineTickMs ? 'schedule' : 'catchup';
      await run(routine.id, latest, trigger);
    }
  }

  function tick() {
    if (ticking) return ticking;
    ticking = runTick()
      .catch((error) => log({ event: 'routine_tick_error', error: error?.message ?? String(error) }))
      .finally(() => { ticking = null; });
    return ticking;
  }

  function detach(context) {
    context.detached = true;
    context.unsubscribe?.();
    inFlight.delete(context);
  }

  function onEvent(context, event) {
    if (context.detached) return;
    const owner = context.routine.agent;
    const mine = event?.agentId === owner || (Array.isArray(event?.chain) && event.chain[0] === owner);
    if (!mine) return;
    switch (event.type) {
      case 'request': {
        const card = {
          requestId: event.requestId, agent: event.agentId, kind: event.kind, toolName: event.toolName,
          summary: summarize(event.kind, event.input), resolved: null,
        };
        context.cards.push(card);
        if (!context.linePosted) {
          context.linePosted = true;
          postLine(context, card);
        }
        break;
      }
      case 'resolved': {
        const card = context.cards.find((item) => item.requestId === event.requestId);
        if (card) card.resolved = typeof event.outcome === 'string' ? event.outcome : null;
        break;
      }
      case 'error':
        if (event.agentId === owner) context.errorSeen = true;
        break;
      default:
    }
  }

  function postLine(context, card) {
    const { routine } = context;
    const name = hub.snapshot().agents.find((agent) => agent.id === card.agent)?.name ?? card.agent;
    hub.notify(routine.agent, {
      role: 'system', kind: 'routine', state: 'waiting', routine: { id: routine.id, name: routine.name },
      agent: card.agent, toolName: card.toolName, summary: `${name} is waiting for you during ${routine.name}.`, text: card.summary,
    }).catch((error) => log({ event: 'routine_line_error', routineId: routine.id, error: error?.message ?? String(error) }));
  }

  async function settle(context, rejected, ended = null) {
    if (context.detached) return;
    detach(context);
    const waiting = context.cards.some((card) => UNANSWERED.has(card.resolved));
    const failed = rejected || Boolean(ended?.error) || context.errorSeen;
    const outcome = waiting ? 'waiting' : ended?.aborted ? 'interrupted' : failed ? 'failed' : 'finished';
    const text = typeof ended?.text === 'string' ? ended.text : '';
    const reply = Array.from(text).slice(0, limits.routineReplyChars).join('');
    const detail = outcome === 'failed' && typeof ended?.error === 'string' ? ended.error : outcome === 'interrupted' ? 'interrupted' : null;
    const endedAt = now();
    await context.started;
    await append(context.routine.id, {
      run: context.run, endedAt: endedAt.toISOString(), outcome,
      ...(reply !== '' ? { reply } : {}),
      ...(reply.length < text.length ? { truncated: true } : {}),
      ...(detail ? { detail } : {}),
      ...(context.cards.length > 0 ? { cards: context.cards.map(({ requestId, ...card }) => card) } : {}),
    });
    log({ event: 'routine_run', routineId: context.routine.id, agentId: context.routine.agent, trigger: context.trigger, outcome, ms: endedAt.getTime() - context.startedAt.getTime() });
  }

  async function refuse(routine, base, test, reason) {
    if (!test) {
      await append(routine.id, reason === 'busy' ? { ...base, outcome: 'busy' } : { ...base, outcome: 'failed', detail: reason });
      log({ event: 'routine_run', routineId: routine.id, agentId: routine.agent, trigger: base.trigger, outcome: reason === 'busy' ? 'busy' : 'failed', ms: 0 });
    }
    return { ok: false, reason };
  }

  async function run(id, occurrence, trigger, { context: extra = null } = {}) {
    const routine = routines.current().find((item) => item.id === id);
    if (!routine) return { ok: false, reason: 'no_such_routine' };
    const test = trigger === 'test';
    const base = { occurrence: occurrence ? occurrence.toISOString() : null, trigger };
    const persona = hub.persona(routine.agent);
    if (!persona) return refuse(routine, base, test, 'agent_unavailable');
    const view = hub.snapshot().agents.find((agent) => agent.id === routine.agent);
    if (view?.state === 'busy' || view?.state === 'waiting') return refuse(routine, base, test, 'busy');

    const context = {
      routine, trigger, run: randomUUID(), startedAt: now(), cards: [], errorSeen: false, linePosted: false,
      detached: false, unsubscribe: null, started: null,
    };
    context.unsubscribe = persona.adapter.subscribe((event) => onEvent(context, event));
    inFlight.add(context);
    const { id: model, effort } = hub.modelFor(routine.agent);
    const turn = persona.adapter.send(persona.agent, routine.instruction, {
      model, effort, permission: hub.permissionFor(routine.agent), routine: { id: routine.id, name: routine.name }, prompt: promptFor(routine, extra),
    });
    turn.catch(() => {});
    try {
      await Promise.race([turn, Promise.resolve(ACCEPTED)]);
    } catch (error) {
      detach(context);
      return refuse(routine, base, test, error?.code === 'busy' ? 'busy' : (error?.code ?? 'send_failed'));
    }
    context.started = append(id, { run: context.run, ...base, startedAt: context.startedAt.toISOString(), ...(extra ? { context: extra } : {}) });
    turn.then((ended) => settle(context, false, ended), () => settle(context, true));
    return { ok: true, run: context.run };
  }

  return {
    async start() {
      if (started) return;
      started = true;
      for (const open of routines.openRuns()) {
        await append(open.id, { run: open.run, endedAt: now().toISOString(), outcome: 'interrupted' });
      }
      await tick();
      arm();
    },

    stop() {
      stopped = true;
      if (timer) clearTimer(timer);
      timer = null;
      for (const context of [...inFlight]) detach(context);
    },

    tick,
    run,
    testRun(id, options = {}) {
      return run(id, null, 'test', options);
    },
  };
}

// The run's prompt; a context goes after the instruction, before the
// standing paragraph.
export function promptFor(routine, context = null) {
  return `Routine "${routine.name}" (a scheduled run, not the user): ${routine.instruction}\n\n`
    + (context ? `${context}\n\n` : '')
    + 'You may ask other agents. Your reply is recorded in this routine\'s log, not shown as a message; if something in it needs Hunter\'s attention, use notify.';
}

// A card's input in at most SUMMARY_CHARS characters: a question's first
// question, an approval's input as JSON text.
function summarize(kind, input) {
  let text;
  if (kind === 'question') {
    const first = Array.isArray(input?.questions) ? input.questions[0] : null;
    text = typeof first?.question === 'string' ? first.question : JSON.stringify(input ?? null);
  } else {
    text = typeof input === 'string' ? input : JSON.stringify(input ?? null);
  }
  return text.length > SUMMARY_CHARS ? text.slice(0, SUMMARY_CHARS) : text;
}
