import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addDays } from '@creche/shared';
import {
  ADMIN_PASSWORD,
  GUARD_PASSWORD,
  GUARDIAN_PASSWORD,
  createAdmin,
  createChild,
  createGuard,
  createGuardian,
  createTestApp,
  del,
  fakeJpeg,
  get,
  insertEvent,
  link,
  login,
  multipart,
  patch,
  post,
  put,
  request,
} from './helpers.js';

const TODAY = '2026-09-10';

test('projections per role: admin sees everything, guard no notes/contacts, guardian no gateAlert/co-guardian photos', async () => {
  const t = await createTestApp();
  try {
    await createAdmin(t, { email: 'dir@creche.test' });
    const admin = await login(t, 'dir@creche.test', ADMIN_PASSWORD);
    const guard = await createGuard(t, { login: 'carlos' });
    const guardToken = await login(t, 'carlos', GUARD_PASSWORD);
    const maria = await createGuardian(t, { email: 'maria@creche.test', name: 'Maria', phone: '11 91111-1111' });
    const jose = await createGuardian(t, { email: 'jose@creche.test', name: 'José' });
    const blocked = await createGuardian(t, { email: 'bloq@creche.test', name: 'Bloqueado' });
    const stranger = await createGuardian(t, { email: 'outra@creche.test' });
    const child = createChild(t, { name: 'Ana Souza', gateAlert: 'Não entregar ao pai', notes: 'alergia a amendoim' });
    link(t, child.id, maria.id, { relationship: 'mae', isPrimary: true });
    link(t, child.id, jose.id, { relationship: 'pai', canPickup: false });
    link(t, child.id, blocked.id, { relationship: 'tio', blocked: true, blockedReason: 'decisão judicial' });

    // Give José a photo through the admin route so the projection has something to hide.
    const photo = multipart([{ name: 'photo', data: fakeJpeg(), filename: 'jose.jpg', contentType: 'image/jpeg' }]);
    const up = await request(t, { method: 'POST', url: `/api/users/${jose.id}/photo`, payload: photo.payload, headers: photo.headers, token: admin });
    assert.equal(up.status, 200);
    assert.match(up.body.photoUrl, /^\/api\/files\/[0-9a-f-]{36}\?t=[A-Za-z0-9_-]{32}$/);

    // Admin
    const a = await get(t, `/api/children/${child.id}`, admin);
    assert.equal(a.status, 200);
    assert.equal(a.body.notes, 'alergia a amendoim');
    assert.equal(a.body.gateAlert, 'Não entregar ao pai');
    assert.equal(a.body.guardians.length, 3);
    const aMaria = a.body.guardians.find((g: { id: string }) => g.id === maria.id);
    assert.equal(aMaria.email, 'maria@creche.test');
    assert.equal(aMaria.phone, '11 91111-1111');
    assert.equal(aMaria.reachable, 'email');
    assert.equal(aMaria.pickupAllowedNow, true);
    assert.equal(aMaria.isPrimary, true);
    const aBlocked = a.body.guardians.find((g: { id: string }) => g.id === blocked.id);
    assert.equal(aBlocked.blocked, true);
    assert.equal(aBlocked.blockedReason, 'decisão judicial');
    assert.equal(aBlocked.reachable, 'none');
    assert.equal(aBlocked.pickupAllowedNow, false);
    assert.deepEqual(a.body.status, { present: false, since: null, lastEvent: null, stale: false });
    assert.ok(Array.isArray(a.body.credentials));
    assert.ok(Array.isArray(a.body.recentEvents));
    assert.ok(Array.isArray(a.body.authorizations));
    assert.equal(a.body.consentAt, '2026-02-01');

    // Guard
    const g = await get(t, `/api/children/${child.id}`, guardToken);
    assert.equal(g.status, 200);
    assert.equal(g.body.gateAlert, 'Não entregar ao pai');
    assert.equal('notes' in g.body, false);
    assert.equal('consentAt' in g.body, false);
    const gJose = g.body.guardians.find((x: { id: string }) => x.id === jose.id);
    assert.equal('email' in gJose, false);
    assert.equal('phone' in gJose, false);
    assert.equal('blockedReason' in gJose, false);
    assert.match(gJose.photoUrl, /^\/api\/files\//);
    assert.equal(gJose.canPickup, false);
    assert.equal(gJose.pickupAllowedNow, false);
    assert.equal(g.body.guardians.find((x: { id: string }) => x.id === blocked.id).blocked, true);

    const gList = await get(t, '/api/children?q=ana', guardToken);
    assert.equal(gList.status, 200);
    assert.equal(gList.body.length, 1);
    assert.equal('notes' in gList.body[0], false);
    const aList = await get(t, '/api/children?className=Maternal%20I', admin);
    assert.equal(aList.body[0].notes, 'alergia a amendoim');

    // Guardian (Maria)
    const mariaToken = await login(t, 'maria@creche.test', GUARDIAN_PASSWORD);
    const m = await get(t, `/api/children/${child.id}`, mariaToken);
    assert.equal(m.status, 200);
    assert.equal('gateAlert' in m.body, false);
    assert.equal('notes' in m.body, false);
    assert.equal(m.body.myRelationship, 'mae');
    assert.equal(m.body.myCanPickup, true);
    assert.equal(m.body.guardians.length, 2, 'blocked link is hidden from guardians');
    const mJose = m.body.guardians.find((x: { id: string }) => x.id === jose.id);
    assert.equal(mJose.name, 'José');
    assert.equal(mJose.relationshipLabel, 'Pai');
    assert.equal(mJose.canPickup, false);
    assert.equal('photoUrl' in mJose, false);
    assert.equal('email' in mJose, false);
    assert.equal('blocked' in mJose, false);

    // Unlinked guardian and blocked guardian: forbidden. Guard cannot list users.
    const strangerToken = await login(t, stranger.email!, GUARDIAN_PASSWORD);
    assert.equal((await get(t, `/api/children/${child.id}`, strangerToken)).status, 403);
    const blockedToken = await login(t, blocked.email!, GUARDIAN_PASSWORD);
    assert.equal((await get(t, `/api/children/${child.id}`, blockedToken)).status, 403);
    assert.equal((await get(t, '/api/children', mariaToken)).status, 403);
    assert.equal((await get(t, `/api/children/${child.id}`)).status, 401);
  } finally {
    await t.close();
  }
});

test('/me/children: includes inactive children (active:false), excludes blocked and removed links', async () => {
  const t = await createTestApp();
  try {
    const maria = await createGuardian(t, { email: 'maria@creche.test' });
    const guard = await createGuard(t);
    const ana = createChild(t, { name: 'Ana' });
    const pedro = createChild(t, { name: 'Pedro', active: false });
    const outro = createChild(t, { name: 'Outro' });
    const removed = createChild(t, { name: 'Removida' });
    link(t, ana.id, maria.id, { relationship: 'mae' });
    link(t, pedro.id, maria.id, { relationship: 'mae' });
    link(t, outro.id, maria.id, { relationship: 'tia', blocked: true });
    const l = link(t, removed.id, maria.id);
    t.db.prepare('UPDATE child_guardians SET removed_at = ? WHERE id = ?').run(t.clock.now().toISOString(), l.id);
    insertEvent(t, { childId: ana.id, type: 'checkin', guardId: guard.id, guardianId: maria.id, occurredAt: '2026-09-10T10:45:00.000Z' });

    const token = await login(t, 'maria@creche.test', GUARDIAN_PASSWORD);
    const res = await get(t, '/api/me/children', token);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.map((c: { name: string }) => c.name), ['Ana', 'Pedro']);
    assert.equal(res.body[0].status.present, true);
    assert.equal(res.body[0].status.since, '2026-09-10T10:45:00.000Z');
    assert.equal(res.body[0].status.stale, false);
    assert.equal(res.body[0].status.lastEvent.personDocument, null);
    assert.equal(res.body[1].active, false);
  } finally {
    await t.close();
  }
});

