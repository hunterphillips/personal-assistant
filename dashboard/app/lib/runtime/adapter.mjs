// The persona runtime adapter contract. An adapter runs one provider's
// persona threads (claude.mjs is the only one today) and exposes this shape
// to the hub (hub.mjs) and the routes (agent-routes.mjs). This file holds the contract
// and the shared RuntimeError; there is no base class to extend.
//
// An adapter is an object with:
//
//   kind                                 the provider name, e.g. 'claude'
//   start(agent) -> Promise<{ threadId }>
//     Loads whatever the persona needs to take a turn. Rejects when that
//     cannot be done; the hub then marks the persona unavailable, as
//     'sdk_unavailable' when the rejection is a RuntimeError with that code
//     (the provider's package could not be loaded) and 'start_failed'
//     otherwise.
//   send(agent, text, { model, effort, permission, from, mentions, prompt, chain, routine, context } = {}) -> Promise<void | { text, error, aborted }>
//     Starts one turn on the given model id and effort level, each optional
//     and passed to the provider only when set, at the given permission
//     level (permissions.mjs; null and absent mean ask). `from` is the registry id
//     of the agent sending the text (absent for the user), `mentions` the
//     ids it named with @, `prompt` what the provider receives in place
//     of `text`, and `chain` the agents the text passed through before
//     the sender (delegation.mjs); a provider records `from` and
//     `mentions` on the user message, may ignore `prompt`, and never
//     records `chain`. `context` is what quick chat sent along
//     (send-context.mjs); a provider that takes it records it as a system
//     line before the user message and gives the model the prompt with it
//     in front, and one that does not ignores it. See the refusal rule below. Once accepted, the promise
//     resolves when the turn ends and never rejects; failures arrive as
//     `error` events and in state(). A send with `routine` ({ id, name },
//     scheduler.mjs) runs detached, in a session of its own that leaves
//     nothing in the thread: no resume, no message events, no error event
//     or lastError, and it resolves { text, error, aborted }, the run's
//     reply, failure, and whether it was interrupted.
//   answer(agent, requestId, answer) -> Promise<void>
//     Settles an open request. Rejects 'no_such_request' for an unknown or
//     already settled id and 'invalid_answer' for a malformed answer.
//   interrupt(agent) -> Promise<void>
//     Aborts the turn in flight and resolves once it has ended; a no-op when
//     no turn is running.
//   setModel(agent, { model?, effort? }) -> Promise<void>   (optional)
//     Records the thread's own model and effort for its next turns: a key
//     present replaces that field (a string, or null to inherit again), a
//     key absent keeps it. Rejects 'busy' while a turn runs or a reset is
//     in flight, 'shutting_down', 'invalid_model', 'invalid_effort'. The
//     hub reads the choice back from state().model when it resolves the
//     pair for send(). A provider without it (Codex) has no per-thread
//     choice.
//   newThread(agent) -> Promise<void>
//     Forgets the persona's session so the next turn starts a fresh one,
//     with any thread model choice. Rejects 'busy' while a turn runs,
//     'shutting_down' after close() has begun, and 'thread_reset_failed'
//     when the files cannot be cleared.
//   state(agentId) -> { state, pending, lastError, sessionId, costUsd, cwd?, model? }
//     state is 'idle' | 'busy' | 'waiting' | 'error'. pending is the oldest
//     open request ({ requestId, kind, toolName, input, at }) or null. cwd,
//     when the provider has one, is the folder the thread is pinned to;
//     model, when the provider has setModel, is the thread's choice
//     { id, effort } or null.
//   subscribe(fn) -> unsubscribe
//   close() -> Promise<void>
//     Refuses new turns, drains or aborts the running ones, and resolves
//     within a bounded time.
//
// A provider that runs turns on a model may take a `turnTools` hook at
// creation (claude.mjs): turnTools(agent, { text, prompt, from, chain,
// mentions, routine, turnId }) -> { mcpServers?, allowedTools?, prompt?, commit?,
// rollback? }, called before each turn, its fields copied by name. It is
// how the daemon gives every agent the ask tool (delegation.mjs) and, later,
// a read-only tool list for unattended chains.
//
// Events, each { type, agentId, at, ...fields }:
//   thread.state { state }
//   message      { role, text, truncated? }
//   request      { requestId, kind: 'question' | 'approval', toolName, input,
//                  from, chain }  the turn's sender and exchange (claude.mjs)
//   resolved     { requestId, outcome, from, chain }
//   usage        { usage, costUsd, denials }
//   error        { message }
//
// Refusal rule. send() and newThread() must decide whether to refuse before
// their first await, so the returned promise is already rejected when they
// refuse. The send route relies on this: it races the promise against an
// already-resolved marker to tell a refusal (an HTTP error) from an accepted
// turn (202) without waiting for the turn. A rejection that arrives after
// acceptance is a contract violation; the route logs it as
// persona_turn_rejected and nothing else sees it.
//
// RuntimeError codes: 'busy', 'shutting_down', 'invalid_agent',
// 'invalid_text', 'no_such_request', 'invalid_answer', 'thread_reset_failed',
// 'sdk_unavailable' (from start() only), 'not_supported' (a method the
// provider has no use for, such as send() on a Codex thread, or an answer to
// a request only its own terminal can express), and 'unavailable' (the
// provider's server is not connected). The routes map each of the others to
// an HTTP status (see RUNTIME_STATUS in agent-routes.mjs).
//
// An adapter that follows sessions it does not own (codex.mjs) also exposes:
//
//   sessions() -> [{ id, threadId, cwd, title, state, pending, lastMessage,
//                    lastError, updatedAt }]
//     The threads it currently follows, newest first; `id` is
//     '<kind>:<threadId>' and is the agentId its events carry.
//   thread(agentId) -> Promise<{ messages }>
//     Recent messages read from the provider, bounded, never cached.
// and emits one more event, `sessions { agentId: '<kind>' }`, whenever the
// set of sessions changes (listed, reconnected, archived, or lost), so a
// listener knows to call sessions() again. Its `error` events for the
// connection itself carry agentId '<kind>' rather than a thread.

export class RuntimeError extends Error {
  // `options.message` is a plain sentence for a reply; the message stays the
  // code otherwise, so routes can keep mapping on `code`.
  constructor(code, options = {}) {
    super(options.message ?? code, options);
    this.name = 'RuntimeError';
    this.code = code;
  }
}
