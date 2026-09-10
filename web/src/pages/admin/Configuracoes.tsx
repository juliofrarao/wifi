import { useEffect, useState, type FormEvent } from 'react';
import { DaycareSettingsBody, type DaycareSettings } from '@creche/shared';
import { downloadBackup, getAdminStats, getSettings, runBackup, sendTestEmail, updateSettings } from '../../api/endpoints';
import { describeError, isApiError } from '../../api/client';
import { AdminShell } from '../../components/AppShell';
import { Banner } from '../../components/Banner';
import { Button } from '../../components/Button';
import { QueryState } from '../../components/QueryState';
import { TextField } from '../../components/TextField';
import { useToast } from '../../components/Toast';
import { useConfig } from '../../config/ConfigProvider';
import { saveBlob } from '../../lib/download';
import { emptyToNull, issuesFromError, formError, validateWith, type FieldErrors } from '../../lib/form';
import { formatDuration, useFormat } from '../../lib/format';
import { useAsync } from '../../lib/useAsync';
import { ChangePasswordSection, PushSection } from '../guardian/Config';
import { LogoutButton } from '../LogoutButton';

const BACKUP_RED_MS = 48 * 3600_000;

export function ConfiguracoesPage() {
  const { config, refresh } = useConfig();
  const fmt = useFormat();
  const toast = useToast();
  const settings = useAsync(() => getSettings(), []);
  const stats = useAsync(() => getAdminStats(), []);
  const [busy, setBusy] = useState<string | null>(null);
  const [emailResult, setEmailResult] = useState<{ kind: 'success' | 'danger'; text: string } | null>(null);

  const testEmail = async () => {
    setBusy('email');
    setEmailResult(null);
    try {
      await sendTestEmail();
      setEmailResult({ kind: 'success', text: `E-mail de teste enviado para ${settings.data?.contactEmail ?? 'o e-mail de contato'}. Confira a caixa de entrada (e o spam).` });
    } catch (err) {
      if (isApiError(err) && err.code === 'EMAIL_DISABLED') setEmailResult({ kind: 'danger', text: 'Envio de e-mail desligado: configure SMTP_HOST no servidor (.env) e reinicie.' });
      else setEmailResult({ kind: 'danger', text: describeError(err) });
    } finally {
      setBusy(null);
    }
  };

  const backupNow = async () => {
    setBusy('backup');
    try {
      const r = await runBackup();
      stats.setData((prev) => (prev ? { ...prev, lastBackupAt: r.lastBackupAt } : prev));
      toast.show(`Backup concluído às ${fmt.time(r.lastBackupAt)}.`, 'success');
    } catch (err) {
      toast.show(describeError(err), 'danger', 6000);
    } finally {
      setBusy(null);
    }
  };

  const download = async () => {
    setBusy('download');
    try {
      const { blob, filename } = await downloadBackup();
      saveBlob(blob, filename ?? `creche-backup-${fmt.today()}.tar.gz`);
    } catch (err) {
      toast.show(describeError(err), 'danger', 6000);
    } finally {
      setBusy(null);
    }
  };

  const lastBackup = stats.data?.lastBackupAt ?? null;
  const backupAge = lastBackup ? Date.now() - Date.parse(lastBackup) : null;

  return (
    <AdminShell title="Configurações" headerActions={<LogoutButton />}>
      <div className="stack stack--lg">
        <section className="card stack">
          <h2 className="card__title">Creche</h2>
          <QueryState loading={settings.loading} error={settings.error} onRetry={settings.reload} hasData={settings.data !== null}>
            {settings.data ? (
              <SettingsForm
                initial={settings.data}
                onSaved={async (saved) => {
                  settings.setData(saved);
                  await refresh();
                }}
              />
            ) : null}
          </QueryState>
        </section>

        <section className="card stack">
          <h2 className="card__title">E-mail</h2>
          <p className="small">
            Estado: {config.emailEnabled ? <span className="badge badge--ok">ativo</span> : <span className="badge badge--warn">desligado</span>}
            {stats.data ? (
              <span className="muted">
                {' '}
                · {stats.data.notifications.emailsToday} de {stats.data.notifications.emailDailyLimit} e-mails hoje · {stats.data.notifications.failedLast24h} falha(s) nas últimas 24 h
              </span>
            ) : null}
          </p>
          <p className="tiny muted">Servidor SMTP, remetente e limite diário ficam no arquivo .env do servidor. O e-mail de contato acima é usado como “responder para”.</p>
          <Button variant="neutral" icon="✉️" loading={busy === 'email'} onClick={() => void testEmail()} data-testid="test-email">
            Enviar e-mail de teste
          </Button>
          {emailResult ? <Banner kind={emailResult.kind}>{emailResult.text}</Banner> : null}
        </section>

        <section className="card stack">
          <h2 className="card__title">Notificações push</h2>
          <p className="small">
            Chaves VAPID: {config.vapidPublicKey ? <span className="badge badge--ok">configuradas</span> : <span className="badge badge--danger">ausentes</span>}
            {config.vapidPublicKey ? <span className="tiny muted"> · chave pública {config.vapidPublicKey.slice(0, 12)}…</span> : null}
          </p>
          <p className="tiny muted">As chaves são geradas automaticamente na primeira execução e guardadas no banco. Para testar o push neste aparelho, ative abaixo.</p>
          <PushSection compact />
        </section>

        <section className="card stack">
          <h2 className="card__title">Backup</h2>
          <p className="small">
            Último backup:{' '}
            {lastBackup ? (
              <strong className={backupAge !== null && backupAge > BACKUP_RED_MS ? 'stat--danger-text' : ''}>
                {fmt.dateTime(lastBackup)} (há {formatDuration(backupAge ?? 0)})
              </strong>
            ) : (
              <strong className="stat--danger-text">nunca</strong>
            )}
          </p>
          <p className="tiny muted">O backup automático roda todo dia às 02:00 (banco + fotos, compactado). Baixe uma cópia regularmente e guarde fora do servidor. Restauração: `npm run restore &lt;arquivo&gt;`.</p>
          <div className="row">
            <Button variant="primary" icon="💾" loading={busy === 'backup'} onClick={() => void backupNow()} data-testid="backup-run">
              Executar backup agora
            </Button>
            <Button variant="neutral" icon="⬇️" loading={busy === 'download'} onClick={() => void download()} data-testid="backup-download">
              Baixar último backup
            </Button>
          </div>
        </section>

        <ChangePasswordSection minLength={12} />

        <section className="card stack">
          <h2 className="card__title">Sobre</h2>
          <ul className="kv">
            <li>
              <span>Versão do app (servidor)</span>
              <span>
                <code>{config.appVersion}</code>
              </span>
            </li>
            <li>
              <span>Versão carregada neste navegador</span>
              <span>
                <code>{__APP_VERSION__}</code>
              </span>
            </li>
            <li>
              <span>Fuso horário</span>
              <span>{config.timezone}</span>
            </li>
            <li>
              <span>Endereço público</span>
              <span>
                <code>{config.appUrl}</code>
              </span>
            </li>
            <li>
              <span>Janela para desfazer</span>
              <span>{config.notifyHoldSeconds} s</span>
            </li>
            <li>
              <span>Saída offline permitida com diretório de até</span>
              <span>{config.offlineCheckoutMaxAgeHours} h</span>
            </li>
            <li>
              <span>Dados de demonstração</span>
              <span>{config.demoData ? <span className="badge badge--warn">sim</span> : 'não'}</span>
            </li>
          </ul>
        </section>
      </div>
    </AdminShell>
  );
}

