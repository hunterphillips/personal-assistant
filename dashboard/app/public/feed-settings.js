// The Feed's settings sheet, beside the posts (over them on a phone), one
// mode at a time:
//
// - Settings, from the header's gear: the open feed's Instructions (note.md
//   in a text box, Save on while it differs from what was read, PUT
//   /api/feeds/:id/note) and its Sources (the active sources, incoming
//   first, then context, each a checkbox; a change is PUT /api/feeds/:id
//   { sources } at once, keeping the sources it lists that are not shown).
//   Manage sources opens the Sources mode.
// - Sources: every source with its kind and address or path (a path that
//   is not there says so), Active and "Default for new feeds" switches (PUT
//   /api/sources/:id), and Delete (a refusal names the feeds using it). Add
//   source picks a type, then shows only its fields. A newsletter's site and
//   an RSS or blog address go to POST /api/sources/discover first: a feed
//   found is saved as an RSS source; a newsletter with none asks for the
//   sender's address and is saved as an email source.
// - New feed, from the header's New feed: name and instructions, POST
//   /api/feeds; the feed then opens on its tab.
//
// create(feed, shellApi) takes feed.js's view (open, reload, current, feeds,
// onFeeds) and returns { hide }. Every text node is set with textContent.
(function () {
  'use strict';

  var NO_ANSWER = 'The dashboard did not respond.';
  var TOO_LONG = 'That is too long to save.';
  var KIND_NAMES = { rss: 'RSS', email: 'Newsletter', file: 'File', folder: 'Folder' };
  var TYPES = [
    { value: 'newsletter', label: 'Newsletter', field: 'url', fieldLabel: 'Site' },
    { value: 'rss', label: 'RSS or blog', field: 'url', fieldLabel: 'Address' },
    { value: 'file', label: 'File', field: 'path', fieldLabel: 'Path' },
    { value: 'folder', label: 'Folder', field: 'path', fieldLabel: 'Path' },
  ];
  var DETAIL_SENTENCES = {
    'url must be an http or https address': 'The address must start with http:// or https://.',
    'sender must be an email address': 'That is not an email address.',
    'path must be an absolute path': 'The path must start with /.',
  };

  function element(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function button(text, className, action) {
    var node = element('button', className || 'button', text);
    node.type = 'button';
    if (action) node.setAttribute('data-feed-settings', action);
    return node;
  }

  var uid = 0;
  function field(labelText, input) {
    var wrap = element('div', 'form-field');
    input.id = input.id || 'feed-settings-field-' + (++uid);
    var label = element('label', 'form-label', labelText);
    label.htmlFor = input.id;
    wrap.appendChild(label);
    wrap.appendChild(input);
    return wrap;
  }

  function input(type, name) {
    var node = element(type === 'textarea' ? 'textarea' : 'input', 'form-input');
    if (type !== 'textarea') node.type = type;
    node.name = name;
    node.autocomplete = 'off';
    return node;
  }

  function check(labelText, checked, role) {
    var wrap = element('label', 'form-check');
    var box = element('input');
    box.type = 'checkbox';
    box.checked = !!checked;
    if (role) box.setAttribute('role', role);
    wrap.appendChild(box);
    wrap.appendChild(document.createTextNode(labelText));
    return { wrap: wrap, box: box };
  }

  function status() {
    var node = element('p', 'form-note feed-settings-status');
    node.setAttribute('role', 'status');
    node.hidden = true;
    return node;
  }

  function say(node, text) {
    node.textContent = text || '';
    node.hidden = !text;
  }

  // "News", "News and Research", "News, Research, and Ideas".
  function names(list) {
    if (list.length < 3) return list.join(' and ');
    return list.slice(0, -1).join(', ') + ', and ' + list[list.length - 1];
  }

  function create(feed, shellApi) {
    var sheet = document.getElementById('feed-settings');
    var heading = document.getElementById('feed-settings-heading');
    var body = document.getElementById('feed-settings-body');
    var gear = document.getElementById('feed-settings-toggle');
    var newButton = document.getElementById('feed-new');
    var api = window.DashboardFeed;

    var mode = null; // 'settings' | 'sources' | 'new' while open
    var feedId = null; // the feed Settings shows
    var opener = null; // what gets focus back on close
    var sequence = 0;

    function setExpanded() {
      gear.setAttribute('aria-expanded', mode === 'settings' || mode === 'sources' ? 'true' : 'false');
      newButton.setAttribute('aria-expanded', mode === 'new' ? 'true' : 'false');
    }

    function show(next, title) {
      mode = next;
      sequence += 1;
      heading.textContent = title;
      body.textContent = '';
      sheet.hidden = false;
      sheet.setAttribute('data-mode', next);
      setExpanded();
    }

    function close(restore) {
      if (mode === null) return;
      mode = null;
      sequence += 1;
      sheet.hidden = true;
      body.textContent = '';
      setExpanded();
      if (restore && opener && !opener.hidden) opener.focus();
    }

    function focusFirst() {
      var first = body.querySelector('input:not([type="hidden"]), textarea, select, button');
      if (first) first.focus();
    }

    function sourcesPath(id) {
      return '/api/sources' + (id ? '/' + encodeURIComponent(id) : '');
    }

    function feedPath(id, rest) {
      return '/api/feeds/' + encodeURIComponent(id) + (rest ? '/' + rest : '');
    }

    function refusal(result, fallback) {
      if (!result) return NO_ANSWER;
      var answer = result.body || {};
      if (result.status === 413 || answer.error === 'note_too_large') return TOO_LONG;
      if (answer.error === 'invalid_body' && answer.detail && DETAIL_SENTENCES[answer.detail]) return DETAIL_SENTENCES[answer.detail];
      return fallback || NO_ANSWER;
    }

    // ---- Settings ----------------------------------------------------------

    function openSettings() {
      var current = feed.current();
      if (!current) return;
      feedId = current.id;
      show('settings', 'Settings');
      var turn = sequence;
      body.appendChild(element('p', 'details-name', current.name));

      var note = element('section', 'feed-settings-section');
      var noteHeading = element('h3', 'feed-settings-heading', 'Instructions');
      noteHeading.id = 'feed-settings-note-heading';
      note.appendChild(noteHeading);
      var text = input('textarea', 'note');
      text.rows = 8;
      text.setAttribute('aria-labelledby', noteHeading.id);
      text.disabled = true;
      note.appendChild(text);
      var save = button('Save', 'button button-primary', 'save-note');
      save.disabled = true;
      var noteStatus = status();
      var actions = element('div', 'form-actions');
      actions.appendChild(save);
      note.appendChild(actions);
      note.appendChild(noteStatus);
      body.appendChild(note);

      var sourcesSection = element('section', 'feed-settings-section');
      sourcesSection.appendChild(element('h3', 'feed-settings-heading', 'Sources'));
      var list = element('div', 'feed-settings-sources');
      sourcesSection.appendChild(list);
      var sourcesStatus = status();
      sourcesSection.appendChild(sourcesStatus);
      var manage = button('Manage sources', 'link-button', 'manage');
      var line = element('p', 'feed-settings-manage');
      line.appendChild(manage);
      sourcesSection.appendChild(line);
      body.appendChild(sourcesSection);

      var saved = '';
      text.addEventListener('input', function () {
        save.disabled = text.value === saved;
        say(noteStatus, '');
      });
      save.addEventListener('click', function () {
        var value = text.value;
        save.disabled = true;
        api.postJson(feedPath(feedId, 'note'), { text: value }, 'PUT').then(function (result) {
          if (turn !== sequence) return;
          if (result && result.status === 200 && result.body && typeof result.body.text === 'string') {
            saved = result.body.text;
            // Disabling Save drops its focus; the text box keeps the sheet's.
            if (document.activeElement === save || document.activeElement === document.body) text.focus();
            save.disabled = text.value === saved;
            say(noteStatus, 'Saved.');
            return;
          }
          save.disabled = false;
          say(noteStatus, refusal(result));
        });
      });

      api.request(feedPath(feedId, 'note')).then(function (result) {
        if (turn !== sequence) return;
        if (!result || result.status !== 200 || !result.body || typeof result.body.text !== 'string') {
          say(noteStatus, NO_ANSWER);
          return;
        }
        saved = result.body.text;
        text.value = saved;
        text.disabled = false;
      });
      api.request(sourcesPath()).then(function (result) {
        if (turn !== sequence) return;
        if (!result || result.status !== 200 || !result.body || !Array.isArray(result.body.sources)) {
          say(sourcesStatus, NO_ANSWER);
          return;
        }
        renderChoices(list, result.body.sources, sourcesStatus, turn);
      });
      focusFirst();
    }

    // The active sources as checkboxes, incoming then context.
    function renderChoices(list, sources, line, turn) {
      list.textContent = '';
      var current = feed.current();
      var chosen = current && current.id === feedId && Array.isArray(current.sources) ? current.sources.slice() : [];
      var active = sources.filter(function (source) { return source && source.active === true; });
      if (active.length === 0) {
        list.appendChild(element('p', 'form-note', 'There are no active sources.'));
        return;
      }
      [['incoming', 'Incoming'], ['context', 'Context']].forEach(function (group) {
        var members = active.filter(function (source) { return source.role === group[0]; });
        if (members.length === 0) return;
        var set = element('fieldset', 'form-fieldset');
        set.appendChild(element('legend', 'form-legend', group[1]));
        members.forEach(function (source) {
          var choice = check(source.name, chosen.indexOf(source.id) !== -1);
          choice.box.value = source.id;
          choice.box.setAttribute('data-source-id', source.id);
          if (source.missing) choice.wrap.appendChild(element('span', 'feed-settings-missing', ' (not there)'));
          set.appendChild(choice.wrap);
        });
        list.appendChild(set);
      });
      list.addEventListener('change', function (event) {
        var box = event.target;
        if (!box || box.type !== 'checkbox') return;
        var id = box.value;
        if (box.checked && chosen.indexOf(id) === -1) chosen.push(id);
        if (!box.checked) chosen = chosen.filter(function (entry) { return entry !== id; });
        var boxes = list.querySelectorAll('input[type="checkbox"]');
        Array.prototype.forEach.call(boxes, function (node) { node.disabled = true; });
        say(line, '');
        api.postJson(feedPath(feedId), { sources: chosen.slice() }, 'PUT').then(function (result) {
          if (turn !== sequence) return;
          Array.prototype.forEach.call(boxes, function (node) { node.disabled = false; });
          if (result && result.status === 200 && result.body && result.body.feed) {
            chosen = Array.isArray(result.body.feed.sources) ? result.body.feed.sources.slice() : chosen;
            feed.reload();
            return;
          }
          box.checked = !box.checked;
          chosen = box.checked ? chosen.concat([id]) : chosen.filter(function (entry) { return entry !== id; });
          say(line, refusal(result));
        });
      });
    }

    // ---- Sources -----------------------------------------------------------

    function openSources() {
      show('sources', 'Sources');
      var turn = sequence;
      var back = button('Back to settings', 'link-button feed-settings-back', 'back');
      body.appendChild(back);
      var list = element('ul', 'feed-sources-list');
      list.setAttribute('aria-label', 'Sources');
      body.appendChild(list);
      var line = status();
      body.appendChild(line);
      var add = button('Add source', 'button', 'add-source');
      body.appendChild(add);
      add.addEventListener('click', function () {
        add.hidden = true;
        body.appendChild(addForm(function () { openSources(); }, function () {
          add.hidden = false;
          add.focus();
        }));
      });
      api.request(sourcesPath()).then(function (result) {
        if (turn !== sequence) return;
        if (!result || result.status !== 200 || !result.body || !Array.isArray(result.body.sources)) {
          say(line, NO_ANSWER);
          return;
        }
        if (result.body.sources.length === 0) say(line, 'There are no sources yet.');
        result.body.sources.forEach(function (source) { list.appendChild(sourceRow(source, turn)); });
      });
      back.focus();
    }

    function sourceRow(source, turn) {
      var row = element('li', 'feed-source');
      row.setAttribute('data-source', source.id);
      row.appendChild(element('p', 'feed-source-name', source.name));
      var address = source.kind === 'rss' ? source.url : source.kind === 'email' ? source.sender : source.path;
      var meta = element('p', 'feed-source-meta');
      meta.appendChild(element('span', 'feed-source-kind', KIND_NAMES[source.kind] || source.kind));
      meta.appendChild(element('span', 'feed-source-address', address || ''));
      row.appendChild(meta);
      if (source.missing) row.appendChild(element('p', 'feed-source-missing', 'This path is not there.'));
      var active = check('Active', source.active, 'switch');
      var fallback = check('Default for new feeds', source.default, 'switch');
      active.box.setAttribute('data-source-switch', 'active');
      fallback.box.setAttribute('data-source-switch', 'default');
      row.appendChild(active.wrap);
      row.appendChild(fallback.wrap);
      var remove = button('Delete', 'button button-small', 'delete-source');
      row.appendChild(remove);
      var line = status();
      row.appendChild(line);

      [[active.box, 'active'], [fallback.box, 'default']].forEach(function (pair) {
        pair[0].addEventListener('change', function () {
          var box = pair[0];
          var change = {};
          change[pair[1]] = box.checked;
          box.disabled = true;
          say(line, '');
          api.postJson(sourcesPath(source.id), change, 'PUT').then(function (result) {
            if (turn !== sequence) return;
            box.disabled = false;
            if (result && result.status === 200) return;
            box.checked = !box.checked;
            say(line, refusal(result));
          });
        });
      });
      remove.addEventListener('click', function () {
        remove.disabled = true;
        say(line, '');
        api.request(sourcesPath(source.id), { method: 'DELETE' }).then(function (result) {
          if (turn !== sequence) return;
          remove.disabled = false;
          if (result && result.status === 200) {
            var next = row.nextElementSibling || row.previousElementSibling;
            row.remove();
            var focusable = next ? next.querySelector('button') : body.querySelector('[data-feed-settings="add-source"]');
            if (focusable) focusable.focus();
            return;
          }
          if (result && result.status === 409 && result.body && Array.isArray(result.body.feeds)) {
            var users = result.body.feeds.map(function (id) {
              var found = feed.feeds().find(function (entry) { return entry.id === id; });
              return found ? found.name : id;
            });
            say(line, names(users) + (users.length === 1 ? ' uses' : ' use') + ' this source. Uncheck it in ' +
              (users.length === 1 ? 'that feed' : 'those feeds') + ' first.');
            return;
          }
          say(line, refusal(result));
        });
      });
      return row;
    }

    // Add source: a type, then only its fields.
    function addForm(done, cancel) {
      var form = element('form', 'details-form feed-source-form');
      form.noValidate = true;
      form.setAttribute('aria-label', 'Add source');
      var types = element('fieldset', 'form-fieldset');
      types.appendChild(element('legend', 'form-legend', 'Type'));
      TYPES.forEach(function (type, i) {
        var wrap = element('label', 'form-check');
        var radio = element('input');
        radio.type = 'radio';
        radio.name = 'source-type';
        radio.value = type.value;
        radio.checked = i === 0;
        wrap.appendChild(radio);
        wrap.appendChild(document.createTextNode(type.label));
        types.appendChild(wrap);
      });
      form.appendChild(types);
      var name = input('text', 'name');
      form.appendChild(field('Name', name));
      var address = input('url', 'address');
      address.inputMode = 'url';
      var addressField = field('Site', address);
      form.appendChild(addressField);
      var sender = input('email', 'sender');
      var senderField = field('Sender', sender);
      var senderNote = element('p', 'form-note', 'No feed was found at that site. Enter the address the newsletter comes from.');
      senderField.insertBefore(senderNote, senderField.firstChild);
      senderField.hidden = true;
      form.appendChild(senderField);
      var line = status();
      form.appendChild(line);
      var actions = element('div', 'form-actions');
      var submit = element('button', 'button button-primary', 'Save');
      submit.type = 'submit';
      actions.appendChild(submit);
      var cancelButton = button('Cancel', 'button');
      actions.appendChild(cancelButton);
      form.appendChild(actions);

      function chosen() {
        var picked = form.querySelector('input[name="source-type"]:checked');
        return TYPES.find(function (type) { return type.value === picked.value; });
      }

      types.addEventListener('change', function () {
        var type = chosen();
        addressField.querySelector('label').textContent = type.fieldLabel;
        address.type = type.field === 'path' ? 'text' : 'url';
        address.inputMode = type.field === 'path' ? 'text' : 'url';
        senderField.hidden = true;
        sender.value = '';
        say(line, '');
      });
      cancelButton.addEventListener('click', function () {
        form.remove();
        cancel();
      });

      function createSource(fields) {
        return api.postJson(sourcesPath(), fields).then(function (result) {
          if (result && result.status === 201) {
            done();
            return;
          }
          submit.disabled = false;
          say(line, refusal(result));
        });
      }

      form.addEventListener('submit', function (event) {
        event.preventDefault();
        var type = chosen();
        var label = name.value.trim();
        var where = address.value.trim();
        if (!label) return say(line, 'Enter a name.');
        if (!where) return say(line, type.field === 'path' ? 'Enter a path.' : 'Enter an address.');
        submit.disabled = true;
        say(line, '');
        if (type.field === 'path') {
          createSource({ name: label, kind: type.value, path: where });
          return;
        }
        if (!senderField.hidden) {
          createSource({ name: label, kind: 'email', sender: sender.value.trim() });
          return;
        }
        say(line, 'Looking for a feed.');
        api.postJson(sourcesPath() + '/discover', { url: where }).then(function (result) {
          if (!result || result.status !== 200 || !result.body) {
            submit.disabled = false;
            say(line, refusal(result));
            return;
          }
          if (typeof result.body.feed === 'string') {
            createSource({ name: label, kind: 'rss', url: result.body.feed });
            return;
          }
          submit.disabled = false;
          if (type.value === 'newsletter') {
            say(line, '');
            senderField.hidden = false;
            sender.focus();
            return;
          }
          say(line, 'No feed was found at that address.');
        });
      });
      setTimeout(function () { name.focus(); }, 0);
      return form;
    }

    // ---- New feed ----------------------------------------------------------

    function openNew() {
      show('new', 'New feed');
      var turn = sequence;
      var form = element('form', 'details-form');
      form.noValidate = true;
      form.setAttribute('aria-label', 'New feed');
      var name = input('text', 'name');
      form.appendChild(field('Name', name));
      var note = input('textarea', 'note');
      note.rows = 8;
      form.appendChild(field('Instructions', note));
      var line = status();
      form.appendChild(line);
      var actions = element('div', 'form-actions');
      var submit = element('button', 'button button-primary', 'Create');
      submit.type = 'submit';
      actions.appendChild(submit);
      actions.appendChild(button('Cancel', 'button', 'close'));
      form.appendChild(actions);
      body.appendChild(form);
      form.addEventListener('submit', function (event) {
        event.preventDefault();
        if (!name.value.trim()) return say(line, 'Enter a name.');
        submit.disabled = true;
        say(line, '');
        api.postJson('/api/feeds', { name: name.value, note: note.value }).then(function (result) {
          if (turn !== sequence) return;
          if (result && result.status === 201 && result.body && result.body.feed) {
            close(false);
            feed.open(result.body.feed.id);
            return;
          }
          submit.disabled = false;
          say(line, refusal(result));
        });
      });
      name.focus();
    }

    // ---- Wiring ------------------------------------------------------------

    gear.addEventListener('click', function () {
      opener = gear;
      if (mode === 'settings' || mode === 'sources') close(true);
      else openSettings();
    });
    newButton.addEventListener('click', function () {
      opener = newButton;
      if (mode === 'new') close(true);
      else openNew();
    });
    sheet.addEventListener('click', function (event) {
      var target = event.target.closest && event.target.closest('[data-feed-settings]');
      if (!target) return;
      var action = target.getAttribute('data-feed-settings');
      if (action === 'close') close(true);
      else if (action === 'manage') openSources();
      else if (action === 'back') openSettings();
    });
    sheet.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') {
        event.preventDefault();
        close(true);
      }
    });
    // The gear is there while a feed is; another tab closes the sheet.
    feed.onFeeds(function () {
      var current = feed.current();
      gear.hidden = !current;
      if ((mode === 'settings' || mode === 'sources') && (!current || current.id !== feedId)) close(false);
    });

    return {
      hide: function () { close(false); },
    };
  }

  window.DashboardFeedSettings = { create: create };
}());
