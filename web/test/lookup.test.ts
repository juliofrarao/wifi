import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChildGateDTO, ChildStatus, GuardianLinkGate, PickupAuthorizationDTO, ScanDirectory } from '@creche/shared';
import { buildLookupFromDirectory, classNamesOf, findCredential, guardianResultFromChild, hasAnyNfc, searchDirectory } from '../src/gate/lookup';

const TODAY = '2026-09-10';
const out: ChildStatus = { present: false, since: null, lastEvent: null, stale: false };
const present: ChildStatus = { present: true, since: '2026-09-10T10:45:00.000Z', lastEvent: null, stale: false };

function link(id: string, name: string, overrides: Partial<GuardianLinkGate> = {}): GuardianLinkGate {
  return {
    id,
    name,
    relationship: 'mae',
    relationshipLabel: 'Mãe',
    canPickup: true,
    isPrimary: true,
    validFrom: null,
    validUntil: null,
    pickupAllowedNow: true, // server value; must be recomputed
    photoUrl: null,
    blocked: false,
    ...overrides,
  };
}

function auth(id: string, overrides: Partial<PickupAuthorizationDTO> = {}): PickupAuthorizationDTO {
  return {
    id,
    childId: 'ana',
    personName: 'Ana Souza',
    personDocument: null,
    relationshipLabel: 'vizinha',
    phone: null,
    validFrom: TODAY,
    validUntil: TODAY,
    note: null,
    createdBy: { id: 'maria', name: 'Maria Silva', relationshipLabel: 'Mãe' },
    createdAt: '2026-09-10T08:00:00.000Z',
    revokedAt: null,
    validNow: true,
    ...overrides,
  };
}

function child(id: string, name: string, guardians: GuardianLinkGate[], overrides: Partial<ChildGateDTO> = {}): ChildGateDTO {
  return {
    id,
    name,
    birthDate: '2022-01-01',
    className: 'Turma A',
    shift: 'manha',
    photoUrl: null,
    active: true,
    status: out,
    createdAt: '2026-01-01T00:00:00.000Z',
    gateAlert: null,
    guardians,
    authorizedPersons: [],
    ...overrides,
  };
}

const dir: ScanDirectory = {
  generatedAt: '2026-09-10T09:00:00.000Z',
  version: 3,
  credentials: [
    { id: 'cred-maria', ownerType: 'guardian', ownerId: 'maria', code: 'AAAA2222', nfcUid: '04a1b2c3', active: true, revokedAt: null },
    { id: 'cred-old', ownerType: 'guardian', ownerId: 'maria', code: 'BBBB2222', nfcUid: null, active: false, revokedAt: '2026-09-01T00:00:00.000Z' },
    { id: 'cred-ana', ownerType: 'child', ownerId: 'ana', code: 'CCCC2222', nfcUid: null, active: true, revokedAt: null },
    { id: 'cred-joao', ownerType: 'guardian', ownerId: 'joao', code: 'DDDD2222', nfcUid: 'deadbeef', active: true, revokedAt: null },
  ],
  guardians: [
    { id: 'maria', name: 'Maria Silva', photoUrl: '/api/files/m?t=x', active: true },
    { id: 'joao', name: 'João Souza', photoUrl: null, active: true },
    { id: 'inativo', name: 'Zé Inativo', photoUrl: null, active: false },
  ],
  children: [
    child('ana', 'Ana Silva', [link('maria', 'Maria Silva'), link('joao', 'João Souza', { relationship: 'pai', relationshipLabel: 'Pai', validUntil: '2026-09-01' })], {
      status: present,
      authorizedPersons: [auth('auth-1'), auth('auth-old', { validUntil: '2026-09-09' }), auth('auth-revoked', { revokedAt: '2026-09-10T09:00:00.000Z' })],
    }),
    child('pedro', 'Pedro Silva', [link('maria', 'Maria Silva'), link('joao', 'João Souza', { relationship: 'pai', relationshipLabel: 'Pai', blocked: true })], { className: 'Turma B' }),
    child('bia', 'Beatriz Ação', [link('inativo', 'Zé Inativo')], { active: false, className: 'Turma C' }),
  ],
};

test('findCredential normalizes code/uid, prefers active, detects mismatch', () => {
  assert.equal(findCredential(dir, { code: 'aaaa-2222' }).credential?.id, 'cred-maria');
  assert.equal(findCredential(dir, { uid: '04:A1:B2:C3' }).credential?.id, 'cred-maria');
  assert.equal(findCredential(dir, { uid: '04:A1:B2:C3' }).matchedBy, 'nfc_uid');
  const revoked = findCredential(dir, { code: 'BBBB2222' });
  assert.equal(revoked.credential?.id, 'cred-old');
  assert.equal(revoked.credential?.active, false);
  assert.equal(findCredential(dir, { code: 'ZZZZ2222' }).credential, null);
  assert.equal(findCredential(dir, { code: 'AAAA2222', uid: 'deadbeef' }).mismatch, true);
  assert.equal(findCredential(dir, { code: 'AAAA2222', uid: '04a1b2c3' }).mismatch, false);
  assert.equal(findCredential(null, { code: 'AAAA2222' }).credential, null);
});

