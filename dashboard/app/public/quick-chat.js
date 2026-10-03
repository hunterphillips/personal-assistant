// Quick chat: the header's Quick chat entry (and, on a phone, the menu's)
// opens a pane on the right of the current view, over it on a desk and
// across the width on a phone, without leaving the view. At its top a
// picker lists every Claude agent (registry personas whose provider is
// claude, the set Settings offers); below it is a thread view
// (thread-view.js) bound to the chosen agent, the same column the Agents
// view shows, so a message sent from either lands in the one thread. The
// default is the agent Settings names under "Quick chat talks to"; a choice
// made in the picker is remembered for the page session (sessionStorage,
// when the browser allows it) and wins while that agent is listed.
// Escape and the close button close the pane; closing keeps the thread
// where it was. While the pane shows an agent in a visible document, the
// thread view marks its reply read.
//
// The first message sent after the pane opens, or after the view under it
// changes, carries what Hunter is looking at as the send body's `context`
// (send-context.mjs), which shellApi.context() reads from the view; later
// messages carry none until the pane opens or the view changes again.
//
// The shell calls create(shellApi) once, update(state, keys) on every
// change, viewChanged() when the view under the pane changes, and
// visibility(hidden) when the tab is hidden or shown.
(function () {
  'use strict';

  var STORAGE_KEY = 'dashboard.quickChatAgent';
  var NO_AGENT = 'No Claude agent is registered.';

  function readChoice() {
    try {
      return window.sessionStorage.getItem(STORAGE_KEY);
    } catch (_error) {
      return null;
    }
  }

  function writeChoice(id) {
    try {
      window.sessionStorage.setItem(STORAGE_KEY, id);
    } catch (_error) {
      // No storage: the choice lasts while the page is open.
    }
  }

  // The route's caps (send-context.mjs): a label of 200 characters and a
  // detail of 2000; longer text is cut, never refused.
  function fit(text, max) {
    if (typeof text !== 'string') return undefined;
    var chars = Array.from(text);
    return chars.length > max ? chars.slice(0, max - 1).join('') + '\u2026' : text;
  }

  function fitContext(context) {
    if (!context || typeof context.view !== 'string') return null;
    var fitted = { view: context.view };
    var label = fit(context.label, 200);
    var detail = fit(context.detail, 2000);
    if (label) fitted.label = label;
    if (detail) fitted.detail = detail;
    return fitted;
  }

  function claudeAgents(state) {
    return ((state && state.agents) || []).filter(function (agent) {
      return agent.kind === 'persona' && agent.provider === 'claude';
    });
  }

  function create(shellApi) {
    var toggle = document.getElementById('quick-chat-toggle');
    var menuEntry = document.getElementById('quick-chat-menu-entry');
    var menuToggle = document.getElementById('app-menu-toggle');
    var pane = document.getElementById('quick-chat');
    var picker = document.getElementById('quick-chat-agent');
    var closeButton = document.getElementById('quick-chat-close');
    var empty = document.getElementById('quick-chat-empty');
    var mount = document.getElementById('quick-chat-thread');
    if (!toggle || !pane || !window.DashboardThreadView) return null;

    var state = null;
    var choice = readChoice(); // the picker's last choice, or null
    var shownId = null; // the agent the thread view is bound to
    var pickerKey = null; // what the picker was last built from
    var contextPending = false; // the next send carries the view's context
    var opener = toggle;

    var thread = window.DashboardThreadView.create(mount, {
      prefix: 'quick-chat',
      shell: shellApi,
      back: false,
      onOpenAgent: function (id) {
        close(false);
        shellApi.openAgent(id);
      },
      decorate: function (body) {
        if (!contextPending) return body;
        var context = fitContext(shellApi.context());
        if (context) body.context = context;
        return body;
      },
      onSent: function () {
        contextPending = false;
      },
    });

    function isOpen() {
      return !pane.hidden;
    }

    // The chosen agent while it is listed, else Settings' agent, else the
    // first Claude agent, or null when there is none.
    function agentId() {
      var agents = claudeAgents(state);
      var listed = function (id) { return !!id && agents.some(function (agent) { return agent.id === id; }); };
      if (listed(choice)) return choice;
      var settings = state && state.settings && state.settings.quickChat ? state.settings.quickChat.agent : null;
      if (listed(settings)) return settings;
      return agents.length > 0 ? agents[0].id : null;
    }

    function renderPicker(id) {
      var agents = claudeAgents(state);
      var key = JSON.stringify([id, agents.map(function (agent) { return [agent.id, agent.name]; })]);
      if (key === pickerKey) return;
      pickerKey = key;
      picker.textContent = '';
      agents.forEach(function (agent) {
        var option = document.createElement('option');
        option.value = agent.id;
        option.textContent = agent.name;
        picker.appendChild(option);
      });
      picker.value = id || '';
    }

    function render() {
      if (!state) return;
      var id = agentId();
      renderPicker(id);
      picker.hidden = !id;
      empty.textContent = id ? '' : NO_AGENT;
      empty.hidden = !!id;
      mount.hidden = !id;
      if (id !== shownId) {
        shownId = id;
        thread.select(id);
      }
    }

    function open(from) {
      opener = from || toggle;
      contextPending = true;
      pane.hidden = false;
      toggle.setAttribute('aria-expanded', 'true');
      render();
      if (!document.hidden) thread.show();
      thread.focusInput();
      if (document.activeElement === document.body || !pane.contains(document.activeElement)) picker.focus();
    }

    function close(restore) {
      if (!isOpen()) return;
      pane.hidden = true;
      toggle.setAttribute('aria-expanded', 'false');
      thread.hide();
      if (!restore) return;
      if (opener && opener.offsetParent !== null) opener.focus();
      else if (menuToggle) menuToggle.focus();
    }

    toggle.setAttribute('aria-controls', 'quick-chat');
    toggle.setAttribute('aria-expanded', 'false');
    toggle.addEventListener('click', function () {
      if (isOpen()) close(true);
      else open(toggle);
    });
    if (menuEntry) {
      // The menu closes itself on an entry (theme.js); the pane opens.
      menuEntry.addEventListener('click', function () {
        if (!isOpen()) open(menuToggle);
      });
    }
    closeButton.addEventListener('click', function () { close(true); });
    picker.addEventListener('change', function () {
      choice = picker.value;
      writeChoice(choice);
      render();
      thread.focusInput();
    });
    // Escape closes the pane unless something inside it (the model or @
    // picker) or another popover took the key first.
    document.addEventListener('keydown', function (event) {
      if (event.key !== 'Escape' || event.defaultPrevented || !isOpen()) return;
      event.preventDefault();
      close(true);
    });

    return {
      update: function (next, keys) {
        state = next;
        thread.update(next, keys);
        var touched = !keys || keys.some(function (key) { return key === 'agents' || key === 'settings'; });
        if (touched) render();
      },
      viewChanged: function () {
        contextPending = true;
      },
      visibility: function (hidden) {
        if (hidden) thread.hide();
        else if (isOpen()) thread.show();
      },
      isOpen: isOpen,
      open: open,
      close: close,
    };
  }

  window.DashboardQuickChat = { create: create, claudeAgents: claudeAgents, fitContext: fitContext };
}());
