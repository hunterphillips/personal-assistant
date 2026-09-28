import assert from 'node:assert/strict';
import os from 'node:os';
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
  assert.equal(config.registryPath, path.resolve(APP_ROOT, '../../registry/agents.json'));
  assert.ok(path.isAbsolute(config.registryPath));
  assert.equal(config.launchAgentsDir, path.join(os.homedir(), 'Library', 'LaunchAgents'));
  assert.ok(path.isAbsolute(config.launchAgentsDir));
  assert.deepEqual([...config.allowedHosts], ['127.0.0.1:4243', 'localhost:4243']);
  assert.deepEqual([...config.allowedOrigins], ['http://127.0.0.1:4243', 'http://localhost:4243']);
  assert.equal(config.limits.focusBodyBytes, 1_000_000);
  assert.equal(config.limits.feedbackBodyBytes, 131_072);
  assert.equal(config.timeouts.launchctlMs, 3_000);
});

test('registry path and launch agents dir overrides are honored', () => {
  const config = loadConfig({
    DASHBOARD_REGISTRY_PATH: '/etc/personal-assistant/agents.json',
    DASHBOARD_LAUNCH_AGENTS_DIR: '/etc/launchd-agents',
  });
  assert.equal(config.registryPath, '/etc/personal-assistant/agents.json');
  assert.equal(config.launchAgentsDir, '/etc/launchd-agents');
});

test('a relative registry path override resolves from APP_ROOT', () => {
  const config = loadConfig({ DASHBOARD_REGISTRY_PATH: '../registry/other.json' });
  assert.equal(config.registryPath, path.resolve(APP_ROOT, '../registry/other.json'));
});

test('a relative launch agents dir override resolves from APP_ROOT', () => {
  const config = loadConfig({ DASHBOARD_LAUNCH_AGENTS_DIR: 'var/launchd' });
  assert.equal(config.launchAgentsDir, path.resolve(APP_ROOT, 'var/launchd'));
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

test('threads dir defaults under APP_ROOT and honors absolute and relative overrides', () => {
  assert.equal(loadConfig({}).threadsDir, path.resolve(APP_ROOT, 'var/threads'));
  assert.ok(path.isAbsolute(loadConfig({}).threadsDir));
  assert.equal(loadConfig({ DASHBOARD_THREADS_DIR: '/etc/threads' }).threadsDir, '/etc/threads');
  assert.equal(loadConfig({ DASHBOARD_THREADS_DIR: 'var/other' }).threadsDir, path.resolve(APP_ROOT, 'var/other'));
});

test('cmux files default under the home directory and honor absolute and relative overrides', () => {
  const config = loadConfig({});
  assert.equal(config.cmuxSocketPathFile, path.join(os.homedir(), '.local', 'state', 'cmux', 'last-socket-path'));
  assert.equal(config.cmuxPasswordFile, path.join(os.homedir(), '.local', 'state', 'cmux', 'socket-control-password'));
  assert.equal(config.cmuxCli, '/Applications/cmux.app/Contents/Resources/bin/cmux');
  const overridden = loadConfig({
    DASHBOARD_CMUX_SOCKET_PATH_FILE: '/run/cmux/path', DASHBOARD_CMUX_PASSWORD_FILE: 'var/cmux-password', DASHBOARD_CMUX_CLI: 'bin/fake-cmux',
  });
  assert.equal(overridden.cmuxSocketPathFile, '/run/cmux/path');
  assert.equal(overridden.cmuxPasswordFile, path.resolve(APP_ROOT, 'var/cmux-password'));
  assert.equal(overridden.cmuxCli, path.resolve(APP_ROOT, 'bin/fake-cmux'));
  assert.equal(config.timeouts.cmuxRequestMs, 5_000);
  assert.equal(config.timeouts.cmuxSessionsMs, 5_000);
  assert.equal(config.timeouts.cmuxStaleMs, 300_000);
  assert.equal(config.limits.cmuxFrameBytes, 1_048_576);
});

test('persona limits and timeouts are exposed', () => {
  const config = loadConfig({});
  assert.equal(config.timeouts.drainMs, 30_000);
  assert.equal(config.timeouts.requestMaxAgeMs, 1_800_000);
  assert.equal(config.limits.turnMaxTurns, 25);
  assert.equal(config.limits.messageTextBytes, 8192);
  assert.equal(config.limits.threadCacheMessages, 200);
  assert.equal(config.limits.threadCacheBytes, 1_048_576);
});
