import { useState } from 'react';
import { Link } from 'react-router';
import { formatCode, type CredentialDTO, type OwnerType } from '@creche/shared';
import { createCredential, revokeCredential } from '../api/endpoints';
import { describeError } from '../api/client';
import { useFormat } from '../lib/format';
import { Button } from './Button';
import { ConfirmDialog } from './ConfirmDialog';
import { EmptyState } from './EmptyState';
import { NfcBindSheet } from './NfcBindSheet';
import { useToast } from './Toast';

export interface CredentialOwner {
  type: OwnerType;
  id: string;
  name: string;
}

/**
 * Credential rows with the admin actions (spec §4.7): print, NFC sticker,
 * revoke, "Revogar e gerar nova". With `owner`, a "Gerar carteirinha" button
 * appears. `onChanged` is called after any mutation so the parent reloads.
 */
export function CredentialList({
  credentials,
  owner,
  onChanged,
  showOwner = false,
  allowRevoke = true,
  allowNfc = true,
  selectable,
}: {
  credentials: CredentialDTO[];
  owner?: CredentialOwner;
  onChanged: () => void;
  showOwner?: boolean;
  allowRevoke?: boolean;
  allowNfc?: boolean;
  selectable?: { selected: Set<string>; toggle: (id: string) => void };
}) {
  const fmt = useFormat();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [revokeFor, setRevokeFor] = useState<{ credential: CredentialDTO; regenerate: boolean } | null>(null);
  const [nfcFor, setNfcFor] = useState<CredentialDTO | null>(null);

  const generate = async () => {
    if (!owner) return;
    setBusy('new');
    try {
      const created = await createCredential({ ownerType: owner.type, ownerId: owner.id });
      toast.show(`Carteirinha ${formatCode(created.code ?? '')} gerada.`, 'success');
      onChanged();
    } catch (err) {
      toast.show(describeError(err), 'danger', 5000);
    } finally {
      setBusy(null);
    }
  };

  const active = credentials.filter((c) => c.active);
  const revoked = credentials.filter((c) => !c.active);

  const row = (c: CredentialDTO) => (
    <div key={c.id} className={`list-item${c.active ? '' : ' list-item--voided'}`} data-testid={`credential-${c.id}`}>
      {selectable && c.active ? (
        <input
          type="checkbox"
          className="check-lg"
          checked={selectable.selected.has(c.id)}
          onChange={() => selectable.toggle(c.id)}
          aria-label={`Selecionar carteirinha ${c.code ? formatCode(c.code) : c.id}`}
        />
      ) : null}
      <span className="list-item__body">
        <span className="list-item__title code-text">{c.code ? formatCode(c.code) : 'Só NFC'}</span>
        <span className="list-item__sub">
          {showOwner ? (
            <>
              <Link to={c.ownerType === 'child' ? `/admin/criancas/${c.ownerId}` : `/admin/responsaveis/${c.ownerId}`}>{c.ownerName}</Link>
              {' · '}
              {c.ownerType === 'child' ? `criança${c.ownerClassName ? ` · ${c.ownerClassName}` : ''}` : 'responsável'}
              {' · '}
            </>
          ) : null}
          emitida em {fmt.date(c.createdAt)}
          {c.label ? ` · ${c.label}` : ''}
          {c.revokedAt ? ` · revogada em ${fmt.dateTime(c.revokedAt)}` : ''}
        </span>
        <span className="row">
          {c.nfcUid ? <span className="badge badge--info">NFC {c.nfcUid}</span> : c.active ? <span className="badge">sem NFC</span> : null}
          {!c.active ? <span className="badge badge--danger">revogada</span> : null}
        </span>
      </span>
      {c.active ? (
        <span className="list-item__actions">
          {c.code ? (
            <Link className="btn btn--neutral btn--sm" to={`/admin/carteirinhas/imprimir?ids=${encodeURIComponent(c.id)}`}>
              Imprimir
            </Link>
          ) : null}
          {allowNfc ? (
            <Button variant="neutral" size="sm" onClick={() => setNfcFor(c)}>
              Colar NFC
            </Button>
          ) : null}
          {allowRevoke ? (
            <>
              <Button variant="ghost" size="sm" onClick={() => setRevokeFor({ credential: c, regenerate: false })}>
                Revogar
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setRevokeFor({ credential: c, regenerate: true })}>
                Revogar e gerar nova
              </Button>
            </>
          ) : null}
        </span>
      ) : null}
    </div>
  );

  return (
    <div className="stack">
      {owner ? (
        <div className="row">
          <Button variant="primary" icon="🪪" loading={busy === 'new'} onClick={() => void generate()}>
            Gerar carteirinha
          </Button>
          {active.length > 0 && active.some((c) => c.code) ? (
            <Link className="btn btn--neutral" to={`/admin/carteirinhas/imprimir?ids=${active.map((c) => encodeURIComponent(c.id)).join(',')}`}>
              Imprimir todas
            </Link>
          ) : null}
        </div>
      ) : null}
      {credentials.length === 0 ? <EmptyState icon="🪪" title="Nenhuma carteirinha" /> : null}
      <div className="list">{active.map(row)}</div>
      {revoked.length > 0 ? (
        <details className="details">
          <summary>Revogadas ({revoked.length})</summary>
          <div className="list mt">{revoked.map(row)}</div>
        </details>
      ) : null}

      <ConfirmDialog
        open={revokeFor !== null}
        title={revokeFor?.regenerate ? 'Revogar e gerar nova carteirinha' : 'Revogar carteirinha'}
        confirmLabel={revokeFor?.regenerate ? 'Revogar e gerar nova' : 'Revogar'}
        onCancel={() => setRevokeFor(null)}
        onConfirm={async () => {
          if (!revokeFor) return;
          const { credential, regenerate } = revokeFor;
          try {
            await revokeCredential(credential.id);
            let text = `Carteirinha ${credential.code ? formatCode(credential.code) : ''} revogada.`;
            if (regenerate) {
              const created = await createCredential({ ownerType: credential.ownerType, ownerId: credential.ownerId, label: credential.label ?? undefined });
              text += ` Nova: ${formatCode(created.code ?? '')}.`;
            }
            toast.show(text, 'success', 5000);
            setRevokeFor(null);
            onChanged();
          } catch (err) {
            throw new Error(describeError(err));
          }
        }}
      >
        <p>
          A carteirinha <strong className="code-text">{revokeFor?.credential.code ? formatCode(revokeFor.credential.code) : ''}</strong> de {revokeFor?.credential.ownerName} deixa de funcionar na portaria (código e
          etiqueta NFC). O dono recebe o aviso “carteirinha cancelada”. Nada é apagado.
        </p>
      </ConfirmDialog>

      <NfcBindSheet
        credential={nfcFor}
        onClose={() => setNfcFor(null)}
        onBound={() => {
          onChanged();
        }}
      />
    </div>
  );
}
