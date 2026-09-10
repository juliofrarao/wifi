import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { addDays } from '@creche/shared';
import { dispatchOnce } from '../src/services/notifications/dispatcher.js';
import {
  ADMIN_PASSWORD,
  GUARD_PASSWORD,
  type TestApp,
  createAdmin,
  createChild,
  createCredential,
  createGuard,
  createGuardian,
  createTestApp,
  get,
  insertEvent,
  link,
  login,
  post,
} from './helpers.js';

const TODAY = '2026-09-10';
const HOLD_MS = 45_000;

interface Row {
  id: string;
  user_id: string;
  kind: string;
  channel: string;
  status: string;
  title: string;
  body: string;
  child_ids: string;
  override: number;
  error: string | null;
  batch_id: string | null;
  dispatch_after: string;
}
const rows = (t: TestApp, where = '1=1', ...params: unknown[]) => t.db.prepare(`SELECT * FROM notifications WHERE ${where} ORDER BY created_at, channel`).all(...params) as Row[];
const item = (clientId: string, childId: string) => ({ clientId, childId });
const dispatch = (t: TestApp) => dispatchOnce({ db: t.db, config: t.config, mailer: t.mailer, push: t.push, now: t.clock.now });

async function setup() {
  const t = await createTestApp();
  await createAdmin(t, { email: 'dir@creche.test', name: 'Direção' });
  const admin = await login(t, 'dir@creche.test', ADMIN_PASSWORD);
  const guard = await createGuard(t, { login: 'carlos', name: 'Carlos' });
  const guardToken = await login(t, 'carlos', GUARD_PASSWORD);
  const maria = await createGuardian(t, { email: 'maria@creche.test', name: 'Maria Silva' });
  const jose = await createGuardian(t, { email: 'jose@creche.test', name: 'José Silva' });
  const ana = createChild(t, { name: 'Ana' });
  const pedro = createChild(t, { name: 'Pedro' });
  link(t, ana.id, maria.id, { relationship: 'mae', isPrimary: true });
  link(t, pedro.id, maria.id, { relationship: 'mae', isPrimary: true });
  link(t, ana.id, jose.id, { relationship: 'pai' });
  return { t, admin, guard, guardToken, maria, jose, ana, pedro };
}

test('sibling batch: check-in then check-out, notifications per recipient subset, held for the undo window', async () => {
  const { t, guardToken, maria, jose, ana, pedro } = await setup();
  try {
    const cIn = { a: randomUUID(), p: randomUUID() };
    const res = await post(t, '/api/attendance/events', { type: 'checkin', guardianId: maria.id, method: 'search', events: [item(cIn.a, ana.id), item(cIn.p, pedro.id)] }, guardToken);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.results.map((r: { status: string }) => r.status), ['created', 'created']);
    assert.equal(res.body.results[0].event.batchId, res.body.batchId);
    assert.equal(res.body.results[0].event.occurredAt, '2026-09-10T12:00:00.000Z', 'live events use the server clock');
    assert.equal(res.body.results[0].event.guardianRelationship, 'mae');
    assert.equal(res.body.results[0].event.guardName, 'Carlos');
    assert.equal(res.body.results[0].event.personDocument, null);
    assert.equal(res.body.undoUntil, '2026-09-10T12:00:45.000Z');
    assert.deepEqual(res.body.warnings, []);

    // Check-in: inapp for Maria (both children) and José (Ana only); no e-mail by default preference, no push (no subscription).
    const inRows = rows(t, 'batch_id = ?', res.body.batchId);
    assert.deepEqual(
      inRows.map((r) => [r.user_id === maria.id ? 'maria' : 'jose', r.channel, r.status]).sort(),
      [
        ['jose', 'inapp', 'pending'],
        ['maria', 'inapp', 'pending'],
      ]
    );
    const mariaIn = inRows.find((r) => r.user_id === maria.id)!;
    assert.equal(mariaIn.title, 'Entrada — Ana e Pedro, 09:00');
    assert.match(mariaIn.body, /^Ana e Pedro chegaram à creche às 09:00 \(10\/09\/2026\), deixados por Maria Silva \(mãe\)\. Registrado por Carlos \(portaria\)\.$/);
    assert.deepEqual(JSON.parse(mariaIn.child_ids).sort(), [ana.id, pedro.id].sort());
    const joseIn = inRows.find((r) => r.user_id === jose.id)!;
    assert.equal(joseIn.title, 'Entrada — Ana, 09:00');
    assert.deepEqual(JSON.parse(joseIn.child_ids), [ana.id]);
    assert.equal(mariaIn.dispatch_after, res.body.undoUntil);

    // Nothing goes out inside the hold window.
    t.clock.advance(HOLD_MS - 1000);
    let s = await dispatch(t);
    assert.equal(s.processed, 0);
    t.clock.advance(2000);
    s = await dispatch(t);
    assert.equal(s.sent, 2);
    assert.equal(rows(t, 'status = ?', 'sent').length, 2);

    // Status now: both present since the check-in.
    const today = await get(t, '/api/attendance/today', guardToken);
    assert.equal(today.body.presentCount, 2);
    assert.equal(today.body.present[0].status.since, '2026-09-10T12:00:00.000Z');

    // Check-out at 17:32 local (20:32Z): every guardian gets inapp + e-mail.
    t.clock.set('2026-09-10T20:32:00.000Z');
    const cOut = { a: randomUUID(), p: randomUUID() };
    const out = await post(t, '/api/attendance/events', { type: 'checkout', guardianId: maria.id, method: 'search', events: [item(cOut.a, ana.id), item(cOut.p, pedro.id)] }, guardToken);
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.deepEqual(out.body.results.map((r: { status: string }) => r.status), ['created', 'created']);
    assert.equal(out.body.results[0].event.override, false);
    const outRows = rows(t, 'batch_id = ?', out.body.batchId);
    assert.deepEqual(
      outRows.map((r) => [r.user_id === maria.id ? 'maria' : 'jose', r.channel]).sort(),
      [
        ['jose', 'email'],
        ['jose', 'inapp'],
        ['maria', 'email'],
        ['maria', 'inapp'],
      ]
    );
    const mariaOut = outRows.find((r) => r.user_id === maria.id && r.channel === 'inapp')!;
    assert.equal(mariaOut.title, 'Saída registrada — Ana e Pedro');
    assert.equal(mariaOut.body, 'Ana e Pedro saíram da creche às 17:32 (10/09/2026) com Maria Silva (mãe). Entrada hoje às 09:00. Registrado por Carlos (portaria).');
    assert.equal(mariaOut.override, 0);

    t.clock.advance(HOLD_MS + 1000);
    s = await dispatch(t);
    assert.equal(s.sent, 4);
    assert.equal(t.mailer.outbox.length, 2);
    const mail = t.mailer.outbox.find((m) => m.to === 'maria@creche.test')!;
    assert.equal(mail.subject, '[Creche Teste] Saída registrada — Ana e Pedro');
    assert.equal(mail.replyTo, 'contato@creche.test');
    assert.match(mail.html!, /Ana e Pedro saíram/);
    assert.equal((await get(t, '/api/attendance/today', guardToken)).body.presentCount, 0);
  } finally {
    await t.close();
  }
});

