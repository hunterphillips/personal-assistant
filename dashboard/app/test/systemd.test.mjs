import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { renderUnit, validateUnitInputs } from '../lib/systemd.mjs';

const APP_DIR = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const LABEL = 'com.personal-assistant.dashboard';

const VALID_INPUTS = {
  label: LABEL,
  nodePath: '/opt/node/bin/node',
  appDir: '/home/example/dashboard/app',
  home: '/home/example/.personal-assistant',
  port: 4243,
  publicOrigin: 'https://example.tailnet.ts.net',
};

test('renderUnit renders the user unit the installer writes', () => {
  assert.equal(renderUnit({ ...VALID_INPUTS, focusOrigin: 'http://127.0.0.1:4242' }), `[Unit]
Description=Personal assistant dashboard

[Service]
ExecStart="/home/example/dashboard/app/bin/dashboard-start" "/opt/node/bin/node"
WorkingDirectory=/home/example/dashboard/app
Environment="PATH=/opt/node/bin:/usr/local/bin:/usr/bin:/bin"
Environment="DASHBOARD_PORT=4243"
Environment="DASHBOARD_PUBLIC_ORIGIN=https://example.tailnet.ts.net"
Environment="DASHBOARD_FOCUS_ORIGIN=http://127.0.0.1:4242"
Restart=on-failure
StandardOutput=append:%h/.personal-assistant/log/dashboard.log
StandardError=append:%h/.personal-assistant/log/dashboard.log

[Install]
WantedBy=default.target
`);
});

test('renderUnit names the data root in the environment and the log only when asked', () => {
  const unit = renderUnit({ ...VALID_INPUTS, home: '/srv/assistant data', exportHome: true });
  assert.match(unit, /^Environment="PERSONAL_ASSISTANT_HOME=\/srv\/assistant data"$/m);
  assert.match(unit, /^StandardOutput=append:\/srv\/assistant data\/log\/dashboard\.log$/m);
  assert.match(unit, /^StandardError=append:\/srv\/assistant data\/log\/dashboard\.log$/m);
  assert.doesNotMatch(unit, /%h/);
  assert.doesNotMatch(renderUnit(VALID_INPUTS), /PERSONAL_ASSISTANT_HOME/, 'the default root is not written into the unit');
});

test('renderUnit quotes and escapes values for systemd', () => {
  const unit = renderUnit({
    ...VALID_INPUTS,
    nodePath: '/opt/Node "100%" $HOME/bin/node',
    appDir: '/home/example/Dashboard 50% app',
    briefsDir: '/home/example/Briefs "daily"',
  });
  assert.match(unit, /^ExecStart="\/home\/example\/Dashboard 50%% app\/bin\/dashboard-start" "\/opt\/Node \\"100%%\\" \$\$HOME\/bin\/node"$/m);
  assert.match(unit, /^WorkingDirectory=\/home\/example\/Dashboard 50%% app$/m);
  assert.match(unit, /^Environment="PATH=\/opt\/Node \\"100%%\\" \$HOME\/bin:\/usr\/local\/bin:\/usr\/bin:\/bin"$/m);
  assert.match(unit, /^Environment="DASHBOARD_BRIEFS_DIR=\/home\/example\/Briefs \\"daily\\""$/m);
});

test('renderUnit names the gh command only when given one', () => {
  assert.doesNotMatch(renderUnit(VALID_INPUTS), /DASHBOARD_GH_CLI/);
  const unit = renderUnit({ ...VALID_INPUTS, ghCli: '/usr/bin/gh' });
  assert.match(unit, /^Environment="DASHBOARD_GH_CLI=\/usr\/bin\/gh"$/m);
  assert.throws(() => validateUnitInputs({ ...VALID_INPUTS, ghCli: 'gh' }), /ghCli must be an absolute path/);
});

