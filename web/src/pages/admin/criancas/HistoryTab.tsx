import { useMemo, useState } from 'react';
import { addDays, type AttendanceEventDTO, type EventType } from '@creche/shared';
import { listEvents } from '../../../api/endpoints';
import { describeError } from '../../../api/client';
import { Button } from '../../../components/Button';
import { SimpleCheckbox } from '../../../components/CheckboxRow';
import { EmptyState } from '../../../components/EmptyState';
import { EventRow } from '../../../components/EventRow';
import { QueryState } from '../../../components/QueryState';
import { SelectField, TextField } from '../../../components/TextField';
import { useToast } from '../../../components/Toast';
import { VoidEventDialog } from '../../../components/VoidEventDialog';
import { useFormat } from '../../../lib/format';
import { useAsync } from '../../../lib/useAsync';

const PAGE = 100;

/** Histórico tab (admin): filters, paging, void with reason. */
export function HistoryTab({ childId, onChanged }: { childId: string; onChanged: () => void }) {
  const fmt = useFormat();
  const toast = useToast();
  const today = fmt.today();
  const [from, setFrom] = useState(addDays(today, -30));
  const [to, setTo] = useState(today);
  const [type, setType] = useState<EventType | ''>('');
  const [includeVoided, setIncludeVoided] = useState(true);
  const [extra, setExtra] = useState<AttendanceEventDTO[]>([]);
  const [offset, setOffset] = useState(0);
  const [more, setMore] = useState(false);
  const [voidFor, setVoidFor] = useState<AttendanceEventDTO | null>(null);
  const query = useMemo(() => ({ childId, from: from || undefined, to: to || undefined, type: type || undefined, includeVoided: includeVoided || undefined, limit: PAGE }), [childId, from, to, type, includeVoided]);
  const events = useAsync(async () => {
    setExtra([]);
    setOffset(0);
    return listEvents({ ...query, offset: 0 });
  }, [query]);
  const all = useMemo(() => [...(events.data?.items ?? []), ...extra], [events.data, extra]);
  const total = events.data?.total ?? 0;

  const loadMore = async () => {
    const next = offset + PAGE;
    setMore(true);
    try {
      const page = await listEvents({ ...query, offset: next });
      setExtra((prev) => [...prev, ...page.items]);
      setOffset(next);
    } catch (err) {
      toast.show(describeError(err), 'danger');
    } finally {
      setMore(false);
    }
  };

  return (
    <div className="stack">
      <div className="filters">
        <TextField label="De" type="date" value={from} max={to || today} onChange={(e) => setFrom(e.target.value)} />
        <TextField label="Até" type="date" value={to} min={from || undefined} max={today} onChange={(e) => setTo(e.target.value)} />
        <SelectField label="Tipo" value={type} onChange={(e) => setType(e.target.value as EventType | '')}>
          <option value="">Todos</option>
          <option value="checkin">Entradas</option>
          <option value="checkout">Saídas</option>
          <option value="denied">Recusas</option>
        </SelectField>
      </div>
      <SimpleCheckbox checked={includeVoided} onChange={setIncludeVoided} label="Mostrar registros cancelados" />
      <QueryState loading={events.loading} error={events.error} onRetry={events.reload} hasData={events.data !== null}>
        <p className="small muted">{total} registro(s)</p>
        {all.length === 0 ? <EmptyState icon="🗓️" title="Nenhum registro no período" /> : null}
        <div className="list" data-testid="child-history">
          {all.map((ev) => (
            <EventRow key={ev.id} event={ev} showChild={false} onVoid={setVoidFor} showDocument testId={`child-event-${ev.id}`} />
          ))}
        </div>
        {all.length < total ? (
          <Button variant="neutral" onClick={() => void loadMore()} loading={more}>
            Carregar mais ({total - all.length} restantes)
          </Button>
        ) : null}
      </QueryState>
      <VoidEventDialog
        event={voidFor}
        onClose={() => setVoidFor(null)}
        onVoided={() => {
          setVoidFor(null);
          events.reload();
          onChanged();
        }}
      />
    </div>
  );
}
