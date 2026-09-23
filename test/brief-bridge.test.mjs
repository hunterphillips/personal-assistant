// Behavioral tests for public/brief-bridge.js in a node:vm context. The viewer's
// globals (ITEMS, fb, persist) are declared by a preceding classic script, as
// in a real adapted viewer.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

const BRIDGE = await readFile(new URL('../public/brief-bridge.js', import.meta.url), 'utf8');
const REVISION = 'c'.repeat(64);

const VIEWER_SCRIPT = `
const ITEMS = [
  {"sec": "Needs you", "id": "alpha", "text": "Invented first item."},
  {"sec": "Money", "id": "beta", "lede": "Invented legacy line.", "body": "Detail."}
];
let fb = {"alpha": {"m": "a", "n": "Line one\\nline two"}, "beta": {"m": "d"}, "_overall": "Overall"};
let persistCalls = 0;
function persist() { persistCalls += 1; document.getElementById('status').textContent = 'counts'; }
`;

function element(extra = {}) {
  return {
    textContent: '', value: '', disabled: false, style: {},
    setAttribute() {}, select() { this.selected = true; }, ...extra,
  };
}

function makeBridge({
  fetchImpl = async () => ({ ok: true, status: 200 }),
  clipboard,
  execCommand = () => true,
  viewerScript = VIEWER_SCRIPT,
  config = JSON.stringify({ date: '2026-09-15', revision: REVISION }),
} = {}) {
  const status = element({ textContent: 'No marks yet' });
  const button = element();
  const overall = element({ value: '  Overall thought  ' });
  const configElement = element({ textContent: config });
  const appended = [];
  const consoleCalls = [];
  const fetchCalls = [];
  const timers = [];
  const document = {
    getElementById(id) {
      return { status, overall, 'brief-bridge-config': configElement }[id] ?? null;
    },
    querySelector(selector) { return selector === 'button.save' ? button : null; },
    createElement() { return element(); },
    body: {
      appendChild(node) { appended.push(node); },
      removeChild(node) { appended.splice(appended.indexOf(node), 1); },
    },
    execCommand(command) {
      const area = appended[appended.length - 1];
      return execCommand(command, area);
    },
  };
  const consoleStub = new Proxy({}, {
    get: (_target, name) => (...args) => { consoleCalls.push([name, ...args]); },
  });
  const context = vm.createContext({
    document,
    navigator: clipboard === undefined ? {} : { clipboard },
    localStorage: { getItem() { return null; }, setItem() {} },
    console: consoleStub,
    AbortController,
    Promise,
    JSON,
    setTimeout(fn, delay) { timers.push({ fn, delay }); return timers.length; },
    clearTimeout(id) { if (timers[id - 1]) timers[id - 1].cleared = true; },
    fetch(url, options) {
      fetchCalls.push({ url, options });
      return fetchImpl(url, options);
    },
  });
  context.window = context;
  vm.runInContext(viewerScript, context);
  vm.runInContext(BRIDGE, context);
  return { context, status, button, overall, fetchCalls, timers, consoleCalls, appended };
}

