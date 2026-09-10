import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ADMIN_PASSWORD,
  GUARD_PASSWORD,
  GUARDIAN_PASSWORD,
  createAdmin,
  createGuard,
  createGuardian,
  createTestApp,
  get,
  login,
  post,
  tokenFromUrl,
} from './helpers.js';

const DAY = 86_400_000;

test('login: success, wrong password, inactive user, /auth/me and logout', async () => {
  const t = await createTestApp();
  try {
    const admin = await createAdmin(t, { email: 'dir@creche.test' });
    const guard = await createGuard(t, { login: 'carlos' });
    await createGuardian(t, { email: 'off@creche.test', active: false });

    const ok = await post(t, '/api/auth/login', { identifier: 'DIR@creche.test', password: ADMIN_PASSWORD });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.user.id, admin.id);
    assert.equal(ok.body.user.role, 'admin');
    assert.equal(ok.body.user.hasAccess, true);
    assert.match(ok.body.expiresAt, /Z$/);

    const byLogin = await post(t, '/api/auth/login', { identifier: 'carlos', password: GUARD_PASSWORD });
    assert.equal(byLogin.status, 200);
    assert.equal(byLogin.body.user.id, guard.id);
    assert.equal(byLogin.body.user.hasPin, true);

    const bad = await post(t, '/api/auth/login', { identifier: 'dir@creche.test', password: 'errada-errada' });
    assert.equal(bad.status, 401);
    assert.equal(bad.body.error.code, 'INVALID_CREDENTIALS');

    const inactive = await post(t, '/api/auth/login', { identifier: 'off@creche.test', password: GUARDIAN_PASSWORD });
    assert.equal(inactive.status, 401);
    assert.equal(inactive.body.error.code, 'INVALID_CREDENTIALS');

    const unknown = await post(t, '/api/auth/login', { identifier: 'ninguem@creche.test', password: 'qualquer-coisa' });
    assert.equal(unknown.status, 401);

    const me = await get(t, '/api/auth/me', ok.body.token);
    assert.equal(me.status, 200);
    assert.equal(me.body.user.email, 'dir@creche.test');

    const noToken = await get(t, '/api/auth/me');
    assert.equal(noToken.status, 401);
    assert.equal(noToken.body.error.code, 'UNAUTHORIZED');

    const logout = await post(t, '/api/auth/logout', undefined, ok.body.token);
    assert.equal(logout.status, 204);
    const after = await get(t, '/api/auth/me', ok.body.token);
    assert.equal(after.status, 401);

    const validation = await post(t, '/api/auth/login', { identifier: '' });
    assert.equal(validation.status, 400);
    assert.equal(validation.body.error.code, 'VALIDATION');
    assert.ok(Array.isArray(validation.body.error.details.issues));
  } finally {
    await t.close();
  }
});

test('login limits: 5 failures per identifier → 429 with retryAfterSeconds; window expires', async () => {
  const t = await createTestApp();
  try {
    await createAdmin(t, { email: 'dir@creche.test' });
    for (let i = 0; i < 5; i++) {
      const r = await post(t, '/api/auth/login', { identifier: 'dir@creche.test', password: 'errada-errada' });
      assert.equal(r.status, 401);
    }
    const limited = await post(t, '/api/auth/login', { identifier: 'dir@creche.test', password: ADMIN_PASSWORD });
    assert.equal(limited.status, 429);
    assert.equal(limited.body.error.code, 'RATE_LIMITED');
    assert.ok(limited.body.error.details.retryAfterSeconds > 0);
    assert.ok(limited.headers['retry-after']);

    // Another identifier from the same IP is still fine (IP limit is 20).
    const other = await post(t, '/api/auth/login', { identifier: 'outro@creche.test', password: 'x'.repeat(10) });
    assert.equal(other.status, 401);

    t.clock.advance(16 * 60_000);
    const again = await post(t, '/api/auth/login', { identifier: 'dir@creche.test', password: ADMIN_PASSWORD });
    assert.equal(again.status, 200);
  } finally {
    await t.close();
  }
});

