// Routines view: one card per agent with scheduled jobs, one row per job,
// rendered from the shell's state. The shell calls create({ requestState,
// isStreaming }) once and then update(state, keys) on every change (keys is
// null for a whole snapshot), show() when the view opens, and hide() when it
// closes or the tab is hidden. Cards are rebuilt only while the view is
// shown; show() renders the latest state.
//
// Routines are refreshed only on demand: when the view opens and the last
// refresh is missing or older than 60 seconds, and when Refresh is chosen.
// The Focus card carries Pause or Resume, forwarded to Focus; the server
// refreshes routines after either succeeds, and the card follows the state.
// A failed Pause or Resume is reported in the card until the next attempt or
// until the state shows Focus paused or resumed.
(function () {
  'use strict';

  var STALE_MS = 60000;
  var TICK_MS = 60000;
  var FOCUS_SCAN_PREFIX = 'com.focus.scan-';
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var BADGES = {
    ok: { text: 'OK', tone: 'good' },
    wrote: { text: 'Wrote', tone: 'good' },
    'no change': { text: 'No change', tone: 'good' },
    skipped: { text: 'Skipped', tone: 'wait' },
    'never ran': { text: 'Never ran', tone: 'wait' },
    running: { text: 'Running', tone: 'wait' },
    failed: { text: 'Failed', tone: 'bad' },
    'not loaded': { text: 'Not loaded', tone: 'wait' },
    unknown: { text: 'Unknown', tone: 'wait' },
  };
  var WATCHED = ['routines', 'registry', 'focus', 'agents'];

  function pad(n) {
    return n < 10 ? '0' + n : String(n);
  }

  function clock(date) {
    return pad(date.getHours()) + ':' + pad(date.getMinutes());
  }

  // "just now", "N minutes ago", "N hours ago" under a day; "Yesterday HH:MM"
  // under two; "Mon D HH:MM" otherwise. Local time, 24-hour clock.
  function formatTime(iso, now) {
    var time = Date.parse(iso);
    if (typeof iso !== 'string' || isNaN(time)) return '';
    var diff = now - time;
    if (diff < 60000) return 'just now';
    if (diff < 3600000) {
      var minutes = Math.floor(diff / 60000);
      return minutes === 1 ? '1 minute ago' : minutes + ' minutes ago';
    }
    if (diff < 86400000) {
      var hours = Math.floor(diff / 3600000);
      return hours === 1 ? '1 hour ago' : hours + ' hours ago';
    }
    var date = new Date(time);
    if (diff < 172800000) return 'Yesterday ' + clock(date);
    return MONTHS[date.getMonth()] + ' ' + date.getDate() + ' ' + clock(date);
  }

  function element(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function isFocusScan(item) {
    return typeof item.label === 'string' && item.label.indexOf(FOCUS_SCAN_PREFIX) === 0;
  }

  function badgeFor(item) {
    if (item.available === false) return BADGES.unknown;
    var badge = BADGES[item.outcome] || BADGES.unknown;
    if (item.outcome === 'failed' && typeof item.exitStatus === 'number') {
      return { text: badge.text + ' (exit ' + item.exitStatus + ')', tone: badge.tone };
    }
    return badge;
  }

  // Cards in agent order, each with that agent's routines; routines naming an
  // agent the registry no longer lists come last under their own name.
  function groups(state) {
    var byAgent = {};
    var order = [];
    var items = state.routines.items || [];
    for (var i = 0; i < items.length; i += 1) {
      var id = items[i].agentId;
      if (!Object.prototype.hasOwnProperty.call(byAgent, id)) {
        byAgent[id] = [];
        order.push(id);
      }
      byAgent[id].push(items[i]);
    }
    var result = [];
    var seen = {};
    var agents = state.agents || [];
    for (var j = 0; j < agents.length; j += 1) {
      var agent = agents[j];
      if (!Object.prototype.hasOwnProperty.call(byAgent, agent.id)) continue;
      seen[agent.id] = true;
      result.push({ id: agent.id, name: agent.name, role: agent.role, items: byAgent[agent.id] });
    }
    for (var k = 0; k < order.length; k += 1) {
      if (seen[order[k]]) continue;
      var first = byAgent[order[k]][0];
      result.push({ id: order[k], name: first.agentName || order[k], role: null, items: byAgent[order[k]] });
    }
    return result;
  }

  // Whether the state shows any Focus scan paused.
  function focusPaused(state) {
    var items = state && state.routines && state.routines.items ? state.routines.items : [];
    return items.some(function (item) { return isFocusScan(item) && item.paused === true; });
  }

  function create(shell) {
    var updated = document.getElementById('routines-updated');
    var refreshButton = document.getElementById('routines-refresh');
    var message = document.getElementById('routines-message');
    var cards = document.getElementById('routines-cards');

    var state = null;
    var visible = false;
    var checkOnOpen = false;
    var refreshing = false; // our refresh request is out
    var pauseBusy = false;
    var pauseError = ''; // why the last Pause or Resume failed, or ''
    var tick = null;

    function row(item) {
      var li = element('li', 'routine-row');
      li.appendChild(element('span', 'routine-name', item.name));
      var when = element('span', 'routine-when');
      when.appendChild(element('span', 'routine-schedule', item.schedule && item.schedule.text ? item.schedule.text : ''));
      var run = element('span', 'routine-run');
      run.appendChild(element('span', null, item.lastRun ? formatTime(item.lastRun, Date.now()) : 'Never run'));
      if (isFocusScan(item) && typeof item.failures24h === 'number' && item.failures24h > 0) {
        run.appendChild(element('span', 'routine-failures',
          item.failures24h === 1 ? '1 failure today' : item.failures24h + ' failures today'));
      }
      when.appendChild(run);
      li.appendChild(when);
      var badge = badgeFor(item);
      li.appendChild(element('span', 'badge badge-' + badge.tone, badge.text));
      return li;
    }

    function card(group) {
      var section = element('section', 'routine-card');
      var headingId = 'routines-agent-' + group.id;
      section.setAttribute('aria-labelledby', headingId);
      var header = element('div', 'card-header');
      var title = element('h2', 'card-name', group.name);
      title.id = headingId;
      header.appendChild(title);
      if (group.role) header.appendChild(element('span', 'role-chip', group.role));

      var scans = group.items.filter(isFocusScan);
      if (scans.length > 0) {
        var paused = scans.some(function (item) { return item.paused === true; });
        if (paused) header.appendChild(element('span', 'badge badge-wait', 'Paused'));
        var button = element('button', 'button card-action', paused ? 'Resume' : 'Pause');
        button.type = 'button';
        button.setAttribute('data-routines-action', paused ? 'resume' : 'pause');
        button.disabled = pauseBusy;
        header.appendChild(button);
      }
      section.appendChild(header);

      if (scans.length > 0 && state.routines.focusAvailable === false) {
        section.appendChild(element('p', 'card-note', 'Focus is not responding; showing launchd status.'));
      }
      if (scans.length > 0 && pauseError) {
        var failure = element('p', 'card-error', pauseError);
        failure.setAttribute('role', 'status');
        section.appendChild(failure);
      }

      var list = element('ul', 'routine-list');
      for (var i = 0; i < group.items.length; i += 1) list.appendChild(row(group.items[i]));
      section.appendChild(list);
      return section;
    }

    // `code`, when given, follows the text in a muted span.
    function setMessage(text, code) {
      message.textContent = text || '';
      if (text && code) {
        message.appendChild(document.createTextNode(' '));
        message.appendChild(element('span', 'routines-code', code));
      }
      message.hidden = !text;
    }

    function render() {
      if (!state) return;
      var routines = state.routines;
      var busy = refreshing || routines.refreshing === true;
      refreshButton.textContent = busy ? 'Refreshing…' : 'Refresh';
      refreshButton.disabled = busy;
      updated.textContent = routines.refreshedAt ? 'Updated ' + formatTime(routines.refreshedAt, Date.now()) : '';

      // Keep keyboard focus on the card's button across a re-render.
      var active = document.activeElement;
      var hadFocus = !!active && cards.contains(active) && active.hasAttribute('data-routines-action');

      cards.textContent = '';
      if (state.registry && state.registry.ok === false) {
        setMessage('The registry could not be read.', state.registry.error || null);
        return;
      }
      if (routines.error) setMessage('Routines could not be refreshed.');
      else if (routines.refreshedAt && (routines.items || []).length === 0) setMessage('No routines are registered.');
      else setMessage('');

      var list = groups(state);
      for (var i = 0; i < list.length; i += 1) cards.appendChild(card(list[i]));
      if (hadFocus) {
        var again = cards.querySelector('[data-routines-action]');
        if (again) again.focus();
      }
    }

    function stale() {
      var at = state.routines.refreshedAt;
      var time = at ? Date.parse(at) : NaN;
      return isNaN(time) || Date.now() - time > STALE_MS;
    }

    function maybeRefreshOnOpen() {
      if (!visible || !checkOnOpen || !state) return;
      checkOnOpen = false;
      if (!refreshing && state.routines.refreshing !== true && stale()) refresh();
    }

    // Resolves to the response, or null when the request itself failed.
    function post(path) {
      return fetch(path, { method: 'POST', cache: 'no-store', credentials: 'same-origin' })
        .then(function (response) { return response; }, function () { return null; });
    }

    function refresh() {
      if (refreshing) return;
      refreshing = true;
      render();
      post('/api/routines/refresh').then(function () {
        refreshing = false;
        // `ok` only says the control ran; the outcome arrives in the state.
        if (!shell.isStreaming()) shell.requestState();
        render();
      });
    }

    function togglePause(action) {
      if (pauseBusy) return;
      pauseBusy = true;
      pauseError = '';
      render();
      post(action === 'resume' ? '/api/resume' : '/api/pause').then(function (response) {
        var ok = !!response && response.ok;
        pauseBusy = false;
        pauseError = ok ? '' : response ? 'Focus reported an error.' : 'Focus did not respond.';
        if (ok && !shell.isStreaming()) shell.requestState();
        render();
      });
    }

    refreshButton.addEventListener('click', refresh);
    cards.addEventListener('click', function (event) {
      var button = event.target.closest && event.target.closest('button[data-routines-action]');
      if (button && !button.disabled) togglePause(button.getAttribute('data-routines-action'));
    });

    return {
      update: function (next, keys) {
        if (pauseError && state && focusPaused(state) !== focusPaused(next)) pauseError = '';
        state = next;
        var touched = !keys || keys.some(function (key) { return WATCHED.indexOf(key) !== -1; });
        if (touched && visible) render();
        maybeRefreshOnOpen();
      },
      show: function () {
        if (!visible) checkOnOpen = true;
        visible = true;
        if (tick === null) tick = setInterval(render, TICK_MS);
        render();
        maybeRefreshOnOpen();
      },
      hide: function () {
        visible = false;
        if (tick !== null) clearInterval(tick);
        tick = null;
      },
    };
  }

  window.DashboardRoutines = { create: create, formatTime: formatTime };
}());
