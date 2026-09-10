import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { addDays } from '@creche/shared';
import { ADMIN_PASSWORD, GUARD_PASSWORD, GUARDIAN_PASSWORD, createAdmin, createChild, createCredential, createGuard, createGuardian, createTestApp, get, insertEvent, link, login, post, request } from './helpers.js';

const TODAY = '2026-09-10';

test('lookup: code / uid / mismatch / revoked / inactive / not found, misses limited per session', async () => {
  const t = await createTestApp();
  try {
    await createAdmin(t, { email: 'dir@creche.test' });
    const guard = await createGuard(t, { login: 'carlos' });
    const gt = await login(t, 'carlos', GUARD_PASSWORD);
    const maria = await createGuardian(t, { email: 'maria@creche.test', name: 'Maria', phone: '11 9', password: GUARDIAN_PASSWORD });
    const jose = await createGuardian(t, { email: 'jose@creche.test', name: 'José' });
    const inactive = await createGuardian(t, { email: 'ina@creche.test', name: 'Inativo', active: false });
    const ana = createChild(t, { name: 'Ana', gateAlert: 'Chamar a direção', notes: 'segredo' });
    const pedro = createChild(t, { name: 'Pedro' });
    const off = createChild(t, { name: 'Desligada', active: false });
    link(t, ana.id, maria.id, { relationship: 'mae', isPrimary: true });
    link(t, pedro.id, maria.id, { relationship: 'tia', canPickup: false });
    link(t, off.id, maria.id, { relationship: 'mae' });
    link(t, ana.id, jose.id, { relationship: 'pai', blocked: true });
    insertEvent(t, { childId: ana.id, type: 'checkin', guardId: guard.id, guardianId: maria.id, occurredAt: '2026-09-10T10:45:00.000Z' });
    const card = createCredential(t, 'guardian', maria.id, { nfcUid: '04:A2:24:C2:D6:1E:80' });
    const joseCard = createCredential(t, 'guardian', jose.id, { nfcUid: '04b3c5d7e9f180' });
    const inactiveCard = createCredential(t, 'guardian', inactive.id);
    const revoked = createCredential(t, 'guardian', maria.id);
    t.db.prepare(`UPDATE credentials SET active = 0, revoked_at = ? WHERE id = ?`).run(t.clock.now().toISOString(), revoked.id);

    const byCode = await post(t, '/api/scan/lookup', { code: `${card.code!.slice(0, 4).toLowerCase()}-${card.code!.slice(4)}` }, gt);
    assert.equal(byCode.status, 200, JSON.stringify(byCode.body));
    assert.equal(byCode.body.kind, 'guardian');
    assert.equal(byCode.body.matchedBy, 'code');
    assert.equal(byCode.body.credentialId, card.id);
    assert.deepEqual(byCode.body.guardian, { id: maria.id, name: 'Maria', photoUrl: null });
    assert.deepEqual(byCode.body.children.map((c: { name: string }) => c.name), ['Ana', 'Pedro'], 'inactive child hidden');
    const anaDto = byCode.body.children[0];
    assert.equal(anaDto.relationship, 'mae');
    assert.equal(anaDto.relationshipLabel, 'Mãe');
    assert.equal(anaDto.pickupAllowedNow, true);
    assert.equal(anaDto.status.present, true);
    assert.equal(anaDto.gateAlert, 'Chamar a direção');
    assert.equal('notes' in anaDto, false);
    assert.equal(anaDto.guardians.find((g: { id: string }) => g.id === jose.id).blocked, true);
    assert.equal(byCode.body.children[1].canPickup, false);
    assert.equal(byCode.body.children[1].pickupAllowedNow, false);
    assert.doesNotMatch(JSON.stringify(byCode.body), /maria@creche\.test|segredo|"phone"/);

    const byUid = await post(t, '/api/scan/lookup', { uid: '04:A2:24:C2:D6:1E:80' }, gt);
    assert.equal(byUid.body.matchedBy, 'nfc_uid');
    assert.equal(byUid.body.credentialId, card.id);
    // Code of Maria + uid of José → mismatch; code of Maria + her own uid → fine (code wins).
    const mismatch = await post(t, '/api/scan/lookup', { code: card.code, uid: '04b3c5d7e9f180' }, gt);
    assert.equal(mismatch.status, 409);
    assert.equal(mismatch.body.error.code, 'CREDENTIAL_MISMATCH');
    assert.equal((await post(t, '/api/scan/lookup', { code: card.code, uid: card.nfc_uid }, gt)).body.matchedBy, 'code');
    assert.equal((await post(t, '/api/scan/lookup', { code: 'ZZZZ9999', uid: joseCard.nfc_uid }, gt)).body.guardian.id, jose.id, 'unknown code falls through to the uid');

    const rev = await post(t, '/api/scan/lookup', { code: revoked.code }, gt);
    assert.equal(rev.status, 404);
    assert.equal(rev.body.error.code, 'CARD_REVOKED');
    const ina = await post(t, '/api/scan/lookup', { code: inactiveCard.code }, gt);
    assert.equal(ina.status, 404);
    assert.equal(ina.body.error.code, 'OWNER_INACTIVE');
    const missing = await post(t, '/api/scan/lookup', { code: 'ABCD-2345' }, gt);
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, 'CARD_NOT_FOUND');
    assert.equal((await post(t, '/api/scan/lookup', {}, gt)).status, 400);

    // Only misses count: 20 per 10 min per session.
    for (let i = 0; i < 17; i++) assert.equal((await post(t, '/api/scan/lookup', { code: 'ABCD-2345' }, gt)).status, 404);
    assert.equal((await post(t, '/api/scan/lookup', { code: card.code }, gt)).status, 200, 'hits are never limited before the cap');
    assert.equal((await post(t, '/api/scan/lookup', { code: 'ABCD-2345' }, gt)).status, 404, '20th miss');
    const limited = await post(t, '/api/scan/lookup', { code: card.code }, gt);
    assert.equal(limited.status, 429);
    assert.ok(limited.body.error.details.retryAfterSeconds > 0);
    assert.ok(limited.headers['retry-after']);
    // Another session is not affected; the window clears after 10 minutes.
    const gt2 = await login(t, 'carlos', GUARD_PASSWORD);
    assert.equal((await post(t, '/api/scan/lookup', { code: card.code }, gt2)).status, 200);
    t.clock.advance(11 * 60_000);
    assert.equal((await post(t, '/api/scan/lookup', { code: card.code }, gt)).status, 200);

    const guardianToken = await login(t, 'maria@creche.test', GUARDIAN_PASSWORD);
    assert.equal((await post(t, '/api/scan/lookup', { code: card.code }, guardianToken)).status, 403);
  } finally {
    await t.close();
  }
});

