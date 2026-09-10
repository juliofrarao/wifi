import { useEffect, useMemo, useState } from 'react';
import { CreateUserBody, ROLE_LABELS, SetPinBody, UpdateUserBody, type Role, type UserDTO } from '@creche/shared';
import { createUser, listUsers, revokeUserSessions, setUserPin, updateUser } from '../../api/endpoints';
import { describeError } from '../../api/client';
import { useAuth } from '../../auth/AuthProvider';
import { AdminShell } from '../../components/AppShell';
import { Avatar } from '../../components/Avatar';
import { Banner } from '../../components/Banner';
import { Button } from '../../components/Button';
import { SimpleCheckbox } from '../../components/CheckboxRow';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { EmptyState } from '../../components/EmptyState';
import { Modal } from '../../components/Modal';
import { QueryState } from '../../components/QueryState';
import { SelectField, TextField } from '../../components/TextField';
import { useToast } from '../../components/Toast';
import { emptyToNull, emptyToUndefined, issuesFromError, formError, validateWith, type FieldErrors } from '../../lib/form';
import { useAsync } from '../../lib/useAsync';
import { LogoutButton } from '../LogoutButton';

type StaffRole = 'guard' | 'admin';

function minPassword(role: Role): number {
  return role === 'admin' ? 12 : 8;
}

export function EquipePage() {
  const toast = useToast();
  const { user: me } = useAuth();
  const [includeInactive, setIncludeInactive] = useState(false);
  const [creating, setCreating] = useState(false);
  const [editFor, setEditFor] = useState<UserDTO | null>(null);
  const [pinFor, setPinFor] = useState<UserDTO | null>(null);
  const [toggleFor, setToggleFor] = useState<UserDTO | null>(null);
  const [sessionsFor, setSessionsFor] = useState<UserDTO | null>(null);
  const staff = useAsync(async () => {
    const [guards, admins] = await Promise.all([listUsers({ role: 'guard', includeInactive }), listUsers({ role: 'admin', includeInactive })]);
    return { guards, admins };
  }, [includeInactive]);

  const rows = useMemo(() => {
    const sort = (a: UserDTO, b: UserDTO) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name, 'pt-BR');
    return { guards: [...(staff.data?.guards ?? [])].sort(sort), admins: [...(staff.data?.admins ?? [])].sort(sort) };
  }, [staff.data]);

  const row = (u: UserDTO) => (
    <div key={u.id} className="list-item" data-testid={`staff-row-${u.id}`}>
      <Avatar name={u.name} photoUrl={u.photoUrl} size="md" />
      <span className="list-item__body">
        <span className="list-item__title">
          {u.name}
          {u.id === me?.id ? <span className="tiny muted"> (você)</span> : null}
        </span>
        <span className="list-item__sub">
          {u.login ? `login ${u.login}` : ''}
          {u.login && u.email ? ' · ' : ''}
          {u.email ?? ''}
          {u.phone ? ` · ${u.phone}` : ''}
        </span>
        <span className="row">
          {!u.active ? <span className="badge">inativo</span> : null}
          {!u.hasAccess ? <span className="badge badge--warn">sem senha</span> : null}
          {u.role === 'guard' ? u.hasPin ? <span className="badge badge--ok">PIN definido</span> : <span className="badge badge--warn">sem PIN</span> : null}
        </span>
      </span>
      <span className="list-item__actions">
        <Button variant="neutral" size="sm" onClick={() => setEditFor(u)}>
          Editar
        </Button>
        {u.role === 'guard' ? (
          <Button variant="neutral" size="sm" onClick={() => setPinFor(u)}>
            PIN
          </Button>
        ) : null}
        <Button variant="ghost" size="sm" onClick={() => setSessionsFor(u)}>
          Encerrar sessões
        </Button>
        {u.id !== me?.id ? (
          <Button variant="ghost" size="sm" onClick={() => setToggleFor(u)}>
            {u.active ? 'Desativar' : 'Reativar'}
          </Button>
        ) : null}
      </span>
    </div>
  );

  return (
    <AdminShell
      title="Equipe"
      headerActions={
        <>
          <Button variant="primary" size="sm" icon="＋" onClick={() => setCreating(true)} data-testid="staff-new">
            Nova conta
          </Button>
          <LogoutButton />
        </>
      }
    >
      <div className="stack">
        <SimpleCheckbox checked={includeInactive} onChange={setIncludeInactive} label="Mostrar contas desativadas" />
        <QueryState loading={staff.loading} error={staff.error} onRetry={staff.reload} hasData={staff.data !== null}>
          <h2 className="section-title">Portaria (vigilantes) — {rows.guards.length}</h2>
          {rows.guards.length === 0 ? <EmptyState icon="🛡️" title="Nenhum vigilante cadastrado" /> : null}
          <div className="list">{rows.guards.map(row)}</div>
          <h2 className="section-title">Administração — {rows.admins.length}</h2>
          <div className="list">{rows.admins.map(row)}</div>
        </QueryState>
      </div>

      <StaffCreateSheet
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={() => {
          setCreating(false);
          staff.reload();
        }}
      />
      <StaffEditSheet
        user={editFor}
        onClose={() => setEditFor(null)}
        onSaved={() => {
          setEditFor(null);
          staff.reload();
        }}
      />
      <PinSheet user={pinFor} onClose={() => setPinFor(null)} onSaved={() => {
        setPinFor(null);
        staff.reload();
      }} />

      <ConfirmDialog
        open={toggleFor !== null}
        title={toggleFor?.active ? 'Desativar conta' : 'Reativar conta'}
        confirmLabel={toggleFor?.active ? 'Desativar' : 'Reativar'}
        variant={toggleFor?.active ? 'danger' : 'primary'}
        onCancel={() => setToggleFor(null)}
        onConfirm={async () => {
          if (!toggleFor) return;
          try {
            await updateUser(toggleFor.id, { active: !toggleFor.active });
            toast.show(toggleFor.active ? 'Conta desativada.' : 'Conta reativada.', 'success');
            setToggleFor(null);
            staff.reload();
          } catch (err) {
            throw new Error(describeError(err));
          }
        }}
      >
        <p>{toggleFor?.active ? `${toggleFor.name} perde o acesso imediatamente (sessões e PIN deixam de valer).` : `${toggleFor?.name} volta a poder entrar.`}</p>
      </ConfirmDialog>

      <ConfirmDialog
        open={sessionsFor !== null}
        title="Encerrar sessões"
        confirmLabel="Encerrar"
        onCancel={() => setSessionsFor(null)}
        onConfirm={async () => {
          if (!sessionsFor) return;
          try {
            await revokeUserSessions(sessionsFor.id);
            toast.show('Sessões encerradas.', 'success');
            setSessionsFor(null);
          } catch (err) {
            throw new Error(describeError(err));
          }
        }}
      >
        <p>{sessionsFor?.name} precisará entrar de novo em todos os aparelhos.</p>
      </ConfirmDialog>
    </AdminShell>
  );
}