test('buildLookupFromDirectory: guardian with children, link flags recomputed for today', () => {
  const r = buildLookupFromDirectory(dir, 'guardian', 'maria', TODAY, { matchedBy: 'code', credentialId: 'cred-maria' });
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.result.kind, 'guardian');
  if (r.result.kind !== 'guardian') return;
  assert.equal(r.result.credentialId, 'cred-maria');
  assert.equal(r.result.matchedBy, 'code');
  assert.equal(r.result.guardian.name, 'Maria Silva');
  assert.deepEqual(
    r.result.children.map((c) => c.name),
    ['Ana Silva', 'Pedro Silva']
  );
  const ana = r.result.children[0];
  assert.equal(ana.relationshipLabel, 'Mãe');
  assert.equal(ana.pickupAllowedNow, true);
  assert.equal(ana.status.present, true);
  // Expired link on Ana's guardians list is recomputed to false even though the server said true.
  assert.equal(ana.guardians.find((g) => g.id === 'joao')?.pickupAllowedNow, false);
  // Only authorizations valid today survive.
  assert.deepEqual(
    ana.authorizedPersons.map((a) => a.id),
    ['auth-1']
  );
  // Inactive child is excluded even when linked.
  assert.equal(r.result.children.some((c) => c.id === 'bia'), false);
});

test('buildLookupFromDirectory: expired and blocked links, restriction, status overlay', () => {
  const r = buildLookupFromDirectory(dir, 'guardian', 'joao', TODAY, { statusOf: () => present });
  assert.ok(r.ok);
  if (!r.ok || r.result.kind !== 'guardian') return;
  const ana = r.result.children.find((c) => c.id === 'ana')!;
  const pedro = r.result.children.find((c) => c.id === 'pedro')!;
  assert.equal(ana.pickupAllowedNow, false, 'validUntil in the past');
  assert.equal(ana.blocked, false);
  assert.equal(pedro.pickupAllowedNow, false, 'blocked');
  assert.equal(pedro.blocked, true);
  assert.equal(pedro.status.present, true, 'statusOf overlay applied');
  assert.equal(r.result.matchedBy, 'search');

  const only = buildLookupFromDirectory(dir, 'guardian', 'joao', TODAY, { childIds: ['pedro'] });
  assert.ok(only.ok);
  if (only.ok && only.result.kind === 'guardian') assert.deepEqual(only.result.children.map((c) => c.id), ['pedro']);
});

test('buildLookupFromDirectory: child card, inactive and unknown owners', () => {
  const r = buildLookupFromDirectory(dir, 'child', 'ana', TODAY, { matchedBy: 'code', credentialId: 'cred-ana' });
  assert.ok(r.ok);
  if (!r.ok || r.result.kind !== 'child') return;
  assert.equal(r.result.child.name, 'Ana Silva');
  assert.equal(r.result.guardians.length, 2);
  assert.equal(r.result.guardians.find((g) => g.id === 'joao')?.pickupAllowedNow, false);
  assert.deepEqual(r.result.authorizedPersons.map((a) => a.id), ['auth-1']);

  const converted = guardianResultFromChild(r.result, 'joao', TODAY);
  assert.ok(converted && converted.kind === 'guardian');
  if (converted && converted.kind === 'guardian') {
    assert.equal(converted.guardian.name, 'João Souza');
    assert.equal(converted.children.length, 1);
    assert.equal(converted.children[0].pickupAllowedNow, false);
    assert.equal(converted.credentialId, 'cred-ana');
  }
  assert.equal(guardianResultFromChild(r.result, 'nobody', TODAY), null);

  assert.deepEqual(buildLookupFromDirectory(dir, 'guardian', 'inativo', TODAY), { ok: false, reason: 'inactive' });
  assert.deepEqual(buildLookupFromDirectory(dir, 'child', 'bia', TODAY), { ok: false, reason: 'inactive' });
  assert.deepEqual(buildLookupFromDirectory(dir, 'child', 'nope', TODAY), { ok: false, reason: 'not_found' });
});

test('searchDirectory ignores accents/case, filters by class, describes hits', () => {
  const hits = searchDirectory(dir, 'silva');
  assert.deepEqual(
    hits.map((h) => h.name),
    ['Ana Silva', 'Maria Silva', 'Pedro Silva']
  );
  const maria = hits.find((h) => h.ownerId === 'maria')!;
  assert.equal(maria.ownerType, 'guardian');
  assert.equal(maria.subtitle, 'Mãe de Ana, Pedro');
  assert.equal(hits.find((h) => h.ownerId === 'ana')?.subtitle, 'Turma A · Manhã');

  assert.deepEqual(searchDirectory(dir, 'JOAO').map((h) => h.ownerId), ['joao']);
  // Class filter: children of that class + guardians with a child in it (alphabetical when no prefix match).
  assert.deepEqual(searchDirectory(dir, 'silva', 'Turma B').map((h) => h.ownerId), ['maria', 'pedro']);
  assert.deepEqual(searchDirectory(dir, 'souza', 'Turma B').map((h) => h.ownerId), ['joao']);
  assert.equal(searchDirectory(dir, 'silva', 'Turma B').some((h) => h.ownerId === 'ana'), false);
  assert.equal(searchDirectory(dir, 'beatriz').length, 0, 'inactive children are hidden');
  assert.equal(searchDirectory(dir, '').length, 0);
  assert.equal(searchDirectory(null, 'ana').length, 0);
});

test('directory helpers', () => {
  assert.equal(hasAnyNfc(dir), true);
  assert.equal(hasAnyNfc({ ...dir, credentials: dir.credentials.filter((c) => !c.nfcUid) }), false);
  assert.deepEqual(classNamesOf(dir), ['Turma A', 'Turma B']);
});
