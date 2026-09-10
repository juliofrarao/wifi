import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { type ChildAdminDTO } from '@creche/shared';
import { OTHER_PERSON, buildBackfillRows, emptyRow, mapBackfillResults, personOptions, type BackfillRowInput, type RowOutcome } from '../../admin/backfillLogic';
import { classNames } from '../../admin/childFilters';
import { backfill, listChildren } from '../../api/endpoints';
import { AdminShell } from '../../components/AppShell';
import { Banner } from '../../components/Banner';
import { Button } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { QueryState } from '../../components/QueryState';
import { SelectField, TextField } from '../../components/TextField';
import { useToast } from '../../components/Toast';
import { useConfig } from '../../config/ConfigProvider';
import { formError } from '../../lib/form';
import { useFormat } from '../../lib/format';
import { useAsync } from '../../lib/useAsync';
import { LogoutButton } from '../LogoutButton';

/** "Lançar folha": type the paper attendance sheet (spec §4.9) → POST /attendance/backfill. */
export function LancarPage() {
  const fmt = useFormat();
  const toast = useToast();
  const { config } = useConfig();
  const today = fmt.today();
  const [date, setDate] = useState(today);
  const [className, setClassName] = useState('');
  const [note, setNote] = useState('');
  const [inputs, setInputs] = useState<Record<string, BackfillRowInput>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [outcomes, setOutcomes] = useState<Record<string, RowOutcome>>({});
  const [warnings, setWarnings] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const children = useAsync(() => listChildren<ChildAdminDTO>({}), []);
  const classes = useMemo(() => classNames(children.data ?? []), [children.data]);
  const rows = useMemo(() => (children.data ?? []).filter((c) => c.active && (!className || c.className === className)).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR')), [children.data, className]);
  const options = useMemo(() => new Map(rows.map((c) => [c.id, personOptions(c, date)])), [rows, date]);

  useEffect(() => {
    setOutcomes({});
    setErrors({});
  }, [date, className]);

  const get = (id: string) => inputs[id] ?? emptyRow(id);
  const set = (id: string, patch: Partial<BackfillRowInput>) => setInputs((prev) => ({ ...prev, [id]: { ...get(id), ...patch } }));
  const filled = rows.filter((c) => get(c.id).checkinTime || get(c.id).checkoutTime).length;

  const submit = async () => {
    const built = buildBackfillRows(
      rows.map((c) => get(c.id)),
      options,
      date,
      config.timezone,
      note.trim() || `Folha de papel de ${fmt.civil(date)}`,
      () => crypto.randomUUID()
    );
    setErrors(built.errors);
    if (Object.keys(built.errors).length > 0) {
      toast.show('Corrija as linhas destacadas.', 'danger');
      return;
    }
    if (built.rows.length === 0) {
      toast.show('Preencha pelo menos um horário.', 'warn');
      return;
    }
    setBusy(true);
    try {
      const result = await backfill({ rows: built.rows });
      const mapped = mapBackfillResults(result, built.index);
      setOutcomes(mapped);
      setWarnings(result.warnings);
      const created = result.results.filter((r) => r.status === 'created').length;
      const rejected = result.results.filter((r) => r.status === 'rejected').length;
      toast.show(`${created} registro(s) lançado(s)${rejected ? `, ${rejected} recusado(s)` : ''}.`, rejected ? 'warn' : 'success', 6000);
      // Clear the rows that were accepted so a second submit does not duplicate them.
      setInputs((prev) => {
        const next = { ...prev };
        for (const [key, out] of Object.entries(mapped)) {
          if (out.status === 'rejected') continue;
          const [childId, type] = key.split('.');
          const row = next[childId];
          if (!row) continue;
          next[childId] = type === 'checkin' ? { ...row, checkinTime: '', checkinWho: '', checkinOther: '' } : { ...row, checkoutTime: '', checkoutWho: '', checkoutOther: '' };
        }
        return next;
      });
    } catch (err) {
      toast.show(formError(err), 'danger', 6000);
    } finally {
      setBusy(false);
    }
  };

  const outcomeBadge = (key: string) => {
    const o = outcomes[key];
    if (!o) return null;
    const cls = o.status === 'created' ? 'badge badge--ok' : o.status === 'duplicate' ? 'badge badge--info' : 'badge badge--danger';
    return (
      <span className={cls} data-testid={`backfill-outcome-${key}`} data-status={o.status}>
        {o.message}
      </span>
    );
  };

  return (
    <AdminShell title="Lançar folha" headerActions={<LogoutButton />}>
      <div className="stack">
        <p className="small muted">
          Digite a folha de presença de papel (impressa em <Link to="/portaria/folha">Portaria › Folha</Link>). Cada horário vira um registro com método “Manual”. Lançamentos com mais de 3 h
          de atraso avisam os responsáveis só no app e por e-mail.
        </p>
        <div className="filters">
          <TextField label="Dia da folha" type="date" value={date} max={today} onChange={(e) => setDate(e.target.value || today)} data-testid="backfill-date" />
          <SelectField label="Turma" value={className} onChange={(e) => setClassName(e.target.value)}>
            <option value="">Todas</option>
            {classes.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </SelectField>
          <TextField label="Observação (todas as linhas)" value={note} onChange={(e) => setNote(e.target.value)} placeholder={`Folha de papel de ${fmt.civil(date)}`} maxLength={1000} />
        </div>
        {warnings.length > 0 ? (
          <Banner kind="warn">
            {warnings.map((w) => (
              <div key={w}>{w}</div>
            ))}
          </Banner>
        ) : null}
        <QueryState loading={children.loading} error={children.error} onRetry={children.reload} hasData={children.data !== null}>
          {rows.length === 0 ? <EmptyState icon="📝" title="Nenhuma criança ativa na turma" /> : null}
          <div className="backfill-grid" data-testid="backfill-grid">
            {rows.map((c) => {
              const row = get(c.id);
              const opts = options.get(c.id) ?? [];
              const inErr = errors[`${c.id}.checkin`];
              const outErr = errors[`${c.id}.checkout`];
              return (
                <div key={c.id} className="card backfill-row" data-testid={`backfill-row-${c.id}`}>
                  <div className="backfill-row__child">
                    <strong>{c.name}</strong>
                    <span className="tiny muted"> {c.className ?? ''}</span>
                  </div>
                  <div className="backfill-row__event">
                    <span className="badge badge--ok">Entrada</span>
                    <input className="field__input backfill-row__time" type="time" value={row.checkinTime} onChange={(e) => set(c.id, { checkinTime: e.target.value })} aria-label={`Hora de entrada de ${c.name}`} aria-invalid={inErr ? true : undefined} />
                    <select className="field__input" value={row.checkinWho} onChange={(e) => set(c.id, { checkinWho: e.target.value })} aria-label={`Quem deixou ${c.name}`}>
                      <option value="">Quem deixou…</option>
                      {opts.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                    {row.checkinWho === OTHER_PERSON ? <input className="field__input" value={row.checkinOther} onChange={(e) => set(c.id, { checkinOther: e.target.value })} placeholder="Nome da pessoa" aria-label="Nome de quem deixou" /> : null}
                    {inErr ? <span className="field__error">{inErr}</span> : null}
                    {outcomeBadge(`${c.id}.checkin`)}
                  </div>
                  <div className="backfill-row__event">
                    <span className="badge badge--saida">Saída</span>
                    <input className="field__input backfill-row__time" type="time" value={row.checkoutTime} onChange={(e) => set(c.id, { checkoutTime: e.target.value })} aria-label={`Hora de saída de ${c.name}`} aria-invalid={outErr ? true : undefined} />
                    <select className="field__input" value={row.checkoutWho} onChange={(e) => set(c.id, { checkoutWho: e.target.value })} aria-label={`Quem retirou ${c.name}`}>
                      <option value="">Quem retirou…</option>
                      {opts.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                    {row.checkoutWho === OTHER_PERSON ? <input className="field__input" value={row.checkoutOther} onChange={(e) => set(c.id, { checkoutOther: e.target.value })} placeholder="Nome da pessoa" aria-label="Nome de quem retirou" /> : null}
                    {outErr ? <span className="field__error">{outErr}</span> : null}
                    {outcomeBadge(`${c.id}.checkout`)}
                  </div>
                </div>
              );
            })}
          </div>
        </QueryState>
        <div className="sticky-actions card row row--between">
          <span className="small">
            <strong>{filled}</strong> criança(s) com horário
          </span>
          <Button variant="primary" size="big" className="grow" loading={busy} disabled={filled === 0} onClick={() => void submit()} data-testid="backfill-submit">
            Lançar registros
          </Button>
        </div>
        <p className="tiny muted">
          Saída por autorização avulsa é lançada normalmente. Saída por "outra pessoa" ou por responsável sem permissão é lançada como exceção: escreva o motivo na observação (mínimo 10 caracteres) — os responsáveis e a direção recebem o alerta destacado.
        </p>
      </div>
    </AdminShell>
  );
}