test('R4 duplicate clientId replay and R5 double tap return the existing event without notifying again', async () => {
  const { t, guardToken, maria, ana } = await setup();
  try {
    const clientId = randomUUID();
    const body = { type: 'checkin', guardianId: maria.id, method: 'search', events: [item(clientId, ana.id)] };
    const first = await post(t, '/api/attendance/events', body, guardToken);
    assert.equal(first.body.results[0].status, 'created');
    const before = rows(t).length;
    t.clock.advance(5000);
    const replay = await post(t, '/api/attendance/events', body, guardToken);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.results[0].status, 'duplicate');
    assert.equal(replay.body.results[0].event.id, first.body.results[0].event.id);
    assert.equal(replay.body.batchId, first.body.batchId, 'batch of the existing item');
    assert.equal(replay.body.undoUntil, null);
    assert.equal(rows(t).length, before);

    // Double tap: new clientId, same type/child/guardian/guard within 60 s.
    t.clock.advance(20_000);
    const tap = await post(t, '/api/attendance/events', { ...body, events: [item(randomUUID(), ana.id)] }, guardToken);
    assert.equal(tap.body.results[0].status, 'duplicate');
    assert.equal(tap.body.results[0].event.id, first.body.results[0].event.id);
    assert.equal((t.db.prepare('SELECT COUNT(*) AS n FROM attendance_events').get() as { n: number }).n, 1);
    assert.equal(rows(t).length, before);
  } finally {
    await t.close();
  }
});

test('R1 live: INVALID_STATE with currentStatus; queued conflicts are stored and highlighted for admins', async () => {
  const { t, guardToken, maria, ana } = await setup();
  try {
    const checkin = () => post(t, '/api/attendance/events', { type: 'checkin', guardianId: maria.id, method: 'search', events: [item(randomUUID(), ana.id)] }, guardToken);
    const outWhenOut = await post(t, '/api/attendance/events', { type: 'checkout', guardianId: maria.id, method: 'search', events: [item(randomUUID(), ana.id)] }, guardToken);
    assert.equal(outWhenOut.status, 200);
    assert.equal(outWhenOut.body.results[0].status, 'rejected');
    assert.equal(outWhenOut.body.results[0].error.code, 'INVALID_STATE');
    assert.equal(outWhenOut.body.results[0].error.currentStatus.present, false);
    assert.equal(outWhenOut.body.undoUntil, null);

    assert.equal((await checkin()).body.results[0].status, 'created');
    t.clock.advance(120_000);
    const again = await checkin();
    assert.equal(again.body.results[0].status, 'rejected');
    assert.equal(again.body.results[0].error.code, 'INVALID_STATE');
    assert.equal(again.body.results[0].error.currentStatus.present, true);
    assert.equal(again.body.results[0].error.currentStatus.since, '2026-09-10T12:00:00.000Z');

    // Queued check-in while present → stored with conflict, admins notified (highlighted).
    const queued = await post(
      t,
      '/api/attendance/events',
      { type: 'checkin', guardianId: maria.id, method: 'search', queued: true, occurredAt: '2026-09-10T11:50:00.000Z', directoryGeneratedAt: '2026-09-10T11:00:00.000Z', events: [item(randomUUID(), ana.id)] },
      guardToken
    );
    assert.equal(queued.body.results[0].status, 'created');
    assert.equal(queued.body.results[0].event.conflict, 'already_present');
    assert.equal(queued.body.results[0].event.queued, true);
    assert.equal(queued.body.results[0].event.occurredAt, '2026-09-10T11:50:00.000Z');
    const adminId = (t.db.prepare(`SELECT id FROM users WHERE role = 'admin'`).get() as { id: string }).id;
    const adminRow = rows(t, 'batch_id = ? AND user_id = ?', queued.body.batchId, adminId);
    assert.ok(adminRow.length >= 1, 'admins are notified about conflicts');
    assert.equal(adminRow[0].override, 1);
    assert.match(adminRow[0].body, /fila da portaria/);

    // Queued check-out while out.
    t.db.prepare(`UPDATE attendance_events SET voided_at = ? WHERE type = 'checkin'`).run(t.clock.now().toISOString());
    const qOut = await post(t, '/api/attendance/events', { type: 'checkout', guardianId: maria.id, method: 'search', queued: true, occurredAt: t.clock.now().toISOString(), events: [item(randomUUID(), ana.id)] }, guardToken);
    assert.equal(qOut.body.results[0].status, 'created');
    assert.equal(qOut.body.results[0].event.conflict, 'already_out');
  } finally {
    await t.close();
  }
});

