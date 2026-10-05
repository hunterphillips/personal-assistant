// Claude runtime adapter: runs persona threads through the Claude Agent SDK.
// A persona is one long-lived SDK session whose cwd is the agent's repo as it
// was when the thread began; each send() is one query() that resumes it. Routes and the hub sit above this
// module; it owns only in-memory turn state and the thread files (threads.mjs).
// The contract it implements, including the rule that refusals are decided
// before the first await, is in adapter.mjs.
//
// createClaudeAdapter({ query, importSdk, store, config, log, now, turnTools }) returns:
//
//   kind: 'claude'
//   start(agent) -> Promise<{ threadId }>
//     threadId is agent.id. Imports the SDK (once, cached; skipped when a
//     query is injected) and loads the session pointer into memory; never
//     runs a query. Rejects with a RuntimeError 'sdk_unavailable' (its cause
//     is the import error) if the SDK cannot be loaded, and with the fs
//     error if the pointer file cannot be read.
//   send(agent, text, { model, effort, permission, from, mentions, prompt, chain, routine }) -> Promise<void | { text, error, aborted }>
//     Starts one turn. Refusals reject with a RuntimeError whose code is
//     'busy' (a turn or New thread is in flight; decided synchronously, before
//     any await, so two sends can never both reach query() and fork the
//     session), 'shutting_down' (close() has begun), 'invalid_agent',
//     'invalid_text', 'invalid_permission' (a `permission` that is not
//     one of permissions.mjs PERMISSION_LEVELS, null, or absent), or
//     'invalid_routine' (a `routine` that is not { id, name }). Once
//     accepted, the promise resolves when the turn ends and never rejects;
//     failures arrive as `error` events, except on a routine's detached
//     run, which resolves { text, error, aborted } (see Turn rules).
//   answer(agent, requestId, answer) -> Promise<void>
//     question: { answers: { [question text]: 'Label' | ['A', 'B'] } } (arrays
//               are joined with ", "); { decision: 'deny' } declines it.
//     approval: { decision: 'allow' | 'deny' }.
//     Rejects 'no_such_request' for an unknown or already resolved id and
//     'invalid_answer' for anything else.
//   interrupt(agent) -> Promise<void | { text, error, aborted }>
//     Aborts the turn in flight and waits for it to end, resolving what the
//     send resolves (a run's { text, error, aborted }); a no-op when idle.
//   setModel(agent, { model?, effort? }) -> Promise<void>
//     The thread's own choice for its next turns. A key that is present
//     replaces that field (a string, or null to drop the thread's choice
//     and inherit); a key that is absent keeps the thread's current value.
//     Rejects synchronously 'busy' while a turn is in flight or New thread
//     is clearing (the pair applies at a turn's start, so a change mid-turn
//     would be a lie), 'shutting_down', 'invalid_model' (not a string of 1
//     to 64 characters), 'invalid_effort' (not in models.mjs EFFORTS), or
//     'invalid_agent'. Otherwise writes the pointer with the pair and the
//     current session id (null before the first turn), keeps the pair in
//     the entry (state().model), and records a system message
//     { kind: 'model', model, effort, text } whose text reads "Now on
//     Sonnet." / "Now at low effort." / "Now on Sonnet, low effort." /
//     "Back to the agent's default." (names from models.mjs; an unknown id
//     shows as itself). The hub resolves the pair for the next send from
//     state().model; the adapter itself applies only what send() is given.
//   newThread(agent) -> Promise<void>
//     Rejects 'busy' while a turn is in flight, 'shutting_down' once close()
//     has begun (so a drain never loses the pointer), and
//     'thread_reset_failed' (a RuntimeError whose cause is the fs error) if
//     the pointer or cache cannot be cleared. Otherwise clears both (the
//     thread's model choice goes with the pointer), then emits thread.state idle
//     and a system message 'New thread' (also written to the fresh cache).
//     The idle emission is a boundary marker: it is sent even when the
//     state was already idle, so views can reset the thread.
//   state(agentId) -> { state, pending, lastError, sessionId, costUsd, cwd, model }
//     state: 'idle' | 'busy' | 'waiting' | 'error'; pending is the oldest
//     open request ({ requestId, kind, toolName, input, at, from, chain },
//     from and chain as the turn was sent with: null and [] for Hunter's
//     own turn) or null;
//     costUsd is the last total_cost_usd seen, a running session total; cwd
//     is the folder the thread is pinned to (null before the first start);
//     model is the thread's own choice { id, effort } (either may be null)
//     or null when the thread has none.
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
//   message      { role, text, truncated?, ...fields } user text on send
//                                           (with from and mentions when the
//                                           send carried them),
//                                           assistant text per top-level
//                                           assistant message (subagent
//                                           messages are skipped), system
//                                           lines ('New thread'; setModel's
//                                           { kind: 'model', model, effort });
//                                           text is bounded to
//                                           limits.messageTextBytes
//   request      { requestId, kind: 'question' | 'approval', toolName, input,
//                  from, chain }           from and chain are the turn's (the
//                                           sender's id and the exchange so
//                                           far; null and [] for Hunter's own
//                                           turn), so the hub can show the
//                                           card where the exchange started
//   resolved     { requestId, outcome: 'answered' | 'allowed' | 'denied' |
//                  'expired' | 'interrupted', from, chain }
//   usage        { usage, costUsd, denials } from the result message
//   error        { message }
// A listener that throws is logged as { event: 'runtime_listener_error' }
// and the rest still run.
//
// Turn rules. Every thread query() passes the thread's cwd, the stored session id
// as resume, the permissionMode the caller's `permission` level maps to
// (permissions.mjs sdkModeFor: ask -> 'default', auto -> 'auto', full ->
// 'bypassPermissions' with allowDangerouslySkipPermissions; null and absent
// are ask, so a global mode such as auto never applies on its own, and the
// tools hook cannot change it), maxTurns from limits.turnMaxTurns, the
// turn's AbortController, and canUseTool on every turn (without it the SDK
// drops AskUserQuestion; at Full access it still carries questions). Every
// turn also runs with the Claude Code preset system prompt, so an agent
// behaves as its repo's CLAUDE.md expects; CLAUDE.md itself loads through
// the default setting sources. The preset carries an `append` naming the
// agent from its registry entry (identityPrompt below), built per turn,
// since several agents share one folder and could not tell which they
// are. The SDK records the system prompt on a session's first request, so
// the append reaches an existing thread, and a rename takes effect, only
// after New thread. The init message's permissionMode is logged in persona_init; when it differs
// from the mode requested (Auto is per model, and the user's
// `permissions.disableAutoMode` can refuse it) one
// persona_permission_mismatch line carries both and the turn goes on.
// send(agent, text, { model, effort, permission, from, mentions, prompt, chain, routine, context }): `from` is the
// registry id of the agent that sent the text (absent for the user) and
// `mentions` the ids it named with @; both are recorded on the user message
// and carried by its event. `routine` is { id, name } when the text is a
// routine's instruction (scheduler.mjs), and the send then runs detached:
// a fresh session in agent.cwd (the registry's folder of the moment, not
// the pinned one) with no resume, no pointer read or write, no cache write,
// no context line, and no `message` events; assistant text is collected
// instead, and the send resolves { text, error, aborted } (text joined,
// trimmed, bounded to limits.messageTextBytes; error the failure, "The run
// could not start." before init; aborted on an interrupt). A run's failure
// is the run's: no `error` event, no lastError, and the state ends idle.
// Busy stays mutual with the thread's turns, cards raised during a run are
// the agent's pending requests as on any turn, `from` is never kept beside
// a routine, the tools hook gets `routine` in its context (null on a thread
// turn), and persona_init, persona_usage (with the run's own cost), and
// persona_turn_error carry `routine: <id>`. Otherwise the options, the
// mode, canUseTool, and the hook are those of any other turn at the same
// level. `prompt`, when given, is what the SDK receives
// in place of `text`, so the thread shows what was written while the model
// gets the daemon's prefixed form (delegation.mjs). `context` is what quick
// chat sent along (send-context.mjs); a valid one is recorded as a system
// line { kind: 'context', view, label?, detail } just before the user
// message, and the prompt (text, or `prompt` when given) is prefixed with
// it, so the user message keeps the text as typed. `chain` is the list of
// agents the message passed through before the sender; it is not recorded,
// only handed to the tools hook. { model, effort } takes the resolved pair for this turn
// (hub.modelFor decides it from thread, agent, and system settings); each is
// passed only when set, so null leaves Claude Code's own default in force.
// A model the CLI rejects comes back as a result with is_error whose text
// names the model, and the turn ends in error with that text as lastError.
// The cwd is pinned when the persona starts or first takes a turn and
// changes only on New thread, so a registry edit to an agent's folder never
// resumes an old session in a new folder. The init message's session id is written to the pointer
// when it differs from the one held, and so is the result's, but only after
// init has been seen. canUseTool turns AskUserQuestion into a
// question and every other tool into an approval, and waits for answer(),
// for timeouts.requestMaxAgeMs (denied, outcome 'expired'), or for the turn
// to be aborted (denied, outcome 'interrupted'). The thread stays busy until
// the SDK stream ends, since the model continues after a denial. A stream
// error, or a result with is_error, ends the turn in state 'error'; the next
// send starts over. Every query() also passes the SDK's stderr callback, and
// the turn keeps the last STDERR_MAX characters. If the stream fails before
// init, the pointer is kept, and persona_turn_error carries the SDK's error
// as `cause` and that stderr tail (the log only; the view never sees them).
// When resuming and the stderr says the session or conversation was not
// found, the error is RESUME_FAILED (logged as thread_resume_failed) and New
// thread is the way out; any other failure before init (the CLI could not
// spawn, no credentials, a removed cwd) is START_FAILED, since the pointer
// may be fine. An init whose apiKeySource is a string other than 'none' or
// 'oauth' aborts the turn at once and ends it in 'error' (logged as
// persona_api_key_refused), so a persona never bills an API key.
// An interrupted or shut-down turn ends 'idle' with no error event, even if
// the SDK reports a failure while it winds down. Tools the repo's or the
// user's allow rules cover, reads, and the Skill tool never reach
// canUseTool, so they run without a card.
//
// Per-turn tools. With `turnTools` set, every turn calls
// turnTools(agent, { text, prompt, from, chain, mentions, routine, turnId }) before
// query() and copies exactly these fields from its result by name, never
// spreading it: `mcpServers` and `allowedTools` into the options (a later
// phase adds `tools` here for a read-only chain), and `prompt` in place of
// the text the model gets. A hook result cannot touch permissionMode,
// canUseTool, cwd, resume, systemPrompt, or anything else. A hook that throws is logged
// as persona_tools_error and the turn runs without tools. The result may
// carry commit() and rollback(): commit() runs once init has been seen
// (the prompt reached the model), rollback() when the turn ends without
// init (START_FAILED, RESUME_FAILED, an abort before the query), so the
// hook can hand out replies it holds and take them back if the turn never
// started (delegation.mjs). This hook is the one place a tool is attached
// to a turn; the ask tool for agents lives behind it.

