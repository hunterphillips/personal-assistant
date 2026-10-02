// The thread's Markdown renderer, public/markdown.js, loaded into a bare
// window. parse() and plain() are pure; renderInto() runs against a small
// stand-in document that refuses innerHTML, so the test also shows that
// message text only ever reaches the page through textContent.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/markdown.js', import.meta.url), 'utf8');
const context = { window: {} };
vm.runInNewContext(source, context);
const md = context.window.DashboardMarkdown;
const plain = (value) => JSON.parse(JSON.stringify(value));
const parse = (text) => plain(md.parse(text));
const t = (text) => ({ type: 'text', text });
const p = (...inline) => ({ type: 'paragraph', inline });
const BR = { type: 'break' };

// A stand-in DOM: elements and text nodes, serialized as tags with
// attributes so the tests can compare whole trees.
class Text { constructor(text) { this.text = text; } toString() { return this.text; } }
class Element {
  constructor(doc, tag) { this.ownerDocument = doc; this.tag = tag; this.children = []; this.attrs = {}; this.className = ''; }
  appendChild(node) { this.children.push(node); return node; }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  set textContent(value) { this.children = [new Text(String(value))]; }
  set innerHTML(value) { throw new Error('innerHTML used'); }
  toString() {
    const attrs = Object.keys(this.attrs).map((k) => ` ${k}="${this.attrs[k]}"`).join('') + (this.className ? ` class="${this.className}"` : '');
    if (this.tag === 'br' || this.tag === 'hr') return `<${this.tag}${attrs}>`;
    return `<${this.tag}${attrs}>${this.children.join('')}</${this.tag}>`;
  }
}
const doc = { createElement: (tag) => new Element(doc, tag), createTextNode: (text) => new Text(text) };
const html = (text) => md.renderInto(new Element(doc, 'div'), text).children.join('');

test('a single line with no markup is one paragraph of its text', () => {
  assert.deepEqual(parse('Cash is fine.'), [p(t('Cash is fine.'))]);
  assert.equal(html('Cash is fine.'), '<p>Cash is fine.</p>');
  assert.equal(html(''), '');
  assert.equal(html(undefined), '');
});

test('lines inside a paragraph keep their breaks; a blank line starts a new paragraph', () => {
  assert.deepEqual(parse('One\ntwo  \n\nthree'), [p(t('One'), BR, t('two')), p(t('three'))]);
  assert.equal(html('One\r\ntwo'), '<p>One<br>two</p>');
});

test('headings at three levels; deeper ones show as the third', () => {
  assert.equal(html('# One\n## Two\n### Three\n#### Four'),
    '<h3 class="md-heading">One</h3><h4 class="md-heading">Two</h4><h5 class="md-heading">Three</h5><h5 class="md-heading">Four</h5>');
  assert.equal(html('## Needs **you** ##'), '<h4 class="md-heading">Needs <strong>you</strong></h4>');
  assert.equal(html('#hashtag'), '<p>#hashtag</p>');
  assert.equal(html('## C#'), '<h4 class="md-heading">C#</h4>');
});

