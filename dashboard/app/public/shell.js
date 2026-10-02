// Dashboard shell: switches between Agents (Home, agents.js), Reading (the
// Daily Brief on its Brief tab, feed.js on its Feed tab), Focus, Goals
// (goals.js), and Health (routines.js, the launchd jobs) with the History
// API, creates each child frame the first time its view is shown and keeps
// it afterwards, and keeps one copy of the server's state, which it hands
// to the Health, Agents, and Goals views. Agents is the page at `/`;
// `/agents` shows it too, `/reading` and `/feed` show Reading on the Feed
// tab, `/brief` shows it on the Brief tab, `/health` shows Health (the server
// redirects the old `/routines` there), and any unknown path lands on
// Agents. The brief frame is created only on
// the Brief tab and kept while the Feed tab is shown.
//
// State comes from the event stream (/api/events) while the tab is visible:
// `snapshot` replaces it, `delta` applies a patch when its revision is the
// next one, is dropped when it is not newer, and otherwise refetches
// /api/state, `reload` refetches, and `bye`
// closes and reconnects shortly after. Reconnecting is done here, not by
// EventSource: on any error the source is closed and reopened after 1, 2, 4,
// 8, then 15 seconds, reset by a snapshot. While the stream is down,
// /api/state is fetched every 30 seconds, and after a second failed attempt
// the shell notice offers Retry. Every view change also fetches /api/state.
//
// A frame is created only from state that has just arrived (a snapshot, a
// delta touching focus or brief, or a finished /api/state fetch), never from
// the copy kept since. A mounted frame is never replaced by a state change; a
// newer brief waits until "Load newer brief" is chosen. A frame whose page
// comes back as a JSON error is hidden and marked failed; the state is
// fetched again at once, and Retry reloads it.
(function () {
  'use strict';

  var ROUTES = {
    '/': 'agents', '/agents': 'agents', '/focus': 'focus',
    '/reading': 'reading', '/brief': 'reading', '/feed': 'reading', '/goals': 'goals', '/health': 'health',
  };
  var TITLES = { agents: 'Agents', reading: 'Reading', focus: 'Focus', goals: 'Goals', health: 'Health', feed: 'Feed' };
  var FALLBACK_POLL_MS = 30000;
  var STATE_TIMEOUT_MS = 5000;
  var BACKOFF_MS = [1000, 2000, 4000, 8000, 15000];
  var BYE_DELAY_MS = 500;
  var BRIEF_EMPTY = 'No brief has been generated yet.';
  var BRIEF_UNREADABLE = 'The latest brief file could not be read.';
  var FAILED = 'data-failed';

  var current = null;
  var tab = 'feed'; // the Reading tab: 'brief' or 'feed'
  var state = null; // latest snapshot, or null before the first one
  var applied = 0; // counts snapshots and deltas applied, to order fetches
  var sequence = 0;
  var frames = { focus: null, brief: null };
  var mountedBrief = null; // { date, revision } of the brief frame
  // Requests waiting for the next state that arrives: reload failed frames,
  // load the newer brief.
  var wantReload = false;
  var wantNewer = false;

  // Event stream
  var source = null;
  var streaming = false; // a snapshot arrived on the open source
  var failures = 0; // consecutive failed connections since the last snapshot
  var reconnectTimer = null;
  var fallbackTimer = null;

  var shellApi = {
    requestState: function () { fetchState(); },
    isStreaming: function () { return streaming; },
    // Lands on a persona's thread without a page load; a link with a query
    // is left to the browser.
    openAgent: function (id) {
      history.pushState(null, '', '/?agent=' + encodeURIComponent(id));
      show('agents');
    },
  };
  var routines = window.DashboardRoutines ? window.DashboardRoutines.create(shellApi) : null;
  var settings = window.DashboardSettings ? window.DashboardSettings.create(shellApi) : null;
  var agents = window.DashboardAgents ? window.DashboardAgents.create(shellApi) : null;
  var goals = window.DashboardGoals ? window.DashboardGoals.create(shellApi) : null;
  var feed = window.DashboardFeed ? window.DashboardFeed.create(shellApi) : null;

  function $(id) { return document.getElementById(id); }

  function viewFor(pathname) {
    return Object.prototype.hasOwnProperty.call(ROUTES, pathname) ? ROUTES[pathname] : 'agents';
  }

  function tabFor(pathname) {
    return pathname === '/brief' ? 'brief' : 'feed';
  }

  function onFeed() {
    return current === 'reading' && tab === 'feed';
  }

  function briefUrl(brief) {
    return '/embedded/brief/' + brief.date + '?revision=' + brief.revision;
  }

  function openFailed(date) {
    return 'The brief for ' + date + ' could not be opened.';
  }

  function briefSentence(brief) {
    if (brief && brief.state === 'empty') return BRIEF_EMPTY;
    return brief && typeof brief.date === 'string' ? openFailed(brief.date) : BRIEF_UNREADABLE;
  }

  function failed(frame) {
    return !!frame && frame.hasAttribute(FAILED);
  }

  function isReady(brief) {
    return !!brief && brief.state === 'ready' && typeof brief.date === 'string' && typeof brief.revision === 'string';
  }

  // The brief is known once the server has checked it at least once.
  function briefKnown() {
    return !!state && !!state.brief && state.brief.state !== 'unknown';
  }

  function focusAvailable() {
    return !!(state && state.focus && state.focus.available === true);
  }

  function focusDown() {
    return !!(state && state.focus && state.focus.available === false);
  }

  function createFrame(slot, id, title, src) {
    var frame = document.createElement('iframe');
    frame.id = id;
    frame.className = 'frame';
    frame.title = title;
    frame.src = src;
    // Hidden until its page arrives, so an error body is never shown.
    frame.hidden = true;
    frame.addEventListener('load', function () {
      var error = false;
      try {
        var doc = frame.contentDocument;
        error = !!doc && doc.contentType === 'application/json';
      } catch (_error) {
        error = false;
      }
      if (error) frame.setAttribute(FAILED, '');
      else frame.removeAttribute(FAILED);
      frame.hidden = error;
      if (error) fetchState();
      else render(false);
    });
    slot.appendChild(frame);
    return frame;
  }

  function mountFocus() {
    if (frames.focus) frames.focus.remove();
    frames.focus = createFrame($('focus-slot'), 'focus-frame', 'Focus', '/embedded/focus');
  }

  function mountBrief(brief) {
    if (frames.brief) frames.brief.remove();
    frames.brief = createFrame($('brief-slot'), 'brief-frame', 'Daily Brief ' + brief.date, briefUrl(brief));
    mountedBrief = { date: brief.date, revision: brief.revision };
  }

  // `fresh` is true only right after state arrives; frames are created only
  // then.
  function render(fresh) {
    var brief = briefKnown() ? state.brief : null;

    $('shell-notice').hidden = !(failures >= 2 && !streaming);

    // Focus: mount once it answers; afterwards keep the frame and only report.
    if (fresh && current === 'focus' && !frames.focus && focusAvailable()) mountFocus();
    $('focus-notice').hidden = !(focusDown() || failed(frames.focus));

    // Daily Brief, mounted only while its tab is the one shown.
    if (fresh && current === 'reading' && tab === 'brief' && !frames.brief && isReady(brief)) mountBrief(brief);
    var newer = !!frames.brief && isReady(brief) &&
      (brief.date !== mountedBrief.date || brief.revision !== mountedBrief.revision);
    $('brief-newer').hidden = !newer;
    var notReady = !!brief && !isReady(brief);
    var showState = notReady || (failed(frames.brief) && !newer);
    $('brief-notice-text').textContent = !showState ? '' : notReady ? briefSentence(brief) : openFailed(mountedBrief.date);
    $('brief-notice').hidden = !showState;
  }

  // Acts on Retry and "Load newer brief" with the state that just arrived.
  function applyRequests() {
    var reload = wantReload;
    var newer = wantNewer;
    wantReload = false;
    wantNewer = false;
    if (!state) return;
    var brief = state.brief;
    if (reload && failed(frames.focus) && focusAvailable()) mountFocus();
    if (!isReady(brief) || !frames.brief) return;
    var differs = brief.date !== mountedBrief.date || brief.revision !== mountedBrief.revision;
    if ((reload && failed(frames.brief)) || (newer && differs)) mountBrief(brief);
  }

  // Replaces the state. `keys` names the top-level keys that changed, or is
  // null for a whole new snapshot. `fresh` marks focus and brief as having
  // just arrived.
  function setState(next, keys, fresh) {
    state = next;
    applied += 1;
    if (fresh) applyRequests();
    render(fresh);
    if (routines) routines.update(state, keys);
    if (settings) settings.update(state, keys);
    if (agents) agents.update(state, keys);
    if (goals) goals.update(state, keys);
  }

  function isSnapshot(body) {
    return !!body && typeof body === 'object' && typeof body.revision === 'number' &&
      !!body.focus && !!body.brief && !!body.routines && Array.isArray(body.agents);
  }

  function parse(text) {
    try {
      return JSON.parse(text);
    } catch (_error) {
      return null;
    }
  }

  function fetchState() {
    var id = ++sequence;
    var before = applied;
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, STATE_TIMEOUT_MS);
    return fetch('/api/state', {
      cache: 'no-store',
      credentials: 'same-origin',
      signal: controller.signal,
    }).then(function (response) {
      if (!response.ok) throw new Error('state ' + response.status);
      return response.json();
    }).then(function (body) {
      return isSnapshot(body) ? body : null;
    }, function () {
      return null;
    }).then(function (body) {
      clearTimeout(timer);
      if (id !== sequence) return;
      if (!body) {
        wantReload = false;
        wantNewer = false;
        render(false);
        return;
      }
      // A snapshot or delta applied while this request was out may be newer
      // than its answer; keep it, but still treat the state as just arrived.
      if (!state || applied === before || body.revision >= state.revision) setState(body, null, true);
      else {
        applyRequests();
        render(true);
      }
    });
  }

  // A delta at or below the current revision is already reflected and is
  // dropped; one past the next revision means a missed delta, so the state is
  // fetched again.
  function onDelta(body) {
    if (state && body && typeof body.revision === 'number' && body.revision <= state.revision) return;
    if (!state || !body || typeof body.revision !== 'number' || !body.patch ||
        typeof body.patch !== 'object' || body.revision !== state.revision + 1) {
      fetchState();
      return;
    }
    var next = {};
    var key;
    for (key in state) if (Object.prototype.hasOwnProperty.call(state, key)) next[key] = state[key];
    var keys = Object.keys(body.patch);
    for (var i = 0; i < keys.length; i += 1) next[keys[i]] = body.patch[keys[i]];
    next.revision = body.revision;
    setState(next, keys, keys.indexOf('focus') !== -1 || keys.indexOf('brief') !== -1);
  }

  function closeSource() {
    if (source) source.close();
    source = null;
    streaming = false;
  }

  function stopFallback() {
    if (fallbackTimer !== null) clearInterval(fallbackTimer);
    fallbackTimer = null;
  }

  function startFallback() {
    if (fallbackTimer === null && !document.hidden) fallbackTimer = setInterval(fetchState, FALLBACK_POLL_MS);
  }

  function scheduleReconnect(ms) {
    if (reconnectTimer !== null) clearTimeout(reconnectTimer);
    reconnectTimer = document.hidden ? null : setTimeout(connect, ms);
  }

  // The stream ended or could not open: reconnect after a delay and poll
  // /api/state until a snapshot arrives.
  function dropped(ms) {
    closeSource();
    startFallback();
    scheduleReconnect(ms);
    render(false);
  }

  function connect() {
    if (reconnectTimer !== null) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    closeSource();
    if (document.hidden) return;
    var es = new EventSource('/api/events');
    source = es;
    es.addEventListener('snapshot', function (event) {
      if (source !== es) return;
      var body = parse(event.data);
      if (!isSnapshot(body)) return;
      streaming = true;
      failures = 0;
      stopFallback();
      setState(body, null, true);
    });
    es.addEventListener('delta', function (event) {
      if (source === es) onDelta(parse(event.data));
    });
    es.addEventListener('reload', function () {
      if (source === es) fetchState();
    });
    es.addEventListener('bye', function () {
      if (source === es) dropped(BYE_DELAY_MS);
    });
    // EventSource gives up for good on a non-200 answer, so every error
    // closes it and schedules a new one.
    es.addEventListener('error', function () {
      if (source !== es) return;
      failures += 1;
      dropped(BACKOFF_MS[Math.min(failures, BACKOFF_MS.length) - 1]);
    });
  }

  function disconnect() {
    if (reconnectTimer !== null) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    stopFallback();
    closeSource();
  }

  function show(view) {
    current = view;
    tab = tabFor(location.pathname);
    var views = document.querySelectorAll('section.view');
    for (var i = 0; i < views.length; i += 1) views[i].hidden = views[i].getAttribute('data-view') !== view;
    var links = document.querySelectorAll('.nav a');
    for (var j = 0; j < links.length; j += 1) {
      if (links[j].getAttribute('data-view') === view) links[j].setAttribute('aria-current', 'page');
      else links[j].removeAttribute('aria-current');
    }
    $('reading-brief').hidden = tab !== 'brief';
    $('reading-feed').hidden = tab !== 'feed';
    var tabs = document.querySelectorAll('.reading-tabs a');
    for (var k = 0; k < tabs.length; k += 1) {
      if (tabs[k].getAttribute('data-tab') === tab) tabs[k].setAttribute('aria-current', 'page');
      else tabs[k].removeAttribute('aria-current');
    }
    document.title = TITLES[onFeed() ? 'feed' : view] + ' · Dashboard';
    // Goals fetches the vault while shown, the Feed its store, and Health
    // refreshes stale jobs when it opens.
    if (routines) {
      if (view === 'health') routines.show();
      else routines.hide();
    }
    if (settings) {
      if (view === 'health') settings.show();
      else settings.hide();
    }
    if (agents) {
      if (view === 'agents') agents.show();
      else agents.hide();
    }
    if (goals) {
      if (view === 'goals') goals.show();
      else goals.hide();
    }
    if (feed) {
      if (onFeed()) feed.show();
      else feed.hide();
    }
    render(false);
    fetchState();
  }

  document.addEventListener('click', function (event) {
    var action = event.target.closest && event.target.closest('button[data-action]');
    if (action) {
      if (action.getAttribute('data-action') === 'load-newer') wantNewer = true;
      else wantReload = true;
      if (action.closest('#shell-notice')) connect();
      fetchState();
      return;
    }

    if (event.defaultPrevented || event.button !== 0 ||
        event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    var link = event.target.closest && event.target.closest('a[href]');
    if (!link || link.target || link.hasAttribute('download')) return;
    var url = new URL(link.href);
    if (url.origin !== location.origin || url.hash || url.search) return;
    if (!Object.prototype.hasOwnProperty.call(ROUTES, url.pathname)) return;
    event.preventDefault();
    // A view link drops any query, so Agents from an open thread returns
    // to the list.
    if (url.pathname !== location.pathname || location.search) history.pushState(null, '', url.pathname);
    show(viewFor(url.pathname));
  });

  window.addEventListener('popstate', function () {
    show(viewFor(location.pathname));
  });

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      disconnect();
      if (routines) routines.hide();
      if (settings) settings.hide();
      if (agents) agents.hide();
      if (goals) goals.hide();
      if (feed) feed.hide();
    } else {
      connect();
      if (routines && current === 'health') routines.show();
      if (settings && current === 'health') settings.show();
      if (agents && current === 'agents') agents.show();
      if (goals && current === 'goals') goals.show();
      if (feed && onFeed()) feed.show();
    }
  });

  show(viewFor(location.pathname));
  connect();
}());
