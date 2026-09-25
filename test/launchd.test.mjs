import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { renderPlist, validatePlistInputs } from '../lib/launchd.mjs';

const APP_DIR = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const LABEL = 'com.personal-assistant.dashboard';
const PLUTIL_AVAILABLE = spawnSync('plutil', ['-help'], { stdio: 'ignore' }).error?.code !== 'ENOENT';

const VALID_INPUTS = {
  label: LABEL,
  nodePath: '/opt/node/bin/node',
  appDir: '/Users/example/dashboard/app',
  port: 4243,
  publicOrigin: 'https://example.tailnet.ts.net',
};

test('renderPlist produces a structurally valid plist and passes plutil lint', async (t) => {
  const xml = renderPlist(VALID_INPUTS);
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(xml, /<plist version="1\.0">[\s\S]*<dict>[\s\S]*<\/dict>[\s\S]*<\/plist>\s*$/);
  assert.doesNotMatch(xml, /{{[A-Z0-9_]+}}/);

  if (!PLUTIL_AVAILABLE) {
    t.diagnostic('plutil is unavailable; structural checks were used instead');
    return;
  }

  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dashboard-plist-'));
  try {
    const plistPath = path.join(tempDir, `${LABEL}.plist`);
    await fsp.writeFile(plistPath, xml);
    const lint = spawnSync('plutil', ['-lint', plistPath], { encoding: 'utf8' });
    assert.equal(lint.status, 0, lint.stderr || lint.stdout);
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});

test('renderPlist escapes values and includes the required launchd configuration', () => {
  const nodePath = `/opt/Node & <runtime> "current" 'stable'/bin/node`;
  const appDir = `/Users/example/Dashboard & <app> "primary" 'local' space`;
  const briefsDir = `/Users/example/Briefs & <private> "daily" 'saved' space`;
  const xml = renderPlist({
    ...VALID_INPUTS,
    nodePath,
    appDir,
    briefsDir,
    focusOrigin: 'http://127.0.0.1:4242',
  });

  for (const entity of ['&amp;', '&lt;', '&gt;', '&quot;', '&apos;']) {
    assert.match(xml, new RegExp(entity));
  }
  assert.match(xml, new RegExp(escapeRegExp(xmlEscape(nodePath))));
  assert.match(xml, new RegExp(escapeRegExp(xmlEscape(path.join(appDir, 'bin', 'dashboard-start')))));
  assert.match(xml, new RegExp(escapeRegExp(xmlEscape(briefsDir))));
  assert.match(
    xml,
    new RegExp(
      `<key>ProgramArguments</key>\\s*<array>\\s*<string>${escapeRegExp(xmlEscape(path.join(appDir, 'bin', 'dashboard-start')))}</string>\\s*` +
      `<string>${escapeRegExp(xmlEscape(nodePath))}</string>\\s*</array>`,
    ),
  );
  assert.match(xml, /<key>WorkingDirectory<\/key>\s*<string>[^<]*Dashboard/);
  assert.match(xml, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(xml, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(xml, /<key>PATH<\/key>\s*<string>/);
  assert.match(xml, /<key>DASHBOARD_PORT<\/key>\s*<string>4243<\/string>/);
  assert.match(xml, /<key>DASHBOARD_PUBLIC_ORIGIN<\/key>\s*<string>https:\/\/example\.tailnet\.ts\.net<\/string>/);
  assert.match(xml, /<key>DASHBOARD_BRIEFS_DIR<\/key>/);
  assert.match(xml, /<key>DASHBOARD_FOCUS_ORIGIN<\/key>/);
  const expectedLogPath = xmlEscape(path.join(appDir, 'var', 'log', 'dashboard.log'));
  assert.equal(xml.split(expectedLogPath).length - 1, 2);
});

test('validatePlistInputs rejects relative paths, insecure origins, and invalid ports', () => {
  assert.throws(
    () => validatePlistInputs({ ...VALID_INPUTS, nodePath: 'bin/node' }),
    /nodePath must be an absolute path/,
  );
  assert.throws(
    () => validatePlistInputs({ ...VALID_INPUTS, appDir: 'dashboard/app' }),
    /appDir must be an absolute path/,
  );
  assert.throws(
    () => validatePlistInputs({ ...VALID_INPUTS, briefsDir: 'briefs' }),
    /briefsDir must be an absolute path/,
  );
  assert.throws(
    () => validatePlistInputs({ ...VALID_INPUTS, publicOrigin: 'http://example.test' }),
    /publicOrigin must be a bare https:\/\/ origin/,
  );
  for (const control of ['\u0000', '\u0001', '\u001b', '\uFFFE', '\uD800']) {
    assert.throws(
      () => validatePlistInputs({ ...VALID_INPUTS, appDir: `/Users/example/app${control}` }),
      /appDir contains characters that cannot appear in a plist/,
    );
  }
  for (const port of [0, 65536, 1.5, Number.NaN]) {
    assert.throws(() => validatePlistInputs({ ...VALID_INPUTS, port }), /port must be an integer/);
  }
});

test('dashboard-install dry run writes only below the app var directory', async () => {
  const fixture = await makeInstallerFixture();
  try {
    const before = await listTree(fixture.appDir);
    const result = spawnSync(process.execPath, [
      fixture.installerPath,
      '--dry-run',
      '--node',
      process.execPath,
    ], {
      env: fakeLaunchctlEnv(fixture),
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);

    const renderedPath = path.join(fixture.appDir, 'var', 'launchd', `${LABEL}.plist`);
    assert.equal(result.stdout.trim(), await fsp.realpath(renderedPath));
    assert.equal((await fsp.stat(renderedPath)).isFile(), true);
    assert.deepEqual(await fsp.readdir(fixture.homeDir), []);
    assert.deepEqual(readFakeState(fixture).calls, []);
    const added = (await listTree(fixture.appDir)).filter((entry) => !before.includes(entry));
    assert.deepEqual(added, [
      'var/',
      'var/launchd/',
      `var/launchd/${LABEL}.plist`,
    ]);
  } finally {
    await fsp.rm(fixture.rootDir, { recursive: true, force: true });
  }
});

test('dashboard-install requires a public origin before touching the filesystem', async () => {
  const fixture = await makeInstallerFixture();
  try {
    const result = spawnSync(process.execPath, [fixture.installerPath], {
      env: fakeLaunchctlEnv(fixture),
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /--public-origin is required/);
    assert.equal(fs.existsSync(path.join(fixture.appDir, 'var')), false);
    assert.deepEqual(await fsp.readdir(fixture.homeDir), []);
  } finally {
    await fsp.rm(fixture.rootDir, { recursive: true, force: true });
  }
});

test('dashboard-install refuses a real install when HOME is not the account home', async () => {
  const fixture = await makeInstallerFixture();
  try {
    const result = spawnSync(process.execPath, [
      fixture.installerPath,
      '--public-origin',
      'https://example.tailnet.ts.net',
      '--node',
      process.execPath,
    ], {
      env: fakeLaunchctlEnv(fixture),
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /differs from this account's home directory/);
    assert.equal(fs.existsSync(path.join(fixture.appDir, 'var')), false);
    assert.deepEqual(await fsp.readdir(fixture.homeDir), []);
    assert.deepEqual(readFakeState(fixture).calls, []);
  } finally {
    await cleanupFixture(fixture);
  }
});

test('dashboard-install refuses to render when bin/dashboard-start is not executable', async () => {
  const fixture = await makeInstallerFixture();
  await fsp.chmod(path.join(fixture.appDir, 'bin', 'dashboard-start'), 0o644);
  try {
    const result = spawnSync(process.execPath, [fixture.installerPath, '--dry-run', '--node', process.execPath], {
      env: fakeLaunchctlEnv(fixture),
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /start script is missing or not executable/);
    assert.equal(fs.existsSync(path.join(fixture.appDir, 'var')), false);
  } finally {
    await cleanupFixture(fixture);
  }
});

test('dashboard-install restores and re-bootstraps the previous plist after startup failure', async () => {
  const fixture = await makeInstallerFixture({ loaded: true, codes: { bootstrap: [1] } });
  const previousPlist = await writePreviousPlist(fixture);
  try {
    const result = runInstall(fixture, await freePort());
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /new dashboard job did not start/);
    assert.match(result.stderr, /previous plist was restored and its job loaded again/);
    assert.equal(await fsp.readFile(fixture.installedPath, 'utf8'), previousPlist);

    const state = readFakeState(fixture);
    assert.equal(state.loaded, true);
    assert.equal(countCalls(state, 'bootout'), 1);
    assert.equal(countCalls(state, 'bootstrap'), 2);
    assert.equal(countCalls(state, 'kickstart'), 0);

    const backups = (await fsp.readdir(path.join(fixture.appDir, 'var', 'launchd')))
      .filter((name) => name.startsWith('backup-'));
    assert.equal(backups.length, 1);
    assert.equal(
      await fsp.readFile(path.join(fixture.appDir, 'var', 'launchd', backups[0]), 'utf8'),
      previousPlist,
    );
  } finally {
    await cleanupFixture(fixture);
  }
});

test('dashboard-install retries a rollback bootstrap that fails while the old job exits', async () => {
  const fixture = await makeInstallerFixture({ loaded: true, codes: { bootstrap: [1, 5] } });
  const previousPlist = await writePreviousPlist(fixture);
  try {
    const result = runInstall(fixture, await freePort());
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /previous plist was restored and its job loaded again/);
    assert.equal(await fsp.readFile(fixture.installedPath, 'utf8'), previousPlist);
    const state = readFakeState(fixture);
    assert.equal(countCalls(state, 'bootstrap'), 3);
    assert.equal(state.loaded, true);
  } finally {
    await cleanupFixture(fixture);
  }
});

test('dashboard-install leaves a previously unloaded plist unloaded on rollback', async () => {
  const fixture = await makeInstallerFixture({ loaded: false, codes: { bootstrap: [1] } });
  const previousPlist = await writePreviousPlist(fixture);
  try {
    const result = runInstall(fixture, await freePort());
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /it was not loaded before, so it was left unloaded/);
    assert.equal(await fsp.readFile(fixture.installedPath, 'utf8'), previousPlist);
    const state = readFakeState(fixture);
    assert.equal(countCalls(state, 'bootout'), 0);
    assert.equal(countCalls(state, 'bootstrap'), 1);
    assert.equal(state.loaded, false);
  } finally {
    await cleanupFixture(fixture);
  }
});

test('dashboard-install installs when the job owns the listener, tolerating a not-loaded bootout', async () => {
  const port = await freePort();
  const fixture = await makeInstallerFixture({
    loaded: true,
    serve: true,
    stillLoadedPrints: 2,
    codes: { bootout: [3], bootstrap: [5] },
  });
  await writePreviousPlist(fixture);
  try {
    const result = runInstall(fixture, port);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Health check passed/);
    const state = readFakeState(fixture);
    assert.equal(state.loaded, true);
    assert.equal(countCalls(state, 'bootout'), 1);
    assert.equal(countCalls(state, 'bootstrap'), 2);
    assert.equal(countCalls(state, 'kickstart'), 1);
    assert.match(await fsp.readFile(fixture.installedPath, 'utf8'), /com\.personal-assistant\.dashboard/);
  } finally {
    await cleanupFixture(fixture);
  }
});

test('dashboard-install rolls back when another process holds the listener', async () => {
  const fixture = await makeInstallerFixture({ loaded: false, serve: true, reportWrongPid: true });
  try {
    const result = runInstall(fixture, await freePort());
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not by the job's pid/);
    assert.match(result.stderr, /No previous job was installed/);
    assert.equal(fs.existsSync(fixture.installedPath), false);
    assert.equal(readFakeState(fixture).loaded, false);
  } finally {
    await cleanupFixture(fixture);
  }
});

test('dashboard-install aborts before writing the plist when the port already answers', async () => {
  const fixture = await makeInstallerFixture({ loaded: false });
  const server = net.createServer((socket) => socket.destroy());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  assert.equal(RESERVED_PORTS.has(port), false);
  try {
    const result = runInstall(fixture, port);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(`already listening on 127\\.0\\.0\\.1:${port}`));
    assert.equal(fs.existsSync(fixture.installedPath), false);
    const state = readFakeState(fixture);
    assert.equal(countCalls(state, 'bootstrap'), 0);
    assert.equal(countCalls(state, 'kickstart'), 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await cleanupFixture(fixture);
  }
});

test('dashboard-install refuses to render when an API key is in its environment', async () => {
  for (const name of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY']) {
    const fixture = await makeInstallerFixture();
    try {
      const result = spawnSync(process.execPath, [fixture.installerPath, '--dry-run', '--node', process.execPath], {
        env: { ...fakeLaunchctlEnv(fixture), [name]: 'invented-key' },
        encoding: 'utf8',
      });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, new RegExp(`${name} is set in this environment`));
      assert.match(result.stderr, /must bill the Claude subscription/);
      assert.equal(fs.existsSync(path.join(fixture.appDir, 'var')), false);
      assert.deepEqual(readFakeState(fixture).calls, []);
    } finally {
      await cleanupFixture(fixture);
    }
  }
});

test('dashboard-install refuses to unload a dashboard with busy personas unless forced', async () => {
  const fixture = await makeInstallerFixture({ loaded: true });
  await writePreviousPlist(fixture);
  const agents = [
    { id: 'cfo', name: 'CFO', state: 'busy' },
    { id: 'coach', name: 'Coach', state: 'waiting' },
    { id: 'ops', name: 'Ops', state: null },
    { id: 'dev', name: 'Dev', state: 'idle' },
  ];
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ revision: 1, agents }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  assert.equal(RESERVED_PORTS.has(port), false);
  try {
    let result = await runInstallAsync(fixture, port);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /persona turns are still running \(CFO, Coach\)/);
    assert.match(result.stderr, /--force/);
    assert.deepEqual(requests, ['/api/state']);
    assert.equal(countCalls(readFakeState(fixture), 'bootout'), 0);
    assert.equal(readFakeState(fixture).loaded, true);

    result = await runInstallAsync(fixture, port, ['--force']);
    assert.doesNotMatch(result.stderr, /persona turns are still running/);
    assert.equal(requests.length, 1);
    assert.equal(countCalls(readFakeState(fixture), 'bootout'), 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await cleanupFixture(fixture);
  }
});

test('dashboard-install goes on when the running dashboard has no busy personas', async () => {
  const fixture = await makeInstallerFixture({ loaded: true });
  await writePreviousPlist(fixture);
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ agents: [{ id: 'cfo', name: 'CFO', state: 'idle' }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const result = await runInstallAsync(fixture, port);
    assert.doesNotMatch(result.stderr, /persona turns are still running/);
    assert.equal(countCalls(readFakeState(fixture), 'bootout'), 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await cleanupFixture(fixture);
  }
});

test('dashboard-uninstall rejects another label without side effects', async () => {
  const fixture = await makeInstallerFixture({ loaded: true });
  try {
    const result = spawnSync(process.execPath, [
      path.join(APP_DIR, 'bin', 'dashboard-uninstall'),
      '--label',
      'com.focus.server',
    ], {
      env: fakeLaunchctlEnv(fixture),
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /refusing to operate on label/);
    assert.deepEqual(await fsp.readdir(fixture.homeDir), []);
    assert.deepEqual(readFakeState(fixture).calls, []);
  } finally {
    await cleanupFixture(fixture);
  }
});

test('dashboard-uninstall rejects a plist path outside LaunchAgents without side effects', async () => {
  const fixture = await makeInstallerFixture({ loaded: true });
  const outsidePath = path.join(fixture.rootDir, 'outside.plist');
  await fsp.writeFile(outsidePath, 'keep\n');
  try {
    const result = spawnSync(process.execPath, [
      path.join(APP_DIR, 'bin', 'dashboard-uninstall'),
      '--plist',
      outsidePath,
    ], {
      env: fakeLaunchctlEnv(fixture),
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /refusing to remove plist outside/);
    assert.equal(await fsp.readFile(outsidePath, 'utf8'), 'keep\n');
    assert.deepEqual(await fsp.readdir(fixture.homeDir), []);
    assert.deepEqual(readFakeState(fixture).calls, []);
  } finally {
    await cleanupFixture(fixture);
  }
});

test('dashboard-uninstall boots out only its own label and removes only its plist', async () => {
  const fixture = await makeInstallerFixture({ loaded: true });
  await writePreviousPlist(fixture);
  const focusPlist = path.join(path.dirname(fixture.installedPath), 'com.focus.server.plist');
  await fsp.writeFile(focusPlist, 'focus\n');
  try {
    const result = spawnSync(process.execPath, [path.join(APP_DIR, 'bin', 'dashboard-uninstall')], {
      env: fakeLaunchctlEnv(fixture),
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(fixture.installedPath), false);
    assert.equal(await fsp.readFile(focusPlist, 'utf8'), 'focus\n');
    const { calls } = readFakeState(fixture);
    assert.deepEqual(calls, [`bootout gui/${process.getuid()}/${LABEL}`]);
  } finally {
    await cleanupFixture(fixture);
  }
});

test('dashboard-start rotates an oversized log before starting Node', async () => {
  const rootDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dashboard-start-'));
  const appDir = path.join(rootDir, 'app');
  const logDir = path.join(appDir, 'var', 'log');
  const fakeNode = path.join(rootDir, 'fake-node');
  await fsp.mkdir(path.join(appDir, 'bin'), { recursive: true });
  await fsp.mkdir(logDir, { recursive: true });
  await fsp.copyFile(path.join(APP_DIR, 'bin', 'dashboard-start'), path.join(appDir, 'bin', 'dashboard-start'));
  await fsp.chmod(path.join(appDir, 'bin', 'dashboard-start'), 0o755);
  await fsp.writeFile(fakeNode, '#!/bin/sh\nprintf \'fake node %s\\n\' "$*"\n', { mode: 0o755 });
  const oversized = 5 * 1024 * 1024 + 1;
  await fsp.writeFile(path.join(logDir, 'dashboard.log'), Buffer.alloc(oversized, 'a'));
  await fsp.writeFile(path.join(logDir, 'dashboard.log.1'), 'older\n');
  try {
    const run = () => spawnSync(path.join(appDir, 'bin', 'dashboard-start'), [fakeNode], { encoding: 'utf8' });
    let result = run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal((await fsp.stat(path.join(logDir, 'dashboard.log.1'))).size, oversized);
    const expectedLine = `fake node ${path.join(appDir, 'server.mjs')}\n`;
    assert.equal(await fsp.readFile(path.join(logDir, 'dashboard.log'), 'utf8'), expectedLine);

    result = run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await fsp.readFile(path.join(logDir, 'dashboard.log'), 'utf8'), expectedLine.repeat(2));
    assert.equal((await fsp.stat(path.join(logDir, 'dashboard.log.1'))).size, oversized);
  } finally {
    await fsp.rm(rootDir, { recursive: true, force: true });
  }
});

async function makeInstallerFixture(fakeState = {}) {
  const rootDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dashboard-install-'));
  const appDir = path.join(rootDir, 'app');
  const homeDir = path.join(rootDir, 'home');
  const fakeBinDir = path.join(rootDir, 'fake-bin');
  await Promise.all([
    fsp.mkdir(path.join(appDir, 'bin'), { recursive: true }),
    fsp.mkdir(path.join(appDir, 'lib'), { recursive: true }),
    fsp.mkdir(path.join(appDir, 'launchd'), { recursive: true }),
    fsp.mkdir(homeDir),
    fsp.mkdir(fakeBinDir),
  ]);
  const installerPath = path.join(appDir, 'bin', 'dashboard-install');
  await Promise.all([
    fsp.copyFile(path.join(APP_DIR, 'bin', 'dashboard-install'), installerPath),
    fsp.copyFile(path.join(APP_DIR, 'bin', 'dashboard-start'), path.join(appDir, 'bin', 'dashboard-start')),
    fsp.copyFile(path.join(APP_DIR, 'lib', 'launchd.mjs'), path.join(appDir, 'lib', 'launchd.mjs')),
    fsp.copyFile(path.join(APP_DIR, 'lib', 'config.mjs'), path.join(appDir, 'lib', 'config.mjs')),
    fsp.copyFile(path.join(APP_DIR, 'package.json'), path.join(appDir, 'package.json')),
    fsp.copyFile(
      path.join(APP_DIR, 'launchd', `${LABEL}.plist.template`),
      path.join(appDir, 'launchd', `${LABEL}.plist.template`),
    ),
  ]);
  await fsp.chmod(path.join(appDir, 'bin', 'dashboard-start'), 0o755);

  const statePath = path.join(rootDir, 'launchctl-state.json');
  await fsp.writeFile(statePath, JSON.stringify({
    loaded: false,
    pid: null,
    calls: [],
    codes: {},
    stillLoadedPrints: 0,
    ...fakeState,
  }));
  await fsp.writeFile(path.join(fakeBinDir, 'launchctl'), FAKE_LAUNCHCTL, { mode: 0o755 });

  return {
    rootDir,
    appDir,
    homeDir,
    fakeBinDir,
    installerPath,
    statePath,
    installedPath: path.join(homeDir, 'Library', 'LaunchAgents', `${LABEL}.plist`),
    fakeEnv: { FAKE_LAUNCHCTL_STATE: statePath },
  };
}

// A stand-in for launchctl that tracks one job's loaded state in a JSON file.
// `codes.<subcommand>` lists exit codes consumed one per call (then 0). With
// `serve`, a successful bootstrap starts a loopback HTTP server that plays the
// job; `reportWrongPid` makes `print` report a different pid for it.
const FAKE_LAUNCHCTL = `#!${process.execPath}
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const statePath = process.env.FAKE_LAUNCHCTL_STATE;
if (!statePath) { console.error('fake launchctl: FAKE_LAUNCHCTL_STATE is not set'); process.exit(99); }
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const args = process.argv.slice(2);
const command = args[0];
state.calls.push(args.join(' '));
const save = () => fs.writeFileSync(statePath, JSON.stringify(state));
const nextCode = () => (state.codes[command] ?? []).shift() ?? 0;
const stopServer = () => {
  if (state.pid) { try { process.kill(state.pid); } catch {} }
  state.pid = null;
};
let code = 0;
if (command === 'print') {
  if (state.loaded || state.stillLoadedPrints > 0) {
    if (!state.loaded) state.stillLoadedPrints -= 1;
    const pid = state.reportWrongPid ? 1 : state.pid ?? 4321;
    process.stdout.write('gui/501/job = {\\n\\tstate = running\\n\\tpid = ' + pid + '\\n}\\n');
  } else {
    process.stderr.write('Could not find service in domain\\n');
    code = 113;
  }
} else if (command === 'bootout') {
  code = nextCode();
  if (code === 3) process.stderr.write('Boot-out failed: 3: No such process\\n');
  else if (code !== 0) process.stderr.write('Boot-out failed: ' + code + '\\n');
  if (code === 0 || code === 3) { state.loaded = false; stopServer(); }
} else if (command === 'bootstrap') {
  code = nextCode();
  if (code === 0) {
    state.loaded = true;
    if (state.serve) {
      const port = Number(fs.readFileSync(args[2], 'utf8').match(/<key>DASHBOARD_PORT<\\/key>\\s*<string>(\\d+)</)[1]);
      const child = spawn(process.execPath, ['-e',
        "require('node:http').createServer((q, r) => r.end('ok')).listen(" + port + ", '127.0.0.1')"],
        { detached: true, stdio: 'ignore' });
      child.unref();
      state.pid = child.pid;
    }
  } else if (code === 5) {
    process.stderr.write('Bootstrap failed: 5: Input/output error\\n');
  } else {
    process.stderr.write('Bootstrap failed: ' + code + '\\n');
  }
} else {
  code = nextCode();
}
save();
process.exit(code);
`;

const RESERVED_PORTS = new Set([4242, 4243, 8765]);

function fakeLaunchctlEnv(fixture) {
  const inherited = { ...process.env };
  delete inherited.ANTHROPIC_API_KEY;
  delete inherited.OPENAI_API_KEY;
  return {
    ...inherited,
    HOME: fixture.homeDir,
    PATH: `${fixture.fakeBinDir}:${process.env.PATH}`,
    ...fixture.fakeEnv,
  };
}

function runInstall(fixture, port) {
  assert.equal(RESERVED_PORTS.has(port), false);
  return spawnSync(process.execPath, [
    fixture.installerPath,
    '--public-origin',
    'https://example.tailnet.ts.net',
    '--node',
    process.execPath,
    '--port',
    String(port),
  ], {
    env: { ...fakeLaunchctlEnv(fixture), DASHBOARD_INSTALL_ALLOW_HOME_OVERRIDE: '1' },
    encoding: 'utf8',
  });
}

// runInstall without blocking this process, so a server in the test can answer.
function runInstallAsync(fixture, port, extra = []) {
  assert.equal(RESERVED_PORTS.has(port), false);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [
      fixture.installerPath,
      '--public-origin',
      'https://example.tailnet.ts.net',
      '--node',
      process.execPath,
      '--port',
      String(port),
      ...extra,
    ], { env: { ...fakeLaunchctlEnv(fixture), DASHBOARD_INSTALL_ALLOW_HOME_OVERRIDE: '1' } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => { stderr += data; });
    child.once('exit', (status) => resolve({ status, stdout, stderr }));
  });
}

function readFakeState(fixture) {
  return JSON.parse(fs.readFileSync(fixture.statePath, 'utf8'));
}

function countCalls(state, command) {
  return state.calls.filter((call) => call.split(' ')[0] === command).length;
}

async function writePreviousPlist(fixture) {
  const previousPlist = '<?xml version="1.0"?><plist><dict><key>Label</key><string>previous</string></dict></plist>\n';
  await fsp.mkdir(path.dirname(fixture.installedPath), { recursive: true });
  await fsp.writeFile(fixture.installedPath, previousPlist);
  return previousPlist;
}

async function cleanupFixture(fixture) {
  try {
    const { pid } = readFakeState(fixture);
    if (pid) process.kill(pid);
  } catch {
    // The fake job already exited or never started.
  }
  await fsp.rm(fixture.rootDir, { recursive: true, force: true });
}

async function freePort() {
  for (;;) {
    const server = net.createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    await new Promise((resolve) => server.close(resolve));
    if (!RESERVED_PORTS.has(port)) return port;
  }
}

function xmlEscape(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function listTree(rootDir, relativeDir = '') {
  const entries = await fsp.readdir(path.join(rootDir, relativeDir), { withFileTypes: true });
  const paths = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relativePath = path.join(relativeDir, entry.name);
    paths.push(entry.isDirectory() ? `${relativePath}/` : relativePath);
    if (entry.isDirectory()) paths.push(...await listTree(rootDir, relativePath));
  }
  return paths;
}