test('R1 stale: check-in closes the previous day automatically (23:59:59 local, inapp only); STALE_PRESENCE on live check-out without note', async () => {
  const { t, guardToken, guard, maria, ana, pedro } = await setup();
  try {
    // Ana entered yesterday 08:00 local and never left.
    insertEvent(t, { childId: ana.id, type: 'checkin', guardId: guard.id, guardianId: maria.id, occurredAt: '2026-09-09T11:00:00.000Z' });
    insertEvent(t, { childId: pedro.id, type: 'checkin', guardId: guard.id, guardianId: maria.id, occurredAt: '2026-09-09T11:00:00.000Z' });
    const today = await get(t, '/api/attendance/today', guardToken);
    assert.equal(today.body.presentCount, 0);
    assert.equal(today.body.stalePresentCount, 2);

    const res = await post(t, '/api/attendance/events', { type: 'checkin', guardianId: maria.id, method: 'search', events: [item(randomUUID(), ana.id)] }, guardToken);
    assert.equal(res.body.results[0].status, 'created');
    const auto = t.db.prepare(`SELECT * FROM attendance_events WHERE child_id = ? AND method = 'auto'`).get(ana.id) as { occurred_at: string; note: string; person_name: string; type: string; batch_id: string };
    assert.equal(auto.type, 'checkout');
    assert.equal(auto.occurred_at, '2026-09-10T02:59:59.999Z', '23:59:59.999 São Paulo of the entry day');
    assert.equal(auto.note, 'Fechamento automático: saída não registrada em 09/09');
    assert.equal(auto.person_name, 'Sistema');
    assert.notEqual(auto.batch_id, res.body.batchId);
    const autoRows = rows(t, 'batch_id = ?', auto.batch_id);
    assert.deepEqual(autoRows.map((r) => r.channel), ['inapp', 'inapp'], 'Maria and José, inapp only');
    assert.match(autoRows[0].title, /^Fechamento automático — Ana/);
    assert.equal(autoRows[0].dispatch_after, t.clock.now().toISOString(), 'not held: not undoable');
    const status = await get(t, `/api/children/${ana.id}`, guardToken);
    assert.equal(status.body.status.present, true);
    assert.equal(status.body.status.stale, false);

    // Pedro is still stale: live check-out requires a note.
    const noNote = await post(t, '/api/attendance/events', { type: 'checkout', guardianId: maria.id, method: 'search', events: [item(randomUUID(), pedro.id)] }, guardToken);
    assert.equal(noNote.body.results[0].status, 'rejected');
    assert.equal(noNote.body.results[0].error.code, 'STALE_PRESENCE');
    const withNote = await post(t, '/api/attendance/events', { type: 'checkout', guardianId: maria.id, method: 'search', note: 'Ficou ontem com a tia; saiu agora', events: [item(randomUUID(), pedro.id)] }, guardToken);
    assert.equal(withNote.body.results[0].status, 'created');
    assert.equal((await get(t, '/api/attendance/today', guardToken)).body.stalePresentCount, 0);
  } finally {
    await t.close();
  }
});

