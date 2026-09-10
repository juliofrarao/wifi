import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { dispatchOnce } from '../src/services/notifications/dispatcher.js';
import { renderAttendance, renderCredentialRevoked, renderGuardianAdded } from '../src/services/notifications/templates.js';
import type { EventRow } from '../src/db/rows.js';
import {
  ADMIN_PASSWORD,
  GUARD_PASSWORD,
  GUARDIAN_PASSWORD,
  type TestApp,
  createAdmin,
  createChild,
  createCredential,
  createGuard,
  createGuardian,
  createTestApp,
  del,
  get,
  insertEvent,
  link,
  login,
  post,
  put,
} from './helpers.js';

interface Row {
  id: string;
  user_id: string;
  kind: string;
  channel: string;
  status: string;
  title: string;
  body: string;
  payload_json: string | null;
  error: string | null;
  attempts: number;
  dispatch_after: string;
  sent_at: string | null;
}
const rows = (t: TestApp, where = '1=1', ...params: unknown[]) => t.db.prepare(`SELECT * FROM notifications WHERE ${where} ORDER BY created_at, channel, id`).all(...params) as Row[];
const dispatch = (t: TestApp) => dispatchOnce({ db: t.db, config: t.config, mailer: t.mailer, push: t.push, now: t.clock.now });
const subscribe = (t: TestApp, userId: string, endpoint: string) =>
  t.db.prepare('INSERT INTO push_subscriptions (id, user_id, session_id, endpoint, p256dh, auth, user_agent, created_at) VALUES (?, ?, NULL, ?, ?, ?, NULL, ?)').run(randomUUID(), userId, endpoint, 'p', 'a', t.clock.now().toISOString());

const checkout = async (t: TestApp, token: string, guardianId: string, childIds: string[], extra: Record<string, unknown> = {}) => {
  const res = await post(t, '/api/attendance/events', { type: 'checkout', guardianId, method: 'search', events: childIds.map((childId) => ({ clientId: randomUUID(), childId })), ...extra }, token);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body as { batchId: string; undoUntil: string | null; results: { status: string; event?: { id: string } }[] };
};

async function setup(env: Record<string, string> = {}) {
  const t = await createTestApp({ env });
  await createAdmin(t, { email: 'dir@creche.test', name: 'Direção' });
  const admin = await login(t, 'dir@creche.test', ADMIN_PASSWORD);
  const guard = await createGuard(t, { login: 'carlos', name: 'Carlos' });
  const gt = await login(t, 'carlos', GUARD_PASSWORD);
  const maria = await createGuardian(t, { email: 'maria@creche.test', name: 'Maria' });
  const ana = createChild(t, { name: 'Ana' });
  link(t, ana.id, maria.id, { relationship: 'mae' });
  return { t, admin, guard, gt, maria, ana };
}

