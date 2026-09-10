import { useEffect } from 'react';

/**
 * Keeps the screen on while the component is mounted (Screen Wake Lock API).
 * Re-acquires the lock when the page becomes visible again.
 */
export function useWakeLock(enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    if (typeof navigator === 'undefined' || !('wakeLock' in navigator)) return;
    let sentinel: WakeLockSentinel | null = null;
    let released = false;

    const acquire = async () => {
      if (released || document.visibilityState !== 'visible') return;
      try {
        sentinel = await navigator.wakeLock.request('screen');
        sentinel.addEventListener('release', () => {
          sentinel = null;
        });
      } catch {
        sentinel = null; // low battery or unsupported: ignore
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible' && !sentinel) void acquire();
    };
    void acquire();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      released = true;
      document.removeEventListener('visibilitychange', onVisibility);
      void sentinel?.release().catch(() => undefined);
      sentinel = null;
    };
  }, [enabled]);
}