test('status: stale when present since a previous civil day (daycare TZ); voided events ignored', async () => {
  const t = await createTestApp();
  try {
    await createAdmin(t, { email: 'dir@creche.test' });
    const admin = await login(t, 'dir@creche.test', ADMIN_PASSWORD);
    const guard = await createGuard(t);
    const child = createChild(t, { name: 'Ana' });
    // 2026-09-09 23:30 São Paulo = 2026-09-10T02:30Z — still "yesterday" locally.
    insertEvent(t, { childId: child.id, type: 'checkin', guardId: guard.id, occurredAt: '2026-09-10T02:30:00.000Z' });
    const res = await get(t, `/api/children/${child.id}`, admin);
    assert.equal(res.body.status.present, true);
    assert.equal(res.body.status.stale, true);

    // A later voided checkout does not change the status; a valid one does.
    insertEvent(t, { childId: child.id, type: 'checkout', guardId: guard.id, occurredAt: '2026-09-10T11:00:00.000Z', voidedAt: '2026-09-10T11:01:00.000Z' });
    assert.equal((await get(t, `/api/children/${child.id}`, admin)).body.status.present, true);
    insertEvent(t, { childId: child.id, type: 'checkout', guardId: guard.id, occurredAt: '2026-09-10T11:30:00.000Z' });
    const out = await get(t, `/api/children/${child.id}`, admin);
    assert.equal(out.body.status.present, false);
    assert.equal(out.body.status.lastEvent.type, 'checkout');

    // Same occurred_at: created_at DESC then id DESC decides.
    insertEvent(t, { childId: child.id, type: 'checkin', guardId: guard.id, occurredAt: '2026-09-10T12:00:00.000Z' });
    assert.equal((await get(t, `/api/children/${child.id}`, admin)).body.status.present, true);
  } finally {
    await t.close();
  }
});

