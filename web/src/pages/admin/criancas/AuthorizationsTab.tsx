import { useMemo, useState } from 'react';
import type { ChildAdminDTO, PickupAuthorizationDTO } from '@creche/shared';
import { listPickupAuthorizations, revokePickupAuthorization } from '../../../api/endpoints';
import { describeError } from '../../../api/client';
import { AuthorizationSheet, authorizationBadge } from '../../../components/AuthorizationForm';
import { Button } from '../../../components/Button';
import { ConfirmDialog } from '../../../components/ConfirmDialog';
import { EmptyState } from '../../../components/EmptyState';
import { QueryState } from '../../../components/QueryState';
import { useToast } from '../../../components/Toast';
import { useFormat } from '../../../lib/format';
import { useAsync } from '../../../lib/useAsync';

/** Autorizações avulsas tab (admin sees documents, all history, can revoke any). */
export function AuthorizationsTab({ child, onChanged }: { child: ChildAdminDTO; onChanged: () => void }) {
  const fmt = useFormat();
  const toast = useToast();
  const today = fmt.today();
  const auths = useAsync(() => listPickupAuthorizations(child.id, true), [child.id]);
  const [open, setOpen] = useState(false);
  const [revokeFor, setRevokeFor] = useState<PickupAuthorizationDTO | null>(null);

  const sorted = useMemo(
    () =>
      [...(auths.data ?? [])].sort((a, b) => {
        const rank = (x: PickupAuthorizationDTO) => (x.revokedAt ? 3 : x.validNow ? 0 : x.validFrom > today ? 1 : 2);
        return rank(a) - rank(b) || b.validFrom.localeCompare(a.validFrom);
      }),
    [auths.data, today]
  );

  return (
    <div className="stack">
      <div className="row">
        <Button variant="primary" icon="🤝" onClick={() => setOpen(true)} disabled={!child.active} data-testid="authorization-new">
          Nova autorização avulsa
        </Button>
      </div>
      <QueryState loading={auths.loading} error={auths.error} onRetry={auths.reload} hasData={auths.data !== null}>
        {sorted.length === 0 ? <EmptyState icon="🤝" title="Nenhuma autorização avulsa" /> : null}
        <div className="list">
          {sorted.map((a) => {
            const badge = authorizationBadge(a, today);
            return (
              <div key={a.id} className="list-item" data-testid={`authorization-${a.id}`}>
                <span className="list-item__body">
                  <span className="list-item__title">{a.personName}</span>
                  <span className="list-item__sub">
                    {a.relationshipLabel}
                    {a.personDocument ? ` · doc. ${a.personDocument}` : ''}
                    {a.phone ? ` · ${a.phone}` : ''} · {a.validFrom === a.validUntil ? fmt.civil(a.validFrom) : `${fmt.civil(a.validFrom)} a ${fmt.civil(a.validUntil)}`} · criada por{' '}
                    {a.createdBy.name}
                    {a.createdBy.relationshipLabel ? ` (${a.createdBy.relationshipLabel.toLowerCase()})` : ''} em {fmt.dateTime(a.createdAt)}
                  </span>
                  {a.note ? <span className="tiny muted">{a.note}</span> : null}
                  {a.revokedAt ? <span className="tiny muted">revogada em {fmt.dateTime(a.revokedAt)}</span> : null}
                </span>
                <span className="list-item__actions">
                  <span className={badge.cls}>{badge.label}</span>
                  {!a.revokedAt && a.validUntil >= today ? (
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

      <AuthorizationSheet
        open={open}
        onClose={() => setOpen(false)}
        childOptions={[{ id: child.id, name: child.name }]}
        initialChildId={child.id}
        onCreated={(auth) => {
          setOpen(false);
          toast.show(`${auth.personName} autorizada até ${fmt.civil(auth.validUntil)}.`, 'success');
          auths.reload();
          onChanged();
        }}
      />
      <ConfirmDialog
        open={revokeFor !== null}
        title="Revogar autorização"
        confirmLabel="Revogar"
        onCancel={() => setRevokeFor(null)}
        onConfirm={async () => {
          if (!revokeFor) return;
          try {
            await revokePickupAuthorization(child.id, revokeFor.id);
            toast.show('Autorização revogada.', 'success');
            setRevokeFor(null);
            auths.reload();
            onChanged();
          } catch (err) {
            throw new Error(describeError(err));
          }
        }}
      >
        <p>{revokeFor?.personName} deixará de poder buscar {child.name}.</p>
      </ConfirmDialog>
    </div>
  );
}
