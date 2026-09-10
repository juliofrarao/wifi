import { api, getToken } from '../api/client';
import { getConfig } from '../api/endpoints';
import { STORAGE_KEYS, readJson } from './storage';

/** Web Push helpers (used by logout here and by the guardian settings page in W2). */

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** True when the browser subscription was created for this VAPID public key (PUSH-2). */
export function subscriptionMatchesKey(sub: PushSubscription, vapidPublicKey: string): boolean {
  const key = sub.options?.applicationServerKey;
  if (!key) return true; // cannot tell: keep it
  const expected = urlBase64ToUint8Array(vapidPublicKey);
  const actual = new Uint8Array(key);
  if (actual.length !== expected.length) return false;
  for (let i = 0; i < actual.length; i++) if (actual[i] !== expected[i]) return false;
  return true;
}

async function registerOnServer(sub: PushSubscription): Promise<{ id: string }> {
  const json = sub.toJSON();
  return api<{ id: string }>('/me/push-subscriptions', {
    method: 'POST',
    body: {
      endpoint: sub.endpoint,
      keys: { p256dh: json.keys?.p256dh ?? '', auth: json.keys?.auth ?? '' },
      expirationTime: sub.expirationTime ?? null,
    },
    timeoutMs: 8000,
  });
}

/**
 * Self-healing registration (PUSH-1): the server forgets subscriptions when a session ends
 * (90-day cap, password change, admin revocation) and browsers rotate endpoints. Whenever the
 * app has a session and the browser holds a subscription, re-register it (idempotent upsert).
 * Returns 'on' when the browser subscription is registered, 'off' otherwise.
 */
export async function syncPushSubscription(vapidPublicKey?: string | null): Promise<'on' | 'off'> {
  try {
    if (!getToken()) return 'off';
    const role = readJson<{ role?: string }>(STORAGE_KEYS.user)?.role;
    if (role !== 'guardian' && role !== 'admin') return 'off';
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return 'off';
    if (Notification.permission !== 'granted') return 'off';
    const reg = await navigator.serviceWorker.getRegistration('/');
    if (!reg) return 'off';
    let sub = await reg.pushManager.getSubscription();
    if (!sub) return 'off';
    let key = vapidPublicKey;
    if (key === undefined) key = (await getConfig({ timeoutMs: 5000 })).vapidPublicKey;
    if (key && !subscriptionMatchesKey(sub, key)) {
      // Server keys changed (new database, restore): the old subscription can never be delivered.
      await sub.unsubscribe().catch(() => undefined);
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(key) as BufferSource });
    }
    await registerOnServer(sub);
    return 'on';
  } catch {
    return 'off';
  }
}

export async function getPushSubscription(): Promise<PushSubscription | null> {
  try {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return null;
    const reg = await navigator.serviceWorker.getRegistration('/');
    if (!reg) return null;
    return await reg.pushManager.getSubscription();
  } catch {
    return null;
  }
}

/** Requests permission, subscribes and registers the subscription on the server. */
export async function subscribePush(vapidPublicKey: string): Promise<{ id: string }> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    throw new Error('Este navegador não suporta notificações push.');
  }
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Permissão de notificações negada.');
  const reg = (await navigator.serviceWorker.getRegistration('/')) ?? (await navigator.serviceWorker.ready);
  let sub = await reg.pushManager.getSubscription();
  if (sub && !subscriptionMatchesKey(sub, vapidPublicKey)) {
    await sub.unsubscribe().catch(() => undefined);
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(vapidPublicKey) as BufferSource,
  });
  return registerOnServer(sub);
}

/** Unsubscribes locally and on the server (best effort, never throws). */
export async function unsubscribePush(): Promise<void> {
  const sub = await getPushSubscription();
  if (!sub) return;
  try {
    await api('/me/push-subscriptions/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint }, timeoutMs: 4000 });
  } catch {
    /* best effort */
  }
  try {
    await sub.unsubscribe();
  } catch {
    /* ignore */
  }
}
