// npm run verify:codex -- --yes [--model NAME] [--record FILE]
//
// Live check of the Codex adapter against the installed Codex CLI: starts a
// disposable `codex app-server` on a socket under a short temporary
// directory, points a Codex adapter at it through a temporary owner file,
// creates one thread in an empty temporary directory from a second client
// (as the TUI does), waits for the adapter to list it, asks the model
// one question through request_user_input, answers it through the adapter,
// confirms the resolution and the finished turn, archives the thread, stops
// the server, and prints the versions. It runs one short model turn, which
// bills the Codex subscription, so it refuses without --yes. It never
// touches var/codex or the dashboard's own server, and it leaves nothing
// behind but the archived thread in ~/.codex/sessions.
//
// The thread is started after the adapter has connected, so the run also
// says how the adapter came to list it: through a `thread/started`
// notification, through its `thread/loaded/list` poll, or both, and on how
// many connections. The fresh thread has no rollout until its first turn,
// so the adapter's first resume fails and is retried; the run shows the
// question arriving through that retry. --record FILE writes the versions,
// that answer, and every frame on the adapter's connections as JSON, also
// when a step fails.

import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import WebSocket from 'ws';

import { LIMITS, TIMEOUTS } from '../lib/config.mjs';
import { createCodexAdapter } from '../lib/runtime/codex.mjs';

const PROMPT = 'Use your request_user_input tool once to ask me which colour to use: Amber or Blue. ' +
  'Then reply with exactly "COLOUR=<my answer>". Do not read or write any files.';
const STEP_TIMEOUT_MS = 120_000;

