import { useState, type FormEvent } from 'react';
import { Banner } from '../../components/Banner';
import { Button } from '../../components/Button';
import { TextField } from '../../components/TextField';

/** Password + confirmation (min 8; 12 for admins), shared by invite and reset. */
export function PasswordForm({ minLength = 8, onSubmit, submitLabel = 'Salvar senha' }: { minLength?: number; onSubmit: (password: string) => Promise<void>; submitLabel?: string }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const tooShort = password.length > 0 && password.length < minLength;
  const mismatch = confirm.length > 0 && confirm !== password;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (password.length < minLength || password !== confirm) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(password);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao salvar a senha');
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)} className="stack" noValidate>
      <TextField
        label="Nova senha"
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        autoComplete="new-password"
        hint={`Pelo menos ${minLength} caracteres.`}
        error={tooShort ? `A senha deve ter pelo menos ${minLength} caracteres.` : null}
        required
        data-testid="password-new"
      />
      <TextField
        label="Repita a senha"
        type="password"
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
        autoComplete="new-password"
        error={mismatch ? 'As senhas não conferem.' : null}
        required
        data-testid="password-confirm"
      />
      {error ? <Banner kind="danger">{error}</Banner> : null}
      <Button type="submit" size="big" loading={busy} disabled={password.length < minLength || password !== confirm}>
        {submitLabel}
      </Button>
    </form>
  );
}