test('R2: PICKUP_NOT_ALLOWED per child; override marks only the child that needed it; admins alerted', async () => {
  const t = await createTestApp();
  try {
    await createAdmin(t, { email: 'dir@creche.test' });
    const guard = await createGuard(t, { login: 'carlos' });
    const gt = await login(t, 'carlos', GUARD_PASSWORD);
    const maria = await createGuardian(t, { email: 'maria@creche.test', name: 'Maria' });
    const ana = createChild(t, { name: 'Ana' });
    const pedro = createChild(t, { name: 'Pedro' });
    link(t, ana.id, maria.id, { relationship: 'mae' });
    link(t, pedro.id, maria.id, { relationship: 'tia', validUntil: addDays(TODAY, -1) });
    insertEvent(t, { childId: ana.id, type: 'checkin', guardId: guard.id, guardianId: maria.id, occurredAt: '2026-09-10T10:45:00.000Z' });
    insertEvent(t, { childId: pedro.id, type: 'checkin', guardId: guard.id, guardianId: maria.id, occurredAt: '2026-09-10T10:45:00.000Z' });

    const events = () => [item(randomUUID(), ana.id), item(randomUUID(), pedro.id)];
    const plain = await post(t, '/api/attendance/events', { type: 'checkout', guardianId: maria.id, method: 'search', events: events() }, gt);
    assert.equal(plain.status, 200);
    assert.equal(plain.body.results[0].status, 'created', 'Ana: allowed');
    assert.equal(plain.body.results[1].status, 'rejected');
    assert.equal(plain.body.results[1].error.code, 'PICKUP_NOT_ALLOWED');
    assert.match(plain.body.results[1].error.message, /validade/);

    // Override without a note is a validation error; with a note only Pedro gets override=true.
    const noNote = await post(t, '/api/attendance/events', { type: 'checkout', guardianId: maria.id, method: 'search', override: true, events: [item(randomUUID(), pedro.id)] }, gt);
    assert.equal(noNote.status, 400);
    t.clock.advance(120_000);
    insertEvent(t, { childId: ana.id, type: 'checkin', guardId: guard.id, guardianId: maria.id, occurredAt: t.clock.now().toISOString() });
    t.clock.advance(120_000);
    const withOverride = await post(t, '/api/attendance/events', { type: 'checkout', guardianId: maria.id, method: 'search', override: true, note: 'Direção autorizou por telefone', events: events() }, gt);
    assert.deepEqual(withOverride.body.results.map((r: { status: string }) => r.status), ['created', 'created']);
    assert.equal(withOverride.body.results[0].event.override, false, 'Ana did not need the exception');
    assert.equal(withOverride.body.results[1].event.override, true);
    const adminId = (t.db.prepare(`SELECT id FROM users WHERE role = 'admin'`).get() as { id: string }).id;
    const adminRows = rows(t, 'batch_id = ? AND user_id = ?', withOverride.body.batchId, adminId);
    assert.ok(adminRows.length >= 1);
    assert.equal(adminRows[0].title, 'ATENÇÃO — retirada fora da lista de autorizados');
    assert.match(adminRows[0].body, /Motivo: 'Direção autorizou por telefone'/);
    assert.match(adminRows[0].body, /ligue agora para a creche: \(11\) 4002-8922/);
    const mariaRow = rows(t, 'batch_id = ? AND user_id = ? AND channel = ?', withOverride.body.batchId, maria.id, 'inapp')[0];
    assert.equal(mariaRow.override, 1);

    // Unregistered person on check-out needs override (schema) → 400 without it, created with it.
    t.clock.advance(60_000);
    insertEvent(t, { childId: ana.id, type: 'checkin', guardId: guard.id, guardianId: maria.id, occurredAt: t.clock.now().toISOString() });
    t.clock.advance(120_000);
    const stranger = await post(t, '/api/attendance/events', { type: 'checkout', personName: 'Ana Souza', method: 'search', events: [item(randomUUID(), ana.id)] }, gt);
    assert.equal(stranger.status, 400);
    const strangerOk = await post(
      t,
      '/api/attendance/events',
      { type: 'checkout', personName: 'Ana Souza', personDocument: '123.456.789-00', documentChecked: true, override: true, note: 'mãe ligou autorizando', method: 'search', events: [item(randomUUID(), ana.id)] },
      gt
    );
    assert.equal(strangerOk.body.results[0].status, 'created');
    assert.equal(strangerOk.body.results[0].event.personDocument, null, 'guards never see the document');
    assert.equal(strangerOk.body.results[0].event.documentChecked, true);
    const texts = rows(t, 'batch_id = ?', strangerOk.body.batchId);
    assert.ok(texts.length > 0);
    for (const r of texts) {
      assert.doesNotMatch(r.title + r.body, /123\.456/, 'document number never in alerts');
      assert.match(r.body, /Ana Souza \(não cadastrada\), documento conferido pela portaria\. Motivo: 'mãe ligou autorizando'/);
    }
  } finally {
    await t.close();
  }
});