test('validateUnitInputs rejects relative paths, insecure origins, invalid ports, and characters a unit cannot carry', () => {
  assert.throws(() => validateUnitInputs({ ...VALID_INPUTS, nodePath: 'bin/node' }), /nodePath must be an absolute path/);
  assert.throws(() => validateUnitInputs({ ...VALID_INPUTS, appDir: 'dashboard/app' }), /appDir must be an absolute path/);
  assert.throws(() => validateUnitInputs({ ...VALID_INPUTS, briefsDir: 'briefs' }), /briefsDir must be an absolute path/);
  assert.throws(() => validateUnitInputs({ ...VALID_INPUTS, home: 'data' }), /home must be an absolute path/);
  assert.throws(() => validateUnitInputs({ ...VALID_INPUTS, home: undefined }), /home must be an absolute path/);
  assert.throws(
    () => validateUnitInputs({ ...VALID_INPUTS, publicOrigin: 'http://example.test' }),
    /publicOrigin must be a bare https:\/\/ origin/,
  );
  assert.throws(
    () => validateUnitInputs({ ...VALID_INPUTS, focusOrigin: 'http://example.test:4242' }),
    /focusOrigin must use a loopback hostname/,
  );
  for (const control of ['\u0000', '\n', '\r', '\u001b', '\u007f']) {
    assert.throws(
      () => validateUnitInputs({ ...VALID_INPUTS, appDir: `/home/example/app${control}` }),
      /appDir contains characters that cannot appear in a unit/,
    );
  }
  assert.throws(
    () => validateUnitInputs({ ...VALID_INPUTS, appDir: '/home/example/app\\' }),
    /appDir must not contain a backslash/,
  );
  for (const port of [0, 65536, 1.5, Number.NaN]) {
    assert.throws(() => validateUnitInputs({ ...VALID_INPUTS, port }), /port must be an integer/);
  }
});

