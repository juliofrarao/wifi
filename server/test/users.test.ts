import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ADMIN_PASSWORD,
  GUARDIAN_PASSWORD,
  createAdmin,
  createChild,
  createGuard,
  createGuardian,
  createTestApp,
  del,
  get,
  link,
  login,
  patch,
  post,
} from './helpers.js';

test('POST /users: guardian without e-mail gets an invite link (not sent), phone → WhatsApp link', async () => {
  const t = await createTestApp();
  try {
    await createAdmin(t, { email: 'dir@creche.test' });
    const admin = await login(t, 'dir@creche.test', ADMIN_PASSWORD);

    const noContact = await post(t, '/api/users', { name: 'João Sem Contato', role: 'guardian' }, admin);
    assert.equal(noContact.status, 201);
    assert.equal(noContact.body.user.email, null);
    assert.equal(noContact.body.user.hasAccess, false);
    assert.equal(noContact.body.invite.sent, false);
    assert.equal(noContact.body.invite.whatsappUrl, null);
    assert.match(noContact.body.invite.inviteUrl, /\/convite\//);
    assert.equal(t.mailer.outbox.length, 0);

    const withPhone = await post(t, '/api/users', { name: 'Ana Zap', role: 'guardian', phone: '(21) 98765-4321' }, admin);
    assert.equal(withPhone.status, 201);
    assert.match(withPhone.body.invite.whatsappUrl, /^https:\/\/wa\.me\/5521987654321\?text=/);
    assert.ok(decodeURIComponent(withPhone.body.invite.whatsappUrl).includes('Creche Teste'));

    // sendInvite:false keeps the e-mail in the pocket.
    const quiet = await post(t, '/api/users', { name: 'Quieta', role: 'guardian', email: 'quieta@creche.test', sendInvite: false }, admin);
    assert.equal(quiet.status, 201);
    assert.equal(quiet.body.invite.sent, false);
    assert.equal(t.mailer.outbox.length, 0);

    // Guardians never accept a password.
    const withPassword = await post(t, '/api/users', { name: 'Errado', role: 'guardian', email: 'x@creche.test', password: 'senha-senha-1' }, admin);
    assert.equal(withPassword.status, 400);
    assert.equal(withPassword.body.error.code, 'VALIDATION');

    // Guards need e-mail or login; a password/pin can be set directly; no invite then.
    const guard = await post(t, '/api/users', { name: 'Carlos', role: 'guard', login: 'Carlos', password: 'senha-guard-1', pin: '4321' }, admin);
    assert.equal(guard.status, 201);
    assert.equal(guard.body.user.login, 'carlos');
    assert.equal(guard.body.user.hasAccess, true);
    assert.equal(guard.body.user.hasPin, true);
    assert.equal(guard.body.invite, null);

    // Admin passwords must have 12+ chars.
    const weakAdmin = await post(t, '/api/users', { name: 'Adm', role: 'admin', email: 'adm2@creche.test', password: 'so-onze-ch1' }, admin);
    assert.equal(weakAdmin.status, 400);
    assert.equal(weakAdmin.body.error.code, 'WEAK_PASSWORD');

    // Unique e-mail / login.
    const dup = await post(t, '/api/users', { name: 'Dup', role: 'guardian', email: 'QUIETA@creche.test' }, admin);
    assert.equal(dup.status, 409);
    assert.equal(dup.body.error.code, 'EMAIL_IN_USE');
    const dupLogin = await post(t, '/api/users', { name: 'Dup', role: 'guard', login: 'carlos' }, admin);
    assert.equal(dupLogin.status, 409);
    assert.equal(dupLogin.body.error.code, 'LOGIN_IN_USE');

    // Non-admins are forbidden.
    const guardToken = await login(t, 'carlos', 'senha-guard-1');
    assert.equal((await get(t, '/api/users', guardToken)).status, 403);

    const list = await get(t, '/api/users?role=guardian&q=quieta', admin);
    assert.equal(list.status, 200);
    assert.equal(list.body.length, 1);
    assert.equal(list.body[0].email, 'quieta@creche.test');
  } finally {
    await t.close();
  }
});

test('GET /users/:id detail, PATCH (e-mail change, deactivate revokes sessions, password rules)', async () => {
  const t = await createTestApp();
  try {
    await createAdmin(t, { email: 'dir@creche.test' });
    const admin = await login(t, 'dir@creche.test', ADMIN_PASSWORD);
    const maria = await createGuardian(t, { email: 'maria@creche.test', name: 'Maria' });
    const child = createChild(t, { name: 'Ana' });
    link(t, child.id, maria.id, { relationship: 'mae', isPrimary: true });
    const mariaToken = await login(t, 'maria@creche.test', GUARDIAN_PASSWORD);

    const detail = await get(t, `/api/users/${maria.id}`, admin);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.children.length, 1);
    assert.equal(detail.body.children[0].name, 'Ana');
    assert.equal(detail.body.children[0].relationship, 'mae');
    assert.equal(detail.body.sessions, 1);
    assert.deepEqual(detail.body.preferences, { notifyCheckinPush: true, notifyCheckinEmail: false });
    assert.equal(detail.body.pushSubscriptions, 0);

    const other = await createGuardian(t, { email: 'outra@creche.test' });
    const clash = await patch(t, `/api/users/${maria.id}`, { email: other.email }, admin);
    assert.equal(clash.status, 409);

    const pw = await patch(t, `/api/users/${maria.id}`, { password: 'nova-senha-boa' }, admin);
    assert.equal(pw.status, 400, 'admin cannot set a guardian password');

    const renamed = await patch(t, `/api/users/${maria.id}`, { name: 'Maria Silva', email: 'maria2@creche.test', phone: '11 90000-0000' }, admin);
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.name, 'Maria Silva');
    assert.equal(renamed.body.email, 'maria2@creche.test');

    const off = await patch(t, `/api/users/${maria.id}`, { active: false }, admin);
    assert.equal(off.status, 200);
    assert.equal(off.body.active, false);
    assert.equal((await get(t, '/api/auth/me', mariaToken)).status, 401);
    assert.equal((await post(t, '/api/auth/login', { identifier: 'maria2@creche.test', password: GUARDIAN_PASSWORD })).status, 401);

    // Guard: admin may set password + pin; password change revokes sessions.
    const guard = await createGuard(t, { login: 'carlos' });
    const gt = await login(t, 'carlos', 'senha-guard-1');
    assert.equal((await patch(t, `/api/users/${guard.id}`, { password: 'outra-senha-1' }, admin)).status, 200);
    assert.equal((await get(t, '/api/auth/me', gt)).status, 401);
    assert.equal((await post(t, `/api/users/${guard.id}/pin`, { pin: '9999' }, admin)).status, 204);
    assert.equal((await post(t, `/api/users/${maria.id}/pin`, { pin: '9999' }, admin)).status, 400);

    // Self-deactivation is refused.
    const me = await get(t, '/api/auth/me', admin);
    assert.equal((await patch(t, `/api/users/${me.body.user.id}`, { active: false }, admin)).status, 409);

    const audit = await get(t, '/api/admin/audit?limit=100', admin);
    assert.ok(audit.body.items.some((a: { action: string }) => a.action === 'user.update'));
  } finally {
    await t.close();
  }
});