test('R2: one-off authorization valid today allows pickup without exception; expired or other child does not', async () => {
  const t = await createTestApp();
  try {
    await createAdmin(t, { email: 'dir@creche.test' });
    const guard = await createGuard(t, { login: 'carlos' });
    const gt = await login(t, 'carlos', GUARD_PASSWORD);
    const maria = await createGuardian(t, { email: 'maria@creche.test', name: 'Maria' });
    const ana = createChild(t, { name: 'Ana' });
    const pedro = createChild(t, { name: 'Pedro' });
    link(t, ana.id, maria.id, { relationship: 'mae' });
    link(t, pedro.id, maria.id, { relationship: 'mae' });
    insertEvent(t, { childId: ana.id, type: 'checkin', guardId: guard.id, guardianId: maria.id, occurredAt: '2026-09-10T10:45:00.000Z' });
    insertEvent(t, { childId: pedro.id, type: 'checkin', guardId: guard.id, guardianId: maria.id, occurredAt: '2026-09-10T10:45:00.000Z' });
    const insertAuth = (childId: string, validFrom: string, validUntil: string) => {
      const id = randomUUID();
      t.db
        .prepare(
          `INSERT INTO pickup_authorizations (id, child_id, person_name, person_document, relationship_label, phone, valid_from, valid_until, note, created_by, created_at, revoked_at, revoked_by)
           VALUES (?, ?, 'Rosa Vizinha', '111.222.333-44', 'vizinha', NULL, ?, ?, NULL, ?, ?, NULL, NULL)`
        )
        .run(id, childId, validFrom, validUntil, maria.id, t.clock.now().toISOString());
      return id;
    };
    const valid = insertAuth(ana.id, TODAY, TODAY);
    const expired = insertAuth(pedro.id, addDays(TODAY, -3), addDays(TODAY, -1));

    const ok = await post(t, '/api/attendance/events', { type: 'checkout', authorizationId: valid, personName: 'Rosa Vizinha', method: 'search', events: [item(randomUUID(), ana.id), item(randomUUID(), pedro.id)] }, gt);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.results[0].status, 'created');
    assert.equal(ok.body.results[0].event.override, false);
    assert.equal(ok.body.results[0].event.authorizationId, valid);
    assert.equal(ok.body.results[0].event.authorizedByName, 'Maria (mãe)');
    assert.equal(ok.body.results[0].event.personName, 'Rosa Vizinha');
    assert.equal(ok.body.results[1].status, 'rejected', 'the authorization is for Ana only');
    assert.equal(ok.body.results[1].error.code, 'PICKUP_NOT_ALLOWED');
    const mariaRow = rows(t, 'batch_id = ? AND user_id = ? AND channel = ?', ok.body.batchId, maria.id, 'inapp')[0];
    assert.equal(mariaRow.body, 'Ana saiu da creche às 09:00 (10/09/2026) com Rosa Vizinha (vizinha), autorizada por Maria (mãe). Entrada hoje às 07:45. Registrado por Vigilante 2 (portaria).'.replace('Vigilante 2', guard.name));
    assert.doesNotMatch(mariaRow.body, /111\.222/);

    const exp = await post(t, '/api/attendance/events', { type: 'checkout', authorizationId: expired, personName: 'Rosa Vizinha', method: 'search', events: [item(randomUUID(), pedro.id)] }, gt);
    assert.equal(exp.body.results[0].status, 'rejected');
    assert.equal(exp.body.results[0].error.code, 'PICKUP_NOT_ALLOWED');
    const unknown = await post(t, '/api/attendance/events', { type: 'checkout', authorizationId: randomUUID(), personName: 'X Y', method: 'search', events: [item(randomUUID(), pedro.id)] }, gt);
    assert.equal(unknown.status, 404);
  } finally {
    await t.close();
  }
});

test('blocked link: check-out refused even with override, check-in accepted, denied event recorded and notifies guardians + admins (not the blocked person)', async () => {
  const t = await createTestApp();
  try {
    await createAdmin(t, { email: 'dir@creche.test' });
    const guard = await createGuard(t, { login: 'carlos', name: 'Carlos' });
    const gt = await login(t, 'carlos', GUARD_PASSWORD);
    const maria = await createGuardian(t, { email: 'maria@creche.test', name: 'Maria' });
    const pai = await createGuardian(t, { email: 'pai@creche.test', name: 'Carlos Pai' });
    const joao = createChild(t, { name: 'João' });
    link(t, joao.id, maria.id, { relationship: 'mae' });
    link(t, joao.id, pai.id, { relationship: 'pai', blocked: true, blockedReason: 'judicial' });
    insertEvent(t, { childId: joao.id, type: 'checkin', guardId: guard.id, guardianId: maria.id, occurredAt: '2026-09-10T10:45:00.000Z' });

    const out = await post(t, '/api/attendance/events', { type: 'checkout', guardianId: pai.id, method: 'search', override: true, note: 'insistiu muito na portaria', events: [item(randomUUID(), joao.id)] }, gt);
    assert.equal(out.body.results[0].status, 'rejected');
    assert.equal(out.body.results[0].error.code, 'GUARDIAN_BLOCKED');

    t.clock.set('2026-09-10T19:50:00.000Z');
    const denied = await post(t, '/api/attendance/events', { type: 'denied', guardianId: pai.id, method: 'search', events: [item(randomUUID(), joao.id)] }, gt);
    assert.equal(denied.status, 200, JSON.stringify(denied.body));
    assert.equal(denied.body.results[0].status, 'created');
    assert.equal(denied.body.results[0].event.type, 'denied');
    assert.equal((await get(t, `/api/children/${joao.id}`, gt)).body.status.present, true, 'denied does not change the status');
    const deniedRows = rows(t, 'batch_id = ?', denied.body.batchId);
    assert.ok(deniedRows.every((r) => r.user_id !== pai.id), 'blocked person not notified');
    assert.ok(deniedRows.some((r) => r.user_id === maria.id));
    const adminId = (t.db.prepare(`SELECT id FROM users WHERE role = 'admin'`).get() as { id: string }).id;
    assert.ok(deniedRows.some((r) => r.user_id === adminId));
    const mariaRow = deniedRows.find((r) => r.user_id === maria.id && r.channel === 'inapp')!;
    assert.equal(mariaRow.title, 'Tentativa de retirada recusada — João');
    assert.match(mariaRow.body, /^Carlos Pai \(pai, bloqueado\) tentou retirar João às 16:50 \(10\/09\/2026\)\. A portaria não liberou\./);
    assert.equal(mariaRow.override, 1);

    // R3: a blocked guardian may still drop the child off.
    insertEvent(t, { childId: joao.id, type: 'checkout', guardId: guard.id, guardianId: maria.id, occurredAt: '2026-09-10T20:00:00.000Z' });
    t.clock.set('2026-09-11T11:00:00.000Z');
    const inRes = await post(t, '/api/attendance/events', { type: 'checkin', guardianId: pai.id, method: 'search', events: [item(randomUUID(), joao.id)] }, gt);
    assert.equal(inRes.body.results[0].status, 'created');
    assert.equal(inRes.body.results[0].event.override, false);
  } finally {
    await t.close();
  }
});

