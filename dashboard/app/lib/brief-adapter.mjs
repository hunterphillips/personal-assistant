// Daily Brief routes. The filesystem reader (briefs.mjs) and the feedback
// writer (feedback.mjs) are kept in separate modules so their boundaries can
// be tested without sockets. app.mjs depends only on the contract below.
//
// createBriefRoutes(config) returns:
//
//   handleLatest(req, res)
//     GET /api/brief/latest. The newest brief as the overlay renders it:
//     { state: 'ready', date, revision, title, words, opening, sections }, or
//     { state, date, error } when the newest date's data is missing
//     ('missing', a viewer with no brief-<date>.json) or unusable, or
//     { state: 'empty' } when the briefs directory holds no brief. A briefs
//     directory that cannot be read is a 503 brief_directory_unavailable.
//
//   handleBrief(req, res, { date })
//     GET /api/brief/<date>. The same body for one date; a date with no data
//     is { state: 'missing', date, error: 'brief_not_found' }. app.mjs has
//     validated `date` as a real YYYY-MM-DD calendar date.
//
//   handleFeedbackRead(req, res, { date })
//     GET /api/brief/<date>/feedback. The feedback saved for that date
//     ({ date, revision, overall, items, savedAt }), or an empty draft with
//     revision and savedAt null when nothing is saved.
//
//   handleFeedback(req, res, body)
//     POST /api/brief/feedback. app.mjs has checked Origin and JSON content
//     type, enforced config.limits.feedbackBodyBytes, and parsed the JSON;
//     `body` is the parsed value (any JSON type, still unvalidated). The body
//     names the revision it was marked against and carries every item of it.
//
//   latestMetadata({ signal }) -> Promise<{ state, date?, revision? }>
//     Used by the hub for the snapshot's `brief`, which copies only `state`
//     (lowercase word), `date`, and `revision`. Must never include brief
//     content. An unreadable briefs directory resolves { state: 'unavailable' };
//     unexpected errors may still reject.
//
// Handlers may throw HttpError (http.mjs) before writing; app.mjs converts it
// to a JSON error.

import path from 'node:path';

import { BriefArtifactError, loadBrief, selectLatestBrief } from './briefs.mjs';
import {
  FeedbackError,
  createFeedbackWriter,
  createKeyedQueue,
  renderFeedbackMarkdown,
  savedFeedbackRecord,
  validateFeedbackForArtifact,
  validateFeedbackRequest,
} from './feedback.mjs';
import { HttpError, sendJson } from './http.mjs';

// Failures reading the briefs directory itself. They are errors, not empty
// states, but they are expected operating conditions and get a controlled reply.
const DIRECTORY_UNAVAILABLE_CODES = new Set(['ENOENT', 'ENOTDIR', 'EACCES', 'ELOOP']);

export function createBriefRoutes(config, { now = () => new Date() } = {}) {
  const briefsDir = path.resolve(config.briefsDir);
  const writer = createFeedbackWriter(briefsDir);
  const serializeByDate = createKeyedQueue();

  // { state: 'ready', ...brief } or { state, date, error } for one date.
  async function readDate(date, { signal } = {}) {
    try {
      const brief = await loadBrief(briefsDir, date, { signal });
      return {
        state: 'ready', date: brief.date, revision: brief.revision, title: brief.title, words: brief.words,
        opening: brief.opening, sections: brief.sections,
      };
    } catch (error) {
      if (!(error instanceof BriefArtifactError)) throw error;
      const state = error.code === 'brief_not_found' ? 'missing' : error.state;
      const body = { state, date, error: error.code };
      if (error.revision) body.revision = error.revision;
      return body;
    }
  }

  async function readLatest({ signal } = {}) {
    let selected;
    try {
      selected = await selectLatestBrief(briefsDir, { signal });
    } catch (error) {
      if (DIRECTORY_UNAVAILABLE_CODES.has(error?.code)) throw new DirectoryUnavailableError(error);
      throw error;
    }
    if (!selected) return { state: 'empty' };
    if (!selected.hasData) return { state: 'missing', date: selected.date, error: 'brief_not_found' };
    return readDate(selected.date, { signal });
  }

  async function latestMetadata(options) {
    let body;
    try {
      body = await readLatest(options);
    } catch (error) {
      if (error instanceof DirectoryUnavailableError) return { state: 'unavailable' };
      throw error;
    }
    const metadata = { state: body.state };
    if (body.date) metadata.date = body.date;
    if (body.revision) metadata.revision = body.revision;
    return metadata;
  }

  return {
    async handleLatest(_req, res) {
      let body;
      try {
        body = await readLatest();
      } catch (error) {
        if (error instanceof DirectoryUnavailableError) throw new HttpError(503, 'brief_directory_unavailable');
        throw error;
      }
      sendJson(res, 200, body);
    },
    async handleBrief(_req, res, { date }) {
      sendJson(res, 200, await readDate(date));
    },
    async handleFeedbackRead(_req, res, { date }) {
      let saved;
      try {
        saved = await writer.read(date);
      } catch (error) {
        throw feedbackHttpError(error);
      }
      sendJson(res, 200, saved ?? { date, revision: null, overall: '', items: [], savedAt: null });
    },
    async handleFeedback(_req, res, body) {
      let feedback;
      try {
        feedback = validateFeedbackRequest(body);
      } catch (error) {
        throw feedbackHttpError(error);
      }
      let record;
      await serializeByDate(feedback.date, async () => {
        try {
          const brief = await loadBrief(briefsDir, feedback.date, { expectedRevision: feedback.revision });
          validateFeedbackForArtifact(feedback, brief);
          record = savedFeedbackRecord(feedback, now().toISOString());
          await writer.save(feedback.date, renderFeedbackMarkdown(brief, feedback), record);
        } catch (error) {
          if (error instanceof BriefArtifactError) throw artifactHttpError(error);
          if (error instanceof FeedbackError) throw feedbackHttpError(error);
          throw error;
        }
      });
      sendJson(res, 200, { saved: true, date: feedback.date, savedAt: record.savedAt });
    },
    latestMetadata,
  };
}

class DirectoryUnavailableError extends Error {
  constructor(cause) {
    super('brief_directory_unavailable', { cause });
    this.name = 'DirectoryUnavailableError';
  }
}

function artifactHttpError(error) {
  if (!(error instanceof BriefArtifactError)) return error;
  if (error.code === 'brief_not_found') return new HttpError(404, 'brief_not_found');
  if (error.code === 'revision_conflict') return new HttpError(409, 'revision_conflict');
  // 413 would describe the request; an oversized brief is a server-side
  // artifact problem, so it is reported like other unusable artifacts.
  if (error.state === 'oversized') return new HttpError(409, 'brief_oversized');
  return new HttpError(409, 'brief_unavailable');
}

function feedbackHttpError(error) {
  if (!(error instanceof FeedbackError)) return error;
  return new HttpError(error.status, error.code);
}
