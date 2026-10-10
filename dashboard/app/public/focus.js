// Focus: the attention board, read from /api/focus and changed one op at a
// time through POST /api/focus/changes, whose answer is the board drawn at
// once. Shown by the shell only when the hub reports `focus.native`; the
// iframe path stays the shell's own otherwise.
//
// The board as the old page drew it: Now, Rest of today, Tomorrow, and Later,
// open cards before done ones, then by rank with unranked cards last; a done
// card stays for 24 hours, collapsed to its title until clicked. The tabs pick
// a horizon: the horizons above it are hidden, and so is its own heading. The
// check sends `done` or `reopen`; the ⋯ menu moves a card to one of the four
// places (no order), adds or changes its note, or dismisses it (a done card's
// menu holds Note alone); a manual open card's title edits on double-click.
// The add row under Today sends `add` on Enter and keeps its draft across
// renders. Drag drops a card at the line in a list (`move` with that place's
// whole order) or on a tab (`move` with the card first in that place).
// Recently cleared lists expired and dismissed cards with Reopen. Considered
// reads /api/focus/candidates when shown and when opened, lists the sources
// with candidates, and hides itself when none has any; Add opens an inline
// title and sends `add` with the candidate's external_id, link, and meta in
// the current tab's place, then reads the candidates again.
//
// A refusal's sentence shows in #focus-message and the board is read again.
// update() reads the board again when the snapshot's `focus.updated` moves;
// while Hunter is mid-action (a focused field, an open menu, an edit, a drag,
// or a request in flight) that waits until he is done. While shown, the board
// draws again every minute so done cards leave at their 24-hour mark.
//
// The side panel's Focus section lists Now, Today, Tomorrow, and Later with
// their open counts, then Recently cleared and Considered while they hold
// anything; choosing one selects the tab that shows it and scrolls to it.
// The rules panel behind the header's gear is instructions.js's. Every text
// node is set with textContent.
(function () {
  'use strict';

  var TIMEOUT_MS = 8000;
  var TICK_MS = 60000;
  var IDLE_CHECK_MS = 400;
  var DAY_MS = 24 * 60 * 60 * 1000;
  var NO_ANSWER = 'The dashboard did not respond.';
  var MISSING = 'The Focus board is missing.';
  var HORIZONS = ['today', 'tomorrow', 'later'];
  var PLACES = [
    { key: 'now', label: 'Now' },
    { key: 'today', label: 'Today' },
    { key: 'tomorrow', label: 'Tomorrow' },
    { key: 'later', label: 'Later' },
  ];
  var PLACE_LABELS = { now: 'Now', today: 'Today', tomorrow: 'Tomorrow', later: 'Later' };
  var EMPTY = {
    now: 'Nothing now.',
    today: 'Nothing else today.',
    tomorrow: 'Nothing for tomorrow.',
    later: 'Nothing for later.',
  };
  var SOURCE_NAMES = { gmail: 'Gmail', calendar: 'Calendar', notes: 'Notes', git: 'Git', manual: 'Manual' };
  var STATUS_NAMES = { done: 'Done', expired: 'Expired', dismissed: 'Dismissed' };
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var ICONS = {
    gmail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
    calendar: '<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 2v4M16 2v4"/>',
    git: '<circle cx="6" cy="6" r="2.6"/><circle cx="6" cy="18" r="2.6"/><circle cx="18" cy="9" r="2.6"/><path d="M6 8.6v6.8M18 11.6c0 4-6 3-9.4 4.6"/>',
    notes: '<path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>',
    manual: '<path d="M17 3a2.8 2.8 0 0 1 4 4L8 20l-5 1 1-5z"/>',
  };
  var CHECK = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="m4 12.5 5.2 5.2L20 6.8"/></svg>';
  var DOTS = '<svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/></svg>';

  function element(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function icon(source) {
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'focus-source-icon');
    svg.setAttribute('width', '14');
    svg.setAttribute('height', '14');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    svg.innerHTML = ICONS[source] || ICONS.manual;
    return svg;
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

  function arrayOf(value) { return Array.isArray(value) ? value : []; }

  function age(iso) {
    var time = Date.parse(iso);
    if (Number.isNaN(time)) return '';
    var minutes = Math.floor((Date.now() - time) / 60000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return minutes + 'm';
    var hours = Math.floor(minutes / 60);
    if (hours < 24) return hours + 'h';
    var days = Math.floor(hours / 24);
    if (days < 14) return days + 'd';
    return Math.floor(days / 7) + 'w';
  }

  function safeLink(value) {
    return typeof value === 'string' && /^(https?:|mailto:)/i.test(value.trim()) ? value.trim() : null;
  }

  function placeOf(item) { return item.now && item.tier === 'today' ? 'now' : item.tier; }
  function rankOf(item) { return item && item.rank !== undefined && item.rank !== null ? item.rank : null; }

  // Open before done; then rank, with unranked cards after the ranked ones in
  // the board's own order (the sort is stable).
  function order(a, b) {
    if (a.status !== b.status) return a.status === 'done' ? 1 : -1;
    var ra = rankOf(a);
    var rb = rankOf(b);
    if (ra === null && rb === null) return 0;
    if (ra === null) return 1;
    if (rb === null) return -1;
    return ra - rb;
  }

  function create(shellApi) {
    var board = document.getElementById('focus-board');
    var page = document.getElementById('focus-page');
    var tabs = document.getElementById('focus-tabs');
    var sections = document.getElementById('focus-sections');
    var message = document.getElementById('focus-message');
    var addInput = document.getElementById('focus-add');
    var cleared = document.getElementById('focus-cleared');
    var clearedList = document.getElementById('focus-cleared-list');
    var considered = document.getElementById('focus-considered');
    var consideredBody = document.getElementById('focus-considered-body');
    var side = document.querySelector('[data-panel-for="focus"]');
    var lists = {};
    Array.prototype.forEach.call(board.querySelectorAll('ul[data-place]'), function (list) {
      lists[list.getAttribute('data-place')] = list;
    });

    var state = null;
    var data = null; // the board, or null before the first answer or with a problem
    var problem = null; // the board's problem sentence
    var notice = null; // a refused change's sentence
    var seen = null; // the board stamp drawn last
    var visible = false;
    var sequence = 0;
    var tab = 'today';
    var inflight = false;
    var openMenu = null; // card id whose menu is open
    var editing = null; // card id whose title is being edited
    var editValue = null;
    var noting = null; // card id whose note is being edited
    var noteValue = null;
    var dragId = null;
    var dropping = false;
    var addDraft = '';
    var expanded = new Set(); // done cards opened past their title
    var candidates = null; // { sources } once read
    var candidateSequence = 0;
    var promoting = null; // candidate key whose title is being written
    var promoteValue = null;
    var chosen = null; // the panel's current row
    var pending = false; // a newer board waits for Hunter to finish
    var idleTimer = null;
    var tickTimer = null;
    var rendering = false;

    function byId(id) {
      return data ? arrayOf(data.items).find(function (item) { return item.id === id; }) || null : null;
    }

    function agents() { return state && Array.isArray(state.agents) ? state.agents : []; }
    function pinnedName() {
      var listed = agents().filter(function (entry) { return entry.kind === 'persona' && entry.provider === 'claude'; });
      return (listed.find(function (entry) { return entry.pinned === true; }) || listed.find(function (entry) { return entry.builtin === true; }) || listed[0] || {}).name || 'That agent';
    }

    function rulesRefusal(status, code) {
      if (status === 409 && code === 'busy') return pinnedName() + ' is in the middle of a turn. Try again when it is idle.';
      if (status === 503 || (status === 409 && code === 'persona_unavailable') ||
          (status === 404 && code === 'no_such_agent')) return pinnedName() + ' is not running.';
      if (status === 413) return 'That is too long for one message.';
      return NO_ANSWER;
    }

    function changeRefusal(status, code) {
      if (code === 'no_such_item') return 'That card is no longer on the board.';
      if (code === 'not_open' || code === 'not_closed' || code === 'invalid_order') return 'The board changed before that went through.';
      if (code === 'not_manual') return 'Only a card you added can be renamed.';
      if (code === 'no_board') return MISSING;
      if (status === 413) return 'That is too long.';
      if (status >= 400 && status < 500) return 'The board refused that change.';
      return NO_ANSWER;
    }

    function busy() {
      var active = document.activeElement;
      if (active && board.contains(active) && active.matches('input, textarea')) return true;
      return inflight || editing !== null || noting !== null || promoting !== null || openMenu !== null ||
        dragId !== null || dropping;
    }

    function setMessage() {
      var lines = [problem, notice].filter(Boolean);
      message.textContent = lines.join(' ');
      message.hidden = lines.length === 0;
    }

    // ---------------------------------------------------------------- cards

    function menuEntry(text, attribute, value) {
      var button = element('button', 'menu-entry focus-menu-entry', text);
      button.type = 'button';
      button.setAttribute('role', 'menuitem');
      button.setAttribute(attribute, value);
      return button;
    }

    function cardMenu(item, done) {
      var menu = element('div', 'focus-menu');
      menu.setAttribute('role', 'menu');
      if (!done) {
        PLACES.forEach(function (place) {
          var entry = menuEntry(place.label, 'data-focus-move', place.key);
          entry.setAttribute('data-focus-id', item.id);
          if (placeOf(item) === place.key) entry.setAttribute('aria-current', 'true');
          menu.appendChild(entry);
        });
      }
      var note = menuEntry('Note', 'data-focus-note', item.id);
      if (!done) note.classList.add('focus-menu-divided');
      menu.appendChild(note);
      if (!done) {
        var dismiss = menuEntry('Dismiss', 'data-focus-dismiss', item.id);
        dismiss.classList.add('focus-menu-divided');
        menu.appendChild(dismiss);
      }
      return menu;
    }

    function card(item, big) {
      var done = item.status === 'done';
      var collapsed = done && !expanded.has(item.id);
      var node = element('li', 'focus-card');
      node.setAttribute('data-id', item.id);
      if (big && !collapsed) node.classList.add('focus-card-big');
      if (done) node.classList.add('focus-card-done');
      if (collapsed) node.classList.add('focus-card-collapsed');
      if (!done) node.setAttribute('draggable', 'true');

      var check = element('button', 'focus-check');
      check.type = 'button';
      check.setAttribute('data-focus-check', item.id);
      check.setAttribute('aria-label', 'Done');
      check.setAttribute('aria-pressed', done ? 'true' : 'false');
      check.innerHTML = CHECK;
      node.appendChild(check);

      var body = element('div', 'focus-card-body');
      if (done) {
        body.setAttribute('data-focus-expand', item.id);
        body.setAttribute('role', 'button');
        body.setAttribute('tabindex', '0');
        body.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      }
      var link = collapsed ? null : safeLink(item.link);
      var title;
      if (link) {
        title = element('a', 'focus-title', item.title);
        title.href = link;
        title.target = '_blank';
        title.rel = 'noopener noreferrer';
      } else {
        title = element('div', 'focus-title', item.title);
        if (item.source === 'manual' && !done) title.setAttribute('data-editable', '');
      }
      body.appendChild(title);
      if (!collapsed) {
        var meta = element('p', 'focus-meta');
        meta.appendChild(icon(item.source));
        var bits = [];
        if (item.meta) bits.push(item.meta);
        var ageText = age(item.updated);
        if (ageText) bits.push(ageText);
        meta.appendChild(element('span', null, bits.join(' · ')));
        body.appendChild(meta);
        if (item.note) body.appendChild(element('p', 'focus-note', item.note));
      }
      node.appendChild(body);

      var wrap = element('div', 'focus-menu-wrap');
      var more = element('button', 'focus-more');
      more.type = 'button';
      more.setAttribute('data-focus-more', item.id);
      more.setAttribute('aria-label', 'More');
      more.setAttribute('title', 'More');
      more.setAttribute('aria-haspopup', 'menu');
      more.setAttribute('aria-expanded', openMenu === item.id ? 'true' : 'false');
      more.innerHTML = DOTS;
      wrap.appendChild(more);
      if (openMenu === item.id) wrap.appendChild(cardMenu(item, done));
      node.appendChild(wrap);
      return node;
    }

    function fill(list, items, big, empty) {
      list.textContent = '';
      if (!items.length) {
        var row = element('li', 'focus-empty-row');
        row.appendChild(element('p', 'focus-empty', empty));
        list.appendChild(row);
        return;
      }
      items.forEach(function (item) { list.appendChild(card(item, big)); });
    }

    function liveItems() {
      var cutoff = Date.now() - DAY_MS;
      return arrayOf(data && data.items).filter(function (item) {
        return item.status === 'open' || (item.status === 'done' && Date.parse(item.updated) > cutoff);
      });
    }

    function itemsOf(place, live) {
      return (live || liveItems()).filter(function (item) { return placeOf(item) === place; }).sort(order);
    }

    function openCount(place) {
      return arrayOf(data && data.items).filter(function (item) { return item.status === 'open' && placeOf(item) === place; }).length;
    }

    function clearedItems() {
      return arrayOf(data && data.items).filter(function (item) { return item.status === 'expired' || item.status === 'dismissed'; });
    }

    function renderCleared() {
      var items = clearedItems();
      cleared.hidden = items.length === 0;
      clearedList.textContent = '';
      items.forEach(function (item) {
        var row = element('li', 'focus-row');
        if (item.status === 'dismissed') row.classList.add('focus-row-dismissed');
        row.appendChild(icon(item.source));
        var text = element('span', 'focus-row-title', item.title);
        if (item.status === 'dismissed') text.title = 'Dismissed';
        row.appendChild(text);
        var reopen = element('button', 'focus-pill', 'Reopen');
        reopen.type = 'button';
        reopen.setAttribute('data-focus-reopen', item.id);
        row.appendChild(reopen);
        clearedList.appendChild(row);
      });
    }

    function render() {
      if (!visible) return;
      rendering = true;
      try {
        setMessage();
        sections.hidden = !data;
        if (data) {
          var live = liveItems();
          PLACES.forEach(function (place) {
            fill(lists[place.key], itemsOf(place.key, live), place.key === 'now', EMPTY[place.key]);
          });
          renderCleared();
          seen = data.updated;
        }
        if (addInput.value !== addDraft) addInput.value = addDraft;
        if (editing && !byId(editing)) editing = null;
        if (noting && !byId(noting)) noting = null;
      } finally {
        rendering = false;
      }
      if (editing) startEdit(editing, true);
      if (noting) startNote(noting, true);
      renderPanel();
    }

    // ---------------------------------------------------------------- data

    function apply(next, nextProblem) {
      data = next;
      problem = nextProblem;
      render();
    }

    function load() {
      var id = ++sequence;
      return request('/api/focus', { method: 'GET' }).then(function (result) {
        if (id !== sequence) return;
        var body = result && result.body;
        if (result && result.status === 200 && body && (body.board || typeof body.problem === 'string')) {
          apply(body.board || null, typeof body.problem === 'string' ? body.problem : null);
        } else if (result && result.status === 404) {
          apply(null, MISSING);
        } else if (visible) {
          problem = data ? null : NO_ANSWER;
          if (data) notice = NO_ANSWER;
          setMessage();
        }
      });
    }

    function stopIdle() {
      if (idleTimer !== null) clearInterval(idleTimer);
      idleTimer = null;
    }

    // Reads the board now, or once Hunter is done with what he is doing.
    function refresh() {
      if (!visible) return;
      if (!busy()) {
        pending = false;
        load();
        return;
      }
      pending = true;
      if (idleTimer !== null) return;
      idleTimer = setInterval(function () {
        if (!visible) { stopIdle(); return; }
        if (busy()) return;
        stopIdle();
        pending = false;
        load();
      }, IDLE_CHECK_MS);
    }

    // One op to the board; its answer is drawn, a refusal says why and reads
    // the board again.
    function send(op) {
      if (inflight) return Promise.resolve(false);
      inflight = true;
      return request('/api/focus/changes', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(op),
      }).then(function (result) {
        inflight = false;
        if (result && result.status === 200 && result.body && result.body.board) {
          notice = null;
          apply(result.body.board, null);
          return true;
        }
        var code = result && result.body && typeof result.body.error === 'string' ? result.body.error : null;
        notice = result ? changeRefusal(result.status, code) : NO_ANSWER;
        setMessage();
        render();
        load();
        return false;
      });
    }

    // ---------------------------------------------------------------- tabs

    function selectTab(name) {
      tab = name;
      var from = HORIZONS.indexOf(name);
      Array.prototype.forEach.call(tabs.querySelectorAll('[data-focus-tab]'), function (button) {
        var selected = button.getAttribute('data-focus-tab') === name;
        button.setAttribute('aria-selected', selected ? 'true' : 'false');
        button.tabIndex = selected ? 0 : -1;
      });
      Array.prototype.forEach.call(sections.querySelectorAll('[data-focus-horizon]'), function (block) {
        var horizon = block.getAttribute('data-focus-horizon');
        block.hidden = HORIZONS.indexOf(horizon) < from;
        var lead = block.querySelector('.focus-lead');
        if (lead) lead.hidden = horizon === name;
      });
      sections.setAttribute('aria-labelledby', 'focus-tab-' + name);
      openMenu = null;
      page.scrollTop = 0;
      render();
    }

    tabs.addEventListener('click', function (event) {
      var button = event.target.closest && event.target.closest('[data-focus-tab]');
      if (button) selectTab(button.getAttribute('data-focus-tab'));
    });
    tabs.addEventListener('keydown', function (event) {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      var buttons = Array.prototype.slice.call(tabs.querySelectorAll('[data-focus-tab]'));
      var index = buttons.indexOf(document.activeElement);
      if (index < 0) return;
      event.preventDefault();
      var next = buttons[(index + (event.key === 'ArrowRight' ? 1 : buttons.length - 1)) % buttons.length];
      next.focus();
      selectTab(next.getAttribute('data-focus-tab'));
    });

    // ---------------------------------------------------------------- the panel

    function panelRow(key, name, count) {
      var row = element('button', 'panel-row');
      row.type = 'button';
      row.setAttribute('data-focus-panel', key);
      row.appendChild(element('span', 'panel-row-name', name));
      row.appendChild(element('span', 'panel-row-count', String(count)));
      if (chosen === key) row.setAttribute('aria-current', 'true');
      return row;
    }

    function candidateCount() {
      return candidates ? arrayOf(candidates.sources).reduce(function (sum, source) { return sum + arrayOf(source.candidates).length; }, 0) : 0;
    }

    function renderPanel() {
      if (!side) return;
      side.textContent = '';
      if (!visible || !data) { shellApi.panelChanged(); return; }
      PLACES.forEach(function (place) { side.appendChild(panelRow(place.key, place.label, openCount(place.key))); });
      var clearedCount = clearedItems().length;
      var consideredCount = candidateCount();
      if (clearedCount > 0) side.appendChild(panelRow('cleared', 'Recently cleared', clearedCount));
      if (consideredCount > 0) side.appendChild(panelRow('considered', 'Considered', consideredCount));
      shellApi.panelChanged();
    }

    function choose(key) {
      var target;
      if (key === 'now' || key === 'today') selectTab('today');
      else if (key === 'tomorrow') selectTab('tomorrow');
      else selectTab('later');
      if (key === 'now' || key === 'today') target = document.getElementById('focus-heading-' + key);
      else if (key === 'tomorrow' || key === 'later') target = sections.querySelector('[data-focus-horizon="' + key + '"]');
      else {
        target = key === 'cleared' ? cleared : considered;
        target.open = true;
      }
      chosen = key;
      renderPanel();
      if (target) target.scrollIntoView({ block: 'start' });
      shellApi.closePanel();
    }

    if (side) {
      side.addEventListener('click', function (event) {
        var row = event.target.closest && event.target.closest('[data-focus-panel]');
        if (row) choose(row.getAttribute('data-focus-panel'));
      });
    }

    // ---------------------------------------------------------------- considered

    function candidateKey(source, candidate) { return source + '|' + String(candidate.external_id); }

    function candidateByKey(key) {
      var found = null;
      arrayOf(candidates && candidates.sources).forEach(function (source) {
        arrayOf(source.candidates).forEach(function (candidate) {
          if (!found && candidateKey(source.source, candidate) === key) found = candidate;
        });
      });
      return found;
    }

    function verdictText(verdict) {
      if (!verdict || !verdict.status) return '';
      if (verdict.status === 'open') return 'On the board · ' + (PLACE_LABELS[verdict.tier] || verdict.tier || '');
      var date = new Date(Date.parse(verdict.updated));
      var when = Number.isNaN(date.getTime()) ? '' : ' · ' + MONTHS[date.getMonth()] + ' ' + date.getDate();
      return (STATUS_NAMES[verdict.status] || verdict.status) + when;
    }

    function scannedText(iso) {
      var text = iso ? age(iso) : '';
      if (!text) return 'Never scanned';
      return text === 'just now' ? 'Scanned just now' : 'Scanned ' + text + ' ago';
    }

    function candidateRow(source, candidate) {
      var key = candidateKey(source, candidate);
      var row = element('li', 'focus-row focus-candidate');
      row.setAttribute('data-focus-candidate', key);
      row.appendChild(icon(source));
      var text = element('div', 'focus-candidate-text');
      var title = element('div', 'focus-candidate-title', candidate.title);
      title.title = candidate.title || '';
      text.appendChild(title);
      if (candidate.meta) text.appendChild(element('div', 'focus-candidate-meta', candidate.meta));
      row.appendChild(text);
      var verdict = verdictText(candidate.verdict);
      if (verdict) row.appendChild(element('span', 'focus-verdict', verdict));
      else {
        var add = element('button', 'focus-pill', 'Add');
        add.type = 'button';
        add.setAttribute('data-focus-promote', key);
        row.appendChild(add);
      }
      return row;
    }

    function renderConsidered() {
      if (!candidates) return;
      var groups = arrayOf(candidates.sources).filter(function (source) { return arrayOf(source.candidates).length > 0; });
      considered.hidden = groups.length === 0;
      consideredBody.textContent = '';
      groups.forEach(function (source) {
        consideredBody.appendChild(element('p', 'focus-candidate-group',
          (SOURCE_NAMES[source.source] || source.source) + ' · ' + scannedText(source.scanned)));
        var list = element('ul', 'focus-rows');
        source.candidates.forEach(function (candidate) { list.appendChild(candidateRow(source.source, candidate)); });
        consideredBody.appendChild(list);
      });
      if (promoting && !candidateByKey(promoting)) promoting = null;
      if (promoting) startPromote(promoting, true);
      renderPanel();
    }

    function loadCandidates() {
      var id = ++candidateSequence;
      return request('/api/focus/candidates', { method: 'GET' }).then(function (result) {
        if (id !== candidateSequence) return;
        if (result && result.status === 200 && result.body && Array.isArray(result.body.sources)) {
          candidates = result.body;
          if (visible) renderConsidered();
        }
      });
    }

    considered.addEventListener('toggle', function () {
      if (considered.open) loadCandidates();
    });

    function startPromote(key, restoring) {
      var row = consideredBody.querySelector('[data-focus-candidate="' + CSS.escape(key) + '"]');
      var candidate = candidateByKey(key);
      var title = row && row.querySelector('.focus-candidate-title');
      if (!title || !candidate) { promoting = null; return; }
      promoting = key;
      var pill = row.querySelector('.focus-pill');
      if (pill) pill.remove();
      var input = element('input', 'focus-edit');
      input.type = 'text';
      input.maxLength = 200;
      input.value = restoring && promoteValue !== null ? promoteValue : (candidate.title || '');
      input.setAttribute('aria-label', 'Title');
      title.replaceWith(input);
      input.focus();
      if (!restoring) input.select();
      input.addEventListener('input', function () { promoteValue = input.value; });
      input.addEventListener('keydown', function (event) {
        if (event.key === 'Enter') { event.preventDefault(); savePromote(key, input.value); }
        else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancelPromote(); }
      });
      // A blur cancels: this one creates a card.
      input.addEventListener('blur', function () { if (!rendering && promoting === key) cancelPromote(); });
    }

    function cancelPromote() {
      promoting = null;
      promoteValue = null;
      renderConsidered();
    }

    function savePromote(key, raw) {
      var title = raw.trim().slice(0, 200);
      var candidate = candidateByKey(key);
      promoting = null;
      promoteValue = null;
      if (!candidate || !title) { renderConsidered(); return; }
      var op = {
        op: 'add', title: title, tier: tab,
        external_id: typeof candidate.external_id === 'string' && candidate.external_id ? candidate.external_id : null,
        link: safeLink(candidate.link),
        meta: typeof candidate.meta === 'string' && candidate.meta ? candidate.meta : null,
      };
      send(op).then(function () { loadCandidates(); });
    }

    // ---------------------------------------------------------------- edits

    function cardNode(id) {
      return sections.querySelector('.focus-card[data-id="' + CSS.escape(id) + '"]');
    }

    function startEdit(id, restoring) {
      var node = cardNode(id);
      var title = node && node.querySelector('.focus-title[data-editable]');
      if (!title) { editing = null; return; }
      editing = id;
      var input = element('input', 'focus-edit');
      input.type = 'text';
      input.maxLength = 200;
      input.value = restoring && editValue !== null ? editValue : title.textContent;
      input.setAttribute('aria-label', 'Title');
      title.replaceWith(input);
      input.focus();
      if (!restoring) input.select();
      input.addEventListener('input', function () { editValue = input.value; });
      input.addEventListener('keydown', function (event) {
        if (event.key === 'Enter') { event.preventDefault(); saveEdit(id, input.value); }
        else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancelEdit(); }
      });
      input.addEventListener('blur', function () { if (!rendering && editing === id) saveEdit(id, input.value); });
    }

    function cancelEdit() {
      editing = null;
      editValue = null;
      render();
    }

    function saveEdit(id, raw) {
      var title = raw.trim().slice(0, 200);
      var item = byId(id);
      editing = null;
      editValue = null;
      if (!item || !title || title === item.title) { render(); return; }
      send({ op: 'title', id: id, title: title });
    }

    function startNote(id, restoring) {
      var node = cardNode(id);
      var body = node && node.querySelector('.focus-card-body');
      if (!body) { noting = null; return; }
      noting = id;
      var item = byId(id) || {};
      var area = element('textarea', 'focus-note-edit');
      area.maxLength = 500;
      area.rows = 2;
      area.setAttribute('aria-label', 'Note');
      area.value = restoring && noteValue !== null ? noteValue : (item.note || '');
      var existing = body.querySelector('.focus-note');
      if (existing) existing.replaceWith(area);
      else body.appendChild(area);
      area.focus();
      area.setSelectionRange(area.value.length, area.value.length);
      area.addEventListener('input', function () { noteValue = area.value; });
      area.addEventListener('click', function (event) { event.stopPropagation(); });
      area.addEventListener('keydown', function (event) {
        if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); saveNote(id, area.value); }
        else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancelNote(); }
        else if (event.key === ' ') event.stopPropagation();
      });
      area.addEventListener('blur', function () { if (!rendering && noting === id) saveNote(id, area.value); });
    }

    function cancelNote() {
      noting = null;
      noteValue = null;
      render();
    }

    // Empty text clears the note.
    function saveNote(id, raw) {
      var note = raw.trim().slice(0, 500);
      var item = byId(id);
      noting = null;
      noteValue = null;
      var current = item && item.note !== undefined && item.note !== null ? item.note : '';
      if (!item || note === current) { render(); return; }
      send({ op: 'note', id: id, note: note || null });
    }

    // ---------------------------------------------------------------- clicks

    function closeMenu() {
      if (openMenu === null) return;
      openMenu = null;
      render();
    }

    sections.addEventListener('click', function (event) {
      var target = event.target;
      if (!target.closest) return;
      var check = target.closest('[data-focus-check]');
      if (check) {
        var checked = byId(check.getAttribute('data-focus-check'));
        openMenu = null;
        if (checked) send({ op: checked.status === 'done' ? 'reopen' : 'done', id: checked.id });
        return;
      }
      var more = target.closest('[data-focus-more]');
      if (more) {
        var id = more.getAttribute('data-focus-more');
        openMenu = openMenu === id ? null : id;
        render();
        var reopened = sections.querySelector('[data-focus-more="' + CSS.escape(id) + '"]');
        if (reopened) reopened.focus();
        return;
      }
      var move = target.closest('[data-focus-move]');
      if (move) {
        var moved = byId(move.getAttribute('data-focus-id'));
        var place = move.getAttribute('data-focus-move');
        openMenu = null;
        if (!moved || placeOf(moved) === place) { render(); return; }
        send({ op: 'move', id: moved.id, place: place });
        return;
      }
      var note = target.closest('[data-focus-note]');
      if (note) {
        openMenu = null;
        noting = note.getAttribute('data-focus-note');
        noteValue = null;
        render();
        return;
      }
      var dismiss = target.closest('[data-focus-dismiss]');
      if (dismiss) {
        openMenu = null;
        send({ op: 'dismiss', id: dismiss.getAttribute('data-focus-dismiss') });
        return;
      }
      var reopen = target.closest('[data-focus-reopen]');
      if (reopen) {
        send({ op: 'reopen', id: reopen.getAttribute('data-focus-reopen') });
        return;
      }
      var promote = target.closest('[data-focus-promote]');
      if (promote) {
        startPromote(promote.getAttribute('data-focus-promote'), false);
        return;
      }
      var expand = target.closest('[data-focus-expand]');
      if (expand && !target.closest('a, button, textarea, input')) {
        var key = expand.getAttribute('data-focus-expand');
        if (expanded.has(key)) expanded.delete(key);
        else expanded.add(key);
        render();
        var again = sections.querySelector('[data-focus-expand="' + CSS.escape(key) + '"]');
        if (again && event.detail === 0) again.focus();
      }
    });

    sections.addEventListener('keydown', function (event) {
      if ((event.key === 'Enter' || event.key === ' ') && event.target.hasAttribute && event.target.hasAttribute('data-focus-expand')) {
        event.preventDefault();
        event.target.click();
      }
    });

    sections.addEventListener('dblclick', function (event) {
      var title = event.target.closest && event.target.closest('.focus-title[data-editable]');
      if (!title) return;
      var node = title.closest('.focus-card');
      if (node) startEdit(node.getAttribute('data-id'), false);
    });

    document.addEventListener('click', function (event) {
      if (openMenu !== null && !(event.target.closest && event.target.closest('.focus-menu-wrap'))) closeMenu();
    });

    board.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && openMenu !== null) {
        event.preventDefault();
        var id = openMenu;
        closeMenu();
        var toggle = sections.querySelector('[data-focus-more="' + CSS.escape(id) + '"]');
        if (toggle) toggle.focus();
      }
    });

    // ---------------------------------------------------------------- the add row

    addInput.addEventListener('input', function () { addDraft = addInput.value; });
    addInput.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') {
        addDraft = '';
        addInput.value = '';
        addInput.blur();
        return;
      }
      if (event.key !== 'Enter' || event.isComposing) return;
      event.preventDefault();
      var title = addInput.value.trim().slice(0, 200);
      if (!title || inflight) return;
      addDraft = '';
      addInput.value = '';
      send({ op: 'add', title: title });
    });

    // ---------------------------------------------------------------- drag

    var dropline = element('li', 'focus-dropline');
    dropline.setAttribute('aria-hidden', 'true');

    function openIdsOf(place) {
      return arrayOf(data && data.items).filter(function (item) { return item.status === 'open' && placeOf(item) === place; })
        .sort(order).map(function (item) { return item.id; });
    }

    function clearDrop() {
      if (dropline.parentElement) dropline.remove();
      Array.prototype.forEach.call(tabs.querySelectorAll('.focus-tab-drop'), function (button) { button.classList.remove('focus-tab-drop'); });
    }

    function markTab(button) {
      Array.prototype.forEach.call(tabs.querySelectorAll('.focus-tab-drop'), function (other) {
        if (other !== button) other.classList.remove('focus-tab-drop');
      });
      if (button) button.classList.add('focus-tab-drop');
    }

    // The line goes before the first card whose middle is below the pointer.
    function placeDropline(list, y) {
      var cards = Array.prototype.filter.call(list.querySelectorAll('.focus-card'), function (node) {
        return node.getAttribute('data-id') !== dragId;
      });
      var before = null;
      for (var i = 0; i < cards.length; i += 1) {
        var box = cards[i].getBoundingClientRect();
        if (y < box.top + box.height / 2) { before = cards[i]; break; }
      }
      if (dropline.parentElement === list && dropline.nextElementSibling === before) return;
      list.insertBefore(dropline, before);
    }

    // The list's open cards as they will read once the dragged one lands.
    function orderWithDrop(list) {
      var ids = [];
      Array.prototype.forEach.call(list.children, function (node) {
        if (node === dropline) ids.push(dragId);
        else if (node.classList.contains('focus-card') && !node.classList.contains('focus-card-done') &&
                 node.getAttribute('data-id') !== dragId) ids.push(node.getAttribute('data-id'));
      });
      if (ids.indexOf(dragId) === -1) ids.push(dragId);
      return ids;
    }

    function applyDrop(place, ids) {
      var item = byId(dragId);
      if (!item) { render(); return; }
      if (placeOf(item) === place && String(ids) === String(openIdsOf(place))) { render(); return; }
      dropping = true;
      send({ op: 'move', id: item.id, place: place, order: ids }).then(function () { dropping = false; });
    }

    board.addEventListener('dragstart', function (event) {
      var node = event.target.closest ? event.target.closest('.focus-card[draggable="true"]') : null;
      if (!node) return;
      if (event.target.closest('input, textarea')) { event.preventDefault(); return; }
      dragId = node.getAttribute('data-id');
      openMenu = null;
      editing = null;
      editValue = null;
      noting = null;
      noteValue = null;
      node.classList.add('focus-card-dragging');
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = 'move';
        try { event.dataTransfer.setData('text/plain', dragId); } catch (_error) { /* the id is kept here */ }
      }
    });

    board.addEventListener('dragover', function (event) {
      if (!dragId || !event.target.closest) return;
      var button = event.target.closest('[data-focus-tab]');
      if (button) {
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
        if (dropline.parentElement) dropline.remove();
        markTab(button);
        return;
      }
      markTab(null);
      var list = event.target.closest('ul[data-place]');
      if (!list) { if (dropline.parentElement) dropline.remove(); return; }
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
      placeDropline(list, event.clientY);
    });

    board.addEventListener('dragleave', function (event) {
      var button = event.target.closest ? event.target.closest('[data-focus-tab]') : null;
      if (button) button.classList.remove('focus-tab-drop');
    });

    board.addEventListener('drop', function (event) {
      if (!dragId || !event.target.closest) return;
      var button = event.target.closest('[data-focus-tab]');
      if (button) {
        event.preventDefault();
        // A tab is its horizon: the card goes first there and the view stays.
        var place = button.getAttribute('data-focus-tab');
        var ids = [dragId].concat(openIdsOf(place).filter(function (id) { return id !== dragId; }));
        clearDrop();
        applyDrop(place, ids);
        return;
      }
      var list = event.target.closest('ul[data-place]');
      if (!list) { clearDrop(); render(); return; }
      event.preventDefault();
      if (dropline.parentElement !== list) placeDropline(list, event.clientY);
      var ordered = orderWithDrop(list);
      // The card lands where it was let go while the request is out.
      var node = cardNode(dragId);
      if (node) list.insertBefore(node, dropline);
      clearDrop();
      applyDrop(list.getAttribute('data-place'), ordered);
    });

    board.addEventListener('dragend', function () {
      Array.prototype.forEach.call(board.querySelectorAll('.focus-card-dragging'), function (node) { node.classList.remove('focus-card-dragging'); });
      clearDrop();
      dragId = null;
      if (!dropping) render();
    });

    // ---------------------------------------------------------------- rules

    var rules = window.DashboardInstructions
      ? window.DashboardInstructions.create({
        prefix: 'focus', readPath: '/api/focus/instructions', proposePath: '/api/focus/instructions/propose',
        refusalSentence: rulesRefusal,
        openAgent: function (id) { if (visible && id) shellApi.openAgent(id); },
      })
      : null;

    function startTick() {
      if (tickTimer !== null) clearInterval(tickTimer);
      tickTimer = setInterval(function () { if (!busy()) render(); }, TICK_MS);
    }

    return {
      update: function (next, keys) {
        state = next;
        if (keys && keys.indexOf('focus') === -1) return;
        var focus = next && next.focus;
        if (!visible || !focus || focus.native !== true) return;
        // Before the first answer, show()'s own read is still out.
        if (!data && problem === null) return;
        if (focus.updated === seen && !pending) return;
        refresh();
      },
      show: function () {
        if (visible) return;
        visible = true;
        if (rules) rules.show();
        selectTab(tab);
        load();
        loadCandidates();
        startTick();
      },
      hide: function () {
        if (!visible) return;
        visible = false;
        openMenu = null;
        editing = null;
        editValue = null;
        noting = null;
        noteValue = null;
        promoting = null;
        promoteValue = null;
        chosen = null;
        pending = false;
        stopIdle();
        if (tickTimer !== null) clearInterval(tickTimer);
        tickTimer = null;
        if (side) side.textContent = '';
        if (rules) rules.hide();
      },
      // One sentence of open counts, for quick chat.
      context: function () {
        if (!data) return { view: 'focus' };
        return {
          view: 'focus',
          detail: openCount('now') + ' now, ' + openCount('today') + ' today, ' + openCount('tomorrow') + ' tomorrow, ' +
            openCount('later') + ' later.',
        };
      },
    };
  }

  window.DashboardFocus = { create: create };
}());