test('R11/R15: revoked card live → CARD_REVOKED; queued after revocation → override + note; method/credential consistency', async () => {
  const { t, guardToken, maria, jose, ana, pedro } = await setup();
  try {
    const card = createCredential(t, 'guardian', maria.id);
    const joseCard = createCredential(t, 'guardian', jose.id);
    const anaCard = createCredential(t, 'child', ana.id);
    const ev = () => [item(randomUUID(), ana.id)];

    // R15
    assert.equal((await post(t, '/api/attendance/events', { type: 'checkin', guardianId: maria.id, method: 'nfc', events: ev() }, guardToken)).status, 400);
    assert.equal((await post(t, '/api/attendance/events', { type: 'checkin', guardianId: maria.id, method: 'search', credentialId: card.id, events: ev() }, guardToken)).status, 400);
    const mismatch = await post(t, '/api/attendance/events', { type: 'checkin', guardianId: maria.id, method: 'code', credentialId: joseCard.id, events: ev() }, guardToken);
    assert.equal(mismatch.status, 409);
    assert.equal(mismatch.body.error.code, 'CREDENTIAL_MISMATCH');
    const childCard = await post(t, '/api/attendance/events', { type: 'checkin', guardianId: maria.id, method: 'qr', credentialId: anaCard.id, events: [item(randomUUID(), pedro.id), item(randomUUID(), ana.id)] }, guardToken);
    assert.equal(childCard.status, 200, JSON.stringify(childCard.body));
    assert.deepEqual(childCard.body.results.map((r: { status: string }) => r.status), ['created', 'created']);
    assert.equal(childCard.body.results[0].event.credentialId, anaCard.id);
    assert.equal(childCard.body.results[0].event.method, 'qr');

    // Revoke Maria's card at 08:00 local.
    t.db.prepare(`UPDATE credentials SET active = 0, revoked_at = '2026-09-10T11:00:00.000Z' WHERE id = ?`).run(card.id);
    t.clock.set('2026-09-10T20:00:00.000Z');
    const live = await post(t, '/api/attendance/events', { type: 'checkout', guardianId: maria.id, method: 'code', credentialId: card.id, events: [item(randomUUID(), ana.id), item(randomUUID(), pedro.id)] }, guardToken);
    assert.equal(live.status, 200);
    assert.deepEqual(live.body.results.map((r: { error?: { code: string } }) => r.error?.code), ['CARD_REVOKED', 'CARD_REVOKED']);
    assert.equal(live.body.undoUntil, null);

    const queued = await post(
      t,
      '/api/attendance/events',
      { type: 'checkout', guardianId: maria.id, method: 'code', credentialId: card.id, queued: true, occurredAt: '2026-09-10T19:30:00.000Z', events: [item(randomUUID(), ana.id)] },
      guardToken
    );
    assert.equal(queued.body.results[0].status, 'created', JSON.stringify(queued.body));
    assert.equal(queued.body.results[0].event.override, true);
    assert.equal(queued.body.results[0].event.note, 'carteirinha revogada em 10/09 08:00');
    const adminId = (t.db.prepare(`SELECT id FROM users WHERE role = 'admin'`).get() as { id: string }).id;
    assert.ok(rows(t, 'batch_id = ? AND user_id = ?', queued.body.batchId, adminId).length >= 1, 'admins alerted');

    // Queued event that happened BEFORE the revocation is a normal record.
    const before = await post(
      t,
      '/api/attendance/events',
      { type: 'checkout', guardianId: maria.id, method: 'code', credentialId: card.id, queued: true, occurredAt: '2026-09-10T10:30:00.000Z', events: [item(randomUUID(), pedro.id)] },
      guardToken
    );
    assert.equal(before.body.results[0].status, 'created');
    assert.equal(before.body.results[0].event.override, false);
    assert.equal(before.body.results[0].event.note, null);
  } finally {
    await t.close();
  }
});

