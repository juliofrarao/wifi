import type { InviteResult } from '@creche/shared';
import { useFormat } from '../lib/format';
import { copyText } from '../lib/download';
import { Banner } from './Banner';
import { Button } from './Button';
import { Modal } from './Modal';
import { QrCodeImage } from './QrCodeImage';
import { useToast } from './Toast';

/**
 * Shows an invite / password-reset link (spec §4.6): whether the e-mail was
 * sent, a WhatsApp button, a QR for the counter and a copy button.
 */
export function InviteSheet({ invite, personName, onClose }: { invite: InviteResult | null; personName: string; onClose: () => void }) {
  const fmt = useFormat();
  const toast = useToast();
  const isReset = invite?.kind === 'reset';
  return (
    <Modal open={invite !== null} onClose={onClose} title={isReset ? 'Link para redefinir a senha' : 'Convite para o app'}>
      {invite ? (
        <div className="stack">
          {invite.sent ? (
            <Banner kind="success">E-mail enviado para {personName}. Você também pode compartilhar o link abaixo.</Banner>
          ) : (
            <Banner kind="info">
              {isReset ? 'Envie este link para ' : 'Nenhum e-mail foi enviado. Envie o convite para '}
              {personName} por WhatsApp ou mostre o QR Code no balcão.
            </Banner>
          )}
          <div className="center">
            <QrCodeImage value={invite.inviteUrl} size={220} alt="QR Code do link de convite" className="qr-inline" />
            <p className="tiny muted mt">Válido até {fmt.dateTime(invite.expiresAt)}.</p>
          </div>
          <div className="link-box">
            <code className="ellipsis">{invite.inviteUrl}</code>
          </div>
          <div className="row">
            {invite.whatsappUrl ? (
              <a className="btn btn--entrada grow" href={invite.whatsappUrl} target="_blank" rel="noopener noreferrer">
                Enviar por WhatsApp
              </a>
            ) : null}
            <Button
              variant="neutral"
              className="grow"
              onClick={async () => {
                const ok = await copyText(invite.inviteUrl);
                toast.show(ok ? 'Link copiado.' : 'Não foi possível copiar o link.', ok ? 'success' : 'danger');
              }}
            >
              Copiar link
            </Button>
          </div>
          {!invite.whatsappUrl ? <p className="tiny muted">Cadastre um telefone celular para enviar por WhatsApp.</p> : null}
        </div>
      ) : null}
      <div className="sheet__actions">
        <Button variant="primary" onClick={onClose}>
          Fechar
        </Button>
      </div>
    </Modal>
  );
}
