import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChildGateDTO, ChildStatus } from '@creche/shared';
import { applyOverlay, countPresence, pruneLocalEvents, recomputeStale, type LocalEvent } from '../src/gate/statusLogic';

const TZ = 'America/Sao_Paulo';
const TODAY = '2026-09-10';

function ev(overrides: Partial<LocalEvent>): LocalEvent {
  return {
    clientId: overrides.clientId ?? 'c-' + Math.random(),
    batchId: 'b1',
    childId: 'child-1',
    childName: 'Ana',
    type: 'checkin',
    occurredAt: '2026-09-10T10:45:00.000Z',
    guardianId: 'g1',
    guardianName: 'Maria',
    guardianRelationship: 'mae',
    personName: null,
    guardId: 'guard',
    guardName: 'Carlos',
    method: 'code',
    sentAt: null,
    serverEventId: null,
    voided: false,
    ...overrides,
  };
}

const out: ChildStatus = { present: false, since: null, lastEvent: null, stale: false };
const present: ChildStatus = { present: true, since: '2026-09-10T10:45:00.000Z', lastEvent: null, stale: false };

test('unsent local checkin makes the child present since the device time', () => {
  const s = applyOverlay(out, '2026-09-10T10:00:00.000Z', [ev({})], 'child-1', TODAY, TZ);
  assert.equal(s.present, true);
  assert.equal(s.since, '2026-09-10T10:45:00.000Z');
  assert.equal(s.stale, false);
  assert.equal(s.lastEvent?.guardianName, 'Maria');
  assert.equal(s.lastEvent?.queued, true);
});

test('sent events older than the directory are ignored; newer ones apply', () => {
  const old = ev({ sentAt: '2026-09-10T10:46:00.000Z', occurredAt: '2026-09-10T10:45:00.000Z', type: 'checkout' });
  const s1 = applyOverlay(present, '2026-09-10T11:00:00.000Z', [old], 'child-1', TODAY, TZ);
  assert.equal(s1.present, true, 'old sent checkout already reflected in directory → base wins');
  const fresh = ev({ sentAt: '2026-09-10T11:31:00.000Z', occurredAt: '2026-09-10T11:30:00.000Z', type: 'checkout' });
  const s2 = applyOverlay(present, '2026-09-10T11:00:00.000Z', [fresh], 'child-1', TODAY, TZ);
  assert.equal(s2.present, false);
});

test('latest event wins; voided and denied events are ignored; other children are ignored', () => {
  const events = [
    ev({ occurredAt: '2026-09-10T10:45:00.000Z', type: 'checkin' }),
    ev({ occurredAt: '2026-09-10T12:00:00.000Z', type: 'checkout' }),
    ev({ occurredAt: '2026-09-10T13:00:00.000Z', type: 'checkin', voided: true }),
    ev({ occurredAt: '2026-09-10T14:00:00.000Z', type: 'denied' }),
    ev({ occurredAt: '2026-09-10T15:00:00.000Z', type: 'checkin', childId: 'child-2' }),
  ];
  const s = applyOverlay(out, null, events, 'child-1', TODAY, TZ);
  assert.equal(s.present, false);
  assert.equal(s.lastEvent?.type, 'checkout');
});

test('stale is recomputed for the current civil day', () => {
  const yesterday: ChildStatus = { present: true, since: '2026-09-09T11:00:00.000Z', lastEvent: null, stale: false };
  assert.equal(recomputeStale(yesterday, TODAY, TZ).stale, true);
  assert.equal(recomputeStale(present, TODAY, TZ).stale, false);
  // A local checkin from yesterday (queued offline overnight) is stale too.
  const s = applyOverlay(out, null, [ev({ occurredAt: '2026-09-09T20:00:00.000Z' })], 'child-1', TODAY, TZ);
  assert.equal(s.stale, true);
  // 23:30 local on the 9th is 02:30Z on the 10th → still yesterday in São Paulo.
  const late = applyOverlay(out, null, [ev({ occurredAt: '2026-09-10T02:30:00.000Z' })], 'child-1', TODAY, TZ);
  assert.equal(late.stale, true);
});

test('countPresence excludes stale from present and inactive children entirely', () => {
  const child = (id: string, active = true): ChildGateDTO => ({
    id,
    name: id,
    birthDate: null,
    className: 'A',
    shift: 'manha',
    photoUrl: null,
    active,
    status: out,
    createdAt: '2026-01-01T00:00:00.000Z',
    gateAlert: null,
    guardians: [],
    authorizedPersons: [],
  });
  const statuses: Record<string, ChildStatus> = {
    a: present,
    b: { present: true, since: '2026-09-09T10:00:00.000Z', lastEvent: null, stale: true },
    c: out,
    d: present,
  };
  const counts = countPresence([child('a'), child('b'), child('c'), child('d', false)], (id) => statuses[id]);
  assert.deepEqual(counts, { present: 1, stale: 1 });
});

test('pruneLocalEvents keeps unsent and newer-than-directory events', () => {
  const events = [
    ev({ clientId: 'unsent' }),
    ev({ clientId: 'sent-old', sentAt: '2026-09-10T10:46:00.000Z', occurredAt: '2026-09-10T10:45:00.000Z' }),
    ev({ clientId: 'sent-new', sentAt: '2026-09-10T11:31:00.000Z', occurredAt: '2026-09-10T11:30:00.000Z' }),
    ev({ clientId: 'sent-pending-batch', batchId: 'b2', sentAt: '2026-09-10T10:46:00.000Z', occurredAt: '2026-09-10T10:45:00.000Z' }),
  ];
  const kept = pruneLocalEvents(events, '2026-09-10T11:00:00.000Z', new Set(['b2'])).map((e) => e.clientId);
  assert.deepEqual(kept, ['unsent', 'sent-new', 'sent-pending-batch']);
  assert.equal(pruneLocalEvents(events, null, new Set()).length, 4);
});
