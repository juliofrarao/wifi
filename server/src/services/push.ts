/**
 * Web Push wrapper. VAPID keys live in `settings` (seeded on first run from
 * env or generated). `send` returns { ok, gone }: gone (404/410) means the
 * subscription must be deleted. Tests inject `createFakePush()`.
 */
import webpush from 'web-push';
import type { PushPayload } from '@creche/shared';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import type { PushSubscriptionRow } from '../db/rows.js';
import { getSetting, SETTING_KEYS } from '../db/settings.js';

export interface PushSendResult {
  ok: boolean;
  /** 404/410 from the push service: delete the subscription. */
  gone: boolean;
  statusCode?: number;
  error?: string;
}

export interface PushService {
  enabled(): boolean;
  publicKey(): string | null;
  send(subscription: PushSubscriptionRow, payload: PushPayload): Promise<PushSendResult>;
}

export interface FakePush extends PushService {
  sent: { subscription: PushSubscriptionRow; payload: PushPayload }[];
  /** Endpoints that should answer "gone". */
  goneEndpoints: Set<string>;
  /** Endpoints that should fail transiently. */
  failEndpoints: Set<string>;
}

export function vapidFromSettings(db: Db): { publicKey: string; privateKey: string; subject: string } | null {
  const publicKey = getSetting(db, SETTING_KEYS.vapidPublicKey);
  const privateKey = getSetting(db, SETTING_KEYS.vapidPrivateKey);
  const subject = getSetting(db, SETTING_KEYS.vapidSubject) ?? 'mailto:admin@localhost';
  if (!publicKey || !privateKey) return null;
  return { publicKey, privateKey, subject };
}

export function createPush(db: Db, _config: Config): PushService {
  return {
    enabled: () => vapidFromSettings(db) !== null,
    publicKey: () => vapidFromSettings(db)?.publicKey ?? null,
    async send(subscription, payload) {
      const vapid = vapidFromSettings(db);
      if (!vapid) return { ok: false, gone: false, error: 'Push não configurado (sem chaves VAPID)' };
      try {
        const res = await webpush.sendNotification(
          { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } },
          JSON.stringify(payload),
          { vapidDetails: vapid, TTL: 6 * 3600, urgency: payload.override ? 'high' : 'normal', timeout: 10_000 }
        );
        return { ok: true, gone: false, statusCode: res.statusCode };
      } catch (err) {
        const e = err as { statusCode?: number; message?: string; body?: string };
        const statusCode = typeof e.statusCode === 'number' ? e.statusCode : undefined;
        const gone = statusCode === 404 || statusCode === 410;
        return { ok: false, gone, statusCode, error: (e.message ?? 'erro de push').slice(0, 300) };
      }
    },
  };
}

export function createFakePush(enabled = true): FakePush {
  const fake: FakePush = {
    sent: [],
    goneEndpoints: new Set(),
    failEndpoints: new Set(),
    enabled: () => enabled,
    publicKey: () => (enabled ? 'fake-public-key' : null),
    async send(subscription, payload) {
      if (fake.goneEndpoints.has(subscription.endpoint)) return { ok: false, gone: true, statusCode: 410, error: 'gone' };
      if (fake.failEndpoints.has(subscription.endpoint)) return { ok: false, gone: false, statusCode: 500, error: 'push failed' };
      fake.sent.push({ subscription, payload });
      return { ok: true, gone: false, statusCode: 201 };
    },
  };
  return fake;
}
