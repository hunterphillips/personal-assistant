// Daily Brief routes: PHASE 1 STUB. Phase 3 replaces this module's body;
// app.mjs depends only on the contract below.
//
// createBriefRoutes(config) returns:
//
//   handleLatest(req, res)
//     GET /api/brief/latest. Reply JSON with the latest brief's state, and
//     when available its date, SHA-256 revision, and embedded URL.
//
//   handleEmbedded(req, res, { date, revision })
//     GET /embedded/brief/<date>?revision=<revision>. app.mjs has validated
//     `date` as a real YYYY-MM-DD calendar date and `revision` as 64 lowercase
//     hex characters. Serve exactly that viewer revision, adapted, with a
//     child CSP (http.mjs buildChildCsp + setContentSecurityPolicy).
//
//   handleFeedback(req, res, body)
//     POST /api/brief/feedback. app.mjs has checked Origin and JSON content
//     type, enforced config.limits.feedbackBodyBytes, and parsed the JSON;
//     `body` is the parsed value (any JSON type, still unvalidated).
//
//   latestMetadata({ signal }) -> Promise<{ state, date?, revision?, ... }>
//     Used by /api/status, which copies only `state` (lowercase word),
//     `date`, and `revision`, bounds the wait, and reports
//     { state: "unavailable" } on rejection or timeout. Must never include
//     brief content.
//
// Handlers may throw HttpError (http.mjs) before writing; app.mjs converts it
// to a JSON error.

import { sendError, sendJson } from './http.mjs';

export function createBriefRoutes(_config) {
  return {
    async handleLatest(_req, res) {
      sendJson(res, 200, { state: 'empty' });
    },
    async handleEmbedded(_req, res) {
      sendError(res, 404, 'brief_not_found');
    },
    async handleFeedback(_req, res) {
      sendError(res, 503, 'feedback_unavailable');
    },
    async latestMetadata() {
      return { state: 'empty' };
    },
  };
}
