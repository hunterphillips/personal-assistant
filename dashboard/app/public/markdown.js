// Markdown for thread messages: the agents' replies, your messages, system
// lines, and the brief's memo (agents.js). A small reader for what agents
// write in chat, not a CommonMark implementation.
//
// Blocks: paragraphs, `#` to `######` headings (shown as three modest
// sizes), `-`, `*`, `+` and `1.` lists nested by indent, fenced code blocks
// (``` or ~~~, with an optional language), `>` blockquotes, and `---`
// rules. A line break inside a paragraph stays a line break, as in a chat.
// Inline: **bold**, *italic* and _italic_, `code`, [text](url), <url>, bare
// http(s) URLs, and backslash escapes. Everything else is text.
//
// Safety is by construction: nodes are built with createElement and
// textContent, so raw HTML renders as the characters it is. A link is made
// only for http:, https:, and mailto:; any other link renders as its source
// text. Every link opens in a new tab with rel="noopener noreferrer".
//
// window.DashboardMarkdown:
//   parse(text) -> [block]       the tree, plain data
//   renderInto(node, text, { mentions })
//                                appends the rendered blocks to node.
//                                `mentions` is an optional list of
//                                { id, name }: an "@Name" or "@id" in the
//                                text (case-insensitive, the longest name
//                                first) becomes <span class="mention"
//                                data-mention="id">, built from text nodes
//                                only, never inside code
//   plain(text) -> string        the text with its markers stripped, on one
//                                line, for row previews and summaries
(function () {
  'use strict';

  var FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\s`]*)[^`]*$/;
  var RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
  var HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
  var QUOTE = /^ {0,3}> ?(.*)$/;
  var BULLET = /^( *)([-*+])(?:([ \t]+)(.*))?$/;
  var ORDERED = /^( *)(\d{1,9})([.)])(?:([ \t]+)(.*))?$/;
  var ESCAPABLE = /[!-\/:-@\[-`{-~]/;
  var SAFE_HREF = /^(?:https?:\/\/|mailto:)[^\s\x00-\x1f\x7f]+$/i;
  var LANGUAGE = /^[A-Za-z0-9_+#.-]{1,32}$/;

  function splitLines(text) {
    return String(text).replace(/\r\n?/g, '\n').split('\n').map(function (line) {
      return line.replace(/^[ \t]+/, function (space) { return space.replace(/\t/g, '    '); });
    });
  }

  function isBlank(line) { return /^\s*$/.test(line); }

  function indentOf(line) { return /^ */.exec(line)[0].length; }

  function dedent(line, count) {
    var n = Math.min(count, indentOf(line));
    return line.slice(n);
  }

  // A list item's marker, or null. A rule such as `* * *` is not an item.
  function marker(line) {
    if (RULE.test(line)) return null;
    var m = BULLET.exec(line);
    if (m) {
      return { indent: m[1].length, ordered: false, start: 1, content: m[4] || '',
        contentIndent: m[1].length + 1 + Math.min(m[3] ? m[3].length : 1, 4) };
    }
    m = ORDERED.exec(line);
    if (m) {
      return { indent: m[1].length, ordered: true, start: Number(m[2]), content: m[5] || '',
        contentIndent: m[1].length + m[2].length + 1 + Math.min(m[4] ? m[4].length : 1, 4) };
    }
    return null;
  }

  // Whether the line opens a block that ends a paragraph. An ordered list
  // breaks into a paragraph only when it starts at 1, so a sentence that
  // wraps onto "2024. was" stays a sentence.
  function startsBlock(line) {
    if (FENCE.test(line) || RULE.test(line) || HEADING.test(line) || QUOTE.test(line)) return true;
    var m = marker(line);
    return !!m && m.content !== '' && (!m.ordered || m.start === 1);
  }

  function parseBlocks(lines) {
    var blocks = [];
    var i = 0;
    var m;
    while (i < lines.length) {
      var line = lines[i];
      if (isBlank(line)) { i += 1; continue; }

      if ((m = FENCE.exec(line))) {
        var fence = m[1];
        var fenceIndent = indentOf(line);
        var body = [];
        var closing = new RegExp('^ {0,3}' + (fence[0] === '`' ? '`' : '~') + '{' + fence.length + ',}[ \\t]*$');
        i += 1;
        while (i < lines.length && !closing.test(lines[i])) {
          body.push(dedent(lines[i], fenceIndent));
          i += 1;
        }
        i += 1;
        blocks.push({ type: 'code', lang: LANGUAGE.test(m[2]) ? m[2] : '', text: body.join('\n') });
        continue;
      }

      if (RULE.test(line)) { blocks.push({ type: 'rule' }); i += 1; continue; }

      if ((m = HEADING.exec(line))) {
        blocks.push({ type: 'heading', level: Math.min(m[1].length, 3), inline: parseInline(m[2] || '') });
        i += 1;
        continue;
      }

      if (QUOTE.test(line)) {
        var quoted = [];
        while (i < lines.length && (m = QUOTE.exec(lines[i]))) {
          quoted.push(m[1]);
          i += 1;
        }
        blocks.push({ type: 'quote', blocks: parseBlocks(quoted) });
        continue;
      }

      if (marker(line)) {
        i = parseList(lines, i, blocks);
        continue;
      }

      var text = [line.trim()];
      i += 1;
      while (i < lines.length && !isBlank(lines[i]) && !startsBlock(lines[i])) {
        text.push(lines[i].trim());
        i += 1;
      }
      blocks.push({ type: 'paragraph', inline: parseInline(text.join('\n')) });
    }
    return blocks;
  }

  // One list from lines[i] on, pushed onto blocks; returns the index after
  // it. A line indented two or more spaces past the list's markers belongs
  // to the item above it, so nested lists and continued paragraphs are
  // parsed again from the item's own lines.
  function parseList(lines, i, blocks) {
    var first = marker(lines[i]);
    var base = first.indent;
    var inside = base + 2;
    var items = [];
    var current = null;
    while (i < lines.length) {
      var line = lines[i];
      if (isBlank(line)) {
        var j = i + 1;
        while (j < lines.length && isBlank(lines[j])) j += 1;
        if (j === lines.length) break;
        var next = marker(lines[j]);
        if (indentOf(lines[j]) >= inside) {
          for (var k = i; k < j; k += 1) current.lines.push('');
          i = j;
          continue;
        }
        if (next && next.ordered === first.ordered) { i = j; continue; }
        break;
      }
      var m = marker(line);
      var indent = indentOf(line);
      if (current && indent >= inside) {
        current.lines.push(dedent(line, Math.min(indent, current.contentIndent)));
      } else if (m) {
        if (m.ordered !== first.ordered) break;
        current = { lines: [m.content], contentIndent: m.contentIndent };
        items.push(current);
      } else if (current.lines[current.lines.length - 1] !== '' && !startsBlock(line)) {
        current.lines.push(line.trim());
      } else {
        break;
      }
      i += 1;
    }
    blocks.push({
      type: 'list',
      ordered: first.ordered,
      start: first.start,
      items: items.map(function (item) { return { blocks: parseBlocks(item.lines) }; }),
    });
    return i;
  }

  function runLength(s, i, ch) {
    var n = 0;
    while (s.charAt(i + n) === ch) n += 1;
    return n;
  }

  function isWord(ch) { return /[A-Za-z0-9]/.test(ch); }

  function isSpace(ch) { return ch === '' || /\s/.test(ch); }

  // The index of the next run of exactly `count` backticks from i, or -1.
  function closingBackticks(s, i, count) {
    while (i < s.length) {
      if (s.charAt(i) === '`') {
        var run = runLength(s, i, '`');
        if (run === count) return i;
        i += run;
      } else {
        i += 1;
      }
    }
    return -1;
  }

  // Bold, italic, or both from the delimiter run at i, or null. The closer
  // is the first run of the same length; failing that, the first longer
  // run, whose last characters close it (so `**a *b***` nests).
  function emphasis(s, i, noLinks) {
    var ch = s.charAt(i);
    var count = runLength(s, i, ch);
    if (count > 3 || isSpace(s.charAt(i + count))) return null;
    if (ch === '_' && i > 0 && isWord(s.charAt(i - 1))) return null;
    var exact = -1;
    var longer = -1;
    var j = i + count;
    while (j < s.length && exact < 0) {
      var c = s.charAt(j);
      if (c === '\\') { j += 2; continue; }
      if (c === '`') {
        var ticks = runLength(s, j, '`');
        var end = closingBackticks(s, j + ticks, ticks);
        j = end < 0 ? j + ticks : end + ticks;
        continue;
      }
      if (c !== ch) { j += 1; continue; }
      var run = runLength(s, j, ch);
      var closes = j > i + count && !isSpace(s.charAt(j - 1)) && !(ch === '_' && isWord(s.charAt(j + run)));
      if (closes && run === count) exact = j;
      else if (closes && run > count && longer < 0) longer = j + run - count;
      j += run;
    }
    var close = exact >= 0 ? exact : longer;
    if (close < 0) return null;
    var children = parseInline(s.slice(i + count, close), noLinks);
    var node;
    if (count === 1) node = { type: 'em', children: children };
    else if (count === 2) node = { type: 'strong', children: children };
    else node = { type: 'em', children: [{ type: 'strong', children: children }] };
    return { node: node, end: close + count };
  }

  // [text](url) at i: { end, label, href } with href null when the
  // destination is not a link we make, or null when it is not link syntax.
  function linkAt(s, i) {
    var depth = 0;
    var j = i;
    for (; j < s.length; j += 1) {
      var c = s.charAt(j);
      if (c === '\\') { j += 1; continue; }
      if (c === '[') depth += 1;
      else if (c === ']') { depth -= 1; if (depth === 0) break; }
    }
    if (j >= s.length || s.charAt(j + 1) !== '(') return null;
    var label = s.slice(i + 1, j);
    var k = j + 2;
    while (s.charAt(k) === ' ') k += 1;
    var href = '';
    if (s.charAt(k) === '<') {
      var close = s.indexOf('>', k);
      if (close < 0) return null;
      href = s.slice(k + 1, close);
      k = close + 1;
    } else {
      var parens = 0;
      var startHref = k;
      for (; k < s.length; k += 1) {
        var d = s.charAt(k);
        if (/\s/.test(d)) break;
        if (d === '(') parens += 1;
        else if (d === ')') { if (parens === 0) break; parens -= 1; }
      }
      href = s.slice(startHref, k);
    }
    var title = /^[ \t\n]+(?:"[^"]*"|'[^']*')/.exec(s.slice(k));
    if (title) k += title[0].length;
    while (s.charAt(k) === ' ') k += 1;
    if (s.charAt(k) !== ')') return null;
    return { end: k + 1, label: label, href: safeHref(href) };
  }

  function safeHref(href) {
    var value = String(href).trim();
    return SAFE_HREF.test(value) ? value : null;
  }

  // A bare http(s) URL at i, without the punctuation that ends a sentence
  // around it, or null.
  function bareUrl(s, i) {
    if (i > 0 && isWord(s.charAt(i - 1))) return null;
    var m = /^https?:\/\/[^\s<>]+/i.exec(s.slice(i));
    if (!m) return null;
    var url = m[0].replace(/[.,:;!?'"*_]+$/, '');
    while (url.charAt(url.length - 1) === ')' && url.split('(').length < url.split(')').length) {
      url = url.slice(0, -1).replace(/[.,:;!?'"*_]+$/, '');
    }
    return /^https?:\/\/[^\/]/i.test(url) ? url : null;
  }

  function pushText(out, text) {
    var last = out[out.length - 1];
    if (last && last.type === 'text') last.text += text;
    else out.push({ type: 'text', text: text });
  }

  function parseInline(s, noLinks) {
    var out = [];
    var buffer = '';
    var i = 0;
    function flush() {
      if (buffer) pushText(out, buffer);
      buffer = '';
    }
    while (i < s.length) {
      var c = s.charAt(i);
      var next = s.charAt(i + 1);
      if (c === '\\' && next === '\n') { flush(); out.push({ type: 'break' }); i += 2; continue; }
      if (c === '\\' && ESCAPABLE.test(next)) { buffer += next; i += 2; continue; }
      if (c === '\n') { flush(); out.push({ type: 'break' }); i += 1; continue; }
      if (c === '`') {
        var ticks = runLength(s, i, '`');
        var close = closingBackticks(s, i + ticks, ticks);
        if (close >= 0) {
          var code = s.slice(i + ticks, close).replace(/\n/g, ' ');
          if (code.length > 2 && code.charAt(0) === ' ' && code.charAt(code.length - 1) === ' ' && code.trim()) code = code.slice(1, -1);
          flush();
          out.push({ type: 'code', text: code });
          i = close + ticks;
        } else {
          buffer += s.slice(i, i + ticks);
          i += ticks;
        }
        continue;
      }
      if (c === '*' || c === '_') {
        var styled = emphasis(s, i, noLinks);
        if (styled) {
          flush();
          out.push(styled.node);
          i = styled.end;
        } else {
          var run = runLength(s, i, c);
          buffer += s.slice(i, i + run);
          i += run;
        }
        continue;
      }
      if (!noLinks && c === '[') {
        var link = linkAt(s, i);
        if (link) {
          if (link.href) {
            flush();
            var label = parseInline(link.label, true);
            out.push({ type: 'link', href: link.href, children: label.length ? label : [{ type: 'text', text: link.href }] });
          } else {
            buffer += s.slice(i, link.end);
          }
          i = link.end;
          continue;
        }
      }
      if (!noLinks && c === '<') {
        var auto = /^<([A-Za-z][A-Za-z0-9+.-]*:[^\s<>]+)>/.exec(s.slice(i));
        if (auto && safeHref(auto[1])) {
          flush();
          out.push({ type: 'link', href: auto[1], children: [{ type: 'text', text: auto[1] }] });
          i += auto[0].length;
          continue;
        }
      }
      if (!noLinks && (c === 'h' || c === 'H')) {
        var url = bareUrl(s, i);
        if (url) {
          flush();
          out.push({ type: 'link', href: url, children: [{ type: 'text', text: url }] });
          i += url.length;
          continue;
        }
      }
      buffer += c;
      i += 1;
    }
    flush();
    return out;
  }

  function parse(text) {
    return parseBlocks(splitLines(typeof text === 'string' ? text : ''));
  }

  var HEADING_TAGS = { 1: 'h3', 2: 'h4', 3: 'h5' };

  function renderInline(doc, parent, nodes, pills) {
    for (var i = 0; i < nodes.length; i += 1) {
      var node = nodes[i];
      var el;
      switch (node.type) {
        case 'text': appendText(doc, parent, node.text, pills); continue;
        case 'break': parent.appendChild(doc.createElement('br')); continue;
        case 'code':
          el = doc.createElement('code');
          el.textContent = node.text;
          break;
        case 'link':
          el = doc.createElement('a');
          el.setAttribute('href', node.href);
          el.setAttribute('target', '_blank');
          el.setAttribute('rel', 'noopener noreferrer');
          renderInline(doc, el, node.children, pills);
          break;
        default:
          el = doc.createElement(node.type);
          renderInline(doc, el, node.children, pills);
      }
      parent.appendChild(el);
    }
  }

  // A text run, split around the mentions it names. Each pill is a span
  // with the typed text and the agent's id; the rest stays text nodes.
  function appendText(doc, parent, text, pills) {
    if (!pills || text.indexOf('@') === -1) {
      parent.appendChild(doc.createTextNode(text));
      return;
    }
    var pattern = pills.pattern;
    var last = 0;
    pattern.lastIndex = 0;
    var match;
    while ((match = pattern.exec(text)) !== null) {
      if (match.index > last) parent.appendChild(doc.createTextNode(text.slice(last, match.index)));
      var pill = doc.createElement('span');
      pill.className = 'mention';
      pill.setAttribute('data-mention', pills.ids[match[1].toLowerCase()]);
      pill.textContent = match[0];
      parent.appendChild(pill);
      last = match.index + match[0].length;
    }
    if (last < text.length) parent.appendChild(doc.createTextNode(text.slice(last)));
  }

  // The matcher for a message's mentions: "@" then one of the names or ids,
  // longest first so "Focus scanner" wins over "Focus", not followed by a
  // word character. Null when there is nothing to match.
  function mentionPills(mentions) {
    if (!Array.isArray(mentions) || mentions.length === 0) return null;
    var ids = {};
    var words = [];
    for (var i = 0; i < mentions.length; i += 1) {
      var mention = mentions[i];
      if (!mention || typeof mention.id !== 'string' || mention.id === '') continue;
      var names = [mention.id];
      if (typeof mention.name === 'string' && mention.name.trim() !== '') names.push(mention.name.trim());
      for (var j = 0; j < names.length; j += 1) {
        var key = names[j].toLowerCase();
        if (ids[key] === undefined) {
          ids[key] = mention.id;
          words.push(names[j]);
        }
      }
    }
    if (words.length === 0) return null;
    words.sort(function (a, b) { return b.length - a.length; });
    var escaped = words.map(function (word) { return word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); });
    return { ids: ids, pattern: new RegExp('@(' + escaped.join('|') + ')(?![\\w-])', 'gi') };
  }

  function renderBlocks(doc, parent, blocks, pills) {
    for (var i = 0; i < blocks.length; i += 1) {
      var block = blocks[i];
      var el;
      switch (block.type) {
        case 'paragraph':
          el = doc.createElement('p');
          renderInline(doc, el, block.inline, pills);
          break;
        case 'heading':
          el = doc.createElement(HEADING_TAGS[block.level]);
          el.className = 'md-heading';
          renderInline(doc, el, block.inline, pills);
          break;
        case 'list':
          el = doc.createElement(block.ordered ? 'ol' : 'ul');
          if (block.ordered && block.start !== 1) el.setAttribute('start', String(block.start));
          for (var j = 0; j < block.items.length; j += 1) {
            var item = doc.createElement('li');
            renderBlocks(doc, item, block.items[j].blocks, pills);
            el.appendChild(item);
          }
          break;
        case 'code':
          el = doc.createElement('pre');
          var code = doc.createElement('code');
          if (block.lang) code.setAttribute('data-lang', block.lang);
          code.textContent = block.text;
          el.appendChild(code);
          break;
        case 'quote':
          el = doc.createElement('blockquote');
          renderBlocks(doc, el, block.blocks, pills);
          break;
        default:
          el = doc.createElement('hr');
      }
      parent.appendChild(el);
    }
  }

  function renderInto(node, text, options) {
    var pills = options && options.mentions ? mentionPills(options.mentions) : null;
    renderBlocks(node.ownerDocument, node, parse(text), pills);
    return node;
  }

  function inlineText(nodes) {
    var out = '';
    for (var i = 0; i < nodes.length; i += 1) {
      var node = nodes[i];
      if (node.type === 'break') out += ' ';
      else if (node.children) out += inlineText(node.children);
      else out += node.text;
    }
    return out;
  }

  function blocksText(blocks) {
    var parts = [];
    for (var i = 0; i < blocks.length; i += 1) {
      var block = blocks[i];
      if (block.inline) parts.push(inlineText(block.inline));
      else if (block.type === 'code') parts.push(block.text);
      else if (block.type === 'quote') parts.push(blocksText(block.blocks));
      else if (block.type === 'list') {
        for (var j = 0; j < block.items.length; j += 1) parts.push(blocksText(block.items[j].blocks));
      }
    }
    return parts.join(' ');
  }

  function plain(text) {
    return blocksText(parse(text)).replace(/\s+/g, ' ').trim();
  }

  window.DashboardMarkdown = {
    parse: parse,
    renderInto: renderInto,
    plain: plain,
  };
}());
