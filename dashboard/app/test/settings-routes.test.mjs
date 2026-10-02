import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fakeRegistry, fakeSettings, request, startApp } from './support/harness.mjs';

const AGENTS = [
  { id: 'assistant', name: 'Assistant', role: 'Assistant', description: 'Invented.', group: 'personal', kind: 'persona', provider: 'claude', cwd: '/invented', pinned: true },
  { id: 'cfo', name: 'CFO', role: 'Money', description: 'Invented.', group: 'work', kind: 'persona', provider: 'claude', cwd: '/invented' },
  { id: 'scribe', name: 'Scribe', role: 'Drafts', description: 'Invented.', group: 'work', kind: 'persona', provider: 'codex', cwd: '/invented' },
  { id: 'focus', name: 'Focus', role: 'Tasks', description: 'Invented.', group: 'personal', kind: 'system', cwd: '/invented' },
];

function put(app, body, headers = {}) {
  return request(app, 'PUT', '/api/settings', {
    headers: { 'content-type': 'application/json', origin: app.origin, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function setup(t, { settings = fakeSettings({ brief: { agent: 'assistant' } }), agents = AGENTS } = {}) {
  const app = await startApp(t, { registry: fakeRegistry(agents), settings });
  return { app, settings };
}

test('PUT saves a partial patch, answers the whole document, and the snapshot follows', async (t) => {
  const { app, settings } = await setup(t);
  const before = app.hub.snapshot().revision;
  const response = await put(app, { model: { default: 'sonnet', effort: 'high' } });
  assert.equal(response.status, 200);
  assert.deepEqual(response.json, {
    ok: true, settings: { version: 1, model: { default: 'sonnet', effort: 'high' }, brief: { agent: 'assistant' } },
  });
  assert.deepEqual(settings.updates, [{ model: { default: 'sonnet', effort: 'high' } }]);
  const snapshot = app.hub.snapshot();
  assert.equal(snapshot.revision, before + 1);
  assert.deepEqual(snapshot.settings.model, { default: 'sonnet', effort: 'high' });
  assert.deepEqual(snapshot.agents.find((a) => a.id === 'cfo').model, { id: 'sonnet', effort: 'high', source: 'system', default: { id: 'sonnet', effort: 'high' } });

  const cleared = await put(app, { model: { default: null }, brief: { agent: null } });
  assert.equal(cleared.status, 200);
  assert.deepEqual(cleared.json.settings, { version: 1, model: { default: null, effort: 'high' }, brief: { agent: null } });
  assert.equal(app.hub.snapshot().settings.brief.agent, null);

  const state = await request(app, 'GET', '/api/state');
  assert.deepEqual(state.json.settings, { ok: true, error: null, model: { default: null, effort: 'high' }, brief: { agent: null } });
  assert.deepEqual(state.json.models.map((m) => m.name), ['Fable', 'Opus', 'Sonnet', 'Haiku']);
});

test('PUT refuses bad bodies and values with 400 and the code, and saves nothing', async (t) => {
  const { app, settings } = await setup(t);
  for (const [body, code] of [
    ['not json', 'invalid_json'],
    ['[]', 'invalid_body'],
    ['{}', 'invalid_body'],
    [{ version: 1 }, 'invalid_body'],
    [{ model: {} }, 'invalid_body'],
    [{ model: { default: 'opus' }, extra: true }, 'invalid_body'],
    [{ brief: { agent: 'cfo', other: 1 } }, 'invalid_body'],
    [{ model: { default: '' } }, 'invalid_model'],
    [{ model: { default: 'x'.repeat(65) } }, 'invalid_model'],
    [{ model: { effort: 'turbo' } }, 'invalid_effort'],
    [{ brief: { agent: 'Not an id' } }, 'invalid_agent'],
  ]) {
    const response = await put(app, body);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.deepEqual(response.json, { error: code }, JSON.stringify(body));
  }
  assert.deepEqual(settings.updates, []);
});

test('PUT answers 404 no_such_agent for a brief target that is not a Claude persona; null is allowed', async (t) => {
  const { app, settings } = await setup(t);
  for (const id of ['nobody', 'scribe', 'focus']) {
    const response = await put(app, { brief: { agent: id } });
    assert.equal(response.status, 404, id);
    assert.deepEqual(response.json, { error: 'no_such_agent' });
  }
  assert.deepEqual(settings.updates, []);
  assert.equal((await put(app, { brief: { agent: 'cfo' } })).status, 200);
  assert.equal((await put(app, { brief: { agent: null } })).status, 200);
  assert.deepEqual(settings.updates, [{ brief: { agent: 'cfo' } }, { brief: { agent: null } }]);
});

test('PUT answers 409 settings_invalid while the file is unreadable, and 503 after shutdown begins', async (t) => {
  const { app, settings } = await setup(t);
  settings.fail('settings_invalid_json');
  const refused = await put(app, { model: { default: 'opus' } });
  assert.equal(refused.status, 409);
  assert.deepEqual(refused.json, { error: 'settings_invalid' });
  assert.equal(app.hub.snapshot().settings.ok, false);
  assert.equal(app.hub.snapshot().settings.error, 'settings_invalid_json');
  assert.deepEqual(settings.updates, []);

  await settings.seed({ brief: { agent: 'assistant' } });
  app.handler.closeStreams();
  const closing = await put(app, { model: { default: 'opus' } });
  assert.equal(closing.status, 503);
  assert.deepEqual(closing.json, { error: 'shutting_down' });
});

test('PUT needs a same-origin Origin and a JSON content type, caps the body, and allows PUT only', async (t) => {
  const { app } = await setup(t);
  const noOrigin = await request(app, 'PUT', '/api/settings', {
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: { default: 'opus' } }),
  });
  assert.equal(noOrigin.status, 403);
  const wrongType = await request(app, 'PUT', '/api/settings', {
    headers: { 'content-type': 'text/plain', origin: app.origin }, body: JSON.stringify({ model: { default: 'opus' } }),
  });
  assert.equal(wrongType.status, 415);
  const large = await put(app, `{"model":{"default":"${'x'.repeat(5_000)}"}}`);
  assert.equal(large.status, 413);
  const post = await request(app, 'POST', '/api/settings', {
    headers: { 'content-type': 'application/json', origin: app.origin }, body: '{}',
  });
  assert.equal(post.status, 405);
  const get = await request(app, 'GET', '/api/settings');
  assert.equal(get.status, 405);
});

test('without a settings store the route is 404', async (t) => {
  const app = await startApp(t, { registry: fakeRegistry(AGENTS), settings: null });
  const response = await put(app, { model: { default: 'opus' } });
  assert.equal(response.status, 404);
  assert.deepEqual(app.hub.snapshot().settings, { ok: true, error: null, model: { default: null, effort: null }, brief: { agent: null } });
});
