// Notifications: the header's count and the list under it. Everything comes
// from the snapshot's `notifications` ({ open, items }, newest first), so
// every open browser shows the same count; this module only renders it and
// sends Acknowledge (POST /api/notifications/:id/acknowledge) and
// Acknowledge all (POST /api/notifications/acknowledge), then lets the next
// delta redraw. The count sits on the header's Notifications entry when it
// is above zero; on a phone, where that entry lives in the menu, it sits on
// the menu toggle and on the entry inside the menu.
//
// The list is a popover under the header: open items first, then the
// acknowledged ones under a divider. Each shows the agent's name (its id
// when the registry no longer lists it), the sentence, when, and the link
// as the name of what it opens; a link opens through the shell:
// agent:<id> the agent's thread, job:<label> Health with that job selected,
// feed:<run>/<index> the Feed scrolled to that item, brief:<date> the
// Brief. Escape and a click outside close it. A feed link's name is the
// post's title, read from /api/feeds and each feed's read when the list
// opens (the first feed holding that run wins, and it is the feed the link
// opens); until then, or when the post is gone, it is "Feed item". Every text node is set with
// textContent. Buttons carry data-notification-*, never data-action, which
// the shell's own click handler owns.
(function () {
  'use strict';

  var NO_ANSWER = 'The dashboard did not respond.';
  var GONE = 'That notification is no longer kept.';
  var TIMEOUT_MS = 8000;
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  function element(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  // { kind, target } for a link the shell can open, or null.
  function parseLink(link) {
    if (typeof link !== 'string') return null;
    var colon = link.indexOf(':');
    if (colon === -1) return null;
    var kind = link.slice(0, colon);
    var target = link.slice(colon + 1);
    if (kind === 'agent' || kind === 'job') return target ? { kind: kind, target: target } : null;
    if (kind === 'brief') return /^\d{4}-\d{2}-\d{2}$/.test(target) ? { kind: kind, target: target } : null;
    if (kind === 'feed') {
      var match = /^(\d{4}-\d{2}-\d{2}-[a-z][a-z0-9-]*)\/(\d{1,4})$/.exec(target);
      return match ? { kind: kind, target: target, run: match[1], index: Number(match[2]) } : null;
    }
    return null;
  }

  function dateWords(text) {
    var match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
    if (!match) return text;
    return MONTHS[Number(match[2]) - 1] + ' ' + Number(match[3]);
  }

  function formatTime(iso) {
    return window.DashboardJobs && window.DashboardJobs.formatTime ? window.DashboardJobs.formatTime(iso, Date.now()) : '';
  }

  function post(path) {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, TIMEOUT_MS);
    return fetch(path, { method: 'POST', credentials: 'same-origin', signal: controller.signal }).then(function (response) {
      return response.json().then(function (body) { return { status: response.status, body: body }; }, function () {
        return { status: response.status, body: null };
      });
    }, function () {
      return null;
    }).then(function (result) {
      clearTimeout(timer);
      return result;
    });
  }

  function create(shellApi) {
    var toggle = document.getElementById('notifications-toggle');
    var count = document.getElementById('notifications-count');
    var menuEntry = document.getElementById('notifications-menu-entry');
    var menuEntryCount = document.getElementById('notifications-menu-count');
    var menuToggle = document.getElementById('app-menu-toggle');
    var menuCount = document.getElementById('app-menu-count');
    var panel = document.getElementById('notifications-panel');
    var openList = document.getElementById('notifications-open');
    var doneList = document.getElementById('notifications-acknowledged');
    var divider = document.getElementById('notifications-divider');
    var empty = document.getElementById('notifications-empty');
    var all = document.getElementById('notifications-acknowledge-all');
    var reason = document.getElementById('notifications-reason');
    if (!toggle || !panel) return null;

    var state = null;
    var pending = {}; // ids with a request out
    var feedTitles = {}; // 'run/index' -> { title, feed }, from /api/feeds
    var opener = toggle; // what gets focus back on Escape

    function data() {
      var value = state && state.notifications;
      return {
        open: value && typeof value.open === 'number' ? value.open : 0,
        items: value && Array.isArray(value.items) ? value.items.filter(function (item) { return item && typeof item === 'object'; }) : [],
      };
    }

    // The snapshot's agent, or { id, name: id } for one no longer listed.
    function agentOf(id) {
      var agents = state && Array.isArray(state.agents) ? state.agents : [];
      for (var i = 0; i < agents.length; i += 1) if (agents[i].id === id) return agents[i];
      return { id: id, name: id };
    }

    function agentName(id) {
      return agentOf(id).name || id;
    }

    function jobName(label) {
      var items = state && state.jobs && Array.isArray(state.jobs.items) ? state.jobs.items : [];
      for (var i = 0; i < items.length; i += 1) if (items[i].label === label) return items[i].name || label;
      return label;
    }

    function linkName(link) {
      if (link.kind === 'agent') return agentName(link.target);
      if (link.kind === 'job') return jobName(link.target);
      if (link.kind === 'brief') return 'Brief for ' + dateWords(link.target);
      return Object.prototype.hasOwnProperty.call(feedTitles, link.target) ? feedTitles[link.target].title : 'Feed item';
    }

    function setCount(node, value) {
      if (!node) return;
      node.textContent = value > 0 ? String(value) : '';
      node.hidden = value <= 0;
    }

    function renderCount() {
      var open = data().open;
      setCount(count, open);
      setCount(menuEntryCount, open);
      setCount(menuCount, open);
      var label = open > 0 ? 'Notifications, ' + open + ' open' : 'Notifications';
      toggle.setAttribute('aria-label', label);
      if (menuEntry) menuEntry.setAttribute('aria-label', label);
    }

    function row(item) {
      var li = element('li', 'notification');
      li.setAttribute('data-notification-id', item.id);
      var meta = element('div', 'notification-meta');
      var who = element('span', 'notification-who');
      who.appendChild(window.DashboardAvatar.node(agentOf(item.agent), 'small'));
      who.appendChild(element('span', 'notification-agent', agentName(item.agent)));
      meta.appendChild(who);
      var time = element('time', 'notification-time', formatTime(item.at));
      time.setAttribute('datetime', item.at);
      meta.appendChild(time);
      li.appendChild(meta);
      li.appendChild(element('p', 'notification-text', item.text));
      var link = parseLink(item.link);
      var acknowledged = typeof item.acknowledgedAt === 'string';
      if (link || !acknowledged) {
        var actions = element('div', 'notification-actions');
        if (link) {
          var open = element('button', 'notification-link', linkName(link));
          open.type = 'button';
          open.setAttribute('data-notification-link', item.link);
          actions.appendChild(open);
        }
        if (!acknowledged) {
          var button = element('button', 'button notification-acknowledge', 'Acknowledge');
          button.type = 'button';
          button.setAttribute('data-notification-action', 'acknowledge');
          button.disabled = !!pending[item.id];
          actions.appendChild(button);
        }
        li.appendChild(actions);
      }
      return li;
    }

    function renderList() {
      var value = data();
      var open = value.items.filter(function (item) { return typeof item.acknowledgedAt !== 'string'; });
      var done = value.items.filter(function (item) { return typeof item.acknowledgedAt === 'string'; });
      openList.textContent = '';
      doneList.textContent = '';
      open.forEach(function (item) { openList.appendChild(row(item)); });
      done.forEach(function (item) { doneList.appendChild(row(item)); });
      openList.hidden = open.length === 0;
      doneList.hidden = done.length === 0;
      divider.hidden = done.length === 0;
      empty.hidden = value.items.length > 0;
      all.hidden = open.length === 0;
      all.disabled = !!pending['*'];
    }

    function render() {
      renderCount();
      if (!panel.hidden) renderList();
    }

    function showReason(text) {
      reason.textContent = text;
      reason.hidden = !text;
    }

    // Titles for the feed links in the list, read once per opening.
    function loadFeedTitles() {
      var wanted = data().items.some(function (item) {
        var link = parseLink(item.link);
        return link && link.kind === 'feed';
      });
      if (!wanted) return;
      var read = function (path) {
        return fetch(path, { credentials: 'same-origin' }).then(function (response) {
          return response.ok ? response.json() : null;
        }, function () { return null; });
      };
      read('/api/feeds').then(function (body) {
        var feeds = body && Array.isArray(body.feeds) ? body.feeds.filter(function (feed) {
          return feed && typeof feed.id === 'string';
        }) : [];
        return Promise.all(feeds.map(function (feed) {
          return read('/api/feeds/' + encodeURIComponent(feed.id)).then(function (answer) { return { feed: feed.id, body: answer }; });
        }));
      }).then(function (answers) {
        var titles = {};
        answers.forEach(function (answer) {
          if (!answer.body || !Array.isArray(answer.body.runs)) return;
          answer.body.runs.forEach(function (run) {
            if (!run || typeof run.id !== 'string' || !Array.isArray(run.items)) return;
            run.items.forEach(function (item, index) {
              var key = run.id + '/' + index;
              if (item && typeof item.title === 'string' && !Object.prototype.hasOwnProperty.call(titles, key)) {
                titles[key] = { title: item.title, feed: answer.feed };
              }
            });
          });
        });
        feedTitles = titles;
        if (!panel.hidden) renderList();
      }, function () {});
    }

    function open(from) {
      opener = from || toggle;
      showReason('');
      panel.hidden = false;
      toggle.setAttribute('aria-expanded', 'true');
      renderList();
      loadFeedTitles();
      var first = panel.querySelector('button:not([hidden]):not(:disabled)');
      if (first) first.focus();
    }

    function close(restore) {
      if (panel.hidden) return;
      panel.hidden = true;
      toggle.setAttribute('aria-expanded', 'false');
      if (restore && opener && opener.offsetParent !== null) opener.focus();
      else if (restore && menuToggle) menuToggle.focus();
    }

    function acknowledge(id) {
      var key = id || '*';
      if (pending[key]) return;
      pending[key] = true;
      showReason('');
      renderList();
      var path = id ? '/api/notifications/' + encodeURIComponent(id) + '/acknowledge' : '/api/notifications/acknowledge';
      post(path).then(function (result) {
        delete pending[key];
        if (!result || result.status !== 200) {
          var code = result && result.body && typeof result.body.error === 'string' ? result.body.error : null;
          showReason(result && result.status === 404 && code === 'no_such_notification' ? GONE : NO_ANSWER);
        }
        // The delta redraws; without a stream, ask for the state.
        if (!shellApi.isStreaming()) shellApi.requestState();
        if (!panel.hidden) renderList();
      });
    }

    function follow(value) {
      var link = parseLink(value);
      if (!link) return;
      close(false);
      if (link.kind === 'agent') shellApi.openAgent(link.target);
      else if (link.kind === 'job') shellApi.openJob(link.target);
      else if (link.kind === 'feed') {
        var found = Object.prototype.hasOwnProperty.call(feedTitles, link.target) ? feedTitles[link.target] : null;
        shellApi.openFeedItem(link.run, link.index, found ? found.feed : null);
      }
      else if (link.kind === 'brief') shellApi.openBrief(link.target);
    }

    toggle.setAttribute('aria-controls', 'notifications-panel');
    toggle.setAttribute('aria-expanded', 'false');
    toggle.addEventListener('click', function () {
      if (panel.hidden) open(toggle);
      else close(true);
    });
    if (menuEntry) menuEntry.addEventListener('click', function () {
      // The menu closes itself on an entry (theme.js); the list opens in
      // its place.
      open(menuToggle);
    });
    all.addEventListener('click', function () { acknowledge(null); });
    panel.addEventListener('click', function (event) {
      var button = event.target.closest && event.target.closest('button[data-notification-action="acknowledge"]');
      if (button) {
        var item = button.closest('[data-notification-id]');
        if (item) acknowledge(item.getAttribute('data-notification-id'));
        return;
      }
      var link = event.target.closest && event.target.closest('button[data-notification-link]');
      if (link) follow(link.getAttribute('data-notification-link'));
    });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && !panel.hidden) {
        event.preventDefault();
        close(true);
      }
    });
    document.addEventListener('click', function (event) {
      if (panel.hidden) return;
      // The path as dispatched: a click on Acknowledge redraws the list, so
      // its button may be gone from the page by the time this runs.
      var path = event.composedPath();
      if (path.indexOf(panel) !== -1 || path.indexOf(toggle) !== -1 || (menuEntry && path.indexOf(menuEntry) !== -1)) return;
      close(false);
    });

    return {
      update: function (next, keys) {
        state = next;
        var touched = !keys || keys.some(function (key) { return key === 'notifications' || key === 'agents' || key === 'jobs'; });
        if (touched) render();
      },
    };
  }

  window.DashboardNotifications = { create: create, parseLink: parseLink };
}());