test('dispatcher: hold window, push with gone subscription deleted, e-mail retry/backoff then failed, permanent failure', async () => {
  const { t, guard, gt, maria, ana } = await setup();
  try {
    subscribe(t, maria.id, 'https://push.test/ok');
    subscribe(t, maria.id, 'https://push.test/gone');
    t.push.goneEndpoints.add('https://push.test/gone');
    insertEvent(t, { childId: ana.id, type: 'checkin', guardId: guard.id, guardianId: maria.id, occurredAt: '2026-09-10T10:45:00.000Z' });
    const batch = await checkout(t, gt, maria.id, [ana.id]);
    assert.deepEqual(rows(t, 'batch_id = ?', batch.batchId).map((r) => r.channel), ['email', 'inapp', 'push']);

    assert.equal((await dispatch(t)).processed, 0, 'held');
    t.clock.set(batch.undoUntil!);
    const s = await dispatch(t);
    assert.equal(s.sent, 3);
    const after = rows(t, 'batch_id = ?', batch.batchId);
    assert.ok(after.every((r) => r.status === 'sent' && r.sent_at === batch.undoUntil));
    assert.equal(t.push.sent.length, 1);
    const payload = t.push.sent[0].payload;
    assert.equal(payload.tag, `batch:${batch.batchId}`);
    assert.equal(payload.kind, 'checkout');
    assert.equal(payload.override, false);
    const inapp = after.find((r) => r.channel === 'inapp')!;
    assert.equal(payload.url, `/alertas?n=${inapp.id}`);
    assert.equal(payload.notificationId, inapp.id);
    assert.equal(payload.body, 'Ana saiu às 09:00 com Maria (mãe)');
    assert.equal((t.db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get() as { n: number }).n, 1, 'gone subscription deleted');
    assert.equal(t.mailer.outbox.length, 1);
    assert.equal(t.mailer.outbox[0].to, 'maria@creche.test');

    // Transient SMTP failure: 60 s, then 300 s, then failed (3 attempts).
    t.mailer.failWith = Object.assign(new Error('421 try later'), { responseCode: 421 });
    t.clock.advance(60_000);
    insertEvent(t, { childId: ana.id, type: 'checkin', guardId: guard.id, guardianId: maria.id, occurredAt: t.clock.now().toISOString() });
    t.clock.advance(120_000);
    const b2 = await checkout(t, gt, maria.id, [ana.id]);
    t.clock.set(b2.undoUntil!);
    let r = await dispatch(t);
    assert.equal(r.retried, 1);
    let email = rows(t, 'batch_id = ? AND channel = ?', b2.batchId, 'email')[0];
    assert.equal(email.status, 'pending');
    assert.equal(email.attempts, 1);
    assert.equal(email.dispatch_after, new Date(t.clock.now().getTime() + 60_000).toISOString());
    t.clock.advance(30_000);
    assert.equal((await dispatch(t)).processed, 0, 'not due yet');
    t.clock.advance(31_000);
    r = await dispatch(t);
    assert.equal(r.retried, 1);
    email = rows(t, 'id = ?', email.id)[0];
    assert.equal(email.attempts, 2);
    assert.equal(email.dispatch_after, new Date(t.clock.now().getTime() + 300_000).toISOString());
    t.clock.advance(301_000);
    r = await dispatch(t);
    assert.equal(r.failed, 1);
    email = rows(t, 'id = ?', email.id)[0];
    assert.equal(email.status, 'failed');
    assert.equal(email.attempts, 3);
    assert.match(email.error!, /421/);
    assert.equal((t.db.prepare('SELECT last_email_error FROM users WHERE id = ?').get(maria.id) as { last_email_error: string }).last_email_error, '421 try later');
    assert.equal((await dispatch(t)).processed, 0, 'failed rows are not retried');

    // Permanent failure → failed immediately.
    t.mailer.failWith = Object.assign(new Error('550 no such user'), { responseCode: 550 });
    t.clock.advance(60_000);
    insertEvent(t, { childId: ana.id, type: 'checkin', guardId: guard.id, guardianId: maria.id, occurredAt: t.clock.now().toISOString() });
    t.clock.advance(120_000);
    const b3 = await checkout(t, gt, maria.id, [ana.id]);
    t.clock.set(b3.undoUntil!);
    r = await dispatch(t);
    assert.equal(r.failed, 1);
    assert.equal(rows(t, 'batch_id = ? AND channel = ?', b3.batchId, 'email')[0].status, 'failed');
    // Success clears the error.
    t.mailer.failWith = null;
    t.clock.advance(60_000);
    insertEvent(t, { childId: ana.id, type: 'checkin', guardId: guard.id, guardianId: maria.id, occurredAt: t.clock.now().toISOString() });
    t.clock.advance(120_000);
    const b4 = await checkout(t, gt, maria.id, [ana.id]);
    t.clock.set(b4.undoUntil!);
    await dispatch(t);
    assert.equal((t.db.prepare('SELECT last_email_error FROM users WHERE id = ?').get(maria.id) as { last_email_error: string | null }).last_email_error, null);

    // Admin stats reflect the dispatcher's bookkeeping.
    const stats = await get(t, '/api/admin/stats', await login(t, 'dir@creche.test', ADMIN_PASSWORD));
    assert.equal(stats.body.notifications.failedLast24h, 2);
    assert.equal(stats.body.notifications.emailsToday, 2);
    assert.equal(stats.body.notifications.skippedLast24h, 0);
  } finally {
    await t.close();
  }
});

