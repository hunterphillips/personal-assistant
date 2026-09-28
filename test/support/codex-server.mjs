// A scripted stand-in for `codex app-server`: a real ws server on a Unix
// socket under a short temporary path that answers initialize, thread/list,
// thread/resume, thread/turns/list, thread/start, thread/archive, and
// turn/interrupt from an in-memory thread table, records every client
// request, reply, and notification, and can push notifications and server
// requests to its connections. `threads` entries follow the wire shape
// ({ id, cwd, name, preview, updatedAt, status }) plus two test-only fields:
// `turns` (what thread/turns/list returns) and `waiting` ({ id, method,
// params }), a request replayed after each thread/resume.

import http from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { WebSocketServer } from 'ws';

export const FAKE_VERSION = 'codex-cli 0.0.0-fake';

export async function startCodexServer(t, { threads = [], handlers = {} } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cx-'));
  const socket = path.join(dir, 'app.sock');
  if (Buffer.byteLength(socket) > 100) throw new Error(`temporary socket path too long: ${socket}`);
  const server = http.createServer();
  const wss = new WebSocketServer({ server, perMessageDeflate: false });
  const fake = {
    dir,
    socket,
    ownerFile: path.join(dir, 'owner.json'),
    threads: new Map(threads.map((thread) => [thread.id, { ...thread }])),
    connections: [],
    requests: [], // client -> server requests, in order
    replies: [], // client responses to server requests
    notifications: [], // client notifications
    nextThread: 1,
    closed: false,
  };

  const defaults = {
    initialize: () => ({ userAgent: `fake/0.155.1 (${FAKE_VERSION})`, codexHome: dir, platformFamily: 'unix', platformOs: 'macos' }),
    'thread/list': (params) => {
      const all = [...fake.threads.values()].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
      const start = params?.cursor ? Number(params.cursor) : 0;
      const limit = params?.limit ?? all.length;
      const page = all.slice(start, start + limit).map(publicThread);
      const next = start + limit < all.length ? String(start + limit) : null;
      return { data: page, nextCursor: next };
    },
    'thread/resume': (params, conn) => {
      const thread = fake.threads.get(params?.threadId);
      if (!thread) throw new Error('unknown thread');
      if (thread.waiting) {
        setImmediate(() => conn.ask(thread.waiting.method, thread.waiting.id, { threadId: thread.id, ...thread.waiting.params }));
      }
      return { thread: publicThread(thread), cwd: thread.cwd, model: 'fake', modelProvider: 'fake' };
    },
    'thread/turns/list': (params) => {
      const thread = fake.threads.get(params?.threadId);
      if (!thread) throw new Error('unknown thread');
      const turns = [...(thread.turns ?? [])].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
      const limit = params?.limit ?? turns.length;
      return { data: turns.slice(0, limit), nextCursor: null };
    },
    'thread/start': (params) => {
      const id = `fake-thread-${fake.nextThread}`;
      fake.nextThread += 1;
      const thread = { id, cwd: params?.cwd ?? dir, name: null, preview: '', updatedAt: 1_790_000_000 + fake.nextThread, status: { type: 'idle' } };
      fake.threads.set(id, thread);
      return { thread: publicThread(thread), cwd: thread.cwd, model: 'fake', modelProvider: 'fake' };
    },
    'thread/archive': (params) => {
      fake.threads.delete(params?.threadId);
      return {};
    },
    'turn/interrupt': () => ({}),
  };

  wss.on('connection', (ws) => {
    const conn = {
      ws,
      requests: [],
      replies: [],
      notify(method, params) {
        ws.send(JSON.stringify({ jsonrpc: '2.0', method, params }));
      },
      ask(method, id, params) {
        ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
      },
      raw(text) {
        ws.send(text);
      },
      close() {
        ws.close();
      },
      closed: new Promise((resolve) => ws.once('close', resolve)),
    };
    fake.connections.push(conn);
    ws.on('message', (data) => {
      let message;
      try {
        message = JSON.parse(data.toString('utf8'));
      } catch {
        return;
      }
      if (message.method && message.id !== undefined) {
        fake.requests.push(message);
        conn.requests.push(message);
        const handler = handlers[message.method] ?? defaults[message.method];
        let reply;
        try {
          if (!handler) throw new Error(`unknown method ${message.method}`);
          reply = { jsonrpc: '2.0', id: message.id, result: handler(message.params, conn) ?? {} };
        } catch (error) {
          reply = { jsonrpc: '2.0', id: message.id, error: { code: -32000, message: error.message } };
        }
        if (reply !== null) ws.send(JSON.stringify(reply));
      } else if (message.id !== undefined) {
        fake.replies.push(message);
        conn.replies.push(message);
      } else {
        fake.notifications.push(message);
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socket, resolve);
  });

  fake.live = () => fake.connections.filter((conn) => conn.ws.readyState === conn.ws.OPEN);
  fake.notify = (method, params) => {
    for (const conn of fake.live()) conn.notify(method, params);
  };
  fake.ask = (method, id, params) => {
    for (const conn of fake.live()) conn.ask(method, id, params);
  };
  fake.writeOwner = async (fields = {}) => {
    await writeFile(fake.ownerFile, JSON.stringify({
      socket, pid: process.pid, startedAt: new Date().toISOString(), codexVersion: FAKE_VERSION, ...fields,
    }));
  };
  fake.removeOwner = () => rm(fake.ownerFile, { force: true });
  fake.disconnectAll = async () => {
    const open = fake.live();
    for (const conn of open) conn.close();
    await Promise.all(open.map((conn) => conn.closed));
  };
  fake.close = async () => {
    if (fake.closed) return;
    fake.closed = true;
    for (const conn of fake.connections) conn.ws.terminate();
    await new Promise((resolve) => wss.close(resolve));
    await new Promise((resolve) => server.close(resolve));
  };
  t.after(async () => {
    await fake.close();
    await rm(dir, { recursive: true, force: true });
  });
  return fake;
}

function publicThread(thread) {
  const { turns, waiting, ...wire } = thread;
  return wire;
}

// Polls until `predicate()` returns a truthy value or `ms` has passed.
export async function until(predicate, ms = 2_000, label = 'condition') {
  const deadline = Date.now() + ms;
  for (;;) {
    const found = predicate();
    if (found) return found;
    if (Date.now() > deadline) throw new Error(`${label} did not happen within ${ms}ms`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
