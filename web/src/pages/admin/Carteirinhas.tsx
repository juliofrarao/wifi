import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { searchKey, type ChildAdminDTO, type CredentialDTO, type OwnerType } from '@creche/shared';
import { classNames } from '../../admin/childFilters';
import { bulkCredentials, listChildren, listCredentials } from '../../api/endpoints';
import { AdminShell } from '../../components/AppShell';
import { Banner } from '../../components/Banner';
import { Button } from '../../components/Button';
import { SimpleCheckbox } from '../../components/CheckboxRow';
import { CredentialList } from '../../components/CredentialList';
import { Modal } from '../../components/Modal';
import { QueryState } from '../../components/QueryState';
import { SelectField, TextField } from '../../components/TextField';
import { useToast } from '../../components/Toast';
import { formError } from '../../lib/form';
import { useAsync } from '../../lib/useAsync';
import { LogoutButton } from '../LogoutButton';

export function CarteirinhasPage() {
  const toast = useToast();
  const [ownerType, setOwnerType] = useState<OwnerType | ''>('');
  const [className, setClassName] = useState('');
  const [includeRevoked, setIncludeRevoked] = useState(false);
  const [q, setQ] = useState('');
  const [nfcOnly, setNfcOnly] = useState<'' | 'with' | 'without'>('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [withPhoto, setWithPhoto] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const credentials = useAsync(() => listCredentials({ ownerType: ownerType || undefined, className: className || undefined, includeRevoked }), [ownerType, className, includeRevoked]);
  const children = useAsync(() => listChildren<ChildAdminDTO>({}), []);
  const classes = useMemo(() => classNames(children.data ?? []), [children.data]);

  const filtered = useMemo(() => {
    const key = searchKey(q);
    const code = q.replace(/[^a-z0-9]/gi, '').toUpperCase();
    return (credentials.data ?? [])
      .filter((c) => (nfcOnly === 'with' ? Boolean(c.nfcUid) : nfcOnly === 'without' ? !c.nfcUid : true))
      .filter((c) => !key || searchKey(c.ownerName).includes(key) || (code.length >= 2 && (c.code ?? '').includes(code)) || (c.nfcUid ?? '').includes(key))
      .sort((a, b) => Number(b.active) - Number(a.active) || a.ownerName.localeCompare(b.ownerName, 'pt-BR'));
  }, [credentials.data, q, nfcOnly]);

  useEffect(() => {
    // Drop selections that no longer exist.
    setSelected((prev) => new Set([...prev].filter((id) => (credentials.data ?? []).some((c) => c.id === id && c.active))));
  }, [credentials.data]);

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const selectAll = () => setSelected(new Set(filtered.filter((c) => c.active && c.code).map((c) => c.id)));
  const printUrl = `/admin/carteirinhas/imprimir?ids=${[...selected].map(encodeURIComponent).join(',')}${withPhoto ? '&photo=1' : ''}`;

  return (
    <AdminShell
      title="Carteirinhas"
      headerActions={
        <>
          <Button variant="primary" size="sm" icon="🪪" onClick={() => setBulkOpen(true)} data-testid="credentials-bulk">
            Gerar em lote
          </Button>
          <LogoutButton />
        </>
      }
    >
      <div className="stack">
        <p className="small muted">
          Uma carteirinha por pessoa (responsável) ou por criança. Gere, imprima em lote (10 por folha A4), cole a etiqueta NFC opcional e revogue as perdidas. Carteirinhas de responsáveis
          são geradas na página de cada responsável ou aqui em lote.
        </p>
        <div className="filters">
          <TextField label="Buscar" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Nome ou código" autoComplete="off" />
          <SelectField label="Dono" value={ownerType} onChange={(e) => setOwnerType(e.target.value as OwnerType | '')}>
            <option value="">Todos</option>
            <option value="child">Crianças</option>
            <option value="guardian">Responsáveis</option>
          </SelectField>
          <SelectField label="Turma" value={className} onChange={(e) => setClassName(e.target.value)}>
            <option value="">Todas</option>
            {classes.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </SelectField>
          <SelectField label="NFC" value={nfcOnly} onChange={(e) => setNfcOnly(e.target.value as '' | 'with' | 'without')}>
            <option value="">Todas</option>
            <option value="with">Com etiqueta</option>
            <option value="without">Sem etiqueta</option>
          </SelectField>
        </div>
        <SimpleCheckbox checked={includeRevoked} onChange={setIncludeRevoked} label="Mostrar revogadas" />

        <div className="card stack stack--sm sticky-actions">
          <div className="row row--between">
            <span className="small">
              <strong>{selected.size}</strong> selecionada(s)
            </span>
            <span className="row">
              <Button variant="ghost" size="sm" onClick={selectAll}>
                Selecionar todas ({filtered.filter((c) => c.active && c.code).length})
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())} disabled={selected.size === 0}>
                Limpar
              </Button>
            </span>
          </div>
          <div className="row">
            <SimpleCheckbox checked={withPhoto} onChange={setWithPhoto} label="Imprimir com foto" />
            {selected.size > 0 ? (
              <Link className="btn btn--primary" to={printUrl} data-testid="credentials-print">
                Imprimir selecionadas
              </Link>
            ) : (
              <span className="btn btn--primary" aria-disabled="true">
                Imprimir selecionadas
              </span>
            )}
            {className ? (
              <Link className="btn btn--neutral" to={`/admin/carteirinhas/imprimir?className=${encodeURIComponent(className)}${withPhoto ? '&photo=1' : ''}`}>
                Imprimir turma {className}
              </Link>
            ) : null}
          </div>
        </div>

        <QueryState loading={credentials.loading} error={credentials.error} onRetry={credentials.reload} hasData={credentials.data !== null}>
          <p className="small muted">{filtered.length} carteirinha(s)</p>
          <CredentialList credentials={filtered} onChanged={credentials.reload} showOwner selectable={{ selected, toggle }} />
        </QueryState>
      </div>

      <BulkSheet
        open={bulkOpen}
        classes={classes}
        onClose={() => setBulkOpen(false)}
        onCreated={(created) => {
          setBulkOpen(false);
          credentials.reload();
          setSelected(new Set(created.map((c) => c.id)));
          toast.show(created.length === 0 ? 'Ninguém sem carteirinha: nada foi gerado.' : `${created.length} carteirinha(s) gerada(s) e selecionada(s) para impressão.`, 'success', 6000);
        }}
      />
    </AdminShell>
  );
}

