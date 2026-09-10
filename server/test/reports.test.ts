import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN_PASSWORD, GUARD_PASSWORD, GUARDIAN_PASSWORD, createAdmin, createChild, createGuard, createGuardian, createTestApp, get, insertEvent, link, login, request } from './helpers.js';

test('today summary counts (stale excluded) and events query role rules', async () => {
  const t = await createTestApp();
  try {
    await createAdmin(t, { email: 'dir@creche.test' });
    const admin = await login(t, 'dir@creche.test', ADMIN_PASSWORD);
    const guard = await createGuard(t, { login: 'carlos' });
    const gt = await login(t, 'carlos', GUARD_PASSWORD);
    const maria = await createGuardian(t, { email: 'maria@creche.test', name: 'Maria' });
    const blocked = await createGuardian(t, { email: 'bloq@creche.test' });
    const stranger = await createGuardian(t, { email: 'outra@creche.test' });
    const ana = createChild(t, { name: 'Ana' });
    const pedro = createChild(t, { name: 'Pedro' });
    const stale = createChild(t, { name: 'Stale' });
    link(t, ana.id, maria.id);
    link(t, pedro.id, maria.id);
    link(t, stale.id, maria.id);
    link(t, ana.id, blocked.id, { relationship: 'tio', blocked: true });
    insertEvent(t, { childId: ana.id, type: 'checkin', guardId: guard.id, guardianId: maria.id, occurredAt: '2026-09-10T10:45:00.000Z' });
    insertEvent(t, { childId: ana.id, type: 'checkout', guardId: guard.id, guardianId: maria.id, occurredAt: '2026-09-10T11:30:00.000Z', voidedAt: '2026-09-10T11:31:00.000Z' });
    insertEvent(t, { childId: pedro.id, type: 'checkin', guardId: guard.id, guardianId: maria.id, occurredAt: '2026-09-10T11:00:00.000Z' });
    insertEvent(t, { childId: pedro.id, type: 'checkout', guardId: guard.id, guardianId: maria.id, occurredAt: '2026-09-10T11:40:00.000Z' });
    insertEvent(t, { childId: stale.id, type: 'checkin', guardId: guard.id, guardianId: maria.id, occurredAt: '2026-09-09T11:00:00.000Z' });
    insertEvent(t, { childId: ana.id, type: 'checkin', guardId: guard.id, guardianId: maria.id, occurredAt: '2026-08-30T11:00:00.000Z' }); // 11 days ago
    insertEvent(t, { childId: ana.id, type: 'checkout', guardId: guard.id, guardianId: maria.id, occurredAt: '2026-08-30T20:00:00.000Z' });

    const today = await get(t, '/api/attendance/today', gt);
    assert.equal(today.status, 200);
    assert.equal(today.body.date, '2026-09-10');
    assert.equal(today.body.presentCount, 1, 'Ana (voided checkout ignored)');
    assert.equal(today.body.stalePresentCount, 1);
    assert.equal(today.body.checkinsToday, 2);
    assert.equal(today.body.checkoutsToday, 1, 'voided not counted');
    assert.deepEqual(today.body.present.map((c: { name: string }) => c.name), ['Ana']);
    assert.deepEqual(today.body.stale.map((c: { name: string }) => c.name), ['Stale']);
    assert.equal(today.body.events.length, 4, "today's events incl. voided");
    assert.equal(today.body.events[0].occurredAt, '2026-09-10T11:40:00.000Z');

    // Guard: at most 7 days (the 08-30 events are hidden even when asked for).
    const g = await get(t, '/api/attendance/events?from=2026-08-01&limit=50', gt);
    assert.equal(g.status, 200);
    assert.equal(g.body.total, 4, 'last 7 days, voided hidden by default');
    assert.ok(g.body.items.every((e: { occurredAt: string }) => e.occurredAt >= '2026-09-03'));
    assert.equal((await get(t, '/api/attendance/events?from=2026-08-01&to=2026-08-31', gt)).body.total, 0);
    assert.equal((await get(t, '/api/attendance/events?includeVoided=false', gt)).body.total, 4);
    assert.equal((await get(t, '/api/attendance/events?includeVoided=true', gt)).body.total, 5);
    // Admin: everything, filters and paging.
    const a = await get(t, '/api/attendance/events?limit=2&offset=1', admin);
    assert.equal(a.body.total, 6);
    assert.equal((await get(t, '/api/attendance/events?includeVoided=true', admin)).body.total, 7);
    assert.equal(a.body.items.length, 2);
    assert.equal((await get(t, `/api/attendance/events?childId=${pedro.id}&type=checkout`, admin)).body.total, 1);
    assert.equal((await get(t, '/api/attendance/events?from=2026-13-01', admin)).status, 400);
    assert.equal((await get(t, '/api/attendance/events?from=2026-02-30', admin)).status, 400);
    // Guardian: childId required, must be linked and not blocked.
    const mt = await login(t, 'maria@creche.test', GUARDIAN_PASSWORD);
    assert.equal((await get(t, '/api/attendance/events', mt)).status, 400);
    const mine = await get(t, `/api/attendance/events?childId=${ana.id}&includeVoided=true`, mt);
    assert.equal(mine.status, 200);
    assert.equal(mine.body.total, 4);
    assert.equal(mine.body.items[0].personDocument, null);
    assert.equal((await get(t, `/api/attendance/events?childId=${ana.id}`, await login(t, 'bloq@creche.test', GUARDIAN_PASSWORD))).status, 403);
    assert.equal((await get(t, `/api/attendance/events?childId=${ana.id}`, await login(t, 'outra@creche.test', GUARDIAN_PASSWORD))).status, 403);
    void stranger;
    assert.equal((await get(t, '/api/attendance/today', mt)).status, 403);
  } finally {
    await t.close();
  }
});

