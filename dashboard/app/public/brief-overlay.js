// The brief's overlay: the morning brief as the dashboard's own page, over
// whatever view is open. The run writes brief-<date>.json (build.py); the
// daemon serves it as /api/brief/latest or /api/brief/<date> ({ state:
// 'ready', date, revision, title, words, opening, sections } or { state,
// date, error }), and this module renders it: the date and title, the
// opening, then each section's label and its items, each item's Markdown
// with Approve and Dismiss toggles and a Note under it, and at the end an
// overall note and Save. Save posts every item (POST /api/brief/feedback,
// which needs the full set) against the revision it was marked on; the
// daemon writes the Markdown the curator reads next morning and a copy this
// module reads back on the next open (GET /api/brief/<date>/feedback).
//
// DashboardBriefOverlay.create({ instructions, briefIntro }) returns
// { open(date, opener), close(restore), update(state, keys), isOpen }.
// open(null) shows the newest brief, open(date) that date's. The overlay
// scrolls on its own, closes with its Close button or Escape, and returns
// focus to what opened it; the page behind is inert while it is open. The
// Brief instructions panel (instructions.js, `instructions`) opens from the
// overlay's own bar, its intro sentence from briefIntro(). Marks not yet
// saved are kept while the page lives, so closing and reopening the same
// brief keeps them. When the snapshot names a newer brief than the one
// shown, a sentence offers to load it. Every text node is set with
// textContent or the Markdown renderer, which builds nodes the same way.
// Buttons carry data-brief-*, never data-action, which the shell's own click
// handler owns.
(function () {
  'use strict';

  var TIMEOUT_MS = 8000;
  var NO_ANSWER = 'The dashboard did not respond.';
  var EMPTY = 'No brief has been generated yet.';
  var UNREADABLE = 'The brief could not be read.';
  var CHANGED = 'The brief changed after it opened. Load the newer brief to save.';
  var NOT_SAVED = 'The feedback could not be saved.';
  var UNSAVED = 'You have changes that are not saved.';
  var MARKS = { approved: 'Approve', dismissed: 'Dismiss' };

  function element(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function isDate(value) {
    return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
  }

  // "Saturday, October 3" for a YYYY-MM-DD, as a local calendar day.
  function dayWords(date) {
    var match = isDate(date) ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(date) : null;
    if (!match) return '';
    var day = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    var options = { weekday: 'long', month: 'long', day: 'numeric' };
    if (day.getFullYear() !== new Date().getFullYear()) options.year = 'numeric';
    return day.toLocaleDateString('en-US', options);
  }

  function savedWords(iso) {
    var time = typeof iso === 'string' ? new Date(iso) : null;
    if (!time || isNaN(time.getTime())) return '';
    var clock = time.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    if (time.toDateString() === new Date().toDateString()) return 'Saved at ' + clock + '.';
    return 'Saved ' + time.toLocaleDateString('en-US', { month: 'long', day: 'numeric' }) + ' at ' + clock + '.';
  }

  // Resolves with { status, body } or null when there was no answer in time.
  function request(path, init) {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, TIMEOUT_MS);
    init = init || {};
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

  // The brief as served, or null when it is not one the overlay can draw
  // whole. The daemon has checked the shape; this only guards the renderer.
  function readyBrief(body) {
    if (!body || body.state !== 'ready' || !isDate(body.date) || typeof body.revision !== 'string' ||
        !Array.isArray(body.sections)) return null;
    return body;
  }

  // The unavailable sentence for a body that is not ready, with its date.
  function unavailableSentence(result) {
    if (!result) return NO_ANSWER;
    var body = result.body;
    if (result.status === 200 && body && body.state === 'empty') return EMPTY;
    if (body && isDate(body.date)) return 'The brief for ' + dayWords(body.date) + ' could not be opened.';
    return result.status === 200 || result.status === 503 ? UNREADABLE : NO_ANSWER;
  }

  function create(options) {
    var overlay = document.getElementById('brief-overlay');
    var sheet = document.getElementById('brief-sheet');
    var doc = document.getElementById('brief-doc');
    var stateLine = document.getElementById('brief-state');
    var closeButton = document.getElementById('brief-close');
    var shell = document.querySelector('.shell');
    var instructions = options.instructions;

    var open = false;
    var opener = null;
    var sequence = 0;
    var shown = null; // the brief drawn: { date, revision, items: [ids] }
    var snapshotBrief = null; // the snapshot's { state, date, revision }
    // The marks for the brief drawn: { date, revision, overall, items: { id:
    // { mark, note } }, dirty, savedAt }. Kept across close and reopen.
    var draft = null;
    var saving = false;
    var saveSentence = '';

    function showState(text) {
      stateLine.textContent = text;
      stateLine.hidden = !text;
    }

    function noteId(id) {
      return 'brief-note-' + id;
    }

    function markButtons(item, id) {
      var row = element('div', 'brief-marks');
      row.setAttribute('role', 'group');
      row.setAttribute('aria-label', 'Feedback');
      Object.keys(MARKS).forEach(function (mark) {
        var button = element('button', 'brief-mark brief-mark-' + mark, MARKS[mark]);
        button.type = 'button';
        button.setAttribute('data-brief-mark', mark);
        button.setAttribute('aria-pressed', String(item.mark === mark));
        row.appendChild(button);
      });
      var noteToggle = element('button', 'brief-note-toggle', 'Note');
      noteToggle.type = 'button';
      noteToggle.setAttribute('data-brief-note', '');
      noteToggle.setAttribute('aria-controls', noteId(id));
      noteToggle.setAttribute('aria-expanded', String(!!item.note));
      row.appendChild(noteToggle);
      return row;
    }

    function itemNode(entry) {
      var value = draft.items[entry.id];
      var node = element('div', 'brief-item');
      node.setAttribute('data-brief-item', entry.id);
      if (value.mark) node.setAttribute('data-mark', value.mark);
      node.appendChild(window.DashboardMarkdown.renderInto(element('div', 'brief-text markdown'), entry.text));
      node.appendChild(markButtons(value, entry.id));
      var note = element('div', 'brief-note');
      note.id = noteId(entry.id);
      note.hidden = !value.note;
      var label = element('label', 'brief-note-label', 'Note');
      label.htmlFor = noteId(entry.id) + '-input';
      var input = element('textarea', 'composer-input brief-note-input');
      input.id = noteId(entry.id) + '-input';
      input.rows = 2;
      input.value = value.note;
      input.setAttribute('data-brief-note-input', '');
      note.appendChild(label);
      note.appendChild(input);
      node.appendChild(note);
      return node;
    }

    function renderSaveLine() {
      var line = document.getElementById('brief-saved');
      if (!line) return;
      var text = saveSentence || (draft.dirty ? UNSAVED : savedWords(draft.savedAt));
      line.textContent = text;
      line.hidden = !text;
      document.getElementById('brief-save').disabled = saving;
    }

    function renderNewer() {
      var line = document.getElementById('brief-newer');
      if (!line || !shown) return;
      var brief = snapshotBrief;
      var newer = !!brief && brief.state === 'ready' && isDate(brief.date) && typeof brief.revision === 'string' &&
        (brief.date > shown.date || (brief.date === shown.date && brief.revision !== shown.revision));
      line.hidden = !newer || !shown.latest;
    }

    function render(brief) {
      doc.textContent = '';
      var head = element('header', 'brief-head');
      head.appendChild(element('p', 'brief-date', dayWords(brief.date)));
      head.appendChild(element('h1', 'brief-title', brief.title || 'Brief'));
      doc.appendChild(head);

      var newer = element('div', 'brief-newer');
      newer.id = 'brief-newer';
      newer.setAttribute('role', 'status');
      newer.hidden = true;
      newer.appendChild(element('span', null, 'A newer brief is available.'));
      var load = element('button', 'button', 'Load newer brief');
      load.type = 'button';
      load.setAttribute('data-brief-load', '');
      newer.appendChild(load);
      doc.appendChild(newer);

      if (brief.opening) {
        var opening = element('section', 'brief-opening');
        opening.setAttribute('aria-label', 'Opening');
        opening.appendChild(itemNode(brief.opening));
        doc.appendChild(opening);
      }
      brief.sections.forEach(function (section) {
        var node = element('section', 'brief-section');
        node.setAttribute('data-brief-section', section.id);
        var heading = element('h2', 'brief-section-label', section.label);
        heading.id = 'brief-section-' + section.id;
        node.setAttribute('aria-labelledby', heading.id);
        node.appendChild(heading);
        section.items.forEach(function (entry) { node.appendChild(itemNode(entry)); });
        doc.appendChild(node);
      });

      var foot = element('footer', 'brief-foot');
      var label = element('label', 'brief-overall-label', 'Overall note');
      label.htmlFor = 'brief-overall';
      var overall = element('textarea', 'composer-input brief-overall');
      overall.id = 'brief-overall';
      overall.rows = 3;
      overall.value = draft.overall;
      var row = element('div', 'brief-save-row');
      var save = element('button', 'button button-primary', 'Save');
      save.type = 'button';
      save.id = 'brief-save';
      var saved = element('p', 'brief-saved');
      saved.id = 'brief-saved';
      saved.setAttribute('role', 'status');
      row.appendChild(save);
      row.appendChild(saved);
      foot.appendChild(label);
      foot.appendChild(overall);
      foot.appendChild(row);
      doc.appendChild(foot);

      doc.hidden = false;
      renderSaveLine();
      renderNewer();
    }

    function itemsOf(brief) {
      var list = brief.opening ? [brief.opening] : [];
      brief.sections.forEach(function (section) { list = list.concat(section.items); });
      return list;
    }

    // A fresh draft for `brief`, from the saved feedback when it has any.
    function draftFor(brief, saved) {
      var next = { date: brief.date, revision: brief.revision, overall: '', items: {}, dirty: false, savedAt: null };
      itemsOf(brief).forEach(function (entry) { next.items[entry.id] = { mark: null, note: '' }; });
      if (saved && typeof saved.savedAt === 'string' && Array.isArray(saved.items)) {
        next.savedAt = saved.savedAt;
        next.overall = typeof saved.overall === 'string' ? saved.overall : '';
        saved.items.forEach(function (item) {
          if (!item || !Object.prototype.hasOwnProperty.call(next.items, item.id)) return;
          next.items[item.id] = {
            mark: item.mark === 'approved' || item.mark === 'dismissed' ? item.mark : null,
            note: typeof item.note === 'string' ? item.note : '',
          };
        });
      }
      return next;
    }

    function load(date) {
      var current = ++sequence;
      doc.hidden = true;
      showState('');
      var path = date ? '/api/brief/' + date : '/api/brief/latest';
      request(path).then(function (result) {
        if (current !== sequence) return null;
        var brief = result && result.status === 200 ? readyBrief(result.body) : null;
        if (!brief) {
          shown = null;
          showState(unavailableSentence(result));
          return null;
        }
        return request('/api/brief/' + brief.date + '/feedback').then(function (saved) {
          if (current !== sequence) return;
          var keep = draft && draft.dirty && draft.date === brief.date && draft.revision === brief.revision;
          if (!keep) draft = draftFor(brief, saved && saved.status === 200 ? saved.body : null);
          shown = {
            date: brief.date, revision: brief.revision, latest: !date,
            ids: itemsOf(brief).map(function (entry) { return entry.id; }),
          };
          saveSentence = '';
          render(brief);
        });
      });
    }

    function markDirty() {
      draft.dirty = true;
      draft.edits = (draft.edits || 0) + 1;
      saveSentence = '';
      renderSaveLine();
    }

    function save() {
      if (saving || !shown || !draft) return;
      saving = true;
      saveSentence = '';
      renderSaveLine();
      var body = {
        date: draft.date,
        revision: draft.revision,
        overall: draft.overall,
        items: shown.ids.map(function (id) {
          return { id: id, mark: draft.items[id].mark, note: draft.items[id].note };
        }),
      };
      var sent = draft;
      var edits = draft.edits;
      request('/api/brief/feedback', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }).then(function (result) {
        saving = false;
        if (sent !== draft) return;
        if (result && result.status === 200 && result.body && result.body.saved === true) {
          // A change made while the save was out is still unsaved.
          draft.dirty = draft.edits !== edits;
          draft.savedAt = typeof result.body.savedAt === 'string' ? result.body.savedAt : new Date().toISOString();
          saveSentence = '';
        } else if (!result) {
          saveSentence = NO_ANSWER;
        } else {
          var code = result.body && typeof result.body.error === 'string' ? result.body.error : null;
          saveSentence = result.status === 409 && code === 'revision_conflict' ? CHANGED : NOT_SAVED;
        }
        renderSaveLine();
      });
    }

    function openOverlay(date, from) {
      opener = from || document.activeElement;
      if (!open) {
        open = true;
        overlay.hidden = false;
        if (shell) shell.inert = true;
        if (instructions) {
          instructions.setIntro(options.briefIntro());
          instructions.show();
        }
      }
      sheet.scrollTop = 0;
      sheet.focus();
      load(isDate(date) ? date : null);
    }

    function closeOverlay(restore) {
      if (!open) return;
      open = false;
      sequence += 1;
      if (instructions) instructions.hide();
      overlay.hidden = true;
      if (shell) shell.inert = false;
      if (restore !== false && opener && document.contains(opener) && typeof opener.focus === 'function') opener.focus();
      opener = null;
    }

    closeButton.addEventListener('click', function () { closeOverlay(true); });

    doc.addEventListener('click', function (event) {
      var target = event.target;
      if (!target.closest) return;
      if (target.closest('[data-brief-load]')) {
        load(null);
        return;
      }
      if (target.closest('#brief-save')) {
        save();
        return;
      }
      var item = target.closest('[data-brief-item]');
      if (!item || !draft) return;
      var id = item.getAttribute('data-brief-item');
      var value = draft.items[id];
      var markButton = target.closest('[data-brief-mark]');
      if (markButton) {
        var mark = markButton.getAttribute('data-brief-mark');
        value.mark = value.mark === mark ? null : mark;
        var buttons = item.querySelectorAll('[data-brief-mark]');
        for (var i = 0; i < buttons.length; i += 1) {
          buttons[i].setAttribute('aria-pressed', String(buttons[i].getAttribute('data-brief-mark') === value.mark));
        }
        if (value.mark) item.setAttribute('data-mark', value.mark);
        else item.removeAttribute('data-mark');
        markDirty();
        return;
      }
      var noteToggle = target.closest('[data-brief-note]');
      if (noteToggle) {
        var note = document.getElementById(noteId(id));
        var opening = note.hidden;
        note.hidden = !opening;
        noteToggle.setAttribute('aria-expanded', String(opening));
        if (opening) note.querySelector('textarea').focus();
      }
    });

    doc.addEventListener('input', function (event) {
      if (!draft) return;
      var target = event.target;
      if (target.id === 'brief-overall') {
        draft.overall = target.value;
        markDirty();
        return;
      }
      if (target.hasAttribute('data-brief-note-input')) {
        var item = target.closest('[data-brief-item]');
        draft.items[item.getAttribute('data-brief-item')].note = target.value;
        markDirty();
      }
    });

    document.addEventListener('keydown', function (event) {
      // The instructions panel closes itself first and marks the key handled.
      if (event.key === 'Escape' && open && !event.defaultPrevented) {
        event.preventDefault();
        closeOverlay(true);
      }
    });

    return {
      open: openOverlay,
      close: closeOverlay,
      isOpen: function () { return open; },
      update: function (state, keys) {
        if (keys && keys.indexOf('brief') === -1) return;
        snapshotBrief = state && state.brief ? state.brief : null;
        if (open) renderNewer();
      },
    };
  }

  window.DashboardBriefOverlay = { create: create };
}());
