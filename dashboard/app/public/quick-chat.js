// Quick chat: the header's Quick chat entry (and, on a phone, the menu's)
// opens a pane on the right of the current view, over it on a desk and
// across the width on a phone, without leaving the view. At its top a
// button shows the agent's avatar (avatar.js) and name; activating it opens
// a typeahead over every Claude agent (registry personas whose provider is
// claude, the set Settings offers), each row its avatar, name, and role,
// filtered by name and role, with the keys and roles of the composer's @
// picker; below it is a thread view
// (thread-view.js) bound to the chosen agent, the same column the Agents
// view shows, so a message sent from either lands in the one thread. The
// default is the agent Settings names under "Quick chat talks to"; a choice
// made in the picker is remembered for the page session (sessionStorage,
// when the browser allows it) and wins while that agent is listed.
// A pane already open when the brief's overlay opens stays open and usable:
// it sits above the overlay, outside the shell the overlay makes inert, so
// the overlay covering the header only blocks opening a new pane, not one
// already open. Escape and the close button close the pane (Escape closes
// the pane before the overlay under it); closing keeps the thread where it
// was. While the pane shows an agent in a visible document, the thread view
// marks its reply read.
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

  // The agents whose name or role holds the query, ignoring case, in the
  // order given; an empty query keeps them all.
  function matchAgents(agents, query) {
    var needle = String(query || '').trim().toLowerCase();
    if (!needle) return agents.slice();
    return agents.filter(function (agent) {
      return [agent.name, agent.role].some(function (text) {
        return typeof text === 'string' && text.toLowerCase().indexOf(needle) !== -1;
      });
    });
  }

  function create(shellApi) {
    var toggle = document.getElementById('quick-chat-toggle');
    var menuEntry = document.getElementById('quick-chat-menu-entry');
    var menuToggle = document.getElementById('app-menu-toggle');
    var pane = document.getElementById('quick-chat');
    var pickerBox = document.getElementById('quick-chat-picker');
    var picker = document.getElementById('quick-chat-agent');
    var pickerName = document.getElementById('quick-chat-agent-name');
    var pickerAvatar = document.getElementById('quick-chat-agent-avatar');
    var search = document.getElementById('quick-chat-agent-search');
    var searchMenu = document.getElementById('quick-chat-agent-menu');
    var searchList = document.getElementById('quick-chat-agent-list');
    var searchNone = document.getElementById('quick-chat-agent-none');
    var closeButton = document.getElementById('quick-chat-close');
    var empty = document.getElementById('quick-chat-empty');
    var mount = document.getElementById('quick-chat-thread');
    var header = document.querySelector('.app-header');
    if (!toggle || !pane || !window.DashboardThreadView) return null;

    var state = null;
    var choice = readChoice(); // the picker's last choice, or null
    var shownId = null; // the agent the thread view is bound to
    var finding = null; // the open search: { matches, index }, or null
    var searchKey = null; // the agents the open search was built from
    var contextPending = false; // the next send carries the view's context
    var sentView = null; // the view the last context named
    var pendingView = null; // the view the context on the send in flight names
    var opener = toggle;

    var thread = window.DashboardThreadView.create(mount, {
      prefix: 'quick-chat',
      shell: shellApi,
      back: false,
      onOpenAgent: function (id) {
        close(false);
        shellApi.openAgent(id);
      },
      // A context goes along when the pane has just opened or the view
      // changed, or when what is in front changed under an open pane (the
      // brief's overlay opened or closed).
      decorate: function (body) {
        var context = fitContext(shellApi.context());
        if (context && (contextPending || context.view !== sentView)) {
          body.context = context;
          pendingView = context.view;
        }
        return body;
      },
      onSent: function () {
        contextPending = false;
        if (pendingView) sentView = pendingView;
        pendingView = null;
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

    function agentOf(id) {
      var agents = claudeAgents(state);
      for (var i = 0; i < agents.length; i += 1) if (agents[i].id === id) return agents[i];
      return null;
    }

    // The chosen agent's avatar (avatar.js) before its name on the button.
    function renderButton(id) {
      var agent = agentOf(id);
      pickerName.textContent = agent ? agent.name : '';
      pickerAvatar.hidden = !agent;
      if (!agent) return;
      if (pickerAvatar.firstChild) window.DashboardAvatar.update(pickerAvatar.firstChild, agent);
      else pickerAvatar.appendChild(window.DashboardAvatar.node(agent, 'large'));
    }

    function listKey(agents) {
      return JSON.stringify(agents.map(function (agent) { return [agent.id, agent.name, agent.role, agent.avatar]; }));
    }

    // The search lists the agents matching what is typed; the active row
    // stays on the agent it was on while that agent still matches.
    function filterSearch(keepId) {
      var agents = claudeAgents(state);
      searchKey = listKey(agents);
      var matches = matchAgents(agents, search.value);
      var index = 0;
      for (var i = 0; i < matches.length; i += 1) if (matches[i].id === keepId) index = i;
      finding = { matches: matches, index: index };
      renderSearch();
    }

    function renderSearch() {
      var roleChip = window.DashboardAgents && window.DashboardAgents.roleChip;
      searchList.textContent = '';
      finding.matches.forEach(function (agent, i) {
        var option = document.createElement('button');
        option.type = 'button';
        option.className = 'mention-option';
        option.id = 'quick-chat-option-' + agent.id;
        option.tabIndex = -1;
        option.setAttribute('role', 'option');
        option.setAttribute('data-agent', agent.id);
        option.setAttribute('aria-selected', i === finding.index ? 'true' : 'false');
        option.appendChild(window.DashboardAvatar.node(agent, 'small'));
        var name = document.createElement('span');
        name.className = 'mention-option-name';
        name.textContent = agent.name;
        option.appendChild(name);
        if (roleChip ? roleChip(agent) : !!agent.role) {
          var role = document.createElement('span');
          role.className = 'role-chip';
          role.textContent = agent.role;
          option.appendChild(role);
        }
        searchList.appendChild(option);
      });
      var active = finding.matches[finding.index];
      searchNone.hidden = !!active;
      if (active) {
        search.setAttribute('aria-activedescendant', 'quick-chat-option-' + active.id);
        var row = document.getElementById('quick-chat-option-' + active.id);
        if (row && row.scrollIntoView) row.scrollIntoView({ block: 'nearest' });
      } else {
        search.removeAttribute('aria-activedescendant');
      }
    }

    function openSearch() {
      search.value = '';
      picker.hidden = true;
      search.hidden = false;
      searchMenu.hidden = false;
      picker.setAttribute('aria-expanded', 'true');
      search.setAttribute('aria-expanded', 'true');
      filterSearch(shownId);
      search.focus();
    }

    // Closing hands the focus back to the button when the keyboard asked
    // (Escape); a choice sends it to the composer instead.
    function closeSearch(restore) {
      if (!finding) return;
      finding = null;
      searchKey = null;
      searchMenu.hidden = true;
      searchList.textContent = '';
      search.hidden = true;
      search.setAttribute('aria-expanded', 'false');
      search.removeAttribute('aria-activedescendant');
      picker.hidden = false;
      picker.setAttribute('aria-expanded', 'false');
      if (restore) picker.focus();
    }

    function choose(agent) {
      if (!agent) return;
      closeSearch(false);
      choice = agent.id;
      writeChoice(choice);
      render();
      thread.focusInput();
    }

    function render() {
      if (!state) return;
      var id = agentId();
      renderButton(id);
      // An open search is rebuilt only when the agents it lists change, so
      // a status snapshot leaves its rows and scroll alone.
      if (finding && id && listKey(claudeAgents(state)) !== searchKey) filterSearch(finding.matches[finding.index] ? finding.matches[finding.index].id : id);
      if (!id && finding) {
        var focused = document.activeElement === search;
        closeSearch(false);
        if (focused) closeButton.focus();
      }
      pickerBox.hidden = !id;
      empty.textContent = id ? '' : NO_AGENT;
      empty.hidden = !!id;
      mount.hidden = !id;
      if (id !== shownId) {
        shownId = id;
        thread.select(id);
      }
    }

    // The pane starts under the header, whose height differs on a phone.
    function place() {
      if (header) pane.style.top = Math.round(header.getBoundingClientRect().bottom) + 'px';
    }

    function open(from) {
      opener = from || toggle;
      contextPending = true;
      place();
      pane.hidden = false;
      toggle.setAttribute('aria-expanded', 'true');
      render();
      if (!document.hidden) thread.show();
      thread.focusInput();
      if (document.activeElement === document.body || !pane.contains(document.activeElement)) picker.focus();
    }

    function close(restore) {
      if (!isOpen()) return;
      closeSearch(false);
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
    window.addEventListener('resize', function () { if (isOpen()) place(); });
    closeButton.addEventListener('click', function () { close(true); });
    picker.addEventListener('click', openSearch);
    search.addEventListener('input', function () {
      var active = finding && finding.matches[finding.index];
      filterSearch(active ? active.id : null);
    });
    search.addEventListener('keydown', function (event) {
      if (event.isComposing || !finding) return;
      var count = finding.matches.length;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (count === 0) return;
        finding.index = (finding.index + (event.key === 'ArrowDown' ? 1 : -1) + count) % count;
        renderSearch();
      } else if (event.key === 'Enter') {
        event.preventDefault();
        choose(finding.matches[finding.index]);
      } else if (event.key === 'Escape') {
        // Taken here, so the pane stays open (the listener below).
        event.preventDefault();
        closeSearch(true);
      }
    });
    // A press on a row keeps the focus in the field (mousedown below), so
    // a blur means the keyboard or a tap went somewhere else.
    search.addEventListener('blur', function () { closeSearch(false); });
    searchMenu.addEventListener('mousedown', function (event) { event.preventDefault(); });
    searchList.addEventListener('click', function (event) {
      var option = event.target.closest('[role="option"]');
      if (!option || !finding) return;
      var id = option.getAttribute('data-agent');
      choose(finding.matches.filter(function (agent) { return agent.id === id; })[0]);
    });
    // Escape closes the pane unless something inside it (the model, @, or
    // agent picker) or another popover took the key first.
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

  window.DashboardQuickChat = { create: create, claudeAgents: claudeAgents, matchAgents: matchAgents, fitContext: fitContext };
}());
