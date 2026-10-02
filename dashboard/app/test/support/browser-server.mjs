// Servers for the browser tests. startHub() starts, on ephemeral loopback
// ports only:
//   - an isolated copy of Focus with an invented board (isolated-focus.mjs),
//     or nothing at all when the Focus checkout is missing;
//   - the dashboard app over plain HTTP; and
//   - the same app handler behind HTTPS with a throwaway self-signed
//     certificate, with DASHBOARD_PUBLIC_ORIGIN set to that https origin so
//     its Host and Origin pass the app's checks.
// Briefs live in a new temporary directory and are invented by
// writeBrief(). The registry and routines are in-memory fakes seeded from
// the options (see controlledRegistry and controlledRoutines); `state` is the
// state hub itself. Personas run on a fake Claude adapter over a real thread
// store in the temporary directory (see fakePersonas): a send is answered by
// an invented reply unless the persona is held, and `personas` lets a test
// raise a question or approval, reply, or hold a turn open. The real
// delegation service (delegation.mjs) sits over the hub, and a persona
// seeded with `delegate` asks another agent through it on each of the
// user's turns, so the lines render without the SDK. Coding
// sessions come from a fake Codex adapter (`codex`, see fakeCodex) and a
// fake cmux client over a seeded inventory (`cmux`, harness.mjs), with
// terminal bindings from `bindings`; none is present unless seeded. Goals
// reads a temporary copy of the `vault` option's notes, when given, and the
// Feed a temporary copy of the `feed` option's run files; without it the
// feed directory is a missing path in the temporary directory. The feed
// instructions are a temporary copy of the `instructions` option's file,
// or a missing path in the temporary directory.
// stopStreams() ends every event stream with `bye` and
// leaves the app refusing new ones (503 shutting_down), as during shutdown;
// restartApp() then puts a new app handler over the same hub, as after a
// restart. emitDelta(revision, patch) sends one delta with any revision to
// every open event stream without changing the hub. requests(path) lists
// what the app received on a path, with the status it sent. Nothing here reads the real briefs directory or connects to
// ports 4242 or 4243. stop() closes everything and removes the temporary
// directories.

import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';

import { createApp } from '../../lib/app.mjs';
import { createBriefRoutes } from '../../lib/brief-adapter.mjs';
import { createDelegation } from '../../lib/delegation.mjs';
import { createFeed } from '../../lib/feed.mjs';
import { createFeedInstructions } from '../../lib/feed-instructions.mjs';
import { loadConfig } from '../../lib/config.mjs';
import { createFocusProxy } from '../../lib/focus-proxy.mjs';
import { createGoals } from '../../lib/goals.mjs';
import { RuntimeError } from '../../lib/runtime/adapter.mjs';
import { createNotices } from '../../lib/notices.mjs';
import { RegistryError, validateDocument } from '../../lib/registry.mjs';
import { createSettings } from '../../lib/settings.mjs';
import { createThreadStore } from '../../lib/threads.mjs';
import { closeServer, createTestHub, fakeBindings, fakeCmux, freePort, listen } from './harness.mjs';
import { focusSourceAvailable, startIsolatedFocus } from './isolated-focus.mjs';

const FORBIDDEN_PORTS = new Set([4242, 4243]);

export { focusSourceAvailable };

