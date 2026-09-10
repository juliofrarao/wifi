import { Link, useNavigate, useParams } from 'react-router';
import { getReset, resetPassword } from '../../api/endpoints';
import { describeError, isApiError } from '../../api/client';
import { homeFor, useAuth } from '../../auth/AuthProvider';
import { Banner } from '../../components/Banner';
import { PublicShell } from '../../components/AppShell';
import { Spinner } from '../../components/Spinner';
import { useAsync } from '../../lib/useAsync';
import { PasswordForm } from './PasswordForm';

export function ResetPage() {
  const { token = '' } = useParams();
  const navigate = useNavigate();
  const { setSession } = useAuth();
  const reset = useAsync(() => getReset(token), [token]);

  if (reset.loading) {
    return (
      <PublicShell title="Nova senha">
        <Spinner block label="Verificando link…" />
      </PublicShell>
    );
  }
  if (reset.error || !reset.data) {
    return (
      <PublicShell title="Link inválido">
        <Banner kind="danger">{reset.error ?? 'Link não encontrado.'} Peça um novo link em “Esqueci minha senha” ou à secretaria.</Banner>
        <p className="center small mt">
          <Link to="/esqueci">Pedir novo link</Link>
        </p>
      </PublicShell>
    );
  }
  return (
    <PublicShell title={`Nova senha para ${reset.data.name.split(' ')[0]}`}>
      <PasswordForm
        onSubmit={async (password) => {
          try {
            const result = await resetPassword(token, password);
            setSession(result);
            navigate(homeFor(result.user.role), { replace: true });
          } catch (err) {
            if (isApiError(err) && (err.code === 'TOKEN_EXPIRED' || err.code === 'INVALID_TOKEN')) throw new Error('Link expirado ou já usado. Peça um novo.');
            throw new Error(describeError(err));
          }
        }}
      />
    </PublicShell>
  );
}