async function main() {
  const args = process.argv.slice(2);
  const model = args.includes('--model') ? args[args.indexOf('--model') + 1] : null;
  const record = args.includes('--record') ? args[args.indexOf('--record') + 1] : null;
  if (!args.includes('--yes')) {
    console.error('verify-codex: this runs one short model turn on your Codex subscription. Re-run with --yes to go ahead.');
    process.exitCode = 1;
    return;
  }
  const codexVersion = version();
  console.log(`verify-codex: node ${process.version}, ws ${wsVersion()}, ${codexVersion}`);

  const root = await mkdtemp(path.join(os.tmpdir(), 'cxv-'));
  const socket = path.join(root, 'app.sock');
  if (Buffer.byteLength(socket) > 100) throw new Error(`temporary socket path too long: ${socket}`);
  const work = path.join(root, 'work');
  await mkdir(work);
  const ownerFile = path.join(root, 'owner.json');

  // Its own process group, so the native binary under the npm wrapper can
  // be killed too if SIGTERM does not end it (it did not while a turn was
  // waiting on a question that nobody answered).
  const server = spawn('codex', [
    'app-server', '--listen', `unix://${socket}`,
    '-c', 'features.default_mode_request_user_input=true',
    '-c', 'features.request_permissions_tool=true',
  ], { cwd: work, stdio: ['ignore', 'ignore', 'inherit'], detached: true });
  const stopServer = () => new Promise((resolve) => {
    if (server.exitCode !== null || server.signalCode !== null) return resolve();
    const hammer = setTimeout(() => {
      console.log('verify-codex: app-server ignored SIGTERM for 5 seconds; killing its process group');
      try { process.kill(-server.pid, 'SIGKILL'); } catch { /* already gone */ }
    }, 5_000);
    server.once('exit', () => {
      clearTimeout(hammer);
      resolve();
    });
    server.kill('SIGTERM');
  });
  let adapter = null;
  let client = null;
  const frames = []; // every frame on the adapter's connections, in order
  const outcome = { at: new Date().toISOString(), node: process.version, ws: wsVersion(), codex: codexVersion };
  let connections = 0;
  try {
    await writeFile(ownerFile, JSON.stringify({ socket, pid: server.pid, startedAt: new Date().toISOString(), codexVersion }));
    client = await connect(socket);
    console.log('verify-codex: app-server up');

    const events = [];
    adapter = createCodexAdapter({
      ownerFile, timeouts: { ...TIMEOUTS, codexPollMs: 500, codexReconnectMaxMs: 2_000 }, limits: LIMITS,
      log: (entry) => { if (/error|dropped|invalid/.test(entry.event)) console.log(`verify-codex: log ${JSON.stringify(entry)}`); },
      connect: (socketPath) => {
        connections += 1;
        return recorded(new WebSocket(`ws+unix://${socketPath}:/`, { perMessageDeflate: false }), connections, frames);
      },
    });
    adapter.subscribe((event) => events.push(event));
    await until(() => events.some((event) => event.type === 'sessions'), 'adapter connection');

    const started = await client.request('thread/start', {
      cwd: work, sandbox: 'read-only', approvalPolicy: 'on-request', approvalsReviewer: 'user', ...(model ? { model } : {}),
    });
    const threadId = started.thread.id;
    Object.assign(outcome, { threadId, model: started.model });
    console.log(`verify-codex: thread ${threadId} (${started.model})`);
    await until(() => adapter.sessions().some((session) => session.threadId === threadId), 'thread listed');
    outcome.adoption = adoptionOf(frames, threadId, connections);
    outcome.connections = connections;
    console.log(`verify-codex: listed on connection ${connections} of ${connections}; ` +
      `thread/started ${outcome.adoption.threadStarted ? 'arrived' : 'did not arrive'}, ` +
      `thread/loaded/list ${outcome.adoption.loadedList ? 'returned it' : 'was not asked or did not return it'}`);

    await client.request('turn/start', { threadId, input: [{ type: 'text', text: PROMPT }] });
    const request = await until(() => events.find((event) => event.type === 'request' && event.agentId === `codex:${threadId}`), 'question');
    if (request.kind !== 'question') throw new Error(`expected a question, got ${request.kind} ${request.toolName}`);
    const [question] = request.input.questions;
    console.log(`verify-codex: question ${JSON.stringify(question.id)} received (request ${request.requestId})`);
    await adapter.answer(`codex:${threadId}`, request.requestId, { answers: { [question.id]: 'Blue' } });
    await until(() => events.some((event) => event.type === 'resolved' && event.requestId === request.requestId), 'resolved');
    outcome.resumes = frames.filter((f) => f.direction === 'out' && f.message.method === 'thread/resume' && f.message.params?.threadId === threadId).length;
    console.log(`verify-codex: the thread was resumed ${outcome.resumes} time(s) before the question arrived`);
    const completed = await client.waitFor((message) => message.method === 'turn/completed' && message.params?.threadId === threadId, 'turn/completed');
    const text = completed.params.turn.items.find((item) => item.type === 'agentMessage')?.text ?? '';
    console.log(`verify-codex: turn ${completed.params.turn.status}; final message ${JSON.stringify(text)}`);
    if (!/COLOUR=Blue/.test(text)) console.log('verify-codex: the model did not echo the answer; the transport still worked');
    await until(() => adapter.sessions().find((session) => session.threadId === threadId)?.state === 'idle', 'idle');
    await client.request('thread/archive', { threadId });
    outcome.ok = true;
    console.log('verify-codex: thread archived');
  } catch (error) {
    outcome.ok = false;
    outcome.error = error.message;
    throw error;
  } finally {
    client?.close();
    await adapter?.close();
    await stopServer();
    await rm(root, { recursive: true, force: true });
    if (record) {
      await writeFile(record, `${JSON.stringify({ ...outcome, frames }, null, 2)}\n`);
      console.log(`verify-codex: frames written to ${record}`);
    }
  }
  console.log('verify-codex: ok');
}

