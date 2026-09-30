// Feed: the runs in the feed store (/api/feed), one card per run with its
// items, each with a Discuss button that sends the item to the watch persona
// (/api/feed/discuss) and opens its thread. The shell calls
// create(shellApi) once, then show() and hide() as the Feed tab of the
// Reading view comes on and off screen.
//
// While shown, the view fetches /api/feed on show() and every 60 seconds. An
// answer identical to the last one rendered changes nothing. A body that is
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
  var LABEL_MAX = 60;
  var DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

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

    var data = null; // the last /api/feed answer
    var visible = false;
    var poll = null;
    var sequence = 0;
    var rendered = null; // the JSON text of the answer on screen
    var pending = null; // the id being discussed, while the request is out

    function discussButton(item) {
      var button = element('button', 'button button-small', 'Discuss');
      button.type = 'button';
      button.setAttribute('data-feed-action', 'discuss');
      button.setAttribute('data-feed-id', item.id);
      var label = 'Discuss ' + item.title;
      if (label.length > LABEL_MAX) label = label.slice(0, LABEL_MAX - 1) + '…';
      button.setAttribute('aria-label', label);
      button.disabled = pending === item.id;
      return button;
    }

    function renderItem(item) {
      var node = element('article', 'feed-item');
      node.setAttribute('data-feed-item', item.id);
      node.appendChild(element('span', 'role-chip', item.source));
      var title = element('h3', 'feed-title');
      var link = element('a', null, item.title);
      link.href = item.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      title.appendChild(link);
      node.appendChild(title);
      node.appendChild(element('p', 'feed-summary', item.summary));
      var actions = element('div', 'feed-actions');
      actions.appendChild(discussButton(item));
      node.appendChild(actions);
      var reason = element('p', 'feed-reason');
      reason.setAttribute('role', 'status');
      reason.hidden = true;
      node.appendChild(reason);
      return node;
    }

    function renderRun(run) {
      var card = element('section', 'routine-card feed-run');
      var headingId = 'feed-run-' + run.id;
      card.setAttribute('aria-labelledby', headingId);
      card.setAttribute('data-feed-run', run.id);
      var header = element('div', 'card-header');
      var title = element('h2', 'card-name', dateSentence(run.date));
      title.id = headingId;
      header.appendChild(title);
      var since = sinceSentence(run.since);
      if (since) header.appendChild(element('span', 'card-note', since));
      card.appendChild(header);
      objectsIn(run.items).forEach(function (item) { card.appendChild(renderItem(item)); });
      return card;
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

    // Builds every card before touching the page, so a body that is not the
    // expected shape leaves the last render in place and says so.
    function render() {
      if (!data) return;
      var built = [];
      try {
        objectsIn(data.runs).forEach(function (run) {
          if (objectsIn(run.items).length > 0) built.push(renderRun(run));
        });
      } catch (_error) {
        setNoAnswer();
        return;
      }
      var problems = arrayOf(data.problems).filter(function (text) { return typeof text === 'string'; });
      setMessage(built.length === 0 ? [EMPTY].concat(problems) : problems);
      runs.textContent = '';
      built.forEach(function (card) { runs.appendChild(card); });
      rendered = JSON.stringify(data);
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

    runs.addEventListener('click', function (event) {
      var button = event.target.closest && event.target.closest('button[data-feed-action="discuss"]');
      if (!button) return;
      discuss(button.getAttribute('data-feed-id'), button);
    });

    return {
      show: function () {
        if (visible) return;
        visible = true;
        if (data) render();
        load();
        poll = setInterval(load, POLL_MS);
      },
      hide: function () {
        visible = false;
        if (poll !== null) clearInterval(poll);
        poll = null;
      },
    };
  }

  window.DashboardFeed = { create: create, refusalSentence: refusalSentence, dateSentence: dateSentence, sinceSentence: sinceSentence };
}());
