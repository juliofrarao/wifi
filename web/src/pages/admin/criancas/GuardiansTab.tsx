import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { ChildGuardianBody, CreateGuardianForChildBody, relationshipLabel, type ChildAdminDTO, type GuardianLinkAdmin, type InviteResult, type UserDTO } from '@creche/shared';
import { createGuardianForChild, listUsers, putChildGuardian, removeChildGuardian } from '../../../api/endpoints';
import { describeError } from '../../../api/client';
import { Avatar } from '../../../components/Avatar';
import { Banner } from '../../../components/Banner';
import { Button } from '../../../components/Button';
import { SimpleCheckbox } from '../../../components/CheckboxRow';
import { ConfirmDialog } from '../../../components/ConfirmDialog';
import { EmptyState } from '../../../components/EmptyState';
import { InviteSheet } from '../../../components/InviteSheet';
import { Modal } from '../../../components/Modal';
import { Spinner } from '../../../components/Spinner';
import { TextField } from '../../../components/TextField';
import { useToast } from '../../../components/Toast';
import { useConfig } from '../../../config/ConfigProvider';
import { useFormat } from '../../../lib/format';
import { emptyToNull, issuesFromError, formError, validateWith, type FieldErrors } from '../../../lib/form';
import { DEFAULT_LINK, LinkFields, linkBody, type LinkValues } from './LinkFields';

const REACHABLE_LABEL: Record<GuardianLinkAdmin['reachable'], { label: string; cls: string }> = {
  push: { label: 'push', cls: 'badge badge--ok' },
  email: { label: 'e-mail', cls: 'badge badge--ok' },
  inapp: { label: 'só no app', cls: 'badge badge--warn' },
  none: { label: 'sem contato', cls: 'badge badge--danger' },
};

function valuesFromLink(g: GuardianLinkAdmin): LinkValues {
  return {
    relationship: g.relationship,
    canPickup: g.canPickup,
    isPrimary: g.isPrimary,
    validFrom: g.validFrom ?? '',
    validUntil: g.validUntil ?? '',
    blocked: g.blocked,
    blockedReason: g.blockedReason ?? '',
  };
}

