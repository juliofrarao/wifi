import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { addDays, SHIFT_LABELS, type AttendanceEventDTO, type ChildAdminDTO, type DailyReport } from '@creche/shared';
import { classNames } from '../../admin/childFilters';
import { downloadEventsCsv, downloadFrequencyCsv, getDailyReport, getFrequencyReport, listChildren } from '../../api/endpoints';
import { describeError } from '../../api/client';
import { AdminShell } from '../../components/AppShell';
import { Banner } from '../../components/Banner';
import { Button } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { EventRow, eventWho } from '../../components/EventRow';
import { QueryState } from '../../components/QueryState';
import { Tabs } from '../../components/Tabs';
import { SelectField, TextField } from '../../components/TextField';
import { useToast } from '../../components/Toast';
import { VoidEventDialog } from '../../components/VoidEventDialog';
import { saveBlob } from '../../lib/download';
import { useFormat } from '../../lib/format';
import { useAsync } from '../../lib/useAsync';
import { LogoutButton } from '../LogoutButton';

type Tab = 'dia' | 'frequencia' | 'exportar';
const MAX_EXPORT_DAYS = 366;

export function RelatoriosPage() {
  const [tab, setTab] = useState<Tab>('dia');
  return (
    <AdminShell title="Relatórios" headerActions={<LogoutButton />}>
      <div className="stack">
        <Tabs<Tab>
          items={[
            { key: 'dia', label: 'Dia' },
            { key: 'frequencia', label: 'Frequência mensal' },
            { key: 'exportar', label: 'Exportar CSV' },
          ]}
          value={tab}
          onChange={setTab}
        />
        {tab === 'dia' ? <DailyTab /> : tab === 'frequencia' ? <FrequencyTab /> : <ExportTab />}
      </div>
    </AdminShell>
  );
}

function EventSection({ title, events, onVoid }: { title: string; events: AttendanceEventDTO[]; onVoid: (ev: AttendanceEventDTO) => void }) {
  if (events.length === 0) return null;
  return (
    <section className="card">
      <h2 className="card__title">
        {title} ({events.length})
      </h2>
      <div className="list">
        {events.map((ev) => (
          <EventRow key={ev.id} event={ev} childLink onVoid={ev.voidedAt ? undefined : onVoid} showDocument />
        ))}
      </div>
    </section>
  );
}

