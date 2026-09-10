import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChildAdminDTO, CreateEventsResult } from '@creche/shared';
import { OTHER_PERSON, buildBackfillRows, emptyRow, mapBackfillResults, personOptions } from '../src/admin/backfillLogic';
import { buildPrintCards, chunk, parsePrintQuery } from '../src/admin/cards';
import { classNames, filterChildren, hasReachableGuardian } from '../src/admin/childFilters';

const tz = 'America/Sao_Paulo';

function child(partial: Partial<ChildAdminDTO>): ChildAdminDTO {
  return {
    id: 'c1',
    name: 'Ana Souza',
    birthDate: null,
    className: 'Maternal I',
    shift: 'manha',
    photoUrl: null,
    active: true,
    status: { present: false, since: null, stale: false, lastEvent: null },
    createdAt: '2026-01-01T00:00:00.000Z',
    gateAlert: null,
    guardians: [],
    authorizedPersons: [],
    notes: null,
    consentAt: null,
    consentByName: null,
    consentRelationship: null,
    deactivatedAt: null,
    anonymizedAt: null,
    credentials: [],
    recentEvents: [],
    authorizations: [],
    ...partial,
  };
}

const guardian = {
  id: 'g1',
  name: 'Maria Silva',
  relationship: 'mae' as const,
  relationshipLabel: 'Mãe',
  canPickup: true,
  isPrimary: true,
  validFrom: null,
  validUntil: null,
  pickupAllowedNow: true,
  photoUrl: null,
  blocked: false,
  email: 'maria@demo.local',
  login: null,
  phone: null,
  hasAccess: true,
  blockedReason: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  reachable: 'email' as const,
};

test('personOptions lists links, authorizations valid on the date and "other"', () => {
  const c = child({
    guardians: [guardian, { ...guardian, id: 'g2', name: 'Bloqueado', blocked: true }],
    authorizations: [
      {
        id: 'a1',
        childId: 'c1',
        personName: 'Vizinha',
        personDocument: null,
        relationshipLabel: 'vizinha',
        phone: null,
        validFrom: '2026-09-10',
        validUntil: '2026-09-10',
        note: null,
        createdBy: { id: 'g1', name: 'Maria', relationshipLabel: 'Mãe' },
        createdAt: '2026-09-09T00:00:00.000Z',
        revokedAt: null,
        validNow: true,
      },
    ],
  });
  const onDay = personOptions(c, '2026-09-10');
  assert.deepEqual(
    onDay.map((o) => o.value),
    ['g:g1', 'a:a1', OTHER_PERSON]
  );
  assert.equal(onDay[0].label, 'Maria Silva (mãe)');
  const otherDay = personOptions(c, '2026-09-11');
  assert.deepEqual(
    otherDay.map((o) => o.value),
    ['g:g1', OTHER_PERSON]
  );
});

test('buildBackfillRows builds rows with zoned instants and reports errors', () => {
  const c = child({ guardians: [guardian] });
  const options = new Map([[c.id, personOptions(c, '2026-09-10')]]);
  let n = 0;
  const newId = () => `id-${++n}`;
  const ok = buildBackfillRows(
    [{ ...emptyRow('c1'), checkinTime: '07:45', checkinWho: 'g:g1', checkoutTime: '17:30', checkoutWho: OTHER_PERSON, checkoutOther: 'Tia Rosa' }],
    options,
    '2026-09-10',
    tz,
    'Folha de papel',
    newId
  );
  assert.deepEqual(ok.errors, {});
  assert.equal(ok.rows.length, 2);
  assert.equal(ok.rows[0].occurredAt, '2026-09-10T10:45:00.000Z');
  assert.equal(ok.rows[0].guardianId, 'g1');
  assert.equal(ok.rows[1].personName, 'Tia Rosa');
  assert.equal(ok.rows[1].guardianId, null);
  assert.equal(ok.rows[1].type, 'checkout');
  assert.deepEqual(ok.index.get('id-2'), { childId: 'c1', type: 'checkout' });

  const bad = buildBackfillRows(
    [
      { ...emptyRow('c1'), checkinTime: '25:00', checkinWho: 'g:g1' },
      { ...emptyRow('c2'), checkinTime: '08:00', checkinWho: '', checkoutTime: '07:00', checkoutWho: 'g:g1' },
    ],
    options,
    '2026-09-10',
    tz,
    null,
    newId
  );
  assert.match(bad.errors['c1.checkin'], /Hora inválida/);
  assert.match(bad.errors['c2.checkin'], /Escolha quem/);
  // Checkout before checkin is only checked when the checkin row was accepted.
  assert.equal(bad.rows.length, 0);
  assert.match(bad.errors['c2.checkout'] ?? '', /Pessoa inválida/);

  const order = buildBackfillRows([{ ...emptyRow('c1'), checkinTime: '18:00', checkinWho: 'g:g1', checkoutTime: '17:00', checkoutWho: 'g:g1' }], options, '2026-09-10', tz, null, newId);
  assert.match(order.errors['c1.checkout'], /depois da entrada/);
  assert.equal(order.rows.length, 1);
});