test('child card and manual lookup', async () => {
  const t = await createTestApp();
  try {
    const guard = await createGuard(t, { login: 'carlos' });
    const gt = await login(t, 'carlos', GUARD_PASSWORD);
    const maria = await createGuardian(t, { email: 'maria@creche.test', name: 'Maria' });
    const ana = createChild(t, { name: 'Ana' });
    link(t, ana.id, maria.id, { relationship: 'mae' });
    t.db
      .prepare(
        `INSERT INTO pickup_authorizations (id, child_id, person_name, person_document, relationship_label, phone, valid_from, valid_until, note, created_by, created_at, revoked_at, revoked_by)
         VALUES (?, ?, 'Rosa', '123', 'vizinha', NULL, ?, ?, NULL, ?, ?, NULL, NULL), (?, ?, 'Antiga', NULL, 'tia', NULL, ?, ?, NULL, ?, ?, NULL, NULL)`
      )
      .run(randomUUID(), ana.id, TODAY, TODAY, maria.id, t.clock.now().toISOString(), randomUUID(), ana.id, addDays(TODAY, -5), addDays(TODAY, -1), maria.id, t.clock.now().toISOString());
    const card = createCredential(t, 'child', ana.id);
    void guard;

    const res = await post(t, '/api/scan/lookup', { code: card.code }, gt);
    assert.equal(res.status, 200);
    assert.equal(res.body.kind, 'child');
    assert.equal(res.body.child.name, 'Ana');
    assert.equal(res.body.credentialId, card.id);
    assert.deepEqual(res.body.guardians.map((g: { name: string; relationshipLabel: string }) => [g.name, g.relationshipLabel]), [['Maria', 'Mãe']]);
    assert.equal(res.body.authorizedPersons.length, 1, 'only valid today');
    assert.equal(res.body.authorizedPersons[0].personName, 'Rosa');
    assert.equal(res.body.authorizedPersons[0].personDocument, null);
    assert.equal(res.body.authorizedPersons[0].createdBy.relationshipLabel, 'Mãe');

    const manual = await post(t, '/api/scan/manual', { ownerType: 'guardian', ownerId: maria.id }, gt);
    assert.equal(manual.status, 200);
    assert.equal(manual.body.kind, 'guardian');
    assert.equal(manual.body.matchedBy, 'search');
    assert.equal(manual.body.credentialId, null);
    const manualChild = await post(t, '/api/scan/manual', { ownerType: 'child', ownerId: ana.id }, gt);
    assert.equal(manualChild.body.kind, 'child');
    assert.equal(manualChild.body.matchedBy, 'search');
    assert.equal((await post(t, '/api/scan/manual', { ownerType: 'child', ownerId: randomUUID() }, gt)).status, 404);
    assert.equal((await post(t, '/api/scan/manual', { ownerType: 'child', ownerId: 'nope' }, gt)).status, 400);
  } finally {
    await t.close();
  }
});