test('dashboard-install dry run on systemd prints the unit and its commands and writes only the rendered unit', async () => {
  const fixture = await makeInstallerFixture();
  try {
    const before = await listTree(fixture.appDir);
    const result = spawnSync(process.execPath, [fixture.installerPath, '--dry-run', '--node', process.execPath], {
      env: fakeSystemctlEnv(fixture),
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);

    const renderedPath = path.join(fixture.dataHome, 'cache', 'systemd', `${LABEL}.service`);
    const unit = await fsp.readFile(renderedPath, 'utf8');
    assert.equal(result.stdout, [
      `${renderedPath}\n`,
      '\n',
      unit,
      '\n',
      `An install copies it to ${fixture.installedPath} and runs:\n`,
      '  systemctl --user daemon-reload\n',
      `  systemctl --user enable --now ${LABEL}\n`,
    ].join(''));
    assert.match(result.stderr, /lingering is not enabled for .*, so the dashboard stops at logout/);
    assert.deepEqual(await listTree(fixture.homeDir), [
      '.personal-assistant/',
      '.personal-assistant/cache/',
      '.personal-assistant/cache/systemd/',
      `.personal-assistant/cache/systemd/${LABEL}.service`,
    ]);
    assert.deepEqual(readFakeState(fixture).calls, []);
    assert.deepEqual(await listTree(fixture.appDir), before, 'nothing is written in the app');
  } finally {
    await cleanupFixture(fixture);
  }
});

test('dashboard-install writes the gh it finds on its PATH into the unit, and says so when it finds none', async () => {
  const fixture = await makeInstallerFixture();
  try {
    const renderedPath = path.join(fixture.dataHome, 'cache', 'systemd', `${LABEL}.service`);
    const dryRun = (env) => spawnSync(process.execPath, [fixture.installerPath, '--dry-run', '--node', process.execPath], {
      env, encoding: 'utf8',
    });

    const missing = dryRun({ ...fakeSystemctlEnv(fixture), PATH: fixture.fakeBinDir });
    assert.equal(missing.status, 0, missing.stderr || missing.stdout);
    assert.match(missing.stderr, /the Focus GitHub scan needs gh on the daemon's PATH or DASHBOARD_GH_CLI/);
    assert.doesNotMatch(await fsp.readFile(renderedPath, 'utf8'), /DASHBOARD_GH_CLI/);

    const ghPath = path.join(fixture.fakeBinDir, 'gh');
    await fsp.writeFile(ghPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const found = dryRun({ ...fakeSystemctlEnv(fixture), PATH: fixture.fakeBinDir });
    assert.equal(found.status, 0, found.stderr || found.stdout);
    assert.doesNotMatch(found.stderr, /needs gh/);
    const unit = await fsp.readFile(renderedPath, 'utf8');
    assert.equal(unit.split('\n').filter((line) => line === `Environment="DASHBOARD_GH_CLI=${ghPath}"`).length, 1);
  } finally {
    await cleanupFixture(fixture);
  }
});

test('dashboard-install on systemd installs, enables, and starts a fresh unit that owns the listener', async () => {
  const port = await freePort();
  const fixture = await makeInstallerFixture({ serve: true });
  fixture.fakeEnv.FAKE_LINGER = 'yes';
  try {
    const result = runInstall(fixture, port);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /^Lingering is enabled for .*, so the dashboard keeps running after logout\.$/m);
    assert.doesNotMatch(result.stderr, /lingering/);
    assert.match(result.stdout, /Health check passed/);
    assert.doesNotMatch(result.stdout, /Previous unit saved/);

    const state = readFakeState(fixture);
    assert.deepEqual(state.calls, [
      `--user is-enabled ${LABEL}`,
      `--user is-active ${LABEL}`,
      '--user daemon-reload',
      `--user reset-failed ${LABEL}`,
      `--user enable --now ${LABEL}`,
      `--user show -p MainPID --value ${LABEL}`,
    ]);
    assert.equal(state.active, true);
    assert.equal(state.enabled, true);

    const installed = await fsp.readFile(fixture.installedPath, 'utf8');
    assert.equal(installed, await fsp.readFile(path.join(fixture.dataHome, 'cache', 'systemd', `${LABEL}.service`), 'utf8'));
    assert.match(installed, new RegExp(`^Environment="DASHBOARD_PORT=${port}"$`, 'm'));
    assert.equal((await fsp.stat(path.join(fixture.dataHome, 'log'))).mode & 0o777, 0o700);
    assert.equal(fs.existsSync(path.join(fixture.homeDir, 'Library')), false);
  } finally {
    await cleanupFixture(fixture);
  }
});

test('dashboard-install on systemd backs up the previous unit, stops its service, and replaces it', async () => {
  const port = await freePort();
  const fixture = await makeInstallerFixture({ serve: true, active: true, enabled: true });
  const previousUnit = await writePreviousUnit(fixture);
  try {
    const result = runInstall(fixture, port);
    assert.equal(result.status, 0, result.stderr || result.stdout);

    const backups = (await fsp.readdir(path.join(fixture.dataHome, 'cache', 'systemd')))
      .filter((name) => name.startsWith('backup-'));
    assert.equal(backups.length, 1);
    assert.match(backups[0], /\.service$/);
    const backupPath = path.join(fixture.dataHome, 'cache', 'systemd', backups[0]);
    assert.equal(await fsp.readFile(backupPath, 'utf8'), previousUnit);
    assert.match(result.stdout, new RegExp(`Previous unit saved at ${escapeRegExp(backupPath)}`));

    const state = readFakeState(fixture);
    assert.equal(countCalls(state, 'stop'), 1);
    assert.equal(countCalls(state, 'enable'), 1);
    assert.equal(state.active, true);
    assert.notEqual(await fsp.readFile(fixture.installedPath, 'utf8'), previousUnit);
  } finally {
    await cleanupFixture(fixture);
  }
});

test('dashboard-install on systemd restores and restarts the previous unit when the health wait fails', async () => {
  const fixture = await makeInstallerFixture({ serve: false, active: true, enabled: true });
  const previousUnit = await writePreviousUnit(fixture);
  try {
    const result = runInstall(fixture, await freePort());
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /new dashboard service did not start: health check timed out/);
    assert.match(result.stderr, /previous unit was restored and its service started again/);
    assert.equal(await fsp.readFile(fixture.installedPath, 'utf8'), previousUnit);

    const state = readFakeState(fixture);
    assert.equal(state.active, true);
    assert.equal(state.enabled, true);
    assert.equal(countCalls(state, 'stop'), 2);
    assert.equal(countCalls(state, 'daemon-reload'), 2);
    assert.equal(countCalls(state, 'start'), 1);
    assert.equal(countCalls(state, 'disable'), 0);
  } finally {
    await cleanupFixture(fixture);
  }
});

test('dashboard-install on systemd stops a new unit stuck restarting and resets its start limit before restarting the previous one', async () => {
  const fixture = await makeInstallerFixture({ serve: true, crashNew: true, active: true, enabled: true });
  const previousUnit = await writePreviousUnit(fixture);
  try {
    const result = runInstall(fixture, await freePort());
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /health check timed out/);
    assert.match(result.stderr, /previous unit was restored and its service started again/);
    assert.equal(await fsp.readFile(fixture.installedPath, 'utf8'), previousUnit);
    const state = readFakeState(fixture);
    assert.equal(state.activating, false);
    assert.equal(state.active, true);
    assert.equal(state.startLimit, false);
  } finally {
    await cleanupFixture(fixture);
  }
});

