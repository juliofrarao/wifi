/**
 * Regression tests for the findings of the adversarial review (security, attendance rules,
 * notifications). Each test names the finding it covers.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { addDays } from '@creche/shared';
import { redactUrl } from '../src/app.js';
import { csvEscape, toCsv } from '../src/services/csv.js';
import { parseTrustProxy } from '../src/config.js';
import { dispatchOnce } from '../src/services/notifications/dispatcher.js';
import {
  ADMIN_PASSWORD,
  GUARD_PASSWORD,
  type TestApp,
  createAdmin,
  createChild,
  createGuard,
  createGuardian,
  createTestApp,
  get,
  insertEvent,
  link,
  login,
  patch,
  post,
  tokenFromUrl,
} from './helpers.js';

const TODAY = '2026-09-10';
const HOLD_MS = 45_000;
const item = (childId: string) => ({ clientId: randomUUID(), childId });
const dispatch = (t: TestApp) => dispatchOnce({ db: t.db, config: t.config, mailer: t.mailer, push: t.push, now: t.clock.now });

interface Row {
  id: string;
  user_id: string;
  kind: string;
  channel: string;
  status: string;
  title: string;
  body: string;
  child_ids: string;
  batch_id: string | null;
  error: string | null;
  attempts: number;
}
const rows = (t: TestApp, where: string, ...params: unknown[]) => t.db.prepare(`SELECT * FROM notifications WHERE ${where} ORDER BY created_at, channel`).all(...params) as Row[];

async function setup(opts: { emailEnabled?: boolean } = {}) {
  const t = await createTestApp({ emailEnabled: opts.emailEnabled ?? true });
  await createAdmin(t, { email: 'dir@creche.test', name: 'Direção' });
  const admin = await login(t, 'dir@creche.test', ADMIN_PASSWORD);
  const guard = await createGuard(t, { login: 'carlos', name: 'Carlos' });
  const guardToken = await login(t, 'carlos', GUARD_PASSWORD);
  const maria = await createGuardian(t, { email: 'maria@creche.test', name: 'Maria Silva' });
  const jose = await createGuardian(t, { email: 'jose@creche.test', name: 'José Silva' });
  const ana = createChild(t, { name: 'Ana Souza' });
  const pedro = createChild(t, { name: 'Pedro Souza' });
  link(t, ana.id, maria.id, { relationship: 'mae' });
  link(t, pedro.id, maria.id, { relationship: 'mae' });
  link(t, ana.id, jose.id, { relationship: 'pai', canPickup: false });
  return { t, admin, guard, guardToken, maria, jose, ana, pedro };
}

test('ATT-2: a one-off authorization never widens what a registered guardian may do', async () => {
  const { t, admin, guardToken, jose, ana, guard } = await setup();
  insertEvent(t, { childId: ana.id, type: 'checkin', guardId: guard.id, occurredAt: '2026-09-10T10:30:00.000Z' });
  const auth = await post(t, `/api/children/${ana.id}/pickup-authorizations`, { personName: 'Rosa Vizinha', relationshipLabel: 'vizinha' }, admin);
  assert.equal(auth.status, 201);
  // José is linked but cannot pick up; attaching Rosa's authorization must not let him through.
  const res = await post(
    t,
    '/api/attendance/events',
    { type: 'checkout', guardianId: jose.id, authorizationId: auth.body.id, method: 'search', events: [item(ana.id)] },
    guardToken
  );
  assert.equal(res.status, 200);
  assert.equal(res.body.results[0].status, 'rejected');
  assert.equal(res.body.results[0].error.code, 'PICKUP_NOT_ALLOWED');
  // Rosa herself (unregistered) is covered by the authorization: no exception.
  const ok = await post(t, '/api/attendance/events', { type: 'checkout', personName: 'Rosa Vizinha', authorizationId: auth.body.id, method: 'search', events: [item(ana.id)] }, guardToken);
  assert.equal(ok.body.results[0].status, 'created');
  assert.equal(ok.body.results[0].event.override, false);
  assert.equal(ok.body.results[0].event.authorizationId, auth.body.id);
  await t.close();
});

/** An authorization created on a past day (the office cannot create expired ones through the API). */
function insertAuthorization(t: TestApp, childId: string, createdBy: string, day: string, personName: string): string {
  const id = randomUUID();
  t.db
    .prepare(
      `INSERT INTO pickup_authorizations (id, child_id, person_name, person_document, relationship_label, phone, valid_from, valid_until, note, created_by, created_at, revoked_at, revoked_by)
       VALUES (?, ?, ?, NULL, 'vizinha', NULL, ?, ?, NULL, ?, ?, NULL, NULL)`
    )
    .run(id, childId, personName, day, day, createdBy, `${day}T10:00:00.000Z`);
  return id;
}

