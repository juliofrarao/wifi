import { EVENT_TYPE_LABELS, type AttendanceEventDTO } from '@creche/shared';
import { voidEvent } from '../api/endpoints';
import { describeError } from '../api/client';
import { useFormat } from '../lib/format';
import { ConfirmDialog } from './ConfirmDialog';
import { useToast } from './Toast';

/** "Cancelar registro" with a required reason (admin: any event, any age). */
export function VoidEventDialog({ event, onClose, onVoided }: { event: AttendanceEventDTO | null; onClose: () => void; onVoided: (ev: AttendanceEventDTO) => void }) {
  const fmt = useFormat();
  const toast = useToast();
  return (
    <ConfirmDialog
      open={event !== null}
      title="Cancelar registro"
      confirmLabel="Cancelar registro"
      cancelLabel="Voltar"
      reason={{ label: 'Motivo', minLength: 3, placeholder: 'Ex.: lançamento errado' }}
      onCancel={onClose}
      onConfirm={async (reason) => {
        if (!event) return;
        try {
          const voided = await voidEvent(event.id, reason);
          toast.show('Registro cancelado.', 'success');
          onVoided(voided);
        } catch (err) {
          throw new Error(describeError(err));
        }
      }}
    >
      {event ? (
        <p>
          {event.childName}: {EVENT_TYPE_LABELS[event.type].toLowerCase()} em {fmt.dateTime(event.occurredAt)}. Os responsáveis receberão “Registro cancelado”; o registro continua no histórico
          como cancelado.
        </p>
      ) : null}
    </ConfirmDialog>
  );
}