function StaffCreateSheet({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const toast = useToast();
  const [role, setRole] = useState<StaffRole>('guard');
  const [name, setName] = useState('');
  const [login, setLogin] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [pin, setPin] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setRole('guard');
      setName('');
      setLogin('');
      setEmail('');
      setPhone('');
      setPassword('');
      setPin('');
      setErrors({});
      setError(null);
    }
  }, [open]);
  const min = minPassword(role);

  const submit = async () => {
    const body: CreateUserBody = {
      role,
      name: name.trim(),
      login: emptyToNull(login),
      email: emptyToNull(email),
      phone: emptyToNull(phone),
      password: emptyToUndefined(password),
      pin: role === 'guard' ? emptyToUndefined(pin) : undefined,
      sendInvite: !password && Boolean(emptyToNull(email)),
    };
    const r = validateWith(CreateUserBody, body);
    if (!r.ok) {
      setErrors(r.errors);
      setError(r.first);
      return;
    }
    if (body.password && body.password.length < min) {
      setErrors({ password: `A senha deve ter pelo menos ${min} caracteres.` });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await createUser(r.data);
      toast.show(`${result.user.name} cadastrado(a)${result.invite ? (result.invite.sent ? ' e convite enviado por e-mail' : '; envie o convite pela página da pessoa') : ''}.`, 'success', 6000);
      onCreated();
    } catch (err) {
      setErrors(issuesFromError(err));
      setError(formError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Nova conta da equipe" sheet dismissible={!busy}>
      <div className="stack">
        <SelectField label="Papel" value={role} onChange={(e) => setRole(e.target.value as StaffRole)}>
          <option value="guard">{ROLE_LABELS.guard} (vigilante)</option>
          <option value="admin">{ROLE_LABELS.admin}</option>
        </SelectField>
        <TextField label="Nome completo" value={name} onChange={(e) => setName(e.target.value)} error={errors.name} required autoComplete="off" />
        <div className="grid-2">
          <TextField label="Login curto" value={login} onChange={(e) => setLogin(e.target.value)} error={errors.login} autoCapitalize="none" autoComplete="off" placeholder="ex.: carlos" hint="Para entrar sem e-mail." />
          <TextField label="E-mail" type="email" inputMode="email" autoCapitalize="none" value={email} onChange={(e) => setEmail(e.target.value)} error={errors.email} />
        </div>
        <TextField label="Telefone (opcional)" type="tel" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} error={errors.phone} />
        <TextField
          label="Senha"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={errors.password}
          autoComplete="new-password"
          hint={`Mínimo ${min} caracteres. Deixe em branco para enviar um convite por e-mail.`}
        />
        {role === 'guard' ? (
          <TextField label="PIN de troca rápida" inputMode="numeric" pattern="\d*" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))} error={errors.pin} hint="4 a 6 dígitos; usado no celular da portaria." />
        ) : null}
        {error ? <Banner kind="danger">{error}</Banner> : null}
        <div className="sheet__actions">
          <Button variant="neutral" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void submit()} data-testid="staff-submit">
            Cadastrar
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function StaffEditSheet({ user, onClose, onSaved }: { user: UserDTO | null; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [login, setLogin] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (user) {
      setName(user.name);
      setLogin(user.login ?? '');
      setEmail(user.email ?? '');
      setPhone(user.phone ?? '');
      setPassword('');
      setErrors({});
      setError(null);
    }
  }, [user]);
  const min = user ? minPassword(user.role) : 8;

  const submit = async () => {
    if (!user) return;
    const body: UpdateUserBody = { name: name.trim(), login: emptyToNull(login), email: emptyToNull(email), phone: emptyToNull(phone), password: emptyToUndefined(password) };
    const r = validateWith(UpdateUserBody, body);
    if (!r.ok) {
      setErrors(r.errors);
      setError(r.first);
      return;
    }
    if (!body.login && !body.email) {
      setErrors({ login: 'Informe login ou e-mail' });
      return;
    }
    if (body.password && body.password.length < min) {
      setErrors({ password: `A senha deve ter pelo menos ${min} caracteres.` });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await updateUser(user.id, r.data);
      toast.show(body.password ? 'Dados salvos. A nova senha encerrou as sessões abertas.' : 'Dados salvos.', 'success');
      onSaved();
    } catch (err) {
      setErrors(issuesFromError(err));
      setError(formError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={user !== null} onClose={onClose} title={user ? `Editar ${user.name}` : ''} sheet dismissible={!busy}>
      <div className="stack">
        <TextField label="Nome completo" value={name} onChange={(e) => setName(e.target.value)} error={errors.name} required autoComplete="off" />
        <div className="grid-2">
          <TextField label="Login curto" value={login} onChange={(e) => setLogin(e.target.value)} error={errors.login} autoCapitalize="none" autoComplete="off" />
          <TextField label="E-mail" type="email" inputMode="email" autoCapitalize="none" value={email} onChange={(e) => setEmail(e.target.value)} error={errors.email} />
        </div>
        <TextField label="Telefone" type="tel" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} error={errors.phone} />
        <TextField label="Nova senha (opcional)" type="password" value={password} onChange={(e) => setPassword(e.target.value)} error={errors.password} autoComplete="new-password" hint={`Mínimo ${min} caracteres. Definir a senha encerra todas as sessões da pessoa.`} />
        {error ? <Banner kind="danger">{error}</Banner> : null}
        <div className="sheet__actions">
          <Button variant="neutral" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void submit()}>
            Salvar
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function PinSheet({ user, onClose, onSaved }: { user: UserDTO | null; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [pin, setPin] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (user) {
      setPin('');
      setConfirm('');
      setError(null);
    }
  }, [user]);
  const submit = async () => {
    if (!user) return;
    const r = validateWith(SetPinBody, { pin });
    if (!r.ok) {
      setError(r.first);
      return;
    }
    if (pin !== confirm) {
      setError('Os PINs não conferem.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await setUserPin(user.id, pin);
      toast.show(`PIN de ${user.name} definido.`, 'success');
      onSaved();
    } catch (err) {
      setError(formError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={user !== null} onClose={onClose} title={user ? `PIN de ${user.name}` : ''} dismissible={!busy}>
      <div className="stack">
        <p className="small muted">4 a 6 dígitos, usados na troca rápida de vigilante no celular da portaria.</p>
        <TextField label="Novo PIN" type="password" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))} autoComplete="off" />
        <TextField label="Repita o PIN" type="password" inputMode="numeric" value={confirm} onChange={(e) => setConfirm(e.target.value.replace(/\D/g, '').slice(0, 6))} autoComplete="off" />
        {error ? <Banner kind="danger">{error}</Banner> : null}
        <div className="sheet__actions">
          <Button variant="neutral" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void submit()} disabled={pin.length < 4}>
            Salvar PIN
          </Button>
        </div>
      </div>
    </Modal>
  );
}
