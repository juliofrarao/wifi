import { useEffect, useState } from 'react';
import { joinNames } from '@creche/shared';
import { Button } from '../../components/Button';
import { useToast } from '../../components/Toast';
import { formatCountdown, useFormat } from '../../lib/format';
import { useNow } from '../../lib/useNow';
import { VIBRATE, vibrate } from '../../lib/vibrate';
import type { SuccessInfo } from '../flow';
import { forgetSuccess } from '../flow';
import { getQueueItem, useQueue } from '../queue';
import { performUndo, undoActive, useUndo } from '../undo';

const AUTO_CLOSE_MS = 3000;

/**
 * Full-screen success (green ENTRADA / orange SAÍDA / red recusa) with names,
 * time, "Desfazer" countdown and the sending indicator. Closes on tap or 3 s.
 */
export function SuccessOverlay({ info, onClose }: { info: SuccessInfo; onClose: () => void }) {
  const fmt = useFormat();
  const toast = useToast();
  const undo = useUndo();
  const now = useNow(500);
  const { items } = useQueue();
  const [undoing, setUndoing] = useState(false);
  const item = items.find((i) => i.batchId === info.batchId) ?? getQueueItem(info.batchId);

  useEffect(() => {
    vibrate(info.type === 'checkin' ? VIBRATE.checkin : info.type === 'checkout' ? VIBRATE.checkout : VIBRATE.error);
  }, [info.type]);

  useEffect(() => {
    if (undoing) return;
    const t = setTimeout(onClose, AUTO_CLOSE_MS);
    return () => clearTimeout(t);
  }, [onClose, undoing]);

  const canUndo = undo?.batchId === info.batchId && undoActive(undo, now);
  const remaining = undo ? Date.parse(undo.undoUntil) - now : 0;
  const title = info.type === 'checkin' ? 'ENTRADA registrada' : info.type === 'checkout' ? 'SAÍDA registrada' : 'Recusa registrada';
  const icon = info.type === 'checkin' ? '⬇' : info.type === 'checkout' ? '⬆' : '⛔';
  const sending = !item || item.status === 'pending' || item.status === 'sending';
  const statusText =
    item?.status === 'sent'
      ? 'enviado ✓'
      : item?.status === 'needs_login'
        ? 'aguardando login'
        : item?.status === 'rejected'
          ? 'não aplicado — veja em Hoje'
          : 'enviando…';

  const handleUndo = async () => {
    setUndoing(true);
    const result = await performUndo();
    toast.show(result.message, result.ok ? 'success' : 'danger');
    if (result.ok) forgetSuccess();
    setUndoing(false);
    onClose();
  };

  return (
    <div
      className={`success-screen success-screen--${info.type}`}
      data-testid="success-screen"
      role="dialog"
      aria-live="assertive"
      aria-label={title}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="success-screen__icon" aria-hidden="true">
        {icon}
      </div>
      <div className="success-screen__title">{title}</div>
      <div className="success-screen__names">{joinNames(info.childNames, 4)}</div>
      <div className="success-screen__time">
        {fmt.time(info.at)} · {info.personName}
      </div>
      <div className="success-screen__status" aria-live="polite">
        {sending ? <span className="spinner" aria-hidden="true" /> : null} {statusText}
      </div>
      <div className="row" onClick={(e) => e.stopPropagation()}>
        {canUndo ? (
          <Button variant="neutral" size="big" onClick={() => void handleUndo()} loading={undoing} data-testid="success-undo">
            Desfazer ({formatCountdown(remaining)})
          </Button>
        ) : null}
        <Button variant="neutral" size="big" onClick={onClose} data-testid="success-close">
          Fechar
        </Button>
      </div>
    </div>
  );
}
