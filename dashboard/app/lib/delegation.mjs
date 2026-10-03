// Messages between agents: the ask tool and the lines it writes, and the
// notify tool beside it.
//
// Every Claude agent's turn gets one in-process MCP server named `agents`
// with the tool `ask({ to, message })`, through the adapter's turnTools
// hook (runtime/claude.mjs). The tool sends `message` to the agent `to` as
// a turn of its own, waits a few seconds for the reply, and answers the
// caller with the reply text, or with a pending sentence when the receiver
// is still working, or with the sentence that says why the message did not
// go. The sender is the agent whose turn is running, taken from the hook's
// closure; nothing in the tool's arguments can forge it.
//
// With a notification store (`notifications`, notifications.mjs) the same
// server also carries `notify({ text, link? })`: one sentence for Hunter's
// header list, raised under the agent whose turn is running (the same
// closure; no argument names the agent). It posts nothing in any thread.
//
// createDelegation({ hub, registry, notifications, limits, timeouts, log, now,
//                    randomUUID, importSdk })
// returns:
//
//   toolsFor(agent, { text, prompt, from, chain, mentions, turnId })
//     -> Promise<{ mcpServers, allowedTools, prompt?, commit(), rollback() }>
//     The turnTools hook. `mcpServers.agents` is the per-turn server (its
//     handler closes over the sender and the chain), `allowedTools` names
//     the tool so it runs without a card, and `prompt` replaces what the
//     model gets when there is something to add: replies that arrived
//     since the sender's last own turn before the text, and the ids of the
//     agents the user mentioned after it. Pending replies are only offered
//     on the sender's own turn (`from` absent), never on a hop from
//     another agent, and only for the session the ask was made in; they
//     are taken when the prompt is built, kept by commit() once the prompt
//     reached the model, and put back by rollback() when the turn never
//     started. The tool's description lists every other agent that takes
//     messages from the sender: `accepts` absent or null means everyone.
//
//   ask({ from, chain, to, message }) -> Promise<result>
//     result is { status: 'replied', delegationId, reply }, { status:
//     'pending', delegationId }, { status: 'busy', delegationId }, or
//     { status: 'refused', reason }, with the sentence the tool answers
//     in `text`. `chain` is the agents the message passed through before
//     the sender. Checks, in order: `to` names no agent (unknown); names a
//     project or system entry (not_an_agent); its agent is not running
//     (unavailable); its `accepts` leaves the sender out (not_allowed);
//     `to` is the sender or already in the chain (cycle); the chain has
//     limits.delegationDepth agents already (depth: the user asks A, A
//     may ask B, B may ask C, C may not ask). A refusal posts one line to
//     the sender's thread and sends nothing. Otherwise a 'sent' line goes
//     to the sender's thread, the receiver's adapter gets
//     send(receiver, message, { from, chain, prompt }) with the prompt
//     `From <sender>, an agent in this system (not the user): <message>`,
//     and the receiver's thread shows the message with `from`. A
//     synchronous busy refusal posts a 'busy' line. The receiver's events
//     are followed from before the send until its turn ends: assistant
//     text is the reply; a request posts one 'waiting' line to the
//     sender's thread (the hub relays the card itself to the thread the
//     exchange started in, hub.mjs `forwarded`). When
//     the turn ends within timeouts.delegationWaitMs the 'finished' line
//     (text: the reply, summary: its first sentence; the client prefixes
//     "<name> replied:") or the 'failed' line posts and the tool gets the
//     reply inline; otherwise the tool gets the pending sentence ("<name>
//     is still working. The reply will arrive in this thread.") and the
//     line posts when the turn ends, with the reply queued for the
//     sender's next own turn. What the tool answers is prose the model
//     may repeat, so it never carries an id; the delegationId stays in
//     the result fields and the lines. A turn that ends with no text is 'failed'
//     when the adapter or the hub recorded an error for the receiver, an
//     error or interrupted event was seen, or no usage arrived (an
//     interrupt or shutdown); otherwise it is 'finished' with "<name>
//     answered with no text.". Text that arrived is a reply even if the
//     turn then failed.
//
//   notify({ from, text, link }) -> Promise<result>
//     The notify tool's work: { status: 'raised', id, text } or { status:
//     'refused', reason, text }, `text` the sentence the tool answers. A
//     refusal (empty, too long, a link in no known shape, no store, or a
//     write that failed, logged as notification_error) stores nothing.
//
//   pendingFor(agentId, sessionId) -> [{ delegationId, from, to, reply, at }]
//     Replies queued for the sender, newest last, at most
//     limits.delegationPendingReplies kept, for that session only;
//     entries for another session are dropped when it is read.
//   takePending(agentId, sessionId) -> the same list, removed
//   restorePending(agentId, entries) puts a taken list back
//
// Lines in the sender's thread are system messages with kind 'delegation',
// `state` (sent, busy, waiting, finished, failed, refused), `to`, `text`,
// `summary`, `delegationId` except on a refusal, `reason` on a refusal,
// and `from` on a not_allowed refusal; the client renders them from these
// fields and keeps `text` as the fallback (public/agents.js
// delegationParts). The sentences here and there are the same. A line
// never becomes the row's preview (hub.mjs updatesPreview).
//
// Nothing here throws into the SDK: a rejected hub.notify or any other
// failure is logged as delegation_error and returned as a sentence. Logs:
// delegation_sent, delegation_refused (reason), delegation_finished
// (status, waitedMs, inline), delegation_error.

