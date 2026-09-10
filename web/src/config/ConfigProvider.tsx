import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AppConfig } from '@creche/shared';
import { getConfig } from '../api/endpoints';
import { readJson, writeJson } from '../lib/storage';

const CONFIG_CACHE_KEY = 'creche.config';
const REFRESH_INTERVAL_MS = 30 * 60 * 1000;

export const DEFAULT_CONFIG: AppConfig = {
  daycareName: 'Creche Segura',
  daycarePhone: null,
  timezone: 'America/Sao_Paulo',
  appUrl: typeof location !== 'undefined' ? location.origin : '',
  vapidPublicKey: null,
  emailEnabled: false,
  appVersion: __APP_VERSION__,
  directoryVersion: 0,
  demoData: false,
  notifyHoldSeconds: 45,
  offlineCheckoutMaxAgeHours: 12,
};

export interface ConfigContextValue {
  config: AppConfig;
  /** True once GET /config succeeded at least once in this session. */
  loaded: boolean;
  /** Last fetch failed (cached/default config in use). */
  offline: boolean;
  /** The server serves a newer bundle than the one running. */
  updateAvailable: boolean;
  refresh: () => Promise<void>;
  /** Updates the service worker and reloads the page. */
  applyUpdate: () => Promise<void>;
  /** Called by screens that are idle (Leitura with empty queue): reload when an update is pending. */
  autoReloadIfUpdate: () => void;
}

const ConfigContext = createContext<ConfigContextValue | null>(null);

export function ConfigProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<AppConfig>(() => ({ ...DEFAULT_CONFIG, ...(readJson<Partial<AppConfig>>(CONFIG_CACHE_KEY) ?? {}) }));
  const [loaded, setLoaded] = useState(false);
  const [offline, setOffline] = useState(false);
  const inflight = useRef<Promise<void> | null>(null);

  const refresh = useCallback(async () => {
    if (inflight.current) return inflight.current;
    inflight.current = (async () => {
      try {
        const fresh = await getConfig({ timeoutMs: 8000 });
        setConfig(fresh);
        setLoaded(true);
        setOffline(false);
        writeJson(CONFIG_CACHE_KEY, fresh);
        // Spec §8: registration.update() after GET /config.
        try {
          const reg = await navigator.serviceWorker?.getRegistration('/');
          await reg?.update();
        } catch {
          /* ignore */
        }
      } catch {
        setOffline(true);
      } finally {
        inflight.current = null;
      }
    })();
    return inflight.current;
  }, []);

  useEffect(() => {
    void refresh();
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', onVisibility);
    const timer = setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      clearInterval(timer);
    };
  }, [refresh]);

  const updateAvailable =
    loaded &&
    __APP_VERSION__ !== 'dev' &&
    Boolean(config.appVersion) &&
    config.appVersion !== 'dev' &&
    config.appVersion !== __APP_VERSION__;

  const applyUpdate = useCallback(async () => {
    try {
      const reg = await navigator.serviceWorker?.getRegistration('/');
      await reg?.update();
      reg?.waiting?.postMessage({ type: 'skip-waiting' });
      navigator.serviceWorker?.controller?.postMessage({ type: 'refresh-precache' });
    } catch {
      /* ignore */
    }
    location.reload();
  }, []);

  const autoReloadIfUpdate = useCallback(() => {
    if (updateAvailable) void applyUpdate();
  }, [updateAvailable, applyUpdate]);

  const value = useMemo<ConfigContextValue>(
    () => ({ config, loaded, offline, updateAvailable, refresh, applyUpdate, autoReloadIfUpdate }),
    [config, loaded, offline, updateAvailable, refresh, applyUpdate, autoReloadIfUpdate]
  );
  return <ConfigContext.Provider value={value}>{children}</ConfigContext.Provider>;
}

export function useConfig(): ConfigContextValue {
  const ctx = useContext(ConfigContext);
  if (!ctx) throw new Error('useConfig must be used inside <ConfigProvider>');
  return ctx;
}
