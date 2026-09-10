import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { formatCode, normalizeCode, type UserDTO } from '@creche/shared';
import { getPublicCard } from '../../api/endpoints';
import { getToken } from '../../api/client';
import { Banner } from '../../components/Banner';
import { PublicShell } from '../../components/AppShell';
import { Spinner } from '../../components/Spinner';
import { useConfig } from '../../config/ConfigProvider';
import { pingGate, sendCodeToGate } from '../../lib/broadcast';
import { STORAGE_KEYS, readJson } from '../../lib/storage';

/**
 * /c/:code — the URL printed in the QR. With a gate session in this tab →
 * /portaria?code=; with a gate reader open in another tab → BroadcastChannel;
 * otherwise the public "found card" message.
 */
export function CardPublicPage() {
  const { code = '' } = useParams();
  const navigate = useNavigate();
  const { config } = useConfig();
  const [state, setState] = useState<'checking' | 'sent' | 'public'>('checking');
  const [info, setInfo] = useState<{ daycareName: string; daycarePhone: string | null } | null>(null);
  const normalized = normalizeCode(code);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const user = getToken() ? readJson<UserDTO>(STORAGE_KEYS.user) : null;
      if (user && (user.role === 'guard' || user.role === 'admin')) {
        navigate(`/portaria?code=${encodeURIComponent(normalized)}`, { replace: true });
        return;
      }
      const gateOpen = await pingGate(500);
      if (cancelled) return;
      if (gateOpen) {
        sendCodeToGate(normalized);
        setState('sent');
        setTimeout(() => {
          try {
            window.close();
          } catch {
            /* cannot close tabs we did not open */
          }
        }, 1500);
        return;
      }
      try {
        const data = await getPublicCard(normalized);
        if (!cancelled) setInfo(data);
      } catch {
        /* fall back to config */
      }
      if (!cancelled) setState('public');
    })();
    return () => {
      cancelled = true;
    };
  }, [normalized, navigate]);

  const name = info?.daycareName ?? config.daycareName;
  const phone = info?.daycarePhone ?? config.daycarePhone;

  return (
    <PublicShell title="Carteirinha">
      {state === 'checking' ? <Spinner block label="Verificando…" /> : null}
      {state === 'sent' ? <Banner kind="success">Código enviado para a portaria. Você já pode fechar esta aba.</Banner> : null}
      {state === 'public' ? (
        <div className="stack">
          <p className="big-text">Carteirinha da {name}.</p>
          <p>
            Código <code>{formatCode(normalized)}</code>.
          </p>
          <p>
            Se você encontrou esta carteirinha, por favor ligue para a creche{phone ? `: ${phone}` : ''} ou entregue na secretaria.
          </p>
        </div>
      ) : null}
    </PublicShell>
  );
}
