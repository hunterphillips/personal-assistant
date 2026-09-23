// Focus proxy: PHASE 1 STUB. Phase 2 replaces this module's body; app.mjs
// depends only on the contract below.
//
// createFocusProxy(config) returns:
//
//   handlePage(req, res)
//     GET /embedded/focus. Fetch the fixed upstream `GET /` from
//     config.focusOrigin and write the response, including a child CSP
//     (http.mjs buildChildCsp + setContentSecurityPolicy). Common headers are
//     already set.
//
//   handleApi(req, res, { body })
//     GET or PUT /api/focus, forwarded to the fixed upstream /api/focus. For
//     PUT, app.mjs has already checked Origin, JSON content type, and declared
//     Content-Length; `body` is the request body stream from
//     limitRequestBody (config.limits.focusBodyBytes). Read the body only from
//     `body`, never from `req`. If `body` errors, abort the upstream request and,
//     when headers are not sent, reply sendError(res, err.status, err.code).
//     For GET, `body` is undefined. Never retry a mutation.
//
//   checkHealth({ signal }) -> Promise<{ available: boolean }>
//     Used by /api/status. Must stop work when `signal` aborts; app.mjs also
//     bounds the wait and treats rejection or timeout as unavailable.
//
// Handlers may throw HttpError (http.mjs) before writing; app.mjs converts it
// to a JSON error. Upstream refusal is 502, timeout 504, redirects are errors.

import { sendError } from './http.mjs';

export function createFocusProxy(_config) {
  return {
    async handlePage(_req, res) {
      sendError(res, 503, 'focus_unavailable');
    },
    async handleApi(_req, res, { body } = {}) {
      body?.resume();
      sendError(res, 503, 'focus_unavailable');
    },
    async checkHealth() {
      return { available: false };
    },
  };
}
