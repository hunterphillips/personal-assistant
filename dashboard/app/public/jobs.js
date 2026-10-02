// The Health view: one card per agent with launchd jobs, one row per job,
// rendered from the shell's state, with what is off (the Codex server,
// cmux) above the cards, from the snapshot's `jobs` key. The shell calls
// create({ requestState, isStreaming }) once, then update(state, keys) on
// every change (keys is null for a whole snapshot), show() when the view
// opens, and hide() when it closes or the tab is hidden. Nothing is rebuilt
// while off screen; show() renders the latest state.
//
// Jobs are refreshed only on demand: when the view opens and the last
// refresh is missing or older than 60 seconds, and when Refresh is chosen.
// The Focus card carries Pause or Resume, forwarded to Focus; the server
// refreshes jobs after either succeeds, and the card follows the state.
// A failed Pause or Resume is reported there until the next attempt or
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
  var WATCHED = ['jobs', 'registry', 'focus', 'agents', 'codex', 'cmux'];

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

  // Cards in agent order, each with that agent's jobs; jobs naming an
  // agent the registry no longer lists come last under their own name.
  function groups(state) {
    var byAgent = {};
    var order = [];
    var items = state.jobs.items || [];
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
    var items = state && state.jobs && state.jobs.items ? state.jobs.items : [];
    return items.some(function (item) { return isFocusScan(item) && item.paused === true; });
  }

  function create(shell) {
    var updated = document.getElementById('jobs-updated');
    var refreshButton = document.getElementById('jobs-refresh');
    var message = document.getElementById('jobs-message');
    var cards = document.getElementById('jobs-cards');
    var availability = document.getElementById('health-availability');

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

    // One agent's jobs as a card with the agent's name and role.
    function section(group) {
      var node = element('section', 'routine-card');
      var header = element('div', 'card-header');
      var headingId = 'jobs-agent-' + group.id;
      node.setAttribute('aria-labelledby', headingId);
      var title = element('h3', 'card-name', group.name);
      title.id = headingId;
      header.appendChild(title);
      // A role that only repeats the name is not shown as a chip.
      if (group.role && group.role !== group.name) header.appendChild(element('span', 'role-chip', group.role));

      var scans = group.items.filter(isFocusScan);
      if (scans.length > 0) {
        var paused = scans.some(function (item) { return item.paused === true; });
        if (paused) header.appendChild(element('span', 'badge badge-wait', 'Paused'));
        var button = element('button', 'button card-action', paused ? 'Resume' : 'Pause');
        button.type = 'button';
        button.setAttribute('data-jobs-action', paused ? 'resume' : 'pause');
        button.disabled = pauseBusy;
        header.appendChild(button);
      }
      node.appendChild(header);

      if (scans.length > 0 && state.jobs.focusAvailable === false) {
        node.appendChild(element('p', 'card-note', 'Focus is not responding; showing launchd status.'));
      }
      if (scans.length > 0 && pauseError) {
        var failure = element('p', 'card-error', pauseError);
        failure.setAttribute('role', 'status');
        node.appendChild(failure);
      }

      var list = element('ul', 'routine-list');
      for (var i = 0; i < group.items.length; i += 1) list.appendChild(row(group.items[i]));
      node.appendChild(list);
      return node;
    }

    // Replaces the cards, keeping keyboard focus on a Pause or Resume
    // button across the rebuild.
    function rebuildCards() {
      var active = document.activeElement;
      var hadFocus = !!active && cards.contains(active) && active.hasAttribute('data-jobs-action');
      cards.textContent = '';
      var list = groups(state);
      for (var i = 0; i < list.length; i += 1) cards.appendChild(section(list[i]));
      if (hadFocus) {
        var again = cards.querySelector('[data-jobs-action]');
        if (again) again.focus();
      }
    }

    // What is off, above the heading; nothing while both answer. The
    // sentences are the Agents view's, which says the same per row.
    function renderAvailability() {
      var agents = window.DashboardAgents;
      availability.textContent = '';
      var lines = agents ? [agents.codexSentence(state.codex), agents.cmuxSentence(state.cmux)] : [];
      for (var i = 0; i < lines.length; i += 1) if (lines[i]) availability.appendChild(element('p', null, lines[i]));
      availability.hidden = availability.childNodes.length === 0;
    }

    // `code`, when given, follows the text in a muted span.
    function setMessage(text, code) {
      message.textContent = text || '';
      if (text && code) {
        message.appendChild(document.createTextNode(' '));
        message.appendChild(element('span', 'jobs-code', code));
      }
      message.hidden = !text;
    }

    function render() {
      if (!state || !visible) return;
      var jobs = state.jobs;
      var busy = refreshing || jobs.refreshing === true;
      refreshButton.textContent = busy ? 'Refreshing…' : 'Refresh';
      refreshButton.disabled = busy;
      updated.textContent = jobs.refreshedAt ? 'Updated ' + formatTime(jobs.refreshedAt, Date.now()) : '';

      // A bad registry edit keeps the last good agents on the server, so the
      // cards stay while the sentence says the file could not be read.
      if (state.registry && state.registry.ok === false) setMessage('The registry could not be read.', state.registry.error || null);
      else if (jobs.error) setMessage('Jobs could not be refreshed.');
      else if (jobs.refreshedAt && (jobs.items || []).length === 0) setMessage('No jobs are registered.');
      else setMessage('');

      renderAvailability();
      rebuildCards();
    }

    function stale() {
      var at = state.jobs.refreshedAt;
      var time = at ? Date.parse(at) : NaN;
      return isNaN(time) || Date.now() - time > STALE_MS;
    }

    function maybeRefreshOnOpen() {
      if (!visible || !checkOnOpen || !state) return;
      checkOnOpen = false;
      if (!refreshing && state.jobs.refreshing !== true && stale()) refresh();
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
      post('/api/jobs/refresh').then(function () {
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
        // 502 and 504 come from the dashboard's proxy when Focus gave no
        // usable answer; any other error status is Focus's own.
        var unreachable = !response || response.status === 502 || response.status === 504;
        pauseError = ok ? '' : unreachable ? 'Focus did not respond.' : 'Focus reported an error.';
        if (ok && !shell.isStreaming()) shell.requestState();
        render();
      });
    }

    refreshButton.addEventListener('click', refresh);
    // Pause and Resume exist only in what this module renders.
    document.addEventListener('click', function (event) {
      var button = event.target.closest && event.target.closest('button[data-jobs-action]');
      if (button && !button.disabled) togglePause(button.getAttribute('data-jobs-action'));
    });

    return {
      update: function (next, keys) {
        if (pauseError && state && focusPaused(state) !== focusPaused(next)) pauseError = '';
        state = next;
        var touched = !keys || keys.some(function (key) { return WATCHED.indexOf(key) !== -1; });
        if (touched) render();
        maybeRefreshOnOpen();
      },
      // Renders once when the view comes on screen; while it stays there,
      // update() alone rebuilds it, so a repeated show() changes nothing.
      // Relative times move while it is on screen.
      show: function () {
        if (visible) return;
        visible = true;
        checkOnOpen = true;
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

  window.DashboardJobs = { create: create, formatTime: formatTime };
}());