/** Responsáveis tab: list, edit link, add existing, add new (with invite), remove. */
export function GuardiansTab({ child, onChanged }: { child: ChildAdminDTO; onChanged: (c: ChildAdminDTO) => void }) {
  const fmt = useFormat();
  const toast = useToast();
  const today = fmt.today();
  const [editFor, setEditFor] = useState<GuardianLinkAdmin | null>(null);
  const [removeFor, setRemoveFor] = useState<GuardianLinkAdmin | null>(null);
  const [addExisting, setAddExisting] = useState(false);
  const [addNew, setAddNew] = useState(false);
  const [invite, setInvite] = useState<{ result: InviteResult; name: string } | null>(null);

  return (
    <div className="stack">
      <div className="row">
        <Button variant="primary" icon="＋" onClick={() => setAddNew(true)} data-testid="guardian-add-new">
          Novo responsável
        </Button>
        <Button variant="neutral" icon="🔎" onClick={() => setAddExisting(true)} data-testid="guardian-add-existing">
          Vincular responsável já cadastrado
        </Button>
      </div>
      {child.guardians.length === 0 ? <EmptyState icon="👪" title="Nenhum responsável vinculado">Sem responsável alcançável ninguém recebe os alertas de saída.</EmptyState> : null}
      <div className="list">
        {child.guardians.map((g) => {
          const reach = REACHABLE_LABEL[g.reachable];
          return (
            <div key={g.id} className={`list-item${g.blocked ? ' list-item--danger' : ''}`} data-testid={`guardian-link-${g.id}`}>
              <Avatar name={g.name} photoUrl={g.photoUrl} size="md" noPhotoBadge />
              <span className="list-item__body">
                <span className="list-item__title">
                  <Link to={`/admin/responsaveis/${g.id}`}>{g.name}</Link>
                </span>
                <span className="list-item__sub">
                  {g.relationshipLabel || relationshipLabel(g.relationship)}
                  {g.email ? ` · ${g.email}` : ''}
                  {g.phone ? ` · ${g.phone}` : ''}
                  {g.validFrom || g.validUntil ? ` · validade ${g.validFrom ? `de ${fmt.civil(g.validFrom)}` : ''} ${g.validUntil ? `até ${fmt.civil(g.validUntil)}` : ''}` : ''}
                </span>
                <span className="row">
                  {g.blocked ? <span className="badge badge--danger">BLOQUEADO{g.blockedReason ? `: ${g.blockedReason}` : ''}</span> : null}
                  {g.isPrimary ? <span className="badge badge--info">principal</span> : null}
                  {!g.blocked ? (
                    g.pickupAllowedNow ? (
                      <span className="badge badge--ok">pode retirar</span>
                    ) : (
                      <span className="badge badge--warn">{g.canPickup ? (g.validFrom && g.validFrom > today ? 'ainda não vale' : 'vencido') : 'não retira'}</span>
                    )
                  ) : null}
                  <span className={reach.cls}>{reach.label}</span>
                  {!g.hasAccess ? <span className="badge">sem acesso ao app</span> : null}
                </span>
              </span>
              <span className="list-item__actions">
                <Button variant="neutral" size="sm" onClick={() => setEditFor(g)}>
                  Editar vínculo
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setRemoveFor(g)}>
                  Remover
                </Button>
              </span>
            </div>
          );
        })}
      </div>

      <LinkEditSheet
        open={editFor !== null}
        title={editFor ? `Vínculo de ${editFor.name}` : ''}
        initial={editFor ? valuesFromLink(editFor) : DEFAULT_LINK}
        onClose={() => setEditFor(null)}
        onSubmit={async (body) => {
          if (!editFor) return;
          const updated = await putChildGuardian(child.id, editFor.id, body);
          onChanged(updated);
          toast.show('Vínculo atualizado.', 'success');
          setEditFor(null);
        }}
      />

      <ConfirmDialog
        open={removeFor !== null}
        title="Remover responsável"
        confirmLabel="Remover"
        onCancel={() => setRemoveFor(null)}
        onConfirm={async () => {
          if (!removeFor) return;
          try {
            const updated = await removeChildGuardian(child.id, removeFor.id);
            onChanged(updated);
            toast.show('Vínculo removido.', 'success');
            setRemoveFor(null);
          } catch (err) {
            throw new Error(describeError(err));
          }
        }}
      >
        <p>
          {removeFor?.name} deixa de ver {child.name} no app, de receber alertas e de poder retirá-la. O histórico é mantido. A conta da pessoa não é apagada.
        </p>
      </ConfirmDialog>

      <AddExistingSheet
        open={addExisting}
        child={child}
        onClose={() => setAddExisting(false)}
        onLinked={(updated) => {
          onChanged(updated);
          setAddExisting(false);
        }}
      />

      <AddNewSheet
        open={addNew}
        child={child}
        onClose={() => setAddNew(false)}
        onCreated={(updated, guardian, inv) => {
          onChanged(updated);
          setAddNew(false);
          if (inv) setInvite({ result: inv, name: guardian.name });
          else toast.show(`${guardian.name} cadastrado(a) (só portaria: sem e-mail para convite).`, 'success', 5000);
        }}
      />

      <InviteSheet invite={invite?.result ?? null} personName={invite?.name ?? ''} onClose={() => setInvite(null)} />
    </div>
  );
}

