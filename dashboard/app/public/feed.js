// Feed: the feeds in the feeds store, one tab each (the strip shows at two or
// more), the open feed's runs as dated groups of posts. The open feed is in
// the address (/feed?f=<id>), the first feed when it names none or one that
// is gone. Each post shows its sources' badge, its title as a link, the
// summary, the takeaway on its own muted line under it, and the story's
// image; then an action row: Insights (when the post has them) expanding
// the explanation under the row through markdown.js, then three icons left
// of it: the bookmark (Save and Unsave), Discuss (a turn to the feed's
// producer, /api/feeds/:id/discuss, whose thread then opens), and Dismiss.
// Marks post to /api/feeds/:id/{save,unsave,dismiss}, which answer the
// fresh read.
//
// The side panel's Feed section, drawn on the same render as the posts and
// cleared on hide, lists All, Saved while any post is saved, then each
// source with its count, by the name /api/sources gives its id (an id the
// store does not know shows as written). Choosing Saved or a source shows
// only those posts, with a line above them and a Show all button; the choice
// is not stored and clears on hide or on another tab.
//
// While shown, the view fetches /api/feeds, /api/sources, and the open feed
// on show() and every 60 seconds. An answer identical to the last one
// rendered changes nothing. A body that is not the expected shape shows the
// no-answer sentence. Buttons carry data-feed-action, never data-action,
// which the shell's own click handler owns. Every text node is set with
// textContent.
(function () {
  'use strict';

  var POLL_MS = 60000;
  var TIMEOUT_MS = 8000;
  var NO_ANSWER = 'The dashboard did not respond.';
  var NO_FEEDS = 'There are no feeds yet.';
  var GONE = 'That post is no longer in the feed.';
  var TOO_LONG = 'That is too long for one message.';
  var DAYS =['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  var BADGE_COLOURS = 6;
  var SVG_NS = 'http://www.w3.org/2000/svg';
  var BOOKMARK = '<path d="M7 4.5h10a1 1 0 0 1 1 1v14l-6-4-6 4v-14a1 1 0 0 1 1-1Z"/>';
  var DISMISS = '<circle cx="12" cy="12" r="8.5"/><path d="M6 6l12 12"/>';

  function element(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  // A calendar date as a local date, or null when it is not YYYY-MM-DD.
  function parseDate(text) {
    var match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(typeof text === 'string' ? text : '');
    if (!match) return null;
    var date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    return Number.isNaN(date.getTime()) ? null : date;
  }

  // "Monday, September 28", or the text as given when it is not a date.
  function dateSentence(text) {
    var date = parseDate(text);
    if (!date) return text;
    return DAYS[date.getDay()] + ', ' + MONTHS[date.getMonth()] + ' ' + date.getDate();
  }

  // "Since September 14", or null when there is no window.
  function sinceSentence(text) {
    var date = parseDate(text);
    if (!date) return null;
    return 'Since ' + MONTHS[date.getMonth()] + ' ' + date.getDate();
  }

  // "LS" for "Latent Space": the first letter of each of the first two
  // words, upper case. Punctuation is ignored and a bracketed aside is
  // dropped entirely, so "AINews (Latent Space)" gives "A".
  function initials(name) {
    var text = String(name).replace(/[(\[{][^)\]}]*[)\]}]/g, ' ');
    var words = text.split(/[\s-]+/).filter(function (word) {
      return /[A-Za-z0-9]/.test(word);
    }).slice(0, 2);
    return words.map(function (word) {
      return /[A-Za-z0-9]/.exec(word)[0];
    }).join('').toUpperCase();
  }

  // One of the badge colours, the same for a source every time.
  function colourIndex(name) {
    var hash = 0;
    var text = String(name);
    for (var i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
    return hash % BADGE_COLOURS;
  }

  function icon(className, size, paths, filled) {
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', className);
    svg.setAttribute('viewBox', size === 16 ? '0 0 16 16' : '0 0 24 24');
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    svg.setAttribute('fill', filled ? 'currentColor' : 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', size === 16 ? '1.5' : '1.75');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.innerHTML = paths;
    return svg;
  }

  // The story's picture. The title already names the story, so the alt text
  // is empty; an image that fails to load is removed rather than shown broken.
  function storyImage(src) {
    var image = element('img', 'feed-image');
    image.alt = '';
    image.loading = 'lazy';
    image.referrerPolicy = 'no-referrer';
    image.addEventListener('error', function () { image.remove(); });
    image.src = src;
    return image;
  }

  // Resolves with { status, body } or null when there was no answer in time.
  function request(path, init) {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, TIMEOUT_MS);
    init = init || { method: 'GET' };
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

  function postJson(path, body, method) {
    return request(path, {
      method: method || 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
  }

  function arrayOf(value) {
    return Array.isArray(value) ? value : [];
  }

  // The objects in a list, without nulls or other stray values.
  function objectsIn(value) {
    return arrayOf(value).filter(function (entry) { return entry !== null && typeof entry === 'object'; });
  }

  function feedPath(id, action) {
    return '/api/feeds/' + encodeURIComponent(id) + (action ? '/' + action : '');
  }

  // The feed the address names, or null.
  function feedInAddress() {
    try { return new URLSearchParams(location.search).get('f'); } catch (_error) { return null; }
  }

  function create(shellApi) {
    var message = document.getElementById('feed-message');
    var runs = document.getElementById('feed-runs');
    var tabs = document.getElementById('feed-tabs');
    var side = document.querySelector('[data-panel-for="feed"]');
    var filterLine = document.getElementById('feed-filter');
    var filterText = document.getElementById('feed-filter-text');

    var state = null; // the shell's snapshot, for agent names and jobs
    var feeds = null; // the /api/feeds answer's feeds, or null before one
    var feedProblems = [];
    var sourceNames = {}; // source id -> name, from /api/sources
    var feedId = null; // the open feed
    var data = null; // the open feed's read
    var visible = false;
    var poll = null;
    var sequence = 0;
    var rendered = null; // the JSON text of what is on screen
    var pending = null; // the post id whose request is out
    var target = null; // { feed, run, index } to scroll to once it is drawn
    var missed = false; // true while a link's post is not in the feed
    var filter = null; // null for all, 'saved', or a source id
    var expanded = {}; // post id -> true while its Insights are open
    var listeners = []; // called with the feeds after each load

    function agentName(id) {
      var agents = state && Array.isArray(state.agents) ? state.agents : [];
      var found = agents.find(function (entry) { return entry.id === id; });
      return found && found.name ? found.name : id;
    }

    function openFeed() {
      return objectsIn(feeds).find(function (feed) { return feed.id === feedId; }) || null;
    }

    function producerName() {
      var feed = openFeed();
      return feed && feed.producer ? agentName(feed.producer) : 'The agent';
    }

    function refusalSentence(status, code) {
      if (status === 409 && code === 'busy') return producerName() + ' is in the middle of a turn. Try again when it is idle.';
      if (status === 503 || (status === 409 && code === 'persona_unavailable') ||
          (status === 404 && code === 'no_such_agent')) return producerName() + ' is not running.';
      if (status === 404 && code === 'no_such_item') return GONE;
      if (status === 413) return TOO_LONG;
      return NO_ANSWER;
    }

    function sourceName(id) {
      return Object.prototype.hasOwnProperty.call(sourceNames, id) ? sourceNames[id] : id;
    }

    function itemSources(item) {
      return arrayOf(item.sources).filter(function (id) { return typeof id === 'string' && id !== ''; });
    }

    function passes(item) {
      if (filter === null) return true;
      if (filter === 'saved') return item.status === 'saved';
      return itemSources(item).indexOf(filter.slice('source:'.length)) !== -1;
    }

    function discussButton(item) {
      var button = element('button', 'feed-icon-button feed-discuss');
      button.type = 'button';
      button.setAttribute('data-feed-action', 'discuss');
      button.setAttribute('data-feed-id', item.id);
      button.setAttribute('aria-label', 'Discuss');
      button.setAttribute('title', 'Discuss');
      button.disabled = pending === item.id;
      button.appendChild(icon('feed-icon', 24, '<path d="M10.7 19.4 A8 8 0 1 0 5.1 15.4 C3.5 16.4 2.9 18.6 5.5 20 C6.9 19.3 8.7 19 10.7 19.4 Z"/>'));
      button.firstChild.setAttribute('width', '20');
      button.firstChild.setAttribute('height', '20');
      return button;
    }

    // The post's dismiss: acts directly, no confirmation menu.
    function dismissButton(item) {
      var button = element('button', 'feed-icon-button feed-dismiss');
      button.type = 'button';
      button.setAttribute('data-feed-action', 'dismiss');
      button.setAttribute('data-feed-id', item.id);
      button.setAttribute('aria-label', 'Dismiss');
      button.setAttribute('title', 'Dismiss');
      button.disabled = pending === item.id;
      button.appendChild(icon('', 24, DISMISS, false));
      button.firstChild.setAttribute('width', '20');
      button.firstChild.setAttribute('height', '20');
      return button;
    }

    function insightsButton(item, panelId) {
      var open = expanded[item.id] === true;
      var button = element('button', 'feed-action feed-insights-toggle');
      button.type = 'button';
      button.setAttribute('data-feed-action', 'insights');
      button.setAttribute('data-feed-id', item.id);
      button.setAttribute('aria-expanded', open ? 'true' : 'false');
      button.setAttribute('aria-controls', panelId);
      button.appendChild(icon('feed-icon', 16, '<path d="M4.5 6 8 9.5 11.5 6"/>'));
      button.appendChild(document.createTextNode('Insights'));
      return button;
    }

    // The post's bookmark: outline until saved, filled once saved, as Ideas'.
    function saveToggle(item) {
      var saved = item.status === 'saved';
      var name = saved ? 'Unsave' : 'Save';
      var button = element('button', 'feed-icon-button feed-save-toggle');
      button.type = 'button';
      button.setAttribute('data-feed-action', name.toLowerCase());
      button.setAttribute('data-feed-id', item.id);
      button.setAttribute('aria-label', name);
      button.setAttribute('title', name);
      button.setAttribute('aria-pressed', saved ? 'true' : 'false');
      button.disabled = pending === item.id;
      button.appendChild(icon('', 24, BOOKMARK, saved));
      button.firstChild.setAttribute('width', '20');
      button.firstChild.setAttribute('height', '20');
      return button;
    }

    function renderItem(item, n) {
      var names = itemSources(item).map(sourceName);
      var first = names[0] || '';
      var node = element('article', 'feed-item');
      node.setAttribute('data-feed-item', item.id);
      if (typeof item.position === 'number') node.setAttribute('data-feed-position', String(item.position));
      var badge = element('span', 'feed-badge feed-badge-' + colourIndex(first), initials(first));
      badge.setAttribute('role', 'img');
      badge.setAttribute('aria-label', names.join(', '));
      badge.title = names.join(', ');
      node.appendChild(badge);
      var body = element('div', 'feed-body');
      var title = element('h3', 'feed-title');
      var link = element('a', null, item.title);
      link.href = item.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      title.appendChild(link);
      body.appendChild(title);
      body.appendChild(element('p', 'feed-summary', item.summary));
      if (typeof item.takeaway === 'string' && item.takeaway) body.appendChild(element('p', 'feed-takeaway', item.takeaway));
      if (typeof item.image === 'string' && /^https?:\/\//i.test(item.image)) body.appendChild(storyImage(item.image));
      var actions = element('div', 'feed-actions');
      var panelId = 'feed-insights-' + n;
      var hasInsights = typeof item.insights === 'string' && item.insights !== '';
      if (hasInsights) actions.appendChild(insightsButton(item, panelId));
      var marks = element('div', 'feed-icon-actions');
      marks.appendChild(saveToggle(item));
      marks.appendChild(discussButton(item));
      marks.appendChild(dismissButton(item));
      actions.appendChild(marks);
      body.appendChild(actions);
      if (hasInsights) {
        var insights = element('div', 'feed-insights markdown');
        insights.id = panelId;
        insights.setAttribute('data-feed-insights', item.id);
        insights.hidden = expanded[item.id] !== true;
        window.DashboardMarkdown.renderInto(insights, item.insights);
        body.appendChild(insights);
      }
      var reason = element('p', 'feed-reason');
      reason.setAttribute('role', 'status');
      reason.hidden = true;
      body.appendChild(reason);
      node.appendChild(body);
      return node;
    }

    function renderRun(run, items, counter) {
      var group = element('section', 'feed-run');
      var headingId = 'feed-run-' + run.id;
      group.setAttribute('aria-labelledby', headingId);
      group.setAttribute('data-feed-run', run.id);
      var header = element('div', 'feed-run-header');
      var title = element('h2', 'feed-date section-heading', dateSentence(run.date));
      title.id = headingId;
      header.appendChild(title);
      var since = sinceSentence(run.since);
      if (since) header.appendChild(element('span', 'feed-since', since));
      group.appendChild(header);
      items.forEach(function (item) { group.appendChild(renderItem(item, counter.next++)); });
      return group;
    }

    // A tab that had focus has it again once the strip is redrawn.
    function renderTabs() {
      var active = document.activeElement;
      var focused = active && tabs.contains(active) ? active.getAttribute('data-feed-tab') : null;
      tabs.textContent = '';
      var list = objectsIn(feeds);
      tabs.hidden = list.length < 2;
      if (tabs.hidden) return;
      list.forEach(function (feed) {
        var tab = element('button', 'feed-tab', feed.name);
        tab.type = 'button';
        tab.setAttribute('role', 'tab');
        tab.setAttribute('data-feed-tab', feed.id);
        tab.setAttribute('aria-selected', feed.id === feedId ? 'true' : 'false');
        tab.setAttribute('aria-controls', 'feed-runs');
        tab.tabIndex = feed.id === feedId ? 0 : -1;
        tabs.appendChild(tab);
        if (feed.id === focused) tab.focus();
      });
    }

    function panelRow(key, label, count, badgeName) {
      var row = element('button', 'panel-row');
      row.type = 'button';
      row.setAttribute('data-feed-filter', key);
      if (badgeName !== undefined) {
        var badge = element('span', 'feed-badge feed-badge-' + colourIndex(badgeName), initials(badgeName));
        badge.setAttribute('aria-hidden', 'true');
        row.appendChild(badge);
      }
      row.appendChild(element('span', 'panel-row-name', label));
      row.appendChild(element('span', 'panel-row-count', String(count)));
      if ((filter === null ? 'all' : filter) === key) row.setAttribute('aria-current', 'true');
      return row;
    }

    // All, Saved while any post is saved, then each source with its count,
    // most posts first, then by name.
    function renderPanel(all) {
      if (!side) return;
      side.textContent = '';
      if (all.length === 0) return;
      var counts = {};
      var saved = 0;
      all.forEach(function (item) {
        if (item.status === 'saved') saved += 1;
        itemSources(item).forEach(function (id) { counts[id] = (counts[id] || 0) + 1; });
      });
      side.appendChild(panelRow('all', 'All', all.length));
      if (saved > 0) side.appendChild(panelRow('saved', 'Saved', saved));
      side.appendChild(element('h2', 'panel-heading', 'Sources'));
      Object.keys(counts).map(function (id) { return { id: id, name: sourceName(id), count: counts[id] }; })
        .sort(function (a, b) { return b.count - a.count || a.name.localeCompare(b.name); })
        .forEach(function (entry) { side.appendChild(panelRow('source:' + entry.id, entry.name, entry.count, entry.name)); });
    }

    function setMessage(lines) {
      message.textContent = '';
      lines.forEach(function (text, i) {
        if (i > 0) message.appendChild(document.createElement('br'));
        message.appendChild(document.createTextNode(text));
      });
      message.hidden = lines.length === 0;
    }

    function setNoAnswer() {
      setMessage([NO_ANSWER]);
      rendered = null;
    }

    // The sentence for a feed with no posts: when its producer next runs,
    // from the producer's calendar job when it has one.
    function emptySentence() {
      var feed = openFeed();
      if (!feed) return NO_FEEDS;
      var name = agentName(feed.producer);
      var items = state && state.jobs && Array.isArray(state.jobs.items) ? state.jobs.items : [];
      var job = items.find(function (entry) {
        return entry && entry.agentId === feed.producer && entry.schedule && entry.schedule.kind === 'calendar';
      });
      if (!job) return 'No posts yet. ' + name + ' fills this feed on its next run.';
      var when = String(job.schedule.text);
      return 'No posts yet. ' + name + ' runs ' + when.charAt(0).toLowerCase() + when.slice(1) + '.';
    }

    function filterSentence() {
      if (filter === 'saved') return 'Showing saved posts only.';
      return 'Showing ' + sourceName(filter.slice('source:'.length)) + ' only.';
    }

    // Builds every group before touching the page, so a body that is not the
    // expected shape leaves the last render in place and says so.
    function render() {
      if (feeds === null) return;
      renderTabs();
      var built = [];
      var all = [];
      try {
        var counter = { next: 0 };
        var shownRuns = objectsIn(data && data.runs);
        shownRuns.forEach(function (run) { objectsIn(run.items).forEach(function (item) { all.push(item); }); });
        // A filter whose posts are gone goes with them.
        if (filter !== null && !all.some(passes)) filter = null;
        shownRuns.forEach(function (run) {
          var items = objectsIn(run.items).filter(passes);
          if (items.length > 0) built.push(renderRun(run, items, counter));
        });
      } catch (_error) {
        setNoAnswer();
        return;
      }
      var problems = feedProblems.concat(arrayOf(data && data.problems))
        .filter(function (text) { return typeof text === 'string'; });
      var lines = objectsIn(feeds).length === 0 ? [NO_FEEDS] : all.length === 0 ? [emptySentence()] : [];
      setMessage((missed ? [GONE] : []).concat(lines, problems));
      runs.textContent = '';
      built.forEach(function (group) { runs.appendChild(group); });
      renderPanel(all);
      filterLine.hidden = filter === null;
      filterText.textContent = filter === null ? '' : filterSentence();
      shellApi.panelChanged();
      rendered = renderKey();
    }

    function renderKey() {
      return JSON.stringify([feeds, sourceNames, data, filter, state && state.jobs ? state.jobs.items : null, missed]);
    }

    function renderIfChanged() {
      var text = renderKey();
      if (visible && text !== rendered) render();
    }

    // Scrolls to the target post and marks it, when it is on the page: the
    // post at that position in the run's file, so a dismissed post before
    // it shifts nothing. With `last`, a target that is not there is given
    // up and the view says the post is gone.
    function revealTarget(last) {
      if (!target || !visible) return;
      if (target.feed && target.feed !== feedId) {
        if (last) target = null;
        return;
      }
      var group = runs.querySelector('[data-feed-run="' + CSS.escape(target.run) + '"]');
      var node = group ? group.querySelector('.feed-item[data-feed-position="' + Number(target.index) + '"]') : null;
      if (!node) {
        if (last) {
          target = null;
          missed = true;
          render();
        }
        return;
      }
      target = null;
      var marked = runs.querySelectorAll('.feed-item[data-feed-target]');
      for (var i = 0; i < marked.length; i += 1) marked[i].removeAttribute('data-feed-target');
      node.setAttribute('data-feed-target', '');
      node.tabIndex = -1;
      node.scrollIntoView({ block: 'start' });
      node.focus({ preventScroll: true });
    }

    // Puts the feed in the address without a new history entry.
    function writeAddress() {
      if (location.pathname !== '/feed') return;
      var search = feedId && objectsIn(feeds).length > 1 ? '?f=' + encodeURIComponent(feedId) : '';
      if (location.search !== search) history.replaceState(null, '', '/feed' + search);
    }

    function pickFeed() {
      var list = objectsIn(feeds);
      var wanted = target && target.feed ? target.feed : feedInAddress() || feedId;
      var found = list.find(function (feed) { return feed.id === wanted; }) ||
        list.find(function (feed) { return feed.id === feedId; }) || list[0] || null;
      if ((found ? found.id : null) !== feedId) {
        feedId = found ? found.id : null;
        data = null;
        filter = null;
        expanded = {};
      }
    }

    // Resolves once the answer is handled.
    function load() {
      var id = ++sequence;
      return Promise.all([request('/api/feeds'), request('/api/sources')]).then(function (answers) {
        if (id !== sequence) return null;
        var list = answers[0];
        if (!list || list.status !== 200 || !list.body || !Array.isArray(list.body.feeds)) {
          if (visible) setNoAnswer();
          return null;
        }
        feeds = objectsIn(list.body.feeds);
        feedProblems = arrayOf(list.body.problems);
        var names = {};
        if (answers[1] && answers[1].status === 200 && answers[1].body) {
          objectsIn(answers[1].body.sources).forEach(function (source) {
            if (typeof source.id === 'string' && typeof source.name === 'string') names[source.id] = source.name;
          });
        }
        sourceNames = names;
        pickFeed();
        listeners.forEach(function (listener) { listener(feeds); });
        if (!feedId) {
          data = null;
          renderIfChanged();
          return null;
        }
        return request(feedPath(feedId)).then(function (result) {
          if (id !== sequence) return;
          if (result && result.status === 200 && result.body && Array.isArray(result.body.runs)) {
            data = result.body;
            if (visible) writeAddress();
            renderIfChanged();
          } else if (visible) {
            setNoAnswer();
          }
          revealTarget(true);
        });
      });
    }

    function apply(next) {
      if (!next || !Array.isArray(next.runs)) return;
      data = next;
      renderIfChanged();
    }

    function switchTo(id) {
      if (id === feedId) return;
      feedId = id;
      data = null;
      filter = null;
      missed = false;
      expanded = {};
      writeAddress();
      rendered = null;
      render();
      document.getElementById('feed-page').scrollTop = 0;
      load();
    }

    function itemNode(id) {
      return runs.querySelector('[data-feed-item="' + CSS.escape(id) + '"]');
    }

    function reasonFor(id) {
      var node = itemNode(id);
      return node ? node.querySelector('.feed-reason') : null;
    }

    function showReason(id, fallback, result) {
      var code = result && result.body && typeof result.body.error === 'string' ? result.body.error : null;
      var current = reasonFor(id) || fallback;
      if (!current) return;
      current.textContent = result ? refusalSentence(result.status, code) : NO_ANSWER;
      current.hidden = false;
    }

    function discuss(id, button) {
      if (pending) return;
      pending = id;
      button.disabled = true;
      var reason = reasonFor(id);
      if (reason) reason.hidden = true;
      var feed = feedId;
      postJson(feedPath(feed, 'discuss'), { id: id }).then(function (result) {
        pending = null;
        button.disabled = false;
        if (result && result.status === 202 && result.body && typeof result.body.agentId === 'string') {
          if (visible) shellApi.openAgent(result.body.agentId);
          return;
        }
        showReason(id, reason, result);
      });
    }

    function mark(action, id, button) {
      if (pending) return;
      pending = id;
      // Read before disabling, which drops focus in Chromium.
      var focused = document.activeElement === button && button.classList.contains('feed-save-toggle');
      button.disabled = true;
      var reason = reasonFor(id);
      if (reason) reason.hidden = true;
      var feed = feedId;
      postJson(feedPath(feed, action), { id: id }).then(function (result) {
        pending = null;
        button.disabled = false;
        if (result && result.status === 200 && result.body && Array.isArray(result.body.runs)) {
          // A read already out predates the mark; its answer is dropped.
          if (feed === feedId) {
            sequence += 1;
            apply(result.body);
          }
          // The render replaced the bookmark; a keyboard toggle keeps its place.
          if (focused) {
            var row = itemNode(id);
            var next = row && row.querySelector('.feed-save-toggle');
            if (next) next.focus();
          }
          return;
        }
        showReason(id, reason, result);
      });
    }

    function toggleInsights(button) {
      var id = button.getAttribute('data-feed-id');
      var open = button.getAttribute('aria-expanded') !== 'true';
      var panel = document.getElementById(button.getAttribute('aria-controls'));
      button.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (panel) panel.hidden = !open;
      if (open) expanded[id] = true;
      else delete expanded[id];
    }

    function choose(key) {
      filter = key === 'all' ? null : key;
      rendered = null;
      render();
      document.getElementById('feed-page').scrollTop = 0;
      shellApi.closePanel();
    }

    // The post the reader is at: the first whose top edge is within the
    // scroll container's visible box (a pixel of slack, since a scrolled
    // edge lands on fractions).
    function itemInView() {
      var scroller = document.getElementById('feed-page');
      if (!scroller || !data) return null;
      var box = scroller.getBoundingClientRect();
      var nodes = runs.querySelectorAll('.feed-item[data-feed-item]');
      for (var i = 0; i < nodes.length; i += 1) {
        var top = nodes[i].getBoundingClientRect().top;
        if (top >= box.top - 1 && top < box.bottom) return itemById(nodes[i].getAttribute('data-feed-item'));
      }
      return null;
    }

    function itemById(id) {
      var found = null;
      objectsIn(data && data.runs).forEach(function (run) {
        objectsIn(run.items).forEach(function (item) { if (!found && item.id === id) found = item; });
      });
      return found;
    }

    if (side) {
      side.addEventListener('click', function (event) {
        var row = event.target.closest && event.target.closest('button[data-feed-filter]');
        if (row) choose(row.getAttribute('data-feed-filter'));
      });
    }
    filterLine.addEventListener('click', function (event) {
      if (event.target.closest && event.target.closest('button[data-feed-action="show-all"]')) choose('all');
    });
    tabs.addEventListener('click', function (event) {
      var tab = event.target.closest && event.target.closest('button[data-feed-tab]');
      if (tab) switchTo(tab.getAttribute('data-feed-tab'));
    });
    tabs.addEventListener('keydown', function (event) {
      if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
      var list = Array.prototype.slice.call(tabs.querySelectorAll('button[data-feed-tab]'));
      var at = list.indexOf(document.activeElement);
      if (at === -1) return;
      event.preventDefault();
      var next = list[(at + (event.key === 'ArrowRight' ? 1 : list.length - 1)) % list.length];
      switchTo(next.getAttribute('data-feed-tab'));
      var focused = tabs.querySelector('[data-feed-tab="' + CSS.escape(next.getAttribute('data-feed-tab')) + '"]');
      if (focused) focused.focus();
    });

    runs.addEventListener('click', function (event) {
      var button = event.target.closest && event.target.closest('button[data-feed-action]');
      if (!button) return;
      var action = button.getAttribute('data-feed-action');
      var id = button.getAttribute('data-feed-id');
      if (action === 'insights') toggleInsights(button);
      else if (action === 'discuss') discuss(id, button);
      else mark(action, id, button);
    });

    return {
      update: function (next, keys) {
        state = next;
        if (visible && feeds !== null && (!keys || keys.includes('agents') || keys.includes('jobs'))) renderIfChanged();
      },
      show: function () {
        if (visible) return;
        visible = true;
        var wanted = feedInAddress();
        if (wanted && wanted !== feedId && feeds !== null) pickFeed();
        if (feeds !== null) render();
        load();
        poll = setInterval(load, POLL_MS);
      },
      // Opens a feed's tab and reads it again (feed-settings.js after a
      // change, or a new feed).
      open: function (id) {
        if (id && id !== feedId) {
          feedId = id;
          data = null;
          filter = null;
          expanded = {};
        }
        writeAddress();
        rendered = null;
        if (visible) render();
        return load();
      },
      reload: function () { return load(); },
      current: function () { return openFeed(); },
      producerName: function () { return producerName(); },
      feeds: function () { return objectsIn(feeds); },
      onFeeds: function (listener) { listeners.push(listener); },
      // Scrolls to the post at `index` in the run's file once it is drawn (a
      // notification's link), in `feed` when given, or says it is gone;
      // show() has already run.
      reveal: function (run, index, feed) {
        target = { feed: feed || null, run: run, index: index };
        if (missed) {
          missed = false;
          render();
        }
        if (feed && feed !== feedId && feeds !== null) {
          switchTo(feed);
          return;
        }
        if (filter !== null) {
          filter = null;
          rendered = null;
          render();
        }
        revealTarget(false);
        // Not on the page: read the feed again, which reveals it or says
        // it is gone.
        if (target) load();
      },
      // What quick chat sends along from the Feed: the topmost post whose
      // top edge is inside the scrolling list, or the view's name alone.
      context: function () {
        var item = visible ? itemInView() : null;
        if (!item) return { view: 'feed' };
        var lines = [];
        var names = itemSources(item).map(sourceName);
        if (names.length) lines.push('Source: ' + names.join(', '));
        if (item.url) lines.push('URL: ' + item.url);
        if (item.summary) lines.push('Summary: ' + item.summary);
        if (item.takeaway) lines.push('Takeaway: ' + item.takeaway);
        return { view: 'feed', label: item.title, detail: lines.join('\n') };
      },
      hide: function () {
        visible = false;
        filter = null;
        missed = false;
        if (side) side.textContent = '';
        filterLine.hidden = true;
        rendered = null;
        if (poll !== null) clearInterval(poll);
        poll = null;
      },
    };
  }

  window.DashboardFeed = {
    create: create, dateSentence: dateSentence, sinceSentence: sinceSentence, request: request, postJson: postJson,
  };
}());
