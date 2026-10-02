// Focus proxy: forwards a fixed set of routes to the Focus server at
// config.focusOrigin. There is no generic forwarding: every upstream path is a
// constant in this file. app.mjs depends only on the contract below.
//
// createFocusProxy(config) returns:
//
//   handlePage(req, res)
//     GET /embedded/focus. Fetches the fixed upstream `GET /` and writes it
//     with a child CSP that allows Focus's inline scripts and styles, its
//     Google Fonts stylesheet and font files, and fetches to this origin.
//     Common headers are already set.
//
//   handleApi(req, res, { body })
//     GET or PUT /api/focus, forwarded to the fixed upstream /api/focus. For
//     PUT, app.mjs has already checked Origin, JSON content type, and declared
//     Content-Length; `body` is the request body stream from
//     limitRequestBody (config.limits.focusBodyBytes); the consumer
//     obligations are in http.mjs above limitRequestBody. The body is read
//     only from `body`, never from `req`. When `body` errors (limit crossed or
//     client gone), the upstream request is aborted at once and the reply is
//     sendError(res, err.status, err.code), even if Focus already answered:
//     a PUT succeeds only when the whole body was sent upstream and the whole
//     response arrived. For GET, `body` is undefined.
//
//   handleControl(req, res, { path })
//     Focus's own status and scan controls, which its page calls by absolute
//     path, forwarded to the same upstream path (CONTROL_ROUTES):
//       GET  /api/status    JSON status
//       GET  /api/candidates JSON: each scanner's latest candidates + verdict
//       POST /api/pause     200 JSON status, or 500 text/plain
//       POST /api/resume    200 JSON status, or 500 text/plain
//       POST /api/refresh   202 JSON status, or 409 JSON when already refreshing
//     For POST, app.mjs has already checked Origin and that the request has
//     no body (no JSON content type is required); the upstream request is
//     sent with Content-Length: 0 and nothing is read from `req`. A path or
//     method outside CONTROL_ROUTES is answered 404 without contacting Focus.
//
//   Responses from handleApi and handleControl pass through with Focus's
//   status (anything but 3xx), content type, and body, provided the type is
//   JSON or text/plain. A mutation (PUT or POST) is never retried.
//
//   checkHealth({ signal }) -> Promise<{ available: boolean }>
//     Used by /api/dashboard/status: a GET of upstream /api/focus, read up to
//     API_LIMIT and parsed, built on the same getJson as fetchStatus below.
//     available is true only when the reply is 200 JSON whose body is a
//     complete, parseable, plain JSON object. Stops when `signal` aborts or
//     after config.timeouts.upstreamMs; resolves { available: false } on any
//     failure, including a truncated response.
//
//   fetchStatus({ signal }) -> Promise<object | null>
//     Used by the routines module: a GET of upstream /api/status, read up to
//     API_LIMIT and parsed. Resolves with the parsed object when the reply is
//     200 JSON whose body is a plain JSON object. Stops when `signal` aborts or
//     after config.timeouts.upstreamMs. Resolves null on any failure (timeout,
//     abort, non-200, wrong media type, oversize, truncation, parse error);
//     never rejects.
//
// Upstream requests carry Host set to the configured authority and only the
// headers listed in forwardedHeaders; cookies, credentials, hop-by-hop
// headers, Origin and Referer never cross. Responses are buffered up to
// PAGE_LIMIT (HTML) or API_LIMIT (JSON) before anything is written, so every
// failure is a JSON error:
//   502 focus_unavailable           refused, reset, or closed before a complete response
//                                   (a GET, or a mutation whose request was not sent whole)
//   502 upstream_failed_uncertain   a mutation was sent whole, then the connection failed
//   502 upstream_early_response     Focus answered and closed before the request body was sent whole
//   502 upstream_redirect           3xx; redirects are never followed
//   502 upstream_too_large          response over the size limit
//   502 upstream_bad_response       page not 200 HTML, or API response not JSON/text
//   504 upstream_timeout            no complete exchange within config.timeouts.upstreamMs
//   504 upstream_timeout_uncertain  the same, after a mutation was sent whole; Focus may have committed

import http from 'node:http';

import { HttpError, buildChildCsp, sendBody, sendError, setContentSecurityPolicy } from './http.mjs';

export const PAGE_LIMIT = 2 * 1024 * 1024;
export const API_LIMIT = 4 * 1024 * 1024;

