import { useMemo, useState } from 'react';
import { relationshipLabel, SHIFT_LABELS } from '@creche/shared';
import { Banner } from '../../components/Banner';
import { Button } from '../../components/Button';
import { GateShell } from '../../components/AppShell';
import { SelectField } from '../../components/TextField';
import { useConfig } from '../../config/ConfigProvider';
import { useFormat } from '../../lib/format';
import { useGate } from '../GateProvider';
import { classNamesOf } from '../lookup';

/** Printable attendance sheet by class, generated from the directory (spec §4.9). */
export function FolhaPage() {
  const gate = useGate();
  const { config } = useConfig();
  const fmt = useFormat();
  const dir = gate.directory.directory;
  const classes = useMemo(() => classNamesOf(dir), [dir]);
  const [className, setClassName] = useState('');

  const groups = useMemo(() => {
    const children = (dir?.children ?? []).filter((c) => c.active && (!className || c.className === className));
    const map = new Map<string, typeof children>();
    for (const c of children) {
      const key = c.className ?? 'Sem turma';
      const list = map.get(key) ?? [];
      list.push(c);
      map.set(key, list);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0], 'pt-BR')).map(([key, list]) => [key, list.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'))] as const);
  }, [dir, className]);

  return (
    <GateShell>
      <div className="stack">
        <div className="page-title no-print">
          <h1>Folha de presença</h1>
          <Button variant="primary" icon="🖨️" onClick={() => window.print()} disabled={!dir}>
            Imprimir
          </Button>
        </div>
        <div className="no-print">
          <SelectField label="Turma" value={className} onChange={(e) => setClassName(e.target.value)}>
            <option value="">Todas as turmas</option>
            {classes.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </SelectField>
          <p className="tiny muted">Depois, a secretaria lança a folha em “Lançar folha” no painel.</p>
        </div>
        {!dir ? <Banner kind="warn">Diretório ainda não baixado.</Banner> : null}
        {groups.map(([group, list]) => (
          <section key={group} className="print-page card">
            <h2>
              {config.daycareName} — Folha de presença · {group}
            </h2>
            <p className="small">
              Data: {fmt.civil(gate.today)} · {list.length} criança(s) · Responsável pela folha: ____________________
            </p>
            <div className="table-wrap">
              <table className="table table--sheet">
                <thead>
                  <tr>
                    <th>Criança</th>
                    <th>Turno</th>
                    <th>Entrada</th>
                    <th>Quem deixou</th>
                    <th>Saída</th>
                    <th>Quem retirou</th>
                    <th>Assinatura</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((c) => (
                    <tr key={c.id}>
                      <td>
                        <strong>{c.name}</strong>
                        <br />
                        <span className="tiny muted">{c.guardians.filter((g) => !g.blocked).map((g) => `${g.name.split(' ')[0]} (${(g.relationshipLabel || relationshipLabel(g.relationship)).toLowerCase()})`).join(', ')}</span>
                      </td>
                      <td>{c.shift ? SHIFT_LABELS[c.shift] : ''}</td>
                      <td>__ : __</td>
                      <td />
                      <td>__ : __</td>
                      <td />
                      <td />
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ))}
      </div>
    </GateShell>
  );
}
