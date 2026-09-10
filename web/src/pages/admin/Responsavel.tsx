import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { UpdateUserBody, relationshipLabel, type InviteResult, type UserDetailDTO } from '@creche/shared';
import { anonymizeUser, getUser, inviteUser, revokeUserSessions, updateUser, uploadUserPhoto } from '../../api/endpoints';
import { describeError } from '../../api/client';
import { AdminShell } from '../../components/AppShell';
import { Avatar } from '../../components/Avatar';
import { Banner } from '../../components/Banner';
import { Button } from '../../components/Button';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { InviteSheet } from '../../components/InviteSheet';
import { OwnerCredentials } from '../../components/OwnerCredentials';
import { PhotoUpload } from '../../components/PhotoUpload';
import { QueryState } from '../../components/QueryState';
import { Tabs } from '../../components/Tabs';
import { TextField } from '../../components/TextField';
import { useToast } from '../../components/Toast';
import { emptyToNull, issuesFromError, formError, validateWith, type FieldErrors } from '../../lib/form';
import { useFormat } from '../../lib/format';
import { useAsync } from '../../lib/useAsync';
import { LogoutButton } from '../LogoutButton';
import { guardianBadges } from './Responsaveis';

type Tab = 'dados' | 'foto' | 'filhos' | 'carteirinhas' | 'acesso';

