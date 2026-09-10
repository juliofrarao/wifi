import type { ReactNode } from 'react';
import { Banner } from './Banner';
import { Button } from './Button';
import { Spinner } from './Spinner';

/**
 * Renders a spinner while loading (and nothing is cached), an error banner
 * with retry when the load failed, otherwise the children.
 */
export function QueryState({
  loading,
  error,
  onRetry,
  hasData = false,
  label = 'Carregando…',
  children,
}: {
  loading: boolean;
  error: string | null;
  onRetry?: () => void;
  /** When true, children render even while reloading (stale-while-revalidate). */
  hasData?: boolean;
  label?: string;
  children: ReactNode;
}) {
  if (error && !hasData) {
    return (
      <Banner
        kind="danger"
        actions={
          onRetry ? (
            <Button variant="neutral" size="sm" onClick={onRetry}>
              Tentar de novo
            </Button>
          ) : null
        }
      >
        {error}
      </Banner>
    );
  }
  if (loading && !hasData) return <Spinner block label={label} />;
  return (
    <>
      {error ? (
        <Banner kind="warn" className="banner--compact">
          Não foi possível atualizar: {error}
        </Banner>
      ) : null}
      {children}
    </>
  );
}