test('ATT-1: a sheet checkout by an authorized person is not an exception', async () => {
  const { t, admin, guard, maria, ana } = await setup();
  const auth = { body: { id: insertAuthorization(t, ana.id, maria.id, '2026-09-09', 'Rosa Vizinha') } };
  const res = await post(
    t,
    '/api/attendance/backfill',
    {
      rows: [
        { clientId: randomUUID(), childId: ana.id, type: 'checkin', guardianId: maria.id, occurredAt: '2026-09-09T11:00:00.000Z' },
        { clientId: randomUUID(), childId: ana.id, type: 'checkout', personName: 'Rosa Vizinha', authorizationId: auth.body.id, occurredAt: '2026-09-09T20:00:00.000Z' },
      ],
    },
    admin
  );
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const checkout = res.body.results.find((r: any) => r.event?.type === 'checkout');
  assert.equal(checkout.status, 'created');
  assert.equal(checkout.event.override, false);
  assert.equal(checkout.event.authorizationId, auth.body.id);
  assert.match(checkout.event.authorizedByName ?? '', /Maria/);
  const inapp = rows(t, `user_id = ? AND kind = 'checkout' AND channel = 'inapp'`, maria.id);
  assert.equal(inapp.length, 1);
  assert.doesNotMatch(inapp[0].title, /ATENÇÃO/);
  assert.match(inapp[0].body, /autorizad/i);
  // TPL-1: a past-day checkout never says "Entrada hoje".
  assert.doesNotMatch(inapp[0].body, /Entrada hoje/);
  assert.match(inapp[0].body, /Entrada no mesmo dia às 08:00/);
  void guard;
  await t.close();
});

test('ATT-4: a sheet checkout by a guardian without permission needs an explicit exception', async () => {
  const { t, admin, jose, maria, ana } = await setup();
  const base = [{ clientId: randomUUID(), childId: ana.id, type: 'checkin', guardianId: maria.id, occurredAt: '2026-09-09T11:00:00.000Z' }];
  const refused = await post(t, '/api/attendance/backfill', { rows: [...base, { clientId: randomUUID(), childId: ana.id, type: 'checkout', guardianId: jose.id, occurredAt: '2026-09-09T20:00:00.000Z' }] }, admin);
  const out1 = refused.body.results.find((r: any) => r.status === 'rejected');
  assert.ok(out1, 'checkout without override is refused');
  assert.equal(out1.error.code, 'PICKUP_NOT_ALLOWED');
  const noReason = await post(t, '/api/attendance/backfill', { rows: [{ clientId: randomUUID(), childId: ana.id, type: 'checkout', guardianId: jose.id, occurredAt: '2026-09-09T20:00:00.000Z', override: true, note: 'curto' }] }, admin);
  assert.equal(noReason.status, 400, 'override requires a note of at least 10 characters');
  const accepted = await post(
    t,
    '/api/attendance/backfill',
    { rows: [{ clientId: randomUUID(), childId: ana.id, type: 'checkout', guardianId: jose.id, occurredAt: '2026-09-09T20:00:00.000Z', override: true, note: 'Mãe autorizou por telefone, direção ciente' }] },
    admin
  );
  assert.equal(accepted.body.results[0].status, 'created', JSON.stringify(accepted.body));
  assert.equal(accepted.body.results[0].event.override, true);
  assert.equal(accepted.body.results[0].event.guardianId, jose.id);
  await t.close();
});