export function ResponsavelPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const fmt = useFormat();
  const toast = useToast();
  const user = useAsync(() => getUser(id), [id]);
  const [tab, setTab] = useState<Tab>('dados');
  const [invite, setInvite] = useState<InviteResult | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<'deactivate' | 'sessions' | 'anonymize' | null>(null);
  const u = user.data;

  const sendInvite = async () => {
    if (!u) return;
    setBusy('invite');
    try {
      const result = await inviteUser(u.id);
      setInvite(result);
    } catch (err) {
      toast.show(describeError(err), 'danger', 5000);
    } finally {
      setBusy(null);
    }
  };

  return (
    <AdminShell
      title={u?.name ?? 'Responsável'}
      headerActions={
        <>
          <Link to="/admin/responsaveis" className="btn btn--ghost btn--sm">
            ‹ Responsáveis
          </Link>
          <LogoutButton />
        </>
      }
    >
      <QueryState loading={user.loading} error={user.error} onRetry={user.reload} hasData={u !== null}>
        {u ? (
          <div className="stack">
            <div className="card row">
              <Avatar name={u.name} photoUrl={u.photoUrl} size="lg" noPhotoBadge />
              <div className="grow">
                <div className="big-text">{u.name}</div>
                <div className="small muted">
                  {u.email ?? 'sem e-mail'}
                  {u.phone ? ` · ${u.phone}` : ''}
                </div>
                <div className="row mt">
                  {guardianBadges(u).map((b) => (
                    <span key={b.label} className={b.cls}>
                      {b.label}
                    </span>
                  ))}
                  {u.hasAccess ? <span className="badge badge--ok">tem senha</span> : null}
                  {u.pushSubscriptions > 0 ? <span className="badge badge--ok">push em {u.pushSubscriptions} aparelho(s)</span> : <span className="badge">sem push</span>}
                </div>
              </div>
            </div>
            {u.lastEmailError ? <Banner kind="warn">Última falha de e-mail: {u.lastEmailError}</Banner> : null}
            {!u.role || u.role !== 'guardian' ? <Banner kind="info">Esta conta é da equipe ({u.role}). Edite-a em “Equipe”.</Banner> : null}

            <Tabs<Tab>
              items={[
                { key: 'dados', label: 'Dados' },
                { key: 'foto', label: 'Foto' },
                { key: 'filhos', label: 'Filhos', badge: u.children.length },
                { key: 'carteirinhas', label: 'Carteirinhas', badge: u.credentials.filter((c) => c.active).length || undefined },
                { key: 'acesso', label: 'Acesso' },
              ]}
              value={tab}
              onChange={setTab}
            />

            {tab === 'dados' ? (
              <div className="card">
                <UserEditForm user={u} onSaved={(saved) => user.setData({ ...u, ...saved })} />
              </div>
            ) : null}

            {tab === 'foto' ? (
              <div className="card">
                <PhotoUpload name={u.name} photoUrl={u.photoUrl} upload={(form) => uploadUserPhoto(u.id, form)} onUploaded={(url) => user.setData({ ...u, photoUrl: url })} />
              </div>
            ) : null}

            {tab === 'filhos' ? (
              <div className="stack">
                {u.children.length === 0 ? <p className="small muted">Nenhuma criança vinculada. Vincule pela página da criança.</p> : null}
                <div className="list">
                  {u.children.map((c) => (
                    <Link key={c.id} to={`/admin/criancas/${c.id}?tab=responsaveis`} className={`list-item${c.blocked ? ' list-item--danger' : ''}`}>
                      <Avatar name={c.name} photoUrl={c.photoUrl} size="md" />
                      <span className="list-item__body">
                        <span className="list-item__title">{c.name}</span>
                        <span className="list-item__sub">
                          {c.className ?? 'Sem turma'} · {relationshipLabel(c.relationship)}
                          {c.validFrom ? ` · de ${fmt.civil(c.validFrom)}` : ''}
                          {c.validUntil ? ` · até ${fmt.civil(c.validUntil)}` : ''}
                        </span>
                      </span>
                      <span className="list-item__actions">
                        {c.isPrimary ? <span className="badge badge--info">principal</span> : null}
                        {c.blocked ? <span className="badge badge--danger">bloqueado</span> : c.canPickup ? <span className="badge badge--ok">pode retirar</span> : <span className="badge badge--warn">não retira</span>}
                      </span>
                    </Link>
                  ))}
                </div>
              </div>
            ) : null}

            {tab === 'carteirinhas' ? <OwnerCredentials owner={{ type: 'guardian', id: u.id, name: u.name }} onChanged={user.reload} /> : null}

            {tab === 'acesso' ? (
              <div className="stack">
                <section className="card stack">
                  <h2 className="card__title">Convite e senha</h2>
                  <p className="small muted">
                    {u.hasAccess
                      ? 'A pessoa já tem senha. Gere um link de redefinição se ela esqueceu (a creche nunca define a senha do responsável).'
                      : 'A pessoa ainda não tem senha. Envie o convite por e-mail, WhatsApp ou QR no balcão.'}
                    {u.email ? '' : ' Sem e-mail cadastrado: o link só pode ser compartilhado por WhatsApp ou QR.'}
                  </p>
                  <Button variant="primary" icon="✉️" loading={busy === 'invite'} onClick={() => void sendInvite()} disabled={!u.active} data-testid="user-invite">
                    {u.hasAccess ? 'Gerar link de redefinição' : 'Enviar convite'}
                  </Button>
                </section>
                <section className="card stack">
                  <h2 className="card__title">Preferências e sessões</h2>
                  <ul className="kv">
                    <li>
                      <span>Aviso de entrada por push</span>
                      <span>{u.preferences ? (u.preferences.notifyCheckinPush ? 'sim' : 'não') : '—'}</span>
                    </li>
                    <li>
                      <span>Aviso de entrada por e-mail</span>
                      <span>{u.preferences ? (u.preferences.notifyCheckinEmail ? 'sim' : 'não') : '—'}</span>
                    </li>
                    <li>
                      <span>Sessões abertas</span>
                      <span>{u.sessions}</span>
                    </li>
                    <li>
                      <span>Cadastro</span>
                      <span>{fmt.dateTime(u.createdAt)}</span>
                    </li>
                  </ul>
                  <Button variant="neutral" onClick={() => setConfirm('sessions')} disabled={u.sessions === 0 && u.pushSubscriptions === 0}>
                    Encerrar todas as sessões
                  </Button>
                </section>
                <section className="card stack">
                  <h2 className="card__title">{u.active ? 'Desativar' : 'Reativar'}</h2>
                  <p className="small muted">{u.active ? 'Desativar encerra as sessões e as notificações; a pessoa deixa de ser reconhecida na portaria.' : 'A conta volta a funcionar.'}</p>
                  <Button variant={u.active ? 'danger' : 'primary'} onClick={() => setConfirm('deactivate')}>
                    {u.active ? 'Desativar conta' : 'Reativar conta'}
                  </Button>
                </section>
                <section className="card stack">
                  <h2 className="card__title">Anonimizar (LGPD)</h2>
                  <p className="small muted">Substitui o nome por “Responsável removido #NNNN”, apaga contatos e foto e revoga carteirinhas e sessões. Só para contas inativas; irreversível.</p>
                  <Button variant="danger" disabled={u.active || Boolean(u.anonymizedAt)} onClick={() => setConfirm('anonymize')}>
                    {u.anonymizedAt ? 'Já anonimizado' : 'Anonimizar'}
                  </Button>
                </section>
              </div>
            ) : null}
          </div>
        ) : null}
      </QueryState>

      <InviteSheet invite={invite} personName={u?.name ?? ''} onClose={() => setInvite(null)} />

      <ConfirmDialog
        open={confirm === 'sessions'}
        title="Encerrar sessões"
        confirmLabel="Encerrar"
        onCancel={() => setConfirm(null)}
        onConfirm={async () => {
          if (!u) return;
          try {
            await revokeUserSessions(u.id);
            toast.show('Sessões encerradas.', 'success');
            setConfirm(null);
            user.reload();
          } catch (err) {
            throw new Error(describeError(err));
          }
        }}
      >
        <p>{u?.name} precisará entrar de novo em todos os aparelhos; as notificações push são removidas.</p>
      </ConfirmDialog>

      <ConfirmDialog
        open={confirm === 'deactivate'}
        title={u?.active ? 'Desativar conta' : 'Reativar conta'}
        confirmLabel={u?.active ? 'Desativar' : 'Reativar'}
        variant={u?.active ? 'danger' : 'primary'}
        onCancel={() => setConfirm(null)}
        onConfirm={async () => {
          if (!u) return;
          try {
            const saved = await updateUser(u.id, { active: !u.active });
            user.setData({ ...u, ...saved });
            toast.show(saved.active ? 'Conta reativada.' : 'Conta desativada.', 'success');
            setConfirm(null);
          } catch (err) {
            throw new Error(describeError(err));
          }
        }}
      >
        <p>{u?.active ? `${u.name} deixará de acessar o app e de receber alertas.` : `${u?.name} voltará a acessar o app.`}</p>
      </ConfirmDialog>

      <ConfirmDialog
        open={confirm === 'anonymize'}
        title="Anonimizar responsável"
        confirmLabel="Anonimizar definitivamente"
        reason={{ label: 'Motivo', minLength: 3 }}
        onCancel={() => setConfirm(null)}
        onConfirm={async (reason) => {
          if (!u) return;
          try {
            await anonymizeUser(u.id, { reason });
            toast.show('Responsável anonimizado.', 'success');
            setConfirm(null);
            navigate('/admin/responsaveis');
          } catch (err) {
            throw new Error(describeError(err));
          }
        }}
      >
        <p>Esta ação não pode ser desfeita.</p>
      </ConfirmDialog>
    </AdminShell>
  );
}

