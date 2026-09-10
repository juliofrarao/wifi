/** /api/reports/* — daily and monthly frequency reports (admin). */
import type { FastifyInstance } from 'fastify';
import { todayCivil } from '@creche/shared';
import { requireRole } from '../auth/plugin.js';
import type { Ctx } from '../context.js';
import { queryStr } from '../lib/validate.js';
import { dailyReport, frequencyCsv, frequencyReport } from '../services/reports.js';

export function registerReportRoutes(api: FastifyInstance, ctx: Ctx): void {
  const admin = requireRole('admin');
  const reportCtx = { db: ctx.db, config: ctx.config };

  api.get<{ Querystring: { date?: string } }>('/reports/daily', { preHandler: admin }, async (req) => {
    const date = queryStr(req.query.date) ?? todayCivil(ctx.config.tz, req.now);
    return dailyReport(reportCtx, date, req.now);
  });

  api.get<{ Querystring: { month?: string; className?: string; format?: string } }>('/reports/frequency', { preHandler: admin }, async (req, reply) => {
    const month = queryStr(req.query.month) ?? todayCivil(ctx.config.tz, req.now).slice(0, 7);
    const report = frequencyReport(reportCtx, month, queryStr(req.query.className), req.now);
    if (queryStr(req.query.format)?.toLowerCase() === 'csv') {
      reply.header('Content-Disposition', `attachment; filename="frequencia-${month}.csv"`);
      reply.header('Cache-Control', 'no-store');
      reply.type('text/csv; charset=utf-8');
      return reply.send(frequencyCsv(report));
    }
    return report;
  });
}
