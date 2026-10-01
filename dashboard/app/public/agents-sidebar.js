// The Agents view's toggle button that hides and shows the agents list, so
// an open thread can take the full width. The button lives in the pane
// that is open: at the top right of the list, beside the Agents heading,
// while the list shows; at the left end of the thread header, before the
// agent name, once the list is hidden. This script moves the one button
// between those two slots. The choice is kept in localStorage and applied
// here, at load, before the view paints, so there is no flash. Desk only:
// the button is hidden under the phone media query in styles.css, and the
// collapsed grid rules only take effect from 720px, so this never touches
// the phone list/thread switch agents.js owns.
(function () {
  'use strict';

  var STORAGE_KEY = 'dashboard.agentsListHidden';

  var view = document.getElementById('view-agents');
  var toggle = document.getElementById('agents-toggle');
  var listHead = document.getElementById('agents-list-head');
  var threadHeader = document.querySelector('#agent-panel .thread-header');
  if (!view || !toggle || !listHead || !threadHeader) return;

  function readHidden() {
    try {
      return window.localStorage.getItem(STORAGE_KEY) === '1';
    } catch (err) {
      return false;
    }
  }

  function writeHidden(hidden) {
    try {
      if (hidden) window.localStorage.setItem(STORAGE_KEY, '1');
      else window.localStorage.removeItem(STORAGE_KEY);
    } catch (err) {
      // No storage: the choice just does not persist.
    }
  }

  function place(hidden) {
    var focused = document.activeElement === toggle;
    if (hidden) {
      threadHeader.insertBefore(toggle, threadHeader.firstChild);
    } else {
      listHead.appendChild(toggle);
    }
    if (focused) toggle.focus();
  }

  function apply(hidden) {
    view.classList.toggle('agents-collapsed', hidden);
    toggle.setAttribute('aria-expanded', String(!hidden));
    toggle.setAttribute('aria-label', hidden ? 'Show agents' : 'Hide agents');
    place(hidden);
  }

  apply(readHidden());

  toggle.addEventListener('click', function () {
    var hidden = !view.classList.contains('agents-collapsed');
    apply(hidden);
    writeHidden(hidden);
    toggle.focus();
  });
}());
