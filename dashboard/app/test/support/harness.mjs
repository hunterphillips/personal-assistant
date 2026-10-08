// Test helpers: ephemeral loopback servers, temporary directories, and a raw
// HTTP client that sends paths and headers exactly as given.

import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createApp } from '../../lib/app.mjs';
import { createBriefRoutes } from '../../lib/brief-adapter.mjs';
import { createFeeds } from '../../lib/feeds.mjs';
import { createBriefInstructions } from '../../lib/brief-instructions.mjs';
import { loadConfig } from '../../lib/config.mjs';
import { createFocusProxy } from '../../lib/focus-proxy.mjs';
import { createGoals } from '../../lib/goals.mjs';
import { createHub } from '../../lib/hub.mjs';
import { RegistryError, validateDocument } from '../../lib/registry.mjs';
import { DEFAULTS as SETTINGS_DEFAULTS, SettingsError, validatePatch } from '../../lib/settings.mjs';
import { createSources } from '../../lib/sources.mjs';

export async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}

export async function closeServer(server) {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}

export async function freePort() {
  const server = http.createServer();
  const port = await listen(server);
  await closeServer(server);
  return port;
}

export async function tempDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dashboard-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

// A synthetic Focus upstream that records every request it receives and
// answers once the request body has been read.
export async function startSyntheticFocus(t) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url });
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"synthetic":true}');
    });
  });
  const port = await listen(server);
  t.after(() => closeServer(server));
  return { origin: `http://127.0.0.1:${port}`, requests };
}

// A registry that never reads a file: current() returns `agents` as loaded.
// write(mutate) applies the mutation in memory, validating with the real
// validateDocument except that any absolute path counts as a folder (test
// agents live in invented folders); `writes` keeps each candidate document.
// set(fields) changes current() and notifies, as a reload would.
export function fakeRegistry(agents = [], { groups = [], ok = true, error = null } = {}) {
  const listeners = new Set();
  let current = Object.freeze({ ok, agents, groups, error, loadedAt: ok ? '2026-01-01T00:00:00.000Z' : null, path: '/invented/agents.json' });
  const notify = () => {
    for (const fn of [...listeners]) fn(current);
  };
  const fake = {
    writes: [],
    current: () => current,
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    set(fields) {
      current = Object.freeze({ ...current, ...fields });
      notify();
    },
    async write(mutate) {
      if (!current.ok && current.error !== 'registry_missing') throw new RegistryError('registry_invalid', [current.error]);
      const document = structuredClone({ version: 1, groups: [...current.groups], agents: current.agents.map((agent) => ({ ...agent })) });
      const candidate = mutate(document);
      const result = validateDocument(candidate, { isDirectory: (target) => path.isAbsolute(target) });
      if (!result.ok) throw new RegistryError('invalid_registry', result.problems);
      fake.writes.push(candidate);
      current = Object.freeze({ ok: true, agents: result.agents, groups: result.groups, error: null, loadedAt: new Date().toISOString(), path: current.path });
      notify();
      return { agents: result.agents, groups: result.groups };
    },
    start: async () => current,
    stop() {},
  };
  return fake;
}

// Jobs that run no subprocess; `calls` counts refreshes.
export function fakeJobs(jobs = []) {
  const fake = {
    calls: 0,
    async refresh() {
      fake.calls += 1;
      return { refreshedAt: new Date().toISOString(), focusAvailable: null, jobs };
    },
  };
  return fake;
}

// Terminal bindings that never read a file; `set(map)` replaces them and
// notifies the hub as a re-read would.
export function fakeBindings(initial = new Map()) {
  let current = initial;
  const listeners = new Set();
  return {
    current: () => current,
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    set(next) {
      current = next;
      for (const fn of listeners) fn(current);
    },
    start: async () => {},
    stop() {},
  };
}

