(function () {
  'use strict';

  var configElement = document.getElementById('brief-bridge-config');
  var config;
  try {
    config = JSON.parse(configElement.textContent);
  } catch (_error) {
    setStatus('Save unavailable. Use Copy instead.');
    return;
  }

  var pending = false;
  var timeoutMilliseconds = 12000;

  function setStatus(text) {
    var status = document.getElementById('status');
    if (status) status.textContent = text;
  }

  // Put the viewer's own mark counts back after a transient message, as the
  // original viewer did. `persist` is the viewer's global function.
  function restoreCountsLater(delay) {
    setTimeout(function () {
      try {
        if (typeof persist === 'function') persist();
      } catch (_error) {
        // Leave the transient message in place.
      }
    }, delay);
  }

  // ITEMS and fb are the viewer's global lexical bindings, not window
  // properties, so they are read by name.
  function draft() {
    return {
      date: config.date,
      revision: config.revision,
      overall: document.getElementById('overall').value,
      items: ITEMS.map(function (item) {
        var value = fb[item.id] || {};
        return {
          id: item.id,
          mark: value.m === 'a' ? 'approved' : value.m === 'd' ? 'dismissed' : null,
          note: typeof value.n === 'string' ? value.n : '',
        };
      }),
    };
  }

  function normalized(value) {
    return value.replace(/\r\n?/g, '\n');
  }

  function singleLine(value) {
    return String(value).replace(/\r\n|[\r\n\u2028\u2029]/g, ' ');
  }

  // Same rendering as lib/feedback.mjs renderFeedbackMarkdown.
  function markdown(value) {
    var lines = ['# Brief feedback — ' + value.date, ''];
    var overall = normalized(value.overall).trim();
    if (overall) lines.push('## Overall', '', overall, '');
    var section = null;
    value.items.forEach(function (saved, index) {
      var item = ITEMS[index];
      if (item.sec !== section) {
        section = item.sec;
        lines.push('## ' + section, '');
      }
      var tag = saved.mark === 'approved' ? 'APPROVED' : saved.mark === 'dismissed' ? 'DISMISSED' : 'no mark';
      var text = typeof item.text === 'string' && item.text ? item.text : item.lede;
      lines.push('- ' + tag + ' — ' + singleLine(text));
      if (saved.note.trim()) {
        var noteLines = normalized(saved.note).split('\n');
        lines.push('  - note: ' + noteLines[0]);
        noteLines.slice(1).forEach(function (line) { lines.push('    ' + line); });
      }
    });
    return lines.join('\n') + '\n';
  }

  window.saveOut = function () {
    if (pending) return;
    var body;
    try {
      body = JSON.stringify(draft());
    } catch (_error) {
      setStatus('Save unavailable, draft kept. Use Copy instead.');
      return;
    }

    var button = document.querySelector('button.save');
    var timer = null;
    function settle() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      pending = false;
      if (button) button.disabled = false;
    }

    try {
      pending = true;
      if (button) button.disabled = true;
      setStatus('Saving…');
      var controller = typeof AbortController === 'function' ? new AbortController() : null;
      if (controller) timer = setTimeout(function () { controller.abort(); }, timeoutMilliseconds);
      fetch('/api/brief/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: body,
        signal: controller ? controller.signal : undefined,
      }).then(function (response) {
        if (response.ok) {
          setStatus('Saved');
          restoreCountsLater(3000);
          return;
        }
        if (response.status === 409) throw new Error('changed');
        if (response.status === 413) throw new Error('large');
        throw new Error('failed');
      }).catch(function (error) {
        var reason = error && error.message;
        if (reason === 'changed') setStatus('Save failed: a newer brief is available. Load it from the dashboard, then save again.');
        else if (reason === 'large') setStatus('Save failed: feedback is too long. Draft kept.');
        else setStatus('Save failed, draft kept. Use Copy instead.');
      }).then(settle, settle);
    } catch (_error) {
      settle();
      setStatus('Save failed, draft kept. Use Copy instead.');
    }
  };

  function copyWithSelection(text) {
    var area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.top = '-1000px';
    area.style.opacity = '0';
    document.body.appendChild(area);
    try {
      area.select();
      return document.execCommand('copy') === true;
    } finally {
      document.body.removeChild(area);
    }
  }

  window.copyOut = function () {
    var text;
    try {
      text = markdown(draft());
    } catch (_error) {
      setStatus('Copy blocked');
      return;
    }

    function copied() {
      setStatus('Copied');
      restoreCountsLater(2000);
    }
    function fallback() {
      var ok = false;
      try {
        ok = copyWithSelection(text);
      } catch (_error) {
        ok = false;
      }
      if (ok) copied();
      else setStatus('Copy blocked');
    }

    var clipboard = typeof navigator !== 'undefined' && navigator ? navigator.clipboard : null;
    if (!clipboard || typeof clipboard.writeText !== 'function') {
      fallback();
      return;
    }
    try {
      Promise.resolve(clipboard.writeText(text)).then(copied, fallback);
    } catch (_error) {
      fallback();
    }
  };
}());
