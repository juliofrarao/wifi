import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { AuthResult, Role, UserDTO } from '@creche/shared';
import { ApiError, AUTH_EXPIRED_EVENT, clearToken, getToken, isApiError, setToken } from '../api/client';
import { getMe, login as loginRequest, logout as logoutRequest } from '../api/endpoints';
import { STORAGE_KEYS, readJson, writeJson } from '../lib/storage';
import { unsubscribePush } from '../lib/push';
import { getQueueCounts, retryNeedsLogin } from '../gate/queue';
import { clearDirectory } from '../gate/directory';

export type AuthStatus = 'loading' | 'anon' | 'authed';

export interface AuthContextValue {
  status: AuthStatus;
  user: UserDTO | null;
  /** POST /auth/login */
  signIn: (identifier: string, password: string) => Promise<UserDTO>;
  /** Adopt a session returned by invite / reset / switch. */
  setSession: (result: AuthResult) => void;
  /** POST /auth/logout (refused with QUEUE_PENDING while the gate queue has pending items). */
  signOut: () => Promise<void>;
  /** Re-validate the session (GET /auth/me). */
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/** Home route for a role (used by redirects). */
export function homeFor(role: Role | null | undefined): string {
  switch (role) {
    case 'guard':
      return '/portaria';
    case 'admin':
      return '/admin';
    case 'guardian':
      return '/inicio';
    default:
      return '/login';
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<UserDTO | null>(() => (getToken() ? readJson<UserDTO>(STORAGE_KEYS.user) : null));
  const [status, setStatus] = useState<AuthStatus>(() => (getToken() ? (user ? 'authed' : 'loading') : 'anon'));

  const adopt = useCallback((next: UserDTO | null) => {
    setUser(next);
    writeJson(STORAGE_KEYS.user, next);
    setStatus(next ? 'authed' : 'anon');
  }, []);

  const refreshUser = useCallback(async () => {
    if (!getToken()) {
      adopt(null);
      return;
    }
    try {
      const { user: me } = await getMe({ timeoutMs: 8000, silent: true });
      adopt(me);
    } catch (err) {
      if (isApiError(err) && err.status === 401) {
        adopt(null);
      } else if (!readJson<UserDTO>(STORAGE_KEYS.user)) {
        // No cached user and the server is unreachable: stay in loading→anon.
        setStatus('anon');
      }
      // Network error with a cached user: keep the session (offline gate).
    }
  }, [adopt]);

  useEffect(() => {
    void refreshUser();
    const onExpired = () => adopt(null);
    window.addEventListener(AUTH_EXPIRED_EVENT, onExpired);
    return () => window.removeEventListener(AUTH_EXPIRED_EVENT, onExpired);
  }, [refreshUser, adopt]);

  const setSession = useCallback(
    (result: AuthResult) => {
      setToken(result.token);
      adopt(result.user);
      // Items parked with needs_login can be sent again.
      void retryNeedsLogin();
    },
    [adopt]
  );

  const signIn = useCallback(
    async (identifier: string, password: string) => {
      const result = await loginRequest({ identifier, password });
      setSession(result);
      return result.user;
    },
    [setSession]
  );

  const signOut = useCallback(async () => {
    const counts = await getQueueCounts();
    if (counts.pending + counts.sending > 0) {
      throw new ApiError(
        'QUEUE_PENDING',
        `Há ${counts.pending + counts.sending} registro(s) aguardando envio. Envie-os antes de sair.`,
        409
      );
    }
    await unsubscribePush();
    try {
      await logoutRequest();
    } catch {
      /* best effort: the session may already be gone */
    }
    clearToken();
    await clearDirectory().catch(() => undefined);
    adopt(null);
  }, [adopt]);

  const value = useMemo<AuthContextValue>(
    () => ({ status, user, signIn, setSession, signOut, refreshUser }),
    [status, user, signIn, setSession, signOut, refreshUser]
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
