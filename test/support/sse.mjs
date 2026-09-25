// A raw Server-Sent Events client for tests. openEvents(app) sends
// GET /api/events and resolves once response headers arrive with
//   { status, headers, body, next(ms), close(), closed }
// For a 200, next() resolves with the next parsed event, { id, event, data }
// with `data` JSON-parsed, or { comment } for a `:` line, and rejects if none
// arrives within `ms` or the stream ends first. For other statuses `body` is
// the whole text. close() destroys the connection; `closed` resolves when it
// has closed. pause() and resume() stop and restart reading the socket.

import http from 'node:http';

export function openEvents(app, { path = '/api/events', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: app.port,
      method: 'GET',
      path,
      headers: { host: app.authority, ...headers },
      setHost: false,
      agent: false,
    });
    req.on('error', reject);
    req.on('response', (res) => {
      const queue = [];
      const waiters = [];
      let ended = false;
      let buffer = '';
      const closed = new Promise((done) => res.once('close', done));
      const push = (item) => {
        const waiter = waiters.shift();
        if (waiter) waiter.resolve(item);
        else queue.push(item);
      };
      res.setEncoding('utf8');
      res.on('error', () => {});
      res.on('close', () => {
        ended = true;
        while (waiters.length > 0) waiters.shift().reject(new Error('stream ended'));
      });

      if (res.statusCode !== 200) {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body, closed }));
        return;
      }

      res.on('data', (chunk) => {
        buffer += chunk;
        let at;
        while ((at = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, at);
          buffer = buffer.slice(at + 2);
          push(parseBlock(block));
        }
      });
      resolve({
        status: res.statusCode,
        headers: res.headers,
        closed,
        next(ms = 2_000) {
          if (queue.length > 0) return Promise.resolve(queue.shift());
          if (ended) return Promise.reject(new Error('stream ended'));
          return new Promise((done, fail) => {
            const waiter = {
              resolve: (item) => { clearTimeout(timer); done(item); },
              reject: (error) => { clearTimeout(timer); fail(error); },
            };
            const timer = setTimeout(() => {
              waiters.splice(waiters.indexOf(waiter), 1);
              fail(new Error(`no event within ${ms} ms`));
            }, ms);
            waiters.push(waiter);
          });
        },
        close() {
          req.destroy();
          return closed;
        },
        pause: () => res.pause(),
        resume: () => res.resume(),
      });
    });
    req.end();
  });
}

function parseBlock(block) {
  const event = {};
  for (const line of block.split('\n')) {
    if (line.startsWith(':')) return { comment: line.slice(1).trim() };
    const colon = line.indexOf(':');
    const field = line.slice(0, colon);
    const value = line.slice(colon + 1).replace(/^ /, '');
    if (field === 'data') event.data = JSON.parse(value);
    else event[field] = value;
  }
  return event;
}