/** Name / e-mail / phone editor (UpdateUserBody without password). */
export function UserEditForm({ user, onSaved, showLogin = false }: { user: UserDetailDTO; onSaved: (u: Partial<UserDetailDTO>) => void; showLogin?: boolean }) {
  const toast = useToast();
  const [name, setName] = useState(user.name);
  const [email, setEmail] = useState(user.email ?? '');
  const [login, setLogin] = useState(user.login ?? '');
  const [phone, setPhone] = useState(user.phone ?? '');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setName(user.name);
    setEmail(user.email ?? '');
    setLogin(user.login ?? '');
    setPhone(user.phone ?? '');
  }, [user.id, user.name, user.email, user.login, user.phone]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const body: UpdateUserBody = { name: name.trim(), email: emptyToNull(email), phone: emptyToNull(phone) };
    if (showLogin) body.login = emptyToNull(login);
    const r = validateWith(UpdateUserBody, body);
    if (!r.ok) {
      setErrors(r.errors);
      setError(r.first);
      return;
    }
    setBusy(true);
    setError(null);
    setErrors({});
    try {
      const saved = await updateUser(user.id, r.data);
      onSaved(saved);
      toast.show('Dados salvos.', 'success');
    } catch (err) {
      setErrors(issuesFromError(err));
      setError(formError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="stack" onSubmit={(e) => void submit(e)} noValidate>
      <TextField label="Nome completo" value={name} onChange={(e) => setName(e.target.value)} error={errors.name} required autoComplete="off" />
      {showLogin ? <TextField label="Login" value={login} onChange={(e) => setLogin(e.target.value)} error={errors.login} autoCapitalize="none" autoComplete="off" hint="3 a 30 letras minúsculas, números, ponto, traço ou sublinhado." /> : null}
      <TextField label="E-mail" type="email" inputMode="email" autoCapitalize="none" value={email} onChange={(e) => setEmail(e.target.value)} error={errors.email} />
      <TextField label="Telefone celular" type="tel" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} error={errors.phone} />
      {error ? <Banner kind="danger">{error}</Banner> : null}
      <Button type="submit" variant="primary" loading={busy}>
        Salvar
      </Button>
    </form>
  );
}