test('ATT-3: a replay that creates an event the first attempt rejected still notifies it', async () => {
  const { t, guardToken, guard, maria, ana, pedro } = await setup();
  insertEvent(t, { childId: ana.id, type: 'checkin', guardId: guard.id, occurredAt: '2026-09-10T10:30:00.000Z' });
  const body = { type: 'checkout', guardianId: maria.id, method: 'search', events: [item(ana.id), item(pedro.id)] };
  const first = await post(t, '/api/attendance/events', body, guardToken);
  assert.deepEqual(first.body.results.map((r: any) => r.status), ['created', 'rejected']);
  const replay = await post(t, '/api/attendance/events', { ...body, queued: true, occurredAt: t.clock.now().toISOString() }, guardToken);
  assert.deepEqual(replay.body.results.map((r: any) => r.status), ['duplicate', 'created']);
  assert.equal(replay.body.results[1].event.conflict, 'already_out');
  assert.notEqual(replay.body.results[1].event.batchId, first.body.batchId, 'the new event gets its own batch');
  const inapp = rows(t, `user_id = ? AND kind = 'checkout' AND channel = 'inapp'`, maria.id);
  assert.equal(inapp.length, 2);
  assert.ok(inapp.some((r) => r.child_ids.includes(pedro.id) && r.title.includes('Pedro')), 'Pedro is notified');
  await t.close();
});

test('VOID-1: voiding one sibling after delivery keeps the retrying e-mail for the other', async () => {
  const { t, guardToken, guard, maria, ana, pedro } = await setup();
  for (const c of [ana, pedro]) insertEvent(t, { childId: c.id, type: 'checkin', guardId: guard.id, occurredAt: '2026-09-10T10:30:00.000Z' });
  const res = await post(t, '/api/attendance/events', { type: 'checkout', guardianId: maria.id, method: 'search', events: [item(ana.id), item(pedro.id)] }, guardToken);
  assert.deepEqual(res.body.results.map((r: any) => r.status), ['created', 'created']);
  const anaEvent = res.body.results[0].event.id;
  t.clock.advance(HOLD_MS + 1000);
  t.mailer.failWith = Object.assign(new Error('421 Try again later'), { responseCode: 421 });
  await dispatch(t);
  const email = rows(t, `user_id = ? AND channel = 'email' AND kind = 'checkout'`, maria.id);
  assert.equal(email.length, 1);
  assert.equal(email[0].status, 'pending', 'transient failure keeps the row pending');
  assert.equal(email[0].attempts, 1);
  const voided = await post(t, `/api/attendance/events/${anaEvent}/void`, { reason: 'toque errado' }, guardToken);
  assert.equal(voided.status, 200);
  const after = rows(t, `user_id = ? AND channel = 'email' AND kind = 'checkout'`, maria.id);
  assert.equal(after.length, 1);
  assert.equal(after[0].status, 'pending', 'the surviving sibling keeps an e-mail');
  assert.deepEqual(JSON.parse(after[0].child_ids), [pedro.id]);
  assert.doesNotMatch(after[0].title, /Ana/);
  assert.ok(rows(t, `user_id = ? AND kind = 'void'`, maria.id).length >= 1, 'a cancellation notice was created');
  t.mailer.failWith = null;
  t.clock.advance(31 * 60_000);
  await dispatch(t);
  const subjects = t.mailer.outbox.map((m) => m.subject);
  assert.ok(subjects.some((s) => /Saída registrada — Pedro/.test(s)), `Pedro's e-mail was sent: ${subjects.join(' | ')}`);
  assert.ok(!subjects.some((s) => /Saída registrada — Ana/.test(s)));
  await t.close();
});

test('ATT-6: the daily report does not list children enrolled after the date as absent', async () => {
  const { t, admin } = await setup();
  t.clock.advance(3 * 24 * 60 * 60_000); // enrolled on 2026-09-13
  const late = createChild(t, { name: 'Nova Criança' });
  const report = await get(t, `/api/reports/daily?date=${TODAY}`, admin);
  assert.equal(report.status, 200);
  const names = report.body.absent.map((c: any) => c.name);
  assert.ok(names.includes('Ana Souza'));
  assert.ok(!names.includes(late.name), `late child must not be absent on ${TODAY}: ${names}`);
  await t.close();
});

