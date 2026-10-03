// One thread's column: the header with the agent's name and New thread,
// the messages, the open question or approval, the status line with
// Interrupt, and the composer with the @ picker and the model button. The
// Agents view (agents.js) mounts one beside its list, and quick chat
// (quick-chat.js) mounts another in its pane; both read and post through
// the same routes, so a message sent from either lands in the one thread.
//
// create(root, options) clones #thread-template into `root`. Each
// [data-part] becomes the id "<prefix>-<part>" (the Agents view's prefix is
// `agent`, so its ids are the ones the view always had), and data-for,
// data-controls, and data-labelledby name a part the same way. Every
// listener is on `root` or a node inside it, except the model picker's
// outside-press listener while it is open. Options:
//   prefix       the ids' prefix
//   shell        { requestState, isStreaming }
//   back         false hides "All agents" (quick chat has no list)
//   onBack()     "All agents" was chosen
//   onOpenAgent(id)  a link to another agent's thread was chosen
//   decorate(body, agent) -> body   adds to a send's body (quick chat's
//                context); onSent(agent) runs after a send is accepted
// It returns { select(id), update(state, keys), render(), blank(title),
// show(), hide(), focusInput(), selected(), destroy() }. The shell's state
// arrives through update(); nothing is drawn while hidden, and show()
// draws the latest. While shown in a visible document, an open persona
// with an unopened reply is marked read (POST /api/agents/<id>/read).
//
// The thread is fetched from <route>/thread when an entry is selected and
// again whenever the snapshot shows its last message, its turn, or the
// time of its last line outside a turn (`lastLineAt`) changed, so the
// column follows the turn without rebuilding it from deltas. A question or
// approval is rendered from the snapshot's `pending` (or, for a persona,
// the oldest card forwarded to it); the card is rebuilt only when the
// request changes, so choices survive other state changes. A refusal is
// reported under the composer until the next attempt. Drafts are one map
// per page, by agent id, shared by every instance: typing writes it and
// select() reads it, so a draft typed in the pane is there when the Agents
// view opens that agent; two instances showing one agent at once do not
// follow each other live.
(function () {
  'use strict';

  var drafts = {}; // unsent composer text by agent id, for every instance

  function create(root, options) {
    var A = window.DashboardAgents;
    var H = A.shared;
    var element = H.element;
    var button = H.button;
    var parse = H.parse;
    var post = H.post;
    var detail = H.detail;
    var detailList = H.detailList;
    var isPersona = H.isPersona;
    var isSession = H.isSession;
    var isTerminal = H.isTerminal;
    var hasThread = H.hasThread;
    var turnOpen = H.turnOpen;
    var providerName = H.providerName;
    var shortPath = H.shortPath;
    var displayName = H.displayName;
    var effortNameOf = H.effortNameOf;
    var modelRefusal = H.modelRefusal;
    var questionsOf = H.questionsOf;
    var routeBase = H.routeBase;
    var EFFORTS = H.EFFORTS;
    var TERMINAL_ONLY = H.TERMINAL_ONLY;
    var FORWARDED_NOTE = H.FORWARDED_NOTE;
    var SCROLL_END_PX = H.SCROLL_END_PX;
    var THREAD_TIMEOUT_MS = H.THREAD_TIMEOUT_MS;
    var roleChip = A.roleChip;
    var errorSentence = A.errorSentence;
    var composerReason = A.composerReason;
    var modelButtonText = A.modelButtonText;
    var refusalSentence = A.refusalSentence;
    var mentionIds = A.mentionIds;
    var mentionCandidates = A.mentionCandidates;
    var formatInput = A.formatInput;
    var terminalState = A.terminalState;

    options = options || {};
    var prefix = options.prefix;
    var shell = options.shell;
    var WATCHED = ['agents', 'groups', 'registry', 'sessions', 'codex', 'cmux', 'settings', 'models'];

    root.appendChild(document.getElementById('thread-template').content.cloneNode(true));
    function partId(name) { return prefix + '-' + name; }
    var parts = root.querySelectorAll('[data-part]');
    for (var p = 0; p < parts.length; p += 1) parts[p].id = partId(parts[p].getAttribute('data-part'));
    var refs = [['data-for', 'for'], ['data-controls', 'aria-controls'], ['data-labelledby', 'aria-labelledby']];
    for (var r = 0; r < refs.length; r += 1) {
      var linked = root.querySelectorAll('[' + refs[r][0] + ']');
      for (var q = 0; q < linked.length; q += 1) linked[q].setAttribute(refs[r][1], partId(linked[q].getAttribute(refs[r][0])));
    }
    function part(name) { return root.querySelector('[data-part="' + name + '"]'); }

    var back = part('back');
    var nameNode = part('name');
    var chips = part('chips');
    var cost = part('cost');
    var newThread = part('new-thread');
    var confirmNode = part('confirm');
    var confirmText = part('confirm-text');
    var description = part('description');
    var notice = part('notice');
    var messagesNode = part('messages');
    var status = part('status');
    var statusText = part('status-text');
    var request = part('request');
    var composer = part('composer');
    var inputLabel = part('input-label');
    var input = part('input');
    var send = part('send');
    var reason = part('composer-reason');
    var failure = part('failure');
    var modelButton = part('model');
    var modelLabel = part('model-label');
    var modelNote = part('model-note');
    var modelMenu = part('model-menu');
    var modelList = part('model-list');
    var effortRow = part('effort-row');
    var modelReset = part('model-reset');
    var mentionMenu = part('mention-menu');
    var foot = part('foot');
    if (options.back === false) back.remove();

    var renderer = H.messageRenderer(function () { return (state && state.agents) || []; });
    var messageNode = renderer.messageNode;
    var dayKey = renderer.dayKey;
    var dayLine = renderer.dayLine;

    var state = null;
    var visible = false;
    var selectedId = null;
    var thread = { id: null, messages: null, loading: false, error: false, fresh: true, version: 0 };
    var renderedVersion = -1;
    var threadKey = null; // what the thread was last fetched against
    var threadSeq = 0;
    var busy = false; // one of our POSTs is out
    var actionError = ''; // why the selected agent's last POST failed, or ''
    var confirming = false; // New thread awaits confirmation
    var menuOpen = false; // the model picker is open for the selected agent
    var menuKey = null; // what the picker was last built from
    var mention = null; // the open @ picker: { start, candidates, index }, or null
    var markingRead = null; // the persona whose bodyless read request is out
    var tick = null;

    function chip(className, text) {
      return element('span', className, text);
    }

    // The listed agent with this id, or null.
    function agentById(id) {
      var agents = (state && state.agents) || [];
      for (var i = 0; i < agents.length; i += 1) if (agents[i].id === id) return agents[i];
      return null;
    }

    // The open agent or session, or null.
    function selectedAgent() {
      if (!state || !selectedId) return null;
      var lists = [state.agents || [], state.sessions || []];
      for (var l = 0; l < lists.length; l += 1) {
        for (var i = 0; i < lists[l].length; i += 1) if (lists[l][i].id === selectedId) return lists[l][i];
      }
      return null;
    }

    // The card the thread shows: the agent's own request while it waits,
    // else the oldest request forwarded here (raised by another agent
    // while answering a delegation that started in this thread). `owner`
    // is the agent whose request it is.
    function shownRequest(agent) {
      if (!agent || !hasThread(agent)) return null;
      if (agent.state === 'waiting' && agent.pending) return { pending: agent.pending, owner: agent, forwarded: false };
      if (isPersona(agent) && Array.isArray(agent.forwarded) && agent.forwarded.length > 0) {
        var card = agent.forwarded[0];
        return { pending: card, owner: agentById(card.agent) || { id: card.agent, name: card.agent }, forwarded: true };
      }
      return null;
    }

    // Opening a persona's thread in a visible document is reading it.
    function markRead(force) {
      var agent = selectedAgent();
      if (!visible || document.hidden || !isPersona(agent) || (!force && agent.unread !== true) || markingRead === agent.id) return;
      markingRead = agent.id;
      fetch('/api/agents/' + encodeURIComponent(agent.id) + '/read', {
        method: 'POST', cache: 'no-store', credentials: 'same-origin',
      }).then(function () {
        markingRead = null;
        if (!shell.isStreaming()) shell.requestState();
      }, function () {
        markingRead = null;
      });
    }

    // The pane scrolls to the newest message when a thread first shows and
    // when the reader is already at the end; a reader who scrolled up stays
    // where they were. A Claude terminal has no messages: its pane is its
    // state.
    function renderMessages() {
      var agent = selectedAgent();
      var atEnd = messagesNode.scrollHeight - messagesNode.scrollTop - messagesNode.clientHeight <= SCROLL_END_PX;
      var follow = thread.fresh || atEnd;
      messagesNode.textContent = '';
      renderedVersion = thread.version;
      if (isTerminal(agent)) {
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
      var days = 0;
      var previousDay = null;
      for (var d = 0; d < thread.messages.length; d += 1) {
        var key = dayKey(thread.messages[d]);
        if (key !== null && key !== previousDay) days += 1;
        if (key !== null) previousDay = key;
      }
      previousDay = null;
      for (var i = 0; i < thread.messages.length; i += 1) {
        var entry = thread.messages[i];
        var entryDay = dayKey(entry);
        if (days > 1 && entryDay !== null && entryDay !== previousDay) messagesNode.appendChild(dayLine(entry));
        if (entryDay !== null) previousDay = entryDay;
        messagesNode.appendChild(messageNode(entry));
      }
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
    // persona's is keyed by its text. Codex also says whether a free-text
    // answer is allowed (`isOther`, on by default) and whether the answer
    // is a secret, which is then typed into a password field.
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
      if (question.isOther === false) return card;
      var other = element('label', 'request-other');
      var otherId = prefix + '-other-' + index;
      var otherLabel = element('span', 'request-other-label', 'Other');
      other.appendChild(otherLabel);
      var field = element('input', 'request-other-field');
      field.type = question.isSecret === true ? 'password' : 'text';
      field.id = otherId;
      field.setAttribute('aria-label', 'Other answer for: ' + question.question);
      field.autocomplete = 'off';
      other.appendChild(field);
      card.appendChild(other);
      return card;
    }

    // The approval's heading: what the agent asks, by Codex's item kinds or
    // the persona's tool name. A session request of a kind this view does
    // not know is answered in the terminal, and the heading says so.
    function approvalTitle(agent, pending) {
      var name = displayName(agent);
      switch (pending.toolName) {
        case 'commandExecution': return name + ' wants to run a command';
        case 'fileChange': return name + ' wants to change files';
        case 'permissions': return name + ' asks for permission';
        default:
          if (isSession(agent)) return name + ' is waiting on the terminal';
          return name + ' wants to run ' + (pending.toolName || 'a tool');
      }
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
      var shown = shownRequest(agent);
      var pending = shown ? shown.pending : null;
      var owner = shown ? shown.owner : agent;
      var key = pending ? agent.id + '|' + pending.requestId + '|' + (shown.forwarded ? pending.agent : '') : '';
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
        card.appendChild(element('h3', 'request-title', approvalTitle(owner, pending)));
        if (shown.forwarded) card.appendChild(element('p', 'request-note', FORWARDED_NOTE));
        card.appendChild(approvalDetails(owner, pending) || element('pre', 'request-input', formatInput(pending)));
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
        if (shown.forwarded) {
          var firstHead = request.querySelector('.request-head');
          var note = element('p', 'request-note', FORWARDED_NOTE);
          if (firstHead) firstHead.parentNode.insertBefore(note, firstHead.nextSibling);
          else request.insertBefore(note, request.firstChild);
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
        var otherField = card.querySelector('.request-other-field');
        var other = otherField ? otherField.value.trim() : '';
        var multi = card.hasAttribute('data-multi');
        if (other && (multi || labels.length === 0)) labels.push(other);
        if (labels.length === 0) {
          if (missingNode) missingNode.textContent = 'Every question needs an answer.';
          var first = card.querySelector('.option, .request-other-field');
          if (first) first.focus();
          return null;
        }
        answers[card.getAttribute('data-question')] = multi ? labels : other || labels[0];
      }
      if (missingNode) missingNode.textContent = '';
      return answers;
    }

    // The column with a title and nothing else (New agent with no thread
    // open, in the Agents view).
    function blank(title) {
      nameNode.textContent = title;
      chips.textContent = '';
      cost.textContent = '';
      description.textContent = '';
      description.hidden = true;
      newThread.hidden = true;
      confirmNode.hidden = true;
      notice.textContent = '';
      notice.hidden = true;
      status.hidden = true;
      request.textContent = '';
      request.removeAttribute('data-request');
      request.hidden = true;
      messagesNode.textContent = '';
      renderedVersion = -1;
      composer.hidden = true;
      if (menuOpen) closeModelMenu(false);
      foot.textContent = '';
      foot.hidden = true;
      failure.textContent = '';
      failure.hidden = true;
    }

    function render() {
      var agent = selectedAgent();
      if (!agent) {
        blank('');
        return;
      }
      var persona = isPersona(agent);
      var session = isSession(agent);
      var name = displayName(agent);

      nameNode.textContent = name;
      chips.textContent = '';
      if (roleChip(agent)) chips.appendChild(chip('role-chip', agent.role));
      if (providerName(agent)) chips.appendChild(chip('provider-chip', providerName(agent)));
      cost.textContent = persona && typeof agent.costUsd === 'number' ? '$' + agent.costUsd.toFixed(2) + ' this session' : '';
      description.textContent = session ? shortPath(agent.cwd, state.home) : persona ? '' : agent.description || '';
      description.hidden = !description.textContent;

      newThread.hidden = !persona;
      newThread.disabled = busy || !persona || agent.state === 'unavailable' || turnOpen(agent);
      confirmNode.hidden = !confirming;
      confirmText.textContent = 'Start a new thread? ' + name + ' will not remember this one.';

      // A failed turn, or a turn the clock stopped: the persona is idle
      // again with the reason kept until its next turn. A Codex thread
      // whose server went away says so the same way.
      var failed = hasThread(agent) && (agent.state === 'error' || (agent.state === 'idle' && !!agent.lastError) ||
        (session && agent.state === 'unavailable' && !!agent.lastError));
      notice.textContent = failed ? errorSentence(agent) : '';
      notice.hidden = !failed;

      // The status line stays up while a forwarded card is open, naming
      // its owner; Interrupt is for this agent's own turn only.
      var shown = shownRequest(agent);
      var forwardedOpen = !!(shown && shown.forwarded);
      var open = hasThread(agent) && (turnOpen(agent) || forwardedOpen);
      status.hidden = !open;
      statusText.textContent = !open ? '' : forwardedOpen ? displayName(shown.owner) + ' is waiting for you.' : agent.state === 'busy' ? name + ' is working.' : name + ' is waiting for you.';
      var interrupt = status.querySelector('button');
      interrupt.hidden = !turnOpen(agent);
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
        renderModelTools(agent);
      }
      foot.textContent = hasThread(agent) && session ? 'Type to this thread in its terminal.' : '';
      foot.hidden = !foot.textContent;
      failure.textContent = actionError;
      failure.hidden = !actionError;
    }

    // Fetches the thread when the selected persona's or Codex session's
    // thread may have changed: a new selection, a new last message, a
    // model change (its line is not the last message), a line the daemon
    // wrote outside a turn (lastLineAt), or a turn that ended. `force`
    // fetches it again regardless, for Retry.
    function syncThread(force) {
      var agent = selectedAgent();
      if (!hasThread(agent) || agent.state === 'unavailable') return;
      var key = agent.id + '|' + JSON.stringify(agent.lastMessage) + '|' + JSON.stringify(agent.model || null) + '|' + (agent.lastLineAt || '') + '|' + (turnOpen(agent) ? 'open' : 'closed');
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

    // Brings out the chosen agent's draft; the draft being left is already
    // in the shared map (the input listener keeps it there).
    function setSelected(id) {
      if (menuOpen) closeModelMenu(false);
      closeMentionMenu();
      selectedId = id;
      input.value = (id && drafts[id]) || '';
      actionError = '';
      confirming = false;
      resetThread(id);
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
      render();
      post(routeBase(agent) + '/' + action, body).then(function (result) {
        busy = false;
        var ok = !!(result && result.ok);
        var current = agent.id === selectedId;
        if (ok) {
          if (!shell.isStreaming()) shell.requestState();
        } else if (result && result.code === 'no_such_request') {
          shell.requestState();
        }
        if (current && !ok) actionError = action === 'model' ? modelRefusal(result, agent) : refusalSentence(result, agent);
        render();
        if (current && onDone) onDone(ok);
      });
    }

    // Where the keyboard lands once a request or approval is settled.
    function focusComposer() {
      if (!composer.hidden && !input.disabled) input.focus();
      else if (!status.hidden) status.focus();
    }

    // The model and effort the next turn runs on, under the input: a button
    // for a Claude persona (disabled while the persona cannot run), a note
    // for a Codex one. The picker rebuilds only when what it shows changes,
    // so an open one keeps its focus.
    function renderModelTools(agent) {
      var claude = isPersona(agent) && agent.provider === 'claude' && agent.model;
      var codex = isPersona(agent) && agent.provider === 'codex';
      modelButton.hidden = !claude;
      modelNote.hidden = !codex;
      if (!claude) {
        if (menuOpen) closeModelMenu(false);
        return;
      }
      modelLabel.textContent = modelButtonText(agent.model, state.models);
      modelButton.disabled = agent.state === 'unavailable';
      modelButton.setAttribute('aria-expanded', menuOpen ? 'true' : 'false');
      modelMenu.hidden = !menuOpen;
      if (menuOpen) renderModelMenu(agent);
    }

    function renderModelMenu(agent) {
      var key = JSON.stringify([agent.id, agent.model, state.models, busy]);
      if (key === menuKey) return;
      menuKey = key;
      var model = agent.model;
      var models = state.models || [];
      modelList.textContent = '';
      for (var i = 0; i < models.length; i += 1) {
        var option = element('button', 'model-option', models[i].name);
        option.type = 'button';
        option.setAttribute('role', 'option');
        option.setAttribute('aria-selected', model.id === models[i].id ? 'true' : 'false');
        option.setAttribute('data-model', models[i].id);
        option.disabled = busy;
        if (model.default && model.default.id === models[i].id) option.appendChild(element('span', 'model-option-default', 'Default'));
        modelList.appendChild(option);
      }
      effortRow.textContent = '';
      for (var j = 0; j < EFFORTS.length; j += 1) {
        var level = element('button', 'effort-option', effortNameOf(EFFORTS[j]));
        level.type = 'button';
        level.setAttribute('aria-pressed', model.effort === EFFORTS[j] ? 'true' : 'false');
        level.setAttribute('data-effort', EFFORTS[j]);
        level.disabled = busy;
        effortRow.appendChild(level);
      }
      modelReset.disabled = busy || model.source !== 'thread';
    }

    function openModelMenu() {
      var agent = selectedAgent();
      if (menuOpen || modelButton.hidden || modelButton.disabled || !agent) return;
      menuOpen = true;
      menuKey = null;
      renderModelTools(agent);
      var selected = modelList.querySelector('[aria-selected="true"]') || modelList.firstElementChild;
      if (selected) selected.focus();
      document.addEventListener('pointerdown', onOutsidePointer, true);
    }

    function closeModelMenu(refocus) {
      if (!menuOpen) return;
      menuOpen = false;
      menuKey = null;
      modelMenu.hidden = true;
      modelButton.setAttribute('aria-expanded', 'false');
      document.removeEventListener('pointerdown', onOutsidePointer, true);
      if (refocus !== false && !modelButton.hidden) modelButton.focus();
    }

    function onOutsidePointer(event) {
      if (modelMenu.contains(event.target) || modelButton.contains(event.target)) return;
      closeModelMenu(false);
    }

    // Posts the thread's choice; the snapshot brings the new pair, and the
    // thread is fetched again for its line, which the row preview does not
    // carry. The picker closes on a choice and the button keeps focus.
    function chooseModel(body) {
      var agent = selectedAgent();
      if (!isPersona(agent) || modelButton.disabled) return;
      closeModelMenu(true);
      act(agent, 'model', body, function (ok) {
        if (ok) syncThread(true);
      });
    }

    function sendMessage() {
      var agent = selectedAgent();
      if (!isPersona(agent) || send.disabled) return;
      closeMentionMenu();
      var text = input.value.trim();
      if (!text) {
        input.focus();
        return;
      }
      var mentions = mentionIds(text, state && state.agents);
      var body = mentions.length > 0 ? { text: text, mentions: mentions } : { text: text };
      if (options.decorate) body = options.decorate(body, agent);
      act(agent, 'send', body, function (ok) {
        if (ok) {
          input.value = '';
          drafts[agent.id] = '';
          if (options.onSent) options.onSent(agent);
        }
        input.focus();
      });
    }

    // Answers post to the open thread; the daemon settles a forwarded
    // card through its owner.
    function answerQuestion(agent, card) {
      var answers = collectAnswers();
      if (!answers) return;
      act(agent, 'answer', { requestId: card.requestId, answers: answers }, focusComposer);
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


    composer.addEventListener('submit', function (event) {
      event.preventDefault();
      sendMessage();
    });

    modelButton.addEventListener('click', function () {
      if (menuOpen) closeModelMenu(true);
      else openModelMenu();
    });

    modelMenu.addEventListener('click', function (event) {
      var option = event.target.closest('.model-option');
      if (option && !option.disabled) return chooseModel({ model: option.getAttribute('data-model') });
      var level = event.target.closest('.effort-option');
      if (level && !level.disabled) return chooseModel({ effort: level.getAttribute('data-effort') });
      if (modelReset.contains(event.target) && !modelReset.disabled) chooseModel({ model: null, effort: null });
    });

    // Escape closes; arrows move within the model list or the effort row;
    // Enter and Space choose, as buttons do.
    modelMenu.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeModelMenu(true);
        return;
      }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      var group = event.target.closest('.model-list, .effort-row');
      if (!group) return;
      var items = Array.prototype.filter.call(group.children, function (node) { return !node.disabled; });
      var index = items.indexOf(event.target);
      if (index === -1) return;
      event.preventDefault();
      var forward = event.key === 'ArrowDown' || event.key === 'ArrowRight';
      items[(index + (forward ? 1 : items.length - 1)) % items.length].focus();
    });

    // A press on a picker button keeps the focus where it is (WebKit moves
    // it on mousedown, which would close the picker before the click).
    modelMenu.addEventListener('mousedown', function (event) {
      if (event.target.closest('button')) event.preventDefault();
    });

    // Leaving the picker with the keyboard closes it.
    modelMenu.addEventListener('focusout', function (event) {
      if (!menuOpen || !event.relatedTarget) return;
      if (modelMenu.contains(event.relatedTarget) || event.relatedTarget === modelButton) return;
      closeModelMenu(false);
    });

    // The @ picker. While the caret follows "@" at a word start (the start
    // of the text or after whitespace, with no line break since), a listbox
    // over the input offers the agents that match what was typed after it.
    // Up and Down move, Enter or Tab chooses, Escape closes; a click or a
    // tap chooses too. Choosing replaces "@letters" with "@Name ".
    function mentionToken() {
      var caret = input.selectionStart;
      if (typeof caret !== 'number' || caret !== input.selectionEnd) return null;
      var before = input.value.slice(0, caret);
      var at = before.lastIndexOf('@');
      if (at === -1) return null;
      if (at > 0 && !/\s/.test(before.charAt(at - 1))) return null;
      var query = before.slice(at + 1);
      if (query.indexOf('\n') !== -1) return null;
      return { start: at, query: query };
    }

    function updateMentionMenu() {
      var agent = selectedAgent();
      var token = isPersona(agent) && !input.disabled ? mentionToken() : null;
      if (!token) return closeMentionMenu();
      var candidates = mentionCandidates(state && state.agents, state && state.groups, agent.id, token.query);
      if (candidates.length === 0) return closeMentionMenu();
      var keep = mention && mention.start === token.start ? mention.candidates[mention.index] : null;
      var index = 0;
      if (keep) {
        for (var i = 0; i < candidates.length; i += 1) if (candidates[i].id === keep.id) index = i;
      }
      mention = { start: token.start, candidates: candidates, index: index };
      renderMentionMenu();
    }

    function renderMentionMenu() {
      mentionMenu.textContent = '';
      for (var i = 0; i < mention.candidates.length; i += 1) {
        var agent = mention.candidates[i];
        var option = element('button', 'mention-option');
        option.type = 'button';
        option.id = prefix + '-mention-' + agent.id;
        option.setAttribute('role', 'option');
        option.setAttribute('data-agent', agent.id);
        option.setAttribute('aria-selected', i === mention.index ? 'true' : 'false');
        option.appendChild(element('span', 'mention-option-name', agent.name));
        if (roleChip(agent)) option.appendChild(chip('role-chip', agent.role));
        mentionMenu.appendChild(option);
      }
      mentionMenu.hidden = false;
      input.setAttribute('aria-expanded', 'true');
      input.setAttribute('aria-activedescendant', prefix + '-mention-' + mention.candidates[mention.index].id);
    }

    function closeMentionMenu() {
      if (!mention) return;
      mention = null;
      mentionMenu.hidden = true;
      mentionMenu.textContent = '';
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
    }

    function moveMention(step) {
      var count = mention.candidates.length;
      mention.index = (mention.index + step + count) % count;
      renderMentionMenu();
    }

    function chooseMention(agent) {
      if (!mention || !agent) return;
      var caret = input.selectionStart;
      var inserted = '@' + agent.name + ' ';
      input.value = input.value.slice(0, mention.start) + inserted + input.value.slice(caret);
      var next = mention.start + inserted.length;
      closeMentionMenu();
      input.focus();
      input.setSelectionRange(next, next);
    }

    input.addEventListener('input', function () {
      if (selectedId) drafts[selectedId] = input.value;
      updateMentionMenu();
    });
    input.addEventListener('click', updateMentionMenu);
    input.addEventListener('blur', function () {
      // A press on an option keeps the focus here (mousedown below), so a
      // blur means the keyboard went somewhere else.
      closeMentionMenu();
    });

    mentionMenu.addEventListener('mousedown', function (event) {
      if (event.target.closest('button')) event.preventDefault();
    });
    mentionMenu.addEventListener('click', function (event) {
      var option = event.target.closest('.mention-option');
      if (!option || !mention) return;
      var id = option.getAttribute('data-agent');
      for (var i = 0; i < mention.candidates.length; i += 1) {
        if (mention.candidates[i].id === id) return chooseMention(mention.candidates[i]);
      }
    });

    input.addEventListener('keydown', function (event) {
      if (event.isComposing) return;
      if (mention) {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          moveMention(event.key === 'ArrowDown' ? 1 : -1);
          return;
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          closeMentionMenu();
          return;
        }
        if ((event.key === 'Enter' && !event.shiftKey && !event.altKey) || event.key === 'Tab') {
          event.preventDefault();
          chooseMention(mention.candidates[mention.index]);
          return;
        }
      }
      if (event.key !== 'Enter') return;
      if (event.shiftKey || event.altKey) return;
      event.preventDefault();
      sendMessage();
    });
    // Moving the caret with the keyboard can leave or enter an @ token.
    input.addEventListener('keyup', function (event) {
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'Home' || event.key === 'End') updateMentionMenu();
    });

    // The thread's own controls, and links to other agents' threads in its
    // messages. A link taken here is marked with preventDefault, so the
    // shell and the Agents view's document listener leave it alone.
    function onClick(event) {
      var target = event.target;
      var link = target.closest && target.closest('a[data-agent], [data-part="back"]');
      if (link && root.contains(link)) {
        if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        if (link === back) {
          if (options.onBack) options.onBack();
        } else if (options.onOpenAgent) {
          options.onOpenAgent(link.getAttribute('data-agent'));
        }
        return;
      }
      var node = target.closest && target.closest('button[data-agent-action]');
      if (!node || node.disabled || !root.contains(node)) return;
      var agent = selectedAgent();
      var shown = shownRequest(agent);
      switch (node.getAttribute('data-agent-action')) {
        case 'choose':
          toggleOption(node);
          break;
        case 'answer':
          if (shown) answerQuestion(agent, shown.pending);
          break;
        case 'allow':
        case 'deny':
          if (shown) {
            act(agent, 'answer', { requestId: shown.pending.requestId, decision: node.getAttribute('data-agent-action') }, focusComposer);
          }
          break;
        case 'interrupt':
          if (agent) act(agent, 'interrupt');
          break;
        case 'open-brief':
          if (shell.openBrief) shell.openBrief(node.getAttribute('data-brief-date'), node);
          break;
        case 'new-thread':
          confirming = true;
          render();
          confirmNode.querySelector('button').focus();
          break;
        case 'confirm-new-thread':
          confirming = false;
          if (agent) act(agent, 'new-thread', undefined, function () { newThread.focus(); });
          break;
        case 'cancel-new-thread':
          confirming = false;
          render();
          newThread.focus();
          break;
        case 'retry-thread':
          syncThread(true);
          break;
        default:
          break;
      }
    }
    root.addEventListener('click', onClick);

    function refreshTimes() {
      H.refreshTimes(root);
    }

    return {
      // Opens this entry's thread (null for none). Choosing the open one
      // again changes nothing.
      select: function (id) {
        if (id === selectedId) return;
        setSelected(id);
        if (!visible) return;
        render();
        syncThread();
        markRead(true);
      },
      update: function (next, keys) {
        state = next;
        var touched = !keys || keys.some(function (key) { return WATCHED.indexOf(key) !== -1; });
        if (!touched || !visible) return;
        render();
        syncThread();
        markRead(false);
      },
      render: function () {
        if (state) render();
      },
      blank: blank,
      show: function () {
        visible = true;
        // The draft may have changed in another instance while this one
        // was hidden; the input is not in use, so it takes the map's.
        if (selectedId && document.activeElement !== input) input.value = drafts[selectedId] || '';
        if (tick === null) tick = setInterval(refreshTimes, H.TICK_MS);
        if (state) render();
        syncThread();
        markRead(true);
      },
      hide: function () {
        visible = false;
        if (menuOpen) closeModelMenu(false);
        closeMentionMenu();
        if (tick !== null) clearInterval(tick);
        tick = null;
      },
      focusInput: function () {
        if (!composer.hidden && !input.disabled) input.focus();
      },
      selected: function () {
        return selectedId;
      },
      destroy: function () {
        if (tick !== null) clearInterval(tick);
        tick = null;
        if (menuOpen) closeModelMenu(false);
        root.removeEventListener('click', onClick);
        root.textContent = '';
      },
    };
  }

  window.DashboardThreadView = { create: create };
}());
