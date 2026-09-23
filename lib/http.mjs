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
  "img-src 'self' data:",
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

// Sends { error: code }. If headers already went out, the only safe move is to
// cut the connection so the client sees a failure instead of a truncated success.
export function sendError(res, status, code, { headers = {}, head = false } = {}) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  sendJson(res, status, { error: code }, { headers, head });
}

export function redirect(res, location) {
  res.writeHead(308, { Location: location, 'Content-Length': 0 });
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

const tooLarge = () => new HttpError(413, 'payload_too_large');
const aborted = () => new HttpError(400, 'request_aborted');

const DRAIN_LIMIT_BYTES = 4 * 1024 * 1024;
const draining = new WeakMap();

// Discards the rest of a rejected request body and resolves once the request
// has been fully received. Replying only after that lets the client finish
// sending and read the error; replying mid-upload makes Node close the
// connection and the client usually sees a reset instead. Bodies declared
// larger than `maxBytes` are not waited for, and a client that sends more
// than `maxBytes` has its connection cut. Safe to call more than once.
export function drainRequest(req, maxBytes = DRAIN_LIMIT_BYTES) {
  let pending = draining.get(req);
  if (pending) return pending;
  pending = new Promise((resolve) => {
    if (req.complete || req.destroyed || Number(req.headers['content-length'] ?? 0) > maxBytes) {
      resolve();
      return;
    }
    let discarded = 0;
    req.on('data', (chunk) => {
      discarded += chunk.length;
      if (discarded > maxBytes) req.socket?.destroy();
    });
    req.once('end', resolve).once('close', resolve);
    req.resume();
  });
  draining.set(req, pending);
  return pending;
}

// Buffers the whole request body, rejecting with HttpError(413) once it passes
// `limit` bytes (by Content-Length or by counting). A 413 rejection happens
// after the remainder has been drained.
export function readBody(req, { limit }) {
  if (declaredLengthExceeds(req, limit)) return drainRequest(req).then(() => Promise.reject(tooLarge()));
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const detach = () => {
      settled = true;
      req.off('data', onData).off('end', onEnd).off('error', onFail).off('close', onFail);
    };
    const settle = (error, value) => {
      if (settled) return;
      detach();
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk) => {
      size += chunk.length;
      if (size > limit) {
        detach();
        drainRequest(req).then(() => reject(tooLarge()));
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
// stream carrying the request body that errors with HttpError(413) as soon as
// more than `limit` bytes arrive (after draining the remainder), or HttpError(400, 'request_aborted') if the
// client disconnects mid-body. The consumer must handle the stream's 'error'
// event: abort any upstream request and, if nothing was sent yet, reply with
// sendError(res, err.status, err.code).
export function limitRequestBody(req, limit) {
  let size = 0;
  const limited = new Transform({
    transform(chunk, _encoding, callback) {
      size += chunk.length;
      if (size > limit) {
        req.unpipe(limited);
        drainRequest(req).then(() => callback(tooLarge()));
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
