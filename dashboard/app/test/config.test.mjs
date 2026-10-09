import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { APP_ROOT, ConfigError, codexDirFrom, jobRunnerFrom, loadConfig } from '../lib/config.mjs';

const HOME = '/data/root';
const REPO = path.resolve(APP_ROOT, '../..');

test('defaults resolve from the source location and the data root', () => {
  const config = loadConfig({ PERSONAL_ASSISTANT_HOME: HOME });
  assert.equal(config.port, 4243);
  assert.equal(config.bindHost, '127.0.0.1');
  assert.equal(config.focusOrigin, 'http://127.0.0.1:4242');
  assert.equal(config.publicOrigin, null);
  assert.equal(config.home, HOME);
  assert.equal(config.briefsDir, '/data/root/briefs');
  assert.equal(config.registryPath, '/data/root/registry/agents.json');
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

test('the job runner follows the platform, and DASHBOARD_JOB_RUNNER overrides it', () => {
  assert.equal(loadConfig({}, { platform: 'darwin' }).jobRunner, 'launchd');
  assert.equal(loadConfig({}, { platform: 'linux' }).jobRunner, 'systemd');
  assert.equal(loadConfig({ DASHBOARD_JOB_RUNNER: '' }, { platform: 'linux' }).jobRunner, 'systemd');
  assert.equal(loadConfig({ DASHBOARD_JOB_RUNNER: 'systemd' }, { platform: 'darwin' }).jobRunner, 'systemd');
  assert.equal(loadConfig({ DASHBOARD_JOB_RUNNER: 'launchd' }, { platform: 'linux' }).jobRunner, 'launchd');
  assert.equal(loadConfig({}).jobRunner, process.platform === 'darwin' ? 'launchd' : 'systemd');
});

test('an unknown job runner is a config problem', () => {
  assert.throws(() => loadConfig({ DASHBOARD_JOB_RUNNER: 'cron' }), (error) =>
    error instanceof ConfigError && error.problems.includes('DASHBOARD_JOB_RUNNER must be launchd or systemd'));
});

test('jobRunnerFrom answers the installer the way loadConfig does', () => {
  assert.equal(jobRunnerFrom({}, 'darwin'), 'launchd');
  assert.equal(jobRunnerFrom({}, 'linux'), 'systemd');
  assert.equal(jobRunnerFrom({ DASHBOARD_JOB_RUNNER: '' }, 'linux'), 'systemd');
  assert.equal(jobRunnerFrom({ DASHBOARD_JOB_RUNNER: 'launchd' }, 'linux'), 'launchd');
  assert.equal(jobRunnerFrom({ DASHBOARD_JOB_RUNNER: 'systemd' }, 'darwin'), 'systemd');
  assert.throws(() => jobRunnerFrom({ DASHBOARD_JOB_RUNNER: 'cron' }, 'linux'), (error) =>
    error instanceof ConfigError && error.problems.includes('DASHBOARD_JOB_RUNNER must be launchd or systemd'));
  assert.throws(() => loadConfig({ DASHBOARD_JOB_RUNNER: 'cron', DASHBOARD_PORT: '0' }), (error) =>
    error instanceof ConfigError && error.problems.length === 2);
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
    assert.equal(loadConfig({}).briefsDir, path.join(os.homedir(), '.personal-assistant', 'briefs'));
    assert.equal(loadConfig({}).builtinPath, path.join(REPO, 'registry', 'builtin.json'));
  } finally {
    process.chdir(before);
  }
});

test('the data root defaults to ~/.personal-assistant and every store default derives from it', () => {
  assert.equal(loadConfig({}).home, path.join(os.homedir(), '.personal-assistant'));
  assert.equal(loadConfig({ PERSONAL_ASSISTANT_HOME: '' }).home, path.join(os.homedir(), '.personal-assistant'));
  const config = loadConfig({ PERSONAL_ASSISTANT_HOME: '/data/root/' });
  assert.equal(config.home, HOME);
  assert.deepEqual({
    settingsPath: config.settingsPath,
    registryPath: config.registryPath,
    routinesDir: config.routinesDir,
    notificationsDir: config.notificationsDir,
    threadsDir: config.threadsDir,
    codexDir: config.codexDir,
    feedsDir: config.feedsDir,
    sourcesDir: config.sourcesDir,
    ideasDir: config.ideasDir,
    ideasMarksPath: config.ideasMarksPath,
    ideasInstructionsPath: config.ideasInstructionsPath,
    briefsDir: config.briefsDir,
    briefReadsPath: config.briefReadsPath,
  }, {
    settingsPath: '/data/root/settings.json',
    registryPath: '/data/root/registry/agents.json',
    routinesDir: '/data/root/routines',
    notificationsDir: '/data/root/notifications',
    threadsDir: '/data/root/threads',
    codexDir: '/data/root/codex',
    feedsDir: '/data/root/feeds',
    sourcesDir: '/data/root/sources',
    ideasDir: '/data/root/ideas/items',
    ideasMarksPath: '/data/root/ideas/marks.json',
    ideasInstructionsPath: '/data/root/ideas/criteria.md',
    briefsDir: '/data/root/briefs',
    briefReadsPath: '/data/root/brief-reads.json',
  });
  // The read times sit beside the threads directory, so at the root.
  assert.equal(path.join(path.dirname(config.threadsDir), 'thread-reads.json'), '/data/root/thread-reads.json');
  // Code and contracts stay in the repository.
  assert.equal(config.briefInstructionsPath, path.join(REPO, 'daily-brief', 'curator.md'));
  assert.equal(config.builtinPath, path.join(REPO, 'registry', 'builtin.json'));
  assert.equal(config.repoRoot, REPO);
  assert.equal(config.defaultsDir, path.join(REPO, 'defaults'));
  assert.equal(config.rootReadme, path.join(APP_ROOT, 'docs', 'root-README.md'));
});

test('each store override still wins over the data root', () => {
  const overrides = {
    DASHBOARD_SETTINGS_PATH: ['settingsPath', '/o/settings.json'],
    DASHBOARD_REGISTRY_PATH: ['registryPath', '/o/agents.json'],
    DASHBOARD_ROUTINES_DIR: ['routinesDir', '/o/routines'],
    DASHBOARD_NOTIFICATIONS_DIR: ['notificationsDir', '/o/notifications'],
    DASHBOARD_THREADS_DIR: ['threadsDir', '/o/threads'],
    DASHBOARD_CODEX_DIR: ['codexDir', '/o/codex'],
    DASHBOARD_FEEDS_DIR: ['feedsDir', '/o/feeds'],
    DASHBOARD_SOURCES_DIR: ['sourcesDir', '/o/sources'],
    DASHBOARD_IDEAS_DIR: ['ideasDir', '/o/ideas'],
    DASHBOARD_IDEAS_MARKS: ['ideasMarksPath', '/o/marks.json'],
    DASHBOARD_IDEAS_INSTRUCTIONS: ['ideasInstructionsPath', '/o/criteria.md'],
    DASHBOARD_BRIEFS_DIR: ['briefsDir', '/o/briefs'],
    DASHBOARD_BRIEF_READS_PATH: ['briefReadsPath', '/o/brief-reads.json'],
  };
  for (const [name, [key, value]] of Object.entries(overrides)) {
    assert.equal(loadConfig({ PERSONAL_ASSISTANT_HOME: HOME, [name]: value })[key], value, name);
  }
  assert.equal(loadConfig({ PERSONAL_ASSISTANT_HOME: HOME, DASHBOARD_IDEAS_MARKS: 'var/marks.json' }).ideasMarksPath,
    path.resolve(APP_ROOT, 'var/marks.json'));
});

test('migrate-from defaults to the repository, is null when empty, and takes an absolute override', () => {
  assert.equal(loadConfig({}).migrateFrom, REPO);
  assert.equal(loadConfig({ DASHBOARD_MIGRATE_FROM: '' }).migrateFrom, null);
  assert.equal(loadConfig({ DASHBOARD_MIGRATE_FROM: '/fixture/repo/' }).migrateFrom, '/fixture/repo');
});

test('a relative data root or migrate-from is refused', () => {
  assert.throws(() => loadConfig({ PERSONAL_ASSISTANT_HOME: 'data' }), (error) => error instanceof ConfigError &&
    error.problems.includes('PERSONAL_ASSISTANT_HOME must be an absolute path'));
  assert.throws(() => loadConfig({ DASHBOARD_MIGRATE_FROM: '../..' }), (error) => error instanceof ConfigError &&
    error.problems.includes('DASHBOARD_MIGRATE_FROM must be an absolute path or empty'));
  assert.throws(() => codexDirFrom({ PERSONAL_ASSISTANT_HOME: 'data' }), ConfigError);
});

test('codexDirFrom agrees with loadConfig', () => {
  for (const env of [{}, { PERSONAL_ASSISTANT_HOME: HOME }, { PERSONAL_ASSISTANT_HOME: HOME, DASHBOARD_CODEX_DIR: '/o/codex' },
    { DASHBOARD_CODEX_DIR: 'var/codex' }]) {
    assert.equal(codexDirFrom(env), loadConfig(env).codexDir, JSON.stringify(env));
  }
  assert.equal(codexDirFrom({ PERSONAL_ASSISTANT_HOME: HOME }), '/data/root/codex');
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

test('threads dir defaults under the data root and honors absolute and relative overrides', () => {
  assert.equal(loadConfig({ PERSONAL_ASSISTANT_HOME: HOME }).threadsDir, '/data/root/threads');
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
  assert.equal(config.timeouts.sessionsPollMs, 10_000);
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
  assert.equal(config.limits.delegationDepth, 2);
  assert.equal(config.limits.delegationMessageChars, 4000);
  assert.equal(config.limits.delegationReplyChars, 4000);
  assert.equal(config.limits.delegationPendingReplies, 5);
  assert.equal(config.timeouts.delegationWaitMs, 5_000);
});

test('the feeds and sources stores default under the data root; the brief rules stay in the repository', () => {
  const config = loadConfig({ PERSONAL_ASSISTANT_HOME: HOME });
  assert.deepEqual([config.feedsDir, config.sourcesDir], ['/data/root/feeds', '/data/root/sources']);
  assert.ok(!('feedDir' in config) && !('feedInstructionsPath' in config));
  assert.equal(loadConfig({ DASHBOARD_FEEDS_DIR: 'var/feeds' }).feedsDir, path.resolve(APP_ROOT, 'var/feeds'));
  assert.equal(config.limits.feedNoteBytes, 64 * 1024);
  assert.equal(loadConfig({}).briefInstructionsPath, path.resolve(APP_ROOT, '../../daily-brief/curator.md'));
  assert.equal(loadConfig({ DASHBOARD_BRIEF_INSTRUCTIONS: '/tmp/rules.md' }).briefInstructionsPath, '/tmp/rules.md');
});