test('login limits: 20 failures per IP', async () => {
  const t = await createTestApp();
  try {
    await createAdmin(t, { email: 'dir@creche.test' });
    for (let i = 0; i < 20; i++) {
      await post(t, '/api/auth/login', { identifier: `u${i}@creche.test`, password: 'errada-errada' });
    }
    const limited = await post(t, '/api/auth/login', { identifier: 'dir@creche.test', password: ADMIN_PASSWORD });
    assert.equal(limited.status, 429);
  } finally {
    await t.close();
  }
});

test('sessions: sliding renewal and absolute cap', async () => {
  const t = await createTestApp();
  try {
    await createAdmin(t, { email: 'dir@creche.test' });
    const first = await post(t, '/api/auth/login', { identifier: 'dir@creche.test', password: ADMIN_PASSWORD });
    const token = first.body.token as string;
    const expires1 = new Date(first.body.expiresAt).getTime();

    // 20 days later: less than half of the 30-day TTL remains → renewed.
    t.clock.advance(20 * DAY);
    assert.equal((await get(t, '/api/auth/me', token)).status, 200);
    const row = t.db.prepare('SELECT expires_at FROM sessions').get() as { expires_at: string };
    assert.ok(new Date(row.expires_at).getTime() > expires1);

    // Keep using it every 20 days; the 90-day absolute cap still ends it.
    for (let i = 0; i < 3; i++) {
      t.clock.advance(20 * DAY);
      assert.equal((await get(t, '/api/auth/me', token)).status, 200);
    }
    t.clock.advance(20 * DAY); // day 100
    assert.equal((await get(t, '/api/auth/me', token)).status, 401);
  } finally {
    await t.close();
  }
});

test('switch guard by PIN: new session, old one closed, INVALID_PIN and lockout after 5 failures', async () => {
  const t = await createTestApp();
  try {
    const carlos = await createGuard(t, { login: 'carlos', pin: '1234' });
    const ana = await createGuard(t, { login: 'ana', pin: '5678' });
    await createGuard(t, { login: 'sem-pin', pin: null });
    const token = await login(t, 'carlos', GUARD_PASSWORD);

    const guards = await get(t, '/api/auth/guards', token);
    assert.equal(guards.status, 200);
    assert.deepEqual(
      guards.body.map((g: { id: string }) => g.id).sort(),
      [carlos.id, ana.id].sort()
    );

    const wrong = await post(t, '/api/auth/switch', { userId: ana.id, pin: '0000' }, token);
    assert.equal(wrong.status, 401);
    assert.equal(wrong.body.error.code, 'INVALID_PIN');

    const ok = await post(t, '/api/auth/switch', { userId: ana.id, pin: '5678' }, token);
    assert.equal(ok.status, 200);
    assert.equal(ok.body.user.id, ana.id);
    assert.equal((await get(t, '/api/auth/me', token)).status, 401, 'old session is closed');
    const me = await get(t, '/api/auth/me', ok.body.token);
    assert.equal(me.body.user.id, ana.id);

    // Lockout per session.
    const token2 = ok.body.token as string;
    for (let i = 0; i < 4; i++) {
      const r = await post(t, '/api/auth/switch', { userId: carlos.id, pin: '9999' }, token2);
      assert.equal(r.status, 401);
    }
    const fifth = await post(t, '/api/auth/switch', { userId: carlos.id, pin: '9999' }, token2);
    assert.equal(fifth.status, 429);
    const evenCorrect = await post(t, '/api/auth/switch', { userId: carlos.id, pin: '1234' }, token2);
    assert.equal(evenCorrect.status, 429);

    // A guardian cannot switch.
    const g = await createGuardian(t, { email: 'g@creche.test' });
    const gt = await login(t, g.email!, GUARDIAN_PASSWORD);
    assert.equal((await post(t, '/api/auth/switch', { userId: carlos.id, pin: '1234' }, gt)).status, 403);
  } finally {
    await t.close();
  }
});

