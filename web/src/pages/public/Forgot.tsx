import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { forgotPassword } from '../../api/endpoints';
import { describeError, isApiError } from '../../api/client';
import { Banner } from '../../components/Banner';
import { Button } from '../../components/Button';
import { PublicShell } from '../../components/AppShell';
import { TextField } from '../../components/TextField';

export function ForgotPage() {
  const [identifier, setIdentifier] = useState('');
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await forgotPassword(identifier.trim());
      setDone(true);
    } catch (err) {
      if (isApiError(err) && err.code === 'RATE_LIMITED') setError('Muitas tentativas. Aguarde alguns minutos.');
      else setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <PublicShell title="Esqueci minha senha">
      {done ? (
        <div className="stack">
          <Banner kind="success">Se existir uma conta com esse e-mail, enviamos um link para criar uma nova senha. Ele vale por 1 hora.</Banner>
          <p className="small muted">Não tem e-mail cadastrado? Peça à secretaria da creche um link de redefinição.</p>
          <Link to="/login" className="btn btn--neutral">
            Voltar para o login
          </Link>
        </div>
      ) : (
        <form onSubmit={(e) => void submit(e)} className="stack" noValidate>
          <TextField label="E-mail ou login" value={identifier} onChange={(e) => setIdentifier(e.target.value)} autoComplete="username" autoCapitalize="none" inputMode="email" required />
          {error ? <Banner kind="danger">{error}</Banner> : null}
          <Button type="submit" size="big" loading={busy} disabled={!identifier.trim()}>
            Enviar link
          </Button>
          <p className="small muted">Sem e-mail cadastrado? Peça à secretaria da creche um link de redefinição.</p>
          <p className="center small">
            <Link to="/login">Voltar</Link>
          </p>
        </form>
      )}
    </PublicShell>
  );
}
