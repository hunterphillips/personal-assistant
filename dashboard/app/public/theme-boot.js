// Applies the saved theme before the stylesheet loads, so a dark page never
// paints light first. Storage can be unavailable in private or locked-down
// browsers; in that case the system choice is used for this page only.
//
// It also applies the side panel's stored width (panel.js owns it) as
// --panel-w on the root, so a widened panel does not paint at the default
// first. A missing or unreadable value leaves the stylesheet's default.
(function () {
  'use strict';

  var KEY = 'dashboard-theme';
  var choices = { light: true, dark: true, system: true };
  var media = window.matchMedia('(prefers-color-scheme: dark)');
  var choice = read();

  function read() {
    try {
      var saved = window.localStorage.getItem(KEY);
      return choices[saved] ? saved : 'system';
    } catch (_error) {
      return 'system';
    }
  }

  function resolved() {
    return choice === 'system' ? (media.matches ? 'dark' : 'light') : choice;
  }

  function apply(notify) {
    var theme = resolved();
    document.documentElement.dataset.theme = theme;
    if (notify) window.dispatchEvent(new CustomEvent('dashboardthemechange', { detail: { choice: choice, resolved: theme } }));
  }

  function set(next) {
    choice = choices[next] ? next : 'system';
    try {
      window.localStorage.setItem(KEY, choice);
    } catch (_error) {
      // The visible choice still applies for this page.
    }
    apply(true);
  }

  media.addEventListener('change', function () {
    if (choice === 'system') apply(true);
  });
  apply(false);
  window.DashboardTheme = { choice: function () { return choice; }, resolved: resolved, set: set };
}());

(function () {
  'use strict';

  try {
    var width = Number(window.localStorage.getItem('dashboard.panelWidth'));
    if (width > 0 && isFinite(width)) {
      width = Math.round(Math.min(480, Math.max(220, width)));
      document.documentElement.style.setProperty('--panel-w', width + 'px');
    }
  } catch (_error) {
    // No storage: the panel opens at the default width.
  }
}());
