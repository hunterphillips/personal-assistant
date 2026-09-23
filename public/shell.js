// Dashboard shell: switches between Home, Focus, and Daily Brief with the
// History API, creates each child frame the first time its view is shown and
// keeps it afterwards, and reads /api/dashboard/status on navigation and every
// 30 seconds while the page is visible. A frame is created only from a status
// answer that has just arrived, never from the one kept since the last check.
// A mounted frame is never replaced by a status change; a newer brief waits
// until "Load newer brief" is chosen. A frame whose page comes back as a JSON
// error is hidden and marked failed; the status is read again at once, and
// Retry reloads it.
(function () {
  'use strict';

  var ROUTES = { '/': 'home', '/focus': 'focus', '/brief': 'brief' };
  var TITLES = { home: 'Home', focus: 'Focus', brief: 'Daily Brief' };
  var POLL_MS = 30000;
  var STATUS_TIMEOUT_MS = 5000;
  var BRIEF_EMPTY = 'No brief has been generated yet.';
  var BRIEF_UNREADABLE = 'The latest brief file could not be read.';
  var FAILED = 'data-failed';

  var current = null;
  var status = null; // last /api/dashboard/status body, or null when unreachable
  var checked = false; // a status check has finished at least once
  var sequence = 0;
  var pollTimer = null;
  var frames = { focus: null, brief: null };
  var mountedBrief = null; // { date, revision } of the brief frame
  // Requests waiting for the next status answer: reload failed frames, load
  // the newer brief.
  var wantReload = false;
  var wantNewer = false;

  function $(id) { return document.getElementById(id); }

  function viewFor(pathname) {
    return Object.prototype.hasOwnProperty.call(ROUTES, pathname) ? ROUTES[pathname] : 'home';
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
      if (error) checkStatus();
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

  // `fresh` is true only right after a status answer arrives; frames are
  // created only then.
  function render(fresh) {
    var focusAvailable = !!(status && status.focus && status.focus.available === true);
    var brief = status ? status.brief : null;
    var unreachable = checked && status === null;

    $('shell-notice').hidden = !unreachable;

    // Home
    $('home-focus').textContent = checked && !unreachable && !focusAvailable ? 'Focus is not responding.' : '';
    $('home-brief').textContent = !status ? '' : isReady(brief) ? brief.date : briefSentence(brief);

    // Focus: mount once it answers; afterwards keep the frame and only report.
    if (fresh && current === 'focus' && !frames.focus && focusAvailable) mountFocus();
    $('focus-notice').hidden = !((status && !focusAvailable) || failed(frames.focus));

    // Daily Brief
    if (fresh && current === 'brief' && !frames.brief && isReady(brief)) mountBrief(brief);
    var newer = !!frames.brief && isReady(brief) &&
      (brief.date !== mountedBrief.date || brief.revision !== mountedBrief.revision);
    $('brief-newer').hidden = !newer;
    var notReady = !!status && !isReady(brief);
    var showState = notReady || (failed(frames.brief) && !newer);
    $('brief-notice-text').textContent = !showState ? '' : notReady ? briefSentence(brief) : openFailed(mountedBrief.date);
    $('brief-notice').hidden = !showState;
  }

  // Acts on Retry and "Load newer brief" with the status that just arrived.
  function applyRequests() {
    var reload = wantReload;
    var newer = wantNewer;
    wantReload = false;
    wantNewer = false;
    if (!status) return;
    var focusAvailable = !!(status.focus && status.focus.available === true);
    var brief = status.brief;
    if (reload && failed(frames.focus) && focusAvailable) mountFocus();
    if (!isReady(brief) || !frames.brief) return;
    var differs = brief.date !== mountedBrief.date || brief.revision !== mountedBrief.revision;
    if ((reload && failed(frames.brief)) || (newer && differs)) mountBrief(brief);
  }

  function checkStatus() {
    var id = ++sequence;
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, STATUS_TIMEOUT_MS);
    return fetch('/api/dashboard/status', {
      cache: 'no-store',
      credentials: 'same-origin',
      signal: controller.signal,
    }).then(function (response) {
      if (!response.ok) throw new Error('status ' + response.status);
      return response.json();
    }).then(function (body) {
      return body && typeof body === 'object' ? body : null;
    }, function () {
      return null;
    }).then(function (body) {
      clearTimeout(timer);
      if (id !== sequence) return;
      status = body;
      checked = true;
      applyRequests();
      render(true);
    });
  }

  function show(view) {
    current = view;
    var views = document.querySelectorAll('section.view');
    for (var i = 0; i < views.length; i += 1) views[i].hidden = views[i].getAttribute('data-view') !== view;
    var links = document.querySelectorAll('.nav a');
    for (var j = 0; j < links.length; j += 1) {
      if (links[j].getAttribute('data-view') === view) links[j].setAttribute('aria-current', 'page');
      else links[j].removeAttribute('aria-current');
    }
    document.title = TITLES[view] + ' · Dashboard';
    render(false);
    checkStatus();
  }

  function schedulePolling() {
    if (pollTimer !== null) clearInterval(pollTimer);
    pollTimer = null;
    if (!document.hidden) pollTimer = setInterval(checkStatus, POLL_MS);
  }

  document.addEventListener('click', function (event) {
    var action = event.target.closest && event.target.closest('button[data-action]');
    if (action) {
      if (action.getAttribute('data-action') === 'load-newer') wantNewer = true;
      else wantReload = true;
      checkStatus();
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
    if (url.pathname !== location.pathname) history.pushState(null, '', url.pathname);
    show(viewFor(url.pathname));
  });

  window.addEventListener('popstate', function () {
    show(viewFor(location.pathname));
  });

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) checkStatus();
    schedulePolling();
  });

  show(viewFor(location.pathname));
  schedulePolling();
}());
