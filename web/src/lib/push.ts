import { api } from '../api/client';

/** Web Push helpers (used by logout here and by the guardian settings page in W2). */

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
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
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidPublicKey) as BufferSource,
    }));
  const json = sub.toJSON();
  return api<{ id: string }>('/me/push-subscriptions', {
    method: 'POST',
    body: {
      endpoint: sub.endpoint,
      keys: { p256dh: json.keys?.p256dh ?? '', auth: json.keys?.auth ?? '' },
      expirationTime: sub.expirationTime ?? null,
    },
  });
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
