// Agent avatars: one round picture beside an agent's name, the same in the
// agents list, the thread header, quick chat, notifications, and delegation
// lines. An agent whose snapshot entry carries `avatar` (its picture's
// mtime, hub.mjs) shows /api/agents/<id>/avatar?v=<avatar>; one without,
// or whose picture fails to load, shows its initials (data-initials, drawn
// by CSS) on one of the --badge-0 to --badge-5 colours, chosen from its id
// so it never changes.
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
  // src -> { state: 'loading' | 'ready' | 'failed', image, waiting }: each picture
  // is fetched once by a probe image, and every node showing it waits on
  // that one load, so a list that redraws on every snapshot change neither
  // refetches a picture nor retries one that failed. A new version is a
  // new src.
  var loads = {};
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

  function showImage(node, src) {
    node.className = base(node) + ' avatar-image';
    var image = document.createElement('img');
    image.alt = '';
    image.src = src;
    node.appendChild(image);
  }

  // The probe's outcome, applied to every node still waiting on `src`
  // (one refilled since for another agent or version is skipped).
  function settle(src, state) {
    var entry = loads[src];
    entry.state = state;
    var waiting = entry.waiting;
    entry.waiting = [];
    for (var i = 0; i < waiting.length; i += 1) {
      var node = waiting[i].node;
      if (node.getAttribute('data-avatar-src') !== src) continue;
      if (state === 'ready') showImage(node, src);
      else showInitials(node, waiting[i].agent);
    }
  }

  function load(src) {
    if (loads[src]) return loads[src];
    var image = new Image();
    loads[src] = { state: 'loading', image: image, waiting: [] };
    image.addEventListener('load', function () { settle(src, 'ready'); });
    image.addEventListener('error', function () { settle(src, 'failed'); });
    image.src = src;
    return loads[src];
  }

  function fill(node, agent) {
    node.textContent = '';
    node.removeAttribute('data-initials');
    node.removeAttribute('data-avatar-src');
    node.setAttribute('data-avatar', agent.id);
    node.setAttribute('data-avatar-key', keyOf(agent));
    var src = typeof agent.avatar === 'string' && agent.avatar
      ? '/api/agents/' + encodeURIComponent(agent.id) + '/avatar?v=' + encodeURIComponent(agent.avatar)
      : null;
    var entry = src ? load(src) : null;
    if (!entry || entry.state === 'failed') {
      showInitials(node, agent);
      return;
    }
    node.setAttribute('data-avatar-src', src);
    if (entry.state === 'ready') {
      showImage(node, src);
      return;
    }
    // An empty circle until the probe answers.
    node.className = base(node) + ' avatar-image';
    entry.waiting.push({ node: node, agent: agent });
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
