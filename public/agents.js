// Agents view, the page at `/`: the registry's agents as a list grouped
// Work and Personal, and beside it either one persona's thread or, with no
// agent open, the routines overview. The shell calls create({ requestState,
// isStreaming }, routines) once, then update(state, keys) on every change
// (keys is null for a whole snapshot), show() when the view opens, and
// hide() when it closes or the tab is hidden. The list is rebuilt only
// while the view is shown; show() renders the latest state.
//
// The open agent is `?agent=<id>` in the URL, so a reload lands on the same
// thread and Back and Forward move between threads. Choosing a row pushes
// that URL; the shell's popstate handler calls show(), which reads it back.
// On a phone the list comes first and its Routines row opens the overview
// at `/routines`, a view link the shell handles.
//
// `routines` (routines.js) renders the overview into its own pane and one
// agent's routines under the thread header, behind a "Routines (n)" button
// that appears only for agents with routines; this view says when each is
// on screen.
//
// The thread is fetched from /api/agents/<id>/thread when a persona opens
// and again whenever the snapshot shows its last message or its turn
// changed, so the pane follows the turn without rebuilding it from deltas.
// A question or approval is rendered from the snapshot's `pending`; the
// card is rebuilt only when the request changes, so choices survive other
// state changes. Send, Answer, Allow, Deny, Interrupt, and New thread post
// to the persona routes; a refusal is reported under the composer until the
// next attempt. The composer's draft and the refusal belong to the agent
// they were typed for: a draft is kept while another thread is open and put
// back when its agent is chosen again.
//
// The snapshot's coding sessions (Codex threads and Claude terminals in
// cmux) are rows too, each under the project row the hub named in its
// `projectId`, or under "Other sessions" after the groups. A session's id
// (`codex:<thread>` or `claude:<cmux session>`) goes in `?agent=` like an
// agent's. A Codex session opens the same pane, read and answered through
// the session routes, with no composer: its messages are typed in the
// terminal. A Claude terminal has nothing to read, so its pane says so
// and shows its state. Both offer "Open terminal", which posts to the
// session's open-terminal route and is off, with the reason under it,
// unless the session's terminal is bound, still open, and cmux answers.
(function () {
  'use strict';

  var GROUPS = [['work', 'Work'], ['personal', 'Personal']];
  var PROVIDERS = { claude: 'Claude', codex: 'Codex' };
  var WATCHED = ['agents', 'registry', 'routines', 'sessions', 'codex', 'cmux'];
  var AGENT_ID = /^[a-z][a-z0-9-]{1,31}$/;
  var SESSION_ID = /^(?:codex|claude):[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
  var NO_SESSIONS = 'No coding sessions. Start the Codex server or open a terminal in cmux.';
  var TERMINAL_ONLY = 'Answer this one in the terminal.';
  var UNBOUND = 'This terminal was not started through the dashboard, so it cannot be opened from here.';
  var TERMINAL_CLOSED = 'That terminal is closed.';
  var TICK_MS = 60000;
  var THREAD_TIMEOUT_MS = 8000;
  var SCROLL_END_PX = 80; // this close to the end counts as reading the newest message
  var NO_ANSWER = 'The dashboard did not respond.';

  function element(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function button(className, text, action) {
    var node = element('button', className, text);
    node.type = 'button';
    node.setAttribute('data-agent-action', action);
    return node;
  }

  function formatTime(iso) {
    var routines = window.DashboardRoutines;
    return routines && typeof iso === 'string' ? routines.formatTime(iso, Date.now()) : '';
  }

  // A time span that refreshTimes() keeps current.
  function timeSpan(className, iso) {
    var node = element('span', className, formatTime(iso));
    if (typeof iso === 'string') node.setAttribute('data-at', iso);
    return node;
  }

  function refreshTimes(root) {
    var spans = root.querySelectorAll('[data-at]');
    for (var i = 0; i < spans.length; i += 1) spans[i].textContent = formatTime(spans[i].getAttribute('data-at'));
  }

  function providerName(agent) {
    var provider = agent && agent.provider;
    if (!provider) return '';
    return Object.prototype.hasOwnProperty.call(PROVIDERS, provider) ? PROVIDERS[provider] : provider;
  }

  function isPersona(agent) {
    return !!agent && agent.kind === 'persona';
  }

  // A row from the snapshot's sessions: a Codex thread or a Claude terminal.
  function isSession(entry) {
    return !!entry && (entry.kind === 'terminal' || typeof entry.threadId === 'string');
  }

  function isTerminal(entry) {
    return isSession(entry) && entry.kind === 'terminal';
  }

  // A persona or a Codex session: something with messages to read.
  function hasThread(entry) {
    return isPersona(entry) || (isSession(entry) && !isTerminal(entry));
  }

  function turnOpen(agent) {
    return agent.state === 'busy' || agent.state === 'waiting';
  }

  function lastSegment(cwd) {
    if (typeof cwd !== 'string') return '';
    var parts = cwd.split('/').filter(Boolean);
    return parts.length > 0 ? parts[parts.length - 1] : cwd;
  }

  // A path with the home directory as `~`.
  function shortPath(cwd, home) {
    if (typeof cwd !== 'string') return '';
    if (typeof home !== 'string' || !home) return cwd;
    if (cwd === home) return '~';
    return cwd.indexOf(home + '/') === 0 ? '~' + cwd.slice(home.length) : cwd;
  }

  // What a row or pane calls the entry: an agent's name, a Codex thread's
  // title, or the session's folder.
  function displayName(entry) {
    if (!isSession(entry)) return entry.name;
    if (!isTerminal(entry) && typeof entry.title === 'string' && entry.title) return entry.title;
    return lastSegment(entry.cwd) || 'Terminal';
  }

  // The rows under each group heading in registry order, each with the
  // sessions nested under it (newest first, as the snapshot lists them);
  // groups with no rows are left out. Sessions under no project form one
  // more group after the others.
  function groups(agents, sessions) {
    var nested = {};
    var loose = [];
    for (var s = 0; s < (sessions || []).length; s += 1) {
      var session = sessions[s];
      var projectId = session.projectId;
      var known = projectId && (agents || []).some(function (agent) { return agent.id === projectId; });
      if (!known) loose.push(session);
      else (nested[projectId] = nested[projectId] || []).push(session);
    }
    var result = [];
    for (var i = 0; i < GROUPS.length; i += 1) {
      var members = (agents || []).filter(function (agent) { return agent.group === GROUPS[i][0]; });
      if (members.length === 0) continue;
      var entries = members.map(function (agent) { return { agent: agent, sessions: nested[agent.id] || [] }; });
      result.push({ key: GROUPS[i][0], title: GROUPS[i][1], entries: entries });
    }
    if (loose.length > 0) result.push({ key: 'other', title: 'Other sessions', entries: [{ agent: null, sessions: loose }] });
    return result;
  }

  // The sentence under the list when nothing could be listed and both
  // sources are off; with one of them on, the pane says what is off.
  function sessionsSentence(state) {
    if (!state || (state.sessions || []).length > 0) return '';
    var codexOff = !!state.codex && state.codex.available === false;
    var cmuxOff = !!state.cmux && state.cmux.available === false;
    return codexOff && cmuxOff ? NO_SESSIONS : '';
  }

  // The Codex server, when it is off, as a sentence; '' while it answers.
  function codexSentence(codex) {
    if (!codex || codex.available !== false) return '';
    switch (codex.reason) {
      case 'no_server': return 'Codex server not running.';
      case 'disconnected': return 'Codex server disconnected.';
      default: return 'Codex sessions are off.';
    }
  }

  // cmux, when it cannot be reached, as a sentence; '' while it answers.
  function cmuxSentence(cmux) {
    if (!cmux || cmux.available !== false) return '';
    switch (cmux.reason) {
      case 'not_running': return 'cmux is not running.';
      case 'no_password':
      case 'auth_failed': return 'cmux refused the connection. Check the socket password.';
      default: return 'cmux is not reachable.';
    }
  }

  // The recorded terminal, when it names one: ids are null when the helper
  // ran outside cmux.
  function bound(session) {
    var binding = session && session.binding;
    return !!binding && typeof binding.workspaceId === 'string' && typeof binding.surfaceId === 'string';
  }

  // Why Open terminal is off for the session, or '' when it can be chosen.
  function terminalReason(session, state) {
    if (!bound(session)) return UNBOUND;
    var cmux = state && state.cmux;
    if (!cmux || cmux.available !== true) return cmuxSentence(cmux) || 'cmux is not reachable.';
    return session.binding.live === true ? '' : TERMINAL_CLOSED;
  }

  // A refused open-terminal as a sentence. `result` is { code, reason } or
  // null when there was no answer.
  function openRefusal(result) {
    if (!result) return NO_ANSWER;
    var reason = result.reason;
    switch (result.code) {
      case 'unbound': return UNBOUND;
      case 'terminal_closed': return TERMINAL_CLOSED;
      case 'cmux_unavailable': return cmuxSentence({ available: false, reason: reason });
      case 'focus_failed':
        if (reason === 'not_found') return TERMINAL_CLOSED;
        if (reason === 'not_running' || reason === 'no_password' || reason === 'auth_failed') return cmuxSentence({ available: false, reason: reason });
        return 'cmux could not open that terminal.';
      case 'no_such_session': return 'That session is no longer listed.';
      case 'shutting_down': return 'The dashboard is shutting down. Try again in a moment.';
      default: return 'Something went wrong on the dashboard. Try again.';
    }
  }

  // What the phone's Routines row says once routines have been read.
  function routinesCount(state) {
    var routines = state && state.routines;
    if (!routines || !routines.refreshedAt) return '';
    var n = (routines.items || []).length;
    return n === 1 ? '1 routine' : n + ' routines';
  }

  // The persona's or session's lastError as a sentence the reader can act
  // on. The adapter's own messages are already sentences and pass through.
  function errorSentence(agent) {
    var code = agent.lastError;
    switch (code) {
      case 'api_key_in_env':
        return 'The dashboard started with an API key in its environment, so personas are off. Unset it and restart the dashboard.';
      case 'start_failed':
        return 'The session file for ' + agent.name + ' could not be read. Check the threads directory, then restart the dashboard.';
      case 'server_gone':
        return 'The Codex server disconnected.';
      case 'sdk_unavailable':
        return 'The Claude Agent SDK could not be loaded. Run npm ci in dashboard/app, then restart the dashboard.';
      case 'provider_unavailable':
        return providerName(agent) ? 'There is no runtime for ' + providerName(agent) + ' yet.' : 'There is no runtime for this provider yet.';
      case 'turn_timeout':
        return 'The last turn ran too long and was stopped.';
      case 'error':
      case null:
      case undefined:
      case '':
        return 'The last turn failed.';
      default:
        return String(code);
    }
  }

  // Why a persona cannot take a message right now, or ''.
  function composerReason(agent) {
    if (!isPersona(agent)) return '';
    if (agent.state === 'unavailable') return agent.lastError ? errorSentence(agent) : agent.name + ' has not started yet.';
    if (agent.state === 'busy') return agent.name + ' is working. Wait for the reply or interrupt.';
    if (agent.state === 'waiting') {
      return agent.pending && agent.pending.kind === 'approval' ? 'Allow or deny the request first.' : 'Answer the question first.';
    }
    return '';
  }

  // A refused or failed request as a sentence. `code` is the JSON error, or
  // null when there was no answer.
  function refusalSentence(result, agent) {
    if (!result) return NO_ANSWER;
    var name = displayName(agent);
    switch (result.code) {
      case 'busy': return name + ' is still working. Wait for the reply.';
      case 'no_such_request': return 'That request was already answered or has expired.';
      case 'shutting_down': return 'The dashboard is shutting down. Try again in a moment.';
      case 'persona_unavailable': return name + ' is unavailable.';
      case 'thread_reset_failed': return 'The thread could not be reset. Check the dashboard log.';
      case 'invalid_text': return 'Type a message first.';
      case 'payload_too_large': return 'The message is too long. Shorten it.';
      case 'invalid_answer': return 'That answer could not be sent.';
      case 'not_a_persona': return name + ' has no thread.';
      case 'invalid_agent': return 'That agent is not in the registry.';
      case 'not_supported': return TERMINAL_ONLY;
      case 'unavailable': return 'The Codex server is not connected.';
      case 'no_such_session': return 'That session is no longer listed.';
      default: return 'Something went wrong on the dashboard. Try again.';
    }
  }

  // The one-line preview under a row: the last message, or the description
  // for an agent that has no thread.
  function previewText(agent) {
    if (!isPersona(agent)) return agent.description || '';
    var message = agent.lastMessage;
    if (!message || typeof message.text !== 'string') return '';
    var text = message.text.replace(/\s+/g, ' ').trim();
    return message.role === 'user' ? 'You: ' + text : text;
  }

  // The row's state line for a persona or a session, or null. A Codex
  // thread whose turn is open is still answerable here, so its turn wins
  // over a closed terminal; a closed terminal is all there is to say
  // about a Claude terminal.
  function stateLine(agent) {
    var closed = isSession(agent) && !!agent.binding && agent.binding.live === false;
    if (isTerminal(agent)) {
      if (closed) return { text: 'Terminal closed', tone: 'muted' };
      if (agent.state === 'waiting') return { text: 'Waiting for you', tone: 'wait' };
      return agent.state === 'busy' ? { text: 'Working', tone: 'muted' } : null;
    }
    if (!hasThread(agent)) return null;
    switch (agent.state) {
      case 'waiting': return { text: 'Waiting for you', tone: 'wait' };
      case 'busy': return { text: 'Working', tone: 'muted' };
      case 'error': return { text: 'The last turn failed', tone: 'bad' };
      case 'unavailable': return isSession(agent) ? { text: 'Server stopped', tone: 'muted' } : { text: 'Unavailable', tone: 'muted' };
      default: return closed ? { text: 'Terminal closed', tone: 'muted' } : null;
    }
  }

  // The sentence a terminal's pane shows for its state.
  function terminalState(session) {
    if (session.binding && session.binding.live === false) return 'The terminal is closed.';
    switch (session.state) {
      case 'busy': return 'Claude is working.';
      case 'idle': return 'Claude is idle.';
      case 'waiting': return 'Claude is waiting for you.';
      default: return 'Claude’s state is not known.';
    }
  }

  // An approval's input for display: pretty JSON when it is whole, the raw
  // cut text otherwise.
  function formatInput(pending) {
    var input = typeof pending.input === 'string' ? pending.input : JSON.stringify(pending.input);
    if (pending.truncated) return input;
    try {
      return JSON.stringify(JSON.parse(input), null, 2);
    } catch (_error) {
      return input;
    }
  }

  function questionsOf(pending) {
    var input = pending && pending.input;
    return input && Array.isArray(input.questions) ? input.questions : [];
  }

  function parse(text) {
    try {
      return JSON.parse(text);
    } catch (_error) {
      return null;
    }
  }

  function agentFromUrl() {
    var id = new URLSearchParams(location.search).get('agent');
    return id && (AGENT_ID.test(id) || SESSION_ID.test(id)) ? id : null;
  }

  function agentUrl(id) {
    return id ? '/?agent=' + encodeURIComponent(id) : '/';
  }

  // The route prefix for the entry's thread, answer, and interrupt.
  function routeBase(entry) {
    return (isSession(entry) ? '/api/sessions/' : '/api/agents/') + entry.id;
  }

  function create(shell, routines) {
    var view = document.getElementById('view-agents');
    var message = document.getElementById('agents-message');
    var routinesRowCount = document.getElementById('agents-routines-count');
    var groupsNode = document.getElementById('agents-groups');
    var overview = document.getElementById('routines-overview');
    var empty = document.getElementById('agent-empty');
    var panel = document.getElementById('agent-panel');
    var nameNode = document.getElementById('agent-name');
    var chips = document.getElementById('agent-chips');
    var cost = document.getElementById('agent-cost');
    var routinesToggle = document.getElementById('agent-routines-toggle');
    var routinesSection = document.getElementById('agent-routines');
    var newThread = document.getElementById('agent-new-thread');
    var openTerminal = document.getElementById('agent-open-terminal');
    var terminalLine = document.getElementById('agent-terminal-reason');
    var foot = document.getElementById('agent-foot');
    var availability = document.getElementById('agents-availability');
    var confirmNode = document.getElementById('agent-confirm');
    var confirmText = document.getElementById('agent-confirm-text');
    var description = document.getElementById('agent-description');
    var notice = document.getElementById('agent-notice');
    var messagesNode = document.getElementById('agent-messages');
    var status = document.getElementById('agent-status');
    var statusText = document.getElementById('agent-status-text');
    var request = document.getElementById('agent-request');
    var composer = document.getElementById('agent-composer');
    var inputLabel = document.getElementById('agent-input-label');
    var input = document.getElementById('agent-input');
    var send = document.getElementById('agent-send');
    var reason = document.getElementById('agent-composer-reason');
    var failure = document.getElementById('agent-failure');

    var state = null;
    var visible = false;
    var selectedId = null;
    var overviewOpen = false; // the phone's Routines row was chosen (`/routines`)
    var overviewTold = false; // what `routines` was last told: the overview is on screen
    var routinesOpen = false; // the open agent's routines are expanded
    var wide = window.matchMedia('(min-width: 720px)');
    var thread = { id: null, messages: null, loading: false, error: false, fresh: true, version: 0 };
    var renderedVersion = -1;
    var threadKey = null; // what the thread was last fetched against
    var threadSeq = 0;
    var busy = false; // one of our POSTs is out
    var actionError = ''; // why the selected agent's last POST failed, or ''
    var terminalError = ''; // why the selected session's Open terminal was refused, or ''
    var confirming = false; // New thread awaits confirmation
    var drafts = {}; // unsent composer text by agent id, for agents not selected
    var tick = null;

    // The open agent or session, or null.
    function selectedAgent() {
      if (!state || !selectedId) return null;
      var lists = [state.agents || [], state.sessions || []];
      for (var l = 0; l < lists.length; l += 1) {
        for (var i = 0; i < lists[l].length; i += 1) if (lists[l][i].id === selectedId) return lists[l][i];
      }
      return null;
    }

    function chip(className, text) {
      return element('span', className, text);
    }

    function row(agent) {
      var persona = isPersona(agent);
      var node = persona ? element('a', 'agent-row') : element('div', 'agent-row agent-row-plain');
      if (persona) node.href = agentUrl(agent.id);
      node.setAttribute('data-agent', agent.id);
      if (agent.id === selectedId) node.setAttribute('aria-current', 'true');

      var head = element('span', 'agent-row-head');
      head.appendChild(element('span', 'agent-row-name', agent.name));
      if (agent.role) head.appendChild(chip('role-chip', agent.role));
      if (providerName(agent)) head.appendChild(chip('provider-chip', providerName(agent)));
      if (persona && agent.lastMessage) head.appendChild(timeSpan('agent-row-time', agent.lastMessage.at));
      node.appendChild(head);

      var preview = previewText(agent);
      if (preview) node.appendChild(element('span', 'agent-row-preview', preview));
      var line = stateLine(agent);
      if (line) node.appendChild(element('span', 'agent-row-state agent-row-state-' + line.tone, line.text));
      return node;
    }

    function sessionRow(session) {
      var node = element('a', 'agent-row agent-row-session');
      node.href = agentUrl(session.id);
      node.setAttribute('data-agent', session.id);
      if (session.id === selectedId) node.setAttribute('aria-current', 'true');

      var head = element('span', 'agent-row-head');
      head.appendChild(element('span', 'agent-row-name', displayName(session)));
      if (providerName(session)) head.appendChild(chip('provider-chip', providerName(session)));
      if (session.updatedAt) head.appendChild(timeSpan('agent-row-time', session.updatedAt));
      node.appendChild(head);

      var folder = shortPath(session.cwd, state.home);
      if (folder) node.appendChild(element('span', 'agent-row-preview', folder));
      var line = stateLine(session);
      if (line) node.appendChild(element('span', 'agent-row-state agent-row-state-' + line.tone, line.text));
      return node;
    }

    // The sentence above the list. The overview says when the registry could
    // not be read, so the list says it only while the overview is off screen.
    function renderMessage() {
      if (!state) return;
      var registry = state.registry;
      var text = '';
      if (registry && registry.ok === false) text = overviewShown() ? '' : 'The registry could not be read.';
      else if ((state.agents || []).length === 0) text = 'No agents are registered.';
      message.textContent = text;
      message.hidden = !text;
    }

    function renderList() {
      if (!state) return;
      // Keep keyboard focus on the same row across the rebuild.
      var active = document.activeElement;
      var focusedId = active && groupsNode.contains(active) && active.hasAttribute('data-agent') ? active.getAttribute('data-agent') : null;
      groupsNode.textContent = '';
      renderMessage();
      routinesRowCount.textContent = routinesCount(state);

      var list = groups(state.agents, state.sessions);
      for (var i = 0; i < list.length; i += 1) {
        var section = element('section', 'agent-group agent-group-' + list[i].key);
        var headingId = 'agents-group-' + list[i].key;
        section.setAttribute('aria-labelledby', headingId);
        var heading = element('h2', 'agent-group-heading', list[i].title);
        heading.id = headingId;
        section.appendChild(heading);
        for (var j = 0; j < list[i].entries.length; j += 1) {
          var entry = list[i].entries[j];
          if (entry.agent) section.appendChild(row(entry.agent));
          for (var k = 0; k < entry.sessions.length; k += 1) section.appendChild(sessionRow(entry.sessions[k]));
        }
        groupsNode.appendChild(section);
      }
      var sentence = sessionsSentence(state);
      if (sentence) groupsNode.appendChild(element('p', 'agents-message agents-sessions-message', sentence));
      if (focusedId) {
        var again = groupsNode.querySelector('[data-agent="' + focusedId + '"]');
        if (again) again.focus();
      }
    }

    function messageNode(entry) {
      var role = entry.role === 'user' || entry.role === 'system' ? entry.role : 'assistant';
      var node = element('div', 'thread-message thread-message-' + role);
      node.appendChild(element('div', 'thread-message-text', typeof entry.text === 'string' ? entry.text : ''));
      var meta = element('div', 'thread-message-meta');
      if (entry.truncated) meta.appendChild(element('span', null, 'Cut short. '));
      meta.appendChild(timeSpan(null, entry.at));
      node.appendChild(meta);
      return node;
    }

    // The pane scrolls to the newest message when a thread first shows and
    // when the reader is already at the end; a reader who scrolled up stays
    // where they were. A Claude terminal has no messages: its pane says
    // where the session runs, then its state.
    function renderMessages() {
      var agent = selectedAgent();
      var atEnd = messagesNode.scrollHeight - messagesNode.scrollTop - messagesNode.clientHeight <= SCROLL_END_PX;
      var follow = thread.fresh || atEnd;
      messagesNode.textContent = '';
      renderedVersion = thread.version;
      if (isTerminal(agent)) {
        messagesNode.appendChild(element('p', 'thread-line', 'This session runs in a cmux terminal.'));
        messagesNode.appendChild(element('p', 'thread-line', terminalState(agent)));
        return;
      }
      if (!hasThread(agent) || agent.state === 'unavailable') return;
      if (thread.error) {
        var line = element('p', 'thread-line');
        line.appendChild(document.createTextNode('The thread could not be loaded. '));
        line.appendChild(button('link-button', 'Retry', 'retry-thread'));
        messagesNode.appendChild(line);
        if (thread.messages === null) return;
      } else if (thread.messages === null) {
        if (thread.loading) messagesNode.appendChild(element('p', 'thread-line', 'Opening thread.'));
        return;
      }
      thread.fresh = false;
      if (thread.messages.length === 0) {
        messagesNode.appendChild(element('p', 'thread-line', 'No messages yet.'));
        return;
      }
      for (var i = 0; i < thread.messages.length; i += 1) messagesNode.appendChild(messageNode(thread.messages[i]));
      if (follow) messagesNode.scrollTop = messagesNode.scrollHeight;
    }

    function optionButton(option) {
      var node = button('option', undefined, 'choose');
      node.setAttribute('aria-pressed', 'false');
      node.setAttribute('data-label', option.label);
      node.appendChild(element('span', 'option-label', option.label));
      if (option.description) node.appendChild(element('span', 'option-description', option.description));
      return node;
    }

    // A Codex question carries an id, which its answer is keyed by; a
    // persona's is keyed by its text.
    function questionCard(question, index) {
      var card = element('section', 'request-card');
      card.setAttribute('data-question', typeof question.id === 'string' && question.id ? question.id : question.question);
      if (question.multiSelect) card.setAttribute('data-multi', '');
      var head = element('div', 'request-head');
      if (question.header) head.appendChild(chip('request-chip', question.header));
      head.appendChild(element('h3', 'request-title', question.question));
      card.appendChild(head);
      var options = element('div', 'request-options');
      var list = Array.isArray(question.options) ? question.options : [];
      for (var i = 0; i < list.length; i += 1) {
        if (list[i] && typeof list[i].label === 'string') options.appendChild(optionButton(list[i]));
      }
      card.appendChild(options);
      var other = element('label', 'request-other');
      var otherId = 'agent-other-' + index;
      var otherLabel = element('span', 'request-other-label', 'Other');
      other.appendChild(otherLabel);
      var field = element('input', 'request-other-field');
      field.type = 'text';
      field.id = otherId;
      field.setAttribute('aria-label', 'Other answer for: ' + question.question);
      field.autocomplete = 'off';
      other.appendChild(field);
      card.appendChild(other);
      return card;
    }

    // The approval's heading: what the agent asks, by Codex's item kinds or
    // the persona's tool name.
    function approvalTitle(agent, pending) {
      var name = displayName(agent);
      switch (pending.toolName) {
        case 'commandExecution': return name + ' wants to run a command';
        case 'fileChange': return name + ' wants to change files';
        case 'permissions': return name + ' asks for permission';
        default: return name + ' wants to run ' + (pending.toolName || 'a tool');
      }
    }

    function detail(label, body) {
      var node = element('div', 'request-detail');
      node.appendChild(element('span', 'request-detail-label', label));
      node.appendChild(body);
      return node;
    }

    function detailList(items) {
      var list = element('ul');
      for (var i = 0; i < items.length; i += 1) list.appendChild(element('li', null, items[i]));
      return list;
    }

    // The permissions a Codex request asks for, as lines; [] when the
    // shape is not the one Codex sends.
    function permissionLines(permissions) {
      if (!permissions || typeof permissions !== 'object') return [];
      var lines = [];
      var fs = permissions.fileSystem;
      var entries = fs && Array.isArray(fs.entries) ? fs.entries : [];
      for (var i = 0; i < entries.length; i += 1) {
        var entry = entries[i];
        var target = entry && entry.path && typeof entry.path.path === 'string' ? entry.path.path : null;
        if (target) lines.push((typeof entry.access === 'string' ? entry.access + ' ' : '') + shortPath(target, state.home));
      }
      if (permissions.network) lines.push('network');
      return lines;
    }

    // The parts of a Codex approval worth reading on their own: the command
    // and folder of a command, the files of a change, the permissions asked
    // for, and the reason given. Null when the input carries none of them
    // or arrived cut short; a persona's input stays JSON.
    function approvalDetails(agent, pending) {
      if (!isSession(agent) || pending.truncated) return null;
      var input = typeof pending.input === 'string' ? parse(pending.input) : pending.input;
      if (!input || typeof input !== 'object') return null;
      var node = element('div', 'request-details');
      var command = Array.isArray(input.command) ? input.command.join(' ') : input.command;
      if (typeof command === 'string' && command) node.appendChild(detail('Command', element('pre', 'request-input', command)));
      var folder = typeof input.cwd === 'string' ? input.cwd : typeof input.grantRoot === 'string' ? input.grantRoot : '';
      if (folder) node.appendChild(detail('Folder', element('span', 'request-detail-text', shortPath(folder, state.home))));
      var files = [];
      var changes = Array.isArray(input.changes) ? input.changes : [];
      for (var i = 0; i < changes.length; i += 1) {
        var file = typeof changes[i] === 'string' ? changes[i] : changes[i] && changes[i].path;
        if (typeof file === 'string') files.push(shortPath(file, state.home));
      }
      if (files.length > 0) node.appendChild(detail('Files', detailList(files)));
      var permissions = permissionLines(input.permissions);
      if (permissions.length > 0) node.appendChild(detail('Permissions', detailList(permissions)));
      if (typeof input.reason === 'string' && input.reason.trim()) {
        node.appendChild(detail('Reason', element('span', 'request-detail-text', input.reason.trim())));
      }
      return node.childNodes.length > 0 ? node : null;
    }

    function renderRequest(agent) {
      var pending = hasThread(agent) && agent.state === 'waiting' ? agent.pending : null;
      var key = pending ? agent.id + '|' + pending.requestId : '';
      if (request.getAttribute('data-request') === key) {
        setRequestBusy();
        return;
      }
      request.setAttribute('data-request', key);
      request.textContent = '';
      request.hidden = !pending;
      if (!pending) return;
      var native = pending.native === true;
      if (pending.kind === 'approval') {
        var card = element('section', 'request-card');
        card.appendChild(element('h3', 'request-title', approvalTitle(agent, pending)));
        card.appendChild(approvalDetails(agent, pending) || element('pre', 'request-input', formatInput(pending)));
        if (pending.truncated) card.appendChild(element('p', 'request-note', 'Input cut short.'));
        if (native) {
          card.appendChild(element('p', 'request-note', TERMINAL_ONLY));
        } else {
          var actions = element('div', 'request-actions');
          actions.appendChild(button('button button-primary', 'Allow', 'allow'));
          actions.appendChild(button('button', 'Deny', 'deny'));
          card.appendChild(actions);
        }
        request.appendChild(card);
      } else {
        var questions = questionsOf(pending);
        for (var i = 0; i < questions.length; i += 1) {
          if (questions[i] && typeof questions[i].question === 'string') request.appendChild(questionCard(questions[i], i));
        }
        if (native) {
          request.appendChild(element('p', 'request-note', TERMINAL_ONLY));
        } else {
          var answerRow = element('div', 'request-actions');
          answerRow.appendChild(button('button button-primary', 'Answer', 'answer'));
          var missing = element('span', 'request-missing');
          missing.setAttribute('role', 'status');
          answerRow.appendChild(missing);
          request.appendChild(answerRow);
        }
      }
      setRequestBusy();
    }

    function setRequestBusy() {
      var buttons = request.querySelectorAll('button');
      for (var i = 0; i < buttons.length; i += 1) buttons[i].disabled = busy;
    }

    // One answer per question. A multi-select question sends its pressed
    // labels plus the Other text when given; a single-select question sends
    // the Other text when typed, else the pressed label. Returns null and
    // marks the first unanswered question otherwise.
    function collectAnswers() {
      var cards = request.querySelectorAll('.request-card[data-question]');
      var answers = {};
      var missingNode = request.querySelector('.request-missing');
      for (var i = 0; i < cards.length; i += 1) {
        var card = cards[i];
        var labels = [];
        var pressed = card.querySelectorAll('.option[aria-pressed="true"]');
        for (var j = 0; j < pressed.length; j += 1) labels.push(pressed[j].getAttribute('data-label'));
        var other = card.querySelector('.request-other-field').value.trim();
        var multi = card.hasAttribute('data-multi');
        if (other && (multi || labels.length === 0)) labels.push(other);
        if (labels.length === 0) {
          if (missingNode) missingNode.textContent = 'Every question needs an answer.';
          card.querySelector('.option, .request-other-field').focus();
          return null;
        }
        answers[card.getAttribute('data-question')] = multi ? labels : other || labels[0];
      }
      if (missingNode) missingNode.textContent = '';
      return answers;
    }

    // Whether the overview is on screen: the pane shows it whenever no
    // agent is open, and on a phone the pane itself shows only once the
    // Routines row was chosen.
    function overviewShown() {
      return visible && !selectedId && (overviewOpen || wide.matches);
    }

    // Tells `routines` when the overview comes on or goes off screen, and
    // only then: it rebuilds the overview itself on every state change.
    function syncOverview() {
      var shown = overviewShown();
      if (!routines || shown === overviewTold) return;
      overviewTold = shown;
      if (shown) routines.show();
      else routines.hide();
    }

    // What is off, above the overview's heading; nothing while both answer.
    function renderAvailability() {
      availability.textContent = '';
      var lines = [codexSentence(state.codex), cmuxSentence(state.cmux)];
      for (var i = 0; i < lines.length; i += 1) if (lines[i]) availability.appendChild(element('p', null, lines[i]));
      availability.hidden = availability.childNodes.length === 0;
    }

    function renderThread() {
      var agent = selectedAgent();
      view.classList.toggle('agents-open', !!selectedId || overviewOpen);
      overview.hidden = !!selectedId;
      syncOverview();
      renderMessage();
      if (!selectedId) {
        empty.hidden = true;
        panel.hidden = true;
        if (routines) routines.unmount();
        return;
      }
      if (!agent) {
        empty.textContent = SESSION_ID.test(selectedId) ? 'That session is not listed.' : 'No agent named ' + selectedId + ' is registered.';
        empty.hidden = false;
        panel.hidden = true;
        if (routines) routines.unmount();
        return;
      }
      empty.hidden = true;
      panel.hidden = false;
      var persona = isPersona(agent);
      var session = isSession(agent);
      var name = displayName(agent);

      nameNode.textContent = name;
      chips.textContent = '';
      if (agent.role) chips.appendChild(chip('role-chip', agent.role));
      if (providerName(agent)) chips.appendChild(chip('provider-chip', providerName(agent)));
      cost.textContent = persona && typeof agent.costUsd === 'number' ? '$' + agent.costUsd.toFixed(2) + ' this session' : '';
      description.textContent = session ? shortPath(agent.cwd, state.home) : persona ? '' : agent.description || '';
      description.hidden = !description.textContent;

      var jobs = routines && !session ? routines.count(agent.id) : 0;
      var jobsOpen = routinesOpen && jobs > 0;
      routinesToggle.hidden = jobs === 0;
      routinesToggle.textContent = 'Routines (' + jobs + ')';
      routinesToggle.setAttribute('aria-expanded', jobsOpen ? 'true' : 'false');
      routinesSection.hidden = !jobsOpen;
      if (routines) {
        if (jobsOpen && visible) routines.mount(routinesSection, agent.id);
        else routines.unmount();
      }

      newThread.hidden = !persona;
      newThread.disabled = busy || !persona || agent.state === 'unavailable' || turnOpen(agent);
      confirmNode.hidden = !confirming;
      confirmText.textContent = 'Start a new thread? ' + name + ' will not remember this one.';

      // Open terminal: on only for a session whose terminal is bound, still
      // open, and reachable; otherwise the line under it says why, or why
      // the last attempt was refused.
      openTerminal.hidden = !session;
      var why = session ? terminalReason(agent, state) : '';
      openTerminal.disabled = !session || busy || !!why;
      terminalLine.textContent = why || terminalError;
      terminalLine.hidden = !terminalLine.textContent;

      // A failed turn, or a turn the clock stopped: the persona is idle
      // again with the reason kept until its next turn. A Codex thread
      // whose server went away says so the same way.
      var failed = hasThread(agent) && (agent.state === 'error' || (agent.state === 'idle' && !!agent.lastError) ||
        (session && agent.state === 'unavailable' && !!agent.lastError));
      notice.textContent = failed ? errorSentence(agent) : '';
      notice.hidden = !failed;

      var open = hasThread(agent) && turnOpen(agent);
      status.hidden = !open;
      statusText.textContent = !open ? '' : agent.state === 'busy' ? name + ' is working.' : name + ' is waiting for you.';
      var interrupt = status.querySelector('button');
      interrupt.disabled = busy;

      renderRequest(agent);
      // A terminal's pane is its state, so it follows every change.
      if (isTerminal(agent) || thread.version !== renderedVersion) renderMessages();

      composer.hidden = !persona;
      if (persona) {
        var reasonText = composerReason(agent);
        inputLabel.textContent = 'Message ' + name;
        input.disabled = agent.state === 'unavailable';
        send.disabled = busy || !!reasonText;
        reason.textContent = reasonText;
        reason.hidden = !reasonText;
      }
      foot.textContent = hasThread(agent) && session ? 'Codex threads take messages in the terminal.' : '';
      foot.hidden = !foot.textContent;
      failure.textContent = actionError;
      failure.hidden = !actionError;
    }

    function render() {
      if (!state) return;
      renderList();
      renderAvailability();
      renderThread();
    }

    // Fetches the thread when the selected persona's or Codex session's
    // thread may have changed: a new selection, a new last message, or a
    // turn that ended. `force` fetches it again regardless, for Retry.
    function syncThread(force) {
      var agent = selectedAgent();
      if (!hasThread(agent) || agent.state === 'unavailable') return;
      var key = agent.id + '|' + JSON.stringify(agent.lastMessage) + '|' + (turnOpen(agent) ? 'open' : 'closed');
      if (key === threadKey && !force) return;
      threadKey = key;
      fetchThread(agent);
    }

    function fetchThread(agent) {
      var id = agent.id;
      var seq = ++threadSeq;
      var controller = new AbortController();
      var timer = setTimeout(function () { controller.abort(); }, THREAD_TIMEOUT_MS);
      thread.loading = true;
      if (thread.messages === null) bumpThread();
      fetch(routeBase(agent) + '/thread', { cache: 'no-store', credentials: 'same-origin', signal: controller.signal })
        .then(function (response) { return response.ok ? response.json() : null; }, function () { return null; })
        .then(function (body) {
          clearTimeout(timer);
          if (seq !== threadSeq || thread.id !== id) return;
          thread.loading = false;
          if (body && Array.isArray(body.messages)) {
            thread.messages = body.messages;
            thread.error = false;
          } else {
            // The last good messages stay; the next state change fetches again.
            thread.error = true;
            threadKey = null;
          }
          bumpThread();
        });
    }

    function bumpThread() {
      thread.version += 1;
      if (visible) renderMessages();
    }

    function resetThread(id) {
      threadSeq += 1;
      thread = { id: id, messages: null, loading: false, error: false, fresh: true, version: thread.version + 1 };
      threadKey = null;
    }

    // Puts the current draft away and brings out the chosen agent's.
    function setSelected(id) {
      if (selectedId) drafts[selectedId] = input.value;
      selectedId = id;
      input.value = (id && drafts[id]) || '';
      actionError = '';
      terminalError = '';
      confirming = false;
      routinesOpen = false;
      resetThread(id);
    }

    // A history entry is added only when the URL names a different agent
    // (or the phone's overview), so choosing the open row from `/agents`
    // or `/?agent=` adds nothing.
    function select(id, push) {
      if (push && (agentFromUrl() !== id || overviewOpen)) history.pushState(null, '', agentUrl(id));
      overviewOpen = false;
      if (id === selectedId) return;
      setSelected(id);
      render();
      syncThread();
      if (isPersona(selectedAgent()) && wide.matches) input.focus();
    }

    // Resolves with { ok, status, code, reason }, or null when the request
    // itself failed.
    function post(path, body) {
      var init = { method: 'POST', cache: 'no-store', credentials: 'same-origin' };
      if (body !== undefined) {
        init.headers = { 'content-type': 'application/json' };
        init.body = JSON.stringify(body);
      }
      return fetch(path, init).then(function (response) {
        return response.text().then(function (text) {
          var json = parse(text);
          return {
            ok: response.ok,
            status: response.status,
            code: json && typeof json.error === 'string' ? json.error : null,
            reason: json && typeof json.reason === 'string' ? json.reason : null,
          };
        }, function () {
          return { ok: response.ok, status: response.status, code: null, reason: null };
        });
      }, function () {
        return null;
      });
    }

    // Runs one persona or session action; the outcome lands in the state,
    // so a success only clears the failure line and asks for the state when
    // not streaming. The failure line and onDone(ok) belong to the agent
    // acted on: when another thread has been opened meanwhile, neither
    // touches it.
    function act(agent, action, body, onDone) {
      if (busy) return;
      busy = true;
      actionError = '';
      renderThread();
      post(routeBase(agent) + '/' + action, body).then(function (result) {
        busy = false;
        var ok = !!(result && result.ok);
        var current = agent.id === selectedId;
        if (ok) {
          if (!shell.isStreaming()) shell.requestState();
        } else if (result && result.code === 'no_such_request') {
          shell.requestState();
        }
        if (current && !ok) actionError = refusalSentence(result, agent);
        renderThread();
        if (current && onDone) onDone(ok);
      });
    }

    // Asks cmux to focus the session's terminal. A success shows nothing:
    // the terminal has the focus. A refusal is said under the button until
    // the next attempt or another session is chosen.
    function openSessionTerminal(session) {
      if (busy) return;
      busy = true;
      terminalError = '';
      renderThread();
      post(routeBase(session) + '/open-terminal').then(function (result) {
        busy = false;
        var ok = !!(result && result.ok);
        if (session.id === selectedId && !ok) terminalError = openRefusal(result);
        if (!ok && result && (result.code === 'terminal_closed' || result.code === 'no_such_session')) shell.requestState();
        renderThread();
        if (session.id === selectedId) openTerminal.focus();
      });
    }

    // Where the keyboard lands once a request or approval is settled.
    function focusComposer() {
      if (!composer.hidden && !input.disabled) input.focus();
      else if (!status.hidden) status.focus();
    }

    function sendMessage() {
      var agent = selectedAgent();
      if (!isPersona(agent) || send.disabled) return;
      var text = input.value.trim();
      if (!text) {
        input.focus();
        return;
      }
      act(agent, 'send', { text: text }, function (ok) {
        if (ok) input.value = '';
        input.focus();
      });
    }

    function answerQuestion(agent) {
      var answers = collectAnswers();
      if (!answers) return;
      act(agent, 'answer', { requestId: agent.pending.requestId, answers: answers }, focusComposer);
    }

    function toggleOption(node) {
      var card = node.closest('.request-card');
      var pressed = node.getAttribute('aria-pressed') === 'true';
      if (!card.hasAttribute('data-multi')) {
        var siblings = card.querySelectorAll('.option');
        for (var i = 0; i < siblings.length; i += 1) siblings[i].setAttribute('aria-pressed', 'false');
      }
      node.setAttribute('aria-pressed', pressed ? 'false' : 'true');
    }

    view.addEventListener('click', function (event) {
      var target = event.target;
      var link = target.closest && target.closest('a[data-agent]');
      if (link) {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        select(link.getAttribute('data-agent'), true);
        return;
      }
      var back = target.closest && target.closest('#agent-back');
      if (back) {
        event.preventDefault();
        select(null, true);
        return;
      }
      var node = target.closest && target.closest('button[data-agent-action]');
      if (!node || node.disabled) return;
      var agent = selectedAgent();
      switch (node.getAttribute('data-agent-action')) {
        case 'choose':
          toggleOption(node);
          break;
        case 'answer':
          if (agent && agent.pending) answerQuestion(agent);
          break;
        case 'allow':
        case 'deny':
          if (agent && agent.pending) {
            act(agent, 'answer', { requestId: agent.pending.requestId, decision: node.getAttribute('data-agent-action') }, focusComposer);
          }
          break;
        case 'interrupt':
          if (agent) act(agent, 'interrupt');
          break;
        case 'open-terminal':
          if (isSession(agent)) openSessionTerminal(agent);
          break;
        case 'new-thread':
          confirming = true;
          renderThread();
          confirmNode.querySelector('button').focus();
          break;
        case 'confirm-new-thread':
          confirming = false;
          if (agent) act(agent, 'new-thread', undefined, function () { newThread.focus(); });
          break;
        case 'cancel-new-thread':
          confirming = false;
          renderThread();
          newThread.focus();
          break;
        case 'retry-thread':
          syncThread(true);
          break;
        case 'toggle-routines':
          routinesOpen = !routinesOpen;
          renderThread();
          break;
        default:
          break;
      }
    });

    composer.addEventListener('submit', function (event) {
      event.preventDefault();
      sendMessage();
    });

    input.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        sendMessage();
      }
    });

    // Crossing 720px moves the overview on or off screen with no agent open;
    // with one open, nothing here changes and nothing is rebuilt.
    wide.addEventListener('change', function () {
      if (visible) renderThread();
    });

    return {
      update: function (next, keys) {
        state = next;
        var touched = !keys || keys.some(function (key) { return WATCHED.indexOf(key) !== -1; });
        if (touched && visible) {
          render();
          syncThread();
        }
      },
      show: function () {
        visible = true;
        var id = agentFromUrl();
        overviewOpen = location.pathname === '/routines';
        if (id !== selectedId) setSelected(id);
        if (tick === null) tick = setInterval(function () { refreshTimes(view); }, TICK_MS);
        render();
        syncThread();
      },
      hide: function () {
        visible = false;
        if (tick !== null) clearInterval(tick);
        tick = null;
        syncOverview();
        if (routines) routines.unmount();
      },
    };
  }

  window.DashboardAgents = {
    create: create,
    routinesCount: routinesCount,
    groups: groups,
    errorSentence: errorSentence,
    composerReason: composerReason,
    refusalSentence: refusalSentence,
    previewText: previewText,
    stateLine: stateLine,
    formatInput: formatInput,
    displayName: displayName,
    shortPath: shortPath,
    sessionsSentence: sessionsSentence,
    codexSentence: codexSentence,
    cmuxSentence: cmuxSentence,
    terminalReason: terminalReason,
    openRefusal: openRefusal,
    terminalState: terminalState,
  };
}());
