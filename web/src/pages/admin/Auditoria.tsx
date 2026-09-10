import { useMemo, useState } from 'react';
import type { AuditEntry } from '@creche/shared';
import { getAudit } from '../../api/endpoints';
import { describeError } from '../../api/client';
import { AdminShell } from '../../components/AppShell';
import { Button } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { QueryState } from '../../components/QueryState';
import { TextField } from '../../components/TextField';
import { useToast } from '../../components/Toast';
import { useFormat } from '../../lib/format';
import { useAsync } from '../../lib/useAsync';
import { LogoutButton } from '../LogoutButton';

const PAGE = 100;

function detailsText(details: unknown): string {
  if (details === null || details === undefined) return '';
  if (typeof details === 'string') return details;
  try {
    return JSON.stringify(details);
  } catch {
    return String(details);
  }
}

/** Audit log (R18) with cursor pagination and a client-side text filter. */
export function AuditoriaPage() {
  const fmt = useFormat();
  const toast = useToast();
  const [extra, setExtra] = useState<AuditEntry[]>([]);
  const [nextBefore, setNextBefore] = useState<string | null | undefined>(undefined);
  const [more, setMore] = useState(false);
  const [q, setQ] = useState('');
  const first = useAsync(async () => {
    setExtra([]);
    const page = await getAudit({ limit: PAGE });
    setNextBefore(page.nextBefore);
    return page;
  }, []);
  const all = useMemo(() => [...(first.data?.items ?? []), ...extra], [first.data, extra]);
  const filtered = useMemo(() => {
    const key = q.trim().toLowerCase();
    if (!key) return all;
    return all.filter((e) => [e.actorName, e.action, e.entityType, e.entityId, detailsText(e.details), e.ip].some((v) => (v ?? '').toLowerCase().includes(key)));
  }, [all, q]);

  const loadMore = async () => {
    if (!nextBefore) return;
    setMore(true);
    try {
      const page = await getAudit({ limit: PAGE, before: nextBefore });
      setExtra((prev) => [...prev, ...page.items]);
      setNextBefore(page.nextBefore);
    } catch (err) {
      toast.show(describeError(err), 'danger');
    } finally {
      setMore(false);
    }
  };

  return (
    <AdminShell title="Auditoria" headerActions={<LogoutButton />}>
      <div className="stack">
        <p className="small muted">Toda mudança administrativa (cadastros, vínculos, carteirinhas, senhas, configurações, cancelamentos) fica registrada aqui com quem fez, quando e de onde.</p>
        <div className="row row--between">
          <TextField label="Filtrar" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ação, pessoa, entidade…" className="grow" autoComplete="off" />
          <Button variant="neutral" size="sm" onClick={first.reload} loading={first.loading && first.data !== null}>
            Atualizar
          </Button>
        </div>
        <QueryState loading={first.loading} error={first.error} onRetry={first.reload} hasData={first.data !== null}>
          {filtered.length === 0 ? <EmptyState icon="🔍" title="Nenhum registro" /> : null}
          {filtered.length > 0 ? (
            <div className="table-wrap">
              <table className="table audit-table" data-testid="audit-table">
                <thead>
                  <tr>
                    <th>Quando</th>
                    <th>Quem</th>
                    <th>Ação</th>
                    <th>Entidade</th>
                    <th>Detalhes</th>
                    <th>IP</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((e) => (
                    <tr key={e.id}>
                      <td className="nowrap">{fmt.dateTime(e.at)}</td>
                      <td>{e.actorName ?? 'sistema'}</td>
                      <td>
                        <code>{e.action}</code>
                      </td>
                      <td className="small">
                        {e.entityType}
                        {e.entityId ? <span className="tiny muted"> {e.entityId.slice(0, 8)}…</span> : null}
                      </td>
                      <td className="small audit-table__details">
                        <code>{detailsText(e.details)}</code>
                      </td>
                      <td className="tiny muted">{e.ip ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          {nextBefore ? (
            <Button variant="neutral" onClick={() => void loadMore()} loading={more}>
              Carregar mais
            </Button>
          ) : null}
        </QueryState>
      </div>
    </AdminShell>
  );
}
