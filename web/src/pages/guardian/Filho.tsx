import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';
import { relationshipLabel, type AttendanceEventDTO, type MyChildDTO, type PickupAuthorizationDTO } from '@creche/shared';
import { getChild, listEvents, listPickupAuthorizations, revokePickupAuthorization } from '../../api/endpoints';
import { describeError } from '../../api/client';
import { useAuth } from '../../auth/AuthProvider';
import { GuardianShell } from '../../components/AppShell';
import { AuthorizationSheet, authorizationBadge } from '../../components/AuthorizationForm';
import { Avatar } from '../../components/Avatar';
import { Banner } from '../../components/Banner';
import { Button } from '../../components/Button';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { EmptyState } from '../../components/EmptyState';
import { EventRow } from '../../components/EventRow';
import { QueryState } from '../../components/QueryState';
import { SimpleCheckbox } from '../../components/CheckboxRow';
import { Tabs } from '../../components/Tabs';
import { useToast } from '../../components/Toast';
import { useFormat } from '../../lib/format';
import { useAsync } from '../../lib/useAsync';
import { LogoutButton } from '../LogoutButton';
import { childStatusText } from './statusText';

const PAGE = 50;
type Tab = 'historico' | 'pessoas';

export function FilhoPage() {
  const { id = '' } = useParams();
  const fmt = useFormat();
  const toast = useToast();
  const { user } = useAuth();
  const child = useAsync(() => getChild<MyChildDTO>(id), [id]);
  const [tab, setTab] = useState<Tab>('historico');
  const [includeVoided, setIncludeVoided] = useState(false);
  const [offset, setOffset] = useState(0);
  const [extra, setExtra] = useState<AttendanceEventDTO[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const events = useAsync(async () => {
    setExtra([]);
    setOffset(0);
    return listEvents({ childId: id, includeVoided: includeVoided || undefined, limit: PAGE, offset: 0 });
  }, [id, includeVoided]);
  const auths = useAsync(() => listPickupAuthorizations(id, true), [id]);
  const [authOpen, setAuthOpen] = useState(false);
  const [revokeFor, setRevokeFor] = useState<PickupAuthorizationDTO | null>(null);

  const allEvents = useMemo(() => [...(events.data?.items ?? []), ...extra], [events.data, extra]);
  const total = events.data?.total ?? 0;
  const today = fmt.today();

  const loadMore = async () => {
    const next = offset + PAGE;
    setLoadingMore(true);
    try {
      const page = await listEvents({ childId: id, includeVoided: includeVoided || undefined, limit: PAGE, offset: next });
      setExtra((prev) => [...prev, ...page.items]);
      setOffset(next);
    } catch (err) {
      toast.show(describeError(err), 'danger');
    } finally {
      setLoadingMore(false);
    }
  };

  const status = child.data ? childStatusText(child.data as MyChildDTO & { deactivatedAt?: string | null }, fmt) : null;
  const sortedAuths = useMemo(
    () =>
      [...(auths.data ?? [])].sort((a, b) => {
        const av = a.revokedAt ? 3 : a.validNow ? 0 : a.validFrom > today ? 1 : 2;
        const bv = b.revokedAt ? 3 : b.validNow ? 0 : b.validFrom > today ? 1 : 2;
        return av - bv || b.validFrom.localeCompare(a.validFrom);
      }),
    [auths.data, today]
  );

  return (
    <GuardianShell
      title={child.data?.name ?? 'Filho'}
      headerActions={
        <>
          <Link to="/inicio" className="btn btn--ghost btn--sm">
            ‹ Início
          </Link>
          <LogoutButton />
        </>
      }
    >
      <QueryState loading={child.loading} error={child.error} onRetry={child.reload} hasData={child.data !== null}>
        {child.data ? (
          <div className="stack">
            <div className="card row">
              <Avatar name={child.data.name} photoUrl={child.data.photoUrl} size="lg" />
              <div className="grow">
                <div className="big-text">{child.data.name}</div>
                <div className="small muted">
                  {child.data.className ?? 'Sem turma'}
                  {child.data.birthDate ? ` · nascimento ${fmt.civil(child.data.birthDate)}` : ''}
                </div>
                <div className={`child-card__status ${status?.tone === 'present' ? 'child-card__status--present' : status?.tone === 'stale' ? 'child-card__status--stale' : ''}`.trim()}>{status?.text}</div>
              </div>
            </div>

            <Tabs<Tab>
              items={[
                { key: 'historico', label: 'Histórico', badge: total || undefined },
                { key: 'pessoas', label: 'Quem pode buscar' },
              ]}
              value={tab}
              onChange={setTab}
            />

            {tab === 'historico' ? (
              <div className="stack">
                <SimpleCheckbox checked={includeVoided} onChange={setIncludeVoided} label="Mostrar registros cancelados" />
                <QueryState loading={events.loading} error={events.error} onRetry={events.reload} hasData={events.data !== null}>
                  {allEvents.length === 0 ? <EmptyState icon="🗓️" title="Nenhum registro ainda" /> : null}
                  <div className="list" data-testid="child-history">
                    {allEvents.map((ev) => (
                      <EventRow key={ev.id} event={ev} showChild={false} testId={`child-event-${ev.id}`} />
                    ))}
                  </div>
                  {allEvents.length < total ? (
                    <Button variant="neutral" onClick={() => void loadMore()} loading={loadingMore}>
                      Carregar mais ({total - allEvents.length} restantes)
                    </Button>
                  ) : null}
                </QueryState>
              </div>
            ) : (
              <div className="stack">
                <h2 className="section-title">Responsáveis</h2>
                <div className="list">
                  {child.data.guardians.map((g) => (
                    <div key={g.id} className="list-item">
                      <span className="list-item__body">
                        <span className="list-item__title">
                          {g.name}
                          {g.id === user?.id ? <span className="tiny muted"> (você)</span> : null}
                        </span>
                        <span className="list-item__sub">
                          {g.relationshipLabel || relationshipLabel(g.relationship)}
                          {g.validUntil ? ` · até ${fmt.civil(g.validUntil)}` : ''}
                          {g.validFrom && g.validFrom > today ? ` · a partir de ${fmt.civil(g.validFrom)}` : ''}
                        </span>
                      </span>
                      <span className="list-item__actions">
                        {g.isPrimary ? <span className="badge badge--info">principal</span> : null}
                        {g.pickupAllowedNow ? <span className="badge badge--ok">pode retirar</span> : <span className="badge badge--warn">não retira</span>}
                      </span>
                    </div>
                  ))}
                </div>

                <div className="row row--between">
                  <h2 className="section-title">Autorizações avulsas</h2>
                  {child.data.active && child.data.myCanPickup ? (
                    <Button variant="primary" size="sm" icon="🤝" onClick={() => setAuthOpen(true)}>
                      Autorizar alguém
                    </Button>
                  ) : null}
                </div>
                {!child.data.myCanPickup ? <p className="tiny muted">Só responsáveis autorizados a retirar podem registrar autorizações avulsas.</p> : null}
                <QueryState loading={auths.loading} error={auths.error} onRetry={auths.reload} hasData={auths.data !== null}>
                  {sortedAuths.length === 0 ? <EmptyState icon="🤝" title="Nenhuma autorização avulsa" /> : null}
                  <div className="list">
                    {sortedAuths.map((a) => {
                      const badge = authorizationBadge(a, today);
                      const mine = a.createdBy.id === user?.id;
                      return (
                        <div key={a.id} className="list-item" data-testid={`authorization-${a.id}`}>
                          <span className="list-item__body">
                            <span className="list-item__title">{a.personName}</span>
                            <span className="list-item__sub">
                              {a.relationshipLabel}
                              {a.phone ? ` · ${a.phone}` : ''} · {a.validFrom === a.validUntil ? fmt.civil(a.validFrom) : `${fmt.civil(a.validFrom)} a ${fmt.civil(a.validUntil)}`} · por{' '}
                              {a.createdBy.name}
                              {a.createdBy.relationshipLabel ? ` (${a.createdBy.relationshipLabel.toLowerCase()})` : ''}
                            </span>
                            {a.note ? <span className="tiny muted">{a.note}</span> : null}
                          </span>
                          <span className="list-item__actions">
                            <span className={badge.cls}>{badge.label}</span>
                            {mine && !a.revokedAt && a.validUntil >= today ? (
                              <Button variant="ghost" size="sm" onClick={() => setRevokeFor(a)}>
                                Revogar
                              </Button>
                            ) : null}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </QueryState>
              </div>
            )}
          </div>
        ) : null}
      </QueryState>

      {child.data ? (
        <AuthorizationSheet
          open={authOpen}
          onClose={() => setAuthOpen(false)}
          childOptions={[{ id: child.data.id, name: child.data.name }]}
          initialChildId={child.data.id}
          onCreated={(auth) => {
            setAuthOpen(false);
            toast.show(`${auth.personName} autorizada até ${fmt.civil(auth.validUntil)}.`, 'success', 5000);
            auths.reload();
            child.reload();
          }}
        />
      ) : null}

      <ConfirmDialog
        open={revokeFor !== null}
        title="Revogar autorização"
        confirmLabel="Revogar"
        onCancel={() => setRevokeFor(null)}
        onConfirm={async () => {
          if (!revokeFor) return;
          try {
            await revokePickupAuthorization(id, revokeFor.id);
            toast.show('Autorização revogada.', 'success');
            setRevokeFor(null);
            auths.reload();
            child.reload();
          } catch (err) {
            throw new Error(describeError(err));
          }
        }}
      >
        <p>
          {revokeFor?.personName} deixará de poder buscar {child.data?.name}.
        </p>
      </ConfirmDialog>
      {child.error && !child.data ? <Banner kind="info">Só é possível ver os próprios filhos.</Banner> : null}
    </GuardianShell>
  );
}