test('bullet and numbered lists, nested by indent', () => {
  assert.equal(html('- a\n* b\n+ c'), '<ul><li><p>a</p></li><li><p>b</p></li><li><p>c</p></li></ul>');
  assert.equal(html('1. one\n2. two'), '<ol><li><p>one</p></li><li><p>two</p></li></ol>');
  assert.equal(html('3. three\n4. four'), '<ol start="3"><li><p>three</p></li><li><p>four</p></li></ol>');
  assert.equal(html('- a\n  - a1\n    - a1x\n  - a2\n- b'),
    '<ul><li><p>a</p><ul><li><p>a1</p><ul><li><p>a1x</p></li></ul></li><li><p>a2</p></li></ul></li><li><p>b</p></li></ul>');
  assert.equal(html('1. first\n   - detail\n2. second'),
    '<ol><li><p>first</p><ul><li><p>detail</p></li></ul></li><li><p>second</p></li></ol>');
  // Two-space nesting under a numbered item, a continuation line, a blank between items.
  assert.equal(html('1. first\n  - detail\n2. second\ncontinued\n\n3. third'),
    '<ol><li><p>first</p><ul><li><p>detail</p></li></ul></li><li><p>second<br>continued</p></li><li><p>third</p></li></ol>');
  // A list straight after a paragraph line, and a paragraph after the list.
  assert.equal(html('Here:\n- a\n- b\n\nDone.'), '<p>Here:</p><ul><li><p>a</p></li><li><p>b</p></li></ul><p>Done.</p>');
  // A number that is not 1 does not break into a paragraph.
  assert.equal(html('Founded in\n2024. Then more.'), '<p>Founded in<br>2024. Then more.</p>');
  // Switching between bullets and numbers starts a new list.
  assert.equal(html('- a\n1. b'), '<ul><li><p>a</p></li></ul><ol><li><p>b</p></li></ol>');
});

test('bold, italic, and inline code', () => {
  assert.equal(html('**bold** and *it* and _it_ and `x < y`'),
    '<p><strong>bold</strong> and <em>it</em> and <em>it</em> and <code>x < y</code></p>');
  assert.equal(html('***both***'), '<p><em><strong>both</strong></em></p>');
  assert.equal(html('**bold *and italic***'), '<p><strong>bold <em>and italic</em></strong></p>');
  assert.equal(html('*a **b** c*'), '<p><em>a <strong>b</strong> c</em></p>');
  assert.equal(html('snake_case_name and 2 * 3 * 4'), '<p>snake_case_name and 2 * 3 * 4</p>');
  assert.equal(html('`*not italic*` and ``a ` b``'), '<p><code>*not italic*</code> and <code>a ` b</code></p>');
  assert.equal(html('\\*literal\\* and **unclosed'), '<p>*literal* and **unclosed</p>');
});

test('fenced code blocks keep their text and take an optional language', () => {
  assert.equal(html('```js\nconst a = 1;\n  <b>x</b>\n```'), '<pre><code data-lang="js">const a = 1;\n  <b>x</b></code></pre>');
  assert.equal(html('~~~\n# not a heading\n~~~\nafter'), '<pre><code># not a heading</code></pre><p>after</p>');
  // An unclosed fence runs to the end.
  assert.equal(html('```\nopen'), '<pre><code>open</code></pre>');
  assert.deepEqual(parse('```"><script>\nx\n```')[0].lang, '');
});

test('blockquotes and rules', () => {
  assert.equal(html('> quoted\n> - item\n\n---\n\n* * *'),
    '<blockquote><p>quoted</p><ul><li><p>item</p></li></ul></blockquote><hr><hr>');
});

test('links: markdown, angle, and bare URLs, each opening in a new tab', () => {
  const attrs = 'target="_blank" rel="noopener noreferrer"';
  assert.equal(html('[the **bank**](https://bank.example/a_(b))'),
    `<p><a href="https://bank.example/a_(b)" ${attrs}>the <strong>bank</strong></a></p>`);
  assert.equal(html('Mail [me](mailto:h@example.com "Title").'), `<p>Mail <a href="mailto:h@example.com" ${attrs}>me</a>.</p>`);
  assert.equal(html('See https://example.com/x?y=1. Or (http://example.com/a).'),
    `<p>See <a href="https://example.com/x?y=1" ${attrs}>https://example.com/x?y=1</a>. Or (<a href="http://example.com/a" ${attrs}>http://example.com/a</a>).</p>`);
  assert.equal(html('<https://example.com>'), `<p><a href="https://example.com" ${attrs}>https://example.com</a></p>`);
  assert.equal(html('`https://example.com`'), '<p><code>https://example.com</code></p>');
});

