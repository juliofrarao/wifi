/** GET /api/config — public AppConfig. */
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '@creche/shared';
import type { Ctx } from '../context.js';
import { getDirectoryVersion, getSetting, getSettingBool, SETTING_KEYS } from '../db/settings.js';

export function appConfigOf(ctx: Ctx): AppConfig {
  const { db, config } = ctx;
  return {
    daycareName: getSetting(db, SETTING_KEYS.daycareName) ?? config.daycareName,
    daycarePhone: getSetting(db, SETTING_KEYS.daycarePhone),
    timezone: config.tz,
    appUrl: config.appUrl,
    vapidPublicKey: ctx.push.publicKey(),
    emailEnabled: ctx.mailer.enabled,
    appVersion: ctx.appVersion,
    directoryVersion: getDirectoryVersion(db),
    demoData: getSettingBool(db, SETTING_KEYS.demoData, false),
    notifyHoldSeconds: config.notifyHoldSeconds,
    offlineCheckoutMaxAgeHours: config.offlineCheckoutMaxAgeHours,
  };
}

export function registerConfigRoutes(api: FastifyInstance, ctx: Ctx): void {
  api.get('/config', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store');
    return appConfigOf(ctx);
  });
}