async function flush() {
  for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

function runTimers(timers, delay) {
  for (const timer of timers) if (timer.delay === delay && !timer.cleared) timer.fn();
}

test('Save posts the exact JSON contract with same-origin credentials and restores counts', async () => {
  const bridge = makeBridge();
  const draftBefore = vm.runInContext('JSON.stringify(fb)', bridge.context);
  bridge.context.saveOut();
  assert.equal(bridge.button.disabled, true);
  assert.equal(bridge.status.textContent, 'Saving…');
  assert.equal(bridge.fetchCalls.length, 1);
  const [{ url, options }] = bridge.fetchCalls;
  assert.equal(url, '/api/brief/feedback');
  assert.equal(options.method, 'POST');
  assert.equal(options.credentials, 'same-origin');
  assert.deepEqual({ ...options.headers }, { 'Content-Type': 'application/json' });
  assert.deepEqual(JSON.parse(options.body), {
    date: '2026-09-15',
    revision: REVISION,
    overall: '  Overall thought  ',
    items: [
      { id: 'alpha', mark: 'approved', note: 'Line one\nline two' },
      { id: 'beta', mark: 'dismissed', note: '' },
    ],
  });
  await flush();
  assert.equal(bridge.status.textContent, 'Saved');
  assert.equal(bridge.button.disabled, false);
  assert.equal(vm.runInContext('JSON.stringify(fb)', bridge.context), draftBefore);
  runTimers(bridge.timers, 3000);
  assert.equal(vm.runInContext('persistCalls', bridge.context), 1);
  assert.equal(bridge.status.textContent, 'counts');
  assert.ok(bridge.timers.find((timer) => timer.delay === 12000).cleared);
  assert.deepEqual(bridge.consoleCalls, []);
});

test('a second Save while pending sends nothing', async () => {
  let resolveFetch;
  const bridge = makeBridge({ fetchImpl: () => new Promise((resolve) => { resolveFetch = resolve; }) });
  bridge.context.saveOut();
  bridge.context.saveOut();
  assert.equal(bridge.fetchCalls.length, 1);
  resolveFetch({ ok: true, status: 200 });
  await flush();
  assert.equal(bridge.button.disabled, false);
  bridge.context.saveOut();
  assert.equal(bridge.fetchCalls.length, 2);
});

for (const [label, fetchImpl, message] of [
  ['409', async () => ({ ok: false, status: 409 }), 'Save failed: brief changed, reload to continue'],
  ['413', async () => ({ ok: false, status: 413 }), 'Save failed: feedback is too long. Draft kept.'],
  ['500', async () => ({ ok: false, status: 500 }), 'Save failed, draft kept. Use Copy instead.'],
  ['network error', async () => { throw new TypeError('invented network failure'); }, 'Save failed, draft kept. Use Copy instead.'],
  ['synchronous fetch throw', () => { throw new TypeError('invented'); }, 'Save failed, draft kept. Use Copy instead.'],
]) {
  test(`Save failure on ${label} re-enables the button and keeps the draft`, async () => {
    const bridge = makeBridge({ fetchImpl });
    const draftBefore = vm.runInContext('JSON.stringify(fb)', bridge.context);
    bridge.context.saveOut();
    await flush();
    assert.equal(bridge.status.textContent, message);
    assert.equal(bridge.button.disabled, false);
    assert.equal(bridge.overall.value, '  Overall thought  ');
    assert.equal(vm.runInContext('JSON.stringify(fb)', bridge.context), draftBefore);
    assert.equal(bridge.timers.filter((timer) => timer.delay !== 12000).length, 0);
    assert.deepEqual(bridge.consoleCalls, []);
  });
}

test('Save with unreachable viewer globals leaves the button enabled and says so', () => {
  const bridge = makeBridge({ viewerScript: 'let unrelated = 1;' });
  bridge.context.saveOut();
  assert.equal(bridge.fetchCalls.length, 0);
  assert.equal(bridge.button.disabled, false);
  assert.equal(bridge.status.textContent, 'Save unavailable, draft kept. Use Copy instead.');
  bridge.context.saveOut();
  assert.equal(bridge.status.textContent, 'Save unavailable, draft kept. Use Copy instead.');
  assert.deepEqual(bridge.consoleCalls, []);
});

test('Save when draft() throws on malformed state leaves the button enabled', () => {
  const bridge = makeBridge({ viewerScript: VIEWER_SCRIPT.replace('let fb = {', 'let fb = null; let unused = {') });
  bridge.context.saveOut();
  assert.equal(bridge.fetchCalls.length, 0);
  assert.equal(bridge.button.disabled, false);
  assert.equal(bridge.status.textContent, 'Save unavailable, draft kept. Use Copy instead.');
});

const EXPECTED_MARKDOWN = [
  '# Brief feedback — 2026-09-15', '', '## Overall', '', 'Overall thought', '',
  '## Needs you', '', '- APPROVED — Invented first item.', '  - note: Line one', '    line two',
  '## Money', '', '- DISMISSED — Invented legacy line.', '',
].join('\n');

test('Copy writes the server Markdown to the clipboard and restores counts', async () => {
  const written = [];
  const bridge = makeBridge({ clipboard: { writeText: async (text) => { written.push(text); } } });
  bridge.context.copyOut();
  await flush();
  assert.deepEqual(written, [EXPECTED_MARKDOWN]);
  assert.equal(bridge.status.textContent, 'Copied');
  runTimers(bridge.timers, 2000);
  assert.equal(bridge.status.textContent, 'counts');
  assert.deepEqual(bridge.consoleCalls, []);
});

test('Copy without a clipboard API falls back to a selected textarea', async () => {
  const copied = [];
  const bridge = makeBridge({
    execCommand: (command, area) => { copied.push([command, area.value, area.selected]); return true; },
  });
  bridge.context.copyOut();
  await flush();
  assert.deepEqual(copied, [['copy', EXPECTED_MARKDOWN, true]]);
  assert.deepEqual(bridge.appended, []);
  assert.equal(bridge.status.textContent, 'Copied');
});

test('Copy falls back when the clipboard rejects or throws', async () => {
  for (const writeText of [async () => { throw new Error('denied'); }, () => { throw new Error('denied'); }]) {
    const bridge = makeBridge({ clipboard: { writeText } });
    bridge.context.copyOut();
    await flush();
    assert.equal(bridge.status.textContent, 'Copied');
  }
});

test('Copy reports blocked when clipboard and fallback both fail, without logging', async () => {
  for (const execCommand of [() => false, () => { throw new Error('invented'); }]) {
    const bridge = makeBridge({ clipboard: { writeText: async () => { throw new Error('denied'); } }, execCommand });
    bridge.context.copyOut();
    await flush();
    assert.equal(bridge.status.textContent, 'Copy blocked');
    assert.deepEqual(bridge.appended, []);
    assert.deepEqual(bridge.consoleCalls, []);
  }
});

test('a missing config element disables Save with a status message', () => {
  const bridge = makeBridge({ config: '{not json' });
  assert.equal(bridge.status.textContent, 'Save unavailable. Use Copy instead.');
});