// A settings store that never touches a file: current() answers DEFAULTS
// merged with `initial`, update() validates as the real store does and
// notifies, `fail(error)` makes it answer ok false (as an unreadable file
// would) until the next update, and `updates` records every patch.
export function fakeSettings(initial = {}, { ok = true, error = null } = {}) {
  const listeners = new Set();
  const merge = (base, patch) => Object.freeze({
    version: 1,
    model: Object.freeze({ ...base.model, ...(patch?.model ?? {}) }),
    brief: Object.freeze({ ...base.brief, ...(patch?.brief ?? {}) }),
    permission: Object.freeze({ ...base.permission, ...(patch?.permission ?? {}) }),
    quickChat: Object.freeze({ ...base.quickChat, ...(patch?.quickChat ?? {}) }),
  });
  let settings = merge(SETTINGS_DEFAULTS, initial);
  let state = Object.freeze({ ok, settings, error, loadedAt: '2026-01-01T00:00:00.000Z', path: '/invented/settings.json' });
  const notify = () => {
    for (const fn of [...listeners]) fn(state);
  };
  const fake = {
    updates: [],
    current: () => state,
    async load() {},
    async update(patch) {
      const problem = validatePatch(patch);
      if (problem) throw new SettingsError(problem);
      if (!state.ok) throw new SettingsError('settings_invalid', state.error);
      fake.updates.push(patch);
      settings = merge(settings, patch);
      state = Object.freeze({ ...state, settings });
      notify();
      return settings;
    },
    async seed(values) {
      settings = merge(SETTINGS_DEFAULTS, values);
      state = Object.freeze({ ...state, ok: true, error: null, settings });
      notify();
      return true;
    },
    fail(message) {
      state = Object.freeze({ ...state, ok: false, error: message });
      notify();
    },
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
  return fake;
}

// Builds a hub over the given focus and brief, with fake registry,
// jobs, and settings unless real ones are passed, and no persona
// adapters unless given.
export function createTestHub({
  config, focus, brief, registry = fakeRegistry(), jobs = fakeJobs(), routines = null, adapters = {}, store = null, bindings = null,
  cmux = null, settings = fakeSettings(), reads = null, briefReads = null, notifications = null, home = '/invented', log = () => {}, now = undefined,
}) {
  return createHub({
    registry, jobs, routines, focus, brief, timeouts: config.timeouts, limits: config.limits, adapters, store, bindings, cmux, settings, reads,
    briefReads, notifications, home, log,
    ...(now ? { now } : {}),
  });
}

// A cmux client that never touches a socket: `inventory` is what the next
// refresh() answers (set() replaces it), current() is the last refreshed
// answer (null until the first refresh, as the real client's), `refreshes`
// counts refresh calls, `focusCalls` records focus arguments, and
// `focusResult` is what focus() answers.
export function fakeCmux(inventory = null) {
  const fake = {
    inventory,
    last: null,
    refreshes: 0,
    focusCalls: [],
    focusResult: { ok: true, verified: true },
    current: () => fake.last,
    async refresh() {
      fake.refreshes += 1;
      fake.last = fake.inventory;
      return fake.last;
    },
    async focus(target) {
      fake.focusCalls.push(target);
      return fake.focusResult;
    },
    set(next) {
      fake.inventory = next;
    },
    close() {},
  };
  return fake;
}

// Starts the app on an ephemeral port. `focus` and `brief` default to the
// real phase 1 modules; tests may pass fakes. `registry` and `jobs`
// default to the fakes above, and `hub` to a hub over all four plus any
// `adapters` and `store` fakes (default none), started before the app
// listens. `goals` defaults to createGoals over the same registry; pass null
// for an app without the Goals routes, and pass `registry` along with `hub`
// when a test of Goals brings its own hub, so both read one registry.
// The config's data root is a fresh temporary directory unless `env` names
// PERSONAL_ASSISTANT_HOME, and DASHBOARD_MIGRATE_FROM is empty unless `env`
// names it, so every store default lands under the temporary root.
// `feeds` and `sources` default to createFeeds and createSources over the
// temporary root's feeds/ and sources/ (or DASHBOARD_FEEDS_DIR and
// DASHBOARD_SOURCES_DIR when `env` names them), so no test reads the real
// stores; pass `feeds: null` for an app without the feed and source routes.
// The brief instructions reader reads DASHBOARD_BRIEF_INSTRUCTIONS, a
// missing path in a temporary directory unless `env` names it; pass
// `briefInstructions: null` for an app without the brief instructions
// routes.
// `delegation(hub)` is optional: a factory for the delegation service
// (delegation.mjs), called once the hub exists; its result is handed to
// every adapter that has setDelegation() and returned as `delegation`.
// `notices` (notices.mjs) is optional and goes to the event stream.
// `settings` defaults to a fakeSettings() shared by the hub and the PUT
// route; pass null for an app without the settings route. `notifications`
// (notifications.mjs, optional) goes to the hub and the routes. `configure`
// may adjust config.
export async function startApp(t, {
  env = {}, focus, brief, registry = fakeRegistry(), jobs, routines = null, scheduler = null, hub, adapters, store, bindings,
  cmux = null, goals, feeds, sources, ideas = null, ideasInstructions = null, briefInstructions, notices = null, settings = fakeSettings(), reads = null,
  briefReads = null, notifications = null, configure = (c) => c,
  delegation = null,
} = {}) {
  const server = http.createServer();
  const port = await listen(server);
  const briefsDir = env.DASHBOARD_BRIEFS_DIR ?? path.join(await tempDir(t), 'briefs-missing');
  const briefInstructionsFile = env.DASHBOARD_BRIEF_INSTRUCTIONS ?? path.join(await tempDir(t), 'curator-missing.md');
  const focusOrigin = env.DASHBOARD_FOCUS_ORIGIN ?? `http://127.0.0.1:${await freePort()}`;
  // A fresh data root and no checkout to migrate, so no default reaches the
  // real root or the live checkout; `env` may name either.
  const home = env.PERSONAL_ASSISTANT_HOME ?? path.join(await tempDir(t), 'root');
  const config = configure(loadConfig({
    DASHBOARD_MIGRATE_FROM: '',
    ...env,
    PERSONAL_ASSISTANT_HOME: home,
    DASHBOARD_PORT: String(port),
    DASHBOARD_BRIEFS_DIR: briefsDir,
    DASHBOARD_BRIEF_INSTRUCTIONS: briefInstructionsFile,
    DASHBOARD_FOCUS_ORIGIN: focusOrigin,
  }));
  const logs = [];
  const log = (entry) => logs.push(entry);
  const focusRoutes = focus ?? createFocusProxy(config);
  const briefRoutes = brief ?? createBriefRoutes(config);
  const jobsModule = jobs ?? fakeJobs();
  const stateHub = hub ?? createTestHub({
    config, focus: focusRoutes, brief: briefRoutes, registry, jobs: jobsModule, routines, adapters, store, bindings, cmux, log,
    ...(settings ? { settings } : {}), ...(reads ? { reads } : {}), ...(briefReads ? { briefReads } : {}), notifications,
  });
  if (!hub) await stateHub.start();
  const delegationService = typeof delegation === 'function' ? delegation(stateHub) : null;
  // `scheduler` may be the scheduler itself or a function of the hub, as `delegation` is.
  const schedulerService = typeof scheduler === 'function' ? scheduler(stateHub) : scheduler;
  if (schedulerService) t.after(() => schedulerService.stop());
  for (const adapter of Object.values(adapters ?? {})) adapter?.setDelegation?.(delegationService);
  const goalsReader = goals === undefined ? createGoals({ registry, limits: config.limits, log }) : goals;
  let feedStore = null;
  const sourceStore = sources ?? createSources({
    dir: config.sourcesDir, limits: config.limits, log, usedBy: (id) => (feedStore ? feedStore.usedBy(id) : []),
  });
  feedStore = feeds === undefined ? createFeeds({ dir: config.feedsDir, sources: sourceStore, limits: config.limits, log }) : feeds;
  const briefInstructionsReader = briefInstructions === undefined
    ? createBriefInstructions({ file: config.briefInstructionsPath, limits: config.limits, log })
    : briefInstructions;
  const handler = createApp({
    config, focus: focusRoutes, brief: briefRoutes, hub: stateHub, store, cmux, goals: goalsReader, feeds: feedStore,
    sources: sourceStore, ideas, ideasInstructions, briefInstructions: briefInstructionsReader, notices, settings, registry, routines,
    scheduler: schedulerService, notifications, log,
  });
  server.on('request', handler);
  t.after(() => {
    handler.closeStreams();
    stateHub.close();
    return closeServer(server);
  });
  const authority = `127.0.0.1:${port}`;
  return {
    port, config, logs, authority, origin: `http://${authority}`, hub: stateHub, jobs: jobsModule, routines, settings, handler,
    delegation: delegationService, scheduler: schedulerService, notifications, feeds: feedStore, sources: sourceStore,
  };
}

// Sends one request. `headers.host` defaults to the app authority; pass
// host: null to omit it. `body` may be a string/Buffer or an async iterable.
export function request(app, method, path, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const finalHeaders = { host: app.authority, ...headers };
    if (finalHeaders.host === null) delete finalHeaders.host;
    const req = http.request({
      host: '127.0.0.1',
      port: app.port,
      method,
      path,
      headers: finalHeaders,
      setHost: false,
      agent: false,
    });
    let responded = false;
    req.on('response', (res) => {
      responded = true;
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json;
        try {
          json = JSON.parse(text);
        } catch {
          json = undefined;
        }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
      res.on('error', reject);
    });
    // The server may answer and close while the body is still being sent.
    req.on('error', (error) => {
      if (!responded) reject(error);
    });
    if (body && typeof body[Symbol.asyncIterator] === 'function' && !Buffer.isBuffer(body)) {
      (async () => {
        for await (const chunk of body) {
          if (responded || req.destroyed) break;
          if (!req.write(chunk)) await writable(req);
        }
        req.end();
      })().catch(() => {});
    } else {
      req.end(body);
    }
  });
}

function writable(req) {
  return new Promise((resolve) => {
    const done = () => {
      req.off('drain', done).off('close', done);
      resolve();
    };
    req.on('drain', done).on('close', done);
  });
}

export async function* chunks(total, size = 64 * 1024) {
  for (let sent = 0; sent < total; sent += size) {
    yield Buffer.alloc(Math.min(size, total - sent), 0x61);
  }
}