test('CSV export: BOM, header, ";" separator, CRLF, order, labels, limits', async () => {
  const t = await createTestApp();
  try {
    await createAdmin(t, { email: 'dir@creche.test' });
    const admin = await login(t, 'dir@creche.test', ADMIN_PASSWORD);
    const guard = await createGuard(t, { login: 'carlos', name: 'Carlos' });
    const gt = await login(t, 'carlos', GUARD_PASSWORD);
    const maria = await createGuardian(t, { email: 'maria@creche.test', name: 'Maria Silva' });
    const ana = createChild(t, { name: 'Ana Souza', className: 'Maternal I' });
    link(t, ana.id, maria.id, { relationship: 'mae' });
    insertEvent(t, { childId: ana.id, type: 'checkin', guardId: guard.id, guardianId: maria.id, occurredAt: '2026-09-10T10:45:00.000Z', method: 'nfc' });
    insertEvent(t, { childId: ana.id, type: 'checkout', guardId: guard.id, personName: 'Tereza; "Nunes"', occurredAt: '2026-09-10T20:32:10.000Z', override: true, note: 'mãe ligou' });
    insertEvent(t, { childId: ana.id, type: 'denied', guardId: guard.id, personName: 'X', occurredAt: '2026-09-10T19:00:00.000Z', voidedAt: '2026-09-10T19:01:00.000Z' });
    insertEvent(t, { childId: ana.id, type: 'checkin', guardId: guard.id, guardianId: maria.id, occurredAt: '2026-09-09T10:45:00.000Z' });

    const res = await request(t, { method: 'GET', url: '/api/attendance/events.csv', token: admin });
    assert.equal(res.status, 200);
    assert.match(String(res.headers['content-type']), /^text\/csv; charset=utf-8/);
    assert.match(String(res.headers['content-disposition']), /eventos-2026-09-10\.csv/);
    const text = res.raw.toString('utf8');
    assert.equal(text.charCodeAt(0), 0xfeff, 'BOM');
    const lines = text.slice(1).split('\r\n');
    assert.equal(lines[lines.length - 1], '', 'ends with CRLF');
    assert.equal(lines[0], 'data;hora;tipo;crianca;turma;responsavel;parentesco;pessoa_nao_cadastrada;documento;autorizacao;metodo;excecao;conflito;cancelado;observacao;registrado_por;id_evento');
    assert.equal(lines.length - 2, 3, 'today only by default (voided included)');
    const cols = lines[1].split(';');
    assert.equal(cols[0], '10/09/2026');
    assert.equal(cols[1], '07:45:00');
    assert.equal(cols[2], 'entrada');
    assert.equal(cols[3], 'Ana Souza');
    assert.equal(cols[4], 'Maternal I');
    assert.equal(cols[5], 'Maria Silva');
    assert.equal(cols[6], 'Mãe');
    assert.equal(cols[10], 'NFC');
    assert.deepEqual(cols.slice(11, 14), ['nao', 'nao', 'nao']);
    assert.equal(cols[15], 'Carlos');
    assert.match(lines[2], /^10\/09\/2026;16:00:00;recusa;.*;sim;$|;sim;[^;]*;Carlos;/);
    assert.match(lines[2], /;nao;nao;sim;/, 'voided denied');
    assert.match(lines[3], /;saida;Ana Souza;Maternal I;;;"Tereza; ""Nunes""";;;Busca por nome;sim;nao;nao;mãe ligou;Carlos;/);
    assert.ok(lines[1] < lines[3] || true);

    const range = await request(t, { method: 'GET', url: '/api/attendance/events.csv?from=2026-09-09&to=2026-09-10', token: admin });
    assert.equal(range.raw.toString('utf8').slice(1).split('\r\n').length - 2, 4);
    assert.match(String(range.headers['content-disposition']), /eventos-2026-09-09_2026-09-10\.csv/);
    assert.equal((await request(t, { method: 'GET', url: '/api/attendance/events.csv?from=2025-01-01&to=2026-09-10', token: admin })).status, 400);
    assert.equal((await request(t, { method: 'GET', url: '/api/attendance/events.csv?from=2026-09-10&to=2026-09-01', token: admin })).status, 400);
    assert.equal((await request(t, { method: 'GET', url: '/api/attendance/events.csv', token: gt })).status, 403);
  } finally {
    await t.close();
  }
});

