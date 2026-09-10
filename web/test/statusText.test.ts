import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AttendanceEventDTO, ChildStatus } from '@creche/shared';
import { makeFormatters } from '../src/lib/formatters';
import { childStatusText, eventActor } from '../src/pages/guardian/statusText';

const tz = 'America/Sao_Paulo';
const fmt = makeFormatters(tz);
const todayIso = new Date();
const todayAt = (h: number, m: number) => {
  // Build "today HH:MM" in the daycare zone from the civil date.
  const civil = fmt.today();
  const [y, mo, d] = civil.split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1, d, h + 3, m)).toISOString();
};

function ev(partial: Partial<AttendanceEventDTO>): AttendanceEventDTO {
  return {
    id: 'e1',
    batchId: 'b1',
    clientId: null,
    childId: 'c1',
    childName: 'Ana',
    type: 'checkin',
    guardianId: 'g1',
    guardianName: 'Maria Silva',
    guardianRelationship: 'mae',
    personName: null,
    personDocument: null,
    documentChecked: false,
    authorizationId: null,
    authorizedByName: null,
    guardId: 'u1',
    guardName: 'Carlos',
    method: 'code',
    credentialId: null,
    override: false,
    conflict: null,
    queued: false,
    note: null,
    occurredAt: todayIso.toISOString(),
    createdAt: todayIso.toISOString(),
    voidedAt: null,
    voidedBy: null,
    voidReason: null,
    ...partial,
  };
}

test('present since today with who dropped off', () => {
  const at = todayAt(7, 45);
  const status: ChildStatus = { present: true, since: at, stale: false, lastEvent: ev({ type: 'checkin', occurredAt: at }) };
  const r = childStatusText({ active: true, status }, fmt);
  assert.equal(r.text, 'Na creche desde 07:45 · deixado por Maria Silva (mãe)');
  assert.equal(r.tone, 'present');
});

test('stale presence never says "since yesterday"', () => {
  const status: ChildStatus = { present: true, since: '2026-01-01T10:00:00.000Z', stale: true, lastEvent: null };
  const r = childStatusText({ active: true, status }, fmt);
  assert.equal(r.text, 'Saída de ontem não registrada — fale com a secretaria');
  assert.equal(r.tone, 'stale');
});

test('out with last checkout today / other day / unregistered person', () => {
  const at = todayAt(17, 30);
  const out: ChildStatus = {
    present: false,
    since: null,
    stale: false,
    lastEvent: ev({ type: 'checkout', occurredAt: at, guardianName: 'João', guardianRelationship: 'pai' }),
  };
  assert.equal(childStatusText({ active: true, status: out }, fmt).text, 'Fora da creche · saiu 17:30 com João (pai)');

  const old: ChildStatus = {
    ...out,
    lastEvent: ev({ type: 'checkout', occurredAt: '2026-01-05T20:30:00.000Z', guardianId: null, guardianName: null, guardianRelationship: null, personName: 'Ana Souza' }),
  };
  assert.equal(childStatusText({ active: true, status: old }, fmt).text, 'Fora da creche · saiu 05/01 às 17:30 com Ana Souza');

  const none: ChildStatus = { present: false, since: null, stale: false, lastEvent: null };
  assert.equal(childStatusText({ active: true, status: none }, fmt).text, 'Fora da creche');
});

test('inactive child', () => {
  const status: ChildStatus = { present: false, since: null, stale: false, lastEvent: null };
  assert.equal(childStatusText({ active: false, status, deactivatedAt: '2026-03-15T12:00:00.000Z' }, fmt).text, 'Desligado(a) em 15/03');
  assert.equal(childStatusText({ active: false, status }, fmt).text, 'Desligado(a)');
  assert.equal(eventActor(null), '');
});
