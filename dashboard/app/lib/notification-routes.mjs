// Notification routes over notifications.mjs:
//   GET  /api/notifications                    -> 200 { open, items } as the
//                                                 snapshot carries them
//   POST /api/notifications/:id/acknowledge    bodyless -> 200 { ok: true,
//                                                 acknowledged: 0 | 1 }; 0 when
//                                                 it was already acknowledged
//   POST /api/notifications/acknowledge        bodyless, every open one ->
//                                                 200 { ok: true, acknowledged: n }
// Refusals: 503 shutting_down on a POST during shutdown, 404
// no_such_notification for an id the store no longer keeps, 500
// notification_write_failed (logged as notification_write_error). An id in
// the path that is not NOTIFICATION_ID leaves the route unmatched (404).
//
// createNotificationRoutes({ notifications, log, shuttingDown }) returns
// match(pathname) -> route | null in the shape app.mjs routes on
// ({ name: 'notification', methods, bodyless, label, params: { id, action } })
// and serve(req, res, route). The router has already checked the method and
// Origin before serve() runs.

import { HttpError, sendJson } from './http.mjs';
import { NOTIFICATION_ID, NotificationError } from './notifications.mjs';

const PREFIX = '/api/notifications';

export function createNotificationRoutes({ notifications, log = () => {}, shuttingDown }) {
  function match(pathname) {
    if (pathname === PREFIX) return { name: 'notification', methods: ['GET'], label: PREFIX, params: { id: null, action: 'list' } };
    if (pathname === `${PREFIX}/acknowledge`) {
      return { name: 'notification', methods: ['POST'], bodyless: true, label: `${PREFIX}/acknowledge`, params: { id: null, action: 'all' } };
    }
    if (!pathname.startsWith(`${PREFIX}/`)) return null;
    const [id, action, ...rest] = pathname.slice(PREFIX.length + 1).split('/');
    if (!NOTIFICATION_ID.test(id) || action !== 'acknowledge' || rest.length !== 0) return null;
    return { name: 'notification', methods: ['POST'], bodyless: true, label: `${PREFIX}/:id/acknowledge`, params: { id, action: 'one' } };
  }

  function refusal(error) {
    if (error instanceof NotificationError && error.code === 'no_such_notification') return new HttpError(404, error.code);
    log({ event: 'notification_write_error', error: error?.message ?? String(error) });
    return new HttpError(500, 'notification_write_failed');
  }

  async function serve(req, res, route) {
    const { id, action } = route.params;
    if (action === 'list') return sendJson(res, 200, notifications.view());
    if (shuttingDown()) throw new HttpError(503, 'shutting_down');
    let acknowledged;
    try {
      acknowledged = action === 'all' ? await notifications.acknowledgeAll() : await notifications.acknowledge([id]);
    } catch (error) {
      throw refusal(error);
    }
    return sendJson(res, 200, { ok: true, acknowledged });
  }

  return { match, serve };
}
