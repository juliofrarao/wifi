import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { SHIFTS, SHIFT_LABELS, type ChildAdminDTO, type Shift } from '@creche/shared';
import { CHILD_FLAGS, CHILD_FLAG_LABELS, classNames, filterChildren, hasConsent, hasReachableGuardian, type ChildFlag } from '../../../admin/childFilters';
import { createChild, listChildren } from '../../../api/endpoints';
import { AdminShell } from '../../../components/AppShell';
import { Avatar } from '../../../components/Avatar';
import { Button } from '../../../components/Button';
import { SimpleCheckbox } from '../../../components/CheckboxRow';
import { EmptyState } from '../../../components/EmptyState';
import { Modal } from '../../../components/Modal';
import { QueryState } from '../../../components/QueryState';
import { SelectField, TextField } from '../../../components/TextField';
import { useToast } from '../../../components/Toast';
import { useFormat } from '../../../lib/format';
import { useAsync } from '../../../lib/useAsync';
import { LogoutButton } from '../../LogoutButton';
import { ChildForm, valuesFromChild } from './ChildForm';

export function childStatusBadge(c: ChildAdminDTO): { label: string; cls: string } {
  if (!c.active) return { label: 'inativa', cls: 'badge' };
  if (c.status.present && c.status.stale) return { label: 'sem saída ontem', cls: 'badge badge--warn' };
  if (c.status.present) return { label: 'na creche', cls: 'badge badge--ok' };
  return { label: 'fora', cls: 'badge' };
}

export function CriancasPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const fmt = useFormat();
  const [params, setParams] = useSearchParams();
  const flag = (CHILD_FLAGS as readonly string[]).includes(params.get('f') ?? '') ? (params.get('f') as ChildFlag) : '';
  const [q, setQ] = useState(params.get('q') ?? '');
  const [className, setClassName] = useState(params.get('turma') ?? '');
  const [shift, setShift] = useState<Shift | ''>('');
  const [includeInactive, setIncludeInactive] = useState(false);
  const [creating, setCreating] = useState(false);
  const children = useAsync(() => listChildren<ChildAdminDTO>({ includeInactive: true }), []);

  const classes = useMemo(() => classNames(children.data ?? []), [children.data]);
  const filtered = useMemo(() => filterChildren(children.data ?? [], { q, className, shift, flag, includeInactive }), [children.data, q, className, shift, flag, includeInactive]);

  const setFlag = (f: ChildFlag | '') => {
    const next = new URLSearchParams(params);
    if (f) next.set('f', f);
    else next.delete('f');
    setParams(next, { replace: true });
  };

  return (
    <AdminShell
      title="Crianças"
      headerActions={
        <>
          <Button variant="primary" size="sm" icon="＋" onClick={() => setCreating(true)} data-testid="child-new">
            Nova criança
          </Button>
          <LogoutButton />
        </>
      }
    >
      <div className="stack">
        <div className="filters">
          <TextField label="Buscar" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Nome da criança ou do responsável" autoComplete="off" data-testid="children-search" />
          <SelectField label="Turma" value={className} onChange={(e) => setClassName(e.target.value)}>
            <option value="">Todas</option>
            {classes.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </SelectField>
          <SelectField label="Turno" value={shift} onChange={(e) => setShift(e.target.value as Shift | '')}>
            <option value="">Todos</option>
            {SHIFTS.map((s) => (
              <option key={s} value={s}>
                {SHIFT_LABELS[s]}
              </option>
            ))}
          </SelectField>
          <SelectField label="Situação" value={flag} onChange={(e) => setFlag(e.target.value as ChildFlag | '')}>
            <option value="">Todas</option>
            {CHILD_FLAGS.map((f) => (
              <option key={f} value={f}>
                {CHILD_FLAG_LABELS[f]}
              </option>
            ))}
          </SelectField>
        </div>
        <SimpleCheckbox checked={includeInactive} onChange={setIncludeInactive} label="Mostrar crianças desativadas" />

        <QueryState loading={children.loading} error={children.error} onRetry={children.reload} hasData={children.data !== null}>
          <p className="small muted">
            {filtered.length} criança(s){flag ? ` · ${CHILD_FLAG_LABELS[flag]}` : ''}
          </p>
          {filtered.length === 0 ? (
            <EmptyState icon="🧒" title="Nenhuma criança encontrada" action={<Button onClick={() => setCreating(true)}>Cadastrar criança</Button>} />
          ) : null}
          <div className="list" data-testid="children-list">
            {filtered.map((c) => {
              const st = childStatusBadge(c);
              return (
                <Link key={c.id} to={`/admin/criancas/${c.id}`} className="list-item" data-testid={`child-row-${c.id}`}>
                  <Avatar name={c.name} photoUrl={c.photoUrl} size="md" noPhotoBadge />
                  <span className="list-item__body">
                    <span className="list-item__title">{c.name}</span>
                    <span className="list-item__sub">
                      {c.className ?? 'Sem turma'}
                      {c.shift ? ` · ${SHIFT_LABELS[c.shift]}` : ''}
                      {c.birthDate ? ` · ${fmt.civil(c.birthDate)}` : ''} · {c.guardians.filter((g) => !g.blocked).length} responsável(is)
                    </span>
                    <span className="row">
                      <span className={st.cls}>{st.label}</span>
                      {c.gateAlert ? <span className="badge badge--danger">aviso de portaria</span> : null}
                      {!hasReachableGuardian(c) ? <span className="badge badge--danger">sem responsável alcançável</span> : null}
                      {!hasConsent(c) ? <span className="badge badge--warn">sem consentimento</span> : null}
                      {!c.credentials.some((k) => k.active) ? <span className="badge">sem carteirinha</span> : null}
                    </span>
                  </span>
                </Link>
              );
            })}
          </div>
        </QueryState>
      </div>

      <Modal open={creating} onClose={() => setCreating(false)} title="Nova criança" sheet>
        <ChildForm
          initial={valuesFromChild(null)}
          classOptions={classes}
          submitLabel="Cadastrar"
          onCancel={() => setCreating(false)}
          onSubmit={async (body) => {
            const created = await createChild(body);
            toast.show(`${created.name} cadastrada. Agora adicione os responsáveis.`, 'success', 5000);
            setCreating(false);
            navigate(`/admin/criancas/${created.id}?tab=responsaveis`);
          }}
        />
      </Modal>
    </AdminShell>
  );
}
