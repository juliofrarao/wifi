/** GET /api/public/cards/:code — always 200 with the same body (no enumeration). */
import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../context.js';
import { getSetting, SETTING_KEYS } from '../db/settings.js';

export function registerPublicRoutes(api: FastifyInstance, ctx: Ctx): void {
  api.get<{ Params: { code: string } }>('/public/cards/:code', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store');
    return {
      daycareName: getSetting(ctx.db, SETTING_KEYS.daycareName) ?? ctx.config.daycareName,
      daycarePhone: getSetting(ctx.db, SETTING_KEYS.daycarePhone),
    };
  });
}
