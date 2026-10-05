// Agent avatars: one round picture beside an agent's name, the same in the
// agents list, the thread header, quick chat, notifications, and delegation
// lines. An agent whose snapshot entry carries `avatar` (its picture's
// mtime, hub.mjs) shows /api/agents/<id>/avatar?v=<avatar>; one without,
// or whose picture fails to load, shows its initials (data-initials, drawn
// by CSS) on one of the
// --badge-0 to --badge-5 colours, chosen from its id so it never changes.
// The name always sits beside it, so the circle is hidden from assistive
// technology.
//
// window.DashboardAvatar:
//   node(agent, size) -> a new <span class="avatar avatar-<size>">; size is
//     'small' (24px, lists), 'large' (28px, headers), or 'inline' (24px,
//     beside a name inside a sentence). `agent` is a
//     snapshot agent, or { id, name } for one the registry no longer lists.
//   update(node, agent) -> refills a node made by node() when the agent's
//     id, name, or picture changed since, and leaves it alone otherwise.
//   initials(name) -> "SB" for "Second brain", "CF" for "CFO".
//   colourIndex(id) -> 0..5.
(function () {
  'use strict';

  var BADGE_COLOURS = 6;

  function initials(name) {
    var words = String(name || '').split(/\s+/).filter(Boolean);
    if (words.length === 0) return '';
    if (words.length === 1) return Array.from(words[0]).slice(0, 2).join('').toUpperCase();
    return words.slice(0, 2).map(function (word) { return Array.from(word)[0]; }).join('').toUpperCase();
  }

  function colourIndex(id) {
    var hash = 0;
    var text = String(id || '');
    for (var i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
    return hash % BADGE_COLOURS;
  }

  function keyOf(agent) {
    return JSON.stringify([agent.id, agent.name || '', typeof agent.avatar === 'string' ? agent.avatar : null]);
  }

  function base(node) {
    var size = node.getAttribute('data-avatar-size');
    return size === 'inline' ? 'avatar avatar-small avatar-inline' : 'avatar avatar-' + size;
  }

  // Drawn from the attribute by CSS, so the initials never join the text
  // of the sentence or row the avatar sits in.
  function showInitials(node, agent) {
    node.textContent = '';
    node.setAttribute('data-initials', initials(agent.name || agent.id));
    node.className = base(node) + ' avatar-badge-' + colourIndex(agent.id);
  }

  function fill(node, agent) {
    node.textContent = '';
    node.removeAttribute('data-initials');
    node.setAttribute('data-avatar', agent.id);
    node.setAttribute('data-avatar-key', keyOf(agent));
    if (typeof agent.avatar !== 'string' || !agent.avatar) {
      showInitials(node, agent);
      return;
    }
    node.className = base(node) + ' avatar-image';
    var image = document.createElement('img');
    image.alt = '';
    image.decoding = 'async';
    image.addEventListener('error', function () {
      if (image.parentNode === node) showInitials(node, agent);
    });
    image.src = '/api/agents/' + encodeURIComponent(agent.id) + '/avatar?v=' + encodeURIComponent(agent.avatar);
    node.appendChild(image);
  }

  function node(agent, size) {
    var span = document.createElement('span');
    span.setAttribute('data-avatar-size', size === 'large' || size === 'inline' ? size : 'small');
    span.setAttribute('aria-hidden', 'true');
    fill(span, agent);
    return span;
  }

  function update(span, agent) {
    if (span.getAttribute('data-avatar-key') === keyOf(agent)) return;
    fill(span, agent);
  }

  window.DashboardAvatar = { node: node, update: update, initials: initials, colourIndex: colourIndex };
})();
