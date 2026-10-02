// The Settings card at the top of Health: the default model and effort for
// every agent's turns and which agent's thread the morning brief notice
// goes to, each a select over the snapshot's `models`, the effort levels,
// and the Claude agents the registry lists. A change is sent as one PUT
// /api/settings; the saved values arrive back through the state like every
// other change, so the card never holds a value the server did not. While
// a save is in flight the selects are disabled; a refusal puts a sentence
// under the rows and the selects go back to the state's values.
//
// The shell calls create(shell) once, then update(state, keys) on every
// change (keys is null for a whole snapshot), show() when Health opens, and
// hide() when it closes. Nothing is rebuilt while off screen.
(function () {
  'use strict';

  var SAVED_MS = 3000;
  var WATCHED = ['settings', 'models', 'agents'];
  var EFFORTS = [
    { id: 'low', name: 'Low' },
    { id: 'medium', name: 'Medium' },
    { id: 'high', name: 'High' },
    { id: 'xhigh', name: 'Extra high' },
    { id: 'max', name: 'Max' },
  ];
  var CLAUDE_CODE_DEFAULT = 'Claude Code default';
  var NO_ONE = 'No one';
  var NO_TARGET = 'No agent receives the brief.';
  var SAVED = 'Saved.';
  var FILE_UNREADABLE = 'The settings file could not be read. Fix or delete it.';
  var REFUSALS = {
    no_such_agent: 'That agent is not registered.',
    settings_invalid: FILE_UNREADABLE,
  };
  var SAVE_FAILED = 'Settings could not be saved.';

  function $(id) { return document.getElementById(id); }

  function option(value, text) {
    var node = document.createElement('option');
    node.value = value;
    node.textContent = text;
    return node;
  }

  // Rebuilds a select's options, keeping the chosen value selected. The
  // empty option value stands for null.
  function fill(select, options, value) {
    while (select.firstChild) select.removeChild(select.firstChild);
    var seen = false;
    options.forEach(function (item) {
      select.appendChild(option(item.id, item.name));
      if (item.id === value) seen = true;
    });
    // A value the list does not carry (a model id typed by hand, an agent
    // since removed) stays visible as itself rather than silently moving.
    if (!seen && value) select.appendChild(option(value, value));
    select.value = value || '';
  }

  function claudeAgents(state) {
    return (state.agents || []).filter(function (agent) {
      return agent.kind === 'persona' && agent.provider === 'claude';
    });
  }

  function create(shell) {
    var card = $('settings-card');
    var selects = {
      model: $('settings-model'),
      effort: $('settings-effort'),
      brief: $('settings-brief'),
    };
    var status = $('settings-status');
    var state = null;
    var visible = false;
    var dirty = true;
    var saving = false;
    var message = null; // { text, tone: 'note' | 'bad', until? }
    var savedTimer = null;

    function settingsOf() {
      return (state && state.settings) || { ok: true, error: null, model: { default: null, effort: null }, brief: { agent: null } };
    }

    function setStatus(text, tone) {
      if (!text) {
        status.hidden = true;
        status.textContent = '';
        status.className = 'settings-status';
        return;
      }
      status.hidden = false;
      status.textContent = text;
      status.className = 'settings-status' + (tone === 'bad' ? ' is-bad' : '');
    }

    function render() {
      if (!card || !state) return;
      var settings = settingsOf();
      var models = [{ id: '', name: CLAUDE_CODE_DEFAULT }].concat((state.models || []).map(function (model) {
        return { id: model.id, name: model.name };
      }));
      var efforts = [{ id: '', name: CLAUDE_CODE_DEFAULT }].concat(EFFORTS);
      var agents = [{ id: '', name: NO_ONE }].concat(claudeAgents(state).map(function (agent) {
        return { id: agent.id, name: agent.name };
      }));
      fill(selects.model, models, settings.model.default);
      fill(selects.effort, efforts, settings.model.effort);
      fill(selects.brief, agents, settings.brief.agent);
      Object.keys(selects).forEach(function (key) { selects[key].disabled = saving; });
      if (message) setStatus(message.text, message.tone);
      else if (settings.ok === false) setStatus(FILE_UNREADABLE, 'bad');
      else if (!settings.brief.agent) setStatus(NO_TARGET, 'note');
      else setStatus(null);
      dirty = false;
    }

    function clearSaved() {
      if (savedTimer) clearTimeout(savedTimer);
      savedTimer = null;
    }

    function note(text, tone) {
      clearSaved();
      message = { text: text, tone: tone };
      if (tone === 'note') {
        savedTimer = setTimeout(function () {
          savedTimer = null;
          message = null;
          if (visible) render();
          else dirty = true;
        }, SAVED_MS);
      }
    }

    function patchFor(key, value) {
      var chosen = value === '' ? null : value;
      if (key === 'model') return { model: { default: chosen } };
      if (key === 'effort') return { model: { effort: chosen } };
      return { brief: { agent: chosen } };
    }

    function save(key, value) {
      if (saving) return;
      saving = true;
      clearSaved();
      message = null;
      render();
      fetch('/api/settings', {
        method: 'PUT',
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patchFor(key, value)),
      }).then(function (response) {
        return response.json().then(function (body) { return { ok: response.ok, body: body }; }, function () {
          return { ok: response.ok, body: null };
        });
      }, function () {
        return { ok: false, body: null };
      }).then(function (result) {
        saving = false;
        if (result.ok) {
          note(SAVED, 'note');
          // The state carries the saved values; without a stream, ask for it.
          if (!shell.isStreaming()) shell.requestState();
        } else {
          var code = result.body && result.body.error;
          note(REFUSALS[code] || SAVE_FAILED, 'bad');
        }
        if (visible) render();
        else dirty = true;
      });
    }

    Object.keys(selects).forEach(function (key) {
      if (!selects[key]) return;
      selects[key].addEventListener('change', function () {
        save(key, selects[key].value);
      });
    });

    return {
      update: function (next, keys) {
        state = next;
        if (keys && !keys.some(function (key) { return WATCHED.indexOf(key) !== -1; })) return;
        // A refusal stays until the next change; a save confirmation yields
        // to the state it caused.
        if (visible) render();
        else dirty = true;
      },
      show: function () {
        visible = true;
        if (dirty) render();
      },
      hide: function () {
        visible = false;
      },
    };
  }

  window.DashboardSettings = { create: create };
}());
