// Response and request-body helpers shared by the router and route modules.
// Every JSON error body is { "error": "<code>" }; no messages or stacks.

import { Transform } from 'node:stream';

export class HttpError extends Error {
  constructor(status, code) {
    super(code);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

export const SHELL_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  // Feed images come from story sites; the shell is only served on the tailnet.
  "img-src 'self' data: https: http:",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'self'",
].join('; ');

// Applied to every response first; HTML routes replace it with SHELL_CSP or a child policy.
export const DEFAULT_CSP = "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";

const EXTERNAL_SOURCE = /^https:\/\/[a-z0-9.-]+$/;

// Policy for an embedded child page (Focus UI, a brief viewer). Those pages
// carry their own inline scripts/styles and may load fonts from named
// https origins. Framing stays limited to this origin.
export function buildChildCsp({
  inlineScripts = false,
  inlineStyles = false,
  styleSources = [],
  fontSources = [],
} = {}) {
  for (const source of [...styleSources, ...fontSources]) {
    if (!EXTERNAL_SOURCE.test(source)) throw new TypeError('child CSP sources must be bare https origins');
  }
  const directive = (name, inline, extra) =>
    [name, "'self'", ...(inline ? ["'unsafe-inline'"] : []), ...extra].join(' ');
  return [
    "default-src 'self'",
    directive('script-src', inlineScripts, []),
    directive('style-src', inlineStyles, styleSources),
    directive('font-src', false, fontSources),
    "img-src 'self' data:",
    "connect-src 'self'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'self'",
  ].join('; ');
}

export function setContentSecurityPolicy(res, policy) {
  res.setHeader('Content-Security-Policy', policy);
}

export function applyCommonHeaders(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Content-Security-Policy', DEFAULT_CSP);
}

// Sends a complete body. With head: true, sends the same headers and no body.
export function sendBody(res, status, contentType, body, { head = false, headers = {} } = {}) {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
  res.writeHead(status, {
    ...headers,
    'Content-Type': contentType,
    'Content-Length': buffer.length,
  });
  res.end(head ? undefined : buffer);
}

export function sendJson(res, status, value, options = {}) {
  sendBody(res, status, 'application/json; charset=utf-8', JSON.stringify(value), options);
}

export function redirect(res, location, status = 308) {
  res.writeHead(status, { Location: location, 'Content-Length': 0 });
  res.end();
}

export function isJsonContentType(value) {
  if (typeof value !== 'string') return false;
  return value.split(';', 1)[0].trim().toLowerCase() === 'application/json';
}

export function declaredLengthExceeds(req, limit) {
  const declared = req.headers['content-length'];
  return declared !== undefined && Number(declared) > limit;
}

// An AbortSignal that aborts when `res` closes before it finished.
export function closedSignal(res) {
  const controller = new AbortController();
  res.once('close', () => controller.abort());
  return controller.signal;
}

const tooLarge = () => new HttpError(413, 'payload_too_large');
const aborted = () => new HttpError(400, 'request_aborted');

// How much of an unread request body is discarded, and for how long, after an
// early reply before the connection is cut.
export const LINGER_LIMITS = Object.freeze({ bytes: 2 * 1024 * 1024, ms: 2_000 });

function hasUnreadBody(req) {
  if (!req || req.complete || req.destroyed) return false;
  const declared = Number(req.headers['content-length'] ?? 0);
  return declared > 0 || req.headers['transfer-encoding'] !== undefined;
}

// Prepares a reply sent before the request body has fully arrived (a 413, or
// any refusal that skips the body). The reply carries Connection: close. Node
// would close the socket as soon as the reply is written, and a client still
// uploading would then get a reset instead of the reply. So the write side is
// closed after the reply while the rest of the body is read and discarded;
// the socket is destroyed once more than LINGER_LIMITS.bytes arrive or
// LINGER_LIMITS.ms pass, and closed normally if the body ends first.
function lingerAfterEarlyReply(req, res) {
  const socket = req.socket;
  if (!socket || socket.destroyed) return;
  res.setHeader('Connection', 'close');
  req.unpipe();

  const cut = () => socket.destroy();
  const timer = setTimeout(cut, LINGER_LIMITS.ms);
  timer.unref();
  socket.once('close', () => clearTimeout(timer));

  let discarded = 0;
  req.on('data', (chunk) => {
    discarded += chunk.length;
    if (discarded > LINGER_LIMITS.bytes) cut();
  });
  req.resume();

  // Node's HTTP server calls socket.destroySoon() once a Connection: close
  // reply is written. Replace it for this socket only: end our side, keep
  // reading, and destroy once the reply is flushed and the body is done. If a
  // future Node stops calling it, the timer above still bounds the socket.
  socket.destroySoon = function closeAfterBody() {
    if (this.writable) this.end();
    const closeWhenDone = () => {
      if (this.writableFinished && (req.complete || req.destroyed)) this.destroy();
    };
    this.once('finish', closeWhenDone);
    req.once('end', closeWhenDone);
    closeWhenDone();
  };
}

// Sends { error: code }. If headers already went out, the only safe move is to
// cut the connection so the client sees a failure instead of a truncated
// success. If the request body is still arriving, the reply closes the
// connection after a bounded drain (see lingerAfterEarlyReply).
export function sendError(res, status, code, { headers = {}, head = false } = {}) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  if (hasUnreadBody(res.req)) lingerAfterEarlyReply(res.req, res);
  sendJson(res, status, { error: code }, { headers, head });
}