const PAGE_PATH = '/';
const API_PATH = '/api/focus';
const STATUS_PATH = '/api/status';

// The only other upstream paths, each with its one allowed method.
export const CONTROL_ROUTES = new Map([
  ['/api/status', 'GET'],
  ['/api/candidates', 'GET'],
  ['/api/pause', 'POST'],
  ['/api/resume', 'POST'],
  ['/api/refresh', 'POST'],
]);

export const FOCUS_PAGE_CSP = buildChildCsp({
  inlineScripts: true,
  inlineStyles: true,
  styleSources: ['https://fonts.googleapis.com'],
  fontSources: ['https://fonts.gstatic.com'],
});

const API_TYPES = new Set(['application/json', 'text/plain']);

export function createFocusProxy(config) {
  const origin = new URL(config.focusOrigin);
  const target = {
    host: origin.hostname.replace(/^\[(.*)\]$/, '$1'),
    port: Number(origin.port || 80),
  };
  const authority = origin.host;
  const timeoutMs = config.timeouts.upstreamMs;

  // One upstream exchange. Resolves with the buffered response once the
  // request has been sent whole AND the response has arrived whole; rejects
  // with an HttpError otherwise. Whichever failure comes first wins, including
  // a body error after Focus has already answered. Never retries. The client
  // leaving aborts the upstream.
  function exchange(res, { method, path, headers, body, limit }) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let requestSent = false;
      let reply = null;
      const upstream = http.request({ ...target, method, path, headers: { ...headers, host: authority }, agent: false });

      const uncertain = () => method !== 'GET' && requestSent;
      const cleanup = () => {
        clearTimeout(timer);
        res.off('close', onClientClose);
      };
      const fail = (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        body?.unpipe(upstream);
        upstream.destroy();
        reject(error);
      };
      const succeedIfDone = () => {
        if (settled || !requestSent || !reply) return;
        settled = true;
        cleanup();
        resolve(reply);
      };
      const onClientClose = () => {
        if (!res.writableFinished) fail(new HttpError(400, 'request_aborted'));
      };
      const timer = setTimeout(() => {
        fail(new HttpError(504, uncertain() ? 'upstream_timeout_uncertain' : 'upstream_timeout'));
      }, timeoutMs);

      res.on('close', onClientClose);
      const connectionFailed = () =>
        new HttpError(502, uncertain() ? 'upstream_failed_uncertain' : 'focus_unavailable');
      const earlyOrFailed = () => (reply && !requestSent ? new HttpError(502, 'upstream_early_response') : connectionFailed());
      upstream.on('error', () => fail(earlyOrFailed()));
      upstream.on('finish', () => {
        requestSent = true;
        succeedIfDone();
      });
      // Node closes a Connection: close socket once the response ends, and
      // then drops further body writes without an error. So a connection that
      // closes before the request was sent whole fails here instead of
      // stalling until the timeout.
      upstream.on('close', () => {
        if (!requestSent) fail(earlyOrFailed());
      });
      upstream.on('response', (upstreamRes) => {
        if (upstreamRes.statusCode >= 300 && upstreamRes.statusCode < 400) {
          upstreamRes.resume();
          fail(new HttpError(502, 'upstream_redirect'));
          return;
        }
        readBounded(upstreamRes, limit, connectionFailed).then((buffer) => {
          reply = { status: upstreamRes.statusCode, contentType: upstreamRes.headers['content-type'], body: buffer };
          succeedIfDone();
        }, fail);
      });

      if (body) {
        // Attached before the first read and kept for the stream's lifetime.
        body.on('error', fail);
        body.pipe(upstream);
      } else {
        upstream.end();
      }
    });
  }

  // One bounded GET, shared by checkHealth and fetchStatus: reads up to
  // API_LIMIT and resolves the parsed body when the reply is 200 JSON whose
  // body is a complete, parseable, plain JSON object; null on any failure
  // (timeout, abort, non-200, wrong media type, oversize, truncation, parse
  // error, or a non-object value). Stops when `signal` aborts or after
  // timeoutMs. Never rejects. Success leaves the connection to close normally
  // after the body ended; any failure cuts it.
  function getJson(path, { signal } = {}) {
    return new Promise((resolve) => {
      if (signal?.aborted) {
        resolve(null);
        return;
      }
      let settled = false;
      const upstream = http.request({
        ...target,
        method: 'GET',
        path,
        headers: { host: authority, accept: 'application/json' },
        agent: false,
      });
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (value === null) upstream.destroy();
        resolve(value);
      };
      const onAbort = () => finish(null);
      const timer = setTimeout(onAbort, timeoutMs);
      signal?.addEventListener('abort', onAbort, { once: true });
      upstream.on('error', onAbort);
      upstream.on('response', (upstreamRes) => {
        const usable = upstreamRes.statusCode === 200
          && mediaType(upstreamRes.headers['content-type']) === 'application/json';
        if (!usable) {
          upstreamRes.resume();
          finish(null);
          return;
        }
        readBounded(upstreamRes, API_LIMIT, () => null).then((buffer) => {
          let parsed;
          try {
            parsed = JSON.parse(buffer.toString('utf8'));
          } catch {
            finish(null);
            return;
          }
          const plain = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed);
          finish(plain ? parsed : null);
        }, onAbort);
      });
      upstream.end();
    });
  }

  // Forwards to a fixed upstream path and passes Focus's reply through.
  async function forward(res, request) {
    let reply;
    try {
      reply = await exchange(res, { ...request, limit: API_LIMIT });
    } catch (error) {
      sendError(res, error.status, error.code);
      return;
    }
    if (!API_TYPES.has(mediaType(reply.contentType))) {
      sendError(res, 502, 'upstream_bad_response');
      return;
    }
    sendBody(res, reply.status, reply.contentType, reply.body);
  }

  return {
    async handlePage(_req, res) {
      let reply;
      try {
        reply = await exchange(res, { method: 'GET', path: PAGE_PATH, headers: { accept: 'text/html' }, limit: PAGE_LIMIT });
      } catch (error) {
        sendError(res, error.status, error.code);
        return;
      }
      if (reply.status !== 200 || mediaType(reply.contentType) !== 'text/html') {
        sendError(res, 502, 'upstream_bad_response');
        return;
      }
      setContentSecurityPolicy(res, FOCUS_PAGE_CSP);
      sendBody(res, 200, reply.contentType, reply.body);
    },

    handleApi(req, res, { body } = {}) {
      return forward(res, { method: req.method, path: API_PATH, headers: forwardedHeaders(req, body), body });
    },

    handleControl(req, res, { path } = {}) {
      if (CONTROL_ROUTES.get(path) !== req.method) {
        sendError(res, 404, 'not_found');
        return Promise.resolve();
      }
      const headers = { accept: 'application/json' };
      if (req.method === 'POST') headers['content-length'] = '0';
      return forward(res, { method: req.method, path, headers });
    },

    async checkHealth({ signal } = {}) {
      return { available: (await getJson(API_PATH, { signal })) !== null };
    },

    fetchStatus({ signal } = {}) {
      return getJson(STATUS_PATH, { signal });
    },
  };
}

