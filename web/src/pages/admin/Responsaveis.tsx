import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { CreateUserBody, searchKey, type InviteResult, type UserDTO } from '@creche/shared';
import { createUser, listUsers } from '../../api/endpoints';
import { AdminShell } from '../../components/AppShell';
import { Avatar } from '../../components/Avatar';
import { Banner } from '../../components/Banner';
import { Button } from '../../components/Button';
import { SimpleCheckbox } from '../../components/CheckboxRow';
import { EmptyState } from '../../components/EmptyState';
import { InviteSheet } from '../../components/InviteSheet';
import { Modal } from '../../components/Modal';
import { QueryState } from '../../components/QueryState';
import { TextField } from '../../components/TextField';
import { useToast } from '../../components/Toast';
import { useConfig } from '../../config/ConfigProvider';
import { emptyToNull, issuesFromError, formError, validateWith, type FieldErrors } from '../../lib/form';
import { useAsync } from '../../lib/useAsync';
import { LogoutButton } from '../LogoutButton';

/** Badges for a guardian account (spec §7: "sem contato", "sem acesso"). */
export function guardianBadges(u: UserDTO): { label: string; cls: string }[] {
  const out: { label: string; cls: string }[] = [];
  if (!u.active) out.push({ label: 'inativo', cls: 'badge' });
  if (u.anonymizedAt) out.push({ label: 'anonimizado', cls: 'badge badge--danger' });
  if (!u.email && !u.login) out.push({ label: 'sem contato', cls: 'badge badge--danger' });
  else if (!u.hasAccess) out.push({ label: 'sem acesso', cls: 'badge badge--warn' });
  return out;
}

export function ResponsaveisPage() {
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [includeInactive, setIncludeInactive] = useState(false);
  const [creating, setCreating] = useState(false);
  const [invite, setInvite] = useState<{ result: InviteResult; name: string } | null>(null);
  const users = useAsync(() => listUsers({ role: 'guardian', includeInactive }), [includeInactive]);

  const filtered = useMemo(() => {
    const key = searchKey(q);
    return (users.data ?? [])
      .filter((u) => !key || searchKey(u.name).includes(key) || (u.email ?? '').toLowerCase().includes(key) || (u.phone ?? '').includes(q.trim()))
      .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  }, [users.data, q]);

  return (
    <AdminShell
      title="Responsáveis"
      headerActions={
        <>
          <Button variant="primary" size="sm" icon="＋" onClick={() => setCreating(true)} data-testid="guardian-new">
            Novo responsável
          </Button>
          <LogoutButton />
        </>
      }
    >
      <div className="stack">
        <TextField label="Buscar" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Nome, e-mail ou telefone" autoComplete="off" data-testid="guardians-search" />
        <SimpleCheckbox checked={includeInactive} onChange={setIncludeInactive} label="Mostrar inativos" />
        <QueryState loading={users.loading} error={users.error} onRetry={users.reload} hasData={users.data !== null}>
          <p className="small muted">{filtered.length} responsável(is)</p>
          {filtered.length === 0 ? <EmptyState icon="👪" title="Nenhum responsável encontrado" /> : null}
          <div className="list" data-testid="guardians-list">
            {filtered.map((u) => (
              <Link key={u.id} to={`/admin/responsaveis/${u.id}`} className="list-item" data-testid={`guardian-row-${u.id}`}>
                <Avatar name={u.name} photoUrl={u.photoUrl} size="md" noPhotoBadge />
                <span className="list-item__body">
                  <span className="list-item__title">{u.name}</span>
                  <span className="list-item__sub">
                    {u.email ?? 'sem e-mail'}
                    {u.phone ? ` · ${u.phone}` : ''}
                  </span>
                  <span className="row">
                    {guardianBadges(u).map((b) => (
                      <span key={b.label} className={b.cls}>
                        {b.label}
                      </span>
                    ))}
                  </span>
                </span>
              </Link>
            ))}
          </div>
        </QueryState>
      </div>

      <GuardianCreateSheet
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(user, inv) => {
          setCreating(false);
          users.reload();
          if (inv) setInvite({ result: inv, name: user.name });
          else navigate(`/admin/responsaveis/${user.id}`);
        }}
      />
      <InviteSheet
        invite={invite?.result ?? null}
        personName={invite?.name ?? ''}
        onClose={() => {
          setInvite(null);
        }}
      />
    </AdminShell>
  );
}

function GuardianCreateSheet({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (user: UserDTO, invite: InviteResult | null) => void }) {
  const { config } = useConfig();
  const toast = useToast();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [sendInvite, setSendInvite] = useState(true);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setName('');
      setEmail('');
      setPhone('');
      setSendInvite(true);
      setErrors({});
      setError(null);
    }
  }, [open]);

  const submit = async () => {
    const body: CreateUserBody = { name: name.trim(), email: emptyToNull(email), phone: emptyToNull(phone), role: 'guardian', sendInvite: sendInvite && Boolean(emptyToNull(email)) };
    const r = validateWith(CreateUserBody, body);
    if (!r.ok) {
      setErrors(r.errors);
      setError(r.first);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await createUser(r.data);
      toast.show(`${result.user.name} cadastrado(a). Vincule aos filhos na página da criança.`, 'success', 6000);
      onCreated(result.user, result.invite);
    } catch (err) {
      setErrors(issuesFromError(err));
      setError(formError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Novo responsável" sheet dismissible={!busy}>
      <div className="stack">
        <p className="small muted">Depois de cadastrar, vincule a pessoa às crianças na aba “Responsáveis” de cada criança.</p>
        <TextField label="Nome completo" value={name} onChange={(e) => setName(e.target.value)} error={errors.name} required autoComplete="off" />
        <TextField label="E-mail (opcional)" type="email" inputMode="email" autoCapitalize="none" value={email} onChange={(e) => setEmail(e.target.value)} error={errors.email} />
        <TextField label="Telefone celular (opcional)" type="tel" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} error={errors.phone} />
        {emptyToNull(email) && config.emailEnabled ? <SimpleCheckbox checked={sendInvite} onChange={setSendInvite} label="Enviar convite por e-mail agora" /> : null}
        {error ? <Banner kind="danger">{error}</Banner> : null}
        <div className="sheet__actions">
          <Button variant="neutral" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void submit()}>
            Cadastrar
          </Button>
        </div>
      </div>
    </Modal>
  );
}