import { randomUUID as cryptoRandomUUID } from 'node:crypto';

import { z } from 'zod';

import { NotificationError } from './notifications.mjs';
import { firstSentence } from './notices.mjs';
import { RuntimeError } from './runtime/adapter.mjs';

export const SERVER_NAME = 'agents';
export const TOOL_NAME = 'ask';
export const ASK_TOOL = `mcp__${SERVER_NAME}__${TOOL_NAME}`;
export const NOTIFY_TOOL_NAME = 'notify';
export const NOTIFY_TOOL = `mcp__${SERVER_NAME}__${NOTIFY_TOOL_NAME}`;

// What a notification is for, in two sentences; the agent's own prompt and
// repo rules carry the rest of the judgment.
export const NOTIFY_DESCRIPTION = 'Raise a notification the user sees soon in the dashboard header: one sentence about something that needs their attention, '
  + 'such as unusual account activity or an audit waiting for them. '
  + 'Never use it for a chat reply, routine status, or a failed job, unless you judge that the failure needs their attention.';
const LINK_SENTENCE = 'The link must be agent:<id>, feed:<run>/<index>, brief:<date>, or job:<label>.';

const SERVER_VERSION = '1.0.0';
const ERROR_TEXT_MAX = 500;
const importClaudeSdk = () => import('@anthropic-ai/claude-agent-sdk');

