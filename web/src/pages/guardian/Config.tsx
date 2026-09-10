import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ChangePasswordBody, UpdateMeBody, type Preferences } from '@creche/shared';
import { changePassword, getPreferences, sendTestPush, updateMe, updatePreferences } from '../../api/endpoints';
import { describeError, isApiError } from '../../api/client';
import { useAuth } from '../../auth/AuthProvider';
import { GuardianShell } from '../../components/AppShell';
import { Banner } from '../../components/Banner';
import { Button } from '../../components/Button';
import { SimpleCheckbox } from '../../components/CheckboxRow';
import { QueryState } from '../../components/QueryState';
import { TextField } from '../../components/TextField';
import { useToast } from '../../components/Toast';
import { useConfig } from '../../config/ConfigProvider';
import { emptyToNull, issuesFromError, formError, validateWith, type FieldErrors } from '../../lib/form';
import { subscribePush, syncPushSubscription, unsubscribePush } from '../../lib/push';
import { isIos, isStandalone, supportsPush } from '../../lib/ua';
import { useAsync } from '../../lib/useAsync';
import { LogoutButton } from '../LogoutButton';

type PushState = 'checking' | 'unsupported' | 'ios-browser' | 'denied' | 'off' | 'on';

/** Push status + "Ativar / Enviar teste / Desativar" (spec §7 Responsável › Configurações). */
export function PushSection({ compact = false }: { compact?: boolean }) {
  const { config } = useConfig();
  const toast = useToast();
  const [state, setState] = useState<PushState>('checking');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const check = useCallback(async () => {
    if (!supportsPush()) {
      setState(isIos() && !isStandalone() ? 'ios-browser' : 'unsupported');
      return;
    }
    if (Notification.permission === 'denied') {
      setState('denied');
      return;
    }
    // Re-registers the browser subscription on the server (idempotent) and only then says "on".
    setState(await syncPushSubscription(config.vapidPublicKey));
  }, [config.vapidPublicKey]);

  useEffect(() => {
    void check();
  }, [check]);

  const enable = async () => {
    setBusy('enable');
    setError(null);
    try {
      if (!config.vapidPublicKey) throw new Error('Notificações push não estão configuradas no servidor. Avise a secretaria.');
      await subscribePush(config.vapidPublicKey);
      toast.show('Notificações ativadas neste aparelho.', 'success');
      await check();
    } catch (err) {
      setError(describeError(err));
      await check();
    } finally {
      setBusy(null);
    }
  };

  const disable = async () => {
    setBusy('disable');
    setError(null);
    await unsubscribePush();
    toast.show('Notificações desativadas neste aparelho.');
    await check();
    setBusy(null);
  };

  const test = async () => {
    setBusy('test');
    setError(null);
    try {
      await sendTestPush();
      toast.show('Notificação de teste enviada. Ela deve aparecer em instantes.', 'success', 5000);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="card stack" aria-labelledby="push-title">
      <h2 id="push-title" className="card__title">
        Notificações no celular
      </h2>
      {state === 'checking' ? <p className="small muted">Verificando…</p> : null}
      {state === 'ios-browser' ? (
        <Banner kind="info" icon="📱">
          No iPhone, as notificações só funcionam com o app instalado: no Safari, toque em <strong>Compartilhar</strong> e depois em <strong>“Adicionar à Tela de Início”</strong>. Abra o app pelo ícone e
          volte aqui para ativar.
        </Banner>
      ) : null}
      {state === 'unsupported' ? <Banner kind="warn">Este navegador não suporta notificações push. Você continua recebendo os alertas aqui no app{config.emailEnabled ? ' e por e-mail' : ''}.</Banner> : null}
      {state === 'denied' ? (
        <Banner kind="warn">
          As notificações estão bloqueadas para este site. Libere em: configurações do navegador → Notificações → {location.hostname}.
          <span className="row mt">
            <Button variant="neutral" size="sm" onClick={() => void check()}>
              Verificar de novo
            </Button>
          </span>
        </Banner>
      ) : null}
      {state === 'off' ? (
        <div className="stack stack--sm">
          {!compact ? <p className="small">Receba na hora o aviso de entrada e de saída dos seus filhos, mesmo com o app fechado.</p> : null}
          <Button variant="primary" icon="🔔" loading={busy === 'enable'} onClick={() => void enable()} data-testid="push-enable">
            Ativar notificações
          </Button>
        </div>
      ) : null}
      {state === 'on' ? (
        <div className="stack stack--sm">
          <Banner kind="success" className="banner--compact">
            Notificações ativas neste aparelho.
          </Banner>
          <div className="row">
            <Button variant="neutral" loading={busy === 'test'} onClick={() => void test()} data-testid="push-test">
              Enviar teste
            </Button>
            <Button variant="ghost" loading={busy === 'disable'} onClick={() => void disable()}>
              Desativar neste aparelho
            </Button>
          </div>
        </div>
      ) : null}
      {error ? <Banner kind="danger">{error}</Banner> : null}
    </section>
  );
}

function PreferencesSection() {
  const { user } = useAuth();
  const { config } = useConfig();
  const toast = useToast();
  const prefs = useAsync(() => getPreferences(), []);
  const [saving, setSaving] = useState(false);

  const toggle = async (patch: Partial<Preferences>) => {
    if (!prefs.data) return;
    const previous = prefs.data;
    prefs.setData({ ...previous, ...patch });
    setSaving(true);
    try {
      const saved = await updatePreferences(patch);
      prefs.setData(saved);
    } catch (err) {
      prefs.setData(previous);
      toast.show(describeError(err), 'danger');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="card stack" aria-labelledby="prefs-title">
      <h2 id="prefs-title" className="card__title">
        Avisos de entrada
      </h2>
      <p className="small muted">Os avisos de <strong>saída</strong> são sempre enviados por todos os canais. Escolha como quer receber os de entrada:</p>
      <QueryState loading={prefs.loading} error={prefs.error} onRetry={prefs.reload} hasData={prefs.data !== null}>
        {prefs.data ? (
          <div className="stack stack--sm" aria-busy={saving || undefined}>
            <SimpleCheckbox checked={prefs.data.notifyCheckinPush} onChange={(v) => void toggle({ notifyCheckinPush: v })} label="Notificação no celular (push)" testId="pref-checkin-push" />
            <SimpleCheckbox checked={prefs.data.notifyCheckinEmail} onChange={(v) => void toggle({ notifyCheckinEmail: v })} label="E-mail" testId="pref-checkin-email" />
            {!user?.email ? <p className="tiny muted">Você não tem e-mail cadastrado; peça à secretaria para incluir.</p> : !config.emailEnabled ? <p className="tiny muted">O envio de e-mails não está ativo no servidor.</p> : null}
          </div>
        ) : null}
      </QueryState>
    </section>
  );
}

function ProfileSection() {
  const { user, refreshUser } = useAuth();
  const toast = useToast();
  const [name, setName] = useState(user?.name ?? '');
  const [phone, setPhone] = useState(user?.phone ?? '');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setName(user?.name ?? '');
    setPhone(user?.phone ?? '');
  }, [user?.name, user?.phone]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const v = validateWith(UpdateMeBody, { name: name.trim(), phone: emptyToNull(phone) });
    if (!v.ok) {
      setErrors(v.errors);
      return;
    }
    setErrors({});
    setBusy(true);
    try {
      await updateMe(v.data);
      await refreshUser();
      toast.show('Dados salvos.', 'success');
    } catch (err) {
      setErrors(issuesFromError(err));
      toast.show(formError(err), 'danger');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card" aria-labelledby="profile-title">
      <h2 id="profile-title" className="card__title">
        Meus dados
      </h2>
      <form className="stack" onSubmit={(e) => void submit(e)} noValidate>
        <TextField label="Nome" value={name} onChange={(e) => setName(e.target.value)} error={errors.name} autoComplete="name" required />
        <TextField label="Telefone (celular)" type="tel" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} error={errors.phone} autoComplete="tel" hint="Usado pela creche para falar com você." />
        <p className="tiny muted">
          E-mail: {user?.email ?? 'não cadastrado'} · Foto: só a secretaria altera (é a foto conferida na portaria).
        </p>
        <Button type="submit" variant="primary" loading={busy} disabled={name.trim().length < 2}>
          Salvar
        </Button>
      </form>
    </section>
  );
}

