import { useEffect, useState, type FormEvent } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router';
import { isApiError } from '../../api/client';
import { homeFor, useAuth } from '../../auth/AuthProvider';
import { Banner } from '../../components/Banner';
import { Button } from '../../components/Button';
import { PublicShell } from '../../components/AppShell';
import { TextField } from '../../components/TextField';
import { loadQueue, useQueue } from '../../gate/queue';

export function LoginPage() {
  const { status, user, signIn } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const queue = useQueue();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void loadQueue();
  }, []);

  if (status === 'authed' && user) {
    const from = (location.state as { from?: string } | null)?.from;
    return <Navigate to={from && from !== '/login' ? from : homeFor(user.role)} replace />;
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const me = await signIn(identifier.trim(), password);
      const from = (location.state as { from?: string } | null)?.from;
      navigate(from && from !== '/login' ? from : homeFor(me.role), { replace: true });
    } catch (err) {
      if (isApiError(err)) {
        if (err.code === 'INVALID_CREDENTIALS' || err.status === 401) setError('E-mail/login ou senha incorretos.');
        else if (err.code === 'RATE_LIMITED') {
          const secs = (err.details as { retryAfterSeconds?: number } | undefined)?.retryAfterSeconds;
          setError(`Muitas tentativas. Aguarde ${secs ? `${secs} segundos` : 'alguns minutos'} e tente de novo.`);
        } else if (err.isNetwork) setError('Sem conexão com o servidor. Verifique a internet e tente de novo.');
        else if (err.code === 'VALIDATION') setError('Preencha e-mail/login e senha.');
        else setError(err.message);
      } else setError('Falha ao entrar.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <PublicShell title="Entrar">
      <form onSubmit={(e) => void submit(e)} className="stack" noValidate>
        {queue.counts.needsLogin + queue.counts.pending > 0 ? (
          <Banner kind="warn">Entre novamente para enviar {queue.counts.needsLogin + queue.counts.pending} registro(s) da portaria.</Banner>
        ) : null}
        <TextField
          label="E-mail ou login"
          value={identifier}
          onChange={(e) => setIdentifier(e.target.value)}
          autoComplete="username"
          autoCapitalize="none"
          autoCorrect="off"
          inputMode="email"
          required
          data-testid="login-identifier"
        />
        <TextField
          label="Senha"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          required
          data-testid="login-password"
        />
        {error ? <Banner kind="danger">{error}</Banner> : null}
        <Button type="submit" size="big" loading={busy} disabled={!identifier.trim() || !password} data-testid="login-submit">
          Entrar
        </Button>
        <p className="center small">
          <Link to="/esqueci">Esqueci minha senha</Link>
        </p>
      </form>
    </PublicShell>
  );
}