test('anonymize user: only inactive; name/contacts replaced, credentials revoked, sessions deleted', async () => {
  const t = await createTestApp();
  try {
    await createAdmin(t, { email: 'dir@creche.test' });
    const admin = await login(t, 'dir@creche.test', ADMIN_PASSWORD);
    const maria = await createGuardian(t, { email: 'maria@creche.test', phone: '11999999999', name: 'Maria' });
    const child = createChild(t);
    link(t, child.id, maria.id);
    const cred = await post(t, '/api/credentials', { ownerType: 'guardian', ownerId: maria.id }, admin);
    assert.equal(cred.status, 201);
    await login(t, 'maria@creche.test', GUARDIAN_PASSWORD);

    const stillActive = await post(t, `/api/users/${maria.id}/anonymize`, { reason: 'saiu da creche' }, admin);
    assert.equal(stillActive.status, 409);
    assert.equal(stillActive.body.error.code, 'INVALID_STATE');

    assert.equal((await patch(t, `/api/users/${maria.id}`, { active: false }, admin)).status, 200);
    const done = await post(t, `/api/users/${maria.id}/anonymize`, { reason: 'saiu da creche' }, admin);
    assert.equal(done.status, 204);

    const row = await get(t, `/api/users/${maria.id}`, admin);
    assert.equal(row.body.name, `Responsável removido #${maria.id.replace(/-/g, '').slice(-4).toUpperCase()}`);
    assert.equal(row.body.email, null);
    assert.equal(row.body.phone, null);
    assert.equal(row.body.hasAccess, false);
    assert.ok(row.body.anonymizedAt);
    assert.equal(row.body.credentials.length, 1);
    assert.equal(row.body.credentials[0].active, false);
    assert.equal(row.body.sessions, 0);
    assert.equal(row.body.children.length, 0, 'live links are removed');

    // Idempotent + not listed among active users.
    assert.equal((await post(t, `/api/users/${maria.id}/anonymize`, { reason: 'de novo' }, admin)).status, 204);
    const list = await get(t, '/api/users?role=guardian', admin);
    assert.equal(list.body.length, 0);

    // Deleting a link of an anonymized user is a 404 (already removed).
    assert.equal((await del(t, `/api/children/${child.id}/guardians/${maria.id}`, admin)).status, 404);
  } finally {
    await t.close();
  }
});

test('PATCH /me and /me/preferences', async () => {
  const t = await createTestApp();
  try {
    const maria = await createGuardian(t, { email: 'maria@creche.test' });
    const token = await login(t, maria.email!, GUARDIAN_PASSWORD);
    const me = await patch(t, '/api/me', { name: 'Maria Souza', phone: '11 98888-7777' }, token);
    assert.equal(me.status, 200);
    assert.equal(me.body.name, 'Maria Souza');
    assert.equal(me.body.phone, '11 98888-7777');

    const prefs = await patch(t, '/api/me/preferences', { notifyCheckinEmail: true }, token);
    assert.deepEqual(prefs.body, { notifyCheckinPush: true, notifyCheckinEmail: true });
    assert.deepEqual((await get(t, '/api/me/preferences', token)).body, { notifyCheckinPush: true, notifyCheckinEmail: true });

    const guard = await createGuard(t, { login: 'carlos' });
    const gt = await login(t, guard.login!, 'senha-guard-1');
    assert.equal((await get(t, '/api/me/preferences', gt)).status, 403);
  } finally {
    await t.close();
  }
});