test('dashboard-install on systemd removes and disables a new unit whose service does not own the listener', async () => {
  const fixture = await makeInstallerFixture({ serve: true, reportWrongPid: true });
  try {
    const result = runInstall(fixture, await freePort());
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not by the service's pid/);
    assert.match(result.stderr, /No previous service was installed/);
    assert.equal(fs.existsSync(fixture.installedPath), false);
    const state = readFakeState(fixture);
    assert.equal(state.active, false);
    assert.equal(state.enabled, false);
  } finally {
    await cleanupFixture(fixture);
  }
});

test('dashboard-uninstall on systemd disables and stops its unit and removes only its file', async () => {
  const fixture = await makeInstallerFixture({ active: true, enabled: true });
  await writePreviousUnit(fixture);
  const focusUnit = path.join(path.dirname(fixture.installedPath), 'com.focus.server.service');
  await fsp.writeFile(focusUnit, 'focus\n');
  try {
    const result = runUninstall(fixture);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Uninstalled com\.personal-assistant\.dashboard/);
    assert.equal(fs.existsSync(fixture.installedPath), false);
    assert.equal(await fsp.readFile(focusUnit, 'utf8'), 'focus\n');
    const state = readFakeState(fixture);
    assert.deepEqual(state.calls, [`--user disable --now ${LABEL}`, '--user daemon-reload']);
    assert.equal(state.active, false);
  } finally {
    await cleanupFixture(fixture);
  }
});

test('dashboard-uninstall on systemd goes on when no unit is installed and refuses another label', async () => {
  const fixture = await makeInstallerFixture();
  try {
    const result = runUninstall(fixture);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readFakeState(fixture).calls, [
      `--user disable --now ${LABEL}`,
      `--user stop ${LABEL}`,
      '--user daemon-reload',
    ]);

    const refused = runUninstall(fixture, ['--label', 'com.focus.server']);
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /refusing to operate on label/);
    assert.equal(readFakeState(fixture).calls.length, 3);
  } finally {
    await cleanupFixture(fixture);
  }
});

