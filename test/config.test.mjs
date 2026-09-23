import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';

import { APP_ROOT, ConfigError, loadConfig } from '../lib/config.mjs';

test('defaults resolve from the source location', () => {
  const config = loadConfig({});
  assert.equal(config.port, 4243);
  assert.equal(config.bindHost, '127.0.0.1');
  assert.equal(config.focusOrigin, 'http://127.0.0.1:4242');
  assert.equal(config.publicOrigin, null);
  assert.equal(config.briefsDir, path.resolve(APP_ROOT, '../../daily-brief/briefs'));
  assert.ok(path.isAbsolute(config.briefsDir));
  assert.deepEqual([...config.allowedHosts], ['127.0.0.1:4243', 'localhost:4243']);
  assert.deepEqual([...config.allowedOrigins], ['http://127.0.0.1:4243', 'http://localhost:4243']);
  assert.equal(config.limits.focusBodyBytes, 1_000_000);
  assert.equal(config.limits.feedbackBodyBytes, 131_072);
});

test('defaults do not depend on the working directory', () => {
  const before = process.cwd();
  try {
    process.chdir(path.parse(before).root);
    assert.equal(loadConfig({}).briefsDir, path.resolve(APP_ROOT, '../../daily-brief/briefs'));
  } finally {
    process.chdir(before);
  }
});

test('public origin joins the Host and Origin allowlists', () => {
  const config = loadConfig({ DASHBOARD_PORT: '5000', DASHBOARD_PUBLIC_ORIGIN: 'https://box.example.ts.net' });
  assert.equal(config.publicOrigin, 'https://box.example.ts.net');
  assert.ok(config.allowedHosts.includes('box.example.ts.net'));
  assert.ok(config.allowedOrigins.includes('https://box.example.ts.net'));
  assert.ok(config.allowedHosts.includes('127.0.0.1:5000'));
});

test('focus origin is refused only at the dashboard bound authority', () => {
  const env = { DASHBOARD_PORT: '4243' };
  assert.throws(() => loadConfig({ ...env, DASHBOARD_FOCUS_ORIGIN: 'http://127.0.0.1:4243' }), ConfigError);
  assert.equal(loadConfig({ ...env, DASHBOARD_FOCUS_ORIGIN: 'http://[::1]:4243' }).focusOrigin, 'http://[::1]:4243');
  assert.equal(loadConfig({ ...env, DASHBOARD_FOCUS_ORIGIN: 'http://localhost:4243' }).focusOrigin, 'http://localhost:4243');
  assert.equal(loadConfig({ DASHBOARD_PORT: '80', DASHBOARD_FOCUS_ORIGIN: 'http://localhost' }).focusOrigin, 'http://localhost');
  assert.throws(() => loadConfig({ DASHBOARD_PORT: '80', DASHBOARD_FOCUS_ORIGIN: 'http://127.0.0.1' }), ConfigError);
});

test('focus origin accepts loopback overrides', () => {
  assert.equal(loadConfig({ DASHBOARD_FOCUS_ORIGIN: 'http://localhost:39999' }).focusOrigin, 'http://localhost:39999');
  assert.equal(loadConfig({ DASHBOARD_FOCUS_ORIGIN: 'http://127.0.0.1:40000/' }).focusOrigin, 'http://127.0.0.1:40000');
});

const invalid = {
  'non-numeric port': { DASHBOARD_PORT: 'abc' },
  'zero port': { DASHBOARD_PORT: '0' },
  'port above range': { DASHBOARD_PORT: '70000' },
  'fractional port': { DASHBOARD_PORT: '42.5' },
  'http public origin': { DASHBOARD_PUBLIC_ORIGIN: 'http://box.example.ts.net' },
  'public origin with path': { DASHBOARD_PUBLIC_ORIGIN: 'https://box.example.ts.net/app' },
  'public origin with credentials': { DASHBOARD_PUBLIC_ORIGIN: 'https://user:pw@box.example.ts.net' },
  'non-loopback focus': { DASHBOARD_FOCUS_ORIGIN: 'http://192.168.1.10:4242' },
  'https focus': { DASHBOARD_FOCUS_ORIGIN: 'https://127.0.0.1:4242' },
  'focus with path': { DASHBOARD_FOCUS_ORIGIN: 'http://127.0.0.1:4242/api' },
  'focus pointing at the dashboard': { DASHBOARD_PORT: '4243', DASHBOARD_FOCUS_ORIGIN: 'http://127.0.0.1:4243' },
  'unparseable focus': { DASHBOARD_FOCUS_ORIGIN: 'not a url' },
};

for (const [name, env] of Object.entries(invalid)) {
  test(`rejects ${name}`, () => {
    assert.throws(() => loadConfig(env), ConfigError);
  });
}