export function createDelegation({
  hub, registry, notifications = null, limits, timeouts, log = () => {}, now = () => new Date(),
  randomUUID = cryptoRandomUUID, importSdk = importClaudeSdk,
}) {
  let sdk = null;
  // delegationId -> { from, to, chain, startedAt, waitingPosted }
  const inflight = new Map();
  // sender id -> [{ delegationId, from, to, sessionId, reply, at }]
  const pending = new Map();

  async function ensureSdk() {
    if (!sdk) sdk = await importSdk();
    return sdk;
  }

  function agents() {
    return registry.current()?.agents ?? [];
  }

  function agentById(id) {
    return agents().find((agent) => agent.id === id) ?? null;
  }

  function nameOf(id) {
    const agent = agentById(id);
    return typeof agent?.name === 'string' && agent.name !== '' ? agent.name : id;
  }

  // `accepts` absent or null means everyone.
  function accepts(agent, sender) {
    return !Array.isArray(agent.accepts) || agent.accepts.includes(sender);
  }

  // Listed in the tool's description: the other agents that take messages
  // from the sender.
  function takesMessagesFrom(agent, sender) {
    return agent.id !== sender && agent.kind === 'persona' && accepts(agent, sender);
  }

  function stateOf(id) {
    const views = hub.snapshot?.()?.agents;
    return Array.isArray(views) ? views.find((view) => view.id === id) ?? null : null;
  }

  // The sentence for each line and for the tool's answer.
  function sentence(state, { to, from, reason }) {
    const name = to ? nameOf(to) : 'The agent';
    switch (state) {
      case 'sent': return `Messaged ${name}`;
      case 'busy': return `${name} is busy. Try again in a moment.`;
      case 'waiting': return `${name} is waiting for you.`;
      case 'failed': return `${name} could not answer.`;
      case 'refused':
        switch (reason) {
          case 'not_allowed': return `${name} does not accept messages from ${from ? nameOf(from) : 'this agent'}.`;
          case 'cycle': return `${name} is already in this exchange.`;
          case 'depth': return `This exchange is already ${limits.delegationDepth === 2 ? 'two' : limits.delegationDepth} agents deep.`;
          case 'unavailable': return `${name} is not available.`;
          case 'not_an_agent': return `${name} does not take messages.`;
          case 'unknown': return `No agent is named ${to || 'that'}.`;
          default: return `${name} could not be asked.`;
        }
      default: return '';
    }
  }

  // Posts one line to the sender's thread. Resolves false when the store
  // refused it; the caller turns that into a sentence for the tool.
  async function post(from, line) {
    try {
      await hub.notify(from, { role: 'system', kind: 'delegation', ...line });
      return true;
    } catch (error) {
      log({ event: 'delegation_error', agentId: from, to: line.to ?? null, delegationId: line.delegationId ?? null, error: bound(error?.message ?? String(error)) });
      return false;
    }
  }

  async function refuse(from, to, reason) {
    log({ event: 'delegation_refused', agentId: from, to, reason });
    const text = sentence('refused', { to, from, reason });
    const line = { state: 'refused', reason, to, text, summary: text };
    if (reason === 'not_allowed') line.from = from;
    await post(from, line);
    return { status: 'refused', reason, text };
  }

  async function ask({ from, chain = [], to, message }) {
    const hops = Array.isArray(chain) ? chain.filter((id) => typeof id === 'string' && id !== '') : [];
    const target = typeof to === 'string' ? to : '';
    const receiverAgent = agentById(target);
    if (!receiverAgent) return refuse(from, target, 'unknown');
    if (receiverAgent.kind !== 'persona') return refuse(from, target, 'not_an_agent');
    const receiver = hub.persona(target);
    if (!receiver) return refuse(from, target, 'unavailable');
    if (!accepts(receiverAgent, from)) return refuse(from, target, 'not_allowed');
    if (target === from || hops.includes(target)) return refuse(from, target, 'cycle');
    if (hops.length >= limits.delegationDepth) return refuse(from, target, 'depth');

    const delegationId = randomUUID();
    const startedAt = now().getTime();
    const sessionId = sessionOf(from);
    const entry = { from, to: target, chain: hops, startedAt, waitingPosted: false };
    inflight.set(delegationId, entry);
    log({ event: 'delegation_sent', agentId: from, to: target, delegationId, depth: hops.length });
    const sent = sentence('sent', { to: target });
    if (!(await post(from, { state: 'sent', to: target, delegationId, text: sent, summary: sent }))) {
      inflight.delete(delegationId);
      return { status: 'failed', delegationId, text: `${nameOf(target)} could not be messaged.` };
    }

    // Followed from before the send: the first event is the synchronous
    // thread.state busy, the user message follows an awaited append.
    const seen = { text: [], error: false, interrupted: false, usage: false, events: [] };
    const unsubscribe = receiver.adapter.subscribe((event) => {
      if (event?.agentId !== target) return;
      seen.events.push(event.type);
      if (event.type === 'message' && event.role === 'assistant' && typeof event.text === 'string') {
        seen.text.push(event.text);
      } else if (event.type === 'request' && !entry.waitingPosted) {
        entry.waitingPosted = true;
        const waiting = sentence('waiting', { to: target });
        post(from, { state: 'waiting', to: target, delegationId, text: waiting, summary: waiting });
      } else if (event.type === 'error') {
        seen.error = true;
      } else if (event.type === 'resolved' && event.outcome === 'interrupted') {
        seen.interrupted = true;
      } else if (event.type === 'usage') {
        seen.usage = true;
      }
    });

    const prompt = `From ${nameOf(from)}, an agent in this system (not the user): ${message}`;
    const { id: model, effort } = hub.modelFor(target);
    // The hop runs at the receiver's own level, never the sender's.
    const permission = typeof hub.permissionFor === 'function' ? hub.permissionFor(target) : null;
    let turn;
    try {
      turn = receiver.adapter.send(receiver.agent, message, { model, effort, permission, from, chain: [...hops, from], prompt });
    } catch (error) {
      turn = Promise.reject(error);
    }
    // A refusal is an already rejected promise; an accepted turn never
    // rejects and settles when it ends.
    const ended = turn.then(() => 'ended', (error) => ({ refused: error }));
    const finish = async (inline) => {
      unsubscribe();
      inflight.delete(delegationId);
      const reply = cut(seen.text.join('\n\n').trim(), limits.delegationReplyChars);
      const failed = reply === '' && (
        seen.error || seen.interrupted || !seen.usage
        || Boolean(receiver.adapter.state(target)?.lastError) || Boolean(stateOf(target)?.lastError)
      );
      const waitedMs = now().getTime() - startedAt;
      const text = failed ? sentence('failed', { to: target }) : (reply === '' ? `${nameOf(target)} answered with no text.` : reply);
      const line = failed
        ? { state: 'failed', to: target, delegationId, text, summary: text }
        : { state: 'finished', to: target, delegationId, text, summary: firstSentence(text) };
      const posted = await post(from, line);
      log({ event: 'delegation_finished', agentId: from, to: target, delegationId, status: failed ? 'failed' : 'finished', waitedMs, inline });
      if (!inline) {
        const list = pending.get(from) ?? [];
        list.push({ delegationId, from, to: target, sessionId, reply: text, at: now().toISOString() });
        pending.set(from, list.slice(-limits.delegationPendingReplies));
      }
      if (!posted) log({ event: 'delegation_error', agentId: from, to: target, delegationId, error: 'line_not_written' });
      return { status: failed ? 'failed' : 'replied', delegationId, reply: text, text };
    };

    let timer = null;
    const wait = new Promise((resolve) => {
      timer = setTimeout(() => resolve('wait'), timeouts.delegationWaitMs);
      timer.unref?.();
    });
    const outcome = await Promise.race([ended, wait]);
    clearTimeout(timer);
    if (outcome !== null && typeof outcome === 'object' && 'refused' in outcome) {
      unsubscribe();
      inflight.delete(delegationId);
      const error = outcome.refused;
      const code = error instanceof RuntimeError ? error.code : 'send_failed';
      if (code === 'busy') {
        const busy = sentence('busy', { to: target });
        await post(from, { state: 'busy', to: target, delegationId, text: busy, summary: busy });
        log({ event: 'delegation_finished', agentId: from, to: target, delegationId, status: 'busy', waitedMs: now().getTime() - startedAt, inline: true });
        return { status: 'busy', delegationId, text: busy };
      }
      log({ event: 'delegation_error', agentId: from, to: target, delegationId, error: bound(error?.message ?? String(error)) });
      const failed = sentence('failed', { to: target });
      await post(from, { state: 'failed', to: target, delegationId, text: failed, summary: failed });
      return { status: 'refused', reason: code, text: failed };
    }
    if (outcome === 'ended') return finish(true);
    ended.then(() => finish(false)).catch((error) => {
      log({ event: 'delegation_error', agentId: from, to: target, delegationId, error: bound(error?.message ?? String(error)) });
    });
    return { status: 'pending', delegationId, text: `${nameOf(target)} is still working. The reply will arrive in this thread.` };
  }

  function sessionOf(agentId) {
    return hub.persona(agentId)?.adapter?.state?.(agentId)?.sessionId ?? null;
  }

  function pendingFor(agentId, sessionId) {
    const list = pending.get(agentId) ?? [];
    const kept = list.filter((item) => item.sessionId === sessionId);
    if (kept.length !== list.length) {
      if (kept.length === 0) pending.delete(agentId);
      else pending.set(agentId, kept);
    }
    return kept.map((item) => ({ ...item }));
  }

  function takePending(agentId, sessionId) {
    const taken = pendingFor(agentId, sessionId);
    if (taken.length > 0) pending.delete(agentId);
    return taken;
  }

  function restorePending(agentId, entries) {
    if (!Array.isArray(entries) || entries.length === 0) return;
    const list = [...entries, ...(pending.get(agentId) ?? [])];
    pending.set(agentId, list.slice(-limits.delegationPendingReplies));
  }

  // The tool's description: the agents the sender may ask, then the rules.
  function describe(sender) {
    const lines = agents()
      .filter((agent) => takesMessagesFrom(agent, sender))
      .map((agent) => {
        const parts = [agent.id, agent.name, agent.role, agent.description].filter((part) => typeof part === 'string' && part !== '');
        const state = stateOf(agent.id)?.state;
        return `- ${parts.join(' · ')}${state === 'unavailable' ? ' (not available now)' : ''}`;
      });
    const listed = lines.length > 0 ? lines.join('\n') : '- none right now';
    return [
      'Ask another agent in this system and get its reply. The agents:',
      listed,
      'Agents the user mentions with @ in a message are the ones you may be meant to ask; pass their id as `to`. '
        + 'A reply that is not back within a few seconds arrives in this thread later, so say what you asked and of whom, then stop.',
    ].join('\n');
  }

  // The model's prompt for this turn: pending replies before the text on
  // the sender's own turn, the mentioned agents' ids after it.
  function compose(context, taken) {
    const text = typeof context.prompt === 'string' ? context.prompt : (typeof context.text === 'string' ? context.text : '');
    const mentions = Array.isArray(context.mentions) ? context.mentions.filter((id) => typeof id === 'string' && id !== '') : [];
    if (taken.length === 0 && mentions.length === 0) return null;
    const blocks = [];
    if (taken.length > 0) {
      const items = taken.map((item) => `From ${nameOf(item.to)} (${item.delegationId}): ${cut(item.reply, limits.delegationReplyChars)}`);
      blocks.push(`Replies that arrived since your last turn:\n${items.join('\n\n')}`);
    }
    blocks.push(text);
    if (mentions.length > 0) {
      blocks.push(`Agents mentioned: ${mentions.map((id) => `${nameOf(id)} (id \`${id}\`)`).join(', ')}`);
    }
    return blocks.join('\n\n');
  }

  async function notify({ from, text, link = null }) {
    const refused = (reason, sentence) => ({ status: 'refused', reason, text: sentence });
    if (!notifications) return refused('unavailable', 'Notifications are not available.');
    try {
      const item = await notifications.raise({ agent: from, text, link: link ?? null });
      log({ event: 'notification_raised', agentId: from, notificationId: item.id });
      return { status: 'raised', id: item.id, text: `Raised notification ${item.id}.` };
    } catch (error) {
      if (error instanceof NotificationError) {
        if (error.code === 'empty_text') return refused(error.code, 'The notification is empty.');
        if (error.code === 'text_too_long') return refused(error.code, `The notification is too long: ${limits.notificationTextChars} characters at most.`);
        if (error.code === 'invalid_link') return refused(error.code, LINK_SENTENCE);
      }
      log({ event: 'notification_error', agentId: typeof from === 'string' ? from : null, error: bound(error?.message ?? String(error)) });
      return refused('write_failed', 'The notification could not be saved.');
    }
  }

  async function toolsFor(agent, context = {}) {
    const { tool, createSdkMcpServer } = await ensureSdk();
    const sender = agent.id;
    const chain = Array.isArray(context.chain) ? context.chain : [];
    const taken = context.from ? [] : takePending(sender, sessionOf(sender));
    let settled = false;
    const schema = {
      to: z.string().min(1).max(64).describe('The agent\'s id, from the list above'),
      message: z.string().min(1).max(limits.delegationMessageChars).describe('What to ask; the agent sees it as a message from you'),
    };
    const askTool = tool(TOOL_NAME, describe(sender), schema, async (args) => {
      try {
        const message = typeof args?.message === 'string' ? args.message.trim() : '';
        if (message === '') return result('The message is empty.');
        if (Array.from(message).length > limits.delegationMessageChars) {
          return result(`The message is too long: ${limits.delegationMessageChars} characters at most.`);
        }
        // The sender comes from this turn, never from the arguments.
        const outcome = await ask({ from: sender, chain, to: args?.to, message });
        return result(outcome.text);
      } catch (error) {
        log({ event: 'delegation_error', agentId: sender, to: typeof args?.to === 'string' ? args.to : null, error: bound(error?.message ?? String(error)) });
        return result('The message could not be sent.');
      }
    });
    const tools = [askTool];
    if (notifications) {
      const notifySchema = {
        text: z.string().min(1).max(limits.notificationTextChars).describe('One sentence saying what needs attention'),
        link: z.string().max(200).optional().describe('What to open: agent:<id>, feed:<run>/<index>, brief:<date>, or job:<label>'),
      };
      tools.push(tool(NOTIFY_TOOL_NAME, NOTIFY_DESCRIPTION, notifySchema, async (args) => {
        // The raising agent comes from this turn, never from the arguments.
        const outcome = await notify({ from: sender, text: args?.text, link: typeof args?.link === 'string' ? args.link : null });
        return result(outcome.text);
      }));
    }
    const server = createSdkMcpServer({ name: SERVER_NAME, version: SERVER_VERSION, tools });
    const prompt = compose(context, taken);
    return {
      mcpServers: { [SERVER_NAME]: server },
      allowedTools: notifications ? [ASK_TOOL, NOTIFY_TOOL] : [ASK_TOOL],
      ...(prompt ? { prompt } : {}),
      commit() {
        settled = true;
      },
      rollback() {
        if (settled) return;
        settled = true;
        restorePending(sender, taken);
      },
    };
  }

  return { toolsFor, ask, notify, pendingFor, takePending, restorePending };
}

function result(text) {
  return { content: [{ type: 'text', text }] };
}

function cut(text, chars) {
  const units = Array.from(text);
  return units.length > chars ? units.slice(0, chars).join('') : text;
}

function bound(text) {
  return String(text).slice(0, ERROR_TEXT_MAX);
}
