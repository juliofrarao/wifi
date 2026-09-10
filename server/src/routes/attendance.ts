/** /api/attendance/* — events batch, void, backfill, today, events query, CSV export. */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { BackfillBody, CreateEventsBody, EventsQuery, VoidEventBody } from '@creche/shared';
import { authOf, requireRole } from '../auth/plugin.js';
import type { Ctx } from '../context.js';
import { eventToDto } from '../dto/events.js';
import { parse, queryBool, queryStr } from '../lib/validate.js';
import { type Actor, backfillEvents, createEvents, eventsCsv, queryEvents, todaySummary, voidEvent } from '../services/attendance.js';

export function registerAttendanceRoutes(api: FastifyInstance, ctx: Ctx): void {
  const gate = requireRole('guard', 'admin');
  const admin = requireRole('admin');
  const attendanceCtx = { db: ctx.db, config: ctx.config, notifier: ctx.notifier, filesSecret: ctx.filesSecret };
  const actorOf = (req: FastifyRequest): Actor => ({ user: authOf(req).user, ip: req.ip ?? null, now: req.now });

  api.post('/attendance/events', { preHandler: gate }, async (req) => {
    const body = parse(CreateEventsBody, req.body);
    return createEvents(attendanceCtx, actorOf(req), body);
  });

  api.post<{ Params: { id: string } }>('/attendance/events/:id/void', { preHandler: gate }, async (req) => {
    const body = parse(VoidEventBody, req.body);
    const row = voidEvent(attendanceCtx, actorOf(req), req.params.id, body.reason);
    return eventToDto(row, { admin: authOf(req).user.role === 'admin' });
  });

  api.post('/attendance/backfill', { preHandler: admin }, async (req) => {
    const body = parse(BackfillBody, req.body);
    return backfillEvents(attendanceCtx, actorOf(req), body);
  });

  api.get('/attendance/today', { preHandler: gate }, async (req) => todaySummary(attendanceCtx, req.now, authOf(req).user.role === 'admin'));

  api.get<{ Querystring: Record<string, string | undefined> }>('/attendance/events', { preHandler: requireRole('guard', 'admin', 'guardian') }, async (req) => {
    // z.coerce.boolean() would turn "false" into true; normalize first.
    const raw: Record<string, unknown> = { ...req.query };
    for (const k of Object.keys(raw)) if (raw[k] === '') delete raw[k];
    raw.includeVoided = queryBool(req.query.includeVoided);
    const query = parse(EventsQuery, raw);
    return queryEvents(attendanceCtx, actorOf(req), query);
  });

  api.get<{ Querystring: { from?: string; to?: string; childId?: string } }>('/attendance/events.csv', { preHandler: admin }, async (req, reply) => {
    const { csv, filename } = eventsCsv(attendanceCtx, req.now, { from: queryStr(req.query.from), to: queryStr(req.query.to), childId: queryStr(req.query.childId) });
    reply.header('Content-Disposition', `attachment; filename="${filename}"`);
    reply.header('Cache-Control', 'no-store');
    reply.type('text/csv; charset=utf-8');
    return reply.send(csv);
  });
}
