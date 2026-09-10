/** /api/me/notifications — the in-app feed (only `inapp` rows already dispatched) and read marks. */
import type { FastifyInstance } from 'fastify';
import { type AttendanceEventDTO, type NotificationDTO, type NotificationsPage, ReadNotificationsBody } from '@creche/shared';
import { authOf, requireRole } from '../auth/plugin.js';
import type { Ctx } from '../context.js';
import { type Db, all, one, placeholders, run } from '../db/index.js';
import type { EventRow, NotificationRow } from '../db/rows.js';
import { EVENT_ORDER, eventToDto } from '../dto/events.js';
import { parse, queryInt, queryStr } from '../lib/validate.js';

function parseChildIds(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** Events shown with a notification: the batch's events for the recipient's children, or the single event. */
function eventsOf(db: Db, row: NotificationRow, childIds: string[], admin: boolean): AttendanceEventDTO[] {
  let rows: EventRow[] = [];
  if (row.batch_id) {
    rows = childIds.length
      ? all<EventRow>(db, `SELECT * FROM attendance_events WHERE batch_id = ? AND child_id IN (${placeholders(childIds.length)}) ORDER BY ${EVENT_ORDER}`, row.batch_id, ...childIds)
      : all<EventRow>(db, `SELECT * FROM attendance_events WHERE batch_id = ? ORDER BY ${EVENT_ORDER}`, row.batch_id);
  } else if (row.event_id) {
    const e = one<EventRow>(db, 'SELECT * FROM attendance_events WHERE id = ?', row.event_id);
    if (e) rows = [e];
  }
  return rows.map((e) => eventToDto(e, { admin }));
}

export function notificationToDto(db: Db, row: NotificationRow, admin: boolean): NotificationDTO {
  const childIds = parseChildIds(row.child_ids);
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    body: row.body,
    override: row.override === 1,
    batchId: row.batch_id,
    events: eventsOf(db, row, childIds, admin),
    childIds,
    readAt: row.read_at,
    createdAt: row.created_at,
  };
}

export function unreadCount(db: Db, userId: string): number {
  return one<{ n: number }>(db, `SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND channel = 'inapp' AND status = 'sent' AND read_at IS NULL`, userId)?.n ?? 0;
}

export function registerNotificationRoutes(api: FastifyInstance, ctx: Ctx): void {
  const { db } = ctx;
  const feed = requireRole('guardian', 'admin');

  api.get<{ Querystring: { limit?: string; before?: string } }>('/me/notifications', { preHandler: feed }, async (req): Promise<NotificationsPage> => {
    const { user } = authOf(req);
    const limit = queryInt(req.query.limit, 50, 1, 200);
    const before = queryStr(req.query.before);
    const rows = before
      ? all<NotificationRow>(
          db,
          `SELECT * FROM notifications WHERE user_id = ? AND channel = 'inapp' AND status = 'sent' AND created_at < ? ORDER BY created_at DESC, id DESC LIMIT ?`,
          user.id,
          before,
          limit
        )
      : all<NotificationRow>(db, `SELECT * FROM notifications WHERE user_id = ? AND channel = 'inapp' AND status = 'sent' ORDER BY created_at DESC, id DESC LIMIT ?`, user.id, limit);
    const admin = user.role === 'admin';
    let nextBefore: string | null = null;
    if (rows.length === limit) {
      // The cursor is exclusive on created_at: pull in every row sharing the last millisecond so none is skipped.
      const lastAt = rows[rows.length - 1].created_at;
      const seen = new Set(rows.map((r) => r.id));
      const ties = all<NotificationRow>(
        db,
        `SELECT * FROM notifications WHERE user_id = ? AND channel = 'inapp' AND status = 'sent' AND created_at = ? ORDER BY id DESC`,
        user.id,
        lastAt
      ).filter((r) => !seen.has(r.id));
      rows.push(...ties);
      nextBefore = lastAt;
    }
    return {
      items: rows.map((r) => notificationToDto(db, r, admin)),
      unreadCount: unreadCount(db, user.id),
      nextBefore,
    };
  });

  api.post('/me/notifications/read', { preHandler: feed }, async (req) => {
    const body = parse(ReadNotificationsBody, req.body ?? {});
    const { user } = authOf(req);
    const now = req.now.toISOString();
    if (body.ids && body.ids.length > 0) {
      run(
        db,
        `UPDATE notifications SET read_at = ? WHERE user_id = ? AND channel = 'inapp' AND read_at IS NULL AND id IN (${placeholders(body.ids.length)})`,
        now,
        user.id,
        ...body.ids
      );
    } else {
      run(db, `UPDATE notifications SET read_at = ? WHERE user_id = ? AND channel = 'inapp' AND status = 'sent' AND read_at IS NULL`, now, user.id);
    }
    return { unreadCount: unreadCount(db, user.id) };
  });
}
