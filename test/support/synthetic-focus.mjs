// A scripted stand-in for the Focus server. Each request is recorded with its
// method, path, headers, the body bytes that arrived, and whether the body
// arrived whole; `respond(req, res, record)` decides the reply after the body
// has been read. The default answers 200 JSON.

import http from 'node:http';

import { closeServer, listen } from './harness.mjs';

export async function startScriptedFocus(t, respond = defaultRespond) {
  const records = [];
  const server = http.createServer((req, res) => {
    const parts = [];
    const record = { method: req.method, url: req.url, headers: req.headers, bytes: 0, complete: false };
    record.closed = new Promise((resolve) => req.once('close', () => resolve(record)));
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
