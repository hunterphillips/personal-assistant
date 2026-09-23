// Daily Brief routes. The filesystem/parser and feedback writer are kept in
// separate modules so their security boundaries can be tested without sockets.
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

import path from 'node:path';

import { BriefArtifactError, loadBriefArtifact, selectLatestBrief } from './briefs.mjs';
import {
  FeedbackError,
  createFeedbackWriter,
  createKeyedQueue,
  renderFeedbackMarkdown,
  validateFeedbackForArtifact,
  validateFeedbackRequest,
} from './feedback.mjs';
import { HttpError, buildChildCsp, sendBody, sendJson, setContentSecurityPolicy } from './http.mjs';

export const BRIEF_CSP = buildChildCsp({ inlineScripts: true, inlineStyles: true });

export function createBriefRoutes(config) {
  const briefsDir = path.resolve(config.briefsDir);
  const writer = createFeedbackWriter(briefsDir);
  const serializeByDate = createKeyedQueue();

  async function latestMetadata({ signal } = {}) {
    const selected = await selectLatestBrief(briefsDir, { signal });
    if (!selected) return { state: 'empty' };
    try {
      const artifact = await loadBriefArtifact(briefsDir, selected.date, { signal });
      return { state: 'ready', date: artifact.date, revision: artifact.revision };
    } catch (error) {
      if (!(error instanceof BriefArtifactError)) throw error;
      const metadata = { state: error.state, date: selected.date };
      if (error.revision) metadata.revision = error.revision;
      return metadata;
    }
  }

  return {
    async handleLatest(_req, res) {
      const metadata = await latestMetadata();
      const response = { ...metadata };
      if (metadata.state === 'ready') {
        response.url = `/embedded/brief/${metadata.date}?revision=${metadata.revision}`;
      }
      sendJson(res, 200, response);
    },
    async handleEmbedded(_req, res, { date, revision }) {
      let artifact;
      try {
        artifact = await loadBriefArtifact(briefsDir, date, { expectedRevision: revision });
      } catch (error) {
        throw artifactHttpError(error);
      }
      const adapted = adaptViewer(artifact);
      setContentSecurityPolicy(res, BRIEF_CSP);
      sendBody(res, 200, 'text/html; charset=utf-8', adapted);
    },
    async handleFeedback(_req, res, body) {
      let feedback;
      try {
        feedback = validateFeedbackRequest(body);
      } catch (error) {
        throw feedbackHttpError(error);
      }
      await serializeByDate(feedback.date, async () => {
        let artifact;
        try {
          artifact = await loadBriefArtifact(briefsDir, feedback.date, { expectedRevision: feedback.revision });
          validateFeedbackForArtifact(feedback, artifact);
          await writer.save(feedback.date, renderFeedbackMarkdown(artifact, feedback));
        } catch (error) {
          if (error instanceof BriefArtifactError) throw artifactHttpError(error);
          if (error instanceof FeedbackError) throw feedbackHttpError(error);
          throw error;
        }
      });
      sendJson(res, 200, { saved: true, date: feedback.date });
    },
    latestMetadata,
  };
}

export function adaptViewer(artifact) {
  const config = JSON.stringify({ date: artifact.date, revision: artifact.revision }).replaceAll('<', '\\u003c');
  const addition = `\n<script id="brief-bridge-config" type="application/json">${config}</script>\n` +
    '<script src="/assets/brief-bridge.js"></script>';
  return Buffer.concat([
    artifact.bytes.subarray(0, artifact.scriptEndByte),
    Buffer.from(addition),
    artifact.bytes.subarray(artifact.scriptEndByte),
  ]);
}

function artifactHttpError(error) {
  if (!(error instanceof BriefArtifactError)) return error;
  if (error.code === 'brief_not_found') return new HttpError(404, 'brief_not_found');
  if (error.code === 'revision_conflict') return new HttpError(409, 'revision_conflict');
  // 413 would describe the request; an oversized viewer is a server-side
  // artifact problem, so it is reported like other unusable artifacts.
  if (error.state === 'oversized') return new HttpError(409, 'brief_oversized');
  return new HttpError(409, 'brief_unavailable');
}

function feedbackHttpError(error) {
  if (!(error instanceof FeedbackError)) return error;
  return new HttpError(error.status, error.code);
}
