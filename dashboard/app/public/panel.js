// The side panel between the rail and every view, and its toggle at the head
// of the header. On a desk (from 720px) the toggle collapses the panel on
// every view and the choice is stored; on a phone the panel is a drawer from
// the left over a scrim, opened by the toggle and closed by the scrim,
// Escape, closePanel(), or another view (shell.js), and nothing is stored.
// openPanel() and closePanel() act only on that drawer.
// Loaded before shell.js, which reaches it through window.DashboardPanel.
(function () {
  'use strict';

  var STORAGE_KEY = 'dashboard.panelHidden';
  // The Agents list's own toggle stored its choice here before the panel.
  var OLD_KEY = 'dashboard.agentsListHidden';

  var shell = document.querySelector('.shell');
  var toggle = document.getElementById('panel-toggle');
  var scrim = document.getElementById('panel-scrim');
  if (!shell || !toggle || !scrim) return;
  var phone = window.matchMedia('(max-width: 719.98px)');

  function readHidden() {
    try {
      var old = window.localStorage.getItem(OLD_KEY);
      if (old !== null) {
        window.localStorage.removeItem(OLD_KEY);
        if (old === '1' && window.localStorage.getItem(STORAGE_KEY) === null) window.localStorage.setItem(STORAGE_KEY, '1');
      }
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

  function isPhone() { return phone.matches; }

  function shown() {
    return isPhone() ? shell.classList.contains('panel-open') : !shell.classList.contains('panel-collapsed');
  }

  function render() {
    var open = shown();
    var label = open ? 'Hide side panel' : 'Show side panel';
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-label', label);
    toggle.setAttribute('title', label);
    scrim.hidden = !(isPhone() && open);
  }

  // The drawer, on a phone; a desk's panel answers only to the toggle.
  function openPanel() {
    if (!isPhone()) return;
    shell.classList.add('panel-open');
    render();
  }

  function closePanel() {
    if (!isPhone()) return;
    shell.classList.remove('panel-open');
    render();
  }

  function setCollapsed(hidden) {
    shell.classList.toggle('panel-collapsed', hidden);
    writeHidden(hidden);
    render();
  }

  shell.classList.toggle('panel-collapsed', readHidden());
  render();

  toggle.addEventListener('click', function () {
    if (isPhone()) {
      if (shown()) closePanel();
      else openPanel();
    } else {
      setCollapsed(shown());
    }
    toggle.focus();
  });

  scrim.addEventListener('click', closePanel);

  // On window, so every layer's own Escape on the document (quick chat,
  // notifications, the menu) runs first and the drawer closes only when
  // none of them took the key.
  window.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape' || event.defaultPrevented || !isPhone() || !shown()) return;
    closePanel();
    toggle.focus();
  });

  // A phone's drawer does not outlive the phone; the desk's stored choice
  // is kept apart from it throughout.
  phone.addEventListener('change', function () {
    if (!isPhone()) shell.classList.remove('panel-open');
    render();
  });

  window.DashboardPanel = { openPanel: openPanel, closePanel: closePanel, isPhone: isPhone };
}());
