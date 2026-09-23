// Focus proxy: forwards two fixed routes to the Focus server at
// config.focusOrigin. app.mjs depends only on the contract below.
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
//     sendError(res, err.status, err.code). For GET, `body` is undefined.
//     A mutation is never retried.
//
//   checkHealth({ signal }) -> Promise<{ available: boolean }>
//     Used by /api/status: a bounded GET of upstream /api/focus whose body is
//     discarded. Stops when `signal` aborts; resolves { available: false } on
//     any failure.
//
// Upstream requests carry Host set to the configured authority and only the
// headers listed in forwardedHeaders; cookies, credentials, hop-by-hop
// headers, Origin and Referer never cross. Responses are buffered up to
// PAGE_LIMIT (HTML) or API_LIMIT (JSON) before anything is written, so every
// failure is a JSON error:
//   502 focus_unavailable           connection refused or reset before the request was sent
//   502 upstream_failed_uncertain   a PUT was sent whole, then the connection failed
//   502 upstream_redirect           3xx; redirects are never followed
//   502 upstream_too_large          response over the size limit
//   502 upstream_bad_response       page not 200 HTML, or API response not JSON/text
//   504 upstream_timeout            no complete response within config.timeouts.upstreamMs
//   504 upstream_timeout_uncertain  the same, after a PUT was sent whole; Focus may have committed

import http from 'node:http';

import { HttpError, buildChildCsp, sendBody, sendError, setContentSecurityPolicy } from './http.mjs';

export const PAGE_LIMIT = 2 * 1024 * 1024;
export const API_LIMIT = 4 * 1024 * 1024;

const PAGE_PATH = '/';
const API_PATH = '/api/focus';

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

  // One upstream exchange. Resolves with the buffered response or rejects
  // with an HttpError; never retries. The client leaving aborts the upstream.
  function exchange(res, { method, path, headers, body, limit }) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let requestSent = false;
      const upstream = http.request({ ...target, method, path, headers: { ...headers, host: authority }, agent: false });

      const uncertain = () => method === 'PUT' && requestSent;
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
      const onClientClose = () => {
        if (!res.writableFinished) fail(new HttpError(400, 'request_aborted'));
      };
      const timer = setTimeout(() => {
        fail(new HttpError(504, uncertain() ? 'upstream_timeout_uncertain' : 'upstream_timeout'));
      }, timeoutMs);

      res.on('close', onClientClose);
      upstream.on('finish', () => { requestSent = true; });
      const connectionFailed = () =>
        new HttpError(502, uncertain() ? 'upstream_failed_uncertain' : 'focus_unavailable');
      upstream.on('error', () => fail(connectionFailed()));
      upstream.on('response', (upstreamRes) => {
        if (upstreamRes.statusCode >= 300 && upstreamRes.statusCode < 400) {
          upstreamRes.resume();
          fail(new HttpError(502, 'upstream_redirect'));
          return;
        }
        readBounded(upstreamRes, limit, connectionFailed).then((buffer) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve({ status: upstreamRes.statusCode, contentType: upstreamRes.headers['content-type'], body: buffer });
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

    async handleApi(req, res, { body } = {}) {
      let reply;
      try {
        reply = await exchange(res, {
          method: req.method,
          path: API_PATH,
          headers: forwardedHeaders(req, body),
          body,
          limit: API_LIMIT,
        });
      } catch (error) {
        sendError(res, error.status, error.code);
        return;
      }
      if (!API_TYPES.has(mediaType(reply.contentType))) {
        sendError(res, 502, 'upstream_bad_response');
        return;
      }
      sendBody(res, reply.status, reply.contentType, reply.body);
    },

    checkHealth({ signal } = {}) {
      return new Promise((resolve) => {
        if (signal?.aborted) {
          resolve({ available: false });
          return;
        }
        let settled = false;
        const upstream = http.request({
          ...target,
          method: 'GET',
          path: API_PATH,
          headers: { host: authority, accept: 'application/json' },
          agent: false,
        });
        const finish = (available) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          upstream.destroy();
          resolve({ available });
        };
        const onAbort = () => finish(false);
        const timer = setTimeout(onAbort, timeoutMs);
        signal?.addEventListener('abort', onAbort, { once: true });
        upstream.on('error', onAbort);
        upstream.on('response', (upstreamRes) => {
          upstreamRes.on('error', () => {}); // destroyed below; the body is not needed
          finish(upstreamRes.statusCode === 200 && mediaType(upstreamRes.headers['content-type']) === 'application/json');
        });
        upstream.end();
      });
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
// declared or counted past `limit`, and with failed() if the stream breaks.
function readBounded(stream, limit, failed) {
  return new Promise((resolve, reject) => {
    const tooLarge = () => {
      stream.destroy();
      reject(new HttpError(502, 'upstream_too_large'));
    };
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
    stream.on('error', () => reject(failed()));
  });
}

function mediaType(value) {
  return typeof value === 'string' ? value.split(';', 1)[0].trim().toLowerCase() : '';
}
