import { useEffect, useMemo, useState } from 'react';
import { relationshipLabel, searchKey, SHIFT_LABELS, type AttendanceEventDTO, type ChildGateDTO, type ChildStatus } from '@creche/shared';
import { voidEvent } from '../../api/endpoints';
import { describeError } from '../../api/client';
import { Avatar } from '../../components/Avatar';
import { Banner } from '../../components/Banner';
import { Button } from '../../components/Button';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { EmptyState } from '../../components/EmptyState';
import { GateShell } from '../../components/AppShell';
import { Sheet } from '../../components/Modal';
import { TextField } from '../../components/TextField';
import { useToast } from '../../components/Toast';
import { useFormat } from '../../lib/format';
import { refreshDirectory } from '../directory';
import { useGate } from '../GateProvider';
import { buildLookupFromDirectory } from '../lookup';
import { dismissNotApplied, kickQueue, useQueue } from '../queue';
import { pendingFromResult } from '../resolve';
import { voidLocalEventByServerId } from '../status';

interface Entry {
  child: ChildGateDTO;
  status: ChildStatus;
}

function whoText(ev: AttendanceEventDTO | null): string {
  if (!ev) return '';
  if (ev.guardianName) return `${ev.guardianName}${ev.guardianRelationship ? ` (${relationshipLabel(ev.guardianRelationship).toLowerCase()})` : ''}`;
  if (ev.personName) return `${ev.personName} (não cadastrada)`;
  return '';
}

