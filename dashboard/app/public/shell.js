// Dashboard shell: switches between Agents (Home, agents.js), the Feed
// (feed.js), Focus, Goals (goals.js), Ideas (ideas.js), and Health (jobs.js, the launchd jobs)
// with the History API. Focus is the board (focus.js) when the snapshot's
// focus.native is true, and otherwise the proxied Focus in a frame, created
// the first time its view is shown and kept afterwards. The shell keeps one
// copy of the server's state,
// which it hands to the Health, Agents, and Goals views, the header's
// notifications (notifications.js), the brief's overlay (brief-overlay.js),
// whose links open views through shellApi, and quick chat (quick-chat.js),
// which asks shellApi.context() what Hunter is looking at. Agents is the
// page at `/`; `/agents` shows it too, `/feed` shows the Feed, `/health`
// shows Health (the server redirects the old `/routines` there and the old
// `/reading` to `/feed`), and any unknown path lands on Agents. `/brief`, the
// brief's old page, shows the Feed with the brief's overlay open, and the
// address becomes `/feed`. The overlay opens over any view from the header's
// Brief entry and from links (shellApi.openBrief) and changes no address.
// The side panel (panel.js) shows the open view's own section, or Now,
// which it draws from every state; a view change closes its drawer on a
// phone.
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
// The Focus frame (only while focus.native is false) is created only from
// state that has just arrived (a
// snapshot, a delta touching focus, or a finished /api/state fetch), never
// from the copy kept since, and is never replaced by a state change. A frame
// whose page comes back as a JSON error is hidden and marked failed; the
// state is fetched again at once, and Retry reloads it.
(function () {
  'use strict';

  var ROUTES = {
    '/': 'agents', '/agents': 'agents', '/focus': 'focus',
    '/brief': 'feed', '/feed': 'feed', '/goals': 'goals', '/ideas': 'ideas', '/health': 'health',
  };
  var TITLES = { agents: 'Agents', focus: 'Focus', goals: 'Goals', ideas: 'Ideas', health: 'Health', feed: 'Feed' };
  var FALLBACK_POLL_MS = 30000;
  var STATE_TIMEOUT_MS = 5000;
  var BACKOFF_MS = [1000, 2000, 4000, 8000, 15000];
  var BYE_DELAY_MS = 500;
  var BRIEF_RULES = 'The brief follows these rules.';
  var NO_ANSWER = 'The dashboard did not respond.';
  var FAILED = 'data-failed';

  var current = null;
  var state = null; // latest snapshot, or null before the first one
  var applied = 0; // counts snapshots and deltas applied, to order fetches
  var sequence = 0;
  var frames = { focus: null };
  // A Retry waiting for the next state that arrives to reload a failed frame.
  var wantReload = false;

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
    // A notification's link (notifications.js): Health with that job
    // selected, the Feed scrolled to an item, the brief's overlay over the
    // current view.
    openJob: function (label) {
      go('/health');
      if (jobs) jobs.select(label);
    },
    openFeedItem: function (run, index, feedId) {
      go('/feed');
      if (feed) feed.reveal(run, index, feedId);
    },
    openBrief: function (date, from) {
      if (overlay) overlay.open(date, from);
    },
    openQuickChat: function (from) {
      if (quickChat) quickChat.open(from);
    },
    // What Hunter is looking at, for quick chat's context line.
    context: function () { return viewContext(); },
    // The side panel's drawer on a phone (panel.js); a desk's panel answers
    // only to its toggle.
    openPanel: function () { if (panel) panel.openPanel(); },
    closePanel: function () { if (panel) panel.closePanel(); },
    // A view filled or emptied its panel section after show().
    panelChanged: function () { panelSection(); },
  };
  var panel = window.DashboardPanel || null;
  if (panel) panel.attach(shellApi);
  var jobs = window.DashboardJobs ? window.DashboardJobs.create(shellApi) : null;
  var settings = window.DashboardSettings ? window.DashboardSettings.create(shellApi) : null;
  var agents = window.DashboardAgents ? window.DashboardAgents.create(shellApi) : null;
  var goals = window.DashboardGoals ? window.DashboardGoals.create(shellApi) : null;
  var ideas = window.DashboardIdeas ? window.DashboardIdeas.create(shellApi) : null;
  var focus = window.DashboardFocus ? window.DashboardFocus.create(shellApi) : null;
  var feed = window.DashboardFeed ? window.DashboardFeed.create(shellApi) : null;
  // The Feed's settings sheet (feed-settings.js), closed whenever the Feed is left.
  var feedSettings = feed && window.DashboardFeedSettings ? window.DashboardFeedSettings.create(feed, shellApi) : null;
  var notifications = window.DashboardNotifications ? window.DashboardNotifications.create(shellApi) : null;
  // The pane over every view (quick-chat.js), with its own thread view.
  var quickChat = window.DashboardQuickChat ? window.DashboardQuickChat.create(shellApi) : null;
  // The Brief instructions panel (instructions.js), inside the overlay: the
  // brief's rules and a change sent to the agent Settings names as receiving
  // the brief. Sending closes the overlay and opens that agent's thread.
  var briefInstructions = window.DashboardInstructions
    ? window.DashboardInstructions.create({
      prefix: 'brief',
      readPath: '/api/brief/instructions',
      proposePath: '/api/brief/instructions/propose',
      refusalSentence: briefRefusalSentence,
      openAgent: function (id) {
        if (overlay) overlay.close(false);
        if (id) shellApi.openAgent(id);
      },
    })
    : null;
  var overlay = window.DashboardBriefOverlay
    ? window.DashboardBriefOverlay.create({ instructions: briefInstructions, briefIntro: briefIntroSentence, shellApi: shellApi })
    : null;

  function $(id) { return document.getElementById(id); }

  // What quick chat sends along: with the brief's overlay open, the brief
  // and the item in view there, since the overlay sits above every view;
  // otherwise the view and the object in it: Health's selected job, the
  // feed item in view, the open agent, the board's counts. Goals, and Focus
  // in its frame, give the view's name alone.
  function viewContext() {
    if (overlay && overlay.isOpen()) return overlay.context();
    if (current === 'focus' && focus && focusNative()) return focus.context();
    if (current === 'health') return jobs ? jobs.context() : { view: 'health' };
    if (current === 'agents') return agents ? agents.context() : { view: 'agents' };
    if (current === 'feed') return feed ? feed.context() : { view: 'feed' };
    if (current === 'ideas') return ideas ? ideas.context() : { view: 'ideas' };
    return current ? { view: current } : null;
  }


  // Shows the view at `pathname`, adding a history entry when it changes.
  function go(pathname) {
    if (location.pathname !== pathname || location.search) history.pushState(null, '', pathname);
    show(viewFor(pathname));
  }

  function viewFor(pathname) {
    return Object.prototype.hasOwnProperty.call(ROUTES, pathname) ? ROUTES[pathname] : 'agents';
  }

  // The agent Settings names as receiving the brief, as listed; with no
  // thread named, the first pinned Claude persona, else the first built-in
  // one, else null.
  function briefAgent() {
    var id = state && state.settings && state.settings.brief ? state.settings.brief.agent : null;
    if (!state || !Array.isArray(state.agents)) return null;
    if (typeof id === 'string' && id !== '') {
      for (var i = 0; i < state.agents.length; i += 1) if (state.agents[i].id === id) return state.agents[i];
      return null;
    }
    var claude = state.agents.filter(function (agent) { return agent.kind === 'persona' && agent.provider === 'claude'; });
    var pinned = null;
    var builtin = null;
    for (var j = 0; j < claude.length; j += 1) {
      if (!pinned && claude[j].pinned === true) pinned = claude[j];
      if (!builtin && claude[j].builtin === true) builtin = claude[j];
    }
    return pinned || builtin || null;
  }

  function briefIntroSentence() {
    var agent = briefAgent();
    if (!agent) return BRIEF_RULES + ' No agent receives the brief, so a change has nowhere to go. Choose one in Settings.';
    return BRIEF_RULES + ' A change goes to ' + agent.name + ', which edits the file.';
  }

  function briefRefusalSentence(status, code) {
    var agent = briefAgent();
    var name = agent ? agent.name : 'That agent';
    if (status === 409 && code === 'no_brief_agent') return 'No agent receives the brief. Choose one in Settings.';
    if (status === 409 && code === 'busy') return name + ' is in the middle of a turn. Try again when it is idle.';
    if (status === 503 || (status === 409 && code === 'persona_unavailable') ||
        (status === 404 && code === 'no_such_agent')) return name + ' is not running.';
    if (status === 413) return 'That is too long for one message.';
    return NO_ANSWER;
  }

  function failed(frame) {
    return !!frame && frame.hasAttribute(FAILED);
  }

  function focusAvailable() {
    return !!(state && state.focus && state.focus.available === true);
  }

  function focusDown() {
    return !!(state && state.focus && state.focus.available === false);
  }

  // The board lives in the data root; the frame is the proxied Focus.
  function focusNative() {
    return !!(state && state.focus && state.focus.native === true);
  }

  // Shows the board or the frame's slot, and shows or hides the board's
  // module to match.
  function syncFocus() {
    var native = focusNative();
    $('focus-board').hidden = !native;
    $('focus-slot').hidden = native;
    if (!focus) return;
    if (current === 'focus' && native && !document.hidden) focus.show();
    else focus.hide();
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
    var theme = window.DashboardTheme ? window.DashboardTheme.resolved() : 'light';
    frames.focus = createFrame($('focus-slot'), 'focus-frame', 'Focus', '/embedded/focus?theme=' + encodeURIComponent(theme));
  }

  // `fresh` is true only right after state arrives; frames are created only
  // then.
  function render(fresh) {
    $('shell-notice').hidden = !(failures >= 2 && !streaming);
    renderRailIndicators();
    renderBriefDot();

    // Focus: the board when native; otherwise mount the frame once it
    // answers, then keep it and only report.
    var native = focusNative();
    if (fresh && current === 'focus' && !native && !frames.focus && focusAvailable()) mountFocus();
    $('focus-notice').hidden = native || !(focusDown() || failed(frames.focus));
    syncFocus();

    if (briefInstructions) briefInstructions.setIntro(briefIntroSentence());
  }

  function renderRailIndicators() {
    var agentsNeedYou = !!(state && Array.isArray(state.agents) && state.agents.some(function (agent) {
      return agent.state === 'waiting' || agent.needsYou === true || agent.unread === true ||
        (Array.isArray(agent.forwarded) && agent.forwarded.length > 0);
    }));
    var failedJob = !!(state && state.jobs && Array.isArray(state.jobs.items) && state.jobs.items.some(function (job) {
      return job.outcome === 'failed' || job.outcome === 'rejected';
    }));
    $('agents-indicator').hidden = !agentsNeedYou;
    $('health-indicator').hidden = !failedJob;
  }

  // The newest brief unread: a dot on the header's Brief entry, and on a
  // phone the menu toggle and the Brief entry inside the menu.
  function renderBriefDot() {
    var unread = !!(state && state.brief && state.brief.unread === true);
    $('brief-dot').hidden = !unread;
    $('app-menu-dot').hidden = !unread;
    $('brief-menu-dot').hidden = !unread;
    $('brief-open').setAttribute('aria-label', unread ? 'Brief, unread' : 'Brief');
  }

  // Acts on Retry with the state that just arrived.
  function applyRequests() {
    var reload = wantReload;
    wantReload = false;
    if (!state) return;
    if (reload && failed(frames.focus) && focusAvailable() && !focusNative()) mountFocus();
  }

  // Replaces the state. `keys` names the top-level keys that changed, or is
  // null for a whole new snapshot. `fresh` marks focus as having just
  // arrived.
  function setState(next, keys, fresh) {
    state = next;
    applied += 1;
    if (fresh) applyRequests();
    render(fresh);
    if (jobs) jobs.update(state, keys);
    if (settings) settings.update(state, keys);
    if (agents) agents.update(state, keys);
    if (goals) goals.update(state, keys);
    if (ideas) ideas.update(state, keys);
    if (focus) focus.update(state, keys);
    if (feed) feed.update(state, keys);
    if (notifications) notifications.update(state, keys);
    if (quickChat) quickChat.update(state, keys);
    if (overlay) overlay.update(state, keys);
    if (panel) panel.update(state);
  }

  function isSnapshot(body) {
    return !!body && typeof body === 'object' && typeof body.revision === 'number' &&
      !!body.focus && !!body.brief && !!body.jobs && Array.isArray(body.agents);
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

  // The side panel shows the current view's own section, or `now` for a
  // view whose section is missing or empty (Focus in its frame, or the Feed
  // before its first answer).
  function panelSection() {
    var own = document.querySelector('[data-panel-for="' + current + '"]');
    var shown = own && own.childElementCount > 0 ? current : 'now';
    var sections = document.querySelectorAll('[data-panel-for]');
    for (var p = 0; p < sections.length; p += 1) sections[p].hidden = sections[p].getAttribute('data-panel-for') !== shown;
  }

  function show(view) {
    var changed = view !== current;
    current = view;
    var views = document.querySelectorAll('section.view');
    for (var i = 0; i < views.length; i += 1) views[i].hidden = views[i].getAttribute('data-view') !== view;
    var links = document.querySelectorAll('.nav a');
    for (var j = 0; j < links.length; j += 1) {
      if (links[j].getAttribute('data-view') === view) links[j].setAttribute('aria-current', 'page');
      else links[j].removeAttribute('aria-current');
    }
    $('app-header-title').textContent = TITLES[view];
    var actions = document.querySelectorAll('[data-actions-for]');
    for (var a = 0; a < actions.length; a += 1) actions[a].hidden = actions[a].getAttribute('data-actions-for') !== view;
    // A phone's drawer closes before the views below are shown, so Agents
    // can open it again.
    panelSection();
    shellApi.closePanel();
    document.title = TITLES[view] + ' · Dashboard';
    // Goals fetches the vault while shown, the Feed its store, and Health
    // refreshes stale jobs when it opens.
    if (jobs) {
      if (view === 'health') jobs.show();
      else jobs.hide();
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
      if (view === 'feed') feed.show();
      else feed.hide();
    }
    if (feedSettings && view !== 'feed') feedSettings.hide();
    if (ideas) {
      if (view === 'ideas') ideas.show();
      else ideas.hide();
    }
    // The board when native; render() below calls syncFocus().
    if (quickChat && changed) quickChat.viewChanged();
    render(false);
    fetchState();
  }

  document.addEventListener('click', function (event) {
    var action = event.target.closest && event.target.closest('button[data-action]');
    if (action) {
      wantReload = true;
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
    if (url.pathname === '/brief' && overlay) {
      overlay.open(null, link);
      return;
    }
    // A view link drops any query, so Agents from an open thread returns
    // to the list.
    if (url.pathname !== location.pathname || location.search) history.pushState(null, '', url.pathname);
    show(viewFor(url.pathname));
  });

  window.addEventListener('popstate', function () {
    show(viewFor(location.pathname));
  });

  window.addEventListener('dashboardthemechange', function () {
    // Focus reads the query during its own load; rebuilding is simpler than
    // maintaining a cross-frame message protocol for this rare choice. The
    // board takes the dashboard's tokens and needs nothing.
    if (frames.focus) mountFocus();
  });

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      disconnect();
      if (jobs) jobs.hide();
      if (settings) settings.hide();
      if (agents) agents.hide();
      if (goals) goals.hide();
      if (feed) feed.hide();
      if (ideas) ideas.hide();
      if (focus) focus.hide();
      if (quickChat) quickChat.visibility(true);
    } else {
      connect();
      if (jobs && current === 'health') jobs.show();
      if (settings && current === 'health') settings.show();
      if (agents && current === 'agents') agents.show();
      if (goals && current === 'goals') goals.show();
      if (feed && current === 'feed') feed.show();
      if (ideas && current === 'ideas') ideas.show();
      syncFocus();
      if (quickChat) quickChat.visibility(false);
    }
  });

  // The header's Brief entry, and the same entry in the phone menu.
  ['brief-open', 'brief-menu-entry'].forEach(function (id) {
    var button = $(id);
    if (button && overlay) button.addEventListener('click', function () { overlay.open(null, button); });
  });

  // `/brief` was the brief's own tab; it now lands on the Feed with the
  // overlay open, under the Feed's address.
  var openOnLoad = location.pathname === '/brief';
  if (openOnLoad) history.replaceState(null, '', '/feed' + location.search);
  show(viewFor(location.pathname));
  connect();
  if (openOnLoad && overlay) overlay.open(null);
}());