// Options:
//   withFocus  start the isolated Focus copy (default true)
//   agents     registry agents (default none)
//   registry   { ok, error } to seed a registry that could not be read
//   routines   { items, focusAvailable, refreshedAt }: when given, the hub is
//              refreshed once at startup so the snapshot holds them
//   personas   { <agentId>: { state, pending, lastError, costUsd, messages,
//              model, startFails } } seeds each persona's runtime state and
//              cached messages before the hub starts (see fakePersonas);
//              `model` is the thread's own choice { id, effort }
//   codex      { sessions, status, threads }: the fake Codex adapter's rows,
//              its status() answer, and the messages thread() answers by
//              session id (see fakeCodex); without it there is no Codex
//              adapter
//   cmux       an inventory as cmux.mjs answers it (see fakeCmux); the hub
//              refreshes sessions once at startup so it is in the snapshot
//   bindings   { <threadId>: { workspaceId, surfaceId } } recorded terminals
//   home       the home directory in the snapshot (default /invented)
//   vault      a directory of notes (such as test/fixtures/vault) copied into
//              a temporary vault, or true for an empty one; either adds the
//              persona SECOND_BRAIN, whose cwd is that vault, to `agents`, so
//              Goals reads it and propose sends to it. `vaultDir` is its path.
//              It cannot be combined with a second-brain entry in `agents`
//              or with a `registry` that carries its own agents.
//   feed       a directory of feed run files (such as test/fixtures/feed)
//              copied into a temporary feed directory. It adds nothing to
//              `agents`; a test that discusses an item adds the WATCH persona
//              itself. `feedDir` is the copy's path.
//   instructions  a criteria file (such as
//              test/fixtures/feed-instructions/relevance.md) copied into the
//              temporary directory as DASHBOARD_FEED_INSTRUCTIONS.
//              `instructionsFile` is the copy's path.
//   settings   { model: { default, effort }, brief: { agent } } written to a
//              real settings file in the temporary directory before the
//              store loads it, so PUT /api/settings writes there; without it
//              the file is seeded as server.mjs does at first start (the
//              defaults, the brief going to the first pinned Claude persona
//              among the agents, or no one). The string 'broken' writes a file the
//              store cannot read. `settings` on the result is the store and
//              `settingsPath` the file.
export async function startHub({
  withFocus = true, agents = [], registry: registryState, routines: routinesSeed, personas: personaSeed = {},
  codex: codexSeed = null, cmux: cmuxSeed = null, bindings: bindingSeed = null, home = '/invented',
  vault = null, feed = null, instructions = null, settings: settingsSeed = null, delegationWaitMs = null,
} = {}) {
  if (vault && agents.some((agent) => agent.id === SECOND_BRAIN.id)) {
    throw new Error('startHub: the vault option adds second-brain; remove it from agents.');
  }
  if (vault && registryState && 'agents' in registryState) {
    throw new Error('startHub: the vault option cannot be combined with a registry that carries its own agents.');
  }
  const cleanups = [];
  const context = { after: (fn) => cleanups.push(fn) };
  const stop = async () => {
    while (cleanups.length > 0) await cleanups.pop()().catch(() => {});
  };

  try {
    const root = await mkdtemp(path.join(os.tmpdir(), 'dashboard-browser-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const briefsDir = path.join(root, 'briefs');
    await mkdir(briefsDir);
    // Inside the temporary directory, so stop() removes it with the rest.
    const vaultDir = vault ? path.join(root, 'vault') : null;
    if (typeof vault === 'string') await cp(vault, vaultDir, { recursive: true });
    else if (vault) await mkdir(vaultDir);
    if (vaultDir) agents = [...agents, { ...SECOND_BRAIN, cwd: vaultDir }];
    const feedDir = path.join(root, feed ? 'feed' : 'feed-missing');
    if (feed) await cp(feed, feedDir, { recursive: true });
    const instructionsFile = path.join(root, instructions ? 'relevance.md' : 'relevance-missing.md');
    if (instructions) await cp(instructions, instructionsFile);

    const focus = withFocus && focusSourceAvailable() ? await startIsolatedFocus(context) : null;
    const focusOrigin = focus?.origin ?? `http://127.0.0.1:${await freePort()}`;

    const certificate = await selfSignedCertificate(root);
    const plain = http.createServer();
    const secure = https.createServer(certificate);
    const plainPort = await listen(plain);
    cleanups.push(() => closeServer(plain));
    const securePort = await listen(secure);
    cleanups.push(() => closeServer(secure));
    for (const port of [plainPort, securePort, Number(new URL(focusOrigin).port)]) {
      if (FORBIDDEN_PORTS.has(port)) throw new Error(`refusing to use port ${port}`);
    }

    const settingsPath = path.join(root, 'settings.json');
    if (settingsSeed === 'broken') await writeFile(settingsPath, '{ not json');
    else if (settingsSeed) await writeFile(settingsPath, JSON.stringify({ version: 1, ...settingsSeed }));
    const loaded = loadConfig({
      DASHBOARD_PORT: String(plainPort),
      DASHBOARD_PUBLIC_ORIGIN: `https://localhost:${securePort}`,
      DASHBOARD_BRIEFS_DIR: briefsDir,
      DASHBOARD_FEED_DIR: feedDir,
      DASHBOARD_FEED_INSTRUCTIONS: instructionsFile,
      DASHBOARD_FOCUS_ORIGIN: focusOrigin,
      DASHBOARD_SETTINGS_PATH: settingsPath,
    });
    // A shorter ask wait lets a test see the pending sentence.
    const config = delegationWaitMs === null
      ? loaded
      : Object.freeze({ ...loaded, timeouts: Object.freeze({ ...loaded.timeouts, delegationWaitMs }) });
    const settings = createSettings({ path: config.settingsPath });
    await settings.load();
    if (!settingsSeed) {
      const listed = registryState?.agents ?? agents;
      const target = listed.find((agent) => agent.kind === 'persona' && agent.provider === 'claude' && agent.pinned === true) ?? null;
      await settings.seed({ brief: { agent: target?.id ?? null } });
    }
    const focusRoutes = createFocusProxy(config);
    const briefRoutes = createBriefRoutes(config);
    const registry = controlledRegistry({ agents, ...registryState });
    const routines = controlledRoutines(routinesSeed);
    const threadsDir = path.join(root, 'threads');
    const store = createThreadStore({ dir: threadsDir, limits: config.limits });
    const personas = fakePersonas(personaSeed, store);
    for (const [id, seed] of Object.entries(personaSeed)) {
      for (const message of seed.messages ?? []) await store.append(id, message);
    }
    const codex = codexSeed ? fakeCodex(codexSeed) : null;
    const cmux = cmuxSeed ? fakeCmux(cmuxSeed) : null;
    const bindings = fakeBindings(new Map(Object.entries(bindingSeed ?? {}).map(([threadId, ids]) => [threadId, Object.freeze({ ...ids })])));
    const adapters = { claude: personas.adapter };
    if (codex) adapters.codex = codex.adapter;
    const hub = createTestHub({
      config, focus: focusRoutes, brief: briefRoutes, registry, routines, adapters, store, bindings, cmux, settings, home,
    });
    await hub.start();
    const delegation = createDelegation({ hub, registry, limits: config.limits, timeouts: config.timeouts });
    personas.adapter.setDelegation(delegation);
    if (routinesSeed) {
      await hub.refreshRoutines();
      routines.calls = 0;
    }
    if (cmux) await hub.refreshSessions();
    // The app subscribes through this wrapper so a test can send a delta the
    // hub never made.
    const streamListeners = new Set();
    const appHub = {
      ...hub,
      subscribe(fn) {
        streamListeners.add(fn);
        const off = hub.subscribe(fn);
        return () => {
          streamListeners.delete(fn);
          off();
        };
      },
    };
    const goals = createGoals({ registry, limits: config.limits });
    const feedReader = createFeed({ dir: feedDir, limits: config.limits });
    const feedInstructions = createFeedInstructions({ file: config.feedInstructionsPath, limits: config.limits });
    const notices = createNotices({
      briefsDir, threadsDir, hub, target: () => settings.current().settings.brief.agent, limits: config.limits,
    });
    const newHandler = () => createApp({
      config, focus: focusRoutes, brief: briefRoutes, hub: appHub, store, cmux, goals, feed: feedReader, feedInstructions,
      notices, settings, registry, log: () => {},
    });
    let handler = newHandler();
    cleanups.push(async () => {
      handler.closeStreams();
      hub.close();
    });
    const seen = [];
    const dispatch = (req, res) => {
      seen.push({ method: req.method, path: (req.url ?? '').split('?')[0], res });
      handler(req, res);
    };
    plain.on('request', dispatch);
    secure.on('request', dispatch);

    return {
      origin: `http://127.0.0.1:${plainPort}`,
      secureOrigin: `https://localhost:${securePort}`,
      briefsDir,
      vaultDir,
      feedDir,
      instructionsFile,
      focus,
      writeBrief: (date, options) => writeFile(path.join(briefsDir, `viewer-${date}.html`), inventedViewer({ date, ...options })),
      writeRawBrief: (date, html) => writeFile(path.join(briefsDir, `viewer-${date}.html`), html),
      // A brief notice as the run writes it; the agent `settings` names in
      // brief.agent must be in `agents` as a started persona for the daemon
      // to post it.
      writeNotice: (date, fields) => writeFile(path.join(briefsDir, `notice-${date}.json`), JSON.stringify({ date, state: 'ready', ...fields })),
      notices,
      settings,
      settingsPath,
      readFeedback: (date) => readFile(path.join(briefsDir, `feedback-${date}.md`), 'utf8'),
      state: hub,
      // Requests the app received, with the status sent so far (null before
      // headers go out). An open event stream shows 200.
      requests: (pathname) => seen
        .filter((entry) => entry.path === pathname)
        .map((entry) => ({ method: entry.method, status: entry.res.headersSent ? entry.res.statusCode : null })),
      registry,
      routines,
      personas,
      delegation,
      codex,
      cmux,
      bindings,
      emitDelta: (revision, patch) => {
        for (const fn of [...streamListeners]) fn({ revision, patch });
      },
      stopStreams: () => handler.closeStreams(),
      restartApp: () => {
        handler.closeStreams();
        handler = newHandler();
      },
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}

// The persona the `vault` option adds; the Goals routes look it up by id.
export const SECOND_BRAIN = Object.freeze({
  id: 'second-brain', name: 'Second brain', role: 'Memory', description: 'Invented.',
  group: 'personal', kind: 'persona', provider: 'claude',
});

// The persona the Feed's Discuss sends to; a test adds it to `agents`.
export const WATCH = Object.freeze({
  id: 'watch', name: 'Watch', role: 'Newsletters', description: 'Invented.',
  group: 'personal', kind: 'persona', provider: 'claude', cwd: '/invented/watch',
});

// A registry held in memory. set(fields) replaces what current() returns and
// notifies the hub, as a changed registry file would.
function controlledRegistry({ ok = true, error = null, agents = [], groups = [] }) {
  const listeners = new Set();
  const build = (fields) => Object.freeze({
    ok: fields.ok,
    error: fields.error,
    agents: fields.ok ? fields.agents : [],
    groups: fields.ok ? fields.groups : [],
    loadedAt: fields.ok ? '2026-01-01T00:00:00.000Z' : null,
    path: '/invented/agents.json',
  });
  let fields = { ok, error, agents, groups };
  let current = build(fields);
  const fake = {
    writes: [],
    current: () => current,
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    set(next) {
      fields = { ...fields, ...next };
      current = build(fields);
      for (const fn of listeners) fn(current);
    },
    // Applies the mutation in memory the way registry.mjs does, validating
    // with the real validateDocument except that any absolute path counts
    // as a folder, since the seeded agents live in invented folders.
    // `writes` keeps each candidate document a test can read back.
    async write(mutate) {
      if (!current.ok && current.error !== 'registry_missing') throw new RegistryError('registry_invalid', [current.error]);
      const document = structuredClone({ version: 1, groups: [...current.groups], agents: current.agents.map((agent) => ({ ...agent })) });
      const candidate = mutate(document);
      const result = validateDocument(candidate, { isDirectory: (target) => path.isAbsolute(target) });
      if (!result.ok) throw new RegistryError('invalid_registry', result.problems);
      fake.writes.push(candidate);
      fields = { ok: true, error: null, agents: result.agents, groups: result.groups };
      current = build(fields);
      for (const fn of listeners) fn(current);
      return { agents: result.agents, groups: result.groups };
    },
    start: async () => current,
    stop() {},
  };
  return fake;
}

// Routines that run no subprocess. `calls` counts refreshes; the fields may
// be changed between refreshes. hold() makes refreshes wait until the
// returned release() is called; `fail` makes them throw. `refreshedAt`, when
// set, is used once and then cleared, so later refreshes report now.
function controlledRoutines({ items = [], focusAvailable = null, refreshedAt = null } = {}) {
  const fake = {
    calls: 0,
    items,
    focusAvailable,
    refreshedAt,
    fail: false,
    gate: null,
    hold() {
      let release;
      fake.gate = new Promise((resolve) => { release = resolve; });
      return () => {
        fake.gate = null;
        release();
      };
    },
    async refresh() {
      fake.calls += 1;
      if (fake.gate) await fake.gate;
      if (fake.fail) throw new Error('invented refresh failure');
      const at = fake.refreshedAt ?? new Date().toISOString();
      fake.refreshedAt = null;
      return { refreshedAt: at, focusAvailable: fake.focusAvailable, routines: fake.items };
    },
  };
  return fake;
}

// A Claude adapter stand-in that keeps each persona's state in memory and
// writes messages to the real thread store, emitting the events the hub
// expects. send() refuses 'busy' while a turn is open; otherwise it goes
// busy, records the user message (with `from` and `mentions` when the
// context carries them, as the real adapter does), and after a short delay
// replies "Reply: <text>" and goes idle, unless the persona is held. A
// persona seeded with `delegate: { to, text }` instead asks that agent
// through the delegation service on each turn that is the user's own
// (context.from absent) and replies with what the tool answered, as a
// model that repeats the tool's text would; with `raise: { kind, toolName,
// input }` on that seed, the receiver raises that request on arrival and
// replies only once it is answered. answer() resolves the pending
// request and continues the turn the same way. The open turn's `from` and
// `chain` are kept on the entry and stamped on every request and resolved
// event, as the real adapter does, so the real hub relays the card.
// Controls on the returned object:
//   hold(id)                       later turns stay busy until reply()
//   reply(id, text)                ends the open turn with that reply
//   raise(id, { kind, toolName, input })  puts the busy persona on a request
//                                  (stamped with the open turn's from and chain)
//   fail(id, message)              ends the open turn with an error
//   say(id, text)                  adds assistant text to the open turn without ending it
//   calls                          [['send', id, text], ['answer', id, requestId, answer], ...]
//   sent                           [{ id, text, context }] for every send, context as given
//   adapter.setDelegation(service) the service `delegate` seeds ask through
export function fakePersonas(seed, store) {
  const listeners = new Set();
  const entries = new Map();
  const held = new Set();
  const calls = [];
  const sent = [];
  const timers = new Set();
  let nextRequest = 1;
  let delegation = null;
  const at = () => new Date().toISOString();

  function entry(id) {
    if (!entries.has(id)) {
      const initial = seed[id] ?? {};
      entries.set(id, {
        state: initial.state ?? 'idle',
        pending: initial.pending ? { requestId: `req-${nextRequest++}`, at: at(), ...initial.pending } : null,
        lastError: initial.lastError ?? null,
        costUsd: initial.costUsd ?? null,
        model: initial.model ? { id: initial.model.id ?? null, effort: initial.model.effort ?? null } : null,
        turn: null,
        // The open turn's sender and exchange, stamped on what it raises.
        from: null,
        chain: [],
      });
    }
    return entries.get(id);
  }

  function emit(type, agentId, fields = {}) {
    for (const fn of [...listeners]) fn({ type, agentId, at: at(), ...fields });
  }

  function setState(id, state) {
    const current = entry(id);
    current.state = state;
    emit('thread.state', id, { state });
  }

  async function say(id, role, text, fields = {}) {
    const message = { ...fields, role, text, at: at() };
    await store.append(id, message);
    emit('message', id, message);
  }

  const MODEL_NAMES = { fable: 'Fable', opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku' };
  const EFFORT_NAMES = { low: 'low', medium: 'medium', high: 'high', xhigh: 'extra high', max: 'max' };
  function modelLine(model, effort) {
    if (model === null && effort === null) return "Back to the agent's default.";
    const effortText = effort === null ? '' : `${EFFORT_NAMES[effort] ?? effort} effort`;
    if (model === null) return `Now at ${effortText}.`;
    const name = MODEL_NAMES[model] ?? model;
    return effort === null ? `Now on ${name}.` : `Now on ${name}, ${effortText}.`;
  }

  function endTurn(id) {
    const current = entry(id);
    const done = current.turn;
    current.turn = null;
    done?.();
  }

  async function finish(id, text) {
    const current = entry(id);
    await say(id, 'assistant', text);
    current.costUsd = (current.costUsd ?? 0) + 0.01;
    emit('usage', id, { usage: {}, costUsd: current.costUsd, denials: [] });
    setState(id, 'idle');
    endTurn(id);
  }

  // The invented reply, unless the persona is held.
  function continueTurn(id, text) {
    if (held.has(id)) return;
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (entry(id).state === 'busy') finish(id, `Reply: ${text}`);
    }, 60);
    timers.add(timer);
  }

  // The seeded ask, made as the tool handler would, then the reply.
  async function delegateTurn(id, delegate, context) {
    if (!delegation) throw new Error('fakePersonas: a delegate seed needs setDelegation()');
    const outcome = await delegation.ask({ from: id, chain: context.chain ?? [], to: delegate.to, message: delegate.text });
    if (entry(id).state === 'busy' && !held.has(id)) await finish(id, outcome.text);
  }

  // A request on the persona's open turn, stamped with the turn's sender
  // and chain as the real adapter stamps it.
  function raise(id, request) {
    const current = entry(id);
    current.pending = { requestId: `req-${nextRequest++}`, at: at(), from: current.from, chain: [...current.chain], ...request };
    setState(id, 'waiting');
    emit('request', id, current.pending);
    return current.pending.requestId;
  }

  const adapter = {
    kind: 'claude',
    async start(agent) {
      if (seed[agent.id]?.startFails) throw new Error('invented start failure');
      entry(agent.id);
      return { threadId: agent.id };
    },
    state(id) {
      const current = entry(id);
      return {
        state: current.state, pending: current.pending, lastError: current.lastError, sessionId: null, costUsd: current.costUsd, cwd: null,
        model: current.model,
      };
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    send(agent, text, context = {}) {
      calls.push(['send', agent.id, text]);
      sent.push({ id: agent.id, text, context });
      const current = entry(agent.id);
      if (current.state === 'busy' || current.state === 'waiting') return Promise.reject(new RuntimeError('busy'));
      const ended = new Promise((resolve) => { current.turn = resolve; });
      current.lastError = null;
      current.from = typeof context.from === 'string' && context.from !== '' ? context.from : null;
      current.chain = Array.isArray(context.chain) ? [...context.chain] : [];
      setState(agent.id, 'busy');
      const fields = {
        ...(current.from ? { from: current.from } : {}),
        ...(Array.isArray(context.mentions) && context.mentions.length > 0 ? { mentions: [...context.mentions] } : {}),
      };
      const delegate = seed[agent.id]?.delegate;
      // A sender's delegate seed may say what the receiver raises on
      // arrival; the receiver then waits for the answer before replying.
      const raised = current.from ? seed[current.from]?.delegate : null;
      say(agent.id, 'user', text, fields).then(() => {
        if (delegate && !current.from) return delegateTurn(agent.id, delegate, context);
        if (raised && raised.to === agent.id && raised.raise) return raise(agent.id, raised.raise);
        return continueTurn(agent.id, text);
      });
      return ended;
    },
    setDelegation(service) {
      delegation = service;
    },
    async answer(agent, requestId, answer) {
      calls.push(['answer', agent.id, requestId, answer]);
      const current = entry(agent.id);
      if (!current.pending || current.pending.requestId !== requestId) throw new RuntimeError('no_such_request');
      current.pending = null;
      emit('resolved', agent.id, { requestId, outcome: 'answered', from: current.from, chain: [...current.chain] });
      setState(agent.id, 'busy');
      continueTurn(agent.id, 'answered');
    },
    async interrupt(agent) {
      const current = entry(agent.id);
      if (current.state !== 'busy' && current.state !== 'waiting') return;
      if (current.pending) {
        const { requestId } = current.pending;
        current.pending = null;
        emit('resolved', agent.id, { requestId, outcome: 'interrupted', from: current.from, chain: [...current.chain] });
      }
      setState(agent.id, 'idle');
      endTurn(agent.id);
    },
    // As the real adapter: the same refusals, the pointer's pair kept in
    // the entry, and the line written through the real store.
    setModel(agent, choice = {}) {
      calls.push(['setModel', agent.id, choice]);
      const current = entry(agent.id);
      if ('model' in choice && choice.model !== null && !(typeof choice.model === 'string' && choice.model !== '' && choice.model.length <= 64)) {
        return Promise.reject(new RuntimeError('invalid_model'));
      }
      if ('effort' in choice && choice.effort !== null && !Object.hasOwn(EFFORT_NAMES, choice.effort)) return Promise.reject(new RuntimeError('invalid_effort'));
      if (current.state === 'busy' || current.state === 'waiting') return Promise.reject(new RuntimeError('busy'));
      const model = 'model' in choice ? choice.model : current.model?.id ?? null;
      const effort = 'effort' in choice ? choice.effort : current.model?.effort ?? null;
      current.model = model === null && effort === null ? null : { id: model, effort };
      return say(agent.id, 'system', modelLine(model, effort), { kind: 'model', model, effort });
    },
    async newThread(agent) {
      calls.push(['newThread', agent.id]);
      const current = entry(agent.id);
      if (current.state === 'busy' || current.state === 'waiting') throw new RuntimeError('busy');
      await store.clear(agent.id);
      current.model = null;
      current.lastError = null;
      setState(agent.id, 'idle');
      await say(agent.id, 'system', 'New thread');
    },
    async close() {
      for (const timer of timers) clearTimeout(timer);
    },
  };

  return {
    adapter,
    calls,
    sent,
    hold: (id) => held.add(id),
    reply: (id, text) => finish(id, text),
    say: (id, text) => say(id, 'assistant', text),
    raise,
    fail(id, message) {
      const current = entry(id);
      current.lastError = message;
      emit('error', id, { message });
      setState(id, 'error');
      endTurn(id);
    },
  };
}

// A Codex adapter stand-in: no personas, the seeded session rows, and
// recorded calls. answer() clears the row's request and marks it busy;
// interrupt() marks it idle; thread() answers the seeded messages. Controls
// on the returned object:
//   set(id, fields)   replaces fields on one row and tells the hub
//   setStatus(status) replaces what status() answers and tells the hub
//   calls             [['answer', id, requestId, answer], ['interrupt', id], ['thread', id], ...]
function fakeCodex({ sessions = [], status = { available: true }, threads = {} }) {
  const listeners = new Set();
  const calls = [];
  const at = () => new Date().toISOString();
  const emit = () => {
    for (const fn of [...listeners]) fn({ type: 'sessions', agentId: 'codex', at: at() });
  };
  const fake = {
    list: sessions.map((row) => ({ ...row })),
    status,
    calls,
    set(id, fields) {
      fake.list = fake.list.map((row) => (row.id === id ? { ...row, ...fields } : row));
      emit();
    },
    setStatus(next) {
      fake.status = next;
      emit();
    },
  };
  const rowFor = (id) => fake.list.find((row) => row.id === id) ?? null;
  fake.adapter = {
    kind: 'codex',
    sessions: () => fake.list,
    status: () => fake.status,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    start: () => Promise.reject(new RuntimeError('not_supported', { message: 'Codex threads take messages in their own terminal.' })),
    state: () => ({ state: 'idle', pending: null, lastError: null, sessionId: null, costUsd: null }),
    async answer(agent, requestId, answer) {
      calls.push(['answer', agent.id, requestId, answer]);
      const row = rowFor(agent.id);
      if (!row?.pending || row.pending.requestId !== requestId) throw new RuntimeError('no_such_request');
      if (row.pending.native) throw new RuntimeError('not_supported');
      fake.set(agent.id, { pending: null, state: 'busy' });
    },
    async interrupt(agent) {
      calls.push(['interrupt', agent.id]);
      fake.set(agent.id, { pending: null, state: 'idle' });
    },
    async thread(agent) {
      calls.push(['thread', agent.id]);
      return { messages: threads[agent.id] ?? [] };
    },
    close: async () => {},
  };
  return fake;
}

async function selfSignedCertificate(root) {
  const dir = path.join(root, 'tls');
  await mkdir(dir, { mode: 0o700 });
  const key = path.join(dir, 'key.pem');
  const cert = path.join(dir, 'cert.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=localhost', '-days', '1',
    '-keyout', key, '-out', cert,
  ], { stdio: 'ignore' });
  return { key: await readFile(key), cert: await readFile(cert) };
}

export const DEFAULT_ITEMS = Object.freeze([
  { sec: 'Needs you', id: 'invented-one', text: 'Invented item one.' },
  { sec: 'Needs you', id: 'invented-two', text: 'Invented item two.' },
  { sec: 'Later', id: 'invented-three', text: 'Invented item three.' },
]);

// An invented viewer in the generated layout the adapter accepts: one inline
// script, ITEMS then KEY, marks kept in localStorage under KEY, and a fixed
// bar with Save, Copy, and Clear. Its own saveOut downloads a file, so a
// download during a test means the bridge did not take over Save. The page
// is taller than any test viewport so its own scrolling is exercised.
export function inventedViewer({ date, items = DEFAULT_ITEMS, heading = `Daily Brief — ${date}` }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${heading}</title>
<style>
body { margin: 0; font-family: Georgia, serif; }
.page { padding: 16px 16px 140px; }
.item { min-height: 320px; padding: 12px 0; border-bottom: 1px solid #ddd; }
.item button[aria-pressed="true"] { font-weight: 700; }
.bar { position: fixed; left: 0; right: 0; bottom: 0; display: flex; flex-wrap: wrap; gap: 8px; padding: 10px 16px; background: #fff; border-top: 1px solid #ccc; }
</style>
</head>
<body>
<div class="page">
  <h1>${heading}</h1>
  <div id="brief"></div>
  <div class="overall"><textarea id="overall" rows="3" aria-label="Overall"></textarea></div>
</div>
<div class="bar">
  <span id="status">No marks yet</span>
  <button class="save" onclick="saveOut()">Save feedback</button>
  <button class="ghost" onclick="copyOut()">Copy instead</button>
  <button class="ghost" onclick="clearAll()">Clear</button>
</div>
<script>
const ITEMS = ${JSON.stringify(items)};
const KEY = 'db-items-${date}';
let fb = {};
try { fb = JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { fb = {}; }
function persist() {
  try { localStorage.setItem(KEY, JSON.stringify(fb)); } catch (e) {}
  const count = Object.keys(fb).filter(function (id) { return fb[id] && fb[id].m; }).length;
  document.getElementById('status').textContent = count ? count + ' marked' : 'No marks yet';
}
function mark(id, m) {
  const value = Object.assign({}, fb[id]);
  value.m = value.m === m ? null : m;
  fb[id] = value;
  persist();
  render();
}
function render() {
  document.getElementById('brief').innerHTML = ITEMS.map(function (item) {
    const m = fb[item.id] && fb[item.id].m;
    return '<div class="item" data-id="' + item.id + '"><p>' + item.text + '</p>' +
      '<button data-mark="a" aria-pressed="' + (m === 'a') + '" onclick="mark(\\'' + item.id + '\\', \\'a\\')">Approve</button> ' +
      '<button data-mark="d" aria-pressed="' + (m === 'd') + '" onclick="mark(\\'' + item.id + '\\', \\'d\\')">Dismiss</button></div>';
  }).join('');
}
function saveOut() {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([JSON.stringify(fb)], { type: 'text/markdown' }));
  link.download = 'feedback-${date}.md';
  document.body.appendChild(link);
  link.click();
  link.remove();
}
function copyOut() {}
function clearAll() { fb = {}; persist(); render(); }
render();
persist();
</script>
</body>
</html>
`;
}