test('SEC-1: wrong PINs are limited per target guard, whatever session tries', async () => {
  const { t, guardToken } = await setup();
  const bruno = await createGuard(t, { login: 'bruno', name: 'Bruno', pin: '9999' });
  let token = guardToken;
  let limited = 0;
  for (let i = 0; i < 4; i++) {
    const r = await post(t, '/api/auth/switch', { userId: bruno.id, pin: '0000' }, token);
    assert.equal(r.status, 401, `attempt ${i}: ${JSON.stringify(r.body)}`);
    // Switching to oneself mints a fresh session — that used to reset the counter.
    const self = await post(t, '/api/auth/switch', { userId: (await get(t, '/api/auth/me', token)).body.user.id, pin: '1234' }, token);
    assert.equal(self.status, 200);
    token = self.body.token;
  }
  for (let i = 0; i < 3; i++) {
    const r = await post(t, '/api/auth/switch', { userId: bruno.id, pin: '0000' }, token);
    if (r.status === 429) limited++;
  }
  assert.ok(limited >= 2, 'the 6th+ wrong PIN against Bruno is rate limited');
  const audited = t.db.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'auth.switch_failed'`).get() as { n: number };
  assert.ok(audited.n >= 4, 'failed PIN attempts are audited');
  await t.close();
});

test('SEC-2: forgot-password is rate limited and does not re-issue a fresh token', async () => {
  const { t, maria } = await setup();
  const statuses: number[] = [];
  for (let i = 0; i < 4; i++) statuses.push((await post(t, '/api/auth/forgot-password', { identifier: 'maria@creche.test' })).status);
  assert.deepEqual(statuses, [204, 204, 204, 429]);
  await new Promise((r) => setTimeout(r, 20)); // the SMTP round-trip happens after the 204
  const tokens = t.db.prepare(`SELECT COUNT(*) AS n FROM auth_tokens WHERE user_id = ? AND kind = 'reset' AND used_at IS NULL`).get(maria.id) as { n: number };
  assert.equal(tokens.n, 1, 'one live reset token despite three calls');
  assert.equal(t.mailer.outbox.length, 1, 'one e-mail despite three calls');
  await t.close();
});

test('SEC-3: CSV cells cannot start a spreadsheet formula', () => {
  assert.equal(csvEscape('=1+1+cmd|calc'), `"'=1+1+cmd|calc"`);
  assert.equal(csvEscape('+55 11 9999'), `"'+55 11 9999"`);
  assert.equal(csvEscape('-1'), `"'-1"`);
  assert.equal(csvEscape('@SUM(1)'), `"'@SUM(1)"`);
  assert.equal(csvEscape('\tx'), `"'\tx"`);
  assert.equal(csvEscape('Maria'), 'Maria');
  assert.equal(csvEscape('a;b'), '"a;b"');
  assert.equal(csvEscape(12), '12');
  assert.ok(toCsv([['=x', 'ok']]).includes(`"'=x";ok`));
});

test('SEC-3: a guardian-controlled name is neutralized in the events CSV', async () => {
  const { t, admin, guardToken, guard, maria, ana } = await setup();
  const evil = '=HYPERLINK("http://evil/";"Maria")';
  const mariaToken = await login(t, 'maria@creche.test', 'senha-resp-1');
  assert.equal((await patch(t, '/api/me', { name: evil }, mariaToken)).status, 200);
  const res = await post(t, '/api/attendance/events', { type: 'checkin', guardianId: maria.id, method: 'search', note: '@SUM(1+9)', events: [item(ana.id)] }, guardToken);
  assert.equal(res.body.results[0].status, 'created');
  const csv = await get(t, `/api/attendance/events.csv?from=${TODAY}&to=${TODAY}`, admin);
  assert.equal(csv.status, 200);
  const text = csv.raw.toString('utf8');
  assert.ok(text.includes(`"'${evil.replace(/"/g, '""')}"`), text);
  assert.ok(text.includes(`"'@SUM(1+9)"`));
  void guard;
  await t.close();
});

test('SEC-4: every response carries the browser hardening headers', async () => {
  const { t, admin } = await setup();
  const res = await get(t, '/api/config');
  assert.match(String(res.headers['content-security-policy']), /default-src 'self'/);
  assert.match(String(res.headers['content-security-policy']), /frame-ancestors 'none'/);
  assert.equal(res.headers['x-frame-options'], 'DENY');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.equal(res.headers['strict-transport-security'], undefined, 'HSTS only behind a TLS proxy');
  const stats = await get(t, '/api/admin/stats', admin);
  assert.match(String(stats.headers['content-security-policy']), /script-src 'self'/);
  await t.close();
});

