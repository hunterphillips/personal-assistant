// Scripted stand-ins for the Focus server.
//
// startScriptedFocus: each request is recorded with its method, path, headers,
// the body bytes that arrived, and whether the body arrived whole;
// `respond(req, res, record)` decides the reply after the body has been read.
// The default answers 200 JSON. `record.closed` resolves when the request
// closes; `record.socketClosed` resolves with { hadError, errorCode } when the
// connection closes, so tests can tell a clean close from a reset.
//
// startEarlyReplyFocus: a raw TCP server that answers 200 JSON as soon as a
// request's headers arrive and never closes its side. By default it keeps
// reading the body; with { stopReading: true } it stops reading once it has
// answered, so the rest of the body stays queued on the sender's side, until
// the test calls connection.resume(). It
// shows what the proxy does when Focus answers before the body is sent whole.

import http from 'node:http';
import net from 'node:net';

import { closeServer, listen } from './harness.mjs';

export async function startScriptedFocus(t, respond = defaultRespond) {
  const records = [];
  const server = http.createServer((req, res) => {
    const parts = [];
    const record = { method: req.method, url: req.url, headers: req.headers, bytes: 0, complete: false };
    record.closed = new Promise((resolve) => req.once('close', () => resolve(record)));
    let errorCode;
    req.socket.on('error', (error) => { errorCode = error.code; });
    record.socketClosed = new Promise((resolve) => {
      req.socket.once('close', (hadError) => resolve({ hadError, errorCode }));
    });
    records.push(record);
    req.on('data', (chunk) => {
      record.bytes += chunk.length;
      parts.push(chunk);
    });
    req.on('end', () => {
      record.complete = true;
      record.body = Buffer.concat(parts).toString('utf8');
      respond(req, res, record);
    });
  });
  const port = await listen(server);
  t.after(() => closeServer(server));
  return { port, origin: `http://127.0.0.1:${port}`, authority: `127.0.0.1:${port}`, records };
}

function defaultRespond(_req, res) {
  res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"synthetic":true}');
}

export async function startEarlyReplyFocus(t, { stopReading = false } = {}) {
  const connections = [];
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    const connection = { bytes: 0, replied: false, closed: null, resume: () => socket.resume() };
    connection.closed = new Promise((resolve) => socket.once('close', () => resolve(connection)));
    connections.push(connection);
    socket.on('error', () => {});
    let head = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      connection.bytes += chunk.length;
      if (connection.replied) return;
      head = Buffer.concat([head, chunk]);
      if (head.includes('\r\n\r\n')) {
        connection.replied = true;
        socket.write('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\n\r\n{"early":1}');
        if (stopReading) socket.pause();
      }
    });
  });
  const port = await listen(server);
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  return { port, origin: `http://127.0.0.1:${port}`, connections };
}