export function HojePage() {
  const gate = useGate();
  const fmt = useFormat();
  const toast = useToast();
  const queue = useQueue();
  const [query, setQuery] = useState('');
  const [checkoutFor, setCheckoutFor] = useState<Entry | null>(null);
  const [cancelFor, setCancelFor] = useState<Entry | null>(null);

  useEffect(() => {
    void refreshDirectory('hoje', true);
  }, []);

  const dir = gate.directory.directory;
  const entries = useMemo<Entry[]>(() => (dir?.children ?? []).filter((c) => c.active).map((child) => ({ child, status: gate.statusOf(child.id) })), [dir, gate]);
  const q = searchKey(query);
  const filtered = q ? entries.filter((e) => searchKey(e.child.name).includes(q)) : entries;
  const present = filtered.filter((e) => e.status.present && !e.status.stale);
  const stale = filtered.filter((e) => e.status.present && e.status.stale);

  const groups = useMemo(() => {
    const map = new Map<string, Entry[]>();
    for (const e of present) {
      const key = [e.child.className ?? 'Sem turma', e.child.shift ? SHIFT_LABELS[e.child.shift] : null].filter(Boolean).join(' · ');
      const list = map.get(key) ?? [];
      list.push(e);
      map.set(key, list);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0], 'pt-BR')).map(([key, list]) => [key, list.sort((a, b) => a.child.name.localeCompare(b.child.name, 'pt-BR'))] as const);
  }, [present]);

  const openCheckout = (entry: Entry, guardianId: string | null, person?: { name: string; relationshipLabel: string; authorizationId: string | null; authorizedBy: string | null }) => {
    if (!dir) return;
    if (guardianId) {
      const built = buildLookupFromDirectory(dir, 'guardian', guardianId, gate.today, { matchedBy: 'search', childIds: [entry.child.id], statusOf: (id) => gate.statusOf(id) });
      if (!built.ok) {
        toast.show('Responsável não encontrado no diretório.', 'danger');
        return;
      }
      gate.openLookup({ ...pendingFromResult(built.result, { method: 'search' }, 'directory'), forcedAction: 'checkout' });
    } else {
      const built = buildLookupFromDirectory(dir, 'child', entry.child.id, gate.today, { matchedBy: 'search', statusOf: (id) => gate.statusOf(id) });
      if (!built.ok) return;
      gate.openLookup({ ...pendingFromResult(built.result, { method: 'search' }, 'directory'), forcedAction: 'checkout', person });
    }
    setCheckoutFor(null);
  };

  const cancelEvent = async (entry: Entry, reason: string) => {
    const ev = entry.status.lastEvent;
    if (!ev) throw new Error('Sem registro para cancelar.');
    // Local events not yet accepted by the server carry id === clientId (see localEventToDto).
    const local = Boolean(ev.clientId) && ev.id === ev.clientId;
    if (local) {
      kickQueue('manual', true);
      throw new Error('Este registro ainda não foi enviado ao servidor. Aguarde alguns segundos e tente de novo.');
    }
    await voidEvent(ev.id, reason);
    await voidLocalEventByServerId(ev.id);
    toast.show('Registro cancelado.', 'success');
    setCancelFor(null);
    void refreshDirectory('void', true);
  };

  return (
    <GateShell>
      <div className="stack" data-testid="today-list">
        <div className="page-title">
          <h1>Hoje · {fmt.civil(gate.today)}</h1>
          <Button variant="neutral" size="sm" onClick={() => void refreshDirectory('manual', true)} loading={gate.directory.loading}>
            Atualizar
          </Button>
        </div>
        <div className="row">
          <span className="chip chip--success">{gate.counts.present} na creche</span>
          {gate.counts.stale > 0 ? <span className="chip chip--warn">{gate.counts.stale} sem saída ontem</span> : null}
        </div>

        {queue.notApplied.length > 0 ? (
          <section>
            <div className="section-title">Não aplicados</div>
            <div className="list">
              {queue.notApplied.map((n) => (
                <div key={`${n.batchId}:${n.childId ?? 'all'}`} className="list-item list-item--danger">
                  <span className="list-item__body">
                    <span className="list-item__title">
                      {n.type === 'checkin' ? 'Entrada' : n.type === 'checkout' ? 'Saída' : 'Recusa'} — {n.childName}
                    </span>
                    <span className="list-item__sub">
                      {n.personName} · {fmt.relative(n.at)} · {n.message}
                    </span>
                  </span>
                  <Button variant="neutral" size="sm" onClick={() => void dismissNotApplied(n.batchId, n.childId)}>
                    Dispensar
                  </Button>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        <TextField label="Buscar criança" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Nome" autoComplete="off" />

        {!dir ? (
          <Banner kind="warn">Diretório ainda não baixado.</Banner>
        ) : present.length === 0 && stale.length === 0 ? (
          <EmptyState icon="🏫" title="Ninguém na creche agora">
            As crianças aparecem aqui após a entrada.
          </EmptyState>
        ) : null}

        {groups.map(([group, list]) => (
          <section key={group}>
            <div className="section-title">
              {group} · {list.length}
            </div>
            <div className="list">
              {list.map((e) => (
                <ChildRow key={e.child.id} entry={e} fmt={fmt} onCheckout={() => setCheckoutFor(e)} onCancel={() => setCancelFor(e)} />
              ))}
            </div>
          </section>
        ))}

        {stale.length > 0 ? (
          <section>
            <div className="section-title">Sem saída registrada ontem · {stale.length}</div>
            <div className="list">
              {stale.map((e) => (
                <ChildRow key={e.child.id} entry={e} fmt={fmt} stale onCheckout={() => setCheckoutFor(e)} onCancel={() => setCancelFor(e)} />
              ))}
            </div>
          </section>
        ) : null}
      </div>

      <Sheet open={checkoutFor !== null} onClose={() => setCheckoutFor(null)} title={checkoutFor ? `Saída de ${checkoutFor.child.name}` : ''}>
        {checkoutFor ? (
          <div className="list">
            <p className="small muted">Quem está retirando?</p>
            {checkoutFor.child.guardians.map((g) => (
              <button key={g.id} type="button" className={`list-item${g.blocked ? ' list-item--danger' : ''}`} onClick={() => openCheckout(checkoutFor, g.id)}>
                <Avatar name={g.name} photoUrl={g.photoUrl} size="md" noPhotoBadge />
                <span className="list-item__body">
                  <span className="list-item__title">{g.name}</span>
                  <span className="list-item__sub">{g.relationshipLabel || relationshipLabel(g.relationship)}</span>
                </span>
                {g.blocked ? <span className="badge badge--danger">bloqueado</span> : g.pickupAllowedNow ? <span className="badge badge--ok">pode retirar</span> : <span className="badge badge--warn">não autorizado</span>}
              </button>
            ))}
            {checkoutFor.child.authorizedPersons.map((a) => (
              <button
                key={a.id}
                type="button"
                className="list-item"
                onClick={() =>
                  openCheckout(checkoutFor, null, {
                    name: a.personName,
                    relationshipLabel: a.relationshipLabel,
                    authorizationId: a.id,
                    authorizedBy: `${a.createdBy.name}${a.createdBy.relationshipLabel ? ` (${a.createdBy.relationshipLabel.toLowerCase()})` : ''}`,
                  })
                }
              >
                <Avatar name={a.personName} photoUrl={null} size="md" />
                <span className="list-item__body">
                  <span className="list-item__title">{a.personName}</span>
                  <span className="list-item__sub">
                    {a.relationshipLabel}, autorizada por {a.createdBy.name}
                  </span>
                </span>
                <span className="badge badge--ok">autorização avulsa</span>
              </button>
            ))}
            <button type="button" className="list-item" onClick={() => openCheckout(checkoutFor, null, { name: '', relationshipLabel: 'não cadastrada', authorizationId: null, authorizedBy: null })}>
              <span className="avatar avatar--md" aria-hidden="true">
                ?
              </span>
              <span className="list-item__body">
                <span className="list-item__title">Outra pessoa (não cadastrada)</span>
                <span className="list-item__sub">Exceção com alerta à direção</span>
              </span>
            </button>
          </div>
        ) : null}
      </Sheet>

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
            await cancelEvent(cancelFor, reason);
          } catch (err) {
            throw new Error(describeError(err));
          }
        }}
      >
        {cancelFor?.status.lastEvent ? (
          <p>
            {cancelFor.child.name}: {cancelFor.status.lastEvent.type === 'checkin' ? 'entrada' : 'saída'} às {fmt.time(cancelFor.status.lastEvent.occurredAt)}
            {whoText(cancelFor.status.lastEvent) ? ` com ${whoText(cancelFor.status.lastEvent)}` : ''}. Os responsáveis receberão “Registro cancelado”.
          </p>
        ) : null}
      </ConfirmDialog>
    </GateShell>
  );
}

function ChildRow({
  entry,
  fmt,
  stale = false,
  onCheckout,
  onCancel,
}: {
  entry: Entry;
  fmt: ReturnType<typeof useFormat>;
  stale?: boolean;
  onCheckout: () => void;
  onCancel: () => void;
}) {
  const ev = entry.status.lastEvent;
  return (
    <div className="list-item" data-testid={`today-child-${entry.child.id}`}>
      <Avatar name={entry.child.name} photoUrl={entry.child.photoUrl} size="md" square noPhotoBadge />
      <span className="list-item__body">
        <span className="list-item__title">{entry.child.name}</span>
        <span className="list-item__sub">
          {stale ? `Entrada ${fmt.relative(entry.status.since)}` : `Entrada ${entry.status.since ? fmt.time(entry.status.since) : '—'}`}
          {whoText(ev) ? ` · deixado por ${whoText(ev)}` : ''}
          {ev?.queued && ev.id === ev.clientId ? ' · enviando…' : ''}
        </span>
        {entry.child.gateAlert ? <span className="badge badge--danger">{entry.child.gateAlert}</span> : null}
      </span>
      <span className="list-item__actions">
        <Button variant="saida" size="sm" onClick={onCheckout} aria-label={`Registrar saída de ${entry.child.name}`}>
          Registrar saída
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel} aria-label={`Cancelar registro de ${entry.child.name}`}>
          Cancelar registro
        </Button>
      </span>
    </div>
  );
}