test('dispatcher: daily e-mail quota skips routine e-mails, keeps exceptions and warns admins once', async () => {
  const { t, admin, guard, gt, maria, ana } = await setup({ SMTP_DAILY_LIMIT: '1' });
  try {
    const pedro = createChild(t, { name: 'Pedro' });
    link(t, pedro.id, maria.id, { relationship: 'mae' });
    insertEvent(t, { childId: ana.id, type: 'checkin', guardId: guard.id, guardianId: maria.id, occurredAt: '2026-09-10T10:45:00.000Z' });
    insertEvent(t, { childId: pedro.id, type: 'checkin', guardId: guard.id, guardianId: maria.id, occurredAt: '2026-09-10T10:45:00.000Z' });
    const b1 = await checkout(t, gt, maria.id, [ana.id]);
    t.clock.set(b1.undoUntil!);
    await dispatch(t);
    assert.equal(t.mailer.outbox.length, 1);

    t.clock.advance(120_000);
    const b2 = await checkout(t, gt, maria.id, [pedro.id]);
    t.clock.set(b2.undoUntil!);
    const s = await dispatch(t);
    assert.equal(s.skipped, 1);
    const skipped = rows(t, 'batch_id = ? AND channel = ?', b2.batchId, 'email')[0];
    assert.equal(skipped.status, 'skipped');
    assert.equal(skipped.error, 'quota');
    assert.equal(t.mailer.outbox.length, 1);
    const alerts = rows(t, "kind = 'system'");
    assert.equal(alerts.length, 1, 'one admin, inapp only (no e-mail about the e-mail quota)');
    assert.equal(alerts[0].channel, 'inapp');
    assert.match(alerts[0].title, /Limite diário de e-mails/);

    // Exception e-mails still go out; the warning is not repeated today.
    t.clock.advance(60_000);
    insertEvent(t, { childId: ana.id, type: 'checkin', guardId: guard.id, guardianId: maria.id, occurredAt: t.clock.now().toISOString() });
    t.clock.advance(120_000);
    const b3 = await checkout(t, gt, maria.id, [ana.id], { guardianId: null, personName: 'Tereza Nunes', override: true, note: 'mãe ligou autorizando' });
    t.clock.set(b3.undoUntil!);
    await dispatch(t);
    const b3Rows = rows(t, 'batch_id = ? AND channel = ?', b3.batchId, 'email');
    assert.ok(b3Rows.length >= 2, 'guardian + admin');
    assert.ok(b3Rows.every((r) => r.status === 'sent'));
    assert.equal(t.mailer.outbox.length, 3);
    assert.equal(rows(t, "kind = 'system'").length, 1);
    const stats = await get(t, '/api/admin/stats', admin);
    assert.equal(stats.body.notifications.skippedLast24h, 1);
    assert.equal(stats.body.notifications.emailDailyLimit, 1);
    // Next day the warning may be sent again.
    t.clock.set('2026-09-11T12:00:00.000Z');
    t.clock.advance(60_000);
    insertEvent(t, { childId: ana.id, type: 'checkin', guardId: guard.id, guardianId: maria.id, occurredAt: t.clock.now().toISOString() });
    t.clock.advance(120_000);
    const b4 = await checkout(t, gt, maria.id, [ana.id]);
    t.clock.set(b4.undoUntil!);
    await dispatch(t);
    assert.equal(t.mailer.outbox.length, 4, 'new day, quota reset');
  } finally {
    await t.close();
  }
});