test('invite: admin creates guardian, e-mail goes out, token accepted once', async () => {
  const t = await createTestApp();
  try {
    await createAdmin(t, { email: 'dir@creche.test' });
    const admin = await login(t, 'dir@creche.test', ADMIN_PASSWORD);
    const created = await post(t, '/api/users', { name: 'Maria Silva', email: 'maria@creche.test', phone: '11 91234-5678', role: 'guardian' }, admin);
    assert.equal(created.status, 201);
    assert.equal(created.body.user.hasAccess, false);
    assert.equal(created.body.invite.kind, 'invite');
    assert.equal(created.body.invite.sent, true);
    assert.match(created.body.invite.inviteUrl, /^https:\/\/creche\.test\/convite\/[A-Za-z0-9_-]{40,}$/);
    assert.match(created.body.invite.whatsappUrl, /^https:\/\/wa\.me\/5511912345678\?text=/);
    assert.equal(t.mailer.outbox.length, 1);
    assert.equal(t.mailer.outbox[0].to, 'maria@creche.test');
    assert.match(t.mailer.outbox[0].subject, /^\[Creche Teste\]/);
    assert.ok(t.mailer.outbox[0].text.includes(created.body.invite.inviteUrl));
    assert.equal(t.mailer.outbox[0].replyTo, 'contato@creche.test');

    const token = tokenFromUrl(created.body.invite.inviteUrl);
    const info = await get(t, `/api/auth/invite/${token}`);
    assert.equal(info.status, 200);
    assert.equal(info.body.name, 'Maria Silva');
    assert.equal(info.body.role, 'guardian');

    const weak = await post(t, '/api/auth/accept-invite', { token, password: 'curta' });
    assert.equal(weak.status, 400);

    const accepted = await post(t, '/api/auth/accept-invite', { token, password: 'minha-senha-nova' });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body.user.hasAccess, true);
    assert.equal((await get(t, '/api/auth/me', accepted.body.token)).status, 200);

    const reuse = await post(t, '/api/auth/accept-invite', { token, password: 'minha-senha-nova' });
    assert.equal(reuse.status, 400);
    assert.equal(reuse.body.error.code, 'INVALID_TOKEN');

    // Password now works for login.
    assert.equal((await post(t, '/api/auth/login', { identifier: 'maria@creche.test', password: 'minha-senha-nova' })).status, 200);

    // A resend invalidates the previous token; the old one expires after 90 days.
    const resend = await post(t, `/api/users/${created.body.user.id}/invite`, {}, admin);
    assert.equal(resend.status, 200);
    assert.equal(resend.body.kind, 'reset', 'user already has a password → reset link');
    const resetToken = tokenFromUrl(resend.body.inviteUrl);
    const resend2 = await post(t, `/api/users/${created.body.user.id}/invite`, {}, admin);
    assert.equal((await get(t, `/api/auth/reset/${resetToken}`)).status, 400, 'previous reset token invalidated');
    const t2 = tokenFromUrl(resend2.body.inviteUrl);
    assert.equal((await get(t, `/api/auth/reset/${t2}`)).status, 200);
    t.clock.advance(2 * 3_600_000);
    const expired = await get(t, `/api/auth/reset/${t2}`);
    assert.equal(expired.status, 400);
    assert.equal(expired.body.error.code, 'TOKEN_EXPIRED');
  } finally {
    await t.close();
  }
});