export function ChangePasswordSection({ minLength = 8 }: { minLength?: number }) {
  const toast = useToast();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const tooShort = next.length > 0 && next.length < minLength;
  const mismatch = confirm.length > 0 && confirm !== next;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const v = validateWith(ChangePasswordBody, { currentPassword: current, newPassword: next });
    if (!v.ok) {
      setError(v.first);
      return;
    }
    if (next !== confirm) {
      setError('As senhas não conferem.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await changePassword(current, next);
      setCurrent('');
      setNext('');
      setConfirm('');
      toast.show('Senha alterada. Suas outras sessões foram encerradas.', 'success', 5000);
    } catch (err) {
      if (isApiError(err) && (err.code === 'INVALID_CREDENTIALS' || err.status === 401)) setError('Senha atual incorreta.');
      else setError(formError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card" aria-labelledby="pwd-title">
      <h2 id="pwd-title" className="card__title">
        Trocar senha
      </h2>
      <form className="stack" onSubmit={(e) => void submit(e)} noValidate>
        <TextField label="Senha atual" type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" required />
        <TextField
          label="Nova senha"
          type="password"
          value={next}
          onChange={(e) => setNext(e.target.value)}
          autoComplete="new-password"
          hint={`Pelo menos ${minLength} caracteres.`}
          error={tooShort ? `A senha deve ter pelo menos ${minLength} caracteres.` : null}
          required
        />
        <TextField label="Repita a nova senha" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" error={mismatch ? 'As senhas não conferem.' : null} required />
        {error ? <Banner kind="danger">{error}</Banner> : null}
        <Button type="submit" variant="primary" loading={busy} disabled={!current || next.length < minLength || next !== confirm}>
          Alterar senha
        </Button>
      </form>
    </section>
  );
}

export function ConfigPage() {
  const { config } = useConfig();
  return (
    <GuardianShell title="Configurações" headerActions={<LogoutButton />}>
      <div className="stack stack--lg">
        <PushSection />
        <PreferencesSection />
        <ProfileSection />
        <ChangePasswordSection />
        <section className="card stack">
          <h2 className="card__title">Sessão</h2>
          <p className="small muted">Sair encerra o acesso neste aparelho e desativa as notificações dele.</p>
          <LogoutButton />
          <p className="tiny muted">
            {config.daycareName} · Creche Segura {__APP_VERSION__}
          </p>
        </section>
      </div>
    </GuardianShell>
  );
}