test('POST /children, PATCH /children (deactivate present child → automatic checkout, no notifications)', async () => {
  const t = await createTestApp();
  try {
    await createAdmin(t, { email: 'dir@creche.test', name: 'Direção' });
    const admin = await login(t, 'dir@creche.test', ADMIN_PASSWORD);
    const guard = await createGuard(t);

    const created = await post(
      t,
      '/api/children',
      { name: 'Pedro Lima', birthDate: '2021-08-15', className: 'Maternal II', shift: 'integral', consentAt: TODAY, consentByName: 'Carla', consentRelationship: 'mae' },
      admin
    );
    assert.equal(created.status, 201);
    assert.equal(created.body.shift, 'integral');
    assert.equal(created.body.consentRelationship, 'mae');
    const badDate = await post(t, '/api/children', { name: 'X Y', birthDate: '2021-02-30' }, admin);
    assert.equal(badDate.status, 400);
    const badRel = await post(t, '/api/children', { name: 'X Y', consentRelationship: 'tia' }, admin);
    assert.equal(badRel.status, 400);

    const id = created.body.id as string;
    insertEvent(t, { childId: id, type: 'checkin', guardId: guard.id, occurredAt: '2026-09-10T10:45:00.000Z' });
    const version = (await get(t, '/api/config')).body.directoryVersion;

    const off = await patch(t, `/api/children/${id}`, { active: false, notes: 'mudou de cidade' }, admin);
    assert.equal(off.status, 200);
    assert.equal(off.body.active, false);
    assert.ok(off.body.deactivatedAt);
    assert.equal(off.body.notes, 'mudou de cidade');
    assert.equal(off.body.status.present, false);
    const auto = off.body.status.lastEvent;
    assert.equal(auto.type, 'checkout');
    assert.equal(auto.method, 'auto');
    assert.equal(auto.note, 'Desligamento');
    assert.equal(auto.guardName, 'Direção');
    assert.equal(t.notifier.calls.length, 0);
    const notifications = t.db.prepare('SELECT COUNT(*) AS n FROM notifications').get() as { n: number };
    assert.equal(notifications.n, 0);
    assert.equal((await get(t, '/api/config')).body.directoryVersion, version + 1);

    // Inactive children are hidden from the guard and from the default admin list.
    const gt = await login(t, guard.login!, GUARD_PASSWORD);
    assert.equal((await get(t, `/api/children/${id}`, gt)).status, 404);
    assert.equal((await get(t, '/api/children', admin)).body.length, 0);
    assert.equal((await get(t, '/api/children?includeInactive=true', admin)).body.length, 1);

    // Reactivating clears deactivated_at; deactivating an already-out child adds no event.
    const on = await patch(t, `/api/children/${id}`, { active: true }, admin);
    assert.equal(on.body.deactivatedAt, null);
    const events = () => (t.db.prepare('SELECT COUNT(*) AS n FROM attendance_events').get() as { n: number }).n;
    const before = events();
    await patch(t, `/api/children/${id}`, { active: false }, admin);
    assert.equal(events(), before);

    // Anonymize (only inactive).
    const anon = await post(t, `/api/children/${id}/anonymize`, { reason: 'retenção' }, admin);
    assert.equal(anon.status, 204);
    const after = await get(t, `/api/children/${id}`, admin);
    assert.match(after.body.name, /^Criança removida #[0-9A-F]{4}$/);
    assert.equal(after.body.birthDate, null);
    assert.equal(after.body.notes, null);
    assert.ok(after.body.anonymizedAt);
    assert.equal(after.body.recentEvents.length, 2, 'events are kept');
    assert.equal(after.body.recentEvents[1].childName, 'Pedro Lima', 'snapshots survive');
  } finally {
    await t.close();
  }
});

test('guardian links: create new guardian for child, PUT/DELETE link, R16 notifier calls', async () => {
  const t = await createTestApp();
  try {
    await createAdmin(t, { email: 'dir@creche.test' });
    const admin = await login(t, 'dir@creche.test', ADMIN_PASSWORD);
    const child = createChild(t, { name: 'Ana' });

    const created = await post(
      t,
      `/api/children/${child.id}/guardians`,
      { name: 'Maria Souza', email: 'maria@creche.test', phone: '11 91234-5678', relationship: 'mae', canPickup: true, isPrimary: true },
      admin
    );
    assert.equal(created.status, 201);
    assert.equal(created.body.guardian.role, 'guardian');
    assert.equal(created.body.invite.sent, true);
    assert.equal(created.body.child.guardians.length, 1);
    assert.equal(created.body.child.guardians[0].isPrimary, true);
    assert.deepEqual(t.notifier.calls.map((c) => c.method), ['guardianAdded']);
    const mariaId = created.body.guardian.id as string;

    const dup = await post(t, `/api/children/${child.id}/guardians`, { name: 'Outra', email: 'maria@creche.test', relationship: 'tia', canPickup: true }, admin);
    assert.equal(dup.status, 409);
    assert.equal(dup.body.error.code, 'EMAIL_IN_USE');

    // Existing guardian linked without pickup → no notification; enabling pickup → notification.
    const tia = await createGuardian(t, { email: 'tia@creche.test', name: 'Tia' });
    t.notifier.calls.length = 0;
    const l1 = await put(t, `/api/children/${child.id}/guardians/${tia.id}`, { relationship: 'tia', canPickup: false }, admin);
    assert.equal(l1.status, 200);
    assert.equal(l1.body.guardians.length, 2);
    assert.equal(t.notifier.calls.length, 0);
    const l2 = await put(t, `/api/children/${child.id}/guardians/${tia.id}`, { relationship: 'tia', canPickup: true, validUntil: addDays(TODAY, 3) }, admin);
    assert.equal(l2.status, 200);
    assert.deepEqual(t.notifier.calls.map((c) => c.method), ['guardianAdded']);
    assert.deepEqual(t.notifier.calls[0].args.slice(0, 2), [child.id, tia.id]);
    // Extending the validity notifies again; same validity does not.
    t.notifier.calls.length = 0;
    await put(t, `/api/children/${child.id}/guardians/${tia.id}`, { relationship: 'tia', canPickup: true, validUntil: addDays(TODAY, 3) }, admin);
    assert.equal(t.notifier.calls.length, 0);
    await put(t, `/api/children/${child.id}/guardians/${tia.id}`, { relationship: 'tia', canPickup: true, validUntil: addDays(TODAY, 10) }, admin);
    assert.equal(t.notifier.calls.length, 1);
    // Blocking never notifies.
    t.notifier.calls.length = 0;
    const blocked = await put(t, `/api/children/${child.id}/guardians/${tia.id}`, { relationship: 'tia', canPickup: true, blocked: true, blockedReason: 'direção' }, admin);
    assert.equal(blocked.body.guardians.find((g: { id: string }) => g.id === tia.id).blocked, true);
    assert.equal(t.notifier.calls.length, 0);

    // Primary flag moves to the new primary.
    await put(t, `/api/children/${child.id}/guardians/${tia.id}`, { relationship: 'tia', canPickup: true, isPrimary: true }, admin);
    const detail = await get(t, `/api/children/${child.id}`, admin);
    assert.equal(detail.body.guardians.filter((g: { isPrimary: boolean }) => g.isPrimary).length, 1);

    // Soft removal.
    const removed = await del(t, `/api/children/${child.id}/guardians/${mariaId}`, admin);
    assert.equal(removed.status, 200);
    assert.equal(removed.body.guardians.length, 1);
    assert.equal((await del(t, `/api/children/${child.id}/guardians/${mariaId}`, admin)).status, 404);
    const links = t.db.prepare('SELECT COUNT(*) AS n FROM child_guardians WHERE removed_at IS NOT NULL').get() as { n: number };
    assert.equal(links.n, 1);

    // Unknown user / wrong role.
    assert.equal((await put(t, `/api/children/${child.id}/guardians/00000000-0000-4000-8000-000000000000`, { relationship: 'mae', canPickup: true }, admin)).status, 404);
  } finally {
    await t.close();
  }
});

test('pickup authorizations: guardian with canPickup creates (no document visible), admin sees document, rules and revocation', async () => {
  const t = await createTestApp();
  try {
    await createAdmin(t, { email: 'dir@creche.test' });
    const admin = await login(t, 'dir@creche.test', ADMIN_PASSWORD);
    const maria = await createGuardian(t, { email: 'maria@creche.test', name: 'Maria' });
    const jose = await createGuardian(t, { email: 'jose@creche.test', name: 'José' });
    const expired = await createGuardian(t, { email: 'exp@creche.test', name: 'Vencida' });
    const child = createChild(t, { name: 'Ana' });
    link(t, child.id, maria.id, { relationship: 'mae' });
    link(t, child.id, jose.id, { relationship: 'pai', canPickup: false });
    link(t, child.id, expired.id, { relationship: 'tia', validUntil: addDays(TODAY, -1) });
    const mariaToken = await login(t, 'maria@creche.test', GUARDIAN_PASSWORD);
    const joseToken = await login(t, 'jose@creche.test', GUARDIAN_PASSWORD);
    const expiredToken = await login(t, 'exp@creche.test', GUARDIAN_PASSWORD);

    const body = { personName: 'Ana Souza', personDocument: '123.456.789-00', relationshipLabel: 'vizinha', phone: '11 90000-0000' };
    assert.equal((await post(t, `/api/children/${child.id}/pickup-authorizations`, body, joseToken)).status, 403);
    assert.equal((await post(t, `/api/children/${child.id}/pickup-authorizations`, body, expiredToken)).status, 403);

    const created = await post(t, `/api/children/${child.id}/pickup-authorizations`, body, mariaToken);
    assert.equal(created.status, 201);
    assert.equal(created.body.validFrom, TODAY);
    assert.equal(created.body.validUntil, TODAY);
    assert.equal(created.body.validNow, true);
    assert.equal(created.body.personDocument, null);
    assert.deepEqual(created.body.createdBy, { id: maria.id, name: 'Maria', relationshipLabel: 'Mãe' });
    assert.deepEqual(t.notifier.calls.map((c) => c.method), ['authorizationAdded']);
    assert.equal(t.notifier.calls[0].args[0], created.body.id);

    const adminView = await get(t, `/api/children/${child.id}/pickup-authorizations`, admin);
    assert.equal(adminView.body.length, 1);
    assert.equal(adminView.body[0].personDocument, '123.456.789-00');
    const guardianView = await get(t, `/api/children/${child.id}/pickup-authorizations`, joseToken);
    assert.equal(guardianView.status, 200, 'any linked guardian may list');
    assert.equal(guardianView.body[0].personDocument, null);

    // Appears in the child projections for today.
    const detail = await get(t, `/api/children/${child.id}`, mariaToken);
    assert.equal(detail.body.authorizedPersons.length, 1);
    assert.equal(detail.body.authorizedPersons[0].createdBy.relationshipLabel, 'Mãe');

    // Validation: max 30 days, end before start, already expired.
    const tooLong = await post(t, `/api/children/${child.id}/pickup-authorizations`, { ...body, validFrom: TODAY, validUntil: addDays(TODAY, 31) }, admin);
    assert.equal(tooLong.status, 400);
    const backwards = await post(t, `/api/children/${child.id}/pickup-authorizations`, { ...body, validFrom: addDays(TODAY, 2), validUntil: TODAY }, admin);
    assert.equal(backwards.status, 400);
    const past = await post(t, `/api/children/${child.id}/pickup-authorizations`, { ...body, validFrom: addDays(TODAY, -5), validUntil: addDays(TODAY, -2) }, admin);
    assert.equal(past.status, 400);
    const future = await post(t, `/api/children/${child.id}/pickup-authorizations`, { ...body, validFrom: addDays(TODAY, 2), validUntil: addDays(TODAY, 4) }, admin);
    assert.equal(future.status, 201);
    assert.equal(future.body.validNow, false);
    assert.equal(future.body.createdBy.relationshipLabel, null, 'admin creator has no relationship');
    assert.equal((await get(t, `/api/children/${child.id}`, admin)).body.authorizedPersons.length, 1, 'only valid today');
    assert.equal((await get(t, `/api/children/${child.id}`, admin)).body.authorizations.length, 2, 'admin sees current + future');

    // Revocation: only creator or admin.
    assert.equal((await del(t, `/api/children/${child.id}/pickup-authorizations/${created.body.id}`, joseToken)).status, 403);
    assert.equal((await del(t, `/api/children/${child.id}/pickup-authorizations/${created.body.id}`, mariaToken)).status, 204);
    const afterRevoke = await get(t, `/api/children/${child.id}/pickup-authorizations?includeExpired=true`, admin);
    const revoked = afterRevoke.body.find((a: { id: string }) => a.id === created.body.id);
    assert.ok(revoked.revokedAt);
    assert.equal(revoked.validNow, false);
    assert.equal((await get(t, `/api/children/${child.id}/pickup-authorizations`, admin)).body.length, 1);
    assert.equal((await del(t, `/api/children/${child.id}/pickup-authorizations/${future.body.id}`, admin)).status, 204);

    const audit = await get(t, '/api/admin/audit', admin);
    const actions = audit.body.items.map((a: { action: string }) => a.action);
    assert.ok(actions.includes('authorization.create'));
    assert.ok(actions.includes('authorization.revoke'));
  } finally {
    await t.close();
  }
});
