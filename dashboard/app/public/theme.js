// The header menu and its browser-local theme choice. View navigation stays
// with shell.js; Settings emits the same popstate signal after changing the
// URL so it can open without reloading the dashboard.
(function () {
  'use strict';

  var api = window.DashboardTheme;
  var toggle = document.getElementById('app-menu-toggle');
  var menu = document.getElementById('app-menu');
  var settings = document.getElementById('settings-link');
  if (!api || !toggle || !menu) return;

  function syncChoice() {
    var inputs = menu.querySelectorAll('input[name="dashboard-theme"]');
    for (var i = 0; i < inputs.length; i += 1) inputs[i].checked = inputs[i].value === api.choice();
  }

  function open() {
    syncChoice();
    menu.hidden = false;
    toggle.setAttribute('aria-expanded', 'true');
    var selected = menu.querySelector('input[name="dashboard-theme"]:checked');
    if (selected) selected.focus();
  }

  function close(restore) {
    menu.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
    if (restore) toggle.focus();
  }

  toggle.addEventListener('click', function () {
    if (menu.hidden) open();
    else close(true);
  });
  menu.addEventListener('change', function (event) {
    if (event.target && event.target.name === 'dashboard-theme') api.set(event.target.value);
  });
  menu.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      close(true);
    }
  });
  document.addEventListener('click', function (event) {
    if (menu.hidden) return;
    // An entry that navigates (Brief, on a phone) closes the menu too; the
    // shell's own link handler still routes it.
    var entry = event.target.closest && event.target.closest('a.menu-entry');
    if (entry && entry !== settings) close(false);
    else if (!menu.contains(event.target) && !toggle.contains(event.target)) close(false);
  });
  if (settings) settings.addEventListener('click', function (event) {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    close(false);
    history.pushState(null, '', '/health');
    window.dispatchEvent(new PopStateEvent('popstate'));
    requestAnimationFrame(function () {
      document.getElementById('settings-card').scrollIntoView({ block: 'start' });
    });
  });
}());