test('directory: shape without contacts/notes, revoked ≤ 90 days, only linked active guardians, ETag/304, heartbeat', async () => {
  const t = await createTestApp();
  try {
    await createAdmin(t, { email: 'dir@creche.test' });
    const admin = await login(t, 'dir@creche.test', ADMIN_PASSWORD);
    const guard = await createGuard(t, { login: 'carlos' });
    const gt = await login(t, 'carlos', GUARD_PASSWORD);
    const maria = await createGuardian(t, { email: 'maria@creche.test', name: 'Maria', phone: '11 98765-4321' });
    const unlinked = await createGuardian(t, { email: 'solto@creche.test', name: 'Solto' });
    const ana = createChild(t, { name: 'Ana', notes: 'confidencial', gateAlert: 'aviso' });
    const off = createChild(t, { name: 'Desligada', active: false });
    link(t, ana.id, maria.id, { relationship: 'mae' });
    const card = createCredential(t, 'guardian', maria.id, { nfcUid: '04aabbccdd' });
    const anaCard = createCredential(t, 'child', ana.id);
    const offCard = createCredential(t, 'child', off.id);
    const recent = createCredential(t, 'guardian', maria.id);
    const old = createCredential(t, 'guardian', maria.id);
    const unlinkedCard = createCredential(t, 'guardian', unlinked.id);
    t.db.prepare(`UPDATE credentials SET active = 0, revoked_at = ? WHERE id = ?`).run('2026-08-01T12:00:00.000Z', recent.id);
    t.db.prepare(`UPDATE credentials SET active = 0, revoked_at = ? WHERE id = ?`).run('2026-05-01T12:00:00.000Z', old.id);

    const res = await request(t, { method: 'GET', url: '/api/scan/directory', token: gt });
    assert.equal(res.status, 200);
    const etag = res.headers.etag as string;
    assert.ok(etag);
    const dir = res.body;
    assert.equal(dir.generatedAt, '2026-09-10T12:00:00.000Z');
    assert.equal(typeof dir.version, 'number');
    const credIds = dir.credentials.map((c: { id: string }) => c.id).sort();
    assert.deepEqual(credIds, [card.id, anaCard.id, recent.id, unlinkedCard.id].sort(), 'active of active owners + revoked in 90 days');
    assert.equal(dir.credentials.find((c: { id: string }) => c.id === recent.id).active, false);
    assert.equal(dir.credentials.find((c: { id: string }) => c.id === card.id).nfcUid, '04aabbccdd');
    assert.ok(!credIds.includes(offCard.id));
    assert.deepEqual(dir.guardians, [{ id: maria.id, name: 'Maria', photoUrl: null, active: true }]);
    assert.deepEqual(dir.children.map((c: { name: string }) => c.name), ['Ana']);
    assert.equal(dir.children[0].gateAlert, 'aviso');
    assert.equal(dir.children[0].guardians[0].relationshipLabel, 'Mãe');
    assert.doesNotMatch(JSON.stringify(dir), /confidencial|98765|maria@creche|"email"|"phone"|"notes"/);

    const notModified = await request(t, { method: 'GET', url: '/api/scan/directory', token: gt, headers: { 'if-none-match': etag } });
    assert.equal(notModified.status, 304);
    // An attendance change (statuses) or a directory change (version) invalidates the ETag.
    insertEvent(t, { childId: ana.id, type: 'checkin', guardId: guard.id, guardianId: maria.id, occurredAt: '2026-09-10T11:00:00.000Z' });
    const changed = await request(t, { method: 'GET', url: '/api/scan/directory', token: gt, headers: { 'if-none-match': etag } });
    assert.equal(changed.status, 200);
    assert.notEqual(changed.headers.etag, etag);
    assert.equal(changed.body.children[0].status.present, true);
    const etag2 = changed.headers.etag as string;
    assert.equal((await request(t, { method: 'GET', url: '/api/scan/directory', token: gt, headers: { 'if-none-match': etag2 } })).status, 304);
    await post(t, `/api/credentials`, { ownerType: 'guardian', ownerId: maria.id }, admin);
    assert.equal((await request(t, { method: 'GET', url: '/api/scan/directory', token: gt, headers: { 'if-none-match': etag2 } })).status, 200);
    assert.equal((await get(t, '/api/scan/directory', admin)).status, 200);

    // Heartbeat upsert per session.
    assert.equal((await post(t, '/api/scan/heartbeat', { queuedCount: 3, oldestQueuedAt: '2026-09-10T08:40:00-03:00', appVersion: 'dev' }, gt)).status, 204);
    assert.equal((await post(t, '/api/scan/heartbeat', { queuedCount: 1, oldestQueuedAt: '2026-09-10T08:50:00-03:00', appVersion: 'dev' }, gt)).status, 204);
    const status = await get(t, '/api/admin/gate-status', admin);
    assert.equal(status.body.length, 1);
    assert.equal(status.body[0].queuedCount, 1);
    assert.equal(status.body[0].oldestQueuedAt, '2026-09-10T11:50:00.000Z');
    assert.equal(status.body[0].guardName, guard.name);
    assert.equal((await post(t, '/api/scan/heartbeat', { queuedCount: -1 }, gt)).status, 400);
  } finally {
    await t.close();
  }
});