function LinkEditSheet({ open, title, initial, onClose, onSubmit }: { open: boolean; title: string; initial: LinkValues; onClose: () => void; onSubmit: (body: ChildGuardianBody) => Promise<void> }) {
  const [v, setV] = useState<LinkValues>(initial);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setV(initial);
      setErrors({});
      setError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const submit = async () => {
    const r = validateWith(ChildGuardianBody, linkBody(v));
    if (!r.ok) {
      setErrors(r.errors);
      setError(r.first);
      return;
    }
    if (r.data.validFrom && r.data.validUntil && r.data.validUntil < r.data.validFrom) {
      setErrors({ validUntil: 'Validade final antes da inicial' });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit(r.data);
    } catch (err) {
      setErrors(issuesFromError(err));
      setError(formError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={open} onClose={onClose} title={title} sheet dismissible={!busy}>
      <div className="stack">
        <LinkFields value={v} onChange={setV} errors={errors} />
        {error ? <Banner kind="danger">{error}</Banner> : null}
        <div className="sheet__actions">
          <Button variant="neutral" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void submit()} data-testid="link-submit">
            Salvar
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function AddExistingSheet({ open, child, onClose, onLinked }: { open: boolean; child: ChildAdminDTO; onClose: () => void; onLinked: (c: ChildAdminDTO) => void }) {
  const toast = useToast();
  const [q, setQ] = useState('');
  const [results, setResults] = useState<UserDTO[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [picked, setPicked] = useState<UserDTO | null>(null);
  useEffect(() => {
    if (!open) {
      setQ('');
      setResults(null);
      setPicked(null);
      return;
    }
  }, [open]);
  useEffect(() => {
    if (!open || q.trim().length < 2) {
      setResults(null);
      return;
    }
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const users = await listUsers({ role: 'guardian', q: q.trim() });
        setResults(users.filter((u) => !child.guardians.some((g) => g.id === u.id)));
      } catch (err) {
        toast.show(describeError(err), 'danger');
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [q, open, child.guardians, toast]);

  if (picked) {
    return (
      <LinkEditSheet
        open={open}
        title={`Vincular ${picked.name} a ${child.name}`}
        initial={DEFAULT_LINK}
        onClose={() => setPicked(null)}
        onSubmit={async (body) => {
          const updated = await putChildGuardian(child.id, picked.id, body);
          toast.show(`${picked.name} vinculado(a).`, 'success');
          onLinked(updated);
        }}
      />
    );
  }
  return (
    <Modal open={open} onClose={onClose} title="Vincular responsável já cadastrado" sheet>
      <div className="stack">
        <TextField label="Buscar por nome, e-mail ou telefone" type="search" value={q} onChange={(e) => setQ(e.target.value)} autoFocus autoComplete="off" data-testid="guardian-search" />
        {searching ? <Spinner block label="Buscando…" /> : null}
        {results && results.length === 0 ? <p className="small muted">Ninguém encontrado. Cadastre como novo responsável.</p> : null}
        <div className="list search-results">
          {results?.map((u) => (
            <button key={u.id} type="button" className="list-item" onClick={() => setPicked(u)} data-testid={`guardian-result-${u.id}`}>
              <Avatar name={u.name} photoUrl={u.photoUrl} />
              <span className="list-item__body">
                <span className="list-item__title">{u.name}</span>
                <span className="list-item__sub">
                  {u.email ?? 'sem e-mail'}
                  {u.phone ? ` · ${u.phone}` : ''}
                  {!u.active ? ' · INATIVO' : ''}
                </span>
              </span>
            </button>
          ))}
        </div>
      </div>
    </Modal>
  );
}

function AddNewSheet({
  open,
  child,
  onClose,
  onCreated,
}: {
  open: boolean;
  child: ChildAdminDTO;
  onClose: () => void;
  onCreated: (c: ChildAdminDTO, guardian: UserDTO, invite: InviteResult | null) => void;
}) {
  const { config } = useConfig();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [sendInvite, setSendInvite] = useState(true);
  const [link, setLink] = useState<LinkValues>(DEFAULT_LINK);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setName('');
      setEmail('');
      setPhone('');
      setSendInvite(true);
      setLink(DEFAULT_LINK);
      setErrors({});
      setError(null);
    }
  }, [open]);

  const submit = async () => {
    const body = { ...linkBody(link), name: name.trim(), email: emptyToNull(email), phone: emptyToNull(phone), sendInvite: sendInvite && Boolean(emptyToNull(email)) };
    const r = validateWith(CreateGuardianForChildBody, body);
    if (!r.ok) {
      setErrors(r.errors);
      setError(r.first);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await createGuardianForChild(child.id, r.data);
      onCreated(result.child, result.guardian, result.invite);
    } catch (err) {
      setErrors(issuesFromError(err));
      setError(formError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={`Novo responsável de ${child.name}`} sheet dismissible={!busy}>
      <div className="stack">
        <TextField label="Nome completo" value={name} onChange={(e) => setName(e.target.value)} error={errors.name} required autoComplete="off" data-testid="new-guardian-name" />
        <TextField label="E-mail (opcional)" type="email" inputMode="email" autoCapitalize="none" value={email} onChange={(e) => setEmail(e.target.value)} error={errors.email} hint="Sem e-mail e sem telefone = só reconhecido na portaria." />
        <TextField label="Telefone celular (opcional)" type="tel" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} error={errors.phone} hint="Permite enviar o convite por WhatsApp." />
        {emptyToNull(email) && config.emailEnabled ? <SimpleCheckbox checked={sendInvite} onChange={setSendInvite} label="Enviar convite por e-mail agora" /> : null}
        <LinkFields value={link} onChange={setLink} errors={errors} />
        {error ? <Banner kind="danger">{error}</Banner> : null}
        <div className="sheet__actions">
          <Button variant="neutral" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void submit()} data-testid="new-guardian-submit">
            Cadastrar e vincular
          </Button>
        </div>
      </div>
    </Modal>
  );
}