test('mapBackfillResults maps statuses to row keys', () => {
  const result: CreateEventsResult = {
    batchId: 'b',
    undoUntil: null,
    warnings: [],
    results: [
      { clientId: 'x', childId: 'c1', status: 'created' },
      { clientId: 'y', childId: 'c1', status: 'rejected', error: { code: 'INVALID_STATE', message: 'Já estava fora' } },
      { clientId: 'z', childId: 'c9', status: 'duplicate' },
    ],
  };
  const index = new Map<string, { childId: string; type: 'checkin' | 'checkout' }>([
    ['x', { childId: 'c1', type: 'checkin' }],
    ['y', { childId: 'c1', type: 'checkout' }],
  ]);
  const out = mapBackfillResults(result, index);
  assert.equal(out['c1.checkin'].message, 'Lançado');
  assert.equal(out['c1.checkout'].status, 'rejected');
  assert.equal(out['c1.checkout'].message, 'Já estava fora');
  assert.equal(Object.keys(out).length, 2);
});

test('print cards: query parsing, chunking and model', () => {
  assert.deepEqual(parsePrintQuery('?ids=a,b,%20c&photo=1'), { ids: ['a', 'b', 'c'], className: null, photo: true });
  assert.deepEqual(parsePrintQuery('?className=Maternal%20I'), { ids: [], className: 'Maternal I', photo: false });
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  const cards = buildPrintCards(
    [
      { id: 'k1', ownerType: 'child', ownerId: 'c1', ownerName: 'Ana Souza', ownerClassName: 'Maternal I', code: 'AAAA2222', nfcUid: null, label: null, active: true, createdAt: '', revokedAt: null },
      { id: 'k2', ownerType: 'guardian', ownerId: 'g1', ownerName: 'Maria Silva', ownerClassName: null, code: 'BBBB3333', nfcUid: null, label: null, active: true, createdAt: '', revokedAt: null },
      { id: 'k3', ownerType: 'guardian', ownerId: 'g2', ownerName: 'Só NFC', ownerClassName: null, code: null, nfcUid: 'abcd', label: null, active: true, createdAt: '', revokedAt: null },
      { id: 'k4', ownerType: 'guardian', ownerId: 'g3', ownerName: 'Revogada', ownerClassName: null, code: 'CCCC4444', nfcUid: null, label: null, active: false, createdAt: '', revokedAt: '' },
    ],
    'https://creche.exemplo.com.br/',
    new Map([['child:c1', '/api/files/f1?t=x']]),
    true
  );
  assert.equal(cards.length, 2);
  assert.equal(cards[0].displayName, 'Ana S.');
  assert.equal(cards[0].codeText, 'AAAA-2222');
  assert.equal(cards[0].url, 'https://creche.exemplo.com.br/c/AAAA2222');
  assert.equal(cards[0].photoUrl, '/api/files/f1?t=x');
  assert.equal(cards[0].className, 'Maternal I');
  assert.equal(cards[1].className, null);
  assert.equal(cards[1].photoUrl, null);
});

test('child filters', () => {
  const kids = [
    child({ id: 'c1', name: 'Zé Pequeno', className: 'B', guardians: [guardian] }),
    child({ id: 'c2', name: 'Ana Lúcia', className: 'A', guardians: [{ ...guardian, reachable: 'none' }], consentAt: '2026-01-01', consentByName: 'Maria', consentRelationship: 'mae' }),
    child({ id: 'c3', name: 'Inativo', active: false, className: 'A' }),
  ];
  assert.deepEqual(classNames(kids), ['A', 'B']);
  assert.deepEqual(
    filterChildren(kids, {}).map((c) => c.id),
    ['c2', 'c1']
  );
  assert.deepEqual(
    filterChildren(kids, { includeInactive: true }).map((c) => c.id),
    ['c2', 'c3', 'c1']
  );
  assert.deepEqual(
    filterChildren(kids, { q: 'lucia' }).map((c) => c.id),
    ['c2']
  );
  assert.deepEqual(
    filterChildren(kids, { q: 'maria' }).map((c) => c.id),
    ['c2', 'c1'],
    'guardian names are searchable'
  );
  assert.deepEqual(
    filterChildren(kids, { flag: 'sem-contato' }).map((c) => c.id),
    ['c2']
  );
  assert.deepEqual(
    filterChildren(kids, { flag: 'sem-consentimento' }).map((c) => c.id),
    ['c1']
  );
  assert.equal(hasReachableGuardian(kids[0]), true);
  assert.equal(hasReachableGuardian(kids[1]), false);
});