function BulkSheet({ open, classes, onClose, onCreated }: { open: boolean; classes: string[]; onClose: () => void; onCreated: (created: CredentialDTO[]) => void }) {
  const [ownerType, setOwnerType] = useState<OwnerType>('child');
  const [className, setClassName] = useState('');
  const [onlyWithout, setOnlyWithout] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setError(null);
      setBusy(false);
    }
  }, [open]);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await bulkCredentials({ ownerType, className: className || undefined, onlyWithout });
      onCreated(result.created);
    } catch (err) {
      setError(formError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={open} onClose={onClose} title="Gerar carteirinhas em lote" dismissible={!busy}>
      <div className="stack">
        <SelectField label="Para quem" value={ownerType} onChange={(e) => setOwnerType(e.target.value as OwnerType)}>
          <option value="child">Crianças</option>
          <option value="guardian">Responsáveis (das crianças da turma)</option>
        </SelectField>
        <SelectField label="Turma" value={className} onChange={(e) => setClassName(e.target.value)}>
          <option value="">Todas as turmas</option>
          {classes.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </SelectField>
        <SimpleCheckbox checked={onlyWithout} onChange={setOnlyWithout} label="Só quem ainda não tem carteirinha ativa" />
        {!onlyWithout ? <Banner kind="warn">Todos receberão uma carteirinha adicional (as antigas continuam válidas).</Banner> : null}
        {error ? <Banner kind="danger">{error}</Banner> : null}
        <div className="sheet__actions">
          <Button variant="neutral" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void submit()}>
            Gerar
          </Button>
        </div>
      </div>
    </Modal>
  );
}