import { randomUUID } from 'node:crypto';

import { TIMEOUTS } from '../config.mjs';
import { contextLine, contextPrompt, parseContext } from '../send-context.mjs';
import { effortName, isEffort, modelName } from '../models.mjs';
import { isPermission, sdkModeFor } from '../permissions.mjs';
import { AGENT_ID } from '../registry.mjs';
import { truncateUtf8 } from '../threads.mjs';
import { RuntimeError } from './adapter.mjs';

const ERROR_TEXT_MAX = 500;
const MODEL_MAX = 64;
const STDERR_MAX = 2048;
const DENIED = 'Denied from the dashboard';
const INTERRUPTED = 'Interrupted from the dashboard';
const RESUME_FAILED = 'The stored session could not be resumed. Start a new thread.';
const START_FAILED = 'The turn could not start. Retry; if it keeps failing, start a new thread.';
const RUN_START_FAILED = 'The run could not start.';
// What the CLI prints when a resume points at a session it cannot find.
const SESSION_MISSING = /(session|conversation)[\s\S]{0,80}(not found|does not exist)|no conversation/i;
// The SDK's ApiKeySource values that do not bill an API key: 'none' is
// claude.ai OAuth (or a bearer token or cloud provider) and 'oauth' is its
// legacy spelling. Everything else, including a value this build does not
// know, is refused.
const SUBSCRIPTION_SOURCES = new Set(['none', 'oauth']);

