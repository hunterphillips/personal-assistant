// Agents view, the page at `/`: the registry's agents as a list grouped
// Work and Personal, and beside it either one persona's thread or, with no
// agent open, a sentence asking for one. The shell calls create({ requestState,
// isStreaming }) once, then update(state, keys) on every change
// (keys is null for a whole snapshot), show() when the view opens, and
// hide() when it closes or the tab is hidden. The list is rebuilt only
// while the view is shown; show() renders the latest state.
//
// The open agent is `?agent=<id>` in the URL, so a reload lands on the same
// thread and Back and Forward move between threads. Choosing a row pushes
// that URL; the shell's popstate handler calls show(), which reads it back.
// On a phone the list comes first and fills the width until a row is chosen.
// The launchd jobs, the registry error, and what is off (the Codex server,
// cmux) are on the Health view (jobs.js); this view says only what
// each row needs.
//
// A gear in the thread header, for every agent but a coding session, opens
// the agent's settings from the registry in a panel beside the thread (a
// sheet over it on a phone), with one line counting the agent's jobs and
// linking to Health. The panel's open state lasts for the page's life: it
// stays open as other agents are chosen, and a reload starts closed. For a
// persona the panel is a form (name, role, group or a new group, description,
// folder, model and effort, who may message it, pinned) that PUTs
// /api/agents/<id>/settings; Save is off until a field changed, and a refusal
// lists the validator's problems under the form. A project or system entry
// stays read-only. "New agent" at the foot of the list opens the same form
// empty, with an id slugged from the name, and POSTs /api/agents; the new
// agent's thread opens once it is listed.
//
// At the panel's foot, any persona the registry does not mark `builtin`
// offers Delete. It asks inline with one sentence naming what goes (the
// registry entry, its routines and their runs; the thread stays on disk)
// and where the brief or quick chat moves when Settings names this agent,
// then sends DELETE /api/agents/<id>; a refusal is one sentence under it.
//
// Under a persona's settings the panel lists its routines (the snapshot's
// `routines`): each row's name, schedule in words, and last run. A row or
// "Add routine" swaps the panel to the routine form (Name, Instruction,
// When as a picker of cadence and time, Active), which POSTs or PUTs
// /api/routines; a saved routine's form also offers Test run, Delete with
// an inline confirm, and its last runs from /api/routines/<id>/runs. A
// collapsed Routines section at the foot of the list shows every routine
// under its agent, each row opening that agent's panel on it. A persona
// whose routine last ended waiting shows "Needs you" on its row until
// Hunter writes in its thread.
//
// The thread column itself (messages, the question or approval card, the
// status line, the composer, drafts, and marking a reply read) is a thread
// view (thread-view.js) mounted in #agent-thread-main; quick chat mounts a
// second one. This file keeps the pure helpers both use, including the
// message renderer, and passes them on as DashboardAgents.shared.
//
// The snapshot's coding sessions (Codex threads and Claude terminals in
// cmux) are rows too, each under the project row the hub named in its
// `projectId`, or under "Other sessions" after the groups. A session's id
// (`codex:<thread>` or `claude:<cmux session>`) goes in `?agent=` like an
// agent's. A Codex session opens the same pane, read and answered through
// the session routes, with no composer: its messages are typed in the
// terminal. A Claude terminal has nothing to read, so its pane is its
// state. Both offer "Open terminal", which posts to the
// session's open-terminal route and is off, with the reason under it,
// unless the session's terminal is bound, still open, and cmux answers.
(function () {
  'use strict';

  var PINNED = 'pinned';
  var PROVIDERS = { claude: 'Claude', codex: 'Codex' };
  var WATCHED = ['agents', 'groups', 'registry', 'sessions', 'codex', 'cmux', 'settings', 'routines'];
  var EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
  var EFFORT_NAMES = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' };
  var PERMISSION_LEVELS = ['ask', 'auto', 'full'];
  var PERMISSION_NAMES = { ask: 'Ask', auto: 'Auto', full: 'Full access' };
  // One sentence per level, under the Permissions select, for the level in force.
  var PERMISSION_NOTES = {
    ask: 'Asks before each tool that is not already allowed.',
    auto: 'Claude decides, and asks only when it is unsure.',
    full: 'Runs every tool without asking.',
  };
  var CODE_DEFAULT = 'Claude Code default';
  var MODEL_BUSY = 'Wait for the turn to finish before changing the model.';
  var AGENT_ID = /^[a-z][a-z0-9-]{1,31}$/;
  var SESSION_ID = /^(?:codex|claude):[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
  var NO_SESSIONS = 'No coding sessions. Start the Codex server or open a terminal in cmux.';
  var TERMINAL_ONLY = 'Answer this one in the terminal.';
  var FORWARDED_NOTE = 'Asked while answering you.';
  var UNBOUND = 'This thread was not started with codex-new, so its terminal is not known.';
  var TERMINAL_CLOSED = 'That terminal is closed.';
  var TICK_MS = 60000;
  var THREAD_TIMEOUT_MS = 8000;
  var SCROLL_END_PX = 80; // this close to the end counts as reading the newest message
  var NO_ANSWER = 'The dashboard did not respond.';
  var CHOOSE = 'Choose an agent to open its thread.';
  var NEW_AGENT = 'New agent';
  var NEW_GROUP = '__new__'; // the Group select's "New group…" value
  var EVERYONE = '*'; // the Who may message list's first checkbox
  var CODEX_NOTE = 'Codex, its own settings';
  var FOLDER_NOTE = 'The folder applies when a new thread starts.';
  var NOT_WRITTEN = 'The registry could not be written.';

  // --- Routines: the picker's schedules and the words for a run ----------

  var DAY_WORDS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var PICKER_DAYS = [1, 2, 3, 4, 5, 6, 0]; // Monday first
  // The When select's cadences; `days` and `monthly` show their own field.
  var CADENCES = [
    { id: 'daily', name: 'Every day' },
    { id: 'weekdays', name: 'Weekdays' },
    { id: 'weekends', name: 'Weekends' },
    { id: 'days', name: 'Every week on…' },
    { id: 'hourly', name: 'Every hour' },
    { id: 'minutes', name: 'Every 30 minutes' },
    { id: 'monthly', name: 'Every month on the…' },
  ];
  var NO_TIME_CADENCES = { hourly: true, minutes: true };
  // A run's outcome as a chip: its text and tone.
  var OUTCOME_CHIPS = {
    finished: { text: 'Finished', tone: '' },
    waiting: { text: 'Waiting for you', tone: 'wait' },
    failed: { text: 'Failed', tone: 'bad' },
    busy: { text: 'Skipped', tone: 'muted' },
    interrupted: { text: 'Interrupted', tone: 'bad' },
    missed: { text: 'Missed', tone: 'bad' },
    running: { text: 'Running', tone: 'muted' },
  };
  var NO_ROUTINES = 'No routines yet.';
  var NO_ROUTINES_ANYWHERE = 'No agent has a routine yet.';
  var NOT_RUN_YET = 'This routine has not run yet.';
  var PICK_DAYS = 'Choose at least one day.';
  var PICK_TIME = 'Choose a time.';
  var PICK_DAY_OF_MONTH = 'Choose a day of the month from 1 to 28.';
  var NAME_MISSING = 'Give the routine a name.';
  var SCHEDULE_REPLACED = 'The saved schedule is not one the picker offers. Saving replaces it.';
  var RUNS_UNREADABLE = 'The runs could not be read.';

  function pad(n) {
    return (n < 10 ? '0' : '') + n;
  }

  // The picker's state as the five-field line the routes take. A spec is
  // { kind, hour?, minute?, days?, dom? }.
  function specToCron(spec) {
    switch (spec.kind) {
      case 'daily': return spec.minute + ' ' + spec.hour + ' * * *';
      case 'weekdays': return spec.minute + ' ' + spec.hour + ' * * 1-5';
      case 'weekends': return spec.minute + ' ' + spec.hour + ' * * 0,6';
      case 'days': return spec.minute + ' ' + spec.hour + ' * * ' + spec.days.join(',');
      case 'hourly': return '0 * * * *';
      case 'minutes': return '*/30 * * * *';
      case 'monthly': return spec.minute + ' ' + spec.hour + ' ' + spec.dom + ' * *';
      default: return '';
    }
  }

  // A stored line as the picker's state, or null when the picker cannot
  // show it (a shape only a hand-edited file would hold).
  function cronToSpec(line) {
    var f = String(line || '').trim().split(/\s+/);
    if (f.length !== 5) return null;
    var minute = f[0];
    var hour = f[1];
    var dom = f[2];
    var month = f[3];
    var dow = f[4];
    if (month !== '*') return null;
    if (hour === '*' && dom === '*' && dow === '*') {
      if (minute === '0') return { kind: 'hourly' };
      if (minute === '*/30') return { kind: 'minutes' };
      return null;
    }
    if (!/^\d{1,2}$/.test(minute) || !/^\d{1,2}$/.test(hour)) return null;
    var hh = parseInt(hour, 10);
    var mm = parseInt(minute, 10);
    if (hh > 23 || mm > 59) return null;
    if (dom !== '*') {
      if (dow !== '*' || !/^\d{1,2}$/.test(dom)) return null;
      var d = parseInt(dom, 10);
      if (d < 1 || d > 28) return null;
      return { kind: 'monthly', dom: d, hour: hh, minute: mm };
    }
    if (dow === '*') return { kind: 'daily', hour: hh, minute: mm };
    if (dow === '1-5') return { kind: 'weekdays', hour: hh, minute: mm };
    if (dow === '0,6') return { kind: 'weekends', hour: hh, minute: mm };
    var days = [];
    var parts = dow.split(',');
    for (var i = 0; i < parts.length; i += 1) {
      var range = /^([0-6])-([0-6])$/.exec(parts[i]);
      if (range) {
        for (var r = parseInt(range[1], 10); r <= parseInt(range[2], 10); r += 1) if (days.indexOf(r) === -1) days.push(r);
        continue;
      }
      if (!/^[0-6]$/.test(parts[i])) return null;
      var n = parseInt(parts[i], 10);
      if (days.indexOf(n) === -1) days.push(n);
    }
    if (days.length === 0) return null;
    days.sort();
    return { kind: 'days', days: days, hour: hh, minute: mm };
  }

  // A local calendar day as a key, for "today" and "tomorrow".
  function localDay(date) {
    return Math.floor((date.getTime() - date.getTimezoneOffset() * 60000) / 86400000);
  }

  // "Next at 6:30 tomorrow" for the next occurrence, or '' for none.
  function nextWords(iso, now) {
    var time = typeof iso === 'string' ? Date.parse(iso) : NaN;
    if (isNaN(time)) return '';
    var date = new Date(time);
    var clock = date.getHours() + ':' + pad(date.getMinutes());
    var days = localDay(date) - localDay(new Date(now));
    var day;
    if (days <= 0) day = 'today';
    else if (days === 1) day = 'tomorrow';
    else if (days < 7) day = 'on ' + DAY_WORDS[date.getDay()];
    else day = 'on ' + MONTH_SHORT[date.getMonth()] + ' ' + date.getDate();
    return 'Next at ' + clock + ' ' + day;
  }

  // The chip a routine's row shows: Off, Not yet run, Running, or the last
  // run's outcome.
  function routineChip(routine) {
    if (routine.active === false) return { text: 'Off', tone: 'off' };
    var last = routine.lastRun;
    if (!last) return { text: 'Not yet run', tone: 'muted' };
    return runChip(last);
  }

  function runChip(run) {
    var outcome = run.run && !run.endedAt && !run.outcome ? 'running' : run.outcome;
    return OUTCOME_CHIPS[outcome] || OUTCOME_CHIPS.finished;
  }

  // When a run happened: its scheduled time, else when it started, else
  // the end of a missed span.
  function runTime(run) {
    return run.occurrence || run.startedAt || run.to || run.endedAt || null;
  }

  // "48 seconds", "3 minutes".
  function durationWords(ms) {
    var seconds = Math.max(1, Math.round(ms / 1000));
    if (seconds < 60) return seconds === 1 ? '1 second' : seconds + ' seconds';
    var minutes = Math.round(seconds / 60);
    return minutes === 1 ? '1 minute' : minutes + ' minutes';
  }

  // One sentence under a run: what happened. `names(id)` resolves an
  // agent's name.
  function runNote(run, names) {
    var parts = [];
    if (run.trigger === 'test') parts.push('Test run.');
    else if (run.trigger === 'catchup') parts.push('Ran late, after the dashboard was down.');
    var chip = runChip(run);
    var card = null;
    var cards = Array.isArray(run.cards) ? run.cards : [];
    for (var i = 0; i < cards.length && !card; i += 1) {
      if (cards[i] && (cards[i].resolved === null || cards[i].resolved === 'expired' || cards[i].resolved === 'interrupted')) card = cards[i];
    }
    switch (chip === OUTCOME_CHIPS.running ? 'running' : run.outcome) {
      case 'finished':
        if (run.startedAt && run.endedAt) parts.push('Replied in ' + durationWords(Date.parse(run.endedAt) - Date.parse(run.startedAt)) + '.');
        break;
      case 'waiting':
        if (card && card.kind === 'question') parts.push(names(card.agent) + ' asked: ' + (card.summary || ''));
        else if (card) parts.push(names(card.agent) + ' wanted to run ' + (card.toolName || 'a tool') + '.');
        else parts.push('A card went unanswered.');
        break;
      case 'failed':
        parts.push(run.detail === 'agent_unavailable' ? 'The agent was not started.' : 'The turn failed.');
        break;
      case 'busy':
        parts.push('The agent was already working.');
        break;
      case 'interrupted':
        parts.push('The dashboard stopped during the run.');
        break;
      case 'missed':
        parts.push(run.count === 1 ? 'One fire was missed.' : (run.count || 0) + ' fires were missed.');
        break;
      case 'running':
        parts.push('Running now.');
        break;
      default:
        break;
    }
    return parts.join(' ');
  }

  // A refused routine save as a sentence.
  function routineRefusal(result, agent) {
    if (!result) return NO_ANSWER;
    var name = agent ? displayName(agent) : 'The agent';
    switch (result.code) {
      case 'invalid_schedule': return 'That schedule could not be saved. Choose when it runs and a time.';
      case 'invalid_body': return 'The routine needs a name, an instruction, and a schedule.';
      case 'no_such_agent': return 'That agent is no longer registered.';
      case 'not_an_agent': return name + ' does not take routines.';
      case 'no_such_routine': return 'That routine is gone.';
      case 'too_many_routines': return 'There is no room for another routine.';
      case 'shutting_down': return 'The dashboard is restarting.';
      case 'payload_too_large': return 'That is too long.';
      case 'routine_write_failed': return 'The routine could not be written.';
      default: return 'The routine could not be saved.';
    }
  }

  // A refused test run as a sentence.
  function testRunRefusal(result, agent) {
    if (!result) return NO_ANSWER;
    var name = agent ? displayName(agent) : 'The agent';
    switch (result.code) {
      case 'busy': return name + ' is still working. Wait for the reply.';
      case 'agent_unavailable': return name + ' is unavailable.';
      case 'no_such_routine': return 'That routine is gone.';
      case 'not_yet': return 'Test runs are not available yet.';
      case 'shutting_down': return 'The dashboard is restarting.';
      default: return 'The routine could not be run.';
    }
  }

  function element(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function button(className, text, action) {
    var node = element('button', className, text);
    node.type = 'button';
    node.setAttribute('data-agent-action', action);
    return node;
  }

  function formatTime(iso) {
    var jobs = window.DashboardJobs;
    return jobs && typeof iso === 'string' ? jobs.formatTime(iso, Date.now()) : '';
  }

  // A time span that refreshTimes() keeps current.
  function timeSpan(className, iso) {
    var node = element('span', className, formatTime(iso));
    if (typeof iso === 'string') node.setAttribute('data-at', iso);
    return node;
  }

  function refreshTimes(root) {
    var spans = root.querySelectorAll('[data-at]');
    for (var i = 0; i < spans.length; i += 1) spans[i].textContent = formatTime(spans[i].getAttribute('data-at'));
  }

  function providerName(agent) {
    var provider = agent && agent.provider;
    if (!provider) return '';
    return Object.prototype.hasOwnProperty.call(PROVIDERS, provider) ? PROVIDERS[provider] : provider;
  }

  // The heading for a group id: the registry's name when it lists the
  // group, else the id with its first letter raised ("family" -> "Family").
  function groupName(key, groupList) {
    if (!key) return '';
    for (var i = 0; i < (groupList || []).length; i += 1) if (groupList[i].id === key) return groupList[i].name;
    return key.charAt(0).toUpperCase() + key.slice(1);
  }

  // The groups to show, in order: the registry's list, then any group an
  // agent names that the list leaves out, in the order first seen.
  function groupOrder(agents, groupList) {
    var order = [];
    var seen = {};
    for (var i = 0; i < (groupList || []).length; i += 1) {
      if (!seen[groupList[i].id]) { seen[groupList[i].id] = true; order.push(groupList[i].id); }
    }
    for (var j = 0; j < (agents || []).length; j += 1) {
      var key = agents[j].group;
      if (key && !seen[key]) { seen[key] = true; order.push(key); }
    }
    return order;
  }

  function isPersona(agent) {
    return !!agent && agent.kind === 'persona';
  }

  // A row from the snapshot's sessions: a Codex thread or a Claude terminal.
  function isSession(entry) {
    return !!entry && (entry.kind === 'terminal' || typeof entry.threadId === 'string');
  }

  function isTerminal(entry) {
    return isSession(entry) && entry.kind === 'terminal';
  }

  // A persona or a Codex session: something with messages to read.
  function hasThread(entry) {
    return isPersona(entry) || (isSession(entry) && !isTerminal(entry));
  }

  function turnOpen(agent) {
    return agent.state === 'busy' || agent.state === 'waiting';
  }

  function lastSegment(cwd) {
    if (typeof cwd !== 'string') return '';
    var parts = cwd.split('/').filter(Boolean);
    return parts.length > 0 ? parts[parts.length - 1] : cwd;
  }

  // A path with the home directory as `~`.
  function shortPath(cwd, home) {
    if (typeof cwd !== 'string') return '';
    if (typeof home !== 'string' || !home) return cwd;
    if (cwd === home) return '~';
    return cwd.indexOf(home + '/') === 0 ? '~' + cwd.slice(home.length) : cwd;
  }

  // What a row or pane calls the entry: an agent's name, a Codex thread's
  // title, or the session's folder.
  // A group or agent id from a name: lowercase, runs of anything else to
  // one hyphen, none at the ends.
  function slug(text) {
    return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  }

  // The folder as typed, with a leading ~ expanded to the home folder.
  function expandPath(text, home) {
    var value = String(text || '').trim();
    if (home && (value === '~' || value.indexOf('~/') === 0)) return home + value.slice(1);
    return value;
  }

  // What the form says when a save is refused: the validator's problems
  // without their "agent N (id): " prefix, or one sentence for the code.
  function formProblems(result) {
    if (!result) return [NO_ANSWER];
    if (result.code === 'invalid_registry' && result.problems && result.problems.length > 0) {
      return result.problems.map(function (problem) { return problem.replace(/^agent \d+ \([^)]*\): /, ''); });
    }
    switch (result.code) {
      case 'duplicate_id': return ['An agent with that id exists.'];
      case 'invalid_permission': return ['That permission level is not offered.'];
      case 'registry_invalid': return ['The registry file could not be read. Fix it by hand first.'];
      case 'not_editable': return ['This entry is edited in the registry file.'];
      case 'no_such_agent': return ['That agent is no longer registered.'];
      case 'shutting_down': return ['The dashboard is restarting.'];
      case 'not_found': return ['The dashboard cannot write the registry.'];
      case 'payload_too_large': return ['That is too long.'];
      default: return [NOT_WRITTEN];
    }
  }

  function displayName(entry) {
    if (!isSession(entry)) return entry.name;
    if (!isTerminal(entry) && typeof entry.title === 'string' && entry.title) return entry.title;
    return lastSegment(entry.cwd) || 'Terminal';
  }

  // The rows under each group heading in registry order, each with the
  // sessions nested under it (newest first, as the snapshot lists them);
  // groups with no rows are left out. Pinned personas come first under no
  // heading. Sessions under no project form one more group after the
  // others.
  function groups(agents, sessions, groupList) {
    var nested = {};
    var loose = [];
    for (var s = 0; s < (sessions || []).length; s += 1) {
      var session = sessions[s];
      var projectId = session.projectId;
      var known = projectId && (agents || []).some(function (agent) { return agent.id === projectId && !agent.pinned; });
      if (!known) loose.push(session);
      else (nested[projectId] = nested[projectId] || []).push(session);
    }
    var entry = function (agent) { return { agent: agent, sessions: nested[agent.id] || [] }; };
    var result = [];
    var pinned = (agents || []).filter(function (agent) { return agent.pinned === true; });
    if (pinned.length > 0) result.push({ key: PINNED, title: null, entries: pinned.map(entry) });
    var order = groupOrder(agents, groupList);
    for (var i = 0; i < order.length; i += 1) {
      var members = (agents || []).filter(function (agent) { return agent.group === order[i] && !agent.pinned; });
      if (members.length === 0) continue;
      result.push({ key: order[i], title: groupName(order[i], groupList), entries: members.map(entry) });
    }
    if (loose.length > 0) result.push({ key: 'other', title: 'Other sessions', entries: [{ agent: null, sessions: loose }] });
    return result;
  }

  // The role chip is left out when it would only repeat the name.
  function roleChip(agent) {
    return !!agent.role && agent.role !== agent.name;
  }

  // The first pinned persona, which a desk opens when the URL names none.
  function pinnedPersona(agents) {
    for (var i = 0; i < (agents || []).length; i += 1) {
      if (agents[i].pinned === true && isPersona(agents[i])) return agents[i];
    }
    return null;
  }

  // The sentence under the list when nothing could be listed and both
  // sources are off; with one of them on, the pane says what is off.
  function sessionsSentence(state) {
    if (!state || (state.sessions || []).length > 0) return '';
    var codexOff = !!state.codex && state.codex.available === false;
    var cmuxOff = !!state.cmux && state.cmux.available === false;
    return codexOff && cmuxOff ? NO_SESSIONS : '';
  }

  // The Codex server, when it is off, as a sentence; '' while it answers.
  function codexSentence(codex) {
    if (!codex || codex.available !== false) return '';
    switch (codex.reason) {
      case 'no_server': return 'The Codex server is not running.';
      case 'disconnected': return 'The Codex server disconnected.';
      case 'ws_unavailable': return 'Codex sessions are off until npm ci runs.';
      default: return 'Codex sessions are off.';
    }
  }

  // cmux, when it cannot be reached, as a sentence; '' while it answers.
  function cmuxSentence(cmux) {
    if (!cmux || cmux.available !== false) return '';
    switch (cmux.reason) {
      case 'not_running': return 'cmux is not running.';
      case 'no_password':
      case 'auth_failed': return 'cmux refused the connection. Check the socket password.';
      default: return 'cmux is not reachable.';
    }
  }

  // The recorded terminal, when it names one: ids are null when the helper
  // ran outside cmux.
  function bound(session) {
    var binding = session && session.binding;
    return !!binding && typeof binding.workspaceId === 'string' && typeof binding.surfaceId === 'string';
  }

  // Why Open terminal is off for the session, or '' when it can be chosen.
  function terminalReason(session, state) {
    if (!bound(session)) return UNBOUND;
    var cmux = state && state.cmux;
    if (!cmux || cmux.available !== true) return cmuxSentence(cmux) || 'cmux is not reachable.';
    return session.binding.live === true ? '' : TERMINAL_CLOSED;
  }

  // A refused open-terminal as a sentence. `result` is { code, reason } or
  // null when there was no answer.
  function openRefusal(result) {
    if (!result) return NO_ANSWER;
    var reason = result.reason;
    switch (result.code) {
      case 'unbound': return UNBOUND;
      case 'terminal_closed': return TERMINAL_CLOSED;
      case 'cmux_unavailable': return cmuxSentence({ available: false, reason: reason });
      case 'focus_failed':
        if (reason === 'not_found') return TERMINAL_CLOSED;
        if (reason === 'not_running' || reason === 'no_password' || reason === 'auth_failed') return cmuxSentence({ available: false, reason: reason });
        return 'cmux could not open that terminal.';
      case 'no_such_session': return 'That session is no longer listed.';
      case 'shutting_down': return 'The dashboard is shutting down. Try again in a moment.';
      default: return 'Something went wrong on the dashboard. Try again.';
    }
  }

  // The persona's or session's lastError as a sentence the reader can act
  // on. The Claude adapter's own messages are already sentences and pass
  // through; a Codex thread's lastError is the server's text, which stays
  // in the log, so the pane says only that the turn failed.
  function errorSentence(agent) {
    var code = agent.lastError;
    switch (code) {
      case 'api_key_in_env':
        return 'The dashboard started with an API key in its environment, so personas are off. Unset it and restart the dashboard.';
      case 'start_failed':
        return 'The session file for ' + displayName(agent) + ' could not be read. Check the threads directory, then restart the dashboard.';
      case 'server_gone':
        return 'The Codex server disconnected.';
      case 'sdk_unavailable':
        return 'The Claude Agent SDK could not be loaded. Run npm ci in dashboard/app, then restart the dashboard.';
      case 'provider_unavailable':
        return providerName(agent) ? 'There is no runtime for ' + providerName(agent) + ' yet.' : 'There is no runtime for this provider yet.';
      case 'turn_timeout':
        return 'The last turn ran too long and was stopped.';
      case 'turn_failed':
      case 'error':
      case null:
      case undefined:
      case '':
        return 'The last turn failed.';
      default:
        return isSession(agent) ? 'The last turn failed.' : String(code);
    }
  }

  // Why a persona cannot take a message right now, or ''.
  function composerReason(agent) {
    if (!isPersona(agent)) return '';
    if (agent.state === 'unavailable') return agent.lastError ? errorSentence(agent) : agent.name + ' has not started yet.';
    if (agent.state === 'busy') return agent.name + ' is working. Wait for the reply or interrupt.';
    if (agent.state === 'waiting') {
      return agent.pending && agent.pending.kind === 'approval' ? 'Allow or deny the request first.' : 'Answer the question first.';
    }
    return '';
  }

  // The display name of a model id from the snapshot's table, or the id.
  function modelNameOf(id, models) {
    for (var i = 0; models && i < models.length; i += 1) {
      if (models[i].id === id) return models[i].name;
    }
    return id;
  }

  function effortNameOf(effort) {
    return EFFORT_NAMES[effort] || effort;
  }

  function permissionNameOf(level) {
    return PERMISSION_NAMES[level] || level;
  }

  // The composer button's text for a resolved { id, effort }: "Sonnet · High",
  // "Sonnet" when effort inherits at every level, "Claude Code default" when
  // both do.
  function modelButtonText(model, models) {
    if (!model) return CODE_DEFAULT;
    var name = model.id ? modelNameOf(model.id, models) : CODE_DEFAULT;
    return model.effort ? name + ' \u00b7 ' + effortNameOf(model.effort) : name;
  }

  // A refused model change as a sentence; the common refusals read the same
  // as elsewhere.
  function modelRefusal(result, agent) {
    if (result && result.code === 'busy') return MODEL_BUSY;
    if (result && result.code === 'not_supported') return displayName(agent) + ' keeps its own model settings.';
    if (result && (result.code === 'invalid_model' || result.code === 'invalid_effort')) return 'That model or effort is not offered.';
    return refusalSentence(result, agent);
  }

  // A refused or failed request as a sentence. `code` is the JSON error, or
  // null when there was no answer.
  function refusalSentence(result, agent) {
    if (!result) return NO_ANSWER;
    var name = displayName(agent);
    switch (result.code) {
      case 'busy': return name + ' is still working. Wait for the reply.';
      case 'no_such_request': return 'That request was already answered or has expired.';
      case 'shutting_down': return 'The dashboard is shutting down. Try again in a moment.';
      case 'persona_unavailable': return name + ' is unavailable.';
      case 'thread_reset_failed': return 'The thread could not be reset. Check the dashboard log.';
      case 'invalid_text': return 'Type a message first.';
      case 'payload_too_large': return 'The message is too long. Shorten it.';
      case 'invalid_answer': return 'That answer could not be sent.';
      case 'not_a_persona': return name + ' has no thread.';
      case 'invalid_agent': return 'That agent is not in the registry.';
      case 'not_supported': return TERMINAL_ONLY;
      case 'unavailable': return 'The Codex server is not connected.';
      case 'no_such_session': return 'That session is no longer listed.';
      default: return 'Something went wrong on the dashboard. Try again.';
    }
  }

  // The one-line preview under a row: the last message with its Markdown
  // markers stripped, or the description for an agent that has no thread.
  // A message another agent sent is prefixed with that agent's name, the
  // way Hunter's own are prefixed "You:"; `agents` resolves the name.
  function previewText(agent, agents) {
    if (!isPersona(agent)) return agent.description || '';
    var message = agent.lastMessage;
    if (!message || typeof message.text !== 'string') return '';
    var source = typeof message.summary === 'string' && message.summary ? message.summary : message.text;
    var text = window.DashboardMarkdown.plain(source);
    if (message.role !== 'user') return text;
    if (typeof message.from === 'string' && message.from) return agentName(agents, message.from) + ': ' + text;
    if (message.routine && typeof message.routine.name === 'string') return message.routine.name + ': ' + text;
    return 'You: ' + text;
  }

  // An agent's display name from the snapshot, or its id when unknown.
  function agentName(agents, id) {
    var list = agents || [];
    for (var i = 0; i < list.length; i += 1) {
      if (list[i] && list[i].id === id) return list[i].name || id;
    }
    return id;
  }

  // The sentence a delegation line shows, as parts: strings and
  // { agent: id, text: name } for a name that links to that agent's thread.
  // `entry` is a system message with kind 'delegation'; `names(id)` resolves
  // an id. The daemon stores the same sentence as `text`; it is the fallback
  // for a state this view does not know.
  function delegationParts(entry, names) {
    var to = typeof entry.to === 'string' ? entry.to : null;
    var from = typeof entry.from === 'string' ? entry.from : null;
    var name = to ? { agent: to, text: names(to) } : null;
    switch (entry.state) {
      case 'sent': return name ? ['Messaged ', name] : [entry.text || ''];
      case 'busy': return name ? [name, ' is busy. Try again in a moment.'] : [entry.text || ''];
      case 'waiting': return name ? [name, ' is waiting for you.'] : [entry.text || ''];
      case 'failed': return name ? [name, ' could not answer.'] : [entry.text || ''];
      case 'refused':
        switch (entry.reason) {
          case 'not_allowed': return name ? [name, ' does not accept messages from ' + (from ? names(from) : 'this agent') + '.'] : [entry.text || ''];
          case 'cycle': return name ? [name, ' is already in this exchange.'] : [entry.text || ''];
          case 'depth': return ['This exchange is already two agents deep.'];
          case 'unavailable': return name ? [name, ' is not available.'] : [entry.text || ''];
          case 'not_an_agent': return name ? [name, ' does not take messages.'] : [entry.text || ''];
          case 'unknown': return ['No agent is named ' + (to || 'that') + '.'];
          default: return [entry.text || ''];
        }
      default: return [entry.text || ''];
    }
  }

  // The ids of the agents `text` names with @: "@" then an agent's display
  // name or id as a whole token (case-insensitive, not followed by a word
  // character), the longest name winning where one is a prefix of another
  // ("@Focus scanner" is that agent, not Focus), in order of first
  // appearance, each once. Code spans and fenced blocks are skipped, as
  // the pill pass skips them. `agents` is the snapshot's list; only
  // agents with a thread (personas) count.
  function mentionIds(text, agents) {
    var names = [];
    var ids = {};
    var list = agents || [];
    for (var i = 0; i < list.length; i += 1) {
      var agent = list[i];
      if (!agent || !isPersona(agent) || typeof agent.id !== 'string' || !agent.id) continue;
      var words = [agent.id];
      if (typeof agent.name === 'string' && agent.name.trim()) words.push(agent.name.trim());
      for (var j = 0; j < words.length; j += 1) {
        var key = words[j].toLowerCase();
        if (ids[key] === undefined) {
          ids[key] = agent.id;
          names.push(words[j]);
        }
      }
    }
    if (names.length === 0 || typeof text !== 'string' || text.indexOf('@') === -1) return [];
    names.sort(function (a, b) { return b.length - a.length; });
    var escaped = names.map(function (word) { return word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); });
    var pattern = new RegExp('(^|[^\\w@])@(' + escaped.join('|') + ')(?![\\w-])', 'gi');
    var prose = text.replace(/```[\s\S]*?(```|$)/g, ' ').replace(/`[^`\n]*`/g, ' ');
    var found = [];
    var match;
    while ((match = pattern.exec(prose)) !== null) {
      var id = ids[match[2].toLowerCase()];
      if (id && found.indexOf(id) === -1) found.push(id);
    }
    return found;
  }

  // The agents the composer offers after "@": every persona but the one
  // whose thread is open, in the Agents list's order (pinned first, then
  // the groups), narrowed to those whose name, id, role, or a word of the
  // name starts with `query` (case-insensitive). An empty query offers all.
  function mentionCandidates(agents, groupList, excludeId, query) {
    var ordered = [];
    var list = groups(agents, [], groupList);
    for (var g = 0; g < list.length; g += 1) {
      for (var e = 0; e < list[g].entries.length; e += 1) {
        var agent = list[g].entries[e].agent;
        if (agent && isPersona(agent) && agent.id !== excludeId) ordered.push(agent);
      }
    }
    var q = String(query || '').trim().toLowerCase();
    if (!q) return ordered;
    return ordered.filter(function (agent) {
      var name = String(agent.name || '').toLowerCase();
      var fields = [name, String(agent.id || '').toLowerCase(), String(agent.role || '').toLowerCase()].concat(name.split(/\s+/));
      return fields.some(function (field) { return field && field.indexOf(q) === 0; });
    });
  }

  // The row's state line for a persona or a session, or null. A Codex
  // thread whose turn is open is still answerable here, so its turn wins
  // over a closed terminal; a closed terminal is all there is to say
  // about a Claude terminal.
  function stateLine(agent) {
    var closed = isSession(agent) && !!agent.binding && agent.binding.live === false;
    if (isTerminal(agent)) {
      if (closed) return { text: 'Terminal closed', tone: 'muted' };
      if (agent.state === 'waiting') return { text: 'Waiting for you', tone: 'wait' };
      return agent.state === 'busy' ? { text: 'Working', tone: 'muted' } : null;
    }
    if (!hasThread(agent)) return null;
    // A card forwarded here is answerable here, whatever the agent's own turn is doing.
    if (agent.state !== 'waiting' && isPersona(agent) && Array.isArray(agent.forwarded) && agent.forwarded.length > 0) return { text: 'Waiting for you', tone: 'wait' };
    // A routine's run left a card unanswered; the row says so until Hunter writes.
    if (agent.state === 'idle' && isPersona(agent) && agent.needsYou === true) return { text: 'Needs you', tone: 'wait' };
    if (isPersona(agent) && agent.unread === true) return { text: 'New reply', tone: 'wait' };
    switch (agent.state) {
      case 'waiting': return { text: 'Waiting for you', tone: 'wait' };
      case 'busy': return { text: 'Working', tone: 'muted' };
      case 'error': return { text: 'The last turn failed', tone: 'bad' };
      case 'unavailable': return isSession(agent) ? { text: 'Server stopped', tone: 'muted' } : { text: 'Unavailable', tone: 'muted' };
      default: return closed ? { text: 'Terminal closed', tone: 'muted' } : null;
    }
  }

  // The sentence a terminal's pane shows for its state.
  function terminalState(session) {
    if (session.binding && session.binding.live === false) return 'The terminal is closed.';
    switch (session.state) {
      case 'busy': return 'Claude is working.';
      case 'idle': return 'Claude is idle.';
      case 'waiting': return 'Claude is waiting for you.';
      default: return 'Claude has not reported its state.';
    }
  }

  // An approval's input for display: pretty JSON when it is whole, the raw
  // cut text otherwise.
  function formatInput(pending) {
    var input = typeof pending.input === 'string' ? pending.input : JSON.stringify(pending.input);
    if (pending.truncated) return input;
    try {
      return JSON.stringify(JSON.parse(input), null, 2);
    } catch (_error) {
      return input;
    }
  }

  function questionsOf(pending) {
    var input = pending && pending.input;
    return input && Array.isArray(input.questions) ? input.questions : [];
  }

  function parse(text) {
    try {
      return JSON.parse(text);
    } catch (_error) {
      return null;
    }
  }

  function agentFromUrl() {
    var id = new URLSearchParams(location.search).get('agent');
    return id && (AGENT_ID.test(id) || SESSION_ID.test(id)) ? id : null;
  }

  function agentUrl(id) {
    return id ? '/?agent=' + encodeURIComponent(id) : '/';
  }

  // The route prefix for the entry's thread, answer, and interrupt.
  function routeBase(entry) {
    return (isSession(entry) ? '/api/sessions/' : '/api/agents/') + entry.id;
  }

  // Resolves with { ok, status, code, reason, problems, note }, or null
  // when the request itself failed.
  function call(method, path, body) {
    var init = { method: method, cache: 'no-store', credentials: 'same-origin' };
    if (body !== undefined) {
      init.headers = { 'content-type': 'application/json' };
      init.body = JSON.stringify(body);
    }
    return fetch(path, init).then(function (response) {
      return response.text().then(function (text) {
        var json = parse(text);
        return {
          ok: response.ok,
          status: response.status,
          code: json && typeof json.error === 'string' ? json.error : null,
          reason: json && typeof json.reason === 'string' ? json.reason : null,
          problems: json && Array.isArray(json.problems) ? json.problems.filter(function (p) { return typeof p === 'string'; }) : [],
          note: json && typeof json.note === 'string' ? json.note : null,
        };
      }, function () {
        return { ok: response.ok, status: response.status, code: null, reason: null, problems: [], note: null };
      });
    }, function () {
      return null;
    });
  }

  function post(path, body) {
    return call('POST', path, body);
  }

  function detail(label, body) {
    var node = element('div', 'request-detail');
    node.appendChild(element('span', 'request-detail-label', label));
    node.appendChild(body);
    return node;
  }

  function detailList(items) {
    var list = element('ul');
    for (var i = 0; i < items.length; i += 1) list.appendChild(element('li', null, items[i]));
    return list;
  }

  // The view names a context line uses, by the send route's `view`.
  var CONTEXT_VIEWS = { agents: 'Agents', feed: 'Feed', brief: 'Brief', focus: 'Focus', goals: 'Goals', health: 'Health' };

  // "Sent from Health: Nightly sync", or "Sent from Focus." with no label.
  function contextSummary(entry) {
    var name = Object.prototype.hasOwnProperty.call(CONTEXT_VIEWS, entry.view) ? CONTEXT_VIEWS[entry.view] : 'the dashboard';
    return typeof entry.label === 'string' && entry.label ? 'Sent from ' + name + ': ' + entry.label : 'Sent from ' + name + '.';
  }

  // A thread's messages as nodes, shared by every thread view. `agentsOf()`
  // returns the snapshot's agents, for names and links.
  function messageRenderer(agentsOf) {
    function messageMeta(entry) {
      var meta = element('div', 'thread-message-meta');
      if (entry.truncated) meta.appendChild(element('span', null, 'Cut short. '));
      meta.appendChild(timeSpan(null, entry.at));
      return meta;
    }

    function messageNode(entry) {
      if (entry.role === 'system' && entry.kind === 'brief') return briefNode(entry);
      if (entry.role === 'system' && entry.kind === 'delegation') return delegationNode(entry);
      if (entry.role === 'system' && entry.kind === 'routine') return routineLineNode(entry);
      if (entry.role === 'system' && entry.kind === 'context') return contextNode(entry);
      if (entry.role === 'user' && typeof entry.from === 'string' && entry.from) return agentMessageNode(entry);
      if (entry.role === 'user' && entry.routine && typeof entry.routine === 'object') return routineMessageNode(entry);
      var role = entry.role === 'user' || entry.role === 'system' ? entry.role : 'assistant';
      var node = element('div', 'thread-message thread-message-' + role);
      node.appendChild(markdownNode('thread-message-text', entry.text, entry.mentions));
      node.appendChild(messageMeta(entry));
      return node;
    }

    // A message another agent sent into this thread: on the left like a
    // reply, with the sender's name above it linking to the sender's thread.
    function agentMessageNode(entry) {
      var node = element('div', 'thread-message thread-message-assistant thread-message-agent');
      node.appendChild(agentLink(entry.from, 'thread-message-from'));
      node.appendChild(markdownNode('thread-message-text', entry.text, entry.mentions));
      node.appendChild(messageMeta(entry));
      return node;
    }

    // A routine's instruction: on the right like Hunter's, with the
    // routine's name above it.
    function routineMessageNode(entry) {
      var node = element('div', 'thread-message thread-message-user thread-message-routine');
      var name = typeof entry.routine.name === 'string' && entry.routine.name ? entry.routine.name : 'routine';
      node.appendChild(element('span', 'thread-message-label', 'Routine \u00b7 ' + name));
      node.appendChild(markdownNode('thread-message-text', entry.text, entry.mentions));
      node.appendChild(messageMeta(entry));
      return node;
    }

    // The line a routine's run posts when it raises a card: centered like
    // a delegation line, opening to the card's input.
    function routineLineNode(entry) {
      var summary = typeof entry.summary === 'string' && entry.summary ? entry.summary : (entry.text || '');
      var body = typeof entry.text === 'string' && entry.text && entry.text !== summary ? entry.text : '';
      if (!body) {
        var line = element('div', 'thread-message thread-message-system thread-message-routine-line');
        line.appendChild(element('div', 'thread-message-text', summary));
        line.appendChild(messageMeta(entry));
        return line;
      }
      var node = element('div', 'thread-message thread-message-system thread-message-brief thread-message-routine-line');
      var details = element('details', 'thread-brief thread-routine');
      details.appendChild(element('summary', 'thread-brief-summary', summary));
      details.appendChild(element('pre', 'thread-brief-body thread-routine-input', body));
      node.appendChild(details);
      node.appendChild(messageMeta(entry));
      return node;
    }

    // What quick chat sent along with Hunter's message: one centered line,
    // "Sent from Health: <label>", opening to the detail the agent was
    // given. A line with no detail is the sentence alone.
    function contextNode(entry) {
      var summary = contextSummary(entry);
      var body = typeof entry.detail === 'string' ? entry.detail : '';
      if (!body) {
        var line = element('div', 'thread-message thread-message-system thread-message-context');
        line.appendChild(element('div', 'thread-message-text', summary));
        line.appendChild(messageMeta(entry));
        return line;
      }
      var node = element('div', 'thread-message thread-message-system thread-message-brief thread-message-context');
      var details = element('details', 'thread-brief thread-context');
      details.appendChild(element('summary', 'thread-brief-summary', summary));
      details.appendChild(element('pre', 'thread-brief-body thread-context-detail', body));
      node.appendChild(details);
      node.appendChild(messageMeta(entry));
      return node;
    }

    // A line about a delegation, centered like a date line. A finished one
    // opens to the reply, the way the brief notice opens to the memo.
    function delegationNode(entry) {
      var names = function (id) { return agentName(agentsOf(), id); };
      if (entry.state === 'finished') {
        var node = element('div', 'thread-message thread-message-system thread-message-brief thread-message-delegation');
        var details = element('details', 'thread-brief thread-delegation');
        var replied = typeof entry.summary === 'string' && entry.summary ? entry.summary : (entry.text || '');
        var who = typeof entry.to === 'string' && entry.to ? names(entry.to) : (typeof entry.from === 'string' && entry.from ? names(entry.from) : 'The agent');
        details.appendChild(element('summary', 'thread-brief-summary', who + ' replied: ' + window.DashboardMarkdown.plain(replied)));
        details.appendChild(markdownNode('thread-brief-body', entry.text || ''));
        node.appendChild(details);
        var meta = messageMeta(entry);
        var target = typeof entry.to === 'string' && entry.to ? entry.to : (typeof entry.from === 'string' ? entry.from : null);
        if (target) {
          meta.appendChild(document.createTextNode(' '));
          meta.appendChild(agentLink(target, 'thread-delegation-link', 'Open ' + names(target)));
        }
        node.appendChild(meta);
        return node;
      }
      var line = element('div', 'thread-message thread-message-system thread-message-delegation');
      var text = element('div', 'thread-message-text thread-delegation-text');
      var parts = delegationParts(entry, names);
      for (var i = 0; i < parts.length; i += 1) {
        var part = parts[i];
        if (typeof part === 'string') text.appendChild(document.createTextNode(part));
        else text.appendChild(agentLink(part.agent, null, part.text));
      }
      line.appendChild(text);
      line.appendChild(messageMeta(entry));
      return line;
    }

    // A link to an agent's thread by registry id, labeled with its name.
    function agentLink(id, className, label) {
      var link = element('a', className, label || agentName(agentsOf(), id));
      link.setAttribute('href', '/?agent=' + encodeURIComponent(id));
      link.setAttribute('data-agent', id);
      return link;
    }

    // A message body rendered from its Markdown (markdown.js). `mentions`,
    // when the message carries registry ids, turns their "@Name" into pills.
    function markdownNode(className, text, mentions) {
      var pills = null;
      if (Array.isArray(mentions) && mentions.length > 0) {
        pills = mentions.filter(function (id) { return typeof id === 'string' && id; }).map(function (id) {
          return { id: id, name: agentName(agentsOf(), id) };
        });
      }
      return window.DashboardMarkdown.renderInto(element('div', className + ' markdown'), text, pills ? { mentions: pills } : undefined);
    }

    // The morning brief's notice: one line that opens to the memo, and Open
    // brief, which shows that date's brief in the overlay over this view. A
    // brief that did not build is the sentence alone.
    function briefNode(entry) {
      var text = typeof entry.text === 'string' ? entry.text : '';
      if (entry.state === 'failed') {
        var line = element('div', 'thread-message thread-message-system thread-message-brief-failed');
        line.appendChild(element('div', 'thread-message-text', text));
        line.appendChild(messageMeta(entry));
        return line;
      }
      var node = element('div', 'thread-message thread-message-system thread-message-brief');
      var details = element('details', 'thread-brief');
      var line = typeof entry.summary === 'string' && entry.summary ? entry.summary : text;
      var day = briefDay(entry.date);
      details.appendChild(element('summary', 'thread-brief-summary', 'Brief' + (day ? ', ' + day : '') + ': ' + window.DashboardMarkdown.plain(line)));
      details.appendChild(markdownNode('thread-brief-body', text));
      node.appendChild(details);
      if (typeof entry.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(entry.date)) {
        var openBrief = element('button', 'button thread-brief-open', 'Open brief');
        openBrief.type = 'button';
        openBrief.setAttribute('data-agent-action', 'open-brief');
        openBrief.setAttribute('data-brief-date', entry.date);
        node.appendChild(openBrief);
      }
      node.appendChild(messageMeta(entry));
      return node;
    }

    // "Tuesday, September 30" for a notice's YYYY-MM-DD, or ''.
    function briefDay(date) {
      var match = typeof date === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(date) : null;
      if (!match) return '';
      return dayLabel(new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
    }

    function dayLabel(date) {
      var options = { weekday: 'long', month: 'long', day: 'numeric' };
      if (date.getFullYear() !== new Date().getFullYear()) options.year = 'numeric';
      return date.toLocaleDateString('en-US', options);
    }

    // The local calendar day a message was posted on, or null.
    function dayKey(entry) {
      var time = typeof entry.at === 'string' ? Date.parse(entry.at) : NaN;
      if (isNaN(time)) return null;
      var date = new Date(time);
      return [date.getFullYear(), date.getMonth(), date.getDate()].join('-');
    }

    // A date line between messages posted on different local days, and one
    // before the first message when the thread spans more than one day.
    function dayLine(entry) {
      return element('p', 'thread-day', dayLabel(new Date(Date.parse(entry.at))));
    }

    return { messageNode: messageNode, dayKey: dayKey, dayLine: dayLine };
  }

  function create(shell) {
    var view = document.getElementById('view-agents');
    var message = document.getElementById('agents-message');
    var groupsNode = document.getElementById('agents-groups');
    var empty = document.getElementById('agent-empty');
    var panel = document.getElementById('agent-panel');
    var detailsToggle = document.getElementById('agent-details-toggle');
    var details = document.getElementById('agent-details');
    var detailsName = document.getElementById('agent-details-name');
    var detailsFields = document.getElementById('agent-details-fields');
    var detailsDescription = document.getElementById('agent-details-description');
    var detailsJobs = document.getElementById('agent-details-jobs');
    var detailsForm = document.getElementById('agent-form');
    var newAgent = document.getElementById('agents-new');
    var openTerminal = document.getElementById('agent-open-terminal');
    var terminalLine = document.getElementById('agent-terminal-reason');
    var routinesNode = document.getElementById('agent-routines');
    var deleteNode = document.getElementById('agent-delete');
    var deleteAgentButton = deleteNode.querySelector('[data-agent-action="delete-agent"]');
    var deleteConfirm = document.getElementById('agent-delete-confirm');
    var deleteText = document.getElementById('agent-delete-text');
    var deleteRefusal = document.getElementById('agent-delete-refusal');
    var routinesSection = document.getElementById('agents-routines');
    var routinesSectionBody = document.getElementById('agents-routines-body');

    var state = null;
    var visible = false;
    var selectedId = null;
    var detailsOpen = false; // the settings panel is open, whichever agent is chosen
    var detailsKey = null; // what the panel was last built from
    var creating = false; // the panel holds the New agent form
    var formKey = null; // what the form was last built from
    var formTarget = null; // 'edit:<id>' or 'create', for the form that is built
    var formBaseline = null; // the form's values as built, for Save
    var formNotice = []; // problems or a note under the form, until the next edit
    var formNoticeIsNote = false;
    var idTouched = false; // the New agent id was typed, so the name stops filling it
    var wide = window.matchMedia('(min-width: 720px)');
    var busy = false; // one of the panel's or Open terminal's POSTs is out
    var terminalError = ''; // why the selected session's Open terminal was refused, or ''
    var tick = null;
    var routineForm = null; // { agentId, routineId | null } while the panel shows the routine form
    var routineNotice = []; // sentences under the routine form, until the next edit
    var routineConfirming = false; // Delete awaits confirmation
    var routinePanelKey = null; // what the panel's Routines section was last built from
    var routineFormTarget = null; // 'edit:<id>' or 'create:<agent>', for the form that is built
    var routineFormBaseline = null; // the routine form's values as built, for Save
    var routineRuns = { key: null, id: null, runs: null, loading: false, error: false }; // the open routine's last runs
    var routineRunsRendered = null;
    var routinesSectionKey = null; // what the sidebar section was last built from
    var deleteFor = null; // the agent id whose Delete awaits confirmation
    var deleteNotice = null; // { agentId, text }: why its Delete was refused
    // The thread column (thread-view.js): the messages, card, status line,
    // and composer of the open agent or session. This view owns the list,
    // the header's actions, and the settings panel beside it.
    var thread = window.DashboardThreadView.create(document.getElementById('agent-thread-main'), {
      prefix: 'agent',
      shell: shell,
      onBack: function () { select(null, true); },
      onOpenAgent: function (id) { select(id, true); },
    });

    // The open agent or session, or null.
    function selectedAgent() {
      if (!state || !selectedId) return null;
      var lists = [state.agents || [], state.sessions || []];
      for (var l = 0; l < lists.length; l += 1) {
        for (var i = 0; i < lists[l].length; i += 1) if (lists[l][i].id === selectedId) return lists[l][i];
      }
      return null;
    }

    function chip(className, text) {
      return element('span', className, text);
    }

    // A row wanting Hunter ("Waiting for you", "Needs you") shows a small
    // dot beside the name instead of the text chip; the sentence stays as
    // the dot's title and aria-label for anyone not reading color.
    function stateDot(line) {
      var dot = element('span', 'agent-row-dot agent-row-dot-' + line.tone);
      dot.setAttribute('role', 'img');
      dot.setAttribute('aria-label', line.text);
      dot.title = line.text;
      return dot;
    }

    function row(agent) {
      var persona = isPersona(agent);
      var node = persona ? element('a', 'agent-row') : element('div', 'agent-row agent-row-plain');
      if (persona) node.href = agentUrl(agent.id);
      node.setAttribute('data-agent', agent.id);
      if (agent.id === selectedId) node.setAttribute('aria-current', 'true');

      var line = stateLine(agent);
      var head = element('span', 'agent-row-head');
      head.appendChild(element('span', 'agent-row-name', agent.name));
      if (line && line.tone === 'wait') head.appendChild(stateDot(line));
      if (roleChip(agent)) head.appendChild(chip('role-chip', agent.role));
      if (providerName(agent)) head.appendChild(chip('provider-chip', providerName(agent)));
      if (persona && agent.lastMessage) head.appendChild(timeSpan('agent-row-time', agent.lastMessage.at));
      node.appendChild(head);

      var preview = previewText(agent, state.agents);
      if (preview) node.appendChild(element('span', 'agent-row-preview', preview));
      if (line && line.tone !== 'wait') node.appendChild(element('span', 'agent-row-state agent-row-state-' + line.tone, line.text));
      return node;
    }

    function sessionRow(session) {
      var node = element('a', 'agent-row agent-row-session');
      node.href = agentUrl(session.id);
      node.setAttribute('data-agent', session.id);
      if (session.id === selectedId) node.setAttribute('aria-current', 'true');

      var line = stateLine(session);
      var head = element('span', 'agent-row-head');
      head.appendChild(element('span', 'agent-row-name', displayName(session)));
      if (line && line.tone === 'wait') head.appendChild(stateDot(line));
      if (providerName(session)) head.appendChild(chip('provider-chip', providerName(session)));
      if (session.updatedAt) head.appendChild(timeSpan('agent-row-time', session.updatedAt));
      node.appendChild(head);

      var folder = shortPath(session.cwd, state.home);
      if (folder) node.appendChild(element('span', 'agent-row-preview', folder));
      if (line && line.tone !== 'wait') node.appendChild(element('span', 'agent-row-state agent-row-state-' + line.tone, line.text));
      return node;
    }

    // The sentence above the list. Health says when the registry could not
    // be read, so an empty list then claims nothing.
    function renderMessage() {
      if (!state) return;
      var registry = state.registry;
      var text = '';
      if (!(registry && registry.ok === false) && (state.agents || []).length === 0) text = 'No agents are registered.';
      message.textContent = text;
      message.hidden = !text;
    }

    function renderList() {
      if (!state) return;
      // Keep keyboard focus on the same row across the rebuild.
      var active = document.activeElement;
      var focusedId = active && groupsNode.contains(active) && active.hasAttribute('data-agent') ? active.getAttribute('data-agent') : null;
      groupsNode.textContent = '';
      renderMessage();

      var list = groups(state.agents, state.sessions, state.groups);
      for (var i = 0; i < list.length; i += 1) {
        var section = element('section', 'agent-group agent-group-' + list[i].key);
        if (list[i].title) {
          var headingId = 'agents-group-' + list[i].key;
          section.setAttribute('aria-labelledby', headingId);
          var heading = element('h2', 'agent-group-heading', list[i].title);
          heading.id = headingId;
          section.appendChild(heading);
        } else {
          section.setAttribute('aria-label', 'Pinned');
        }
        for (var j = 0; j < list[i].entries.length; j += 1) {
          var entry = list[i].entries[j];
          if (entry.agent) section.appendChild(row(entry.agent));
          for (var k = 0; k < entry.sessions.length; k += 1) section.appendChild(sessionRow(entry.sessions[k]));
        }
        groupsNode.appendChild(section);
      }
      var sentence = sessionsSentence(state);
      if (sentence) groupsNode.appendChild(element('p', 'agents-message agents-sessions-message', sentence));
      // The routines section keeps its node (and whether it is open) under
      // the groups.
      groupsNode.appendChild(routinesSection);
      newAgent.hidden = !!(state.registry && state.registry.ok === false);
      renderRoutinesSection();
      if (focusedId) {
        var again = groupsNode.querySelector('[data-agent="' + CSS.escape(focusedId) + '"]');
        if (again) again.focus();
      }
    }

    // With no agent open the pane asks for one; on a phone the pane is
    // off screen until a row is chosen.
    // The agent's registry entry as label and value pairs, each left out
    // when the registry has no value, then its description and, when it has
    // jobs, how many with a link to Health. Rebuilt only when one of them
    // changed, so the keyboard stays on the link across other state.
    // The panel: the New agent form, a persona's form, or a project's or
    // system entry's values read-only.
    function renderPanel(agent) {
      if (creating) {
        detailsKey = null;
        detailsName.textContent = NEW_AGENT;
        detailsFields.textContent = '';
        detailsFields.hidden = true;
        detailsDescription.hidden = true;
        detailsJobs.hidden = true;
        detailsForm.hidden = false;
        hideRoutinePanel();
        renderDelete(null, false);
        renderForm(null);
        return;
      }
      if (isPersona(agent)) {
        detailsKey = null;
        detailsName.textContent = agent.name;
        detailsFields.textContent = '';
        detailsFields.hidden = true;
        detailsDescription.hidden = true;
        if (routineForm && routineForm.agentId !== agent.id) resetRoutineForm();
        // Routines are for Claude agents; while a routine's form is open
        // the settings form steps aside.
        var claude = agent.provider === 'claude';
        var routineOpen = claude && !!routineForm;
        detailsForm.hidden = routineOpen;
        if (!routineOpen) {
          renderForm(agent);
          renderJobs(agent);
        } else {
          detailsJobs.hidden = true;
        }
        if (claude) renderRoutinePanel(agent);
        else hideRoutinePanel();
        renderDelete(agent, !routineOpen);
        return;
      }
      detailsForm.hidden = true;
      detailsFields.hidden = false;
      hideRoutinePanel();
      renderDelete(null, false);
      renderDetails(agent);
    }

    // --- Delete ------------------------------------------------------------

    // Who receives what Settings names this agent for, once it is gone:
    // the same rule the daemon applies (builtins.mjs defaultAgentId).
    function fallbackFor(agent) {
      var claude = ((state && state.agents) || []).filter(function (other) {
        return other.id !== agent.id && other.kind === 'persona' && other.provider === 'claude';
      });
      var pick = claude.filter(function (other) { return other.builtin === true; })[0] ||
        claude.filter(function (other) { return other.pinned === true; })[0] || claude[0] || null;
      return pick;
    }

    function deleteSentence(agent) {
      var settings = (state && state.settings) || {};
      var next = fallbackFor(agent);
      var text = 'Delete ' + agent.name + '? This removes it from the registry with its routines and their runs. Its thread stays on disk.';
      if (settings.brief && settings.brief.agent === agent.id) {
        text += next ? ' The brief will go to ' + next.name + '.' : ' No agent will receive the brief.';
      }
      if (settings.quickChat && settings.quickChat.agent === agent.id) {
        text += next ? ' Quick chat will talk to ' + next.name + '.' : ' Quick chat will have no agent.';
      }
      return text;
    }

    function deleteRefusalText(agent, result) {
      var code = result && result.code;
      if (code === 'builtin') return agent.name + ' is part of the dashboard and cannot be deleted.';
      if (code === 'busy') return agent.name + ' is in the middle of a turn. Delete it once the turn ends.';
      if (code === 'not_agent') return 'Only an agent can be deleted here.';
      if (code === 'no_such_agent') return agent.name + ' is no longer registered.';
      if (code === 'registry_invalid') return 'The registry file could not be read. Fix it by hand first.';
      if (code === 'shutting_down') return 'The dashboard is shutting down.';
      return agent.name + ' could not be deleted.';
    }

    // The foot of the panel: Delete for a persona that is not built in,
    // while its settings form shows.
    function renderDelete(agent, shown) {
      var offered = !!agent && shown && !creating && isPersona(agent) && agent.builtin !== true;
      deleteNode.hidden = !offered;
      if (!offered) return;
      var asking = deleteFor === agent.id;
      deleteAgentButton.hidden = asking;
      deleteAgentButton.disabled = busy;
      deleteConfirm.hidden = !asking;
      if (asking) deleteText.textContent = deleteSentence(agent);
      var buttons = deleteConfirm.querySelectorAll('button');
      for (var i = 0; i < buttons.length; i += 1) buttons[i].disabled = busy;
      var refusal = deleteNotice && deleteNotice.agentId === agent.id ? deleteNotice.text : '';
      deleteRefusal.textContent = refusal;
      deleteRefusal.hidden = !refusal;
    }

    function deleteAgent(agent) {
      if (busy || !isPersona(agent)) return;
      busy = true;
      deleteFor = null;
      deleteNotice = null;
      renderThread();
      call('DELETE', routeBase(agent)).then(function (result) {
        busy = false;
        var ok = !!(result && result.ok);
        if (ok) {
          if (!shell.isStreaming()) shell.requestState();
          if (selectedId === agent.id) {
            detailsOpen = false;
            select(null, true);
            return;
          }
        } else {
          deleteNotice = { agentId: agent.id, text: deleteRefusalText(agent, result) };
        }
        renderThread();
      });
    }

    function renderDetails(agent) {
      var pairs = [
        ['Role', agent.role],
        ['Group', groupName(agent.group, state.groups)],
        ['Provider', providerName(agent)],
        ['Folder', shortPath(agent.cwd, state.home)],
      ];
      var key = JSON.stringify([agent.name, pairs, agent.description, agent.jobs]);
      if (key === detailsKey) return;
      detailsKey = key;
      detailsName.textContent = agent.name;
      detailsFields.textContent = '';
      for (var i = 0; i < pairs.length; i += 1) {
        if (pairs[i][1]) detailsFields.appendChild(detail(pairs[i][0], element('span', 'request-detail-text', pairs[i][1])));
      }
      detailsDescription.textContent = agent.description || '';
      detailsDescription.hidden = !detailsDescription.textContent;
      renderJobs(agent);
    }

    function renderJobs(agent) {
      var jobs = typeof agent.jobs === 'number' ? agent.jobs : 0;
      detailsJobs.textContent = '';
      detailsJobs.hidden = jobs === 0;
      if (jobs === 0) return;
      var link = element('a', null, jobs === 1 ? '1 job' : jobs + ' jobs');
      link.href = '/health';
      detailsJobs.appendChild(document.createTextNode(agent.name + ' runs '));
      detailsJobs.appendChild(link);
      detailsJobs.appendChild(document.createTextNode('.'));
    }

    // --- The settings form -------------------------------------------------

    function control(name) {
      return detailsForm.querySelector('[name="' + name + '"]');
    }

    function formField(label, node, id) {
      var wrap = element('div', 'form-field');
      var lab = element('label', 'form-label', label);
      lab.htmlFor = id;
      node.id = id;
      wrap.appendChild(lab);
      wrap.appendChild(node);
      return wrap;
    }

    function textInput(name, value, maxLength) {
      var node = element('input', 'form-input');
      node.type = 'text';
      node.name = name;
      node.value = value || '';
      node.autocomplete = 'off';
      node.spellcheck = false;
      if (maxLength) node.maxLength = maxLength;
      return node;
    }

    function selectInput(name, options, value) {
      var node = element('select', 'form-input form-select');
      node.name = name;
      for (var i = 0; i < options.length; i += 1) {
        var option = element('option', null, options[i].name);
        option.value = options[i].id;
        if (options[i].id === value) option.selected = true;
        node.appendChild(option);
      }
      return node;
    }

    function checkbox(name, value, label, checked) {
      var wrap = element('label', 'form-check');
      var box = element('input');
      box.type = 'checkbox';
      box.name = name;
      box.value = value;
      box.checked = !!checked;
      wrap.appendChild(box);
      wrap.appendChild(document.createTextNode(label));
      return wrap;
    }

    // The registry's groups in its order, then any group an agent names that
    // the list leaves out, then "New group…".
    function groupOptions() {
      var options = [];
      var seen = {};
      var listed = state.groups || [];
      for (var i = 0; i < listed.length; i += 1) {
        if (seen[listed[i].id]) continue;
        seen[listed[i].id] = true;
        options.push({ id: listed[i].id, name: listed[i].name });
      }
      var agents = state.agents || [];
      for (var j = 0; j < agents.length; j += 1) {
        var id = agents[j].group;
        if (!id || seen[id]) continue;
        seen[id] = true;
        options.push({ id: id, name: groupName(id, listed) });
      }
      return options;
    }

    // The other personas, who could be given leave to message this one.
    function otherPersonas(agent) {
      return (state.agents || []).filter(function (other) {
        return isPersona(other) && (!agent || other.id !== agent.id);
      }).map(function (other) { return { id: other.id, name: other.name }; });
    }

    function defaultModelOption() {
      var settings = state.settings && state.settings.model ? state.settings.model : {};
      var name = settings.default ? modelNameOf(settings.default, state.models) : 'Claude Code';
      return { id: '', name: 'Default (' + name + ')' };
    }

    function defaultEffortOption() {
      var settings = state.settings && state.settings.model ? state.settings.model : {};
      var name = settings.effort ? effortNameOf(settings.effort) : 'Claude Code';
      return { id: '', name: 'Default (' + name + ')' };
    }

    // The system default level, which always has a value.
    function defaultPermission() {
      var settings = state.settings && state.settings.permission ? state.settings.permission : {};
      return settings.default || 'ask';
    }

    function defaultPermissionOption() {
      return { id: '', name: 'System default (' + permissionNameOf(defaultPermission()) + ')' };
    }

    // The sentence under the Permissions select follows the level in force:
    // the chosen one, or the system default when none is chosen.
    function syncPermissionNote() {
      var select = control('permission');
      var note = detailsForm.querySelector('.form-note-permission');
      if (!select || !note) return;
      note.textContent = PERMISSION_NOTES[select.value || defaultPermission()] || '';
    }

    // The form's values as the routes take them, plus what Save compares.
    function formValues() {
      var groupSelect = control('group');
      var group = groupSelect ? groupSelect.value : '';
      var groupNameField = control('groupName');
      var newName = group === NEW_GROUP && groupNameField ? groupNameField.value.trim() : '';
      var accepts = [];
      var everyone = false;
      var boxes = detailsForm.querySelectorAll('input[name="accepts"]');
      for (var i = 0; i < boxes.length; i += 1) {
        if (!boxes[i].checked) continue;
        if (boxes[i].value === EVERYONE) everyone = true;
        else accepts.push(boxes[i].value);
      }
      var model = control('model');
      var effort = control('effort');
      var permission = control('permission');
      var idField = control('agentId');
      var pinned = control('pinned');
      return {
        id: idField ? idField.value.trim() : null,
        name: control('name').value,
        role: control('role').value,
        group: group === NEW_GROUP ? slug(newName) : group,
        newGroup: group === NEW_GROUP ? { id: slug(newName), name: newName } : null,
        description: control('description').value,
        cwd: expandPath(control('cwd').value, state.home),
        model: model && model.value ? model.value : null,
        effort: effort && effort.value ? effort.value : null,
        permission: permission && permission.value ? permission.value : null,
        accepts: everyone || accepts.length === 0 ? null : accepts,
        pinned: !!(pinned && pinned.checked),
      };
    }

    function formDirty() {
      return formBaseline !== null && JSON.stringify(formValues()) !== formBaseline;
    }

    // Save is on once a field changed; the group name shows for a new group;
    // the problems or the note sit under the fields.
    function syncForm() {
      var groupSelect = control('group');
      var nameField = detailsForm.querySelector('.form-field-group-name');
      if (nameField) nameField.hidden = !groupSelect || groupSelect.value !== NEW_GROUP;
      var save = detailsForm.querySelector('[data-form-action="save"]');
      if (save) save.disabled = busy || !formDirty();
      syncPermissionNote();
      var list = detailsForm.querySelector('.form-problems');
      var note = detailsForm.querySelector('.form-note-line');
      list.textContent = '';
      for (var i = 0; i < formNotice.length && !formNoticeIsNote; i += 1) list.appendChild(element('li', null, formNotice[i]));
      list.hidden = formNoticeIsNote || formNotice.length === 0;
      note.textContent = formNoticeIsNote && formNotice.length > 0 ? formNotice[0] : '';
      note.hidden = !note.textContent;
    }

    // Builds the form for the agent (or, creating, for no one) when what it
    // shows changed, unless it holds unsaved edits for the same agent.
    function renderForm(agent) {
      var target = creating ? 'create' : 'edit:' + agent.id;
      var level = agent && agent.model && agent.model.agent ? agent.model.agent : { id: null, effort: null };
      var permission = agent && agent.permission ? agent.permission.agent : null;
      var key = JSON.stringify([
        target,
        agent ? [agent.name, agent.role, agent.group, agent.description, agent.cwd, level, permission, agent.accepts, agent.pinned, agent.provider] : null,
        groupOptions(), state.models, otherPersonas(agent), state.settings && state.settings.model, state.settings && state.settings.permission, state.home,
      ]);
      if (key === formKey) {
        syncForm();
        return;
      }
      if (formKey !== null && target === formTarget && formDirty()) return;
      formKey = key;
      formTarget = target;

      var groups = groupOptions();
      var codex = !!agent && agent.provider === 'codex';
      detailsForm.textContent = '';
      detailsForm.appendChild(formField('Name', textInput('name', agent ? agent.name : '', 40), 'agent-form-name'));
      if (creating) detailsForm.appendChild(formField('Id', textInput('agentId', '', 32), 'agent-form-id'));
      detailsForm.appendChild(formField('Role', textInput('role', agent ? agent.role : '', 24), 'agent-form-role'));
      var groupValue = agent ? agent.group : groups.length > 0 ? groups[0].id : NEW_GROUP;
      detailsForm.appendChild(formField('Group', selectInput('group', groups.concat([{ id: NEW_GROUP, name: 'New group…' }]), groupValue), 'agent-form-group'));
      var groupNameField = formField('Group name', textInput('groupName', '', 40), 'agent-form-group-name');
      groupNameField.className += ' form-field-group-name';
      detailsForm.appendChild(groupNameField);
      var description = element('textarea', 'form-input');
      description.name = 'description';
      description.rows = 3;
      description.maxLength = 300;
      description.value = agent ? agent.description || '' : '';
      detailsForm.appendChild(formField('Description', description, 'agent-form-description'));
      detailsForm.appendChild(formField('Folder', textInput('cwd', agent ? shortPath(agent.cwd, state.home) : ''), 'agent-form-cwd'));
      if (codex) {
        detailsForm.appendChild(element('p', 'form-note form-note-codex', CODEX_NOTE));
      } else {
        var models = (state.models || []).map(function (model) { return { id: model.id, name: model.name }; });
        detailsForm.appendChild(formField('Model', selectInput('model', [defaultModelOption()].concat(models), level.id || ''), 'agent-form-model'));
        var efforts = EFFORTS.map(function (effort) { return { id: effort, name: effortNameOf(effort) }; });
        detailsForm.appendChild(formField('Effort', selectInput('effort', [defaultEffortOption()].concat(efforts), level.effort || ''), 'agent-form-effort'));
        var levels = PERMISSION_LEVELS.map(function (id) { return { id: id, name: permissionNameOf(id) }; });
        detailsForm.appendChild(formField('Permissions', selectInput('permission', [defaultPermissionOption()].concat(levels), permission || ''), 'agent-form-permission'));
        detailsForm.appendChild(element('p', 'form-note form-note-permission'));
      }
      var accepts = agent && Array.isArray(agent.accepts) && agent.accepts.length > 0 ? agent.accepts : null;
      var who = element('fieldset', 'form-fieldset');
      who.appendChild(element('legend', 'form-legend', 'Who may message'));
      who.appendChild(checkbox('accepts', EVERYONE, 'Everyone', !accepts));
      var others = otherPersonas(agent);
      for (var i = 0; i < others.length; i += 1) {
        who.appendChild(checkbox('accepts', others[i].id, others[i].name, !!accepts && accepts.indexOf(others[i].id) !== -1));
      }
      detailsForm.appendChild(who);
      detailsForm.appendChild(checkbox('pinned', 'true', 'Pinned', !!agent && agent.pinned === true));
      var problems = element('ul', 'form-problems');
      problems.hidden = true;
      detailsForm.appendChild(problems);
      var note = element('p', 'form-note form-note-line');
      note.hidden = true;
      detailsForm.appendChild(note);
      var actions = element('div', 'form-actions');
      var save = element('button', 'button button-primary', creating ? 'Create' : 'Save');
      save.type = 'submit';
      save.setAttribute('data-form-action', 'save');
      actions.appendChild(save);
      actions.appendChild(button('button', 'Cancel', 'cancel-form'));
      detailsForm.appendChild(actions);

      formBaseline = creating ? '' : JSON.stringify(formValues());
      syncForm();
    }

    // The body the routes take; a new group rides along as `newGroup`.
    function formBody(values) {
      var body = {
        name: values.name,
        role: values.role,
        group: values.group,
        description: values.description,
        cwd: values.cwd,
        model: values.model,
        effort: values.effort,
        permission: values.permission,
        accepts: values.accepts,
        pinned: values.pinned,
      };
      if (values.newGroup) body.newGroup = values.newGroup;
      if (creating) body.id = values.id;
      return body;
    }

    // Saves the form: PUT for the open persona, POST for a new agent. The
    // snapshot delta brings the change to the row, the header, and the
    // form; a refusal lists why under the form.
    function saveForm() {
      if (busy) return;
      var agent = selectedAgent();
      var wasCreating = creating;
      if (!wasCreating && (!isPersona(agent) || !formDirty())) return;
      var values = formValues();
      var body = formBody(values);
      var method = wasCreating ? 'POST' : 'PUT';
      var path = wasCreating ? '/api/agents' : routeBase(agent) + '/settings';
      busy = true;
      formNotice = [];
      formNoticeIsNote = false;
      syncForm();
      call(method, path, body).then(function (result) {
        busy = false;
        var ok = !!(result && result.ok);
        var current = wasCreating ? creating : agent.id === selectedId && !creating;
        if (ok && !shell.isStreaming()) shell.requestState();
        if (!current) {
          renderThread();
          return;
        }
        if (ok && wasCreating) {
          creating = false;
          formKey = null;
          select(body.id, true);
          return;
        }
        if (ok) {
          formKey = null;
          formNotice = result.note === 'cwd_applies_on_new_thread' ? [FOLDER_NOTE] : [];
          formNoticeIsNote = true;
        } else {
          formNotice = formProblems(result);
          formNoticeIsNote = false;
        }
        renderThread();
        syncForm();
      });
    }

    function startCreate() {
      creating = true;
      idTouched = false;
      formKey = null;
      formNotice = [];
      formNoticeIsNote = false;
      renderThread();
      var first = control('name');
      if (first) first.focus();
    }

    function cancelCreate() {
      creating = false;
      formKey = null;
      formNotice = [];
      formNoticeIsNote = false;
      renderThread();
      newAgent.focus();
    }

    // Everyone and the named agents exclude each other; no one chosen
    // means everyone.
    function onAcceptsChange(box) {
      var boxes = detailsForm.querySelectorAll('input[name="accepts"]');
      var any = false;
      for (var i = 0; i < boxes.length; i += 1) {
        if (box.value === EVERYONE && box.checked && boxes[i] !== box) boxes[i].checked = false;
        else if (box.value !== EVERYONE && box.checked && boxes[i].value === EVERYONE) boxes[i].checked = false;
        if (boxes[i].checked && boxes[i].value !== EVERYONE) any = true;
      }
      if (!any) {
        for (var j = 0; j < boxes.length; j += 1) if (boxes[j].value === EVERYONE) boxes[j].checked = true;
      }
    }

    // The column beside the list: a sentence asking for an agent, the
    // thread view with the panel beside it, or, for New agent with no
    // thread open, the panel alone under the view's blank header. The
    // header's gear and Open terminal follow the open entry.
    function renderThread() {
      var agent = selectedAgent();
      view.classList.toggle('agents-open', !!selectedId || creating);
      renderMessage();
      if (!selectedId && !creating) {
        empty.textContent = CHOOSE;
        empty.hidden = false;
        panel.hidden = true;
        renderHeaderActions(null);
        return;
      }
      if (!agent && !creating) {
        empty.textContent = SESSION_ID.test(selectedId) ? 'That session is not listed.' : 'No agent named ' + selectedId + ' is registered.';
        empty.hidden = false;
        panel.hidden = true;
        renderHeaderActions(null);
        return;
      }
      empty.hidden = true;
      panel.hidden = false;
      if (!agent) {
        thread.blank(NEW_AGENT);
        renderHeaderActions(null);
        details.hidden = false;
        renderPanel(null);
        return;
      }
      var session = isSession(agent);
      thread.render();
      renderHeaderActions(agent);
      details.hidden = creating ? false : !detailsOpen || session;
      if (!details.hidden) renderPanel(agent);
    }

    // The gear, for every entry but a coding session, and Open terminal: on
    // only for a session whose terminal is bound, still open, and
    // reachable; otherwise the line under it says why, or why the last
    // attempt was refused.
    function renderHeaderActions(agent) {
      var session = isSession(agent);
      detailsToggle.hidden = !agent || session;
      detailsToggle.setAttribute('aria-expanded', agent && detailsOpen && !session ? 'true' : 'false');
      openTerminal.hidden = !session;
      var why = session ? terminalReason(agent, state) : '';
      openTerminal.disabled = !session || busy || !!why;
      terminalLine.textContent = session ? why || terminalError : '';
      terminalLine.hidden = !terminalLine.textContent;
    }

    function render() {
      if (!state) return;
      renderList();
      renderThread();
    }

    // On a desk with no agent in the URL the first pinned persona's thread
    // is open; a phone shows the list. The URL is left alone, so Back still
    // leaves the page and a row click still adds its entry.
    function defaultId() {
      if (!wide.matches || !state) return null;
      var agent = pinnedPersona(state.agents);
      return agent ? agent.id : null;
    }

    // A history entry is added only when the URL names a different agent,
    // so choosing the open row from `/agents` or `/?agent=` adds nothing.
    function select(id, push) {
      if (push && agentFromUrl() !== id) history.pushState(null, '', agentUrl(id));
      if (creating) {
        creating = false;
        formKey = null;
        formNotice = [];
        if (id === selectedId) {
          render();
          return;
        }
      }
      if (id === selectedId) return;
      setSelected(id);
      render();
      if (isPersona(selectedAgent()) && wide.matches) thread.focusInput();
    }

    // The thread view puts the draft away and brings out the chosen
    // agent's; the refusal under Open terminal belongs to the last entry.
    function setSelected(id) {
      selectedId = id;
      terminalError = '';
      thread.select(id);
    }

    // Asks cmux to focus the session's terminal. A success shows nothing:
    // the terminal has the focus. A refusal is said under the button until
    // the next attempt or another session is chosen.
    function openSessionTerminal(session) {
      if (busy) return;
      busy = true;
      terminalError = '';
      renderThread();
      post(routeBase(session) + '/open-terminal').then(function (result) {
        busy = false;
        var ok = !!(result && result.ok);
        if (session.id === selectedId && !ok) terminalError = openRefusal(result);
        if (!ok && result && (result.code === 'terminal_closed' || result.code === 'no_such_session')) shell.requestState();
        renderThread();
        if (session.id === selectedId) openTerminal.focus();
      });
    }

    // --- Routines: the panel's list and form, the sidebar section ----------

    function routineItems() {
      return state && state.routines && Array.isArray(state.routines.items) ? state.routines.items : [];
    }

    function routinesOf(agentId) {
      return routineItems().filter(function (routine) { return routine.agent === agentId; });
    }

    function routineById(id) {
      var items = routineItems();
      for (var i = 0; i < items.length; i += 1) if (items[i].id === id) return items[i];
      return null;
    }

    function chipNode(chip) {
      return element('span', 'routine-chip' + (chip.tone ? ' routine-chip-' + chip.tone : ''), chip.text);
    }

    // A row in a routines list: the name and chip, then the schedule with
    // the last run (in the panel) or the next fire (in the sidebar).
    function routineRow(routine, link) {
      var node;
      if (link) {
        node = element('a', 'routine-item');
        node.href = agentUrl(routine.agent);
        node.setAttribute('data-agent', routine.agent);
      } else {
        node = button('routine-item', undefined, 'open-routine');
      }
      node.setAttribute('data-routine', routine.id);
      var head = element('span', 'routine-item-head');
      head.appendChild(element('span', 'routine-item-name', routine.name));
      head.appendChild(chipNode(routineChip(routine)));
      node.appendChild(head);
      var when = routine.schedule && routine.schedule.text ? routine.schedule.text : '';
      var extra = '';
      if (link) {
        extra = routine.active === false ? '' : nextWords(routine.nextAt, Date.now());
      } else if (routine.lastRun && runTime(routine.lastRun)) {
        extra = 'Last run ' + formatTime(runTime(routine.lastRun));
      }
      var line = element('span', 'routine-item-when', when + (extra ? ' · ' + extra : ''));
      if (!link && routine.lastRun && runTime(routine.lastRun)) {
        line.textContent = '';
        line.appendChild(document.createTextNode(when + ' · Last run '));
        line.appendChild(timeSpan(null, runTime(routine.lastRun)));
      }
      node.appendChild(line);
      return node;
    }

    function resetRoutineForm() {
      routineForm = null;
      routineNotice = [];
      routineConfirming = false;
      routinePanelKey = null;
      routineFormTarget = null;
      routineFormBaseline = null;
    }

    // The panel's Routines section for a persona: its routines and Add
    // routine, or the form for one of them.
    function renderRoutinePanel(agent) {
      routinesNode.hidden = false;
      if (routineForm && routineForm.agentId !== agent.id) resetRoutineForm();
      if (routineForm) {
        renderRoutineForm(agent);
        return;
      }
      var mine = routinesOf(agent.id);
      var key = JSON.stringify(['list', agent.id, mine.map(function (routine) {
        return [routine.id, routine.name, routine.schedule, routine.active, routine.lastRun];
      })]);
      if (key === routinePanelKey) {
        refreshTimes(routinesNode);
        return;
      }
      routinePanelKey = key;
      routinesNode.textContent = '';
      var head = element('div', 'details-routines-head');
      var heading = element('h3', 'card-name', 'Routines');
      heading.id = 'agent-routines-heading';
      head.appendChild(heading);
      routinesNode.appendChild(head);
      if (mine.length === 0) {
        routinesNode.appendChild(element('p', 'routine-empty', NO_ROUTINES));
      } else {
        var list = element('div', 'routine-items');
        for (var i = 0; i < mine.length; i += 1) list.appendChild(routineRow(mine[i], false));
        routinesNode.appendChild(list);
      }
      routinesNode.appendChild(button('button', 'Add routine', 'add-routine'));
    }

    function hideRoutinePanel() {
      routinesNode.hidden = true;
      routinesNode.textContent = '';
      routinePanelKey = null;
    }

    function routineFormNode() {
      return routinesNode.querySelector('#routine-form');
    }

    function routineControl(name) {
      var form = routineFormNode();
      return form ? form.querySelector('[name="' + name + '"]') : null;
    }

    // The When picker: a cadence and a time, with the days for "Every week
    // on…" and the day of the month for "Every month on the…".
    function whenField(spec) {
      var wrap = element('div', 'form-field form-field-when');
      var lab = element('label', 'form-label', 'When');
      lab.htmlFor = 'routine-form-cadence';
      wrap.appendChild(lab);
      var row = element('div', 'form-when-row');
      var cadence = element('select', 'form-input form-select');
      cadence.name = 'cadence';
      cadence.id = 'routine-form-cadence';
      var kind = spec ? spec.kind : 'weekdays';
      for (var i = 0; i < CADENCES.length; i += 1) {
        var option = element('option', null, CADENCES[i].name);
        option.value = CADENCES[i].id;
        if (CADENCES[i].id === kind) option.selected = true;
        cadence.appendChild(option);
      }
      row.appendChild(cadence);
      var time = element('input', 'form-input');
      time.type = 'time';
      time.name = 'time';
      time.id = 'routine-form-time';
      time.setAttribute('aria-label', 'Time');
      time.value = spec && typeof spec.hour === 'number' ? pad(spec.hour) + ':' + pad(spec.minute) : '06:30';
      row.appendChild(time);
      wrap.appendChild(row);
      var days = element('div', 'form-days');
      days.setAttribute('role', 'group');
      days.setAttribute('aria-label', 'Days');
      for (var d = 0; d < PICKER_DAYS.length; d += 1) {
        var day = PICKER_DAYS[d];
        var checked = !!spec && spec.kind === 'days' && spec.days.indexOf(day) !== -1;
        days.appendChild(checkbox('day', String(day), DAY_SHORT[day], checked));
      }
      wrap.appendChild(days);
      var domField = element('div', 'form-field form-field-dom');
      var domLabel = element('label', 'form-label', 'Day of the month');
      domLabel.htmlFor = 'routine-form-dom';
      var dom = element('input', 'form-input');
      dom.type = 'number';
      dom.name = 'dom';
      dom.id = 'routine-form-dom';
      dom.min = '1';
      dom.max = '28';
      dom.value = spec && spec.kind === 'monthly' ? String(spec.dom) : '1';
      domField.appendChild(domLabel);
      domField.appendChild(dom);
      wrap.appendChild(domField);
      syncPicker(wrap);
      return wrap;
    }

    // The picker shows only the parts its cadence needs.
    function syncPicker(wrap) {
      var cadence = wrap.querySelector('[name="cadence"]');
      if (!cadence) return;
      var kind = cadence.value;
      wrap.querySelector('.form-days').hidden = kind !== 'days';
      wrap.querySelector('.form-field-dom').hidden = kind !== 'monthly';
      wrap.querySelector('[name="time"]').hidden = !!NO_TIME_CADENCES[kind];
    }

    // The picker's state, or { problem } naming what is missing.
    function pickerSpec(form) {
      var cadence = form.querySelector('[name="cadence"]').value;
      if (cadence === 'hourly' || cadence === 'minutes') return { spec: { kind: cadence } };
      var timeValue = form.querySelector('[name="time"]').value;
      var match = /^(\d{2}):(\d{2})/.exec(timeValue || '');
      if (!match) return { problem: PICK_TIME };
      var hour = parseInt(match[1], 10);
      var minute = parseInt(match[2], 10);
      if (cadence === 'days') {
        var boxes = form.querySelectorAll('input[name="day"]:checked');
        var days = [];
        for (var i = 0; i < boxes.length; i += 1) days.push(parseInt(boxes[i].value, 10));
        if (days.length === 0) return { problem: PICK_DAYS };
        days.sort();
        return { spec: { kind: 'days', days: days, hour: hour, minute: minute } };
      }
      if (cadence === 'monthly') {
        var dom = parseInt(form.querySelector('[name="dom"]').value, 10);
        if (!(dom >= 1 && dom <= 28)) return { problem: PICK_DAY_OF_MONTH };
        return { spec: { kind: 'monthly', dom: dom, hour: hour, minute: minute } };
      }
      return { spec: { kind: cadence, hour: hour, minute: minute } };
    }

    // The form's values: what Save posts, and what dirtiness compares.
    function routineFormValues() {
      var form = routineFormNode();
      if (!form) return null;
      var picked = pickerSpec(form);
      return {
        name: form.querySelector('[name="name"]').value.trim(),
        instruction: form.querySelector('[name="instruction"]').value.trim(),
        active: form.querySelector('[name="active"]').checked,
        schedule: picked.spec ? specToCron(picked.spec) : null,
        problem: picked.problem || null,
      };
    }

    function routineFormDirty() {
      var values = routineFormValues();
      return values !== null && routineFormBaseline !== null && JSON.stringify(values) !== routineFormBaseline;
    }

    // Save is on once a field changed (always for a new routine); the
    // problems sit under the fields; the Delete confirm shows when asked.
    function syncRoutineForm() {
      var form = routineFormNode();
      if (!form) return;
      var save = form.querySelector('[data-form-action="save"]');
      if (save) save.disabled = busy || !routineFormDirty();
      var buttons = form.querySelectorAll('button[data-agent-action]');
      for (var i = 0; i < buttons.length; i += 1) buttons[i].disabled = busy;
      var list = form.querySelector('.form-problems');
      list.textContent = '';
      for (var j = 0; j < routineNotice.length; j += 1) list.appendChild(element('li', null, routineNotice[j]));
      list.hidden = routineNotice.length === 0;
      var confirm = form.querySelector('.routine-confirm');
      if (confirm) confirm.hidden = !routineConfirming;
      var actions = form.querySelector('.routine-actions');
      if (actions) actions.hidden = routineConfirming;
    }

    // Builds the form for the routine (or a new one) when what it shows
    // changed, unless it holds unsaved edits for the same routine.
    function renderRoutineForm(agent) {
      var routine = routineForm.routineId ? routineById(routineForm.routineId) : null;
      if (routineForm.routineId && !routine) {
        resetRoutineForm();
        renderRoutinePanel(agent);
        return;
      }
      var target = routine ? 'edit:' + routine.id : 'create:' + agent.id;
      var key = JSON.stringify(['form', target, routine ? [routine.name, routine.instruction, routine.schedule, routine.active] : null, agent.name]);
      if (key === routinePanelKey || (routinePanelKey !== null && target === routineFormTarget && routineFormDirty())) {
        syncRoutineForm();
        renderRoutineRuns(agent, routine);
        return;
      }
      routinePanelKey = key;
      routineFormTarget = target;
      routinesNode.textContent = '';

      var head = element('div', 'details-routines-head');
      var back = button('button icon-button', undefined, 'cancel-routine');
      back.setAttribute('aria-label', 'Back to the routines');
      back.title = 'Back to the routines';
      back.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" stroke="currentColor" fill="none" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="m15 6-6 6 6 6"/></svg>';
      head.appendChild(back);
      var heading = element('h3', 'card-name', routine ? routine.name : 'New routine');
      heading.id = 'agent-routines-heading';
      head.appendChild(heading);
      routinesNode.appendChild(head);

      var form = element('form', 'details-form routine-form');
      form.id = 'routine-form';
      form.noValidate = true;
      form.appendChild(formField('Name', textInput('name', routine ? routine.name : '', 60), 'routine-form-name'));
      var instruction = element('textarea', 'form-input');
      instruction.name = 'instruction';
      instruction.rows = 4;
      instruction.maxLength = 4000;
      instruction.value = routine ? routine.instruction : '';
      form.appendChild(formField('Instruction', instruction, 'routine-form-instruction'));
      var spec = routine ? cronToSpec(routine.schedule && routine.schedule.cron) : null;
      form.appendChild(whenField(spec));
      if (routine && !spec) form.appendChild(element('p', 'form-note', SCHEDULE_REPLACED));
      form.appendChild(checkbox('active', 'true', 'Active', routine ? routine.active !== false : true));
      var problems = element('ul', 'form-problems');
      problems.hidden = true;
      form.appendChild(problems);
      var actions = element('div', 'form-actions');
      var save = element('button', 'button button-primary', routine ? 'Save' : 'Create');
      save.type = 'submit';
      save.setAttribute('data-form-action', 'save');
      actions.appendChild(save);
      actions.appendChild(button('button', 'Cancel', 'cancel-routine'));
      form.appendChild(actions);
      if (routine) {
        var secondary = element('div', 'form-actions routine-actions');
        secondary.appendChild(button('button button-small', 'Test run', 'test-routine'));
        secondary.appendChild(button('button button-small', 'Delete', 'delete-routine'));
        form.appendChild(secondary);
        var confirm = element('div', 'routine-confirm');
        confirm.setAttribute('role', 'group');
        confirm.setAttribute('aria-label', 'Delete routine');
        confirm.hidden = true;
        confirm.appendChild(element('span', null, 'Delete ' + routine.name + '? Its runs go with it.'));
        confirm.appendChild(button('button button-primary', 'Delete routine', 'confirm-delete-routine'));
        confirm.appendChild(button('button', 'Cancel', 'cancel-delete-routine'));
        form.appendChild(confirm);
      }
      routinesNode.appendChild(form);
      if (routine) {
        var runs = element('div', 'routine-runs');
        runs.id = 'routine-runs';
        routinesNode.appendChild(runs);
      }
      routineFormBaseline = routine ? JSON.stringify(routineFormValues()) : '';
      routineRunsRendered = null;
      syncRoutineForm();
      renderRoutineRuns(agent, routine);
    }

    // Last runs: fetched when the form opens on a saved routine and again
    // whenever its last run moves.
    function renderRoutineRuns(agent, routine) {
      var node = routinesNode.querySelector('#routine-runs');
      if (!routine || !node) return;
      var fetchKey = routine.id + '|' + JSON.stringify(routine.lastRun || null);
      if (fetchKey !== routineRuns.key) {
        routineRuns = { key: fetchKey, id: routine.id, runs: routineRuns.id === routine.id ? routineRuns.runs : null, loading: true, error: false };
        fetchRoutineRuns(routine.id, fetchKey);
      }
      var key = JSON.stringify([routine.id, routineRuns.runs, routineRuns.loading, routineRuns.error]);
      if (key === routineRunsRendered) {
        refreshTimes(node);
        return;
      }
      routineRunsRendered = key;
      node.textContent = '';
      node.appendChild(element('p', 'form-label', 'Last runs'));
      var runs = routineRuns.runs;
      if (runs === null) {
        node.appendChild(element('p', 'routine-empty', routineRuns.error ? RUNS_UNREADABLE : 'Reading the runs.'));
        return;
      }
      if (runs.length === 0) {
        node.appendChild(element('p', 'routine-empty', NOT_RUN_YET));
        return;
      }
      var names = function (id) { return agentName(state.agents, id); };
      var list = element('ul', 'routine-run-list');
      for (var i = 0; i < runs.length; i += 1) {
        var run = runs[i];
        var item = element('li', 'routine-run-row');
        var line = element('span', 'routine-run-head');
        line.appendChild(chipNode(runChip(run)));
        var at = runTime(run);
        if (at) line.appendChild(timeSpan('routine-run-time', at));
        item.appendChild(line);
        var note = runNote(run, names);
        if (note) item.appendChild(element('span', 'routine-run-note', note));
        list.appendChild(item);
      }
      node.appendChild(list);
    }

    function fetchRoutineRuns(id, fetchKey) {
      fetch('/api/routines/' + encodeURIComponent(id) + '/runs', { cache: 'no-store', credentials: 'same-origin' })
        .then(function (response) { return response.ok ? response.json() : null; }, function () { return null; })
        .then(function (body) {
          if (routineRuns.key !== fetchKey) return;
          routineRuns.loading = false;
          if (body && Array.isArray(body.runs)) {
            routineRuns.runs = body.runs;
            routineRuns.error = false;
          } else {
            routineRuns.error = true;
          }
          if (visible) renderThread();
        });
    }

    function openRoutineForm(agent, routineId) {
      routineForm = { agentId: agent.id, routineId: routineId };
      routineNotice = [];
      routineConfirming = false;
      routinePanelKey = null;
      routineFormBaseline = null;
      detailsOpen = true;
      renderThread();
      var first = routineControl('name');
      if (first) first.focus();
    }

    // Back to the agent's routines; the keyboard lands on the heading.
    function closeRoutineForm() {
      resetRoutineForm();
      renderThread();
      var heading = routinesNode.querySelector('#agent-routines-heading');
      if (heading) {
        heading.tabIndex = -1;
        heading.focus();
      }
    }

    // A routine row in the sidebar: that agent's thread with the panel
    // open on the routine.
    function openRoutine(agentId, routineId) {
      routineForm = { agentId: agentId, routineId: routineId };
      routineNotice = [];
      routineConfirming = false;
      routinePanelKey = null;
      routineFormBaseline = null;
      detailsOpen = true;
      select(agentId, true);
      render();
    }

    // Saves the form: POST for a new routine, PUT for a saved one. The
    // snapshot brings the routine to the lists; on success the panel
    // returns to the agent's routines, where the row shows the schedule.
    function saveRoutine() {
      if (busy || !routineForm) return;
      var agent = selectedAgent();
      if (!isPersona(agent) || agent.id !== routineForm.agentId) return;
      var values = routineFormValues();
      if (!values) return;
      var problems = [];
      if (!values.name) problems.push(NAME_MISSING);
      if (!values.instruction) problems.push('Say what the routine asks ' + agent.name + ' to do.');
      if (values.problem) problems.push(values.problem);
      if (problems.length > 0) {
        routineNotice = problems;
        syncRoutineForm();
        return;
      }
      var editing = routineForm.routineId;
      var body = { name: values.name, agent: agent.id, instruction: values.instruction, schedule: values.schedule, active: values.active };
      busy = true;
      routineNotice = [];
      renderThread();
      call(editing ? 'PUT' : 'POST', editing ? '/api/routines/' + encodeURIComponent(editing) : '/api/routines', body).then(function (result) {
        busy = false;
        var ok = !!(result && result.ok);
        if (ok && !shell.isStreaming()) shell.requestState();
        var current = routineForm && routineForm.agentId === agent.id && agent.id === selectedId;
        if (!current) {
          renderThread();
          return;
        }
        if (ok) {
          resetRoutineForm();
          renderThread();
          var heading = routinesNode.querySelector('#agent-routines-heading');
          if (heading) {
            heading.tabIndex = -1;
            heading.focus();
          }
          return;
        }
        routineNotice = [routineRefusal(result, agent)];
        renderThread();
      });
    }

    function testRoutine(agent) {
      if (busy || !routineForm || !routineForm.routineId) return;
      var id = routineForm.routineId;
      busy = true;
      routineNotice = [];
      renderThread();
      post('/api/routines/' + encodeURIComponent(id) + '/run').then(function (result) {
        busy = false;
        var ok = !!(result && result.ok);
        if (ok && !shell.isStreaming()) shell.requestState();
        if (!ok && routineForm && routineForm.routineId === id) routineNotice = [testRunRefusal(result, agent)];
        renderThread();
      });
    }

    function deleteRoutine(agent) {
      if (busy || !routineForm || !routineForm.routineId) return;
      var id = routineForm.routineId;
      busy = true;
      routineConfirming = false;
      routineNotice = [];
      renderThread();
      call('DELETE', '/api/routines/' + encodeURIComponent(id)).then(function (result) {
        busy = false;
        var ok = !!(result && result.ok);
        if (ok && !shell.isStreaming()) shell.requestState();
        if (routineForm && routineForm.routineId === id) {
          if (ok) resetRoutineForm();
          else routineNotice = [routineRefusal(result, agent)];
        }
        renderThread();
      });
    }

    // The sidebar's collapsed section: every routine under its agent, in
    // registry order. Rebuilt only when what it shows changed; its open
    // state is the element's own.
    function renderRoutinesSection() {
      if (!state) return;
      var registryBad = !!(state.registry && state.registry.ok === false);
      var items = routineItems();
      routinesSection.hidden = registryBad;
      var key = JSON.stringify([items.map(function (routine) {
        return [routine.id, routine.name, routine.agent, routine.schedule, routine.active, routine.nextAt, routine.lastRun];
      }), (state.agents || []).map(function (agent) { return [agent.id, agent.name]; })]);
      if (key === routinesSectionKey) return;
      routinesSectionKey = key;
      routinesSectionBody.textContent = '';
      var groupsList = [];
      var agents = state.agents || [];
      for (var i = 0; i < agents.length; i += 1) {
        var mine = items.filter(function (routine) { return routine.agent === agents[i].id; });
        if (mine.length > 0) groupsList.push({ agent: agents[i], routines: mine });
      }
      if (groupsList.length === 0) {
        routinesSectionBody.appendChild(element('p', 'routine-empty', NO_ROUTINES_ANYWHERE));
        return;
      }
      for (var g = 0; g < groupsList.length; g += 1) {
        var group = element('div', 'agents-routines-group');
        group.appendChild(element('h3', 'agents-routines-heading', groupsList[g].agent.name));
        var list = element('div', 'routine-items');
        for (var j = 0; j < groupsList[g].routines.length; j += 1) list.appendChild(routineRow(groupsList[g].routines[j], true));
        group.appendChild(list);
        routinesSectionBody.appendChild(group);
      }
    }

    routinesNode.addEventListener('submit', function (event) {
      if (event.target && event.target.id === 'routine-form') {
        event.preventDefault();
        saveRoutine();
      }
    });

    function onRoutineFormEdit(event) {
      var form = event.target && event.target.closest && event.target.closest('#routine-form');
      if (!form) return;
      if (event.target.name === 'cadence' && event.type === 'change') syncPicker(form.querySelector('.form-field-when'));
      routineNotice = [];
      syncRoutineForm();
    }
    routinesNode.addEventListener('input', onRoutineFormEdit);
    routinesNode.addEventListener('change', onRoutineFormEdit);

    // Header actions live outside #view-agents; one delegated listener keeps
    // them on the same action path as the panel's controls. The thread
    // view handles its own controls and links on its root first and marks
    // a link it took with preventDefault.
    document.addEventListener('click', function (event) {
      var target = event.target;
      var link = target.closest && target.closest('a[data-agent]');
      if (link) {
        if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        if (!view.contains(link)) return;
        event.preventDefault();
        if (link.hasAttribute('data-routine')) {
          openRoutine(link.getAttribute('data-agent'), link.getAttribute('data-routine'));
          return;
        }
        select(link.getAttribute('data-agent'), true);
        return;
      }
      var node = target.closest && target.closest('button[data-agent-action]');
      if (!node || node.disabled) return;
      var agent = selectedAgent();
      switch (node.getAttribute('data-agent-action')) {
        case 'open-terminal':
          if (isSession(agent)) openSessionTerminal(agent);
          break;
        case 'toggle-details':
          detailsOpen = !detailsOpen;
          renderThread();
          // On a phone the panel covers the gear, so the keyboard goes to its chevron.
          if (detailsOpen && !wide.matches) details.querySelector('button').focus();
          break;
        case 'close-details':
          closeDetails();
          break;
        case 'new-agent':
          startCreate();
          break;
        case 'cancel-form':
          if (creating) {
            cancelCreate();
          } else {
            formKey = null;
            formNotice = [];
            renderThread();
          }
          break;
        case 'open-routine':
          if (isPersona(agent)) openRoutineForm(agent, node.getAttribute('data-routine'));
          break;
        case 'add-routine':
          if (isPersona(agent)) openRoutineForm(agent, null);
          break;
        case 'cancel-routine':
          closeRoutineForm();
          break;
        case 'test-routine':
          if (isPersona(agent)) testRoutine(agent);
          break;
        case 'delete-agent':
          if (!isPersona(agent)) break;
          deleteFor = agent.id;
          deleteNotice = null;
          renderThread();
          deleteConfirm.querySelector('button').focus();
          break;
        case 'confirm-delete-agent':
          if (isPersona(agent) && deleteFor === agent.id) deleteAgent(agent);
          break;
        case 'cancel-delete-agent':
          deleteFor = null;
          renderThread();
          deleteAgentButton.focus();
          break;
        case 'delete-routine':
          routineConfirming = true;
          renderThread();
          var confirmButton = routinesNode.querySelector('.routine-confirm button');
          if (confirmButton) confirmButton.focus();
          break;
        case 'confirm-delete-routine':
          if (isPersona(agent)) deleteRoutine(agent);
          break;
        case 'cancel-delete-routine':
          routineConfirming = false;
          renderThread();
          var deleteButton = routinesNode.querySelector('[data-agent-action="delete-routine"]');
          if (deleteButton) deleteButton.focus();
          break;
        default:
          break;
      }
    });

    function closeDetails() {
      if (creating) {
        cancelCreate();
        return;
      }
      detailsOpen = false;
      renderThread();
      detailsToggle.focus();
    }

    detailsForm.addEventListener('submit', function (event) {
      event.preventDefault();
      saveForm();
    });

    function onFormEdit(event) {
      var target = event.target;
      if (!target || !target.name) return;
      if (target.name === 'accepts' && event.type === 'change') onAcceptsChange(target);
      if (creating && target.name === 'agentId' && event.type === 'input') idTouched = true;
      if (creating && target.name === 'name' && !idTouched) {
        var idField = control('agentId');
        if (idField) idField.value = slug(target.value).slice(0, 32);
      }
      formNotice = [];
      formNoticeIsNote = false;
      syncForm();
    }
    detailsForm.addEventListener('input', onFormEdit);
    detailsForm.addEventListener('change', onFormEdit);

    details.addEventListener('keydown', function (event) {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      closeDetails();
    });

    // Turning a phone into a desk with nothing chosen opens the pinned
    // thread, the same as arriving on a desk; turning a desk into a phone
    // with only that default open goes back to the list.
    wide.addEventListener('change', function () {
      if (!visible || agentFromUrl()) return;
      var id = defaultId();
      if (id === selectedId) return;
      if (selectedId && !wide.matches && !agentFromUrl()) setSelected(null);
      else if (id && !selectedId) setSelected(id);
      else return;
      render();
    });

    return {
      update: function (next, keys) {
        state = next;
        thread.update(next, keys);
        var touched = !keys || keys.some(function (key) { return WATCHED.indexOf(key) !== -1; });
        if (touched && visible) {
          if (!selectedId && !agentFromUrl()) {
            var id = defaultId();
            if (id) setSelected(id);
          }
          render();
        }
      },
      show: function () {
        visible = true;
        var id = agentFromUrl() || defaultId();
        if (id !== selectedId) setSelected(id);
        if (tick === null) tick = setInterval(function () { refreshTimes(view); }, TICK_MS);
        thread.show();
        render();
      },
      hide: function () {
        visible = false;
        thread.hide();
        if (tick !== null) clearInterval(tick);
        tick = null;
      },
      // What Hunter is looking at, for quick chat's context line: the open
      // agent's name and state, or the view's name alone.
      context: function () {
        var agent = visible ? selectedAgent() : null;
        if (!agent || !isPersona(agent)) return { view: 'agents' };
        var line = stateLine(agent);
        return { view: 'agents', label: agent.name, detail: 'State: ' + (line ? line.text : 'Idle') };
      },
    };
  }

  window.DashboardAgents = {
    create: create,
    // For thread-view.js, which renders one thread's column with these.
    shared: {
      element: element,
      button: button,
      timeSpan: timeSpan,
      refreshTimes: refreshTimes,
      call: call,
      post: post,
      parse: parse,
      detail: detail,
      detailList: detailList,
      isPersona: isPersona,
      isSession: isSession,
      isTerminal: isTerminal,
      hasThread: hasThread,
      turnOpen: turnOpen,
      providerName: providerName,
      shortPath: shortPath,
      displayName: displayName,
      modelNameOf: modelNameOf,
      effortNameOf: effortNameOf,
      modelRefusal: modelRefusal,
      questionsOf: questionsOf,
      routeBase: routeBase,
      messageRenderer: messageRenderer,
      EFFORTS: EFFORTS,
      SESSION_ID: SESSION_ID,
      TERMINAL_ONLY: TERMINAL_ONLY,
      FORWARDED_NOTE: FORWARDED_NOTE,
      SCROLL_END_PX: SCROLL_END_PX,
      THREAD_TIMEOUT_MS: THREAD_TIMEOUT_MS,
      TICK_MS: TICK_MS,
    },
    contextSummary: contextSummary,
    groups: groups,
    groupName: groupName,
    pinnedPersona: pinnedPersona,
    roleChip: roleChip,
    errorSentence: errorSentence,
    composerReason: composerReason,
    modelButtonText: modelButtonText,
    refusalSentence: refusalSentence,
    previewText: previewText,
    agentName: agentName,
    delegationParts: delegationParts,
    mentionIds: mentionIds,
    mentionCandidates: mentionCandidates,
    stateLine: stateLine,
    formatInput: formatInput,
    displayName: displayName,
    shortPath: shortPath,
    sessionsSentence: sessionsSentence,
    codexSentence: codexSentence,
    cmuxSentence: cmuxSentence,
    terminalReason: terminalReason,
    openRefusal: openRefusal,
    terminalState: terminalState,
    specToCron: specToCron,
    cronToSpec: cronToSpec,
    nextWords: nextWords,
    routineChip: routineChip,
    runNote: runNote,
    routineRefusal: routineRefusal,
    testRunRefusal: testRunRefusal,
  };
}());