// Buffers the whole request body. Rejects with HttpError(413) as soon as the
// body is declared or counted past `limit` bytes, and with
// HttpError(400, 'request_aborted') if the client disconnects. After a 413 the
// caller replies with sendError, which handles the unread remainder.
export function readBody(req, { limit }) {
  if (declaredLengthExceeds(req, limit)) return Promise.reject(tooLarge());
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const settle = (error, value) => {
      if (settled) return;
      settled = true;
      req.off('data', onData).off('end', onEnd).off('error', onFail).off('close', onFail);
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk) => {
      size += chunk.length;
      if (size > limit) {
        req.pause();
        settle(tooLarge());
      } else {
        chunks.push(chunk);
      }
    };
    const onEnd = () => settle(null, Buffer.concat(chunks, size));
    const onFail = () => settle(aborted());
    req.on('data', onData).on('end', onEnd).on('error', onFail).on('close', onFail);
  });
}

// readBody plus JSON.parse; malformed JSON is HttpError(400, 'invalid_json').
export async function readJsonBody(req, { limit }) {
  const buffer = await readBody(req, { limit });
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid_json');
  }
}

// Streaming counterpart of readBody for pass-through bodies. Returns a readable
// stream carrying the request body, with backpressure to `req`. The stream is
// destroyed with an error:
//   - HttpError(413, 'payload_too_large') the moment more than `limit` bytes
//     have arrived. The chunk that crossed the limit is not passed on and
//     `req` is unpiped and paused; nothing is drained before the error.
//   - HttpError(400, 'request_aborted') if the client disconnects mid-body.
// Consumer obligations:
//   - Attach an 'error' listener (or consume with for await inside try/catch)
//     before reading, and keep it for the stream's lifetime; an unhandled
//     error crashes the process.
//   - On error, abort any upstream request at once, then, if headers are not
//     sent, reply sendError(res, err.status, err.code). sendError sends
//     Connection: close and discards a bounded remainder of the body before
//     cutting the connection; the consumer does not drain `req`.
//   - Never read from `req` directly.
export function limitRequestBody(req, limit) {
  let size = 0;
  const limited = new Transform({
    transform(chunk, _encoding, callback) {
      size += chunk.length;
      if (size > limit) {
        req.unpipe(limited);
        req.pause();
        callback(tooLarge());
        return;
      }
      callback(null, chunk);
    },
  });
  req.on('error', () => limited.destroy(aborted()));
  req.on('close', () => {
    if (!req.complete) limited.destroy(aborted());
  });
  req.pipe(limited);
  return limited;
}
