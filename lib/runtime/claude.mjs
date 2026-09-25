// Claude runtime adapter: runs persona threads through the Claude Agent SDK.
// A persona is one long-lived SDK session whose cwd is the agent's repo; each
// send() is one query() that resumes it. Routes and the hub sit above this
// module; it owns only in-memory turn state and the thread files (threads.mjs).
// The contract it implements, including the rule that refusals are decided
// before the first await, is in adapter.mjs.
//
// createClaudeAdapter({ query, store, config, log, now }) returns:
//
//   kind: 'claude'
//   start(agent) -> Promise<{ threadId }>
//     threadId is agent.id. Loads the session pointer into memory; never
//     calls the SDK. Rejects if the pointer file cannot be read.
//   send(agent, text) -> Promise<void>
//     Starts one turn. Refusals reject with a RuntimeError whose code is
//     'busy' (a turn or New thread is in flight; decided synchronously, before
//     any await, so two sends can never both reach query() and fork the
//     session), 'shutting_down' (close() has begun), 'invalid_agent', or
//     'invalid_text'. Once accepted, the promise resolves when the turn ends
//     and never rejects; failures arrive as `error` events.
//   answer(agent, requestId, answer) -> Promise<void>
//     question: { answers: { [question text]: 'Label' | ['A', 'B'] } } (arrays
//               are joined with ", "); { decision: 'deny' } declines it.
//     approval: { decision: 'allow' | 'deny' }.
//     Rejects 'no_such_request' for an unknown or already resolved id and
//     'invalid_answer' for anything else.
//   interrupt(agent) -> Promise<void>
//     Aborts the turn in flight and waits for it to end; a no-op when idle.
//   newThread(agent) -> Promise<void>
//     Rejects 'busy' while a turn is in flight, 'shutting_down' once close()
//     has begun (so a drain never loses the pointer), and
//     'thread_reset_failed' (a RuntimeError whose cause is the fs error) if
//     the pointer or cache cannot be cleared. Otherwise clears both, then emits thread.state idle
//     and a system message 'New thread' (also written to the fresh cache).
//     The idle emission is a boundary marker: it is sent even when the
//     state was already idle, so views can reset the thread.
//   state(agentId) -> { state, pending, lastError, sessionId, costUsd }
//     state: 'idle' | 'busy' | 'waiting' | 'error'; pending is the oldest
//     open request ({ requestId, kind, toolName, input, at }) or null;
//     costUsd is the last total_cost_usd seen, a running session total.
//   subscribe(fn) -> unsubscribe
//   close() -> Promise<void>
//     Refuses new sends and aborts at once any turn waiting on an answer
//     (its request resolves 'interrupted'), as well as any turn that raises
//     a request during the drain. Waits up to config.timeouts.drainMs for
//     busy turns, then aborts the rest and waits at most
//     config.timeouts.abortGraceMs for them to end.
//
// Events, each { type, agentId, at, ... }:
//   thread.state { state }                  on every change
//   message      { role, text, truncated? } user text on send, assistant text
//                                           per top-level assistant message
//                                           (subagent messages are skipped);
//                                           text is bounded to
//                                           limits.messageTextBytes
//   request      { requestId, kind: 'question' | 'approval', toolName, input }
//   resolved     { requestId, outcome: 'answered' | 'allowed' | 'denied' |
//                  'expired' | 'interrupted' }
//   usage        { usage, costUsd, denials } from the result message
//   error        { message }
// A listener that throws is logged as { event: 'runtime_listener_error' }
// and the rest still run.
//
// Turn rules. Every query() passes cwd, the stored session id as resume,
// permissionMode 'default' (so a global mode such as auto never applies),
// maxTurns from limits.turnMaxTurns, the turn's AbortController, the agent's
// model when set, and canUseTool on every turn (without it the SDK drops
// AskUserQuestion). The init message's session id is written to the pointer
// when it differs from the one held, and so is the result's, but only after
// init has been seen. canUseTool turns AskUserQuestion into a
// question and every other tool into an approval, and waits for answer(),
// for timeouts.requestMaxAgeMs (denied, outcome 'expired'), or for the turn
// to be aborted (denied, outcome 'interrupted'). The thread stays busy until
// the SDK stream ends, since the model continues after a denial. A stream
// error, or a result with is_error, ends the turn in state 'error'; the next
// send starts over. If the stream fails before init while resuming, the
// error is RESUME_FAILED (logged as thread_resume_failed); the pointer is
// kept, and New thread is the way out. An init whose apiKeySource is a
// string other than 'none' aborts the turn at once and ends it in 'error'
// (logged as persona_api_key_refused), so a persona never bills an API key.
// An interrupted or shut-down turn ends 'idle' with no error event, even if
// the SDK reports a failure while it winds down. Tools the repo's or the
// user's allow rules cover, reads, and the Skill tool never reach
// canUseTool, so they run without a card.