function SettingsForm({ initial, onSaved }: { initial: DaycareSettings; onSaved: (s: DaycareSettings) => Promise<void> }) {
  const toast = useToast();
  const [name, setName] = useState(initial.daycareName);
  const [phone, setPhone] = useState(initial.daycarePhone ?? '');
  const [email, setEmail] = useState(initial.contactEmail ?? '');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setName(initial.daycareName);
    setPhone(initial.daycarePhone ?? '');
    setEmail(initial.contactEmail ?? '');
  }, [initial]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const r = validateWith(DaycareSettingsBody, { daycareName: name.trim(), daycarePhone: emptyToNull(phone), contactEmail: emptyToNull(email) });
    if (!r.ok) {
      setErrors(r.errors);
      setError(r.first);
      return;
    }
    setBusy(true);
    setError(null);
    setErrors({});
    try {
      const saved = await updateSettings(r.data);
      await onSaved(saved);
      toast.show('Configurações salvas.', 'success');
    } catch (err) {
      setErrors(issuesFromError(err));
      setError(formError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="stack" onSubmit={(e) => void submit(e)} noValidate>
      <TextField label="Nome da creche" value={name} onChange={(e) => setName(e.target.value)} error={errors.daycareName} required hint="Aparece no app, nas carteirinhas e nos e-mails." />
      <TextField label="Telefone" type="tel" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} error={errors.daycarePhone} hint="Impresso nas carteirinhas e mostrado na tela de bloqueio da portaria." />
      <TextField label="E-mail de contato" type="email" inputMode="email" autoCapitalize="none" value={email} onChange={(e) => setEmail(e.target.value)} error={errors.contactEmail} hint="Recebe as respostas dos e-mails e o e-mail de teste." />
      {error ? <Banner kind="danger">{error}</Banner> : null}
      <Button type="submit" variant="primary" loading={busy}>
        Salvar
      </Button>
    </form>
  );
}