test('raw HTML and unsafe links render as text', () => {
  assert.equal(html('<img src=x onerror=alert(1)>'), '<p><img src=x onerror=alert(1)></p>');
  assert.deepEqual(parse('<img src=x onerror=alert(1)>'), [p(t('<img src=x onerror=alert(1)>'))]);
  assert.deepEqual(parse('[x](javascript:alert(1))'), [p(t('[x](javascript:alert(1))'))]);
  assert.deepEqual(parse('[x](JAVASCRIPT:alert(1)) [y](data:text/html,hi) [z](/relative) <javascript:alert(1)>'),
    [p(t('[x](JAVASCRIPT:alert(1)) [y](data:text/html,hi) [z](/relative) <javascript:alert(1)>'))]);
  assert.deepEqual(parse('[x](https://ok.example/ "t")[y](https:// spaced)'),
    [p({ type: 'link', href: 'https://ok.example/', children: [t('x')] }, t('[y](https:// spaced)'))]);
});

test('plain strips the markers to one line for previews and summaries', () => {
  assert.equal(md.plain('## Needs you\n\n- **Call** the [bank](https://bank.example)\n- `wire` _today_\n\n> quoted'),
    'Needs you Call the bank wire today quoted');
  assert.equal(md.plain('Cash is fine.'), 'Cash is fine.');
  assert.equal(md.plain('[x](javascript:alert(1))'), '[x](javascript:alert(1))');
  assert.equal(md.plain(''), '');
});

test('mentions become pills from text nodes only, longest name first, case-insensitive, never inside code or from raw HTML', () => {
  const mentions = [{ id: 'cfo', name: 'CFO' }, { id: 'focus', name: 'Focus' }, { id: 'scanner', name: 'Focus scanner' }];
  const withPills = (text) => md.renderInto(new Element(doc, 'div'), text, { mentions }).children.join('');
  assert.equal(withPills('Ask @CFO about it'), '<p>Ask <span data-mention="cfo" class="mention">@CFO</span> about it</p>');
  // The typed casing stays; the id matches as well as the name.
  assert.equal(withPills('@cfo and @Cfo'), '<p><span data-mention="cfo" class="mention">@cfo</span> and <span data-mention="cfo" class="mention">@Cfo</span></p>');
  // The longest name wins, so "Focus scanner" is one pill.
  assert.equal(withPills('@Focus scanner, then @Focus'),
    '<p><span data-mention="scanner" class="mention">@Focus scanner</span>, then <span data-mention="focus" class="mention">@Focus</span></p>');
  // A name followed by a word character is not that agent.
  assert.equal(withPills('@CFOs are busy'), '<p>@CFOs are busy</p>');
  // Unknown names stay text; nothing happens without mentions.
  assert.equal(withPills('@nobody here'), '<p>@nobody here</p>');
  assert.equal(html('@CFO here'), '<p>@CFO here</p>');
  // Inside code the text is untouched, and in bold the pill nests.
  assert.equal(withPills('`@CFO` **@CFO**'),
    '<p><code>@CFO</code> <strong><span data-mention="cfo" class="mention">@CFO</span></strong></p>');
  // A name that is HTML renders as text, never as markup.
  const hostile = [{ id: 'x', name: '<img src=x onerror=alert(1)>' }];
  assert.equal(md.renderInto(new Element(doc, 'div'), 'hi @<img src=x onerror=alert(1)> there', { mentions: hostile }).children.join(''),
    '<p>hi <span data-mention="x" class="mention">@&lt;img src=x onerror=alert(1)&gt;</span> there</p>'.replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
  // Regex characters in a name are literal.
  const dotted = [{ id: 'dot', name: 'A.B (C)' }];
  assert.equal(md.renderInto(new Element(doc, 'div'), '@A.B (C) and @AxB (C)', { mentions: dotted }).children.join(''),
    '<p><span data-mention="dot" class="mention">@A.B (C)</span> and @AxB (C)</p>');
});