import { randomUUID } from 'node:crypto';

import { TIMEOUTS } from '../config.mjs';
import { AGENT_ID } from '../registry.mjs';
import { truncateUtf8 } from '../threads.mjs';
import { RuntimeError } from './adapter.mjs';

const ERROR_TEXT_MAX = 500;
const DENIED = 'Denied from the dashboard';
const INTERRUPTED = 'Interrupted from the dashboard';
const RESUME_FAILED = 'The stored session could not be resumed. Start a new thread.';

// The SDK is loaded on first use so tests with an injected query never load it.
async function* sdkQuery(args) {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  yield* query(args);
}

export function createClaudeAdapter({ query = sdkQuery, store, config, log = () => {}, now = () => new Date() }) {
  const { limits, timeouts } = config;
  const abortGraceMs = timeouts.abortGraceMs ?? TIMEOUTS.abortGraceMs;
  const entries = new Map();
  const listeners = new Set();
  let closing = false;

  function entryFor(agentId) {
    let entry = entries.get(agentId);
    if (!entry) {
      entry = {
        agentId,
        state: 'idle',
        sessionId: null,
        loaded: false,
        costUsd: null,
        lastError: null,
        turn: null,
        resetting: false,
        pending: new Map(),
      };
      entries.set(agentId, entry);
    }
    return entry;
  }

  function emit(type, agentId, fields = {}) {
    const event = { type, agentId, at: now().toISOString(), ...fields };
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch (error) {
        log({ event: 'runtime_listener_error', error: error?.message ?? String(error) });
      }
    }
  }

  function setState(entry, state) {
    if (entry.state === state) return;
    entry.state = state;
    emit('thread.state', entry.agentId, { state });
  }

  async function loadPointer(entry) {
    const pointer = await store.readPointer(entry.agentId);
    entry.sessionId = pointer?.sessionId ?? null;
    entry.loaded = true;
  }

  async function adoptSession(entry, sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '' || sessionId === entry.sessionId) return;
    entry.sessionId = sessionId;
    try {
      await store.writePointer(entry.agentId, { sessionId, createdAt: now().toISOString() });
    } catch (error) {
      log({ event: 'thread_pointer_error', agentId: entry.agentId, error: error?.message ?? String(error) });
    }
  }

  // Emits a message and appends it to the cache; the cache is display only,
  // so a failed append is logged and the turn goes on.
  async function record(entry, role, text) {
    const bounded = truncateUtf8(text, limits.messageTextBytes);
    const at = now().toISOString();
    const message = { role, text: bounded.text, at, ...(bounded.truncated ? { truncated: true } : {}) };
    emit('message', entry.agentId, message);
    try {
      await store.append(entry.agentId, message);
    } catch (error) {
      log({ event: 'thread_cache_error', agentId: entry.agentId, error: error?.message ?? String(error) });
    }
  }

  // Returns a failure description when the message ends the turn in error.
  async function handleMessage(entry, turn, message) {
    if (message?.type === 'system' && message.subtype === 'init') {
      turn.initSeen = true;
      log({
        event: 'persona_init',
        agentId: entry.agentId,
        apiKeySource: message.apiKeySource ?? null,
        permissionMode: message.permissionMode ?? null,
        model: message.model ?? null,
      });
      const source = message.apiKeySource;
      if (typeof source === 'string' && source !== 'none') {
        turn.refusal = bound(`Refused: this turn would bill an API key (${source}).`);
        log({ event: 'persona_api_key_refused', agentId: entry.agentId, source });
        abortTurn(turn);
        return null;
      }
      await adoptSession(entry, message.session_id);
    } else if (message?.type === 'assistant') {
      if (message.parent_tool_use_id) return null;
      const content = Array.isArray(message.message?.content) ? message.message.content : [];
      const text = content
        .filter((block) => block?.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n\n');
      if (text.trim()) await record(entry, 'assistant', text);
    } else if (message?.type === 'result') {
      // A result before init (a startup failure) must not replace a good pointer.
      if (turn.initSeen) await adoptSession(entry, message.session_id);
      if (typeof message.total_cost_usd === 'number') entry.costUsd = message.total_cost_usd;
      const denials = Array.isArray(message.permission_denials) ? message.permission_denials : [];
      emit('usage', entry.agentId, { usage: message.usage ?? null, costUsd: entry.costUsd, denials });
      log({
        event: 'persona_usage',
        agentId: entry.agentId,
        subtype: message.subtype ?? null,
        numTurns: message.num_turns ?? null,
        costUsd: entry.costUsd,
        denials: denials.length,
      });
      if (message.is_error || message.subtype !== 'success') {
        const errors = Array.isArray(message.errors) ? message.errors.filter((item) => typeof item === 'string') : [];
        return bound(errors.length > 0 ? errors.join('; ') : `Turn ended: ${message.subtype ?? 'error'}`);
      }
    }
    return null;
  }

  function makeCanUseTool(entry, turn) {
    return (toolName, input, options) => {
      if (closing && !turn.aborted && entry.turn === turn) {
        log({ event: 'persona_turn_aborted', agentId: entry.agentId, reason: 'shutdown' });
        abortTurn(turn);
      }
      if (turn.aborted || entry.turn !== turn) return Promise.resolve({ behavior: 'deny', message: INTERRUPTED });
      const requestId = randomUUID();
      const kind = toolName === 'AskUserQuestion' ? 'question' : 'approval';
      const signals = [turn.controller.signal, options?.signal].filter(Boolean);
      return new Promise((resolve) => {
        let timer = null;
        const onAbort = () => pending.settle('interrupted', { behavior: 'deny', message: INTERRUPTED });
        const pending = {
          settled: false,
          request: { requestId, kind, toolName, input, at: now().toISOString() },
          settle(outcome, result) {
            if (pending.settled) return;
            pending.settled = true;
            clearTimeout(timer);
            for (const signal of signals) signal.removeEventListener('abort', onAbort);
            entry.pending.delete(requestId);
            emit('resolved', entry.agentId, { requestId, outcome });
            if (entry.pending.size === 0 && entry.turn === turn && !turn.aborted && !turn.ending) setState(entry, 'busy');
            resolve(result);
          },
        };
        entry.pending.set(requestId, pending);
        timer = setTimeout(() => {
          pending.settle('expired', { behavior: 'deny', message: `No answer within ${formatDuration(timeouts.requestMaxAgeMs)}` });
        }, timeouts.requestMaxAgeMs);
        for (const signal of signals) signal.addEventListener('abort', onAbort, { once: true });
        emit('request', entry.agentId, { requestId, kind, toolName, input });
        setState(entry, 'waiting');
        if (signals.some((signal) => signal.aborted)) onAbort();
      });
    };
  }

  // Never rejects: every failure becomes an error event and state.
  async function runTurn(entry, agent, text, turn) {
    entry.lastError = null;
    setState(entry, 'busy');
    let failure = null;
    let resumed = false;
    try {
      await record(entry, 'user', text);
      if (!entry.loaded) await loadPointer(entry);
      if (turn.aborted) return;
      resumed = Boolean(entry.sessionId);
      const options = {
        cwd: agent.cwd,
        ...(entry.sessionId ? { resume: entry.sessionId } : {}),
        permissionMode: 'default',
        maxTurns: limits.turnMaxTurns,
        abortController: turn.controller,
        canUseTool: makeCanUseTool(entry, turn),
        ...(agent.model ? { model: agent.model } : {}),
      };
      for await (const message of query({ prompt: text, options })) {
        const problem = await handleMessage(entry, turn, message);
        if (turn.refusal) break;
        if (problem && !turn.aborted) failure = problem;
      }
    } catch (error) {
      if (!turn.aborted) {
        if (resumed && !turn.initSeen) {
          failure = RESUME_FAILED;
          log({ event: 'thread_resume_failed', agentId: entry.agentId });
        } else {
          failure = bound(error?.message ?? String(error));
        }
      }
    } finally {
      if (turn.aborted && !turn.refusal) failure = null;
      if (turn.refusal) failure = turn.refusal;
      turn.ending = true;
      for (const pending of [...entry.pending.values()]) {
        pending.settle('interrupted', { behavior: 'deny', message: INTERRUPTED });
      }
      entry.turn = null;
      if (failure) {
        entry.lastError = failure;
        log({ event: 'persona_turn_error', agentId: entry.agentId, error: failure });
        emit('error', entry.agentId, { message: failure });
      }
      setState(entry, failure ? 'error' : 'idle');
    }
  }

  function abortTurn(turn) {
    if (turn.aborted) return;
    turn.aborted = true;
    turn.controller.abort();
  }

  return {
    kind: 'claude',

    async start(agent) {
      checkAgent(agent);
      const entry = entryFor(agent.id);
      if (!entry.turn && !entry.resetting) await loadPointer(entry);
      return { threadId: agent.id };
    },

    send(agent, text) {
      try {
        checkAgent(agent);
      } catch (error) {
        return Promise.reject(error);
      }
      if (closing) return Promise.reject(new RuntimeError('shutting_down'));
      if (typeof text !== 'string' || text.trim() === '') return Promise.reject(new RuntimeError('invalid_text'));
      const entry = entryFor(agent.id);
      if (entry.turn || entry.resetting) return Promise.reject(new RuntimeError('busy'));
      const turn = {
        controller: new AbortController(), aborted: false, done: null, initSeen: false, refusal: null, ending: false,
      };
      entry.turn = turn;
      turn.done = runTurn(entry, agent, text, turn);
      return turn.done;
    },

    async answer(agent, requestId, answer) {
      const pending = entries.get(agentIdOf(agent))?.pending.get(requestId);
      if (!pending) throw new RuntimeError('no_such_request');
      const { outcome, result } = resolveAnswer(pending.request, answer);
      pending.settle(outcome, result);
    },

    async interrupt(agent) {
      const turn = entries.get(agentIdOf(agent))?.turn;
      if (!turn) return;
      log({ event: 'persona_interrupt', agentId: agentIdOf(agent) });
      abortTurn(turn);
      await turn.done;
    },

    newThread(agent) {
      try {
        checkAgent(agent);
      } catch (error) {
        return Promise.reject(error);
      }
      if (closing) return Promise.reject(new RuntimeError('shutting_down'));
      const entry = entryFor(agent.id);
      if (entry.turn || entry.resetting) return Promise.reject(new RuntimeError('busy'));
      entry.resetting = true;
      return (async () => {
        try {
          try {
            await store.clearPointer(entry.agentId);
            entry.sessionId = null;
            entry.loaded = true;
            entry.costUsd = null;
            entry.lastError = null;
            await store.clear(entry.agentId);
          } catch (error) {
            log({ event: 'thread_reset_error', agentId: entry.agentId, error: error?.message ?? String(error) });
            throw new RuntimeError('thread_reset_failed', { cause: error });
          }
          entry.state = 'idle';
          emit('thread.state', entry.agentId, { state: 'idle' });
          await record(entry, 'system', 'New thread');
        } finally {
          entry.resetting = false;
        }
      })();
    },

    state(agentId) {
      const entry = entries.get(agentId);
      if (!entry) return { state: 'idle', pending: null, lastError: null, sessionId: null, costUsd: null };
      const oldest = entry.pending.values().next().value;
      return {
        state: entry.state,
        pending: oldest ? { ...oldest.request } : null,
        lastError: entry.lastError,
        sessionId: entry.sessionId,
        costUsd: entry.costUsd,
      };
    },

    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    async close() {
      closing = true;
      const aborted = [];
      const abortForShutdown = (entry) => {
        if (entry.turn.aborted) return;
        log({ event: 'persona_turn_aborted', agentId: entry.agentId, reason: 'shutdown' });
        abortTurn(entry.turn);
      };
      // A turn waiting on a human answer would only hold the drain.
      for (const entry of entries.values()) {
        if (entry.turn && entry.pending.size > 0) {
          abortForShutdown(entry);
          aborted.push(entry.turn);
        }
      }
      const inFlight = () => [...entries.values()].filter((entry) => entry.turn);
      const draining = inFlight().filter((entry) => !entry.turn.aborted).map((entry) => entry.turn);
      if (draining.length > 0) await within(Promise.all(draining.map((turn) => turn.done)), timeouts.drainMs);
      for (const entry of inFlight()) {
        abortForShutdown(entry);
        aborted.push(entry.turn);
      }
      if (aborted.length > 0) await within(Promise.all(aborted.map((turn) => turn.done)), abortGraceMs);
    },
  };
}