test('forgot/reset password: always 204, e-mail with link, reset revokes all sessions and push subscriptions', async () => {
  const t = await createTestApp();
  try {
    const maria = await createGuardian(t, { email: 'maria@creche.test' });
    const s1 = await login(t, 'maria@creche.test', GUARDIAN_PASSWORD);
    const s2 = await login(t, 'maria@creche.test', GUARDIAN_PASSWORD);
    const sub = await post(
      t,
      '/api/me/push-subscriptions',
      { endpoint: 'https://push.example/abc', keys: { p256dh: 'p', auth: 'a' } },
      s1
    );
    assert.equal(sub.status, 201);

    assert.equal((await post(t, '/api/auth/forgot-password', { identifier: 'ninguem@creche.test' })).status, 204);
    assert.equal(t.mailer.outbox.length, 0);
    assert.equal((await post(t, '/api/auth/forgot-password', { identifier: 'maria@creche.test' })).status, 204);
    assert.equal(t.mailer.outbox.length, 1);
    const url = t.mailer.outbox[0].text.match(/https:\/\/creche\.test\/redefinir\/[A-Za-z0-9_-]+/)?.[0];
    assert.ok(url);
    const token = tokenFromUrl(url);
    assert.equal((await get(t, `/api/auth/reset/${token}`)).body.name, maria.name);

    const reset = await post(t, '/api/auth/reset-password', { token, password: 'outra-senha-boa' });
    assert.equal(reset.status, 200);
    assert.equal((await get(t, '/api/auth/me', s1)).status, 401);
    assert.equal((await get(t, '/api/auth/me', s2)).status, 401);
    assert.equal((await get(t, '/api/auth/me', reset.body.token)).status, 200);
    const subs = t.db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get() as { n: number };
    assert.equal(subs.n, 0);
    assert.equal((await post(t, '/api/auth/login', { identifier: 'maria@creche.test', password: 'outra-senha-boa' })).status, 200);
  } finally {
    await t.close();
  }
});

test('change password: wrong current → 401, success revokes the other sessions only', async () => {
  const t = await createTestApp();
  try {
    await createGuard(t, { login: 'carlos' });
    const s1 = await login(t, 'carlos', GUARD_PASSWORD);
    const s2 = await login(t, 'carlos', GUARD_PASSWORD);
    const wrong = await post(t, '/api/auth/change-password', { currentPassword: 'nope-nope', newPassword: 'nova-senha-boa' }, s1);
    assert.equal(wrong.status, 401);
    const ok = await post(t, '/api/auth/change-password', { currentPassword: GUARD_PASSWORD, newPassword: 'nova-senha-boa' }, s1);
    assert.equal(ok.status, 204);
    assert.equal((await get(t, '/api/auth/me', s1)).status, 200);
    assert.equal((await get(t, '/api/auth/me', s2)).status, 401);
    assert.equal((await post(t, '/api/auth/login', { identifier: 'carlos', password: 'nova-senha-boa' })).status, 200);
  } finally {
    await t.close();
  }
});

test('public routes: /config and /public/cards/:code', async () => {
  const t = await createTestApp();
  try {
    const cfg = await get(t, '/api/config');
    assert.equal(cfg.status, 200);
    assert.equal(cfg.body.daycareName, 'Creche Teste');
    assert.equal(cfg.body.timezone, 'America/Sao_Paulo');
    assert.equal(cfg.body.appUrl, 'https://creche.test');
    assert.equal(cfg.body.emailEnabled, true);
    assert.equal(cfg.body.appVersion, 'dev');
    assert.equal(cfg.body.directoryVersion, 1);
    assert.equal(cfg.body.notifyHoldSeconds, 45);
    assert.equal(cfg.body.vapidPublicKey, 'fake-public-key');

    const a = await get(t, '/api/public/cards/ABCD2345');
    const b = await get(t, '/api/public/cards/ZZZZ9999');
    assert.equal(a.status, 200);
    assert.deepEqual(a.body, b.body);
    assert.equal(a.body.daycarePhone, '(11) 4002-8922');

    const missing = await get(t, '/api/nope');
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, 'NOT_FOUND');
  } finally {
    await t.close();
  }
});
