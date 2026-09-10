import { useEffect, useState } from 'react';
import { cardUrl, formatCode, type CredentialDTO } from '@creche/shared';
import { bindNfc } from '../api/endpoints';
import { describeError, isApiError } from '../api/client';
import { useConfig } from '../config/ConfigProvider';
import { useNfcReader } from '../gate/nfc';
import { supportsNfc } from '../lib/ua';
import { VIBRATE, vibrate } from '../lib/vibrate';
import { Banner } from './Banner';
import { Button } from './Button';
import { Modal } from './Modal';

type Phase = 'scan' | 'binding' | 'bound' | 'writing' | 'written' | 'protecting' | 'done';

function nfcErrorMessage(err: unknown): string {
  const name = err instanceof Error ? err.name : '';
  switch (name) {
    case 'NotSupportedError':
      return 'Este aparelho ou navegador não grava etiquetas NFC.';
    case 'NotAllowedError':
      return 'Permissão de NFC negada. Libere o NFC nas permissões do site.';
    case 'NotReadableError':
      return 'Etiqueta protegida contra gravação ou ilegível. Ligue o NFC nas configurações do aparelho.';
    case 'NetworkError':
      return 'A etiqueta foi afastada antes de terminar. Encoste de novo e mantenha parada.';
    case 'AbortError':
      return 'Operação cancelada.';
    default:
      return err instanceof Error && err.message ? err.message : 'Falha ao acessar a etiqueta NFC.';
  }
}

/**
 * "Colar etiqueta NFC" flow (spec §4.7): read the sticker's UID → POST
 * /credentials/:id/nfc → optionally write the card URL to the tag and make it
 * read-only. Chrome for Android only; other browsers get a clear message.
 */
