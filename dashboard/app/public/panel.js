// The side panel between the rail and every view, and its toggle at the head
// of the header. On a desk (from 720px) the toggle collapses the panel on
// every view and the choice is stored; on a phone the panel is a drawer from
// the left over a scrim, opened by the toggle and closed by the scrim,
// Escape, closePanel(), or another view (shell.js), and nothing is stored.
// openPanel() and closePanel() act only on that drawer.
//
// On a desk the panel's right edge is a handle that sets its width, from 220
// to 480px, by dragging, by the arrow keys (16px a press), or Home and End;
// a double-click puts it back to 288. The width is stored apart from the
// collapsed choice, so hiding the panel keeps it, and theme-boot.js applies
// it before first paint. While the handle drags, the shell takes the
// resizing class, which keeps the Focus frame from catching the pointer.
// A phone's drawer has no handle.
//
// The `now` section, shown for a view with no panel of its own (Focus), is
// drawn here from the snapshot on every state change (update(state)) and
// fetches nothing: the agents waiting on Hunter (the ones the rail's Home dot
// counts), the open notifications, newest first, and today's brief, each
// group with a sentence when it is empty. A row opens its target through
// the shell's shellApi, handed over once with attach(), and on a phone
// closes the drawer first. Every text node is set with textContent.
// Loaded before shell.js, which reaches it through window.DashboardPanel.
(function () {
  'use strict';

  var STORAGE_KEY = 'dashboard.panelHidden';
  // The Agents list's own toggle stored its choice here before the panel.
  var OLD_KEY = 'dashboard.agentsListHidden';

  var shell = document.querySelector('.shell');
  var toggle = document.getElementById('panel-toggle');
  var scrim = document.getElementById('panel-scrim');
  if (!shell || !toggle || !scrim) return;
  var phone = window.matchMedia('(max-width: 719.98px)');

  function readHidden() {
    try {
      var old = window.localStorage.getItem(OLD_KEY);
      if (old !== null) {
        window.localStorage.removeItem(OLD_KEY);
        if (old === '1' && window.localStorage.getItem(STORAGE_KEY) === null) window.localStorage.setItem(STORAGE_KEY, '1');
      }
      return window.localStorage.getItem(STORAGE_KEY) === '1';
    } catch (err) {
      return false;
    }
  }

  function writeHidden(hidden) {
    try {
      if (hidden) window.localStorage.setItem(STORAGE_KEY, '1');
      else window.localStorage.removeItem(STORAGE_KEY);
    } catch (err) {
      // No storage: the choice just does not persist.
    }
  }

  function isPhone() { return phone.matches; }

  function shown() {
    return isPhone() ? shell.classList.contains('panel-open') : !shell.classList.contains('panel-collapsed');
  }

  function render() {
    var open = shown();
    var label = open ? 'Hide side panel' : 'Show side panel';
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-label', label);
    toggle.setAttribute('title', label);
    scrim.hidden = !(isPhone() && open);
  }

  // The drawer, on a phone; a desk's panel answers only to the toggle.
  function openPanel() {
    if (!isPhone()) return;
    shell.classList.add('panel-slides', 'panel-open');
    render();
  }

  function closePanel() {
    if (!isPhone()) return;
    shell.classList.remove('panel-open');
    render();
  }

  function setCollapsed(hidden) {
    shell.classList.toggle('panel-collapsed', hidden);
    writeHidden(hidden);
    render();
  }

  shell.classList.toggle('panel-collapsed', readHidden());
  render();

  toggle.addEventListener('click', function () {
    if (isPhone()) {
      if (shown()) closePanel();
      else openPanel();
    } else {
      setCollapsed(shown());
    }
    toggle.focus();
  });

  scrim.addEventListener('click', closePanel);

  // On window, so every layer's own Escape on the document (quick chat,
  // notifications, the menu) runs first and the drawer closes only when
  // none of them took the key.
  window.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape' || event.defaultPrevented || !isPhone() || !shown()) return;
    closePanel();
    toggle.focus();
  });

  // A phone's drawer does not outlive the phone; the desk's stored choice
  // is kept apart from it throughout.
  phone.addEventListener('change', function () {
    if (!isPhone()) shell.classList.remove('panel-open', 'panel-slides');
    render();
  });

  // The width, on a desk.
  var WIDTH_KEY = 'dashboard.panelWidth';
  var MIN_WIDTH = 220;
  var MAX_WIDTH = 480;
  var DEFAULT_WIDTH = 288;
  var STEP = 16;
  var handle = document.getElementById('panel-resize');
  var width = DEFAULT_WIDTH;
  var drag = null; // { pointer, startX, startWidth, moved } while the handle drags

  function clampWidth(value) {
    return Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, value)));
  }

  function readWidth() {
    try {
      var value = Number(window.localStorage.getItem(WIDTH_KEY));
      return value > 0 && isFinite(value) ? clampWidth(value) : DEFAULT_WIDTH;
    } catch (err) {
      return DEFAULT_WIDTH;
    }
  }

  function writeWidth(value) {
    try {
      if (value === null) window.localStorage.removeItem(WIDTH_KEY);
      else window.localStorage.setItem(WIDTH_KEY, String(value));
    } catch (err) {
      // No storage: the width holds for this page only.
    }
  }

  function applyWidth(value) {
    width = clampWidth(value);
    document.documentElement.style.setProperty('--panel-w', width + 'px');
    if (handle) handle.setAttribute('aria-valuenow', String(width));
  }

  function endDrag() {
    if (!drag) return;
    var moved = drag.moved;
    drag = null;
    shell.classList.remove('panel-resizing');
    // A click that did not move, a double-click's halves included, stores nothing.
    if (moved) writeWidth(width);
  }

  if (handle) {
    applyWidth(readWidth());

    handle.addEventListener('pointerdown', function (event) {
      if (isPhone() || event.button !== 0) return;
      event.preventDefault();
      drag = { pointer: event.pointerId, startX: event.clientX, startWidth: width, moved: false };
      handle.setPointerCapture(event.pointerId);
      shell.classList.add('panel-resizing');
    });

    handle.addEventListener('pointermove', function (event) {
      if (!drag || event.pointerId !== drag.pointer) return;
      if (event.clientX !== drag.startX) drag.moved = true;
      applyWidth(drag.startWidth + event.clientX - drag.startX);
    });

    handle.addEventListener('pointerup', endDrag);
    handle.addEventListener('pointercancel', endDrag);
    handle.addEventListener('lostpointercapture', endDrag);

    handle.addEventListener('dblclick', function () {
      if (isPhone()) return;
      applyWidth(DEFAULT_WIDTH);
      writeWidth(null);
    });

    handle.addEventListener('keydown', function (event) {
      if (isPhone()) return;
      var next = null;
      if (event.key === 'ArrowLeft') next = width - STEP;
      else if (event.key === 'ArrowRight') next = width + STEP;
      else if (event.key === 'Home') next = MIN_WIDTH;
      else if (event.key === 'End') next = MAX_WIDTH;
      if (next === null) return;
      event.preventDefault();
      applyWidth(next);
      writeWidth(width);
    });
  }

  // The Now section.
  var now = document.querySelector('[data-panel-for="now"]');
  var shellApi = null;
  var drawn = null; // the JSON text of what the section shows

  function element(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function pad(value) { return (value < 10 ? '0' : '') + value; }

  // Today as YYYY-MM-DD, a local calendar day.
  function today() {
    var day = new Date();
    return day.getFullYear() + '-' + pad(day.getMonth() + 1) + '-' + pad(day.getDate());
  }

  function formatTime(iso) {
    return window.DashboardJobs && window.DashboardJobs.formatTime ? window.DashboardJobs.formatTime(iso, Date.now()) : '';
  }

  function clockWords(iso) {
    var time = typeof iso === 'string' ? new Date(iso) : null;
    if (!time || isNaN(time.getTime())) return '';
    return time.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }

  // The same agents the rail's Home dot counts (shell.js).
  function waitingOnYou(agent) {
    return agent.state === 'waiting' || agent.needsYou === true || agent.unread === true ||
      (Array.isArray(agent.forwarded) && agent.forwarded.length > 0);
  }

  // What the section shows, as plain data, so an unchanged state redraws
  // nothing and a focused row keeps its focus.
  function model(state) {
    var agents = state && Array.isArray(state.agents) ? state.agents : [];
    var items = state && state.notifications && Array.isArray(state.notifications.items) ? state.notifications.items : [];
    var brief = state && state.brief ? state.brief : null;
    var overlay = window.DashboardBriefOverlay;
    return {
      agents: agents.filter(function (agent) { return agent && typeof agent === 'object' && waitingOnYou(agent); }).map(function (agent) {
        var last = agent.lastMessage && typeof agent.lastMessage.text === 'string' ? agent.lastMessage.text : '';
        return { id: agent.id, name: agent.name || agent.id, preview: last };
      }),
      // The snapshot keeps them newest first.
      notifications: items.filter(function (item) {
        return item && typeof item === 'object' && typeof item.acknowledgedAt !== 'string';
      }).map(function (item) {
        return { id: item.id, text: item.text, when: formatTime(item.at), link: typeof item.link === 'string' ? item.link : null };
      }),
      // The snapshot carries no time for the brief today; one under `at`
      // would show as when it landed.
      brief: brief && brief.state === 'ready' && brief.date === today()
        ? {
          date: brief.date,
          title: overlay && overlay.dayWords ? overlay.dayWords(brief.date) : brief.date,
          landed: clockWords(brief.at),
        }
        : null,
    };
  }

  function group(name, heading) {
    var node = element('div', 'now-group');
    node.setAttribute('data-now-group', name);
    node.appendChild(element('h2', 'panel-heading', heading));
    return node;
  }

  // A row of two lines, the second muted; a button when it opens something.
  function row(tag, name, detail) {
    var node = element(tag, 'panel-row now-row');
    if (tag === 'button') node.type = 'button';
    var text = element('span', 'now-row-text');
    text.appendChild(element('span', 'panel-row-name', name));
    if (detail) text.appendChild(element('span', 'now-row-detail', detail));
    node.appendChild(text);
    return node;
  }

  function renderNow(data) {
    now.textContent = '';

    var waiting = group('agents', 'Waiting on you');
    data.agents.forEach(function (agent) {
      var node = row('button', agent.name, agent.preview);
      node.setAttribute('data-now-agent', agent.id);
      node.insertBefore(element('span', 'agent-row-dot agent-row-dot-wait'), node.firstChild);
      waiting.appendChild(node);
    });
    if (data.agents.length === 0) waiting.appendChild(element('p', 'now-empty', 'No one is waiting on you.'));
    now.appendChild(waiting);

    var notices = group('notifications', 'Notifications');
    data.notifications.forEach(function (item) {
      var link = window.DashboardNotifications ? window.DashboardNotifications.parseLink(item.link) : null;
      var node = row(link ? 'button' : 'div', item.text, item.when);
      node.setAttribute('data-now-notification', item.id);
      if (link) node.setAttribute('data-now-link', item.link);
      node.title = item.text;
      notices.appendChild(node);
    });
    if (data.notifications.length === 0) notices.appendChild(element('p', 'now-empty', 'There are no notifications.'));
    now.appendChild(notices);

    var brief = group('brief', 'Brief');
    if (data.brief) {
      var node = row('button', data.brief.title, data.brief.landed ? 'Landed at ' + data.brief.landed : '');
      node.setAttribute('data-now-brief', data.brief.date);
      brief.appendChild(node);
    } else {
      brief.appendChild(element('p', 'now-empty', 'No brief today.'));
    }
    now.appendChild(brief);
  }

  function update(state) {
    if (!now) return;
    var data = model(state);
    var text = JSON.stringify(data);
    if (text === drawn) return;
    drawn = text;
    renderNow(data);
  }

  // The notifications panel's mapping from a link to what it opens.
  function follow(value) {
    var link = window.DashboardNotifications ? window.DashboardNotifications.parseLink(value) : null;
    if (!link) return;
    if (link.kind === 'agent') shellApi.openAgent(link.target);
    else if (link.kind === 'job') shellApi.openJob(link.target);
    else if (link.kind === 'feed') shellApi.openFeedItem(link.run, link.index);
    else if (link.kind === 'brief') shellApi.openBrief(link.target);
  }

  if (now) {
    now.addEventListener('click', function (event) {
      var button = event.target.closest && event.target.closest('button.now-row');
      if (!button || !shellApi) return;
      closePanel();
      if (button.hasAttribute('data-now-agent')) shellApi.openAgent(button.getAttribute('data-now-agent'));
      else if (button.hasAttribute('data-now-link')) follow(button.getAttribute('data-now-link'));
      else if (button.hasAttribute('data-now-brief')) shellApi.openBrief(button.getAttribute('data-now-brief'), button);
    });
  }

  window.DashboardPanel = {
    openPanel: openPanel,
    closePanel: closePanel,
    isPhone: isPhone,
    attach: function (api) { shellApi = api; },
    update: update,
  };
}());