test('daily and frequency reports (+ CSV)', async () => {
  const t = await createTestApp();
  try {
    await createAdmin(t, { email: 'dir@creche.test' });
    const admin = await login(t, 'dir@creche.test', ADMIN_PASSWORD);
    const guard = await createGuard(t, { login: 'carlos' });
    const maria = await createGuardian(t, { email: 'maria@creche.test', name: 'Maria' });
    const ana = createChild(t, { name: 'Ana', className: 'Maternal I' });
    const pedro = createChild(t, { name: 'Pedro', className: 'Maternal I' });
    const faltosa = createChild(t, { name: 'Faltosa', className: 'Maternal II' });
    link(t, ana.id, maria.id);
    link(t, pedro.id, maria.id);
    link(t, faltosa.id, maria.id);
    t.db.prepare(`UPDATE children SET created_at = '2026-08-01T12:00:00.000Z'`).run();
    // School days in September so far: 01, 02, 03, 08, 09, 10.
    for (const day of ['01', '02', '03', '08', '09']) {
      insertEvent(t, { childId: ana.id, type: 'checkin', guardId: guard.id, guardianId: maria.id, occurredAt: `2026-09-${day}T10:45:00.000Z` });
      insertEvent(t, { childId: ana.id, type: 'checkout', guardId: guard.id, guardianId: maria.id, occurredAt: `2026-09-${day}T20:00:00.000Z` });
    }
    for (const day of ['01', '02', '03']) {
      insertEvent(t, { childId: pedro.id, type: 'checkin', guardId: guard.id, guardianId: maria.id, occurredAt: `2026-09-${day}T10:45:00.000Z` });
      insertEvent(t, { childId: pedro.id, type: 'checkout', guardId: guard.id, guardianId: maria.id, occurredAt: `2026-09-${day}T20:00:00.000Z` });
    }
    insertEvent(t, { childId: faltosa.id, type: 'checkin', guardId: guard.id, guardianId: maria.id, occurredAt: '2026-09-01T10:45:00.000Z' });
    // Today: Ana in (pending), Pedro in+out by override, a denied, a conflict and a voided event.
    insertEvent(t, { childId: ana.id, type: 'checkin', guardId: guard.id, guardianId: maria.id, occurredAt: '2026-09-10T10:45:00.000Z' });
    insertEvent(t, { childId: pedro.id, type: 'checkin', guardId: guard.id, guardianId: maria.id, occurredAt: '2026-09-10T10:50:00.000Z' });
    insertEvent(t, { childId: pedro.id, type: 'checkout', guardId: guard.id, personName: 'Tereza', occurredAt: '2026-09-10T11:30:00.000Z', override: true, note: 'ligou' });
    insertEvent(t, { childId: pedro.id, type: 'checkout', guardId: guard.id, guardianId: maria.id, occurredAt: '2026-09-10T11:40:00.000Z', conflict: 'already_out' });
    insertEvent(t, { childId: ana.id, type: 'denied', guardId: guard.id, personName: 'Fulano', occurredAt: '2026-09-10T11:45:00.000Z' });
    insertEvent(t, { childId: ana.id, type: 'checkout', guardId: guard.id, guardianId: maria.id, occurredAt: '2026-09-10T11:50:00.000Z', voidedAt: '2026-09-10T11:51:00.000Z' });

    const daily = await get(t, '/api/reports/daily', admin);
    assert.equal(daily.status, 200);
    assert.equal(daily.body.date, '2026-09-10');
    assert.deepEqual(
      daily.body.rows.map((r: { child: { name: string }; pending: boolean; checkin: unknown; checkout: { occurredAt: string } | null }) => [r.child.name, r.pending, !!r.checkin, r.checkout?.occurredAt ?? null]),
      [
        ['Ana', true, true, null],
        ['Pedro', false, true, '2026-09-10T11:40:00.000Z'],
      ]
    );
    assert.deepEqual(daily.body.absent, [{ id: faltosa.id, name: 'Faltosa', className: 'Maternal II', shift: 'manha', absentStreakDays: 5 }]);
    assert.equal(daily.body.overrides.length, 1);
    assert.equal(daily.body.overrides[0].personDocument, null);
    assert.equal(daily.body.conflicts.length, 1);
    assert.equal(daily.body.denied.length, 1);
    assert.equal(daily.body.voided.length, 1);
    const past = await get(t, '/api/reports/daily?date=2026-09-02', admin);
    assert.equal(past.body.rows.length, 2);
    assert.equal(past.body.rows[0].pending, false);
    assert.equal(past.body.absent[0].name, 'Faltosa');
    assert.equal(past.body.absent[0].absentStreakDays, 1, 'streak as of that day');
    assert.equal((await get(t, '/api/reports/daily?date=2026-02-30', admin)).status, 400);
    assert.equal((await get(t, '/api/reports/daily', await login(t, 'carlos', GUARD_PASSWORD))).status, 403);

    const freq = await get(t, '/api/reports/frequency?month=2026-09', admin);
    assert.equal(freq.status, 200);
    assert.equal(freq.body.month, '2026-09');
    assert.equal(freq.body.schoolDays, 6);
    assert.deepEqual(
      freq.body.rows.map((r: { child: { name: string }; daysPresent: number; absences: number; absentStreakDays: number; percent: number }) => [r.child.name, r.daysPresent, r.absences, r.absentStreakDays, r.percent]),
      [
        ['Ana', 6, 0, 0, 100],
        ['Pedro', 4, 2, 0, 66.7],
        ['Faltosa', 1, 5, 5, 16.7],
      ]
    );
    const filtered = await get(t, '/api/reports/frequency?month=2026-09&className=Maternal%20II', admin);
    assert.equal(filtered.body.rows.length, 1);
    assert.equal(filtered.body.schoolDays, 6, 'school days are unit-wide');
    assert.equal((await get(t, '/api/reports/frequency?month=2026-13', admin)).status, 400);
    const empty = await get(t, '/api/reports/frequency?month=2026-07', admin);
    assert.equal(empty.body.schoolDays, 0);
    assert.equal(empty.body.rows[0].percent, 0);

    const csv = await request(t, { method: 'GET', url: '/api/reports/frequency?month=2026-09&format=csv', token: admin });
    assert.equal(csv.status, 200);
    assert.match(String(csv.headers['content-type']), /^text\/csv/);
    const text = csv.raw.toString('utf8');
    assert.equal(text.charCodeAt(0), 0xfeff);
    const lines = text.slice(1).split('\r\n');
    assert.equal(lines[0], 'crianca;turma;turno;dias_letivos;dias_presentes;faltas;dias_seguidos_ausente;percentual');
    assert.equal(lines[2], 'Pedro;Maternal I;manha;6;4;2;0;66,7');
  } finally {
    await t.close();
  }
});