// The only request headers that reach Focus besides Host: what the API needs
// to read a JSON body. Everything else the browser sent stays here.
function forwardedHeaders(req, body) {
  const headers = { accept: 'application/json' };
  if (body) {
    headers['content-type'] = req.headers['content-type'];
    if (req.headers['content-length'] !== undefined) headers['content-length'] = req.headers['content-length'];
  }
  return headers;
}

// Buffers a response body, rejecting with 502 upstream_too_large once it is
// declared or counted past `limit`, and with failed() if the stream breaks or
// closes before its end (a truncated response).
function readBounded(stream, limit, failed) {
  return new Promise((resolve, reject) => {
    const tooLarge = () => {
      stream.destroy();
      reject(new HttpError(502, 'upstream_too_large'));
    };
    // Attached first so a later destroy never goes unhandled.
    stream.on('error', () => reject(failed()));
    stream.on('close', () => {
      if (!stream.readableEnded) reject(failed());
    });
    if (Number(stream.headers['content-length'] ?? 0) > limit) {
      tooLarge();
      return;
    }
    const chunks = [];
    let size = 0;
    stream.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) tooLarge();
      else chunks.push(chunk);
    });
    stream.on('end', () => resolve(Buffer.concat(chunks, size)));
  });
}

function mediaType(value) {
  return typeof value === 'string' ? value.split(';', 1)[0].trim().toLowerCase() : '';
}