test('feed: /me/notifications shows only dispatched inapp rows, unread count, read marks, events attached; R16 kinds', async () => {
  const { t, admin, guard, gt, maria, ana } = await setup();
  try {
    const mt = await login(t, 'maria@creche.test', GUARDIAN_PASSWORD);
    const tia = await createGuardian(t, { email: 'tia@creche.test', name: 'Ana Tia' });
    assert.deepEqual((await get(t, '/api/me/notifications', mt)).body, { items: [], unreadCount: 0, nextBefore: null });

    // R16: new person allowed → Maria (the other guardian) gets it immediately (no hold).
    await put(t, `/api/children/${ana.id}/guardians/${tia.id}`, { relationship: 'tia', canPickup: true, validUntil: '2026-09-15' }, admin);
    let r16 = rows(t, "kind = 'guardian_added'");
    assert.deepEqual(r16.map((r) => [r.user_id === maria.id ? 'maria' : 'other', r.channel]).sort(), [
      ['maria', 'email'],
      ['maria', 'inapp'],
    ]);
    assert.equal(r16[0].body, 'Nova pessoa autorizada a retirar Ana: Ana Tia (tia), até 15/09. Se você não reconhece esta pessoa, fale com a creche.');
    assert.equal(r16[0].dispatch_after, t.clock.now().toISOString());
    // Authorization by Maria notifies the aunt, not Maria.
    t.clock.advance(1000);
    const auth = await post(t, `/api/children/${ana.id}/pickup-authorizations`, { personName: 'Rosa Souza', personDocument: '999.888.777-66', relationshipLabel: 'vizinha' }, mt);
    assert.equal(auth.status, 201);
    const authRows = rows(t, "kind = 'authorization_added'");
    assert.ok(authRows.length >= 1);
    assert.ok(authRows.every((r) => r.user_id === tia.id));
    assert.equal(authRows[0].body, 'Maria (mãe) autorizou Rosa Souza (vizinha) a retirar Ana hoje.');
    assert.doesNotMatch(authRows.map((r) => r.body + r.title + (r.payload_json ?? '')).join(), /999\.888/);
    // Card revoked → owner.
    t.clock.advance(1000);
    const card = createCredential(t, 'guardian', maria.id);
    await del(t, `/api/credentials/${card.id}`, admin);
    const revokedRows = rows(t, "kind = 'credential_revoked'");
    assert.ok(revokedRows.length >= 1);
    assert.match(revokedRows[0].body, new RegExp(`A carteirinha ${card.code!.slice(0, 4)}-${card.code!.slice(4)} foi cancelada pela creche`));
    r16 = rows(t, "kind = 'guardian_added'");

    // Nothing shows before dispatch; after it, newest first.
    assert.equal((await get(t, '/api/me/notifications', mt)).body.items.length, 0);
    await dispatch(t);
    insertEvent(t, { childId: ana.id, type: 'checkin', guardId: guard.id, guardianId: maria.id, occurredAt: '2026-09-10T10:45:00.000Z' });
    t.clock.advance(60_000);
    const batch = await checkout(t, gt, maria.id, [ana.id]);
    t.clock.set(batch.undoUntil!);
    await dispatch(t);
    const page = await get(t, '/api/me/notifications?limit=2', mt);
    assert.equal(page.status, 200);
    assert.equal(page.body.items.length, 2);
    assert.equal(page.body.unreadCount, 3);
    assert.ok(page.body.nextBefore);
    const first = page.body.items[0];
    assert.equal(first.kind, 'checkout');
    assert.equal(first.batchId, batch.batchId);
    assert.equal(first.events.length, 1);
    assert.equal(first.events[0].id, batch.results[0].event!.id);
    assert.equal(first.events[0].personDocument, null);
    assert.deepEqual(first.childIds, [ana.id]);
    assert.equal(first.readAt, null);
    assert.equal(first.override, false);
    const page2 = await get(t, `/api/me/notifications?limit=2&before=${encodeURIComponent(page.body.nextBefore)}`, mt);
    assert.equal(page2.body.items.length, 1);
    assert.equal(page2.body.items[0].kind, 'guardian_added');
    assert.equal(page2.body.nextBefore, null);

    const readOne = await post(t, '/api/me/notifications/read', { ids: [first.id] }, mt);
    assert.deepEqual(readOne.body, { unreadCount: 2 });
    assert.ok((await get(t, '/api/me/notifications', mt)).body.items[0].readAt);
    const readAll = await post(t, '/api/me/notifications/read', {}, mt);
    assert.deepEqual(readAll.body, { unreadCount: 0 });
    assert.equal((await get(t, '/api/me/notifications', gt)).status, 403);
    assert.equal((await get(t, '/api/me/notifications', admin)).status, 200);
  } finally {
    await t.close();
  }
});

