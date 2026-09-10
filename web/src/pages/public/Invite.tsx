import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { ROLE_LABELS } from '@creche/shared';
import { acceptInvite, getInvite } from '../../api/endpoints';
import { describeError, isApiError } from '../../api/client';
import { homeFor, useAuth } from '../../auth/AuthProvider';
import { Banner } from '../../components/Banner';
import { Button } from '../../components/Button';
import { PublicShell } from '../../components/AppShell';
import { Spinner } from '../../components/Spinner';
import { useToast } from '../../components/Toast';
import { useFormat } from '../../lib/format';
import { isInAppBrowser, isIos, isStandalone } from '../../lib/ua';
import { useAsync } from '../../lib/useAsync';
import { PasswordForm } from './PasswordForm';

export function InvitePage() {
  const { token = '' } = useParams();
  const navigate = useNavigate();
  const { setSession } = useAuth();
  const toast = useToast();
  const fmt = useFormat();
  const invite = useAsync(() => getInvite(token), [token]);
  const [inApp] = useState(() => isInAppBrowser());
  const [ios] = useState(() => isIos() && !isStandalone());

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      toast.show('Link copiado. Cole no navegador (Chrome ou Safari).', 'success');
    } catch {
      toast.show('Não foi possível copiar. Use o menu do app para abrir no navegador.', 'danger');
    }
  };

  if (invite.loading) {
    return (
      <PublicShell title="Convite">
        <Spinner block label="Verificando convite…" />
      </PublicShell>
    );
  }
  if (invite.error || !invite.data) {
    const expired = /expir/i.test(invite.error ?? '');
    return (
      <PublicShell title="Convite inválido">
        <Banner kind="danger">{expired ? 'Este convite expirou.' : (invite.error ?? 'Convite não encontrado.')} Peça um novo convite à secretaria da creche.</Banner>
        <p className="center small mt">
          <Link to="/login">Já tenho senha</Link>
        </p>
      </PublicShell>
    );
  }
  const { name, role, expiresAt } = invite.data;
  const minLength = role === 'admin' ? 12 : 8;

  return (
    <PublicShell title={`Olá, ${name.split(' ')[0]}!`}>
      <div className="stack">
        <p>
          Você foi cadastrado(a) como <strong>{ROLE_LABELS[role]}</strong>. Crie uma senha para acessar o app.
          <span className="tiny muted"> Convite válido até {fmt.dateTime(expiresAt)}.</span>
        </p>
        {inApp ? (
          <Banner
            kind="warn"
            actions={
              <Button variant="neutral" size="sm" onClick={() => void copyLink()}>
                Copiar link
              </Button>
            }
          >
            Você abriu este link dentro do WhatsApp/Instagram. Para instalar o app e receber alertas, abra no navegador: toque no menu (⋮ ou ⋯) e escolha
            <strong> “Abrir no navegador”</strong> — ou copie o link e cole no Chrome/Safari.
          </Banner>
        ) : null}
        {ios ? (
          <Banner kind="info" icon="📱">
            No iPhone, para receber notificações: abra no Safari, toque em <strong>Compartilhar</strong> e depois em <strong>“Adicionar à Tela de Início”</strong>. Abra o app pelo ícone antes de
            ativar as notificações.
          </Banner>
        ) : null}
        <PasswordForm
          minLength={minLength}
          submitLabel="Criar senha e entrar"
          onSubmit={async (password) => {
            try {
              const result = await acceptInvite({ token, password });
              setSession(result);
              navigate(homeFor(result.user.role), { replace: true });
            } catch (err) {
              if (isApiError(err) && err.code === 'WEAK_PASSWORD') throw new Error(err.message);
              if (isApiError(err) && (err.code === 'TOKEN_EXPIRED' || err.code === 'INVALID_TOKEN')) throw new Error('Convite expirado ou já usado. Peça um novo à secretaria.');
              throw new Error(describeError(err));
            }
          }}
        />
      </div>
    </PublicShell>
  );
}