function resolveAnswer(request, answer) {
  if (!isRecord(answer)) throw new RuntimeError('invalid_answer');
  if (answer.decision === 'deny' && !('answers' in answer)) {
    return { outcome: 'denied', result: { behavior: 'deny', message: DENIED } };
  }
  if (request.kind === 'approval') {
    if (answer.decision === 'allow' && !('answers' in answer)) {
      return { outcome: 'allowed', result: { behavior: 'allow', updatedInput: request.input } };
    }
    throw new RuntimeError('invalid_answer');
  }
  if (!isRecord(answer.answers) || 'decision' in answer) throw new RuntimeError('invalid_answer');
  const questions = new Set((Array.isArray(request.input?.questions) ? request.input.questions : [])
    .map((question) => question?.question)
    .filter((text) => typeof text === 'string'));
  const answers = {};
  for (const [question, value] of Object.entries(answer.answers)) {
    if (!questions.has(question)) throw new RuntimeError('invalid_answer');
    if (typeof value === 'string' && value.trim() !== '') {
      answers[question] = value;
    } else if (Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === 'string' && item.trim() !== '')) {
      answers[question] = value.join(', ');
    } else {
      throw new RuntimeError('invalid_answer');
    }
  }
  if (Object.keys(answers).length === 0) throw new RuntimeError('invalid_answer');
  return { outcome: 'answered', result: { behavior: 'allow', updatedInput: { ...request.input, answers } } };
}

function checkAgent(agent) {
  if (!isRecord(agent) || typeof agent.id !== 'string' || !AGENT_ID.test(agent.id) ||
      typeof agent.cwd !== 'string' || !agent.cwd.startsWith('/')) {
    throw new RuntimeError('invalid_agent');
  }
}

function agentIdOf(agent) {
  return typeof agent === 'string' ? agent : agent?.id;
}

// Resolves when the promise settles or after ms, whichever is first; the
// timer is always cleared.
async function within(promise, ms) {
  let timer;
  try {
    await Promise.race([promise, new Promise((resolve) => { timer = setTimeout(resolve, ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

function formatDuration(ms) {
  if (ms >= 60_000 && ms % 60_000 === 0) {
    const minutes = ms / 60_000;
    return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
  }
  const seconds = Math.max(1, Math.round(ms / 1000));
  return `${seconds} ${seconds === 1 ? 'second' : 'seconds'}`;
}

function bound(text) {
  return truncateUtf8(String(text), ERROR_TEXT_MAX).text;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
