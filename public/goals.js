// Goals: the priorities and goal notes read from the vault (/api/goals), one
// card per section, with a composer that sends a new goal or a change to one
// to the second-brain persona (/api/goals/propose). The shell calls
// create(shellApi) once, then update(state, keys) on every state change, and
// show() and hide() as the view comes on and off screen.
//
// While shown, the view fetches /api/goals on show(), every 60 seconds, and
// at once when the second-brain persona leaves busy or waiting (its turn may
// have written the vault). A refetch keeps an open composer and its text.
// Buttons carry data-goal-action, never data-action, which the shell's own
// click handler owns. Every text node is set with textContent.
(function () {
  'use strict';

  var AGENT_ID = 'second-brain';
  var POLL_MS = 60000;
  var TIMEOUT_MS = 8000;
  var NO_ANSWER = 'The dashboard did not respond.';
  var BUSY = 'Second brain is in the middle of a turn. Try again when it is idle.';
  var NOT_RUNNING = 'Second brain is not running.';
  var CHANGED = 'That goal has changed. Try again.';
  var EMPTY = 'Nothing in the vault yet.';

  function element(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function refusalSentence(status, code) {
    if (status === 409 && code === 'busy') return BUSY;
    if (status === 503 || (status === 409 && code === 'persona_unavailable') ||
        (status === 404 && code === 'no_such_agent')) return NOT_RUNNING;
    if (status === 404 && code === 'no_such_goal') return CHANGED;
    return NO_ANSWER;
  }

  // Resolves with { status, body } or null when there was no answer in time.
  function request(path, init) {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, TIMEOUT_MS);
    init.cache = 'no-store';
    init.credentials = 'same-origin';
    init.signal = controller.signal;
    return fetch(path, init).then(function (response) {
      return response.text().then(function (text) {
        var body = null;
        try { body = JSON.parse(text); } catch (_error) { body = null; }
        return { status: response.status, body: body };
      });
    }).then(function (result) {
      clearTimeout(timer);
      return result;
    }, function () {
      clearTimeout(timer);
      return null;
    });
  }

  function line(label, text) {
    var node = element('p', 'goal-line');
    node.appendChild(element('strong', null, label + ':'));
    node.appendChild(document.createTextNode(' ' + text));
    return node;
  }

  function prose(blocks) {
    var node = element('div', 'goal-prose');
    (blocks || []).forEach(function (block) {
      if (block.type === 'p') node.appendChild(element('p', null, block.text));
      else if (block.type === 'h') node.appendChild(element('h4', null, block.text));
      else if (block.type === 'list') {
        var list = element('ul');
        (block.items || []).forEach(function (text) { list.appendChild(element('li', null, text)); });
        node.appendChild(list);
      }
    });
    return node;
  }

  function paragraphs(blocks) {
    return (blocks || []).filter(function (block) { return block.type === 'p'; })
      .map(function (block) { return block.text; });
  }

  // The item's visible text, one paragraph per part, quoted above the
  // composer when editing it.
  function quoteFor(item) {
    var parts = item.title ? [item.title] : [];
    if (item.now) parts.push('Now: ' + item.now);
    if (item.what) parts.push('What: ' + item.what);
    if (item.why) parts.push('Why: ' + item.why);
    if (!item.now && !item.what && !item.why) parts = parts.concat(paragraphs(item.prose));
    return parts;
  }

  function sectionEmpty(section) {
    return (section.items || []).length === 0 && !section.principle && (section.horizons || []).length === 0;
  }

  function create(shellApi) {
    var message = document.getElementById('goals-message');
    var cards = document.getElementById('goals-cards');

    var data = null; // the last /api/goals answer
    var visible = false;
    var poll = null;
    var sequence = 0;
    var brainState = null;
    var composer = null; // { kind, target, node, input, send, reason, pending }
    var items = {}; // id -> item, from the last render

    function editButton(item) {
      var button = element('button', 'button button-small', 'Edit');
      button.type = 'button';
      button.setAttribute('data-goal-action', 'edit');
      button.setAttribute('data-goal-id', item.id);
      var name = item.title || paragraphs(item.prose)[0] || '';
      if (name) button.setAttribute('aria-label', 'Edit ' + name);
      return button;
    }

    // An item's title row: its title (when it has one) and its Edit button.
    function head(item, extra) {
      var node = element('div', 'goal-item-head');
      if (item.title) node.appendChild(element('h3', 'goal-title', item.title));
      if (extra) node.appendChild(extra);
      if (item.id) {
        items[item.id] = item;
        node.appendChild(editButton(item));
      }
      return node;
    }

    function itemNode(item, fill) {
      var node = element('div', 'goal-item');
      if (item.id) node.setAttribute('data-goal-item', item.id);
      fill(node);
      return node;
    }

    function renderNow(item) {
      return itemNode(item, function (node) {
        node.appendChild(head(item));
        if (item.now) node.appendChild(line('Now', item.now));
        if (item.why) node.appendChild(line('Why', item.why));
        node.appendChild(prose(item.prose));
      });
    }

    function renderListed(item) {
      return itemNode(item, function (node) {
        node.appendChild(head(item));
        node.appendChild(prose(item.prose));
      });
    }

    function renderNote(item) {
      return itemNode(item, function (node) {
        node.appendChild(head(item, item.horizon ? element('span', 'role-chip', item.horizon) : null));
        if (item.what) node.appendChild(line('What', item.what));
        if (item.why) node.appendChild(line('Why', item.why));
        node.appendChild(prose(item.prose));
      });
    }

    function renderLongTerm(section, card) {
      if (section.principle) card.appendChild(element('p', 'goal-principle', section.principle));
      if ((section.items || []).length > 0) {
        var list = element('ol', 'goal-top');
        section.items.forEach(function (item) {
          var li = element('li', 'goal-item');
          if (item.id) li.setAttribute('data-goal-item', item.id);
          li.appendChild(head(item));
          list.appendChild(li);
        });
        card.appendChild(list);
      }
      if ((section.horizons || []).length > 0) {
        var horizons = element('dl', 'goal-horizons');
        section.horizons.forEach(function (horizon) {
          horizons.appendChild(element('dt', null, horizon.label));
          horizons.appendChild(element('dd', null, horizon.text));
        });
        card.appendChild(horizons);
      }
    }

    function renderSection(section) {
      var card = element('section', 'routine-card goal-card');
      var headingId = 'goals-section-' + section.id;
      card.setAttribute('aria-labelledby', headingId);
      card.setAttribute('data-goal-section', section.id);
      var header = element('div', 'card-header');
      var title = element('h2', 'card-name', section.title);
      title.id = headingId;
      header.appendChild(title);
      if (section.updated) header.appendChild(element('span', 'card-note', 'Updated ' + section.updated));
      card.appendChild(header);
      if (section.id === 'long-term') renderLongTerm(section, card);
      else {
        var fill = section.id === 'now' ? renderNow : section.id === 'goals' ? renderNote : renderListed;
        (section.items || []).forEach(function (item) { card.appendChild(fill(item)); });
      }
      return card;
    }

    function setMessage(lines) {
      message.textContent = '';
      lines.forEach(function (text, i) {
        if (i > 0) message.appendChild(document.createElement('br'));
        message.appendChild(document.createTextNode(text));
      });
      message.hidden = lines.length === 0;
    }

    // Puts the open composer under its item, or at the top of the cards.
    function placeComposer() {
      if (!composer) return;
      var hadFocus = composer.node.contains(document.activeElement);
      var host = composer.target ? cards.querySelector('[data-goal-item="' + CSS.escape(composer.target) + '"]') : null;
      if (host) host.appendChild(composer.node);
      else cards.insertBefore(composer.node, cards.firstChild);
      if (hadFocus) composer.input.focus();
    }

    function render() {
      if (!data || !Array.isArray(data.sections)) return;
      var problems = Array.isArray(data.problems) ? data.problems : [];
      var empty = data.sections.every(sectionEmpty);
      setMessage(problems.length > 0 ? problems : empty ? [EMPTY] : []);
      items = {};
      if (composer) composer.node.remove();
      cards.textContent = '';
      data.sections.forEach(function (section) {
        if (!sectionEmpty(section)) cards.appendChild(renderSection(section));
      });
      placeComposer();
    }

    function load() {
      var id = ++sequence;
      request('/api/goals', { method: 'GET' }).then(function (result) {
        if (id !== sequence) return;
        if (result && result.status === 200 && result.body && Array.isArray(result.body.sections)) {
          data = result.body;
          if (visible) render();
        } else if (visible) {
          setMessage([NO_ANSWER]);
        }
      });
    }

    function closeComposer() {
      if (!composer) return;
      composer.node.remove();
      composer = null;
    }

    function openComposer(kind, target) {
      closeComposer();
      var item = target ? items[target] : null;
      var form = element('form', 'composer goal-composer');
      var inputId = 'goals-input';
      if (item) {
        var quote = element('blockquote', 'goal-quote');
        quoteFor(item).forEach(function (text) { quote.appendChild(element('p', null, text)); });
        form.appendChild(quote);
      }
      var label = element('label', 'composer-label', item ? 'What should change?' : 'What do you want to work toward?');
      label.htmlFor = inputId;
      form.appendChild(label);
      var input = element('textarea', 'composer-input');
      input.id = inputId;
      input.rows = 3;
      form.appendChild(input);
      var row = element('div', 'composer-row goal-composer-actions');
      var send = element('button', 'button button-primary', 'Send');
      send.type = 'submit';
      var cancel = element('button', 'button', 'Cancel');
      cancel.type = 'button';
      cancel.setAttribute('data-goal-action', 'cancel');
      row.appendChild(send);
      row.appendChild(cancel);
      form.appendChild(row);
      var reason = element('p', 'composer-reason');
      reason.setAttribute('role', 'status');
      reason.hidden = true;
      form.appendChild(reason);
      form.addEventListener('submit', function (event) {
        event.preventDefault();
        submit();
      });
      composer = { kind: item ? 'edit' : 'add', target: item ? target : null, node: form, input: input, send: send, reason: reason, pending: false };
      placeComposer();
      input.focus();
    }

    function submit() {
      var open = composer;
      if (!open || open.pending) return;
      var text = open.input.value.trim();
      if (!text) {
        open.input.focus();
        return;
      }
      var body = open.kind === 'edit' ? { kind: 'edit', target: open.target, text: text } : { kind: 'add', text: text };
      open.pending = true;
      open.send.disabled = true;
      open.reason.hidden = true;
      request('/api/goals/propose', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }).then(function (result) {
        open.pending = false;
        open.send.disabled = false;
        if (composer !== open) return;
        if (result && result.status === 202) {
          closeComposer();
          shellApi.openAgent(result.body && typeof result.body.agentId === 'string' ? result.body.agentId : AGENT_ID);
          return;
        }
        var code = result && result.body && typeof result.body.error === 'string' ? result.body.error : null;
        open.reason.textContent = result ? refusalSentence(result.status, code) : NO_ANSWER;
        open.reason.hidden = false;
        if (result && result.status === 404 && code === 'no_such_goal') load();
      });
    }

    document.getElementById('goals-add').addEventListener('click', function () {
      openComposer('add', null);
    });
    cards.addEventListener('click', function (event) {
      var button = event.target.closest && event.target.closest('button[data-goal-action]');
      if (!button) return;
      var action = button.getAttribute('data-goal-action');
      if (action === 'edit') openComposer('edit', button.getAttribute('data-goal-id'));
      else if (action === 'cancel') closeComposer();
    });

    function brainStateIn(state) {
      var agents = state && Array.isArray(state.agents) ? state.agents : [];
      for (var i = 0; i < agents.length; i += 1) if (agents[i].id === AGENT_ID) return agents[i].state || null;
      return null;
    }

    return {
      update: function (state, keys) {
        if (keys && keys.indexOf('agents') === -1) return;
        var next = brainStateIn(state);
        var left = (brainState === 'busy' || brainState === 'waiting') && next !== 'busy' && next !== 'waiting';
        brainState = next;
        if (left && visible) load();
      },
      show: function () {
        if (visible) return;
        visible = true;
        if (data) render();
        load();
        poll = setInterval(load, POLL_MS);
      },
      hide: function () {
        visible = false;
        if (poll !== null) clearInterval(poll);
        poll = null;
      },
    };
  }

  window.DashboardGoals = { create: create, refusalSentence: refusalSentence, quoteFor: quoteFor };
}());
