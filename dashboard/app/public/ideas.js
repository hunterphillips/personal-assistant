// Ideas: suggestions from producer runs and Hunter's own additions, grouped
// into Monday-start weeks. The view fetches /api/ideas on show and every 60
// seconds. Discuss opens quick chat without sending a turn; Start sends the
// idea to the pinned agent; Dismiss removes it from the returned list. New
// ideas runs the producer's ideas routine (the store's `routine`) now and
// polls every 10 seconds until a new run lands or ten minutes pass. The
// criteria panel is instructions.js's. Each row expands its description and
// owns one overflow menu whose buttons use data-ideas-action so the shell's
// data-action handler never owns them.
//
// The side panel's Ideas section, drawn on the same render as the weeks and
// cleared on hide, lists Weeks: each week with its count of ideas. Choosing
// one scrolls that week's heading into view and marks the row current until
// another is chosen or the view hides.
(function () {
  'use strict';

  var POLL_MS = 60000;
  var FAST_POLL_MS = 10000;
  var FAST_FOR_MS = 600000;
  var NO_ROUTINE = 'No routine writes ideas.';
  var TIMEOUT_MS = 8000;
  var NO_ANSWER = 'The dashboard did not respond.';
  var EMPTY = 'No ideas yet.';
  var GONE = 'That idea is no longer available.';
  var TOO_LONG = 'That is too long for one message.';
  var ALREADY_STARTED = 'That idea has already been started.';
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  var KINDS = new Set(['workflow', 'view', 'app', 'tool', 'skill', 'plugin', 'agent']);
  var ICONS = {
    workflow: '<path d="M6 5.5h7a3 3 0 0 1 3 3v7"/><path d="m13 13 3 3 3-3"/><circle cx="6" cy="5.5" r="2"/>',
    view: '<rect x="3.5" y="5" width="17" height="14" rx="2"/><path d="M3.5 9h17"/><path d="M9 9v10"/>',
    app: '<rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/>',
    tool: '<path d="M14.5 6.5a4 4 0 0 0-5 5L4 17l3 3 5.5-5.5a4 4 0 0 0 5-5l-2.5 2.5-3-3Z"/>',
    skill: '<path d="M12 3.5 14.2 8l4.8.7-3.5 3.4.8 4.9-4.3-2.3L7.7 17l.8-4.9L5 8.7 9.8 8Z"/>',
    plugin: '<path d="M8.5 4v4.5H4v7h4.5V20h7v-4.5H20v-7h-4.5V4Z"/><path d="M10 4a2 2 0 1 1 4 0"/><path d="M20 10a2 2 0 1 1 0 4"/>',
    agent: '<circle cx="12" cy="8.5" r="3.25"/><path d="M5.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6"/>',
    idea: '<path d="M9 18h6"/><path d="M10 21h4"/><path d="M8.4 14.5A6 6 0 1 1 15.6 14.5C14.6 15.2 14 16.1 14 17h-4c0-.9-.6-1.8-1.6-2.5Z"/>',
  };

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
    var side = document.querySelector('[data-panel-for="ideas"]');
    var addToggle = document.getElementById('ideas-add');
    var addForm = document.getElementById('ideas-add-form');
    var addInput = document.getElementById('ideas-add-input');
    var addCancel = document.getElementById('ideas-add-cancel');
    var addSend = addForm.querySelector('button[type="submit"]');
    var addReason = document.getElementById('ideas-add-reason');
    var newButton = document.getElementById('ideas-new');
    var data = null;
    var state = null;
    var visible = false;
    var poll = null;
    var sequence = 0;
    var rendered = null;
    var pending = null;
    var discussed = null;
    var openMenu = null;
    var chosen = null; // the week key of the panel's current row, or null
    var notice = null; // the New ideas sentence, or null
    var running = false; // a New ideas request is in flight
    var fast = null; // { runs, until } while a New ideas run is awaited

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
      var button = element('button', 'menu-entry ideas-action', name);
      button.type = 'button';
      button.setAttribute('data-ideas-action', name.toLowerCase());
      button.setAttribute('data-ideas-id', id);
      button.disabled = pending === id;
      return button;
    }

    function kindIcon(kind) {
      var name = KINDS.has(kind) ? kind : 'idea';
      var label = name === 'idea' ? 'Idea' : name.charAt(0).toUpperCase() + name.slice(1);
      var icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      icon.setAttribute('class', 'ideas-kind-icon');
      icon.setAttribute('data-ideas-kind', name);
      icon.setAttribute('width', '24');
      icon.setAttribute('height', '24');
      icon.setAttribute('viewBox', '0 0 24 24');
      icon.setAttribute('stroke', 'currentColor');
      icon.setAttribute('fill', 'none');
      icon.setAttribute('stroke-width', '1.75');
      icon.setAttribute('stroke-linecap', 'round');
      icon.setAttribute('stroke-linejoin', 'round');
      icon.setAttribute('role', 'img');
      icon.setAttribute('aria-label', label);
      icon.innerHTML = '<title>' + label + '</title>' + ICONS[name];
      return icon;
    }

    function closeMenu(restore) {
      if (!openMenu) return;
      var menu = openMenu.querySelector('.ideas-menu');
      var toggle = openMenu.querySelector('.ideas-menu-toggle');
      menu.hidden = true;
      toggle.setAttribute('aria-expanded', 'false');
      openMenu = null;
      if (restore) toggle.focus();
    }

    function openItemMenu(node) {
      if (openMenu && openMenu !== node) closeMenu(false);
      var menu = node.querySelector('.ideas-menu');
      var toggle = node.querySelector('.ideas-menu-toggle');
      menu.hidden = false;
      toggle.setAttribute('aria-expanded', 'true');
      openMenu = node;
    }

    function renderItem(item) {
      var node = element('article', 'ideas-item');
      node.setAttribute('data-ideas-item', item.id);
      node.setAttribute('role', 'button');
      node.setAttribute('tabindex', '0');
      node.setAttribute('aria-expanded', 'false');
      node.appendChild(kindIcon(item.kind));
      var content = element('div', 'ideas-content');
      content.appendChild(element('h3', 'ideas-title', item.title));
      if (item.text) {
        var body = element('div', 'ideas-text markdown');
        window.DashboardMarkdown.renderInto(body, item.text);
        content.appendChild(body);
      }
      var meta = [];
      arrayOf(item.agents).forEach(function (id) { meta.push(agentName(id)); });
      var metaNode = element('p', 'ideas-meta');
      if (meta.length) metaNode.appendChild(document.createTextNode(meta.join(' · ')));
      if (typeof item.source === 'string' && /^https?:\/\//i.test(item.source)) {
        var link = element('a', null, 'Source');
        link.href = item.source;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        if (meta.length) metaNode.appendChild(document.createTextNode(' · '));
        metaNode.appendChild(link);
      }
      if (metaNode.childNodes.length) content.appendChild(metaNode);
      node.appendChild(content);
      var toggle = element('button', 'ideas-menu-toggle');
      toggle.type = 'button';
      toggle.setAttribute('aria-label', 'More');
      toggle.setAttribute('title', 'More');
      toggle.setAttribute('aria-expanded', 'false');
      toggle.setAttribute('aria-haspopup', 'menu');
      toggle.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/></svg>';
      node.appendChild(toggle);
      var actions = element('div', 'app-menu ideas-menu');
      actions.setAttribute('role', 'menu');
      actions.hidden = true;
      actions.appendChild(action('Discuss', item.id));
      if (item.status === 'taken' && typeof item.agent === 'string') {
        var started = element('a', 'menu-entry ideas-started', 'Started with ' + agentName(item.agent));
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

    // The panel's Weeks group: one row per week drawn, with its count of ideas.
    function renderPanel(groups) {
      if (!side) return;
      side.textContent = '';
      if (groups.length === 0) return;
      side.appendChild(element('h2', 'panel-heading', 'Weeks'));
      groups.forEach(function (group) {
        var count = group.runs.reduce(function (sum, run) { return sum + objectsIn(run.items).length; }, 0);
        var row = element('button', 'panel-row');
        row.type = 'button';
        row.setAttribute('data-ideas-week', group.key);
        if (group.key === chosen) row.setAttribute('aria-current', 'true');
        row.appendChild(element('span', 'panel-row-name', group.title));
        row.appendChild(element('span', 'panel-row-count', String(count)));
        side.appendChild(row);
      });
    }

    // Scrolls the week's heading into view and marks its row current.
    function choose(key) {
      var week = weeks.querySelector('[data-ideas-week="' + CSS.escape(key) + '"]');
      if (!week) return;
      chosen = key;
      var rows = side.querySelectorAll('.panel-row');
      for (var r = 0; r < rows.length; r += 1) {
        if (rows[r].getAttribute('data-ideas-week') === key) rows[r].setAttribute('aria-current', 'true');
        else rows[r].removeAttribute('aria-current');
      }
      week.querySelector('.ideas-week-title').scrollIntoView({ block: 'start' });
      shellApi.closePanel();
    }

    function runIds(value) {
      return objectsIn(value && value.runs).map(function (run) { return run.id; }).join('\n');
    }

    function producerName() { return agentName(data && data.producer) || 'That agent'; }

    function hasRoutine() { return Boolean(data && typeof data.routine === 'string'); }

    function syncNew() {
      var missing = Boolean(data) && !hasRoutine();
      newButton.disabled = running || missing;
      if (missing) newButton.title = NO_ROUTINE;
      else newButton.removeAttribute('title');
    }

    function noticeLine() { return notice || (data && !hasRoutine() ? NO_ROUTINE : null); }

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
      var line = noticeLine();
      setMessage((built.length === 0 ? [EMPTY] : []).concat(line ? [line] : [], problems));
      syncNew();
      weeks.textContent = '';
      built.forEach(function (node) { weeks.appendChild(node); });
      // A week gone from the store takes its mark with it.
      if (!groups.some(function (group) { return group.key === chosen; })) chosen = null;
      renderPanel(groups);
      shellApi.panelChanged();
      rendered = JSON.stringify(data);
    }

    function startPoll() {
      if (poll !== null) clearInterval(poll);
      poll = setInterval(load, fast ? FAST_POLL_MS : POLL_MS);
    }

    // Leaves fast polling once a new run lands (clearing the sentence) or
    // ten minutes pass.
    function settleFast(next) {
      if (!fast) return;
      var landed = runIds(next) !== fast.runs;
      if (!landed && Date.now() < fast.until) return;
      fast = null;
      if (landed) notice = null;
      if (visible) startPoll();
    }

    function say(text) {
      notice = text;
      rendered = null;
      if (visible && data) render();
      else if (visible) setMessage([text]);
    }

    function runNew() {
      if (running || !hasRoutine()) return;
      running = true;
      syncNew();
      var name = producerName();
      request('/api/routines/' + encodeURIComponent(data.routine) + '/run', { method: 'POST' }).then(function (result) {
        running = false;
        syncNew();
        var code = result && result.body && typeof result.body.error === 'string' ? result.body.error : null;
        if (!result) say(NO_ANSWER);
        else if (result.status === 202) {
          fast = { runs: runIds(data), until: Date.now() + FAST_FOR_MS };
          if (visible) startPoll();
          say(name + ' is writing new ideas. They will appear here when it finishes.');
        } else if (result.status === 409 && code === 'busy') say(name + ' is in the middle of a turn. Try again when it is idle.');
        else if (result.status === 404 || result.status === 503 || (result.status === 409 && code === 'agent_unavailable')) {
          say(name + ' is not running.');
        } else say(NO_ANSWER);
      });
    }

    function apply(next) {
      settleFast(next);
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

    if (side) {
      side.addEventListener('click', function (event) {
        var row = event.target.closest && event.target.closest('button[data-ideas-week]');
        if (row) choose(row.getAttribute('data-ideas-week'));
      });
    }
    weeks.addEventListener('click', function (event) {
      var toggle = event.target.closest && event.target.closest('.ideas-menu-toggle');
      if (toggle) {
        var menuItem = toggle.closest('.ideas-item');
        if (openMenu === menuItem) closeMenu(true);
        else openItemMenu(menuItem);
        return;
      }
      var button = event.target.closest && event.target.closest('button[data-ideas-action]');
      if (button) {
        var id = button.getAttribute('data-ideas-id');
        closeMenu(false);
        if (button.getAttribute('data-ideas-action') === 'discuss') {
          discussed = itemById(id);
          shellApi.openQuickChat(button);
        } else if (button.getAttribute('data-ideas-action') === 'start') mutate('/api/ideas/start', id, button);
        else mutate('/api/ideas/dismiss', id, button);
        return;
      }
      if (event.target.closest && event.target.closest('.ideas-started')) { closeMenu(false); return; }
      if (event.target.closest && event.target.closest('a')) return;
      var row = event.target.closest && event.target.closest('.ideas-item');
      if (row) {
        var expanded = row.getAttribute('aria-expanded') === 'true';
        row.setAttribute('aria-expanded', expanded ? 'false' : 'true');
        row.classList.toggle('ideas-item-expanded', !expanded);
      }
    });
    weeks.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && openMenu) { event.preventDefault(); closeMenu(true); return; }
      if ((event.key === 'Enter' || event.key === ' ') && event.target.classList.contains('ideas-item')) {
        event.preventDefault();
        event.target.click();
      }
    });
    document.addEventListener('click', function (event) {
      if (openMenu && !openMenu.contains(event.target)) closeMenu(false);
    });
    newButton.addEventListener('click', runNew);
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
        newButton.hidden = false;
        if (panel) panel.show();
        if (data) render();
        load();
        startPoll();
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
        chosen = null;
        if (side) side.textContent = '';
        closeMenu(false);
        addToggle.hidden = true;
        newButton.hidden = true;
        closeAdd(false, false);
        if (panel) panel.hide();
        if (poll !== null) clearInterval(poll);
        poll = null;
      },
    };
  }

  window.DashboardIdeas = { create: create };
}());