async function makeInstallerFixture(fakeState = {}) {
  const rootDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dashboard-systemd-'));
  const appDir = path.join(rootDir, 'app');
  const homeDir = path.join(rootDir, 'home');
  const fakeBinDir = path.join(rootDir, 'fake-bin');
  await Promise.all([
    fsp.mkdir(path.join(appDir, 'bin'), { recursive: true }),
    fsp.mkdir(path.join(appDir, 'lib'), { recursive: true }),
    fsp.mkdir(path.join(appDir, 'launchd'), { recursive: true }),
    fsp.mkdir(path.join(appDir, 'systemd'), { recursive: true }),
    fsp.mkdir(homeDir),
    fsp.mkdir(fakeBinDir),
  ]);
  const installerPath = path.join(appDir, 'bin', 'dashboard-install');
  const copies = [
    'bin/dashboard-install',
    'bin/dashboard-uninstall',
    'bin/dashboard-start',
    'lib/launchd.mjs',
    'lib/systemd.mjs',
    'lib/config.mjs',
    'lib/layout.mjs',
    'package.json',
    `launchd/${LABEL}.plist.template`,
    `systemd/${LABEL}.service.template`,
  ];
  await Promise.all(copies.map((file) => fsp.copyFile(path.join(APP_DIR, file), path.join(appDir, file))));
  await fsp.chmod(path.join(appDir, 'bin', 'dashboard-start'), 0o755);

  const statePath = path.join(rootDir, 'systemctl-state.json');
  await fsp.writeFile(statePath, JSON.stringify({
    enabled: false,
    active: false,
    pid: null,
    port: null,
    calls: [],
    codes: {},
    ...fakeState,
  }));
  await fsp.writeFile(path.join(fakeBinDir, 'systemctl'), FAKE_SYSTEMCTL, { mode: 0o755 });
  await fsp.writeFile(path.join(fakeBinDir, 'loginctl'), FAKE_LOGINCTL, { mode: 0o755 });
  await fsp.writeFile(path.join(fakeBinDir, 'ss'), FAKE_SS, { mode: 0o755 });

  return {
    rootDir,
    appDir,
    homeDir,
    dataHome: path.join(homeDir, '.personal-assistant'),
    installerPath,
    uninstallerPath: path.join(appDir, 'bin', 'dashboard-uninstall'),
    fakeBinDir,
    statePath,
    installedPath: path.join(homeDir, '.config', 'systemd', 'user', `${LABEL}.service`),
    fakeEnv: { FAKE_SYSTEMCTL_STATE: statePath },
  };
}