test('templates: texts per spec §6, push body ≤ 3 names, never a document number', () => {
  const daycare = { name: 'Creche Teste', phone: '(11) 4002-8922', tz: 'America/Sao_Paulo' };
  const base = (over: Partial<EventRow>): EventRow => ({
    id: randomUUID(),
    client_id: null,
    batch_id: 'b',
    child_id: randomUUID(),
    child_name: 'João',
    type: 'checkout',
    guardian_id: 'g',
    guardian_name: 'Maria Silva',
    guardian_relationship: 'mae',
    person_name: null,
    person_document: null,
    document_checked: 0,
    authorization_id: null,
    authorized_by_name: null,
    guard_id: 'x',
    guard_name: 'Carlos',
    method: 'nfc',
    credential_id: null,
    override: 0,
    conflict: null,
    queued: 0,
    directory_at: null,
    note: null,
    occurred_at: '2026-09-10T20:32:00.000Z',
    created_at: '2026-09-10T20:32:00.000Z',
    voided_at: null,
    voided_by: null,
    void_reason: null,
    ...over,
  });
  const input = (events: EventRow[], extra: Partial<Parameters<typeof renderAttendance>[0]> = {}) => ({
    events,
    daycare,
    authorizationLabels: new Map<string, string>(),
    checkinAt: new Map<string, string>(),
    blockedEventIds: new Set<string>(),
    backfilledAt: null,
    ...extra,
  });

  const kids = ['Ana', 'Pedro', 'João', 'Lia', 'Bia'].map((child_name) => base({ child_name, child_id: randomUUID() }));
  const five = renderAttendance(input(kids));
  assert.equal(five.title, 'Saída registrada — Ana, Pedro, João +2');
  assert.match(five.body, /^Ana, Pedro, João, Lia e Bia saíram da creche às 17:32 \(10\/09\/2026\) com Maria Silva \(mãe\)\. Registrado por Carlos \(portaria\)\.$/);
  assert.equal(five.pushBody, 'Ana, Pedro, João +2 saíram às 17:32 com Maria Silva (mãe)');
  assert.equal(five.subject, '[Creche Teste] Saída registrada — Ana, Pedro, João +2');
  assert.match(five.html, /<html lang="pt-BR">/);

  const authEvent = base({ guardian_id: null, guardian_name: null, guardian_relationship: null, person_name: 'Ana Souza', person_document: '123.456.789-00', authorization_id: 'a1', authorized_by_name: 'Maria Silva (mãe)' });
  const withAuth = renderAttendance(input([authEvent], { authorizationLabels: new Map([['a1', 'vizinha']]), checkinAt: new Map([[authEvent.child_id, '2026-09-10T10:45:00.000Z']]) }));
  assert.equal(withAuth.body, 'João saiu da creche às 17:32 (10/09/2026) com Ana Souza (vizinha), autorizada por Maria Silva (mãe). Entrada hoje às 07:45. Registrado por Carlos (portaria).');
  assert.doesNotMatch(withAuth.body + withAuth.html + withAuth.pushBody + withAuth.title, /123\.456/);

  const override = renderAttendance(input([base({ guardian_id: null, guardian_name: null, guardian_relationship: null, person_name: 'Ana Souza', person_document: '123.456.789-00', document_checked: 1, override: 1, note: 'mãe ligou autorizando', method: 'search' })]));
  assert.equal(override.title, 'ATENÇÃO — retirada fora da lista de autorizados');
  assert.equal(override.body, "João saiu às 17:32 (10/09/2026) com Ana Souza (não cadastrada), documento conferido pela portaria. Motivo: 'mãe ligou autorizando'. Registrado por Carlos (portaria). Se você não reconhece esta retirada, ligue agora para a creche: (11) 4002-8922.");
  assert.equal(override.highlighted, true);
  assert.doesNotMatch(override.body + override.html + override.pushBody, /123\.456/);

  const checkin = renderAttendance(input([base({ type: 'checkin', occurred_at: '2026-09-10T10:45:00.000Z' })]));
  assert.equal(checkin.title, 'Entrada — João, 07:45');
  assert.equal(checkin.body, 'João chegou à creche às 07:45 (10/09/2026), deixado por Maria Silva (mãe). Registrado por Carlos (portaria).');

  const deniedEvent = base({ type: 'denied', guardian_name: 'Carlos Pai', guardian_relationship: 'pai', occurred_at: '2026-09-10T19:50:00.000Z' });
  const denied = renderAttendance(input([deniedEvent], { blockedEventIds: new Set([deniedEvent.id]) }));
  assert.equal(denied.title, 'Tentativa de retirada recusada — João');
  assert.match(denied.body, /^Carlos Pai \(pai, bloqueado\) tentou retirar João às 16:50 \(10\/09\/2026\)\. A portaria não liberou\./);

  const late = renderAttendance(input([base({ method: 'manual', guard_name: 'Direção' })], { backfilledAt: '2026-09-10T23:05:00.000Z' }));
  assert.match(late.body, /Registrado por Direção \(secretaria\)\. Registro lançado às 20:05 pela secretaria\.$/);

  assert.equal(renderGuardianAdded({ childName: 'João', guardianName: 'Ana', relationship: 'tia', validUntil: '2026-09-15', daycare }).body.startsWith('Nova pessoa autorizada a retirar João: Ana (tia), até 15/09.'), true);
  assert.equal(renderCredentialRevoked({ code: '7K3P2Q9M', childName: null, daycare }).body, 'A carteirinha 7K3P-2Q9M foi cancelada pela creche. Se precisar de uma nova, fale com a secretaria.');
});