test('R6: live ignores device time; queued uses it inside [now − 7 d, now + 2 min], else server time + warning', async () => {
  const { t, guardToken, maria, ana } = await setup();
  try {
    const now = t.clock.now().toISOString();
    const live = await post(t, '/api/attendance/events', { type: 'checkin', guardianId: maria.id, method: 'search', occurredAt: '2026-09-01T10:00:00.000Z', events: [item(randomUUID(), ana.id)] }, guardToken);
    assert.equal(live.body.results[0].event.occurredAt, now);
    assert.deepEqual(live.body.warnings, []);
    t.db.exec('DELETE FROM notifications; DELETE FROM attendance_events');

    const cases: [string, string, boolean][] = [
      ['2026-09-07T10:00:00.000Z', '2026-09-07T10:00:00.000Z', false],
      ['2026-09-10T12:01:30.000Z', '2026-09-10T12:01:30.000Z', false],
      ['2026-09-02T11:00:00.000Z', now, true],
      ['2026-09-10T12:05:00.000Z', now, true],
      ['2026-09-10T09:00:00.000-03:00', '2026-09-10T12:00:00.000Z', false],
    ];
    for (const [device, expected, warned] of cases) {
      const res = await post(t, '/api/attendance/events', { type: 'checkin', guardianId: maria.id, method: 'search', queued: true, occurredAt: device, events: [item(randomUUID(), ana.id)] }, guardToken);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.results[0].event.occurredAt, expected, device);
      assert.equal(res.body.warnings.length > 0, warned, device);
      t.db.exec('DELETE FROM notifications; DELETE FROM attendance_events');
    }
  } finally {
    await t.close();
  }
});

test('void: inside the hold window nothing is sent (siblings regenerate), outside "Registro cancelado" goes out; guard ≤ 24 h, admin always', async () => {
  const { t, admin, guardToken, maria, ana, pedro } = await setup();
  try {
    const guardId = (t.db.prepare(`SELECT id FROM users WHERE login = 'carlos'`).get() as { id: string }).id;
    insertEvent(t, { childId: ana.id, type: 'checkin', guardId, guardianId: maria.id, occurredAt: '2026-09-10T10:45:00.000Z' });
    insertEvent(t, { childId: pedro.id, type: 'checkin', guardId, guardianId: maria.id, occurredAt: '2026-09-10T10:45:00.000Z' });
    const out = await post(t, '/api/attendance/events', { type: 'checkout', guardianId: maria.id, method: 'search', events: [item(randomUUID(), ana.id), item(randomUUID(), pedro.id)] }, guardToken);
    const [anaEvent, pedroEvent] = out.body.results.map((r: { event: { id: string } }) => r.event.id);

    // Void Ana inside the window: rows for the batch are regenerated for Pedro only.
    t.clock.advance(10_000);
    const v1 = await post(t, `/api/attendance/events/${anaEvent}/void`, { reason: 'toque errado' }, guardToken);
    assert.equal(v1.status, 200);
    assert.ok(v1.body.voidedAt);
    assert.equal(v1.body.voidReason, 'toque errado');
    let batchRows = rows(t, 'batch_id = ?', out.body.batchId);
    assert.ok(batchRows.length > 0);
    for (const r of batchRows) {
      assert.equal(r.status, 'pending');
      assert.deepEqual(JSON.parse(r.child_ids), [pedro.id]);
      assert.equal(r.title, 'Saída registrada — Pedro');
      assert.equal(r.dispatch_after, out.body.undoUntil, 'original hold kept');
    }
    assert.equal(rows(t, "kind = 'void'").length, 0, 'no cancellation alert inside the window');
    assert.equal((await get(t, `/api/children/${ana.id}`, guardToken)).body.status.present, true, 'voided check-out does not count');

    // Void Pedro too: everything pending is skipped.
    const v2 = await post(t, `/api/attendance/events/${pedroEvent}/void`, { reason: 'toque errado' }, guardToken);
    assert.equal(v2.status, 200);
    batchRows = rows(t, 'batch_id = ?', out.body.batchId);
    assert.ok(batchRows.every((r) => r.status === 'skipped' && r.error === 'voided'));
    t.clock.advance(HOLD_MS);
    const s = await dispatch(t);
    assert.equal(s.sent, 0);
    assert.equal(t.mailer.outbox.length, 0);
    assert.equal((await post(t, `/api/attendance/events/${pedroEvent}/void`, { reason: 'de novo' }, guardToken)).status, 200, 'idempotent');

    // A delivered check-out that is later cancelled → "Registro cancelado" (inapp + e-mail).
    t.clock.set('2026-09-10T20:32:00.000Z');
    const out2 = await post(t, '/api/attendance/events', { type: 'checkout', guardianId: maria.id, method: 'search', events: [item(randomUUID(), ana.id)] }, guardToken);
    const ev2 = out2.body.results[0].event.id as string;
    t.clock.advance(HOLD_MS + 1000);
    await dispatch(t);
    t.mailer.outbox.length = 0;
    const v3 = await post(t, `/api/attendance/events/${ev2}/void`, { reason: 'registrado na criança errada' }, guardToken);
    assert.equal(v3.status, 200);
    const voidRows = rows(t, "kind = 'void'");
    assert.deepEqual(voidRows.map((r) => [r.user_id === maria.id ? 'maria' : 'jose', r.channel]).sort(), [
      ['jose', 'email'],
      ['jose', 'inapp'],
      ['maria', 'email'],
      ['maria', 'inapp'],
    ]);
    assert.equal(voidRows[0].title, 'Registro cancelado — Ana');
    assert.equal(voidRows[0].body, 'O registro de saída de Ana às 17:32 (10/09/2026) foi cancelado por Carlos (motivo: registrado na criança errada).');
    await dispatch(t);
    assert.equal(t.mailer.outbox.length, 2);
    assert.match(t.mailer.outbox[0].subject, /Registro cancelado/);

    // Guard cannot void after 24 h; admin can.
    t.clock.set('2026-09-12T12:00:00.000Z');
    const old = await post(t, `/api/attendance/events/${ev2}/void`, { reason: 'tarde demais' }, guardToken);
    assert.equal(old.status, 200, 'already voided → idempotent');
    const inRes = await post(t, '/api/attendance/events', { type: 'checkin', guardianId: maria.id, method: 'search', events: [item(randomUUID(), ana.id)] }, guardToken);
    const ev3 = inRes.body.results[0].event.id as string;
    t.clock.set('2026-09-13T13:00:00.000Z');
    const late = await post(t, `/api/attendance/events/${ev3}/void`, { reason: 'erro antigo' }, guardToken);
    assert.equal(late.status, 403);
    const byAdmin = await post(t, `/api/attendance/events/${ev3}/void`, { reason: 'erro antigo' }, admin);
    assert.equal(byAdmin.status, 200);
    assert.equal((await post(t, `/api/attendance/events/${randomUUID()}/void`, { reason: 'x y z' }, admin)).status, 404);
    const auditRows = (await get(t, '/api/admin/audit', admin)).body.items.filter((a: { action: string }) => a.action === 'event.void');
    assert.ok(auditRows.length >= 3);
  } finally {
    await t.close();
  }
});

