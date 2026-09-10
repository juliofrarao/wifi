import { useState } from 'react';
import { useNavigate } from 'react-router';
import { getGuards, switchGuard } from '../../api/endpoints';
import { isApiError } from '../../api/client';
import { useAuth } from '../../auth/AuthProvider';
import { Avatar } from '../../components/Avatar';
import { Banner } from '../../components/Banner';
import { Button } from '../../components/Button';
import { GateShell } from '../../components/AppShell';
import { PinKeypad } from '../../components/PinKeypad';
import { Spinner } from '../../components/Spinner';
import { useToast } from '../../components/Toast';
import { useAsync } from '../../lib/useAsync';
import { setSwitchSuggested, useFlow } from '../flow';
import { kickQueue } from '../queue';

/** Quick guard switch: pick a guard → PIN → POST /auth/switch (replaces the session). */
export function TrocarPage() {
  const { user, setSession } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const flow = useFlow();
  const guards = useAsync(() => getGuards(), []);
  const [picked, setPicked] = useState<{ id: string; name: string; photoUrl: string | null } | null>(null);
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!picked || pin.length < 4) return;
    setBusy(true);
    setError(null);
    try {
      const result = await switchGuard({ userId: picked.id, pin });
      setSession(result);
      setSwitchSuggested(false);
      kickQueue('switch', true);
      toast.show(`Portaria: ${result.user.name}`, 'success');
      navigate('/portaria', { replace: true });
    } catch (err) {
      setPin('');
      if (isApiError(err)) {
        if (err.code === 'INVALID_PIN') setError('PIN incorreto.');
        else if (err.code === 'RATE_LIMITED') setError('Muitas tentativas. Aguarde um pouco ou entre com login e senha.');
        else if (err.isNetwork) setError('Sem conexão. A troca de vigilante precisa de internet.');
        else setError(err.message);
      } else setError('Falha ao trocar de vigilante.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <GateShell>
      <div className="stack">
        <h1>Trocar vigilante</h1>
        {flow.switchSuggested ? (
          <Banner
            kind="info"
            actions={
              <Button
                variant="neutral"
                size="sm"
                onClick={() => {
                  setSwitchSuggested(false);
                  navigate('/portaria', { replace: true });
                }}
              >
                Continuar como {user?.name}
              </Button>
            }
          >
            O app ficou mais de 6 horas em segundo plano. Quem está na portaria agora?
          </Banner>
        ) : null}
        <p className="muted">
          Atual: <strong>{user?.name}</strong>
        </p>
        {!picked ? (
          <>
            {guards.loading ? <Spinner block label="Carregando vigilantes…" /> : null}
            {guards.error ? <Banner kind="danger">{guards.error}</Banner> : null}
            <div className="list" role="list">
              {guards.data?.map((g) => (
                <button key={g.id} type="button" className="list-item" onClick={() => setPicked(g)} data-testid={`switch-guard-${g.id}`}>
                  <Avatar name={g.name} photoUrl={g.photoUrl} size="md" />
                  <span className="list-item__body">
                    <span className="list-item__title">{g.name}</span>
                    {g.id === user?.id ? <span className="list-item__sub">atual</span> : null}
                  </span>
                </button>
              ))}
            </div>
            <Button variant="neutral" onClick={() => navigate(-1)}>
              Voltar
            </Button>
          </>
        ) : (
          <>
            <div className="confirm-head">
              <Avatar name={picked.name} photoUrl={picked.photoUrl} size="lg" />
              <div>
                <div className="confirm-head__name">{picked.name}</div>
                <div className="confirm-head__sub">Digite o PIN</div>
              </div>
            </div>
            {error ? <Banner kind="danger">{error}</Banner> : null}
            <PinKeypad value={pin} onChange={setPin} onSubmit={() => void submit()} disabled={busy} />
            <Button
              variant="neutral"
              onClick={() => {
                setPicked(null);
                setPin('');
                setError(null);
              }}
              disabled={busy}
            >
              Escolher outra pessoa
            </Button>
          </>
        )}
      </div>
    </GateShell>
  );
}
