/** /api/scan/* — directory (ETag/304), card lookup, manual lookup, heartbeat. Guard and admin. */
import type { FastifyInstance } from 'fastify';
import { HeartbeatBody, ManualLookupBody, ScanLookupBody } from '@creche/shared';
import { authOf, requireRole } from '../auth/plugin.js';
import type { Ctx } from '../context.js';
import { parse } from '../lib/validate.js';
import { buildDirectory, directoryEtag, lookupByCard, lookupManual, recordHeartbeat } from '../services/scan.js';

function etagMatches(header: string | string[] | undefined, etag: string): boolean {
  if (!header) return false;
  const raw = Array.isArray(header) ? header.join(',') : header;
  return raw
    .split(',')
    .map((s) => s.trim().replace(/^W\//, ''))
    .some((s) => s === etag || s === '*');
}

export function registerScanRoutes(api: FastifyInstance, ctx: Ctx): void {
  const gate = requireRole('guard', 'admin');
  const scanCtx = { db: ctx.db, config: ctx.config, filesSecret: ctx.filesSecret };

  api.get('/scan/directory', { preHandler: gate }, async (req, reply) => {
    const etag = directoryEtag(ctx.db, ctx.config, req.now);
    reply.header('ETag', etag);
    reply.header('Cache-Control', 'private, no-cache');
    if (etagMatches(req.headers['if-none-match'], etag)) return reply.code(304).send();
    return buildDirectory(scanCtx, req.now);
  });

  api.post('/scan/lookup', { preHandler: gate }, async (req) => {
    const body = parse(ScanLookupBody, req.body);
    return lookupByCard(scanCtx, authOf(req).session, body, req.now);
  });

  api.post('/scan/manual', { preHandler: gate }, async (req) => {
    const body = parse(ManualLookupBody, req.body);
    return lookupManual(scanCtx, authOf(req).session, body, req.now);
  });

  api.post('/scan/heartbeat', { preHandler: gate }, async (req, reply) => {
    const body = parse(HeartbeatBody, req.body);
    recordHeartbeat(ctx.db, authOf(req).session, body, req.now);
    return reply.code(204).send();
  });
}
