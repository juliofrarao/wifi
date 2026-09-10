import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { relationshipLabel, type MyChildDTO } from '@creche/shared';
import { getMyChildren, getMyNotifications } from '../../api/endpoints';
import { GuardianShell } from '../../components/AppShell';
import { AuthorizationSheet } from '../../components/AuthorizationForm';
import { Avatar } from '../../components/Avatar';
import { Banner } from '../../components/Banner';
import { Button } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { QueryState } from '../../components/QueryState';
import { useToast } from '../../components/Toast';
import { useConfig } from '../../config/ConfigProvider';
import { useFormat } from '../../lib/format';
import { useAsync } from '../../lib/useAsync';
import { LogoutButton } from '../LogoutButton';
import { AlertsBadge } from './AlertsBadge';
import { childStatusText } from './statusText';

export function InicioPage() {
  const fmt = useFormat();
  const toast = useToast();
  const { config } = useConfig();
  const children = useAsync(() => getMyChildren(), []);
  const alerts = useAsync(() => getMyNotifications({ limit: 1 }), []);
  const [authOpen, setAuthOpen] = useState(false);
  const [authChild, setAuthChild] = useState<string | undefined>(undefined);

  const pickupChildren = useMemo(() => (children.data ?? []).filter((c) => c.active && c.myCanPickup), [children.data]);

  return (
    <GuardianShell
      title="Meus filhos"
      headerActions={
        <>
          <AlertsBadge unread={alerts.data?.unreadCount ?? null} />
          <LogoutButton />
        </>
      }
    >
      <div className="stack">
        {config.demoData ? (
          <Banner kind="warn" className="banner--compact">
            DADOS DE DEMONSTRAÇÃO
          </Banner>
        ) : null}
        <QueryState loading={children.loading} error={children.error} onRetry={children.reload} hasData={children.data !== null}>
          {children.data && children.data.length === 0 ? (
            <EmptyState icon="🧒" title="Nenhuma criança vinculada">
              Fale com a secretaria da creche para vincular seus filhos à sua conta.
            </EmptyState>
          ) : null}
          <div className="stack">
            {children.data?.map((child) => (
              <ChildCard key={child.id} child={child} />
            ))}
          </div>
        </QueryState>
        {pickupChildren.length > 0 ? (
          <Button
            variant="primary"
            size="big"
            icon="🤝"
            onClick={() => {
              setAuthChild(pickupChildren.length === 1 ? pickupChildren[0].id : undefined);
              setAuthOpen(true);
            }}
          >
            Autorizar alguém a buscar hoje
          </Button>
        ) : null}
        <div className="row row--between">
          <Button variant="ghost" size="sm" onClick={() => children.reload()} loading={children.loading && children.data !== null}>
            Atualizar
          </Button>
          <span className="tiny muted">Atualizado {fmt.time(new Date())}</span>
        </div>
      </div>

      <AuthorizationSheet
        open={authOpen}
        onClose={() => setAuthOpen(false)}
        childOptions={pickupChildren.map((c) => ({ id: c.id, name: c.name }))}
        initialChildId={authChild}
        showDocument
        onCreated={(auth) => {
          setAuthOpen(false);
          toast.show(`${auth.personName} autorizada a buscar até ${fmt.civil(auth.validUntil)}. Os outros responsáveis serão avisados.`, 'success', 6000);
          children.reload();
        }}
      />
    </GuardianShell>
  );
}

function ChildCard({ child }: { child: MyChildDTO }) {
  const fmt = useFormat();
  const status = childStatusText(child as MyChildDTO & { deactivatedAt?: string | null }, fmt);
  const toneCls = status.tone === 'present' ? 'child-card__status--present' : status.tone === 'stale' ? 'child-card__status--stale' : status.tone === 'inactive' ? 'child-card__status--inactive' : '';
  return (
    <Link to={`/filho/${child.id}`} className={`card child-card${child.active ? '' : ' child-card--inactive'}`} data-testid={`child-card-${child.id}`} data-status={status.tone}>
      <Avatar name={child.name} photoUrl={child.photoUrl} size="lg" />
      <span className="grow">
        <span className="child-card__name">{child.name}</span>
        <span className="child-card__meta">
          {child.className ?? 'Sem turma'} · você: {relationshipLabel(child.myRelationship).toLowerCase()}
          {child.myCanPickup ? '' : ' · sem autorização para retirar'}
        </span>
        <span className={`child-card__status ${toneCls}`.trim()}>{status.text}</span>
        {child.active && child.authorizedPersons.length > 0 ? (
          <span className="child-card__meta">Autorizadas hoje: {child.authorizedPersons.map((a) => a.personName).join(', ')}</span>
        ) : null}
      </span>
      <span className="child-card__chevron" aria-hidden="true">
        ›
      </span>
    </Link>
  );
}