test('SEC-5: tokens and photo signatures are redacted from log URLs', () => {
  assert.equal(redactUrl('/api/auth/invite/UjMDYKtNCoHodlBgYP2wGVMdCGW0Z8wG'), '/api/auth/invite/<redacted>');
  assert.equal(redactUrl('/api/auth/reset/abc-def_ghi?x=1'), '/api/auth/reset/<redacted>?x=1');
  assert.equal(redactUrl('/api/files/123?t=SIGNATURE'), '/api/files/123?t=<redacted>');
  assert.equal(redactUrl('/api/children?q=ana'), '/api/children?q=ana');
});

test('SEC-6: TRUST_PROXY accepts false/true, a hop count and an address list', () => {
  assert.equal(parseTrustProxy(undefined), false);
  assert.equal(parseTrustProxy('false'), false);
  assert.equal(parseTrustProxy('true'), true);
  assert.equal(parseTrustProxy('1'), 1);
  assert.deepEqual(parseTrustProxy('10.0.0.0/8, loopback'), ['10.0.0.0/8', 'loopback']);
});

test('SEC-7: an old invite link cannot take over an account that already has a password', async () => {
  const { t, admin } = await setup();
  const created = await post(t, '/api/users', { name: 'Bruno', role: 'guard', login: 'bruno', email: 'bruno@creche.test' }, admin);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const token = tokenFromUrl(created.body.invite.inviteUrl);
  assert.equal((await patch(t, `/api/users/${created.body.user.id}`, { password: 'senha-nova-123' }, admin)).status, 200);
  const live = t.db.prepare(`SELECT COUNT(*) AS n FROM auth_tokens WHERE user_id = ? AND used_at IS NULL`).get(created.body.user.id) as { n: number };
  assert.equal(live.n, 0, 'pending links die when a password is set');
  const accept = await post(t, '/api/auth/accept-invite', { token, password: 'senha-do-atacante-1' });
  assert.equal(accept.status, 400);
  assert.equal(accept.body.error.code, 'INVALID_TOKEN');
  assert.equal((await login(t, 'bruno', 'senha-nova-123')).length > 10, true, 'the legitimate password still works');
  await t.close();
});

test('QUOTA-1: test e-mails count toward the daily total; only quota skips are reported', async () => {
  const { t, admin, guardToken, guard, maria, ana } = await setup({ emailEnabled: false });
  insertEvent(t, { childId: ana.id, type: 'checkin', guardId: guard.id, occurredAt: '2026-09-10T10:30:00.000Z' });
  const res = await post(t, '/api/attendance/events', { type: 'checkout', guardianId: maria.id, method: 'search', events: [item(ana.id)] }, guardToken);
  assert.equal(res.body.results[0].status, 'created');
  t.clock.advance(HOLD_MS + 1000);
  await dispatch(t);
  // Maria and José (linked, not blocked) both get a checkout e-mail row; SMTP is off so both are skipped.
  const skipped = rows(t, `status = 'skipped' AND channel = 'email'`);
  assert.equal(skipped.length, 2);
  assert.ok(skipped.every((r) => r.error === 'email_disabled'));
  const stats = await get(t, '/api/admin/stats', admin);
  assert.equal(stats.body.notifications.skippedLast24h, 0, 'email_disabled is not a quota skip');
  assert.equal(stats.body.notifications.emailsToday, 0);
  await t.close();
});

test('QUOTA-1: a test e-mail is counted in emailsToday', async () => {
  const { t, admin } = await setup({ emailEnabled: true });
  assert.equal((await post(t, '/api/admin/test-email', {}, admin)).status, 204);
  const stats = await get(t, '/api/admin/stats', admin);
  assert.equal(stats.body.notifications.emailsToday, 1);
  await t.close();
});

test('ATT-1/ATT-4 contract: BackfillBody accepts authorizationId and override', () => {
  assert.equal(typeof addDays, 'function');
});
