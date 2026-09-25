// The persona runtime adapter contract. An adapter runs one provider's
// persona threads (claude.mjs is the only one today) and exposes this shape
// to the hub (hub.mjs) and the routes (app.mjs). This file holds the contract
// and the shared RuntimeError; there is no base class to extend.
//
// An adapter is an object with:
//
//   kind                                 the provider name, e.g. 'claude'
//   start(agent) -> Promise<{ threadId }>
//     Loads whatever the persona needs to take a turn. Rejects when that
//     cannot be done; the hub then marks the persona unavailable.
//   send(agent, text) -> Promise<void>
//     Starts one turn. See the refusal rule below. Once accepted, the promise
//     resolves when the turn ends and never rejects; failures arrive as
//     `error` events and in state().
//   answer(agent, requestId, answer) -> Promise<void>
//     Settles an open request. Rejects 'no_such_request' for an unknown or
//     already settled id and 'invalid_answer' for a malformed answer.
//   interrupt(agent) -> Promise<void>
//     Aborts the turn in flight and resolves once it has ended; a no-op when
//     no turn is running.
//   newThread(agent) -> Promise<void>
//     Forgets the persona's session so the next turn starts a fresh one.
//     Rejects 'busy' while a turn runs, 'shutting_down' after close() has
//     begun, and 'thread_reset_failed' when the files cannot be cleared.
//   state(agentId) -> { state, pending, lastError, sessionId, costUsd }
//     state is 'idle' | 'busy' | 'waiting' | 'error'. pending is the oldest
//     open request ({ requestId, kind, toolName, input, at }) or null.
//   subscribe(fn) -> unsubscribe
//   close() -> Promise<void>
//     Refuses new turns, drains or aborts the running ones, and resolves
//     within a bounded time.
//
// Events, each { type, agentId, at, ...fields }:
//   thread.state { state }
//   message      { role, text, truncated? }
//   request      { requestId, kind: 'question' | 'approval', toolName, input }
//   resolved     { requestId, outcome }
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
// 'invalid_text', 'no_such_request', 'invalid_answer', 'thread_reset_failed'.
// The routes map each to an HTTP status (see RUNTIME_STATUS in app.mjs).

export class RuntimeError extends Error {
  constructor(code, options) {
    super(code, options);
    this.name = 'RuntimeError';
    this.code = code;
  }
}
