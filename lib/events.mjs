// Event stream (GET /api/events), Server-Sent Events:
//   - On connect the hub's status is refreshed (bounded by
//     timeouts.statusMs), then `event: snapshot` carries the whole snapshot
//     with `id:` set to its revision.
//   - Each hub change is `event: delta` with `id: <revision>` and data
//     { revision, patch }. There is no replay and Last-Event-ID is ignored: a
//     client that sees a revision gap refetches GET /api/state.
//   - A comment line `: ping` every timeouts.heartbeatMs keeps proxies from
//     closing an idle stream.
//   - Backpressure: when a write returns false, later deltas and pings are
//     dropped until `drain`; if any delta was dropped, one `event: reload`
//     (data {}) follows so the client refetches the snapshot. At most one
//     delta is ever buffered beyond the socket.
//   - closeStreams() sends `event: bye` (data {}) and ends each stream; new
//     streams once the app is shutting down get 503 shutting_down.
//   - At most limits.eventStreams streams at once; the next gets 503
//     too_many_streams with Retry-After: 5.
//   - While any stream is open, one shared unref'd interval refreshes the
//     hub's status every timeouts.statusPollMs.
//   - The router logs a stream once, when it closes, as event stream_closed;
//     isStream(res) tells it which responses those are.
//
// createEvents({ hub, timeouts, limits, shuttingDown }) returns
//   serve(req, res) -> Promise<void>   the route body
//   isStream(res) -> boolean           true once serve() took the response
//   closeStreams()                     bye and end every open stream
// `shuttingDown` is a function answering whether the app's closeStreams()
// has run; the app sets that before calling closeStreams() here.

import { closedSignal, sendError } from './http.mjs';

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-store',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
};

export function createEvents({ hub, timeouts, limits, shuttingDown }) {
  const streams = new Set(); // one close() per open event stream
  const streamingResponses = new WeakSet();
  let statusPoll = null;

  function updateStatusPoll() {
    if (streams.size > 0 && !statusPoll) {
      statusPoll = setInterval(() => hub.refreshStatus(), timeouts.statusPollMs);
      statusPoll.unref();
    } else if (streams.size === 0 && statusPoll) {
      clearInterval(statusPoll);
      statusPoll = null;
    }
  }

  async function serve(req, res) {
    if (shuttingDown()) {
      sendError(res, 503, 'shutting_down');
      return;
    }
    if (streams.size >= limits.eventStreams) {
      sendError(res, 503, 'too_many_streams', { headers: { 'Retry-After': '5' } });
      return;
    }
    streamingResponses.add(res);
    res.writeHead(200, SSE_HEADERS);
    res.flushHeaders();

    let open = true;
    let blocked = false; // a write returned false and drain has not come
    let dropped = false; // a delta was dropped while blocked
    let unsubscribe = () => {};
    const write = (text) => {
      if (!open || res.writableEnded || res.destroyed) return;
      if (!res.write(text)) blocked = true;
    };
    const onDrain = () => {
      blocked = false;
      if (dropped) {
        dropped = false;
        write('event: reload\ndata: {}\n\n');
      }
    };
    const heartbeat = setInterval(() => {
      if (!blocked) write(': ping\n\n');
    }, timeouts.heartbeatMs);
    heartbeat.unref();
    const close = ({ bye = false } = {}) => {
      if (!open) return;
      if (bye) write('event: bye\ndata: {}\n\n');
      open = false;
      clearInterval(heartbeat);
      unsubscribe();
      res.off('drain', onDrain);
      streams.delete(close);
      updateStatusPoll();
      if (bye && !res.writableEnded) res.end();
    };
    res.on('drain', onDrain);
    req.once('close', () => close());
    res.once('close', () => close());
    streams.add(close);
    updateStatusPoll();

    await hub.refreshStatus({ signal: closedSignal(res) });
    if (!open) return;
    const snapshot = hub.snapshot();
    write(`id: ${snapshot.revision}\nevent: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
    unsubscribe = hub.subscribe(({ revision, patch }) => {
      if (blocked) {
        dropped = true;
        return;
      }
      write(`id: ${revision}\nevent: delta\ndata: ${JSON.stringify({ revision, patch })}\n\n`);
    });
  }

  function isStream(res) {
    return streamingResponses.has(res);
  }

  // Ends every open event stream with a final `bye`.
  function closeStreams() {
    for (const close of [...streams]) close({ bye: true });
  }

  return { serve, isStream, closeStreams };
}
