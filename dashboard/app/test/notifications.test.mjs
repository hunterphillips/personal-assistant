import assert from 'node:assert/strict';
import { readFile, stat, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import { LIMITS, TIMEOUTS } from '../lib/config.mjs';
import { ASK_TOOL, NOTIFY_DESCRIPTION, NOTIFY_TOOL, createDelegation } from '../lib/delegation.mjs';
import { NotificationError, createNotifications, validLink } from '../lib/notifications.mjs';
import { createThreadStore } from '../lib/threads.mjs';
import { fakePersonas } from './support/browser-server.mjs';
import { fakeRegistry, request, startApp, tempDir } from './support/harness.mjs';

const AGENTS = [
  { id: 'assistant', name: 'Assistant', role: 'Assistant', description: 'Invented.', group: 'personal', kind: 'persona', provider: 'claude', cwd: '/invented', pinned: true },
  { id: 'cfo', name: 'CFO', role: 'Money', description: 'Invented.', group: 'work', kind: 'persona', provider: 'claude', cwd: '/invented' },
];

const fakeSdk = async () => ({
  tool: (name, description, schema, handler) => ({ name, description, schema, handler }),
  createSdkMcpServer: ({ name, version, tools }) => ({ type: 'sdk', name, version, instance: { tools } }),
});

// A clock that moves one second per reading, so every line has its own time.
function ticking(start = '2026-10-03T12:00:00.000Z') {
  let ms = Date.parse(start);
  return () => {
    const at = new Date(ms);
    ms += 1000;
    return at;
  };
}

async function store(t, { limits = {}, now = ticking() } = {}) {
  const dir = path.join(await tempDir(t), 'notifications');
  const file = path.join(dir, 'notifications.jsonl');
  let counter = 0;
  const logs = [];
  const make = () => createNotifications({
    file, limits: { ...LIMITS, ...limits }, now, randomUUID: () => `n-${++counter}`, log: (entry) => logs.push(entry),
  });
  const notifications = make();
  await notifications.load();
  const lines = async () => (await readFile(file, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  return { notifications, file, dir, lines, logs, make };
}

function send(app, method, pathname, headers = {}) {
  return request(app, method, pathname, { headers: { origin: app.origin, ...headers } });
}

test('raise appends one line per notification, private, newest first in the view', async (t) => {
  const { notifications, file, dir, lines } = await store(t);
  const changes = [];
  notifications.onChange(() => changes.push(notifications.view().open));
  const first = await notifications.raise({ agent: 'cfo', text: '  Unusual   activity\non the card. ', link: 'job:com.example.scan' });
  assert.deepEqual(first, {
    id: 'n-1', agent: 'cfo', text: 'Unusual activity on the card.', link: 'job:com.example.scan', at: '2026-10-03T12:00:00.000Z', acknowledgedAt: null,
  });
  await notifications.raise({ agent: 'assistant', text: 'An audit is waiting.' });
  assert.deepEqual((await lines()).map((line) => line.id), ['n-1', 'n-2']);
  assert.deepEqual(Object.keys((await lines())[0]), ['id', 'agent', 'text', 'link', 'at', 'acknowledgedAt']);
  assert.equal((await lines())[1].link, null);
  const view = notifications.view();
  assert.equal(view.open, 2);
  assert.deepEqual(view.items.map((item) => item.id), ['n-2', 'n-1']);
  assert.deepEqual(changes, [1, 2]);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
});

test('raise refuses an empty or long sentence, a bad link, or a bad agent, and stores nothing', async (t) => {
  const { notifications, file } = await store(t, { limits: { notificationTextChars: 10 } });
  const cases = [
    [{ agent: 'cfo', text: '   ' }, 'empty_text'],
    [{ agent: 'cfo', text: 'x'.repeat(11) }, 'text_too_long'],
    [{ agent: 'cfo', text: 'Hi.', link: 'http://example.com' }, 'invalid_link'],
    [{ agent: 'cfo', text: 'Hi.', link: 'feed:2026-10-03-watch' }, 'invalid_link'],
    [{ agent: 'cfo', text: 'Hi.', link: 7 }, 'invalid_link'],
    [{ agent: 'Not An Id', text: 'Hi.' }, 'invalid_agent'],
  ];
  for (const [fields, code] of cases) {
    await assert.rejects(notifications.raise(fields), (error) => error instanceof NotificationError && error.code === code);
  }
  await assert.rejects(stat(file), { code: 'ENOENT' });
  assert.deepEqual(notifications.view(), { open: 0, items: [] });
});

test('every link shape the dashboard opens is accepted, and nothing else', () => {
  for (const link of [null, 'agent:cfo', 'feed:2026-10-03-watch/0', 'feed:2026-10-03-watch/12', 'brief:2026-10-03', 'job:com.focus.scan-daily']) {
    assert.equal(validLink(link), true, link);
  }
  for (const link of ['', 'agent:', 'agent:CFO', 'feed:watch/1', 'feed:2026-10-03-watch/x', 'brief:yesterday', 'job:', 'job:a b', 'thread:cfo', 'cfo']) {
    assert.equal(validLink(link), false, link);
  }
});

test('acknowledge one and all rewrite the file, keep every item, and refuse an unknown id', async (t) => {
  const { notifications, lines } = await store(t);
  await notifications.raise({ agent: 'cfo', text: 'One.' });
  await notifications.raise({ agent: 'cfo', text: 'Two.' });
  await notifications.raise({ agent: 'cfo', text: 'Three.' });
  assert.equal(await notifications.acknowledge(['n-2']), 1);
  assert.equal(await notifications.acknowledge(['n-2']), 0, 'already acknowledged changes nothing');
  await assert.rejects(notifications.acknowledge(['n-9']), { code: 'no_such_notification' });
  let view = notifications.view();
  assert.equal(view.open, 2);
  assert.equal(view.items.find((item) => item.id === 'n-2').acknowledgedAt !== null, true);
  assert.equal(await notifications.acknowledgeAll(), 2);
  assert.equal(await notifications.acknowledgeAll(), 0);
  view = notifications.view();
  assert.equal(view.open, 0);
  assert.equal(view.items.length, 3, 'nothing is deleted');
  assert.ok((await lines()).every((line) => typeof line.acknowledgedAt === 'string'));
});

test('past the cap the oldest acknowledged items roll off before any open one', async (t) => {
  const { notifications, lines, make } = await store(t, { limits: { notificationsMax: 3 } });
  await notifications.raise({ agent: 'cfo', text: 'One.' });
  await notifications.raise({ agent: 'cfo', text: 'Two.' });
  await notifications.raise({ agent: 'cfo', text: 'Three.' });
  await notifications.acknowledge(['n-2']);
  await notifications.raise({ agent: 'cfo', text: 'Four.' });
  assert.deepEqual((await lines()).map((line) => line.id), ['n-1', 'n-3', 'n-4']);
  await notifications.raise({ agent: 'cfo', text: 'Five.' });
  assert.deepEqual((await lines()).map((line) => line.id), ['n-3', 'n-4', 'n-5'], 'with none acknowledged, the oldest open goes');
  const reloaded = make();
  await reloaded.load();
  assert.deepEqual(reloaded.view().items.map((item) => item.id), ['n-5', 'n-4', 'n-3']);
});

test('load skips bad lines with a log entry and keeps the good ones', async (t) => {
  const { dir, file, make, logs } = await store(t);
  await mkdir(dir, { recursive: true });
  const good = { id: 'a-1', agent: 'cfo', text: 'Good.', link: null, at: '2026-10-03T10:00:00.000Z', acknowledgedAt: null };
  await writeFile(file, [
    JSON.stringify(good),
    '{ not json',
    JSON.stringify({ ...good, id: 'a-1' }),
    JSON.stringify({ ...good, id: 'a-2', link: 'nowhere' }),
    JSON.stringify({ ...good, id: 'a-3', text: '' }),
    JSON.stringify({ ...good, id: 'a-4', acknowledgedAt: '2026-10-03T11:00:00.000Z' }),
    '',
  ].join('\n'));
  const notifications = make();
  await notifications.load();
  assert.deepEqual(notifications.view().items.map((item) => item.id), ['a-4', 'a-1']);
  assert.equal(notifications.view().open, 1);
  assert.deepEqual(logs.map((entry) => [entry.event, entry.line, entry.reason]), [
    ['notification_invalid', 2, 'bad_json'],
    ['notification_invalid', 3, 'bad_id'],
    ['notification_invalid', 4, 'bad_link'],
    ['notification_invalid', 5, 'bad_text'],
  ]);
});

async function delegationSetup(t, { limits = {} } = {}) {
  const threads = createThreadStore({ dir: path.join(await tempDir(t), 'threads'), limits: { messageTextBytes: 8192, threadCacheMessages: 50, threadCacheBytes: 64 * 1024 } });
  const personas = fakePersonas({}, threads);
  const { notifications } = await store(t, { limits });
  const registry = fakeRegistry(AGENTS);
  const app = await startApp(t, {
    registry,
    adapters: { claude: personas.adapter },
    store: threads,
    notifications,
    delegation: (hub) => createDelegation({
      hub, registry, notifications, limits: { ...LIMITS, ...limits }, timeouts: TIMEOUTS, importSdk: fakeSdk,
    }),
  });
  t.after(() => personas.adapter.close());
  return { app, notifications, threads };
}

test('the notify tool raises under the turn\'s agent, answers with the id, and posts nothing in any thread', async (t) => {
  const { app, notifications, threads } = await delegationSetup(t);
  const tools = await app.delegation.toolsFor({ id: 'cfo' }, { text: 'x', prompt: 'x', from: null, chain: [], mentions: [] });
  assert.deepEqual(tools.allowedTools, [ASK_TOOL, NOTIFY_TOOL]);
  const notify = tools.mcpServers.agents.instance.tools.find((tool) => tool.name === 'notify');
  assert.equal(notify.description, NOTIFY_DESCRIPTION);
  assert.equal(NOTIFY_DESCRIPTION.split('. ').length, 2, 'two sentences');
  const before = app.hub.snapshot().revision;
  const answer = await notify.handler({ text: 'Unusual activity on the card.', link: 'agent:cfo', agent: 'assistant', from: 'assistant' });
  const [item] = notifications.view().items;
  assert.deepEqual(answer, { content: [{ type: 'text', text: `Raised notification ${item.id}.` }] });
  assert.equal(item.agent, 'cfo', 'the sender comes from the turn');
  assert.equal(item.link, 'agent:cfo');
  const snapshot = app.hub.snapshot();
  assert.ok(snapshot.revision > before);
  assert.equal(snapshot.notifications.open, 1);
  assert.deepEqual(await threads.read('cfo'), []);
  assert.deepEqual(await threads.read('assistant'), []);
});

test('the notify tool refuses in one sentence and stores nothing', async (t) => {
  const { app, notifications } = await delegationSetup(t, { limits: { notificationTextChars: 20 } });
  const tools = await app.delegation.toolsFor({ id: 'cfo' }, { text: 'x', prompt: 'x', from: null, chain: [], mentions: [] });
  const notify = tools.mcpServers.agents.instance.tools.find((tool) => tool.name === 'notify');
  const text = async (args) => (await notify.handler(args)).content[0].text;
  assert.equal(await text({ text: '  ' }), 'The notification is empty.');
  assert.equal(await text({ text: 'x'.repeat(21) }), 'The notification is too long: 20 characters at most.');
  assert.equal(await text({ text: 'Hi.', link: 'https://example.com' }), 'The link must be agent:<id>, feed:<run>/<index>, brief:<date>, or job:<label>.');
  assert.deepEqual(notifications.view(), { open: 0, items: [] });
});

test('without a store the turn carries only ask', async (t) => {
  const threads = createThreadStore({ dir: path.join(await tempDir(t), 'threads'), limits: { messageTextBytes: 8192, threadCacheMessages: 50, threadCacheBytes: 64 * 1024 } });
  const registry = fakeRegistry(AGENTS);
  const app = await startApp(t, {
    registry, store: threads, delegation: (hub) => createDelegation({ hub, registry, limits: LIMITS, timeouts: TIMEOUTS, importSdk: fakeSdk }),
  });
  const tools = await app.delegation.toolsFor({ id: 'cfo' }, { text: 'x', prompt: 'x', from: null, chain: [], mentions: [] });
  assert.deepEqual(tools.allowedTools, [ASK_TOOL]);
  assert.deepEqual(tools.mcpServers.agents.instance.tools.map((tool) => tool.name), ['ask']);
  assert.deepEqual(app.hub.snapshot().notifications, { open: 0, items: [] });
  assert.equal((await request(app, 'GET', '/api/notifications')).status, 404);
});

test('the routes list, acknowledge one and all, and refuse an unknown id, a body, or a foreign origin', async (t) => {
  const { notifications } = await store(t);
  const app = await startApp(t, { registry: fakeRegistry(AGENTS), notifications });
  await notifications.raise({ agent: 'cfo', text: 'One.' });
  await notifications.raise({ agent: 'assistant', text: 'Two.', link: 'brief:2026-10-03' });

  const list = await request(app, 'GET', '/api/notifications');
  assert.equal(list.status, 200);
  assert.deepEqual(list.json, notifications.view());
  assert.deepEqual((await request(app, 'GET', '/api/state')).json.notifications, notifications.view());

  const one = await send(app, 'POST', '/api/notifications/n-1/acknowledge');
  assert.deepEqual([one.status, one.json], [200, { ok: true, acknowledged: 1 }]);
  assert.equal(app.hub.snapshot().notifications.open, 1);
  assert.equal((await send(app, 'POST', '/api/notifications/n-1/acknowledge')).json.acknowledged, 0);
  const missing = await send(app, 'POST', '/api/notifications/n-9/acknowledge');
  assert.deepEqual([missing.status, missing.json.error], [404, 'no_such_notification']);
  assert.equal((await send(app, 'POST', '/api/notifications/bad.id/acknowledge')).status, 404);
  assert.equal((await send(app, 'GET', '/api/notifications/n-1/acknowledge')).status, 405);
  assert.equal((await request(app, 'POST', '/api/notifications/acknowledge', { headers: { origin: 'http://evil.example' } })).status, 403);
  const withBody = await request(app, 'POST', '/api/notifications/acknowledge', {
    headers: { origin: app.origin, 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(withBody.status, 413);

  const all = await send(app, 'POST', '/api/notifications/acknowledge');
  assert.deepEqual([all.status, all.json], [200, { ok: true, acknowledged: 1 }]);
  const after = app.hub.snapshot().notifications;
  assert.equal(after.open, 0);
  assert.equal(after.items.length, 2);
});