// A stand-in for `systemctl --user` that tracks one unit's enabled and active
// state in a JSON file. `codes.<subcommand>` lists exit codes consumed one per
// call (then 0). With `serve`, starting the unit starts a loopback HTTP server
// on the installed unit's DASHBOARD_PORT that plays the service;
// `reportWrongPid` makes `show` report a different MainPID for it. With
// `crashNew`, a rendered unit crashes on start: it sits in activating
// (auto-restart) and hits the start limit until reset-failed.
const FAKE_SYSTEMCTL = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const statePath = process.env.FAKE_SYSTEMCTL_STATE;
if (!statePath) { console.error('fake systemctl: FAKE_SYSTEMCTL_STATE is not set'); process.exit(99); }
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const args = process.argv.slice(2);
if (args[0] !== '--user') { console.error('fake systemctl: only --user is supported'); process.exit(98); }
const command = args[1];
const label = args[args.length - 1];
state.calls.push(args.join(' '));
const unitPath = path.join(process.env.HOME, '.config', 'systemd', 'user', label + '.service');
const save = () => fs.writeFileSync(statePath, JSON.stringify(state));
const nextCode = () => (state.codes[command] ?? []).shift() ?? 0;
const stop = () => {
  if (state.pid) { try { process.kill(state.pid); } catch {} }
  state.pid = null;
  state.active = false;
  state.activating = false;
};
const start = () => {
  if (state.startLimit) {
    process.stderr.write('Job for ' + label + '.service failed. Start request repeated too quickly.\\n');
    return 1;
  }
  if (state.crashNew && fs.readFileSync(unitPath, 'utf8').includes('dashboard-start')) {
    state.activating = true;
    state.startLimit = true;
    return 0;
  }
  state.active = true;
  if (!state.serve) return 0;
  const portMatch = fs.readFileSync(unitPath, 'utf8').match(/^Environment="DASHBOARD_PORT=(\\d+)"$/m);
  if (!portMatch) return 0;
  const port = Number(portMatch[1]);
  const child = spawn(process.execPath, ['-e',
    "require('node:http').createServer((q, r) => r.end('ok')).listen(" + port + ", '127.0.0.1')"],
    { detached: true, stdio: 'ignore' });
  child.unref();
  state.pid = child.pid;
  state.port = port;
  return 0;
};
let code = nextCode();
if (code === 0) {
  if (command === 'is-enabled') code = state.enabled ? 0 : 1;
  else if (command === 'is-active') {
    process.stdout.write(state.active ? 'active\\n' : state.activating ? 'activating\\n' : 'inactive\\n');
    code = state.active ? 0 : 3;
  }
  else if (command === 'enable') {
    if (!fs.existsSync(unitPath)) { process.stderr.write('Failed to enable unit: Unit file ' + label + '.service does not exist.\\n'); code = 1; }
    else { state.enabled = true; if (args.includes('--now')) code = start(); }
  }
  else if (command === 'disable') {
    if (!fs.existsSync(unitPath)) { process.stderr.write('Failed to disable unit: Unit file ' + label + '.service does not exist.\\n'); code = 1; }
    else { state.enabled = false; if (args.includes('--now')) stop(); }
  }
  else if (command === 'start') code = start();
  else if (command === 'stop') {
    if (!fs.existsSync(unitPath) && !state.active && !state.activating) {
      process.stderr.write('Failed to stop ' + label + '.service: Unit ' + label + '.service not loaded.\\n');
      code = 5;
    } else stop();
  }
  else if (command === 'reset-failed') state.startLimit = false;
  else if (command === 'show') process.stdout.write((state.active ? (state.reportWrongPid ? 1 : state.pid ?? 4321) : 0) + '\\n');
}
save();
process.exit(code);
`;

const FAKE_LOGINCTL = `#!/bin/sh
echo "Linger=\${FAKE_LINGER:-no}"
`;

// Lists the fake service's listener the way ss -Hltnp does.
const FAKE_SS = `#!${process.execPath}
const fs = require('node:fs');
const state = JSON.parse(fs.readFileSync(process.env.FAKE_SYSTEMCTL_STATE, 'utf8'));
if (state.pid && state.active) {
  process.stdout.write('LISTEN 0 511 127.0.0.1:' + state.port + ' 0.0.0.0:* users:(("node",pid=' + state.pid + ',fd=20))\\n');
}
`;

const RESERVED_PORTS = new Set([4242, 4243, 8765]);

function fakeSystemctlEnv(fixture) {
  const inherited = { ...process.env };
  delete inherited.ANTHROPIC_API_KEY;
  delete inherited.OPENAI_API_KEY;
  delete inherited.PERSONAL_ASSISTANT_HOME;
  return {
    ...inherited,
    HOME: fixture.homeDir,
    PATH: `${fixture.fakeBinDir}:${process.env.PATH}`,
    DASHBOARD_JOB_RUNNER: 'systemd',
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
    env: { ...fakeSystemctlEnv(fixture), DASHBOARD_INSTALL_ALLOW_HOME_OVERRIDE: '1' },
    encoding: 'utf8',
  });
}

function runUninstall(fixture, args = []) {
  return spawnSync(process.execPath, [fixture.uninstallerPath, ...args], {
    env: fakeSystemctlEnv(fixture),
    encoding: 'utf8',
  });
}

function readFakeState(fixture) {
  return JSON.parse(fs.readFileSync(fixture.statePath, 'utf8'));
}

function countCalls(state, command) {
  return state.calls.filter((call) => call.split(' ')[1] === command).length;
}

async function writePreviousUnit(fixture) {
  const previousUnit = '[Service]\nExecStart=/bin/true\n';
  await fsp.mkdir(path.dirname(fixture.installedPath), { recursive: true });
  await fsp.writeFile(fixture.installedPath, previousUnit);
  return previousUnit;
}

async function cleanupFixture(fixture) {
  try {
    const { pid } = readFakeState(fixture);
    if (pid) process.kill(pid);
  } catch {
    // The fake service already exited or never started.
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