function DailyTab() {
  const fmt = useFormat();
  const today = fmt.today();
  const [date, setDate] = useState(today);
  const [className, setClassName] = useState('');
  const report = useAsync(() => getDailyReport(date), [date]);
  const [voidFor, setVoidFor] = useState<AttendanceEventDTO | null>(null);
  const r: DailyReport | null = report.data;
  const classes = useMemo(() => classNames(r?.rows.map((x) => x.child) ?? []), [r]);
  const rows = useMemo(() => (r?.rows ?? []).filter((x) => !className || x.child.className === className).sort((a, b) => (a.child.className ?? '').localeCompare(b.child.className ?? '', 'pt-BR') || a.child.name.localeCompare(b.child.name, 'pt-BR')), [r, className]);
  const pending = rows.filter((x) => x.pending);
  const absent = (r?.absent ?? []).filter((x) => !className || x.className === className);

  return (
    <div className="stack">
      <div className="filters no-print">
        <TextField label="Dia" type="date" value={date} max={today} onChange={(e) => setDate(e.target.value || today)} data-testid="report-date" />
        <SelectField label="Turma" value={className} onChange={(e) => setClassName(e.target.value)}>
          <option value="">Todas</option>
          {classes.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </SelectField>
        <div className="row filters__actions">
          <Button variant="neutral" size="sm" onClick={() => setDate(addDays(date, -1))}>
            ‹ Dia anterior
          </Button>
          <Button variant="neutral" size="sm" onClick={() => setDate(addDays(date, 1))} disabled={date >= today}>
            Dia seguinte ›
          </Button>
          <Button variant="neutral" size="sm" icon="🖨️" onClick={() => window.print()}>
            Imprimir
          </Button>
        </div>
      </div>
      <QueryState loading={report.loading} error={report.error} onRetry={report.reload} hasData={r !== null}>
        {r ? (
          <div className="stack">
            <h2>
              Relatório do dia {fmt.civil(r.date)}
              {className ? ` · ${className}` : ''}
            </h2>
            <div className="stat-grid stat-grid--compact">
              <div className="stat">
                <span className="stat__value">{rows.filter((x) => x.checkin).length}</span>
                <span className="stat__label">entradas</span>
              </div>
              <div className="stat stat--saida">
                <span className="stat__value">{rows.filter((x) => x.checkout).length}</span>
                <span className="stat__label">saídas</span>
              </div>
              <div className={`stat${pending.length > 0 ? ' stat--warn' : ''}`}>
                <span className="stat__value">{pending.length}</span>
                <span className="stat__label">sem saída</span>
              </div>
              <div className="stat">
                <span className="stat__value">{absent.length}</span>
                <span className="stat__label">faltas</span>
              </div>
            </div>
            {rows.length === 0 ? <EmptyState icon="📅" title="Nenhum registro neste dia" /> : null}
            {rows.length > 0 ? (
              <div className="table-wrap">
                <table className="table" data-testid="daily-table">
                  <thead>
                    <tr>
                      <th>Criança</th>
                      <th>Turma</th>
                      <th>Entrada</th>
                      <th>Quem deixou</th>
                      <th>Saída</th>
                      <th>Quem retirou</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((x) => (
                      <tr key={x.child.id} className={x.pending ? 'table__row--warn' : ''} data-testid={`daily-row-${x.child.id}`}>
                        <td>
                          <Link to={`/admin/criancas/${x.child.id}`}>{x.child.name}</Link>
                        </td>
                        <td>
                          {x.child.className ?? ''}
                          {x.child.shift ? ` · ${SHIFT_LABELS[x.child.shift]}` : ''}
                        </td>
                        <td>
                          {x.checkin ? fmt.time(x.checkin.occurredAt) : '—'}
                          {x.checkin?.override ? ' ⚠️' : ''}
                        </td>
                        <td>{x.checkin ? eventWho(x.checkin) : ''}</td>
                        <td>
                          {x.checkout ? fmt.time(x.checkout.occurredAt) : x.pending ? <span className="badge badge--warn">sem saída</span> : '—'}
                          {x.checkout?.override ? ' ⚠️' : ''}
                        </td>
                        <td>
                          {x.checkout ? eventWho(x.checkout) : ''}
                          {x.checkout?.authorizedByName ? ` (${x.checkout.authorizedByName})` : ''}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
            {absent.length > 0 ? (
              <section className="card">
                <h2 className="card__title">Faltas ({absent.length})</h2>
                <div className="row">
                  {absent.map((a) => (
                    <Link key={a.id} to={`/admin/criancas/${a.id}`} className="chip">
                      {a.name}
                      {a.absentStreakDays >= 2 ? <span className="tiny muted"> · {a.absentStreakDays} dias</span> : null}
                    </Link>
                  ))}
                </div>
              </section>
            ) : null}
            <EventSection title="Exceções (retirada fora da lista)" events={r.overrides} onVoid={setVoidFor} />
            <EventSection title="Conflitos da fila" events={r.conflicts} onVoid={setVoidFor} />
            <EventSection title="Tentativas recusadas" events={r.denied} onVoid={setVoidFor} />
            <EventSection title="Registros cancelados" events={r.voided} onVoid={setVoidFor} />
          </div>
        ) : null}
      </QueryState>
      <VoidEventDialog
        event={voidFor}
        onClose={() => setVoidFor(null)}
        onVoided={() => {
          setVoidFor(null);
          report.reload();
        }}
      />
    </div>
  );
}

function FrequencyTab() {
  const fmt = useFormat();
  const toast = useToast();
  const [month, setMonth] = useState(fmt.today().slice(0, 7));
  const [className, setClassName] = useState('');
  const [downloading, setDownloading] = useState(false);
  const children = useAsync(() => listChildren<ChildAdminDTO>({}), []);
  const classes = useMemo(() => classNames(children.data ?? []), [children.data]);
  const report = useAsync(() => getFrequencyReport(month, className || undefined), [month, className]);
  const rows = useMemo(() => [...(report.data?.rows ?? [])].sort((a, b) => (a.child.className ?? '').localeCompare(b.child.className ?? '', 'pt-BR') || a.child.name.localeCompare(b.child.name, 'pt-BR')), [report.data]);

  const download = async () => {
    setDownloading(true);
    try {
      const { blob, filename } = await downloadFrequencyCsv(month, className || undefined);
      saveBlob(blob, filename ?? `frequencia-${month}${className ? `-${className}` : ''}.csv`);
    } catch (err) {
      toast.show(describeError(err), 'danger', 5000);
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="stack">
      <div className="filters no-print">
        <TextField label="Mês" type="month" value={month} max={fmt.today().slice(0, 7)} onChange={(e) => setMonth(e.target.value || fmt.today().slice(0, 7))} />
        <SelectField label="Turma" value={className} onChange={(e) => setClassName(e.target.value)}>
          <option value="">Todas</option>
          {classes.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </SelectField>
        <div className="row filters__actions">
          <Button variant="neutral" size="sm" icon="⬇️" loading={downloading} onClick={() => void download()} data-testid="frequency-csv">
            Baixar CSV
          </Button>
          <Button variant="neutral" size="sm" icon="🖨️" onClick={() => window.print()}>
            Imprimir
          </Button>
        </div>
      </div>
      <QueryState loading={report.loading} error={report.error} onRetry={report.reload} hasData={report.data !== null}>
        {report.data ? (
          <div className="stack">
            <h2>
              Frequência de {report.data.month.split('-').reverse().join('/')}
              {className ? ` · ${className}` : ''}
            </h2>
            <p className="small muted">
              {report.data.schoolDays} dia(s) letivo(s) no mês (dias com pelo menos uma entrada registrada na creche).
            </p>
            {rows.length === 0 ? <EmptyState icon="📈" title="Nenhuma criança no filtro" /> : null}
            {rows.length > 0 ? (
              <div className="table-wrap">
                <table className="table" data-testid="frequency-table">
                  <thead>
                    <tr>
                      <th>Criança</th>
                      <th>Turma</th>
                      <th>Presenças</th>
                      <th>Faltas</th>
                      <th>Faltas seguidas</th>
                      <th>%</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr key={row.child.id} className={row.percent < 75 ? 'table__row--warn' : ''}>
                        <td>
                          <Link to={`/admin/criancas/${row.child.id}`}>{row.child.name}</Link>
                        </td>
                        <td>{row.child.className ?? ''}</td>
                        <td>{row.daysPresent}</td>
                        <td>{row.absences}</td>
                        <td>{row.absentStreakDays > 0 ? row.absentStreakDays : ''}</td>
                        <td>
                          <strong>{Math.round(row.percent)}%</strong>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </div>
        ) : null}
      </QueryState>
    </div>
  );
}

function ExportTab() {
  const fmt = useFormat();
  const toast = useToast();
  const today = fmt.today();
  const [from, setFrom] = useState(addDays(today, -30));
  const [to, setTo] = useState(today);
  const [busy, setBusy] = useState(false);
  const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
  const invalid = !from || !to || to < from || days > MAX_EXPORT_DAYS;

  const download = async () => {
    setBusy(true);
    try {
      const { blob, filename } = await downloadEventsCsv({ from, to });
      saveBlob(blob, filename ?? `eventos-${from}-a-${to}.csv`);
    } catch (err) {
      toast.show(describeError(err), 'danger', 5000);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <section className="card stack">
        <h2 className="card__title">Exportar eventos (CSV)</h2>
        <p className="small muted">
          Todos os eventos do período, um por linha, separados por ponto e vírgula (abre no Excel/LibreOffice). Inclui exceções, conflitos, cancelados e o documento de terceiros. Máximo de{' '}
          {MAX_EXPORT_DAYS} dias.
        </p>
        <div className="grid-2">
          <TextField label="De" type="date" value={from} max={to || today} onChange={(e) => setFrom(e.target.value)} />
          <TextField label="Até" type="date" value={to} min={from || undefined} max={today} onChange={(e) => setTo(e.target.value)} />
        </div>
        {to < from ? <Banner kind="danger">A data final é anterior à inicial.</Banner> : days > MAX_EXPORT_DAYS ? <Banner kind="danger">Período maior que {MAX_EXPORT_DAYS} dias.</Banner> : null}
        <Button variant="primary" icon="⬇️" loading={busy} disabled={invalid} onClick={() => void download()} data-testid="events-csv">
          Baixar CSV ({Number.isFinite(days) ? days : 0} dia(s))
        </Button>
      </section>
    </div>
  );
}
