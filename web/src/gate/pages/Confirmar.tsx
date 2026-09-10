import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Navigate } from 'react-router';
import {
  joinNames,
  relationshipLabel,
  suggestAction,
  SHIFT_LABELS,
  type ChildGateDTO,
  type ChildStatus,
  type CreateEventsBody,
  type EventType,
  type ScanChildDTO,
  type ScanLookupResult,
} from '@creche/shared';
import { useAuth } from '../../auth/AuthProvider';
import { Avatar } from '../../components/Avatar';
import { Banner } from '../../components/Banner';
import { Button } from '../../components/Button';
import { CheckboxRow, SimpleCheckbox } from '../../components/CheckboxRow';
import { GateShell } from '../../components/AppShell';
import { TextArea, TextField } from '../../components/TextField';
import { useToast } from '../../components/Toast';
import { useConfig } from '../../config/ConfigProvider';
import { manualLookup, scanLookup } from '../../api/endpoints';
import { useFormat } from '../../lib/format';
import { useWakeLock } from '../../lib/wakeLock';
import { directoryAgeMs, rememberRecentPerson } from '../directory';
import { rememberSuccess, setPending, useFlow, type PendingLookup, type PendingPerson } from '../flow';
import { useGate } from '../GateProvider';
import { guardianResultFromChild, refreshLookup } from '../lookup';
import { enqueue } from '../queue';
import { addLocalEvents } from '../status';
import type { LocalEvent } from '../statusLogic';
import { setUndo } from '../undo';

export function ConfirmarPage() {
  const flow = useFlow();
  const pending = flow.pending;
  if (!pending) return <Navigate to="/portaria" replace />;
  return (
    <GateShell headerExtra={flow.next ? <span className="chip chip--info">Próximo: {flow.next.result.kind === 'guardian' ? flow.next.result.guardian.name : flow.next.result.child.name}</span> : null}>
      {pending.result.kind === 'child' && !pending.person ? (
        <ChildCardScreen key={pending.id} pending={pending} result={pending.result} />
      ) : (
        <ConfirmScreen key={pending.id} pending={pending} />
      )}
    </GateShell>
  );
}

// ---- 4.3 Child card: pick who is here ----------------------------------------------------

function ChildCardScreen({ pending, result }: { pending: PendingLookup; result: Extract<ScanLookupResult, { kind: 'child' }> }) {
  const gate = useGate();
  const fmt = useFormat();
  const child = result.child;
  const status = pending.source === 'live' ? gate.statusOf(child.id, child.status, pending.readAt) : gate.statusOf(child.id);

  const pickGuardian = (guardianId: string) => {
    const converted = guardianResultFromChild(result, guardianId, gate.today);
    if (!converted) return;
    setPending({ ...pending, id: crypto.randomUUID(), result: converted });
  };
  const pickPerson = (person: PendingPerson) => {
    setPending({ ...pending, id: crypto.randomUUID(), person });
  };

  return (
    <div className="stack" data-testid="confirm-screen">
      {child.gateAlert ? (
        <Banner kind="danger">
          {child.name}: {child.gateAlert}
        </Banner>
      ) : null}
      <div className="confirm-head">
        <Avatar name={child.name} photoUrl={child.photoUrl} size="lg" square noPhotoBadge />
        <div className="grow">
          <div className="confirm-head__name">{child.name}</div>
          <div className="confirm-head__sub">{[child.className, child.shift ? SHIFT_LABELS[child.shift] : null].filter(Boolean).join(' · ')}</div>
          <div className="confirm-head__sub">
            <StatusText status={status} time={fmt.time} />
          </div>
        </div>
      </div>

      <div className="section-title">Quem está aqui?</div>
      <div className="list" role="list">
        {result.guardians.map((g) => (
          <button key={g.id} type="button" className={`list-item${g.blocked ? ' list-item--danger' : ''}`} onClick={() => pickGuardian(g.id)} data-testid={`confirm-person-${g.id}`}>
            <Avatar name={g.name} photoUrl={g.photoUrl} size="md" noPhotoBadge />
            <span className="list-item__body">
              <span className="list-item__title">{g.name}</span>
              <span className="list-item__sub">{g.relationshipLabel || relationshipLabel(g.relationship)}</span>
            </span>
            {g.blocked ? (
              <span className="badge badge--danger">bloqueado</span>
            ) : g.pickupAllowedNow ? (
              <span className="badge badge--ok">pode retirar</span>
            ) : (
              <span className="badge badge--warn">não autorizado</span>
            )}
          </button>
        ))}
        {result.authorizedPersons.map((a) => (
          <button
            key={a.id}
            type="button"
            className="list-item"
            onClick={() =>
              pickPerson({
                name: a.personName,
                relationshipLabel: a.relationshipLabel,
                authorizationId: a.id,
                authorizedBy: `${a.createdBy.name}${a.createdBy.relationshipLabel ? ` (${a.createdBy.relationshipLabel.toLowerCase()})` : ''}`,
              })
            }
            data-testid={`confirm-person-${a.id}`}
          >
            <Avatar name={a.personName} photoUrl={null} size="md" />
            <span className="list-item__body">
              <span className="list-item__title">{a.personName}</span>
              <span className="list-item__sub">
                {a.relationshipLabel}, autorizada por {a.createdBy.name}
                {a.createdBy.relationshipLabel ? ` (${a.createdBy.relationshipLabel.toLowerCase()})` : ''} · até {fmt.civil(a.validUntil)}
              </span>
            </span>
            <span className="badge badge--ok">autorização avulsa</span>
          </button>
        ))}
        <button
          type="button"
          className="list-item"
          onClick={() => pickPerson({ name: '', relationshipLabel: 'não cadastrada', authorizationId: null, authorizedBy: null })}
          data-testid="confirm-person-other"
        >
          <span className="avatar avatar--md" aria-hidden="true">
            ?
          </span>
          <span className="list-item__body">
            <span className="list-item__title">Outra pessoa (não cadastrada)</span>
            <span className="list-item__sub">Na saída, registra uma exceção com alerta à direção.</span>
          </span>
        </button>
      </div>
      <Button variant="neutral" size="big" onClick={gate.cancelConfirmation}>
        Cancelar
      </Button>
    </div>
  );
}