// Wraps one adapter socket so every inbound and outbound frame lands in
// `frames` as { connection, direction, at, message } (raw text when it is
// not JSON).
function recorded(ws, connection, frames) {
  const push = (direction, data) => {
    const text = typeof data === 'string' ? data : data.toString('utf8');
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      message = { raw: text };
    }
    frames.push({ connection, direction, at: new Date().toISOString(), message });
  };
  ws.on('message', (data) => push('in', data));
  const send = ws.send.bind(ws);
  ws.send = (data, ...rest) => {
    push('out', data);
    return send(data, ...rest);
  };
  return ws;
}

// How the adapter came to list `threadId`: whether a thread/started for it
// arrived, and whether a thread/loaded/list response named it.
function adoptionOf(frames, threadId, connection) {
  const inbound = frames.filter((frame) => frame.connection === connection && frame.direction === 'in').map((frame) => frame.message);
  const threadStarted = inbound.some((m) => m.method === 'thread/started' && m.params?.thread?.id === threadId);
  const loadedIds = frames.filter((f) => f.direction === 'out' && f.message.method === 'thread/loaded/list').map((f) => f.message.id);
  const loadedList = inbound.some((m) => loadedIds.includes(m.id) && Array.isArray(m.result?.data) && m.result.data.includes(threadId));
  return { threadStarted, loadedList };
}

function version() {
  const result = spawnSync('codex', ['--version'], { encoding: 'utf8' });
  if (result.error || result.status !== 0) throw new Error('codex --version failed; is the Codex CLI on PATH?');
  return result.stdout.trim();
}

function wsVersion() {
  return createRequire(import.meta.url)('ws/package.json').version;
}

// A plain JSON-RPC client for the steps the adapter does not do itself.
async function connect(socket) {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const ws = new WebSocket(`ws+unix://${socket}:/`, { perMessageDeflate: false });
    const opened = await new Promise((resolve) => {
      ws.once('open', () => resolve(true));
      ws.once('error', () => resolve(false));
    });
    if (opened) {
      const client = makeClient(ws);
      await client.request('initialize', { clientInfo: { name: 'verify-codex', version: '0.0.0' }, capabilities: { experimentalApi: true } });
      ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} }));
      return client;
    }
    if (Date.now() > deadline) throw new Error(`the app-server did not answer on ${socket}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

function makeClient(ws) {
  const calls = new Map();
  const listeners = new Set();
  let nextId = 1;
  ws.on('message', (data) => {
    const message = JSON.parse(data.toString('utf8'));
    if (message.id !== undefined && !message.method) {
      const call = calls.get(message.id);
      if (!call) return;
      calls.delete(message.id);
      if (message.error) call.reject(new Error(message.error.message));
      else call.resolve(message.result);
    }
    for (const listener of listeners) listener(message);
  });
  return {
    request: (method, params) => new Promise((resolve, reject) => {
      const id = nextId;
      nextId += 1;
      calls.set(id, { resolve, reject });
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
      setTimeout(() => {
        if (calls.delete(id)) reject(new Error(`${method} timed out`));
      }, STEP_TIMEOUT_MS).unref();
    }),
    waitFor: (predicate, label) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        listeners.delete(listener);
        reject(new Error(`${label} did not arrive within ${STEP_TIMEOUT_MS / 1000} seconds`));
      }, STEP_TIMEOUT_MS);
      const listener = (message) => {
        if (!predicate(message)) return;
        clearTimeout(timer);
        listeners.delete(listener);
        resolve(message);
      };
      listeners.add(listener);
    }),
    close: () => ws.close(),
  };
}

async function until(predicate, label) {
  const deadline = Date.now() + STEP_TIMEOUT_MS;
  for (;;) {
    const found = predicate();
    if (found) return found;
    if (Date.now() > deadline) throw new Error(`${label} did not happen within ${STEP_TIMEOUT_MS / 1000} seconds`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

main().catch((error) => {
  console.error(`verify-codex: ${error.message}`);
  process.exitCode = 1;
});
