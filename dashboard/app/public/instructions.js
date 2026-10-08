// An instructions panel: a button (in the header for Ideas, in the brief's
// overlay for the brief) that opens a panel showing an agent's instructions
// file as prose (read each time it opens) with a composer that sends a
// change to the agent that owns the file and opens its thread. ideas.js
// makes one for the Ideas criteria, shell.js one for the brief's rules; the
// markup for each is in the page, its ids prefixed `<prefix>-instructions`.
//
// DashboardInstructions.create({ prefix, readPath, proposePath, openAgent,
// refusalSentence }) returns { show, hide, setIntro }. show() and hide()
// show and hide the button (the panel closes with it); setIntro(text) sets
// the sentence under the heading. openAgent(id) is called with the agent
// the daemon named after a change was sent; refusalSentence(status, code)
// is the sentence for a refused send. Buttons carry no data-action, which
// the shell's own click handler owns. Every text node is set with
// textContent.
(function () {
  'use strict';

  var TIMEOUT_MS = 8000;
  var NO_ANSWER = 'The dashboard did not respond.';

  function element(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function arrayOf(value) {
    return Array.isArray(value) ? value : [];
  }

  function objectsIn(value) {
    return arrayOf(value).filter(function (entry) { return entry !== null && typeof entry === 'object'; });
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

  function table(block) {
    var node = element('table', 'instructions-table');
    var head = element('thead');
    var headRow = element('tr');
    arrayOf(block.head).forEach(function (text) { headRow.appendChild(element('th', null, text)); });
    head.appendChild(headRow);
    node.appendChild(head);
    var body = element('tbody');
    arrayOf(block.rows).forEach(function (cells) {
      var row = element('tr');
      arrayOf(cells).forEach(function (text) { row.appendChild(element('td', null, text)); });
      body.appendChild(row);
    });
    node.appendChild(body);
    return node;
  }

  function prose(blocks) {
    var node = element('div', 'goal-prose');
    objectsIn(blocks).forEach(function (block) {
      if (block.type === 'p') node.appendChild(element('p', null, block.text));
      else if (block.type === 'h') node.appendChild(element('h4', null, block.text));
      else if (block.type === 'list') {
        var list = element(block.ordered === true ? 'ol' : 'ul');
        arrayOf(block.items).forEach(function (text) { list.appendChild(element('li', null, text)); });
        node.appendChild(list);
      } else if (block.type === 'table') node.appendChild(table(block));
    });
    return node;
  }

  function create(options) {
    var id = function (suffix) { return options.prefix + '-instructions' + (suffix ? '-' + suffix : ''); };
    var toggle = document.getElementById(id('toggle'));
    var panel = document.getElementById(id(''));
    var panelBody = document.getElementById(id('body'));
    var intro = panel.querySelector('.instructions-intro');
    var form = document.getElementById(id('form'));
    var input = document.getElementById(id('input'));
    var send = form.querySelector('button[type="submit"]');
    var panelReason = document.getElementById(id('reason'));
    var sequence = 0;
    var proposing = false;

    function showInstructions(lines, blocks) {
      panelBody.textContent = '';
      lines.forEach(function (text) { panelBody.appendChild(element('p', 'instructions-problem', text)); });
      if (blocks) panelBody.appendChild(prose(blocks));
    }

    function load() {
      var current = ++sequence;
      request(options.readPath, { method: 'GET' }).then(function (result) {
        if (current !== sequence) return;
        var body = result && result.status === 200 ? result.body : null;
        if (!body || !Array.isArray(body.blocks)) {
          showInstructions([NO_ANSWER], null);
          return;
        }
        showInstructions(typeof body.problem === 'string' ? [body.problem] : [], body.blocks);
      });
    }

    function openPanel() {
      panel.hidden = false;
      toggle.setAttribute('aria-expanded', 'true');
      panelReason.hidden = true;
      panelBody.textContent = '';
      load();
      input.focus();
    }

    // fromUser: a Cancel, Escape, or second press, which puts focus back on
    // the button. A sent change also clears the text.
    function closePanel(fromUser) {
      panel.hidden = true;
      toggle.setAttribute('aria-expanded', 'false');
      if (fromUser) toggle.focus();
    }

    function propose() {
      if (proposing) return;
      var text = input.value.trim();
      if (!text) {
        input.focus();
        return;
      }
      proposing = true;
      send.disabled = true;
      panelReason.hidden = true;
      request(options.proposePath, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: text }),
      }).then(function (result) {
        proposing = false;
        send.disabled = false;
        if (result && result.status === 202) {
          input.value = '';
          closePanel(false);
          options.openAgent(result.body && typeof result.body.agentId === 'string' ? result.body.agentId : null);
          return;
        }
        var code = result && result.body && typeof result.body.error === 'string' ? result.body.error : null;
        panelReason.textContent = result ? options.refusalSentence(result.status, code) : NO_ANSWER;
        panelReason.hidden = false;
      });
    }

    toggle.addEventListener('click', function () {
      if (panel.hidden) openPanel();
      else closePanel(true);
    });
    document.getElementById(id('cancel')).addEventListener('click', function () {
      closePanel(true);
    });
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      propose();
    });
    panel.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') {
        event.preventDefault();
        closePanel(true);
      }
    });
    input.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        propose();
      }
    });

    return {
      show: function () { toggle.hidden = false; },
      hide: function () {
        toggle.hidden = true;
        if (!panel.hidden) closePanel(false);
      },
      setIntro: function (text) { if (intro) intro.textContent = text; },
    };
  }

  window.DashboardInstructions = { create: create };
}());
