import { useState } from 'react';
import { addDays, EVENT_TYPE_LABELS, METHOD_LABELS, relationshipLabel, type AttendanceEventDTO, type EventType } from '@creche/shared';
import { listEvents, voidEvent } from '../../api/endpoints';
import { describeError } from '../../api/client';
import { Banner } from '../../components/Banner';
import { Button } from '../../components/Button';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { EmptyState } from '../../components/EmptyState';
import { GateShell } from '../../components/AppShell';
import { Spinner } from '../../components/Spinner';
import { SelectField, TextField } from '../../components/TextField';
import { useToast } from '../../components/Toast';
import { useFormat } from '../../lib/format';
import { useAsync } from '../../lib/useAsync';
import { refreshDirectory } from '../directory';
import { useGate } from '../GateProvider';
import { voidLocalEventByServerId } from '../status';

const VOID_WINDOW_MS = 24 * 60 * 60 * 1000;

export function HistoricoPage() {
  const gate = useGate();
  const fmt = useFormat();
  const toast = useToast();
  const [from, setFrom] = useState(() => addDays(gate.today, -6));
  const [to, setTo] = useState(gate.today);
  const [type, setType] = useState<EventType | ''>('');
  const [includeVoided, setIncludeVoided] = useState(false);
  const [cancelFor, setCancelFor] = useState<AttendanceEventDTO | null>(null);
  const events = useAsync(() => listEvents({ from, to, type: type || undefined, includeVoided: includeVoided || undefined, limit: 300 }), [from, to, type, includeVoided]);

  const minFrom = addDays(gate.today, -6);

  return (
    <GateShell>
      <div className="stack">
        <div className="page-title">
          <h1>Histórico</h1>
          <Button variant="neutral" size="sm" onClick={events.reload} loading={events.loading}>
            Atualizar
          </Button>
        </div>
        <div className="grid-2">
          <TextField label="De" type="date" value={from} min={minFrom} max={gate.today} onChange={(e) => setFrom(e.target.value || minFrom)} />
          <TextField label="Até" type="date" value={to} min={minFrom} max={gate.today} onChange={(e) => setTo(e.target.value || gate.today)} />
        </div>
        <div className="grid-2">
          <SelectField label="Tipo" value={type} onChange={(e) => setType(e.target.value as EventType | '')}>
            <option value="">Todos</option>
            <option value="checkin">Entradas</option>
            <option value="checkout">Saídas</option>
            <option value="denied">Recusas</option>
          </SelectField>
          <SelectField label="Cancelados" value={includeVoided ? '1' : '0'} onChange={(e) => setIncludeVoided(e.target.value === '1')}>
            <option value="0">Ocultar</option>
            <option value="1">Mostrar</option>
          </SelectField>
        </div>
        <p className="tiny muted">A portaria vê os últimos 7 dias e pode cancelar registros feitos há menos de 24 h.</p>

        {events.error ? <Banner kind="danger">{events.error}</Banner> : null}
        {events.loading && !events.data ? <Spinner block label="Carregando…" /> : null}
        <div className="list" data-testid="history-list">
          {events.data && events.data.items.length === 0 ? <EmptyState icon="🗓️" title="Nenhum registro no período" /> : null}
          {events.data?.items.map((ev) => {
            const voidable = !ev.voidedAt && Date.now() - Date.parse(ev.occurredAt) < VOID_WINDOW_MS;
            const who = ev.guardianName ? `${ev.guardianName}${ev.guardianRelationship ? ` (${relationshipLabel(ev.guardianRelationship).toLowerCase()})` : ''}` : ev.personName ? `${ev.personName} (não cadastrada)` : '';
            return (
              <div key={ev.id} className={`list-item${ev.override || ev.conflict ? ' list-item--danger' : ''}`} data-testid={`history-event-${ev.id}`}>
                <span className={`badge ${ev.type === 'checkin' ? 'badge--ok' : ev.type === 'checkout' ? 'badge--saida' : 'badge--danger'}`}>{EVENT_TYPE_LABELS[ev.type]}</span>
                <span className="list-item__body">
                  <span className="list-item__title">{ev.childName}</span>
                  <span className="list-item__sub">
                    {fmt.dateTime(ev.occurredAt)}
                    {who ? ` · ${who}` : ''}
                    {ev.authorizedByName ? ` · ${ev.authorizedByName}` : ''}
                    {' · '}
                    {METHOD_LABELS[ev.method]} · {ev.guardName}
                  </span>
                  <span className="row">
                    {ev.override ? <span className="badge badge--danger">exceção</span> : null}
                    {ev.conflict ? <span className="badge badge--warn">conflito: {ev.conflict === 'already_present' ? 'já estava na creche' : 'já estava fora'}</span> : null}
                    {ev.queued ? <span className="badge">da fila</span> : null}
                    {ev.voidedAt ? <span className="badge badge--danger">cancelado{ev.voidReason ? `: ${ev.voidReason}` : ''}</span> : null}
                    {ev.note ? <span className="tiny muted">{ev.note}</span> : null}
                  </span>
                </span>
                {voidable ? (
                  <Button variant="ghost" size="sm" onClick={() => setCancelFor(ev)} aria-label={`Cancelar registro de ${ev.childName}`}>
                    Cancelar
                  </Button>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>

      <ConfirmDialog
        open={cancelFor !== null}
        title="Cancelar registro"
        confirmLabel="Cancelar registro"
        cancelLabel="Voltar"
        reason={{ label: 'Motivo', minLength: 3, placeholder: 'Ex.: toque errado' }}
        onCancel={() => setCancelFor(null)}
        onConfirm={async (reason) => {
          if (!cancelFor) return;
          try {
            await voidEvent(cancelFor.id, reason);
            await voidLocalEventByServerId(cancelFor.id);
            toast.show('Registro cancelado.', 'success');
            setCancelFor(null);
            events.reload();
            void refreshDirectory('void', true);
          } catch (err) {
            throw new Error(describeError(err));
          }
        }}
      >
        {cancelFor ? (
          <p>
            {cancelFor.childName}: {EVENT_TYPE_LABELS[cancelFor.type].toLowerCase()} em {fmt.dateTime(cancelFor.occurredAt)}. Os responsáveis receberão “Registro cancelado”.
          </p>
        ) : null}
      </ConfirmDialog>
    </GateShell>
  );
}
