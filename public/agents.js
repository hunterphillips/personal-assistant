// Agents view: the registry's agents as a list grouped Work and Personal,
// and one persona's thread beside it. The shell calls create({ requestState,
// isStreaming }) once, then update(state, keys) on every change (keys is
// null for a whole snapshot), show() when the view opens, and hide() when it
// closes or the tab is hidden. The list is rebuilt only while the view is
// shown; show() renders the latest state.
//
// The open agent is `?agent=<id>` in the URL, so a reload lands on the same
// thread and Back and Forward move between threads. Choosing a row pushes
// that URL; the shell's popstate handler calls show(), which reads it back.
//
// The thread is fetched from /api/agents/<id>/thread when a persona opens
// and again whenever the snapshot shows its last message or its turn
// changed, so the pane follows the turn without rebuilding it from deltas.
// A question or approval is rendered from the snapshot's `pending`; the
// card is rebuilt only when the request changes, so choices survive other
// state changes. Send, Answer, Allow, Deny, Interrupt, and New thread post
// to the persona routes; a refusal is reported under the composer until the
// next attempt.
(function () {
  'use strict';

  var GROUPS = [['work', 'Work'], ['personal', 'Personal']];
  var PROVIDERS = { claude: 'Claude', codex: 'Codex' };
  var WATCHED = ['agents', 'registry'];
  var AGENT_ID = /^[a-z][a-z0-9-]{1,31}$/;
  var TICK_MS = 60000;
  var THREAD_TIMEOUT_MS = 8000;
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

  function turnOpen(agent) {
    return agent.state === 'busy' || agent.state === 'waiting';
  }

  // The agents under each group heading, in registry order; groups with no
  // agents are left out.
  function groups(agents) {
    var result = [];
    for (var i = 0; i < GROUPS.length; i += 1) {
      var members = (agents || []).filter(function (agent) { return agent.group === GROUPS[i][0]; });
      if (members.length > 0) result.push({ key: GROUPS[i][0], title: GROUPS[i][1], agents: members });
    }
    return result;
  }

  // What the Home card says under Agents.
  function summary(state) {
    var agents = state && state.agents ? state.agents : [];
    var waiting = agents.filter(function (agent) { return agent.state === 'waiting'; }).map(function (agent) { return agent.name; });
    if (waiting.length === 1) return waiting[0] + ' is waiting for you';
    if (waiting.length === 2) return waiting[0] + ' and ' + waiting[1] + ' are waiting for you';
    if (waiting.length > 2) return waiting.length + ' agents are waiting for you';
    if (agents.length === 0) return '';
    return agents.length === 1 ? '1 agent' : agents.length + ' agents';
  }

  // The persona's lastError as a sentence the reader can act on. The
  // adapter's own messages are already sentences and pass through.
  function errorSentence(agent) {
    var code = agent.lastError;
    switch (code) {
      case 'api_key_in_env':
        return 'The dashboard started with an API key in its environment, so personas are off. Unset it and restart the dashboard.';
      case 'start_failed':
        return 'The session file for ' + agent.name + ' could not be read. Check the threads directory, then restart the dashboard.';
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
    switch (result.code) {
      case 'busy': return agent.name + ' is still working. Wait for the reply.';
      case 'no_such_request': return 'That request was already answered or has expired.';
      case 'shutting_down': return 'The dashboard is shutting down. Try again in a moment.';
      case 'persona_unavailable': return agent.name + ' is unavailable.';
      case 'thread_reset_failed': return 'The thread could not be reset. Check the dashboard log.';
      case 'invalid_text': return 'Type a message first.';
      case 'payload_too_large': return 'The message is too long. Shorten it.';
      case 'invalid_answer': return 'That answer could not be sent.';
      case 'not_a_persona': return agent.name + ' has no thread.';
      case 'invalid_agent': return 'That agent is not in the registry.';
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

  // The row's state line for a persona, or null.
  function stateLine(agent) {
    if (!isPersona(agent)) return null;
    switch (agent.state) {
      case 'waiting': return { text: 'Waiting for you', tone: 'wait' };
      case 'busy': return { text: 'Working', tone: 'muted' };
      case 'error': return { text: 'The last turn failed', tone: 'bad' };
      case 'unavailable': return { text: 'Unavailable', tone: 'muted' };
      default: return null;
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
    return id && AGENT_ID.test(id) ? id : null;
  }

  function create(shell) {
    var view = document.getElementById('view-agents');
    var listPane = document.getElementById('agents-list');
    var message = document.getElementById('agents-message');
    var groupsNode = document.getElementById('agents-groups');
    var pane = document.getElementById('agent-thread');
    var empty = document.getElementById('agent-empty');
    var panel = document.getElementById('agent-panel');
    var nameNode = document.getElementById('agent-name');
    var chips = document.getElementById('agent-chips');
    var cost = document.getElementById('agent-cost');
    var newThread = document.getElementById('agent-new-thread');
    var confirmNode = document.getElementById('agent-confirm');
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
    var thread = { id: null, messages: null, loading: false, error: false, version: 0 };
    var renderedVersion = -1;
    var threadKey = null; // what the thread was last fetched against
    var threadSeq = 0;
    var busy = false; // one of our POSTs is out
    var actionError = ''; // why the last POST failed, or ''
    var confirming = false; // New thread awaits confirmation
    var tick = null;

    function selectedAgent() {
      if (!state || !selectedId) return null;
      var agents = state.agents || [];
      for (var i = 0; i < agents.length; i += 1) if (agents[i].id === selectedId) return agents[i];
      return null;
    }

    function chip(className, text) {
      return element('span', className, text);
    }

    function row(agent) {
      var persona = isPersona(agent);
      var node = persona ? element('a', 'agent-row') : element('div', 'agent-row agent-row-plain');
      if (persona) node.href = '/agents?agent=' + agent.id;
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

    function renderList() {
      if (!state) return;
      groupsNode.textContent = '';
      var registry = state.registry;
      if (registry && registry.ok === false) message.textContent = 'The registry could not be read.';
      else if ((state.agents || []).length === 0) message.textContent = 'No agents are registered.';
      else message.textContent = '';
      message.hidden = !message.textContent;

      var list = groups(state.agents);
      for (var i = 0; i < list.length; i += 1) {
        var section = element('section', 'agent-group');
        var headingId = 'agents-group-' + list[i].key;
        section.setAttribute('aria-labelledby', headingId);
        var heading = element('h2', 'agent-group-heading', list[i].title);
        heading.id = headingId;
        section.appendChild(heading);
        for (var j = 0; j < list[i].agents.length; j += 1) section.appendChild(row(list[i].agents[j]));
        groupsNode.appendChild(section);
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

    function renderMessages() {
      var agent = selectedAgent();
      messagesNode.textContent = '';
      renderedVersion = thread.version;
      if (!isPersona(agent) || agent.state === 'unavailable') return;
      if (thread.error) {
        var line = element('p', 'thread-line');
        line.appendChild(document.createTextNode('The thread could not be loaded. '));
        line.appendChild(button('link-button', 'Retry', 'retry-thread'));
        messagesNode.appendChild(line);
        return;
      }
      if (thread.messages === null) {
        if (thread.loading) messagesNode.appendChild(element('p', 'thread-line', 'Opening thread.'));
        return;
      }
      if (thread.messages.length === 0) {
        messagesNode.appendChild(element('p', 'thread-line', 'No messages yet.'));
        return;
      }
      for (var i = 0; i < thread.messages.length; i += 1) messagesNode.appendChild(messageNode(thread.messages[i]));
      messagesNode.scrollTop = messagesNode.scrollHeight;
    }

    function optionButton(option) {
      var node = button('option', undefined, 'choose');
      node.setAttribute('aria-pressed', 'false');
      node.setAttribute('data-label', option.label);
      node.appendChild(element('span', 'option-label', option.label));
      if (option.description) node.appendChild(element('span', 'option-description', option.description));
      return node;
    }

    function questionCard(question, index) {
      var card = element('section', 'request-card');
      card.setAttribute('data-question', question.question);
      if (question.multiSelect) card.setAttribute('data-multi', '');
      var head = element('div', 'request-head');
      if (question.header) head.appendChild(chip('request-chip', question.header));
      head.appendChild(element('h3', 'request-title', question.question));
      card.appendChild(head);
      var options = element('div', 'request-options');
      var list = Array.isArray(question.options) ? question.options : [];
      for (var i = 0; i < list.length; i += 1) options.appendChild(optionButton(list[i]));
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

    function renderRequest(agent) {
      var pending = isPersona(agent) && agent.state === 'waiting' ? agent.pending : null;
      var key = pending ? pending.requestId : '';
      if (request.getAttribute('data-request') === key) {
        setRequestBusy();
        return;
      }
      request.setAttribute('data-request', key);
      request.textContent = '';
      request.hidden = !pending;
      if (!pending) return;
      if (pending.kind === 'approval') {
        var card = element('section', 'request-card');
        card.appendChild(element('h3', 'request-title', agent.name + ' wants to run ' + (pending.toolName || 'a tool')));
        var pre = element('pre', 'request-input', formatInput(pending));
        card.appendChild(pre);
        if (pending.truncated) card.appendChild(element('p', 'request-note', 'Input cut short.'));
        var actions = element('div', 'request-actions');
        actions.appendChild(button('button button-primary', 'Allow', 'allow'));
        actions.appendChild(button('button', 'Deny', 'deny'));
        card.appendChild(actions);
        request.appendChild(card);
      } else {
        var questions = questionsOf(pending);
        for (var i = 0; i < questions.length; i += 1) request.appendChild(questionCard(questions[i], i));
        var answerRow = element('div', 'request-actions');
        answerRow.appendChild(button('button button-primary', 'Answer', 'answer'));
        var missing = element('span', 'request-missing');
        missing.setAttribute('role', 'status');
        answerRow.appendChild(missing);
        request.appendChild(answerRow);
      }
      setRequestBusy();
    }

    function setRequestBusy() {
      var buttons = request.querySelectorAll('button');
      for (var i = 0; i < buttons.length; i += 1) buttons[i].disabled = busy;
    }

    // One answer per question: the pressed labels, plus the Other text when
    // given. Returns null and marks the first unanswered question otherwise.
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
        if (other) labels.push(other);
        if (labels.length === 0) {
          if (missingNode) missingNode.textContent = 'Every question needs an answer.';
          card.querySelector('.option, .request-other-field').focus();
          return null;
        }
        answers[card.getAttribute('data-question')] = card.hasAttribute('data-multi') ? labels : labels[0];
      }
      if (missingNode) missingNode.textContent = '';
      return answers;
    }

    function renderThread() {
      var agent = selectedAgent();
      view.classList.toggle('agents-open', !!selectedId);
      if (!selectedId) {
        empty.textContent = 'Choose an agent.';
        empty.hidden = false;
        panel.hidden = true;
        return;
      }
      if (!agent) {
        empty.textContent = 'No agent named ' + selectedId + ' is registered.';
        empty.hidden = false;
        panel.hidden = true;
        return;
      }
      empty.hidden = true;
      panel.hidden = false;
      var persona = isPersona(agent);

      nameNode.textContent = agent.name;
      chips.textContent = '';
      if (agent.role) chips.appendChild(chip('role-chip', agent.role));
      if (providerName(agent)) chips.appendChild(chip('provider-chip', providerName(agent)));
      cost.textContent = persona && typeof agent.costUsd === 'number' ? '$' + agent.costUsd.toFixed(2) + ' this session' : '';
      description.textContent = persona ? '' : agent.description || '';
      description.hidden = !description.textContent;

      newThread.hidden = !persona;
      newThread.disabled = busy || !persona || agent.state === 'unavailable' || turnOpen(agent);
      confirmNode.hidden = !confirming;

      var failed = persona && agent.state === 'error';
      notice.textContent = failed ? errorSentence(agent) : '';
      notice.hidden = !failed;

      status.hidden = !(persona && agent.state === 'busy');
      statusText.textContent = persona && agent.state === 'busy' ? agent.name + ' is working.' : '';
      var interrupt = status.querySelector('button');
      interrupt.disabled = busy;

      renderRequest(agent);
      if (thread.version !== renderedVersion) renderMessages();

      composer.hidden = !persona;
      if (persona) {
        var why = composerReason(agent);
        inputLabel.textContent = 'Message ' + agent.name;
        input.disabled = agent.state === 'unavailable';
        send.disabled = busy || !!why;
        reason.textContent = why;
        reason.hidden = !why;
      }
      failure.textContent = actionError;
      failure.hidden = !actionError;
    }

    function render() {
      if (!state) return;
      renderList();
      renderThread();
    }

    // Fetches the thread when the selected persona's thread may have
    // changed: a new selection, a new last message, or a turn that ended.
    function syncThread() {
      var agent = selectedAgent();
      if (!isPersona(agent) || agent.state === 'unavailable') return;
      var key = agent.id + '|' + JSON.stringify(agent.lastMessage) + '|' + (turnOpen(agent) ? 'open' : 'closed');
      if (key === threadKey) return;
      threadKey = key;
      fetchThread(agent.id);
    }

    function fetchThread(id) {
      var seq = ++threadSeq;
      var controller = new AbortController();
      var timer = setTimeout(function () { controller.abort(); }, THREAD_TIMEOUT_MS);
      thread.loading = true;
      if (thread.messages === null) bumpThread();
      fetch('/api/agents/' + id + '/thread', { cache: 'no-store', credentials: 'same-origin', signal: controller.signal })
        .then(function (response) { return response.ok ? response.json() : null; }, function () { return null; })
        .then(function (body) {
          clearTimeout(timer);
          if (seq !== threadSeq || thread.id !== id) return;
          thread.loading = false;
          if (body && Array.isArray(body.messages)) {
            thread.messages = body.messages;
            thread.error = false;
          } else {
            thread.error = true;
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
      thread = { id: id, messages: null, loading: false, error: false, version: thread.version + 1 };
      threadKey = null;
    }

    function select(id, push) {
      if (push) history.pushState(null, '', id ? '/agents?agent=' + id : '/agents');
      if (id === selectedId) return;
      selectedId = id;
      actionError = '';
      confirming = false;
      resetThread(id);
      render();
      syncThread();
      if (isPersona(selectedAgent()) && window.matchMedia('(min-width: 720px)').matches) input.focus();
    }

    // Resolves with { ok, status, code }, or null when the request itself
    // failed.
    function post(path, body) {
      var init = { method: 'POST', cache: 'no-store', credentials: 'same-origin' };
      if (body !== undefined) {
        init.headers = { 'content-type': 'application/json' };
        init.body = JSON.stringify(body);
      }
      return fetch(path, init).then(function (response) {
        return response.text().then(function (text) {
          var json = parse(text);
          return { ok: response.ok, status: response.status, code: json && typeof json.error === 'string' ? json.error : null };
        }, function () {
          return { ok: response.ok, status: response.status, code: null };
        });
      }, function () {
        return null;
      });
    }

    // Runs one persona action; the outcome lands in the state, so a success
    // only clears the failure line and asks for the state when not streaming.
    function act(agent, action, body, onSuccess) {
      if (busy) return;
      busy = true;
      actionError = '';
      renderThread();
      post('/api/agents/' + agent.id + '/' + action, body).then(function (result) {
        busy = false;
        if (result && result.ok) {
          if (onSuccess) onSuccess();
          if (!shell.isStreaming()) shell.requestState();
        } else {
          actionError = refusalSentence(result, agent);
          if (result && result.code === 'no_such_request') shell.requestState();
        }
        renderThread();
      });
    }

    function sendMessage() {
      var agent = selectedAgent();
      if (!isPersona(agent) || send.disabled) return;
      var text = input.value.trim();
      if (!text) {
        input.focus();
        return;
      }
      act(agent, 'send', { text: text }, function () {
        input.value = '';
      });
    }

    function answerQuestion(agent) {
      var answers = collectAnswers();
      if (!answers) return;
      act(agent, 'answer', { requestId: agent.pending.requestId, answers: answers });
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
            act(agent, 'answer', { requestId: agent.pending.requestId, decision: node.getAttribute('data-agent-action') });
          }
          break;
        case 'interrupt':
          if (agent) act(agent, 'interrupt');
          break;
        case 'new-thread':
          confirming = true;
          renderThread();
          confirmNode.querySelector('button').focus();
          break;
        case 'confirm-new-thread':
          confirming = false;
          if (agent) act(agent, 'new-thread');
          break;
        case 'cancel-new-thread':
          confirming = false;
          renderThread();
          newThread.focus();
          break;
        case 'retry-thread':
          if (agent) fetchThread(agent.id);
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
        if (id !== selectedId) {
          selectedId = id;
          actionError = '';
          confirming = false;
          resetThread(id);
        }
        if (tick === null) tick = setInterval(function () { refreshTimes(view); }, TICK_MS);
        render();
        syncThread();
      },
      hide: function () {
        visible = false;
        if (tick !== null) clearInterval(tick);
        tick = null;
      },
    };
  }

  window.DashboardAgents = {
    create: create,
    summary: summary,
    groups: groups,
    errorSentence: errorSentence,
    composerReason: composerReason,
    refusalSentence: refusalSentence,
    previewText: previewText,
    stateLine: stateLine,
    formatInput: formatInput,
  };
}());
