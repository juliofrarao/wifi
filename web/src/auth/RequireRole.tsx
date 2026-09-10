import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import type { Role } from '@creche/shared';
import { homeFor, useAuth } from './AuthProvider';
import { Spinner } from '../components/Spinner';

/**
 * Guards a route by role. Anonymous → /login (remembering where we came from);
 * wrong role → the role's home (guard → /portaria, guardian → /inicio, admin → /admin).
 */
export function RequireRole({ roles, children }: { roles: Role[]; children: ReactNode }) {
  const { status, user } = useAuth();
  const location = useLocation();
  if (status === 'loading') return <Spinner block label="Carregando…" />;
  if (status === 'anon' || !user) {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }
  if (!roles.includes(user.role)) return <Navigate to={homeFor(user.role)} replace />;
  return <>{children}</>;
}

/** "/" → home by role (or /login). */
export function HomeRedirect() {
  const { status, user } = useAuth();
  if (status === 'loading') return <Spinner block label="Carregando…" />;
  return <Navigate to={homeFor(user?.role)} replace />;
}