const importClaudeSdk = () => import('@anthropic-ai/claude-agent-sdk');

export function createClaudeAdapter({
  query = null, importSdk = importClaudeSdk, store, config, log = () => {}, now = () => new Date(), turnTools = null,
}) {
  const { limits, timeouts } = config;
  const abortGraceMs = timeouts.abortGraceMs ?? TIMEOUTS.abortGraceMs;
  const entries = new Map();
  const listeners = new Set();
  let closing = false;
  let loadingSdk = null;

  // The SDK is imported once, outside any turn, so an unloadable package
  // fails start() instead of a turn; a failed import is retried next time.
  function ensureQuery() {
    if (query) return Promise.resolve(query);
    loadingSdk ??= importSdk().then((sdk) => {
      query = sdk.query;
      return query;
    }, (error) => {
      loadingSdk = null;
      throw new RuntimeError('sdk_unavailable', { cause: error });
    });
    return loadingSdk;
  }

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
        cwd: null,
        model: null,
        effort: null,
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
    entry.model = pointer?.model ?? null;
    entry.effort = pointer?.effort ?? null;
    entry.loaded = true;
  }

  // The pointer as the entry holds it: the session and the thread's choice.
  function pointerOf(entry, sessionId = entry.sessionId) {
    return { sessionId, createdAt: now().toISOString(), model: entry.model, effort: entry.effort };
  }

  async function adoptSession(entry, sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '' || sessionId === entry.sessionId) return;
    entry.sessionId = sessionId;
    try {
      await store.writePointer(entry.agentId, pointerOf(entry, sessionId));
    } catch (error) {
      log({ event: 'thread_pointer_error', agentId: entry.agentId, error: error?.message ?? String(error) });
    }
  }

  // The thread's choice { id, effort }, or null when it has none.
  function choiceOf(entry) {
    return entry.model === null && entry.effort === null ? null : { id: entry.model, effort: entry.effort };
  }

  // What the thread line says about a choice.
  function modelLine(model, effort) {
    if (model === null && effort === null) return "Back to the agent's default.";
    const effortText = effort === null ? '' : `${effortName(effort).toLowerCase()} effort`;
    if (model === null) return `Now at ${effortText}.`;
    return effort === null ? `Now on ${modelName(model)}.` : `Now on ${modelName(model)}, ${effortText}.`;
  }

  // Appends a message to the cache, then emits it, so a listener that reads
  // the thread on the event finds the message there. The cache is display
  // only, so a failed append is logged and the message is emitted anyway.
  async function record(entry, role, text, fields = {}) {
    const bounded = truncateUtf8(text, limits.messageTextBytes);
    const at = now().toISOString();
    const message = { ...fields, role, text: bounded.text, at, ...(bounded.truncated ? { truncated: true } : {}) };
    try {
      await store.append(entry.agentId, message);
    } catch (error) {
      log({ event: 'thread_cache_error', agentId: entry.agentId, error: error?.message ?? String(error) });
    }
    emit('message', entry.agentId, message);
  }

  // The hook's tools for this turn, or null. A hook that throws is logged
  // and the turn runs without tools.
  async function toolsForTurn(entry, agent, text, turn) {
    if (typeof turnTools !== 'function') return null;
    try {
      const result = await turnTools(agent, {
        text,
        prompt: turn.prompt ?? text,
        from: turn.from,
        chain: [...turn.chain],
        mentions: [...turn.mentions],
        routine: turn.routine,
        turnId: turn.id,
      });
      return isRecord(result) ? result : null;
    } catch (error) {
      log({ event: 'persona_tools_error', agentId: entry.agentId, error: bound(error?.message ?? String(error)) });
      return null;
    }
  }

  // commit() once the prompt reached the model, rollback() when it never
  // did; each runs at most once and a throwing one is only logged.
  function settleTools(entry, turn, method) {
    const fn = turn.tools?.[method];
    turn.toolsCommitted = true;
    if (typeof fn !== 'function') return;
    try {
      fn();
    } catch (error) {
      log({ event: 'persona_tools_error', agentId: entry.agentId, method, error: bound(error?.message ?? String(error)) });
    }
  }

  // Returns a failure description when the message ends the turn in error.
  async function handleMessage(entry, turn, message) {
    if (message?.type === 'system' && message.subtype === 'init') {
      turn.initSeen = true;
      if (!turn.toolsCommitted) settleTools(entry, turn, 'commit');
      log({
        event: 'persona_init',
        agentId: entry.agentId,
        apiKeySource: message.apiKeySource ?? null,
        permissionMode: message.permissionMode ?? null,
        model: message.model ?? null,
        effort: turn.effort ?? null,
        permission: turn.permission,
        routine: turn.routine?.id ?? null,
      });
      const requested = sdkModeFor(turn.permission).permissionMode;
      if (typeof message.permissionMode === 'string' && message.permissionMode !== requested) {
        log({ event: 'persona_permission_mismatch', agentId: entry.agentId, permission: turn.permission, requested, actual: message.permissionMode });
      }
      const source = message.apiKeySource;
      if (typeof source === 'string' && !SUBSCRIPTION_SOURCES.has(source)) {
        turn.refusal = bound(`Refused: this turn would bill an API key (${source}).`);
        log({ event: 'persona_api_key_refused', agentId: entry.agentId, source });
        abortTurn(turn);
        return null;
      }
      if (!turn.detached) await adoptSession(entry, message.session_id);
    } else if (message?.type === 'assistant') {
      if (message.parent_tool_use_id) return null;
      const content = Array.isArray(message.message?.content) ? message.message.content : [];
      const text = content
        .filter((block) => block?.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n\n');
      if (!text.trim()) return null;
      if (turn.detached) turn.text.push(text);
      else await record(entry, 'assistant', text);
    } else if (message?.type === 'result') {
      // A result before init (a startup failure) must not replace a good pointer.
      // A run's session is its own: neither its id nor its cost is the thread's.
      if (turn.initSeen && !turn.detached) await adoptSession(entry, message.session_id);
      if (typeof message.total_cost_usd === 'number' && !turn.detached) entry.costUsd = message.total_cost_usd;
      const denials = Array.isArray(message.permission_denials) ? message.permission_denials : [];
      emit('usage', entry.agentId, { usage: message.usage ?? null, costUsd: entry.costUsd, denials });
      log({
        event: 'persona_usage',
        agentId: entry.agentId,
        subtype: message.subtype ?? null,
        numTurns: message.num_turns ?? null,
        costUsd: turn.detached ? message.total_cost_usd ?? null : entry.costUsd,
        denials: denials.length,
        ...(turn.routine ? { routine: turn.routine.id } : {}),
      });
      if (message.is_error || message.subtype !== 'success') {
        const errors = Array.isArray(message.errors) ? message.errors.filter((item) => typeof item === 'string') : [];
        if (errors.length > 0) return bound(errors.join('; '));
        // A rejected model, among others, arrives as is_error with the
        // explanation in `result` and no `errors` list.
        if (message.is_error && typeof message.result === 'string' && message.result.trim() !== '') return bound(message.result.trim());
        return bound(`Turn ended: ${message.subtype ?? 'error'}`);
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
          request: { requestId, kind, toolName, input, at: now().toISOString(), from: turn.from ?? null, chain: [...turn.chain] },
          settle(outcome, result) {
            if (pending.settled) return;
            pending.settled = true;
            clearTimeout(timer);
            for (const signal of signals) signal.removeEventListener('abort', onAbort);
            entry.pending.delete(requestId);
            emit('resolved', entry.agentId, { requestId, outcome, from: turn.from ?? null, chain: [...turn.chain] });
            if (entry.pending.size === 0 && entry.turn === turn && !turn.aborted && !turn.ending) setState(entry, 'busy');
            resolve(result);
          },
        };
        entry.pending.set(requestId, pending);
        timer = setTimeout(() => {
          pending.settle('expired', { behavior: 'deny', message: `No answer within ${formatDuration(timeouts.requestMaxAgeMs)}` });
        }, timeouts.requestMaxAgeMs);
        for (const signal of signals) signal.addEventListener('abort', onAbort, { once: true });
        emit('request', entry.agentId, { requestId, kind, toolName, input, from: turn.from ?? null, chain: [...turn.chain] });
        setState(entry, 'waiting');
        if (signals.some((signal) => signal.aborted)) onAbort();
      });
    };
  }

  // Never rejects: every failure becomes an error event and state, or, on a
  // detached turn, the resolution's `error`.
  async function runTurn(entry, agent, text, turn) {
    if (!turn.detached) entry.lastError = null;
    setState(entry, 'busy');
    let failure = null;
    let detail = null;
    let resumed = false;
    try {
      if (!turn.detached) {
        if (turn.context) await record(entry, 'system', contextLine(turn.context), { kind: 'context', ...turn.context });
        await record(entry, 'user', text, {
          ...(turn.from ? { from: turn.from } : {}),
          ...(turn.mentions.length > 0 ? { mentions: [...turn.mentions] } : {}),
        });
      }
      const run = await ensureQuery();
      if (!turn.detached && !entry.loaded) await loadPointer(entry);
      if (turn.aborted) return ended(turn, null);
      turn.tools = await toolsForTurn(entry, agent, text, turn);
      if (turn.aborted) return ended(turn, null);
      const resume = turn.detached ? null : entry.sessionId;
      resumed = Boolean(resume);
      const options = {
        cwd: turn.detached ? agent.cwd : entry.cwd,
        ...(resume ? { resume } : {}),
        ...sdkModeFor(turn.permission),
        systemPrompt: systemPromptFor(agent),
        maxTurns: limits.turnMaxTurns,
        abortController: turn.controller,
        canUseTool: makeCanUseTool(entry, turn),
        stderr: (data) => { turn.stderr = `${turn.stderr}${data}`.slice(-STDERR_MAX); },
        ...(turn.model ? { model: turn.model } : {}),
        ...(turn.effort ? { effort: turn.effort } : {}),
        // Copied by name from the hook's result, never spread: the hook
        // adds tools and nothing else.
        ...(isRecord(turn.tools?.mcpServers) ? { mcpServers: turn.tools.mcpServers } : {}),
        ...(Array.isArray(turn.tools?.allowedTools) ? { allowedTools: [...turn.tools.allowedTools] } : {}),
      };
      const hookPrompt = typeof turn.tools?.prompt === 'string' && turn.tools.prompt.trim() !== '' ? turn.tools.prompt : null;
      for await (const message of run({ prompt: hookPrompt ?? turn.prompt ?? text, options })) {
        const problem = await handleMessage(entry, turn, message);
        if (turn.refusal) break;
        if (problem && !turn.aborted) failure = problem;
      }
    } catch (error) {
      if (!turn.aborted) {
        if (turn.initSeen) {
          failure = bound(error?.message ?? String(error));
        } else {
          // Before init the SDK's error says little more than that the CLI
          // exited; its stderr says whether the stored session was the cause.
          detail = { cause: bound(error?.message ?? String(error)), stderr: turn.stderr };
          if (resumed && SESSION_MISSING.test(turn.stderr)) {
            failure = RESUME_FAILED;
            log({ event: 'thread_resume_failed', agentId: entry.agentId });
          } else {
            failure = turn.detached ? RUN_START_FAILED : START_FAILED;
          }
        }
      }
    } finally {
      if (turn.aborted && !turn.refusal) failure = null;
      if (turn.refusal) failure = turn.refusal;
      turn.ending = true;
      if (!turn.toolsCommitted) settleTools(entry, turn, 'rollback');
      for (const pending of [...entry.pending.values()]) {
        pending.settle('interrupted', { behavior: 'deny', message: INTERRUPTED });
      }
      entry.turn = null;
      if (failure) {
        log({ event: 'persona_turn_error', agentId: entry.agentId, error: failure, ...detail, ...(turn.routine ? { routine: turn.routine.id } : {}) });
      }
      // A run's failure is the run's: the thread never shows it.
      if (failure && !turn.detached) {
        entry.lastError = failure;
        emit('error', entry.agentId, { message: failure });
      }
      setState(entry, failure && !turn.detached ? 'error' : 'idle');
    }
    return ended(turn, failure);
  }

  // What a detached turn resolves with; nothing for a thread turn.
  function ended(turn, failure) {
    if (!turn.detached) return undefined;
    const text = truncateUtf8(turn.text.join('\n\n').trim(), limits.messageTextBytes).text;
    return { text, error: failure, aborted: turn.aborted && !turn.refusal };
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
      await ensureQuery();
      const entry = entryFor(agent.id);
      entry.cwd ??= agent.cwd;
      if (!entry.turn && !entry.resetting) await loadPointer(entry);
      return { threadId: agent.id };
    },

    send(agent, text, { model = null, effort = null, permission = null, from = null, mentions = null, prompt = null, chain = null, routine = null, context = null } = {}) {
      try {
        checkAgent(agent);
      } catch (error) {
        return Promise.reject(error);
      }
      if (closing) return Promise.reject(new RuntimeError('shutting_down'));
      if (typeof text !== 'string' || text.trim() === '') return Promise.reject(new RuntimeError('invalid_text'));
      if (permission !== null && permission !== undefined && !isPermission(permission)) return Promise.reject(new RuntimeError('invalid_permission'));
      if (routine !== null && routine !== undefined && !isRoutineRef(routine)) return Promise.reject(new RuntimeError('invalid_routine'));
      const entry = entryFor(agent.id);
      if (entry.turn || entry.resetting) return Promise.reject(new RuntimeError('busy'));
      // A run never reads the pin, so it never sets it.
      if (!routine) entry.cwd ??= agent.cwd;
      const turn = {
        id: randomUUID(),
        controller: new AbortController(),
        aborted: false,
        done: null,
        initSeen: false,
        refusal: null,
        ending: false,
        stderr: '',
        tools: null,
        toolsCommitted: false,
        model: typeof model === 'string' && model !== '' ? model : null,
        effort: typeof effort === 'string' && effort !== '' ? effort : null,
        permission: permission ?? 'ask',
        routine: routine ? { id: routine.id, name: routine.name } : null,
        // A routine's run is a session of its own, outside the thread.
        detached: Boolean(routine),
        text: [],
        // A routine's turn is the routine's, never another agent's.
        from: !routine && typeof from === 'string' && from !== '' ? from : null,
        mentions: Array.isArray(mentions) ? mentions.filter((id) => typeof id === 'string' && id !== '') : [],
        prompt: typeof prompt === 'string' && prompt.trim() !== '' ? prompt : null,
        chain: Array.isArray(chain) ? chain.filter((id) => typeof id === 'string' && id !== '') : [],
        context: context ? parseContext(context) : null,
      };
      if (turn.context) turn.prompt = contextPrompt(turn.context, turn.prompt ?? text);
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
      return turn.done;
    },

    setModel(agent, choice = {}) {
      try {
        checkAgent(agent);
      } catch (error) {
        return Promise.reject(error);
      }
      if (closing) return Promise.reject(new RuntimeError('shutting_down'));
      const hasModel = isRecord(choice) && choice.model !== undefined;
      const hasEffort = isRecord(choice) && choice.effort !== undefined;
      if (hasModel && choice.model !== null && !(typeof choice.model === 'string' && choice.model !== '' && choice.model.length <= MODEL_MAX)) {
        return Promise.reject(new RuntimeError('invalid_model'));
      }
      if (hasEffort && choice.effort !== null && !isEffort(choice.effort)) return Promise.reject(new RuntimeError('invalid_effort'));
      const entry = entryFor(agent.id);
      if (entry.turn || entry.resetting) return Promise.reject(new RuntimeError('busy'));
      entry.cwd ??= agent.cwd;
      // Held like a turn so a send or New thread meanwhile is refused busy
      // rather than racing the pointer write.
      entry.resetting = true;
      return (async () => {
        try {
          if (!entry.loaded) await loadPointer(entry);
          if (hasModel) entry.model = choice.model;
          if (hasEffort) entry.effort = choice.effort;
          try {
            if (entry.sessionId === null && choiceOf(entry) === null) await store.clearPointer(entry.agentId);
            else await store.writePointer(entry.agentId, pointerOf(entry));
          } catch (error) {
            log({ event: 'thread_pointer_error', agentId: entry.agentId, error: error?.message ?? String(error) });
          }
          log({ event: 'persona_model', agentId: entry.agentId, model: entry.model, effort: entry.effort });
        } finally {
          entry.resetting = false;
        }
        await record(entry, 'system', modelLine(entry.model, entry.effort), { kind: 'model', model: entry.model, effort: entry.effort });
      })();
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
            entry.model = null;
            entry.effort = null;
            entry.loaded = true;
            entry.costUsd = null;
            entry.lastError = null;
            entry.cwd = agent.cwd;
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
      if (!entry) return { state: 'idle', pending: null, lastError: null, sessionId: null, costUsd: null, cwd: null, model: null };
      const oldest = entry.pending.values().next().value;
      return {
        state: entry.state,
        pending: oldest ? { ...oldest.request } : null,
        lastError: entry.lastError,
        sessionId: entry.sessionId,
        costUsd: entry.costUsd,
        cwd: entry.cwd,
        model: choiceOf(entry),
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

// The routine a send is attributed to: { id, name }, both non-empty strings.
function isRoutineRef(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && typeof value.id === 'string' && value.id !== '' && typeof value.name === 'string' && value.name !== '';
}

// The preset with the agent's identity appended, or the bare preset for an
// entry without a name (a registry entry always has one).
function systemPromptFor(agent) {
  const append = identityPrompt(agent);
  return append ? { type: 'preset', preset: 'claude_code', append } : { type: 'preset', preset: 'claude_code' };
}

export function identityPrompt(agent) {
  if (typeof agent?.name !== 'string' || agent.name === '') return null;
  const parts = [`You are ${agent.name}, one of Hunter's agents in his personal assistant system.`];
  if (typeof agent.role === 'string' && agent.role !== '') parts.push(`Your role: ${agent.role}.`);
  if (typeof agent.description === 'string' && agent.description !== '') parts.push(`In your own words: ${agent.description}`);
  return parts.join(' ');
}
