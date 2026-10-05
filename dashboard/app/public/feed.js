// Feed: the runs in the feed store (/api/feed), one group per run with its
// items as posts (with the story's image under the summary when it has one),
// each with a Discuss button that sends the item to the watch persona
// (/api/feed/discuss) and opens its thread. A Feed instructions button in
// the header opens a panel above the posts with the feed's criteria as
// prose (/api/feed/instructions, read each time it opens) and a composer
// that sends a change to the watch persona
// (/api/feed/instructions/propose) and opens its thread; the panel itself
// is instructions.js's. The shell calls create(shellApi) once, then show()
// and hide() as the Feed view comes on and off screen.
//
// The Feed's section of the side panel is drawn on the same render as the
// posts and cleared on hide: All with the total, then Sources, one row per
// source with its count, by count then name. Choosing a source hides the
// other posts and any run left empty, with a line above the posts saying so
// and Show all; All or Show all brings everything back. The choice is held
// only while the view is shown, and on a phone it closes the drawer.
//
// While shown, the view fetches /api/feed on show() and every 60 seconds. An
// answer identical to the last one rendered changes nothing; the panel is
// outside what it renders, so it keeps its text. A body that is
// not the expected shape shows the no-answer sentence. Buttons carry
// data-feed-action, never data-action, which the shell's own click handler
// owns. Every text node is set with textContent.
(function () {
  'use strict';

  var AGENT_ID = 'watch';
  var POLL_MS = 60000;
  var TIMEOUT_MS = 8000;
  var NO_ANSWER = 'The dashboard did not respond.';
  var EMPTY = 'Nothing in the feed yet.';
  var BUSY = 'Watch is in the middle of a turn. Try again when it is idle.';
  var NOT_RUNNING = 'Watch is not running.';
  var GONE = 'That item is no longer in the feed.';
  var TOO_LONG = 'That is too long for one message.';
  var LABEL_MAX = 60;
  var DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  var BADGE_COLOURS = 6;
  var SVG_NS = 'http://www.w3.org/2000/svg';

  function element(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function refusalSentence(status, code) {
    if (status === 409 && code === 'busy') return BUSY;
    if (status === 503 || (status === 409 && code === 'persona_unavailable') ||
        (status === 404 && code === 'no_such_agent')) return NOT_RUNNING;
    if (status === 404 && code === 'no_such_item') return GONE;
    if (status === 413) return TOO_LONG;
    return NO_ANSWER;
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

  // "AN" for "Axios Nashville": the first letter of each of the first two
  // words, upper case.
  function initials(source) {
    var words = String(source).split(/\s+/).filter(Boolean).slice(0, 2);
    return words.map(function (word) { return Array.from(word)[0]; }).join('').toUpperCase();
  }

  // One of the badge colours, the same for a source every time.
  function colourIndex(source) {
    var hash = 0;
    var text = String(source);
    for (var i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
    return hash % BADGE_COLOURS;
  }

  function speechBubble() {
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'feed-icon');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('width', '16');
    svg.setAttribute('height', '16');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    var path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', 'M2.5 3.5h11v7.5h-6.5l-3 2.5v-2.5h-1.5z');
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '1.5');
    path.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(path);
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

  function arrayOf(value) {
    return Array.isArray(value) ? value : [];
  }

  // The objects in a list, without nulls or other stray values.
  function objectsIn(value) {
    return arrayOf(value).filter(function (entry) { return entry !== null && typeof entry === 'object'; });
  }

  function create(shellApi) {
    var message = document.getElementById('feed-message');
    var runs = document.getElementById('feed-runs');
    var filterLine = document.getElementById('feed-filter');
    var sources = document.querySelector('[data-panel-for="feed"]');

    var data = null; // the last /api/feed answer
    var visible = false;
    var poll = null;
    var sequence = 0;
    var rendered = null; // the JSON text of the answer on screen
    var pending = null; // the id being discussed, while the request is out
    var target = null; // { run, index } to scroll to once it is drawn
    var filter = null; // the source whose posts alone are shown

    function discussButton(item) {
      var button = element('button', 'feed-discuss');
      button.type = 'button';
      button.setAttribute('data-feed-action', 'discuss');
      button.setAttribute('data-feed-id', item.id);
      var label = 'Discuss ' + item.title;
      if (label.length > LABEL_MAX) label = label.slice(0, LABEL_MAX - 1) + '…';
      button.setAttribute('aria-label', label);
      button.appendChild(speechBubble());
      button.appendChild(document.createTextNode('Discuss'));
      button.disabled = pending === item.id;
      return button;
    }

    function renderItem(item) {
      var node = element('article', 'feed-item');
      node.setAttribute('data-feed-item', item.id);
      node.setAttribute('data-feed-source', item.source);
      var badge = element('span', 'feed-badge feed-badge-' + colourIndex(item.source), initials(item.source));
      badge.setAttribute('role', 'img');
      badge.setAttribute('aria-label', item.source);
      badge.title = item.source;
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
      if (typeof item.image === 'string' && /^https?:\/\//i.test(item.image)) body.appendChild(storyImage(item.image));
      var actions = element('div', 'feed-actions');
      actions.appendChild(discussButton(item));
      body.appendChild(actions);
      var reason = element('p', 'feed-reason');
      reason.setAttribute('role', 'status');
      reason.hidden = true;
      body.appendChild(reason);
      node.appendChild(body);
      return node;
    }

    function renderRun(run) {
      var group = element('section', 'feed-run');
      var headingId = 'feed-run-' + run.id;
      group.setAttribute('aria-labelledby', headingId);
      group.setAttribute('data-feed-run', run.id);
      var header = element('div', 'feed-run-header');
      var title = element('h2', 'feed-date', dateSentence(run.date));
      title.id = headingId;
      header.appendChild(title);
      var since = sinceSentence(run.since);
      if (since) header.appendChild(element('span', 'feed-since', since));
      group.appendChild(header);
      objectsIn(run.items).forEach(function (item) { group.appendChild(renderItem(item)); });
      return group;
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

    // A row in the panel; `source` is null for All.
    function sourceRow(source, name, count) {
      var row = element('button', 'panel-row');
      row.type = 'button';
      row.setAttribute('data-feed-source', source === null ? '' : source);
      if (source !== null) {
        var badge = element('span', 'feed-badge feed-badge-' + colourIndex(source), initials(source));
        badge.setAttribute('aria-hidden', 'true');
        row.appendChild(badge);
      }
      row.appendChild(element('span', 'panel-row-name', name));
      row.appendChild(element('span', 'panel-row-count', String(count)));
      return row;
    }

    // All and one row per source across the runs shown, by count then name.
    function renderSources(shown) {
      var counts = new Map();
      var total = 0;
      shown.forEach(function (run) {
        objectsIn(run.items).forEach(function (item) {
          var source = String(item.source);
          counts.set(source, (counts.get(source) || 0) + 1);
          total += 1;
        });
      });
      if (filter !== null && !counts.has(filter)) filter = null;
      var names = Array.from(counts.keys()).sort(function (a, b) {
        return counts.get(b) - counts.get(a) || (a < b ? -1 : a > b ? 1 : 0);
      });
      sources.textContent = '';
      sources.appendChild(sourceRow(null, 'All', total));
      sources.appendChild(element('h2', 'panel-heading', 'Sources'));
      names.forEach(function (name) { sources.appendChild(sourceRow(name, name, counts.get(name))); });
      shellApi.refreshPanel();
    }

    // Hides the posts from other sources and any run left empty, and says
    // which source is shown.
    function applyFilter() {
      var groups = runs.querySelectorAll('.feed-run');
      for (var i = 0; i < groups.length; i += 1) {
        var items = groups[i].querySelectorAll('.feed-item');
        var any = false;
        for (var j = 0; j < items.length; j += 1) {
          var match = filter === null || items[j].getAttribute('data-feed-source') === filter;
          items[j].hidden = !match;
          if (match) any = true;
        }
        groups[i].hidden = !any;
      }
      var rows = sources.querySelectorAll('.panel-row');
      for (var r = 0; r < rows.length; r += 1) {
        var current = rows[r].getAttribute('data-feed-source') === (filter === null ? '' : filter);
        if (current) rows[r].setAttribute('aria-current', 'true');
        else rows[r].removeAttribute('aria-current');
      }
      filterLine.textContent = '';
      filterLine.hidden = filter === null;
      if (filter === null) return;
      filterLine.appendChild(document.createTextNode('Showing ' + filter + ' only. '));
      var all = element('button', 'link-button', 'Show all');
      all.type = 'button';
      all.setAttribute('data-feed-action', 'show-all');
      filterLine.appendChild(all);
    }

    function choose(source) {
      filter = source;
      applyFilter();
    }

    // Builds every group before touching the page, so a body that is not the
    // expected shape leaves the last render in place and says so.
    function render() {
      if (!data) return;
      var built = [];
      var shown = [];
      try {
        objectsIn(data.runs).forEach(function (run) {
          if (objectsIn(run.items).length === 0) return;
          built.push(renderRun(run));
          shown.push(run);
        });
      } catch (_error) {
        setNoAnswer();
        return;
      }
      var problems = arrayOf(data.problems).filter(function (text) { return typeof text === 'string'; });
      setMessage(built.length === 0 ? [EMPTY].concat(problems) : problems);
      runs.textContent = '';
      built.forEach(function (group) { runs.appendChild(group); });
      renderSources(shown);
      applyFilter();
      rendered = JSON.stringify(data);
    }

    // Scrolls to the target item and marks it, when it is on the page. With
    // `last`, a target that is not there is given up.
    function revealTarget(last) {
      if (!target || !visible) return;
      var group = runs.querySelector('[data-feed-run="' + CSS.escape(target.run) + '"]');
      var node = group ? group.querySelectorAll('.feed-item')[target.index] : null;
      if (!node) {
        if (last) target = null;
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

    // Resolves once the answer is handled.
    function load() {
      var id = ++sequence;
      return request('/api/feed', { method: 'GET' }).then(function (result) {
        if (id !== sequence) return;
        if (result && result.status === 200 && result.body && Array.isArray(result.body.runs)) {
          var text = JSON.stringify(result.body);
          data = result.body;
          if (visible && text !== rendered) render();
        } else if (visible) {
          setNoAnswer();
        }
        revealTarget(true);
      });
    }

    function reasonFor(id) {
      var item = runs.querySelector('[data-feed-item="' + CSS.escape(id) + '"]');
      return item ? item.querySelector('.feed-reason') : null;
    }

    function discuss(id, button) {
      if (pending) return;
      pending = id;
      button.disabled = true;
      var reason = reasonFor(id);
      if (reason) reason.hidden = true;
      request('/api/feed/discuss', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: id }),
      }).then(function (result) {
        pending = null;
        button.disabled = false;
        if (result && result.status === 202) {
          if (visible) shellApi.openAgent(result.body && typeof result.body.agentId === 'string' ? result.body.agentId : AGENT_ID);
          return;
        }
        var code = result && result.body && typeof result.body.error === 'string' ? result.body.error : null;
        var current = reasonFor(id) || reason;
        if (!current) return;
        current.textContent = result ? refusalSentence(result.status, code) : NO_ANSWER;
        current.hidden = false;
      });
    }

    // The Feed instructions panel (instructions.js): the criteria, read each
    // time it opens, and a change sent to Watch.
    var panel = window.DashboardInstructions
      ? window.DashboardInstructions.create({
        prefix: 'feed',
        readPath: '/api/feed/instructions',
        proposePath: '/api/feed/instructions/propose',
        refusalSentence: refusalSentence,
        openAgent: function (id) { if (visible) shellApi.openAgent(id || AGENT_ID); },
      })
      : null;

    // The item the reader is at: the first whose top edge is within the
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
      objectsIn(data.runs).forEach(function (run) {
        objectsIn(run.items).forEach(function (item) { if (!found && item.id === id) found = item; });
      });
      return found;
    }

    runs.addEventListener('click', function (event) {
      var button = event.target.closest && event.target.closest('button[data-feed-action="discuss"]');
      if (!button) return;
      discuss(button.getAttribute('data-feed-id'), button);
    });

    filterLine.addEventListener('click', function (event) {
      if (event.target.closest && event.target.closest('button[data-feed-action="show-all"]')) choose(null);
    });

    sources.addEventListener('click', function (event) {
      var row = event.target.closest && event.target.closest('button.panel-row[data-feed-source]');
      if (!row) return;
      var source = row.getAttribute('data-feed-source');
      choose(source === '' ? null : source);
      shellApi.closePanel();
    });

    return {
      show: function () {
        if (visible) return;
        visible = true;
        if (panel) panel.show();
        if (data) render();
        load();
        poll = setInterval(load, POLL_MS);
      },
      // Scrolls to the index-th item of the run once it is drawn (a
      // notification's link); show() has already run.
      reveal: function (run, index) {
        target = { run: run, index: index };
        if (filter !== null) choose(null);
        revealTarget(false);
      },
      // What quick chat sends along from the Feed: the topmost item whose
      // top edge is inside the scrolling list, or the view's name alone.
      context: function () {
        var item = visible ? itemInView() : null;
        if (!item) return { view: 'feed' };
        var lines = [];
        if (item.source) lines.push('Source: ' + item.source);
        if (item.url) lines.push('URL: ' + item.url);
        if (item.summary) lines.push('Summary: ' + item.summary);
        return { view: 'feed', label: item.title, detail: lines.join('\n') };
      },
      hide: function () {
        visible = false;
        filter = null;
        sources.textContent = '';
        filterLine.textContent = '';
        filterLine.hidden = true;
        if (panel) panel.hide();
        if (poll !== null) clearInterval(poll);
        poll = null;
      },
    };
  }

  window.DashboardFeed = { create: create, refusalSentence: refusalSentence, dateSentence: dateSentence, sinceSentence: sinceSentence };
}());
