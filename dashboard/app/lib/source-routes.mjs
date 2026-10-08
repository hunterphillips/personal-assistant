// Source routes over sources.mjs:
//   GET    /api/sources       200 { sources, problems }
//   POST   /api/sources       { name, kind, url | sender | path, active?, default? }
//                             -> 201 { ok: true, source }
//   PUT    /api/sources/:id   any of name, active, default, and the kind's
//                             field -> 200 { ok: true, source }
//   DELETE /api/sources/:id   bodyless -> 200 { ok: true }
//
// Refusals, in this order: 503 shutting_down (writes), 400 invalid_json or
// invalid_body (`detail` names the field), 413 payload_too_large (a body
// over limits.feedBodyBytes), 404 no_such_source, and for DELETE 409 in_use
// ({ feeds }) while a feed lists the source. An id in the path that is not
// a source id is unmatched (404 not_found).
//
// createSourceRoutes({ sources, limits, shuttingDown }) returns
// match(pathname) -> route | null and serve(req, res, route), as
// feed-routes.mjs does. The router has already checked the method, Origin,
// and content type.

import { HttpError, readJsonBody, sendJson } from './http.mjs';
import { SOURCE_ID } from './sources.mjs';

const PREFIX = '/api/sources';

const STORE_STATUS = new Map([
  ['invalid_body', 400],
  ['no_such_source', 404],
  ['in_use', 409],
]);

export function createSourceRoutes({ sources, limits, shuttingDown }) {
  function match(pathname) {
    if (pathname === PREFIX) return { name: 'sources', methods: ['GET', 'POST'], label: PREFIX, params: { id: null } };
    if (!pathname.startsWith(`${PREFIX}/`)) return null;
    const id = pathname.slice(PREFIX.length + 1);
    if (!SOURCE_ID.test(id)) return null;
    return { name: 'sources', methods: ['PUT', 'DELETE'], bodyless: ['DELETE'], label: `${PREFIX}/:id`, params: { id } };
  }

  async function serve(req, res, route) {
    const { id } = route.params;
    try {
      if (req.method === 'GET') return sendJson(res, 200, await sources.read());
      if (shuttingDown()) throw new HttpError(503, 'shutting_down');
      if (req.method === 'DELETE') {
        await sources.remove(id);
        return sendJson(res, 200, { ok: true });
      }
      const body = await readJsonBody(req, { limit: limits.feedBodyBytes });
      if (!isRecord(body)) throw new HttpError(400, 'invalid_body');
      if (req.method === 'POST') return sendJson(res, 201, { ok: true, source: await sources.create(body) });
      return sendJson(res, 200, { ok: true, source: await sources.update(id, body) });
    } catch (error) {
      const status = STORE_STATUS.get(error?.code);
      if (status && !(error instanceof HttpError)) throw new HttpError(status, error.code, error.detail ?? null);
      throw error;
    }
  }

  return { match, serve };
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