// ---- 4.2 Confirmation -----------------------------------------------------------------------

type Subject =
  | { kind: 'guardian'; id: string; name: string; photoUrl: string | null }
  | { kind: 'person'; person: PendingPerson };

interface Row {
  child: ScanChildDTO;
  status: ChildStatus;
}

function childrenOf(pending: PendingLookup): { subject: Subject; children: ScanChildDTO[] } {
  const r = pending.result;
  if (r.kind === 'guardian') {
    return { subject: { kind: 'guardian', id: r.guardian.id, name: r.guardian.name, photoUrl: r.guardian.photoUrl }, children: r.children };
  }
  const person = pending.person!;
  const allowed = Boolean(person.authorizationId);
  const child: ScanChildDTO = {
    ...r.child,
    relationship: 'outro',
    relationshipLabel: person.relationshipLabel,
    canPickup: allowed,
    blocked: false,
    pickupAllowedNow: allowed,
  };
  return { subject: { kind: 'person', person }, children: [child] };
}

function ConfirmScreen({ pending }: { pending: PendingLookup }) {
  const gate = useGate();
  const { config } = useConfig();
  const { user } = useAuth();
  const fmt = useFormat();
  const toast = useToast();
  useWakeLock(true);

  const [live, setLive] = useState<ScanLookupResult | null>(null);
  const [liveAt, setLiveAt] = useState<string | null>(null);
  const [verify, setVerify] = useState<'none' | 'verifying' | 'ok' | 'failed'>('none');
  const [armed, setArmed] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Live-refreshed view (SAÍDA verification) or the read as resolved.
  const effective = useMemo<PendingLookup>(() => (live ? { ...pending, result: live, source: 'live' as const, readAt: liveAt ?? pending.readAt } : pending), [pending, live, liveAt]);
  const { subject, children } = useMemo(() => childrenOf(effective), [effective]);
  const baseAt = effective.source === 'live' ? effective.readAt : null;
  const rows: Row[] = useMemo(
    () => children.map((child) => ({ child, status: effective.source === 'live' ? gate.statusOf(child.id, child.status, baseAt) : gate.statusOf(child.id) })),
    [children, effective.source, baseAt, gate]
  );

  const suggestion = useMemo(() => suggestAction(rows.map((r) => ({ id: r.child.id, status: r.status }))), [rows]);
  const [action, setAction] = useState<'checkin' | 'checkout' | null>(() => {
    if (pending.forcedAction) return pending.forcedAction;
    return suggestion.action === 'mixed' ? null : suggestion.action;
  });
  const [selected, setSelected] = useState<string[]>(() => {
    if (pending.forcedAction) return pending.forcedAction === 'checkout' ? suggestion.present : suggestion.out;
    return suggestion.selected;
  });
  const [personName, setPersonName] = useState(subject.kind === 'person' ? subject.person.name : '');
  const [personDocument, setPersonDocument] = useState('');
  const [documentChecked, setDocumentChecked] = useState(false);
  const [note, setNote] = useState('');

  const chooseAction = (a: 'checkin' | 'checkout') => {
    setAction(a);
    setArmed(false);
    setSelected(a === 'checkout' ? suggestion.present : suggestion.out);
  };
  const toggle = (id: string, on: boolean) => {
    setSelected((prev) => (on ? [...new Set([...prev, id])] : prev.filter((x) => x !== id)));
    setArmed(false);
  };

  // ---- SAÍDA: always try a live lookup (3 s) -------------------------------------------
  const verifiedFor = useRef<string | null>(null);
  useEffect(() => {
    if (action !== 'checkout') return;
    if (verifiedFor.current === pending.id) return;
    verifiedFor.current = pending.id;
    const freshEnough = pending.source === 'live' && Date.now() - Date.parse(pending.readAt) < 30_000;
    if (freshEnough) {
      setVerify('ok');
      return;
    }
    let cancelled = false;
    setVerify('verifying');
    (async () => {
      try {
        let result: ScanLookupResult;
        if (pending.code || pending.uid) {
          result = await scanLookup({ ...(pending.code ? { code: pending.code } : {}), ...(pending.uid ? { uid: pending.uid } : {}) }, { timeoutMs: 3000 });
        } else if (pending.result.kind === 'guardian') {
          result = await manualLookup({ ownerType: 'guardian', ownerId: pending.result.guardian.id }, { timeoutMs: 3000 });
        } else {
          result = await manualLookup({ ownerType: 'child', ownerId: pending.result.child.id }, { timeoutMs: 3000 });
        }
        if (cancelled) return;
        // Keep the same shape as the read (guardian view restricted to the children shown).
        let refreshed = refreshLookup(result, gate.today);
        if (pending.result.kind === 'guardian' && refreshed.kind === 'child') {
          refreshed = guardianResultFromChild(refreshed, pending.result.guardian.id, gate.today) ?? refreshed;
        }
        if (pending.result.kind === 'guardian' && refreshed.kind === 'guardian') {
          const ids = new Set(pending.result.children.map((c) => c.id));
          if (pending.result.children.length === 1 && refreshed.children.length > 1) {
            refreshed = { ...refreshed, children: refreshed.children.filter((c) => ids.has(c.id)) };
          }
        }
        if (pending.result.kind === 'child' && refreshed.kind === 'guardian') {
          refreshed = pending.result; // unexpected shape: keep what we have
        }
        setLive(refreshed);
        setLiveAt(new Date().toISOString());
        setVerify('ok');
      } catch {
        if (!cancelled) setVerify('failed');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [action, pending, gate.today]);

  // Live data may change who is present: keep only still-present children selected for SAÍDA.
  const suggestionRef = useRef(suggestion);
  suggestionRef.current = suggestion;
  useEffect(() => {
    if (!live || pending.forcedAction) return;
    setSelected((prev) => (action === 'checkout' ? prev.filter((id) => suggestionRef.current.present.includes(id)) : prev));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live]);

  // ---- Derived flags -------------------------------------------------------------------
  const selectedRows = rows.filter((r) => selected.includes(r.child.id));
  const isCheckout = action === 'checkout';
  const blockedRows = isCheckout ? selectedRows.filter((r) => r.child.blocked) : [];
  const notAllowedRows = isCheckout ? selectedRows.filter((r) => !r.child.blocked && !r.child.pickupAllowedNow) : [];
  const staleRows = isCheckout ? selectedRows.filter((r) => r.status.stale) : [];
  const gateAlerts = rows.filter((r) => r.child.gateAlert);
  const noPhoto = subject.kind === 'guardian' ? !subject.photoUrl : true;
  const personUnregistered = subject.kind === 'person' && !subject.person.authorizationId;
  const needsOverride = isCheckout && (notAllowedRows.length > 0 || personUnregistered);
  const needsName = subject.kind === 'person' && personUnregistered;
  const needsDocumentCheck = isCheckout && (noPhoto || needsOverride);
  const needsNote = needsOverride || staleRows.length > 0;
  const noteMin = needsOverride ? 10 : 3;
  const ageMs = directoryAgeMs(gate.directory);
  const tooOld = isCheckout && verify === 'failed' && (ageMs === null || ageMs > config.offlineCheckoutMaxAgeHours * 3_600_000);
  const offline = isCheckout && verify === 'failed';

  const valid =
    action !== null &&
    selectedRows.length > 0 &&
    blockedRows.length === 0 &&
    (!needsName || personName.trim().length >= 2) &&
    (!needsDocumentCheck || documentChecked) &&
    (!needsNote || note.trim().length >= noteMin) &&
    !tooOld &&
    verify !== 'verifying';

  const submitLabel = (() => {
    if (!action) return 'Escolha ENTRADA ou SAÍDA';
    const names = joinNames(selectedRows.map((r) => r.child.name.split(' ')[0]));
    const n = selectedRows.length;
    if (offline && !armed) return `Confirmar mesmo assim — ${names} (${n})`;
    return `Registrar ${action === 'checkin' ? 'ENTRADA' : 'SAÍDA'} — ${names} (${n})`;
  })();

  // ---- Submit ----------------------------------------------------------------------------
  const submit = useCallback(
    async (type: EventType, targetRows: Row[]) => {
      if (!user || submitting) return;
      if (offline && type === 'checkout' && !armed) {
        setArmed(true);
        return;
      }
      setSubmitting(true);
      try {
        const now = new Date().toISOString();
        const batchId = crypto.randomUUID();
        const events = targetRows.map((r) => ({ clientId: crypto.randomUUID(), childId: r.child.id }));
        const cleanNote = note.trim() || null;
        const body: CreateEventsBody = {
          type,
          guardianId: subject.kind === 'guardian' ? subject.id : null,
          personName: subject.kind === 'person' ? personName.trim() || subject.person.name : null,
          personDocument: subject.kind === 'person' && personDocument.trim() ? personDocument.trim() : null,
          documentChecked,
          authorizationId: subject.kind === 'person' && type === 'checkout' ? subject.person.authorizationId : null,
          method: effective.method === 'auto' ? 'manual' : effective.method,
          credentialId: effective.credentialId,
          override: type === 'checkout' && needsOverride ? true : undefined,
          note: type === 'denied' ? cleanNote ?? 'Tentativa de retirada por pessoa bloqueada' : cleanNote,
          occurredAt: now,
          queued: false,
          directoryGeneratedAt: gate.directory.directory?.generatedAt ?? null,
          events,
        };
        const subjectName = subject.kind === 'guardian' ? subject.name : personName.trim() || subject.person.name;
        const childNames = targetRows.map((r) => r.child.name);
        const local: LocalEvent[] = targetRows.map((r, i) => ({
          clientId: events[i].clientId,
          batchId,
          childId: r.child.id,
          childName: r.child.name,
          type,
          occurredAt: now,
          guardianId: subject.kind === 'guardian' ? subject.id : null,
          guardianName: subject.kind === 'guardian' ? subject.name : null,
          guardianRelationship: subject.kind === 'guardian' ? r.child.relationship : null,
          personName: subject.kind === 'person' ? subjectName : null,
          guardId: user.id,
          guardName: user.name,
          method: body.method,
          sentAt: null,
          serverEventId: null,
          voided: false,
        }));
        await addLocalEvents(local);
        await enqueue(body, { type, childNames, personName: subjectName }, batchId);
        const undoUntil = new Date(Date.now() + config.notifyHoldSeconds * 1000).toISOString();
        if (type !== 'denied') {
          setUndo({ batchId, type, childNames, undoUntil, eventIds: [], createdAt: now });
          rememberSuccess([effective.key, ...(effective.credentialId ? [effective.credentialId] : [])], fmt.time(now));
        }
        if (subject.kind === 'guardian') rememberRecentPerson({ ownerType: 'guardian', ownerId: subject.id, name: subject.name });
        else if (targetRows[0]) rememberRecentPerson({ ownerType: 'child', ownerId: targetRows[0].child.id, name: targetRows[0].child.name });
        gate.finishConfirmation({ batchId, type, childNames, personName: subjectName, at: now, undoUntil });
      } catch (err) {
        toast.show(err instanceof Error ? err.message : 'Falha ao gravar o registro', 'danger');
        setSubmitting(false);
      }
    },
    [user, submitting, offline, armed, note, subject, personName, personDocument, documentChecked, effective, needsOverride, gate, config.notifyHoldSeconds, fmt, toast]
  );

  // ---- Blocked: red screen -----------------------------------------------------------------
  if (blockedRows.length > 0 && subject.kind === 'guardian') {
    return (
      <div className="blocked-screen" role="alert" data-testid="confirm-screen">
        <div className="success-screen__icon" aria-hidden="true">
          ⛔
        </div>
        <h2>NÃO LIBERAR</h2>
        <p className="big-text">Chame a direção{config.daycarePhone ? ` — ${config.daycarePhone}` : ''}</p>
        <p>
          {subject.name} está <strong>bloqueado(a)</strong> para retirar {joinNames(blockedRows.map((r) => r.child.name))}.
        </p>
        <Button variant="neutral" size="big" onClick={() => void submit('denied', blockedRows)} loading={submitting} data-testid="confirm-denied">
          Registrar tentativa recusada
        </Button>
        <Button variant="ghost" size="big" onClick={() => chooseAction('checkin')} className="btn--neutral">
          Trocar para ENTRADA
        </Button>
        <Button variant="neutral" size="big" onClick={gate.cancelConfirmation}>
          Voltar
        </Button>
      </div>
    );
  }

  const relationshipText =
    subject.kind === 'guardian'
      ? uniqueRelationships(rows.map((r) => r.child))
      : subject.person.authorizationId
        ? `${subject.person.relationshipLabel} · autorizada por ${subject.person.authorizedBy}`
        : 'Pessoa não cadastrada';

  return (
    <div className="stack" data-testid="confirm-screen">
      {gateAlerts.map((r) => (
        <Banner kind="danger" key={r.child.id}>
          {r.child.name}: {r.child.gateAlert}
        </Banner>
      ))}

      <div className="confirm-head">
        {subject.kind === 'guardian' ? (
          <Avatar name={subject.name} photoUrl={subject.photoUrl} size="lg" noPhotoBadge />
        ) : (
          <span className="avatar avatar--lg" aria-hidden="true">
            ?
          </span>
        )}
        <div className="grow">
          <div className="confirm-head__name">{subject.kind === 'guardian' ? subject.name : personName.trim() || subject.person.name || 'Outra pessoa'}</div>
          <div className="confirm-head__sub">{relationshipText}</div>
          {verify === 'verifying' ? (
            <div className="small muted">
              <span className="spinner" aria-hidden="true" /> Verificando dados ao vivo…
            </div>
          ) : null}
        </div>
      </div>

      {noPhoto && subject.kind === 'guardian' ? (
        <Banner kind="danger" className="banner--compact">
          SEM FOTO — confira o documento
        </Banner>
      ) : null}

      {offline ? (
        <Banner kind="warn" data-testid="confirm-offline-banner">
          SEM CONEXÃO — dados de {gate.directory.fetchedAt ? fmt.time(gate.directory.fetchedAt) : '—'}
          {tooOld ? (
            <>
              <br />
              Dados com mais de {config.offlineCheckoutMaxAgeHours} h: a saída não pode ser registrada sem conexão. Ligue para a secretaria
              {config.daycarePhone ? ` (${config.daycarePhone})` : ''}.
            </>
          ) : null}
        </Banner>
      ) : null}

      {needsName ? (
        <TextField
          label="Nome completo da pessoa"
          value={personName}
          onChange={(e) => setPersonName(e.target.value)}
          autoComplete="off"
          placeholder="Nome como no documento"
          data-testid="confirm-person-name"
        />
      ) : null}

      <div className="section-title">Crianças</div>
      <div className="stack stack--sm" role="group" aria-label="Crianças">
        {rows.map((r) => {
          const notAllowed = isCheckout && !r.child.blocked && !r.child.pickupAllowedNow;
          const blockedRow = r.child.blocked;
          const statusEl = <StatusText status={r.status} time={fmt.time} />;
          return (
            <CheckboxRow
              key={r.child.id}
              testId={`confirm-child-${r.child.id}`}
              checked={selected.includes(r.child.id)}
              onChange={(on) => toggle(r.child.id, on)}
              hideBox={rows.length === 1}
              tone={notAllowed ? 'danger' : action === 'checkin' ? 'entrada' : action === 'checkout' ? 'saida' : 'default'}
              leading={<Avatar name={r.child.name} photoUrl={r.child.photoUrl} size="md" square noPhotoBadge />}
              title={r.child.name}
              sub={[r.child.className, r.child.shift ? SHIFT_LABELS[r.child.shift] : null, subject.kind === 'guardian' ? r.child.relationshipLabel : null].filter(Boolean).join(' · ')}
              status={
                <>
                  {statusEl}
                  {r.status.stale ? <span className="badge badge--warn"> Sem saída ontem</span> : null}
                  {notAllowed ? <span className="badge badge--danger"> NÃO AUTORIZADO A RETIRAR</span> : null}
                  {blockedRow && !isCheckout ? <span className="badge badge--danger"> bloqueado para retirada</span> : null}
                </>
              }
              statusTone={notAllowed ? 'danger' : r.status.present && !r.status.stale ? 'present' : 'out'}
            />
          );
        })}
      </div>

      {needsOverride ? (
        <Banner kind="danger">
          {personUnregistered
            ? 'Pessoa fora da lista de autorizados: a saída será registrada como EXCEÇÃO e todos os responsáveis e a direção serão alertados.'
            : `${joinNames(notAllowedRows.map((r) => r.child.name))}: ${subject.kind === 'guardian' ? subject.name : 'esta pessoa'} não está autorizado(a) a retirar. A saída será registrada como EXCEÇÃO com alerta à direção.`}
        </Banner>
      ) : null}

      {needsDocumentCheck ? (
        <>
          <SimpleCheckbox checked={documentChecked} onChange={setDocumentChecked} label="Documento conferido" required tone="saida" testId="confirm-document-checked" />
          {subject.kind === 'person' ? (
            <TextField label="Número do documento (opcional)" value={personDocument} onChange={(e) => setPersonDocument(e.target.value)} autoComplete="off" inputMode="text" />
          ) : null}
        </>
      ) : null}

      {needsNote ? (
        <TextArea
          label={needsOverride ? 'Motivo da exceção' : 'Observação (criança sem entrada registrada hoje)'}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          hint={`Mínimo de ${noteMin} caracteres`}
          placeholder={needsOverride ? 'Ex.: mãe ligou autorizando a retirada' : 'Ex.: entrada de ontem não registrada'}
          data-testid="confirm-note"
        />
      ) : null}

      <div className="confirm-actions">
        {suggestion.action === 'mixed' || action === null ? (
          <p className="small muted center">
            Misto: {suggestion.out.length} fora, {suggestion.present.length} na creche. Escolha a ação.
          </p>
        ) : null}
        <div className="action-toggle">
          <Button
            variant="entrada"
            aria-pressed={action === 'checkin'}
            onClick={() => chooseAction('checkin')}
            icon="⬇"
            sub={suggestion.out.length ? joinNames(rows.filter((r) => suggestion.out.includes(r.child.id)).map((r) => r.child.name.split(' ')[0])) : 'ninguém fora'}
            data-testid="confirm-action-checkin"
          >
            ENTRADA
          </Button>
          <Button
            variant="saida"
            aria-pressed={action === 'checkout'}
            onClick={() => chooseAction('checkout')}
            icon="⬆"
            sub={suggestion.present.length ? joinNames(rows.filter((r) => suggestion.present.includes(r.child.id)).map((r) => r.child.name.split(' ')[0])) : 'ninguém na creche'}
            data-testid="confirm-action-checkout"
          >
            SAÍDA
          </Button>
        </div>
        <div className="visually-hidden" aria-live="polite">
          {action === 'checkin' ? 'Ação sugerida: entrada' : action === 'checkout' ? 'Ação sugerida: saída' : 'Escolha a ação'}
        </div>
        <Button
          variant={action === 'checkin' ? 'entrada' : action === 'checkout' ? 'saida' : 'neutral'}
          size="big"
          disabled={!valid}
          loading={submitting}
          onClick={() => action && void submit(action, selectedRows)}
          data-testid="confirm-submit"
        >
          {submitLabel}
        </Button>
        <Button variant="neutral" size="sm" onClick={gate.cancelConfirmation} disabled={submitting}>
          Cancelar
        </Button>
      </div>
    </div>
  );
}

function StatusText({ status, time }: { status: ChildStatus; time: (iso: string) => string }) {
  if (status.present && status.stale) return <span>Sem saída ontem</span>;
  if (status.present) return <span>Na creche desde {status.since ? time(status.since) : '—'}</span>;
  return <span>Fora</span>;
}

function uniqueRelationships(children: (ChildGateDTO & { relationshipLabel: string })[]): string {
  const labels = [...new Set(children.map((c) => c.relationshipLabel))];
  if (labels.length === 1) return labels[0];
  return children.map((c) => `${c.relationshipLabel} de ${c.name.split(' ')[0]}`).join(' · ');
}
