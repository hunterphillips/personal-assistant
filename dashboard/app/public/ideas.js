// Ideas: suggestions from producer runs and Hunter's own additions, grouped
// into Monday-start weeks. The view fetches /api/ideas on show and every 60
// seconds. Discuss opens quick chat without sending a turn; Start sends the
// idea to the pinned agent; Dismiss removes it from the returned list. The
// criteria panel is instructions.js's. Buttons use data-ideas-action so the
// shell's data-action handler never owns them.
(function () {
  'use strict';

  var POLL_MS = 60000;
  var TIMEOUT_MS = 8000;
  var NO_ANSWER = 'The dashboard did not respond.';
  var EMPTY = 'No ideas yet.';
  var GONE = 'That idea is no longer available.';
  var TOO_LONG = 'That is too long for one message.';
  var ALREADY_STARTED = 'That idea has already been started.';
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  var KINDS = new Set(['workflow', 'view', 'app', 'tool', 'skill', 'plugin', 'task']);

  function element(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

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

  function arrayOf(value) { return Array.isArray(value) ? value : []; }
  function objectsIn(value) {
    return arrayOf(value).filter(function (entry) { return entry !== null && typeof entry === 'object'; });
  }

  function parseDate(text) {
    var match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(typeof text === 'string' ? text : '');
    if (!match) return null;
    var date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function weekFor(text) {
    var date = parseDate(text);
    if (!date) return { key: text, title: text };
    date.setDate(date.getDate() - ((date.getDay() + 6) % 7));
    var key = [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
    return { key: key, title: 'Week of ' + MONTHS[date.getMonth()] + ' ' + date.getDate() };
  }

  function create(shellApi) {
    var message = document.getElementById('ideas-message');
    var weeks = document.getElementById('ideas-weeks');
    var addToggle = document.getElementById('ideas-add');
    var addForm = document.getElementById('ideas-add-form');
    var addInput = document.getElementById('ideas-add-input');
    var addCancel = document.getElementById('ideas-add-cancel');
    var addSend = addForm.querySelector('button[type="submit"]');
    var addReason = document.getElementById('ideas-add-reason');
    var data = null;
    var state = null;
    var visible = false;
    var poll = null;
    var sequence = 0;
    var rendered = null;
    var pending = null;
    var discussed = null;

    function agents() { return state && Array.isArray(state.agents) ? state.agents : []; }
    function agent(id) { return agents().find(function (entry) { return entry.id === id; }) || null; }
    function agentName(id) { return agent(id)?.name || id; }
    function startingAgentName() {
      var listed = agents().filter(function (entry) { return entry.kind === 'persona' && entry.provider === 'claude'; });
      return (listed.find(function (entry) { return entry.pinned === true; }) || listed.find(function (entry) { return entry.builtin === true; }) || listed[0] || {}).name || 'That agent';
    }

    function refusalSentence(status, code) {
      if (status === 409 && code === 'busy') return startingAgentName() + ' is in the middle of a turn. Try again when it is idle.';
      if (status === 409 && code === 'already_started') return ALREADY_STARTED;
      if (status === 503 || (status === 409 && code === 'persona_unavailable') ||
          (status === 404 && code === 'no_such_agent')) return startingAgentName() + ' is not running.';
      if (status === 404 && code === 'no_such_item') return GONE;
      if (status === 413) return TOO_LONG;
      return NO_ANSWER;
    }

    function action(name, id) {
      var button = element('button', 'ideas-action', name);
      button.type = 'button';
      button.setAttribute('data-ideas-action', name.toLowerCase());
      button.setAttribute('data-ideas-id', id);
      button.disabled = pending === id;
      return button;
    }

    function renderItem(item) {
      var node = element('article', 'ideas-item');
      node.setAttribute('data-ideas-item', item.id);
      node.appendChild(element('h3', 'ideas-title', item.title));
      if (item.text) {
        var body = element('div', 'ideas-text markdown');
        window.DashboardMarkdown.renderInto(body, item.text);
        node.appendChild(body);
      }
      var meta = [];
      if (KINDS.has(item.kind)) meta.push(item.kind);
      arrayOf(item.agents).forEach(function (id) { meta.push(agentName(id)); });
      if (meta.length) node.appendChild(element('p', 'ideas-meta', meta.join(' · ')));
      if (typeof item.source === 'string' && /^https?:\/\//i.test(item.source)) {
        var source = element('p', 'ideas-source');
        var link = element('a', null, 'Source');
        link.href = item.source;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        source.appendChild(link);
        node.appendChild(source);
      }
      var actions = element('div', 'ideas-actions');
      actions.appendChild(action('Discuss', item.id));
      if (item.status === 'taken' && typeof item.agent === 'string') {
        var started = element('a', 'ideas-started', 'Started with ' + agentName(item.agent));
        started.href = '/?agent=' + encodeURIComponent(item.agent);
        actions.appendChild(started);
      } else actions.appendChild(action('Start', item.id));
      actions.appendChild(action('Dismiss', item.id));
      node.appendChild(actions);
      var reason = element('p', 'ideas-reason');
      reason.setAttribute('role', 'status');
      reason.hidden = true;
      node.appendChild(reason);
      return node;
    }

    function renderWeek(group) {
      var node = element('section', 'ideas-week');
      node.setAttribute('data-ideas-week', group.key);
      node.appendChild(element('h2', 'ideas-week-title', group.title));
      group.runs.forEach(function (run) {
        var runNode = element('div', 'ideas-run');
        runNode.setAttribute('data-ideas-run', run.id);
        objectsIn(run.items).forEach(function (item) { runNode.appendChild(renderItem(item)); });
        node.appendChild(runNode);
      });
      return node;
    }

    function setMessage(lines) {
      message.textContent = '';
      lines.forEach(function (text, index) {
        if (index) message.appendChild(document.createElement('br'));
        message.appendChild(document.createTextNode(text));
      });
      message.hidden = lines.length === 0;
    }

    function render() {
      if (!data) return;
      var groups = [];
      var byWeek = new Map();
      try {
        objectsIn(data.runs).forEach(function (run) {
          if (objectsIn(run.items).length === 0) return;
          var week = weekFor(run.date);
          var group = byWeek.get(week.key);
          if (!group) {
            group = { key: week.key, title: week.title, runs: [] };
            byWeek.set(week.key, group);
            groups.push(group);
          }
          group.runs.push(run);
        });
      } catch (_error) {
        setMessage([NO_ANSWER]);
        rendered = null;
        return;
      }
      var built = groups.map(renderWeek);
      var problems = arrayOf(data.problems).filter(function (text) { return typeof text === 'string'; });
      setMessage(built.length === 0 ? [EMPTY].concat(problems) : problems);
      weeks.textContent = '';
      built.forEach(function (node) { weeks.appendChild(node); });
      rendered = JSON.stringify(data);
    }

    function apply(next) {
      data = next;
      var text = JSON.stringify(next);
      if (visible && text !== rendered) render();
    }

    function load() {
      var id = ++sequence;
      return request('/api/ideas', { method: 'GET' }).then(function (result) {
        if (id !== sequence) return;
        if (result && result.status === 200 && result.body && Array.isArray(result.body.runs)) apply(result.body);
        else if (visible) { setMessage([NO_ANSWER]); rendered = null; }
      });
    }

    function itemById(id) {
      var found = null;
      objectsIn(data && data.runs).forEach(function (run) {
        objectsIn(run.items).forEach(function (item) { if (!found && item.id === id) found = item; });
      });
      return found;
    }

    function itemInView() {
      var scroller = document.getElementById('ideas-page');
      if (!scroller || !data) return null;
      var box = scroller.getBoundingClientRect();
      var nodes = weeks.querySelectorAll('.ideas-item[data-ideas-item]');
      for (var i = 0; i < nodes.length; i += 1) {
        var top = nodes[i].getBoundingClientRect().top;
        if (top >= box.top - 1 && top < box.bottom) return itemById(nodes[i].getAttribute('data-ideas-item'));
      }
      return null;
    }

    function reasonFor(id) {
      var node = weeks.querySelector('[data-ideas-item="' + CSS.escape(id) + '"]');
      return node ? node.querySelector('.ideas-reason') : null;
    }

    function mutate(path, id, button) {
      if (pending) return;
      pending = id;
      button.disabled = true;
      var reason = reasonFor(id);
      if (reason) reason.hidden = true;
      request(path, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: id }),
      }).then(function (result) {
        pending = null;
        button.disabled = false;
        if (result && ((path.endsWith('/start') && result.status === 202) || (!path.endsWith('/start') && result.status === 200))) {
          if (result.body && result.body.ideas) apply(result.body.ideas);
          if (path.endsWith('/start') && visible && result.body && typeof result.body.agentId === 'string') shellApi.openAgent(result.body.agentId);
          return;
        }
        var code = result && result.body && typeof result.body.error === 'string' ? result.body.error : null;
        var current = reasonFor(id) || reason;
        if (current) {
          current.textContent = result ? refusalSentence(result.status, code) : NO_ANSWER;
          current.hidden = false;
        }
      });
    }

    function openAdd() {
      addForm.hidden = false;
      addReason.hidden = true;
      addToggle.setAttribute('aria-expanded', 'true');
      addInput.focus();
    }

    function closeAdd(restore, clear) {
      addForm.hidden = true;
      addToggle.setAttribute('aria-expanded', 'false');
      if (clear) addInput.value = '';
      if (restore) addToggle.focus();
    }

    function addIdea() {
      var text = addInput.value;
      if (!text || !text.split('\n', 1)[0].trim()) { addInput.focus(); return; }
      addSend.disabled = true;
      addReason.hidden = true;
      request('/api/ideas', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: text }),
      }).then(function (result) {
        addSend.disabled = false;
        if (result && result.status === 201 && result.body && result.body.ideas) {
          closeAdd(false, true);
          apply(result.body.ideas);
          return;
        }
        var code = result && result.body && typeof result.body.error === 'string' ? result.body.error : null;
        addReason.textContent = result ? refusalSentence(result.status, code) : NO_ANSWER;
        addReason.hidden = false;
      });
    }

    var panel = window.DashboardInstructions
      ? window.DashboardInstructions.create({
        prefix: 'ideas', readPath: '/api/ideas/instructions', proposePath: '/api/ideas/instructions/propose',
        refusalSentence: refusalSentence,
        openAgent: function (id) { if (visible && id) shellApi.openAgent(id); },
      })
      : null;

    weeks.addEventListener('click', function (event) {
      var button = event.target.closest && event.target.closest('button[data-ideas-action]');
      if (!button) return;
      var id = button.getAttribute('data-ideas-id');
      if (button.getAttribute('data-ideas-action') === 'discuss') {
        discussed = itemById(id);
        shellApi.openQuickChat(button);
      } else if (button.getAttribute('data-ideas-action') === 'start') mutate('/api/ideas/start', id, button);
      else mutate('/api/ideas/dismiss', id, button);
    });
    addToggle.setAttribute('aria-controls', 'ideas-add-form');
    addToggle.setAttribute('aria-expanded', 'false');
    addToggle.addEventListener('click', function () { if (addForm.hidden) openAdd(); else closeAdd(true, false); });
    addCancel.addEventListener('click', function () { closeAdd(true, false); });
    addForm.addEventListener('submit', function (event) { event.preventDefault(); addIdea(); });
    addForm.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') { event.preventDefault(); closeAdd(true, false); }
    });

    return {
      update: function (next, keys) {
        state = next;
        if ((!keys || keys.includes('agents')) && data && visible) render();
      },
      show: function () {
        if (visible) return;
        visible = true;
        addToggle.hidden = false;
        if (panel) panel.show();
        if (data) render();
        load();
        poll = setInterval(load, POLL_MS);
      },
      context: function () {
        var item = discussed || (visible ? itemInView() : null);
        if (!item) return { view: 'ideas' };
        var detail = [];
        if (KINDS.has(item.kind)) detail.push('Kind: ' + item.kind);
        if (arrayOf(item.agents).length) detail.push('Agents: ' + item.agents.map(agentName).join(', '));
        if (item.source) detail.push('Source: ' + item.source);
        if (item.text) detail.push(item.text);
        return { view: 'ideas', label: item.title, detail: detail.join('\n') };
      },
      hide: function () {
        visible = false;
        discussed = null;
        addToggle.hidden = true;
        closeAdd(false, false);
        if (panel) panel.hide();
        if (poll !== null) clearInterval(poll);
        poll = null;
      },
    };
  }

  window.DashboardIdeas = { create: create };
}());