test('backfill: admin only, manual method, R1 at the given time, late rows notify inapp + e-mail with the office text', async () => {
  const { t, admin, guardToken, maria, jose, ana, pedro } = await setup();
  try {
    assert.equal((await post(t, '/api/attendance/backfill', { rows: [] }, guardToken)).status, 403);
    t.db.prepare('INSERT INTO push_subscriptions (id, user_id, session_id, endpoint, p256dh, auth, user_agent, created_at) VALUES (?, ?, NULL, ?, ?, ?, NULL, ?)').run(randomUUID(), maria.id, 'https://push.test/maria', 'k', 'a', t.clock.now().toISOString());
    const rowsBody = [
      { clientId: randomUUID(), childId: ana.id, type: 'checkin', guardianId: maria.id, occurredAt: '2026-09-09T10:45:00.000Z' },
      { clientId: randomUUID(), childId: pedro.id, type: 'checkin', guardianId: maria.id, occurredAt: '2026-09-09T10:45:00.000Z' },
      { clientId: randomUUID(), childId: ana.id, type: 'checkout', guardianId: jose.id, occurredAt: '2026-09-09T20:05:00.000Z' },
      { clientId: randomUUID(), childId: pedro.id, type: 'checkout', guardianId: maria.id, occurredAt: '2026-09-09T20:10:00.000Z', note: 'folha de papel' },
      { clientId: randomUUID(), childId: pedro.id, type: 'checkout', guardianId: maria.id, occurredAt: '2026-09-09T21:00:00.000Z' },
      { clientId: randomUUID(), childId: ana.id, type: 'checkin', guardianId: maria.id, occurredAt: '2026-09-11T10:45:00.000Z' },
    ];
    const res = await post(t, '/api/attendance/backfill', { rows: rowsBody }, admin);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const statuses = res.body.results.map((r: { status: string; error?: { code: string } }) => r.error?.code ?? r.status);
    assert.deepEqual(statuses, ['created', 'created', 'created', 'created', 'INVALID_STATE', 'OCCURRED_AT_INVALID']);
    assert.equal(res.body.results[0].event.method, 'manual');
    assert.equal(res.body.results[0].event.guardName, 'Direção');
    assert.equal(res.body.results[0].event.occurredAt, '2026-09-09T10:45:00.000Z');
    assert.equal(res.body.results[0].event.batchId, res.body.results[1].event.batchId, 'siblings with the same time/person share a batch');
    assert.notEqual(res.body.results[2].event.batchId, res.body.results[3].event.batchId);
    assert.ok(res.body.undoUntil);

    // Late (> 3 h): inapp + e-mail only (no push although Maria has a subscription), with the office text.
    const checkoutRows = rows(t, 'batch_id = ?', res.body.results[3].event.batchId);
    assert.deepEqual(checkoutRows.map((r) => r.channel).sort(), ['email', 'inapp']);
    assert.match(checkoutRows[0].body, /Registro lançado às 09:00 pela secretaria\./);
    assert.match(checkoutRows[0].body, /Registrado por Direção \(secretaria\)/);
    assert.equal(rows(t, "channel = 'push'").length, 0);
    const status = await get(t, `/api/children/${ana.id}`, admin);
    assert.equal(status.body.status.present, false);
    const auditRows = (await get(t, '/api/admin/audit', admin)).body.items.filter((a: { action: string }) => a.action === 'attendance.backfill');
    assert.ok(auditRows.length >= 3);
  } finally {
    await t.close();
  }
});