export function NfcBindSheet({ credential, onClose, onBound }: { credential: CredentialDTO | null; onClose: () => void; onBound: (c: CredentialDTO) => void }) {
  const { config } = useConfig();
  const open = credential !== null;
  const [phase, setPhase] = useState<Phase>('scan');
  const [message, setMessage] = useState<string | null>(null);
  const [uid, setUid] = useState<string | null>(null);
  const [bound, setBound] = useState<CredentialDTO | null>(null);
  const supported = supportsNfc();

  useEffect(() => {
    if (!open) return;
    setPhase('scan');
    setMessage(null);
    setUid(null);
    setBound(null);
  }, [open, credential?.id]);

  const nfc = useNfcReader({
    enabled: open && supported && phase === 'scan',
    onRead: (read) => {
      if (!credential || phase !== 'scan') return;
      if (!read.uid) {
        setMessage('Etiqueta sem número de série legível. Use uma etiqueta NTAG213/215/216.');
        return;
      }
      vibrate(VIBRATE.read);
      setUid(read.uid);
      setPhase('binding');
      setMessage(null);
      bindNfc(credential.id, read.uid).then(
        (updated) => {
          setBound(updated);
          onBound(updated);
          setPhase('bound');
        },
        (err) => {
          setPhase('scan');
          if (isApiError(err) && err.code === 'UID_IN_USE') setMessage('Esta etiqueta já está colada em outra carteirinha ativa. Revogue a outra antes.');
          else setMessage(describeError(err));
        }
      );
    },
    onError: (msg) => setMessage(msg),
  });

  const writeTag = async (readOnly: boolean) => {
    if (!credential?.code) return;
    setMessage(null);
    nfc.stop();
    setPhase(readOnly ? 'protecting' : 'writing');
    try {
      const writer = new NDEFReader();
      if (!readOnly) {
        await writer.write({ records: [{ recordType: 'url', data: cardUrl(config.appUrl, credential.code) }] }, { overwrite: true });
        setPhase('written');
        setMessage('URL gravada na etiqueta.');
      } else {
        await writer.makeReadOnly();
        setPhase('done');
        setMessage('Etiqueta protegida contra gravação.');
      }
    } catch (err) {
      setMessage(nfcErrorMessage(err));
      setPhase(readOnly ? 'written' : 'bound');
    }
  };

  const busy = phase === 'binding' || phase === 'writing' || phase === 'protecting';
  const stateText = (() => {
    if (!supported) return null;
    if (phase !== 'scan') return null;
    switch (nfc.state) {
      case 'listening':
        return 'Encoste a etiqueta NFC na parte de trás do celular…';
      case 'off':
        return 'Ligue o NFC nas configurações do aparelho e toque em “Ativar leitor”.';
      case 'blocked':
        return 'Permissão de NFC bloqueada. Libere nas permissões do site (cadeado na barra de endereço).';
      case 'paused':
        return 'Leitor pausado (volte para o app).';
      default:
        return 'Toque em “Ativar leitor” e encoste a etiqueta.';
    }
  })();

  return (
    <Modal open={open} onClose={onClose} title="Colar etiqueta NFC" dismissible={!busy}>
      {credential ? (
        <div className="stack">
          <p className="small">
            Carteirinha <strong className="code-text">{credential.code ? formatCode(credential.code) : '(sem código)'}</strong> de <strong>{credential.ownerName}</strong>.
            {credential.nfcUid ? <span className="muted"> Já tem uma etiqueta ({credential.nfcUid}); a nova substitui.</span> : null}
          </p>
          {!supported ? (
            <Banner kind="warn">
              A leitura de etiquetas NFC só funciona no <strong>Chrome para Android</strong>. Abra esta página no celular da portaria ou use a carteirinha só com QR Code.
            </Banner>
          ) : null}
          {supported && phase === 'scan' ? (
            <div className={`nfc-area${nfc.state === 'listening' ? ' nfc-area--listening' : nfc.state === 'off' || nfc.state === 'blocked' ? ' nfc-area--error' : ''}`} aria-live="polite">
              {nfc.state === 'listening' ? (
                <div className="pulse" aria-hidden="true">
                  📶
                </div>
              ) : null}
              <div className="nfc-area__title">{nfc.state === 'listening' ? 'Aguardando etiqueta' : 'Leitor NFC'}</div>
              <div className="nfc-area__hint">{stateText}</div>
              {nfc.state !== 'listening' ? (
                <Button variant="primary" className="mt" onClick={() => void nfc.start()}>
                  Ativar leitor
                </Button>
              ) : null}
            </div>
          ) : null}
          {phase === 'binding' ? <Banner kind="info">Gravando a etiqueta {uid} na carteirinha…</Banner> : null}
          {phase === 'bound' || phase === 'written' || phase === 'done' || phase === 'writing' || phase === 'protecting' ? (
            <Banner kind="success">
              Etiqueta <code>{bound?.nfcUid ?? uid}</code> colada à carteirinha. A portaria já reconhece esta etiqueta.
            </Banner>
          ) : null}
          {(phase === 'bound' || phase === 'writing') && credential.code ? (
            <div className="stack stack--sm">
              <p className="small">
                Opcional: gravar o endereço da carteirinha na etiqueta, para que qualquer celular com NFC abra a página <code>/c/{formatCode(credential.code)}</code>. Mantenha a etiqueta encostada.
              </p>
              <Button variant="neutral" loading={phase === 'writing'} onClick={() => void writeTag(false)}>
                Gravar URL na etiqueta
              </Button>
            </div>
          ) : null}
          {phase === 'written' || phase === 'protecting' ? (
            <div className="stack stack--sm">
              <p className="small">Opcional e irreversível: proteger a etiqueta contra novas gravações. Mantenha a etiqueta encostada.</p>
              <Button variant="danger" loading={phase === 'protecting'} onClick={() => void writeTag(true)}>
                Proteger contra gravação
              </Button>
            </div>
          ) : null}
          {message ? <Banner kind={phase === 'scan' || phase === 'bound' ? 'warn' : 'info'}>{message}</Banner> : null}
          <div className="sheet__actions">
            <Button variant={phase === 'scan' ? 'neutral' : 'primary'} onClick={onClose} disabled={busy}>
              {phase === 'scan' ? 'Cancelar' : 'Concluir'}
            </Button>
          </div>
        </div>
      ) : null}
    </Modal>
  );
}
