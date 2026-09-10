import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { ADMIN_PASSWORD, GUARDIAN_PASSWORD, createAdmin, createChild, createGuard, createGuardian, createTestApp, get, insertEvent, link, login, multipart, patch, post, request } from './helpers.js';

const csvUpload = async (t: Awaited<ReturnType<typeof createTestApp>>, token: string, csv: string | Buffer, dryRun: boolean) => {
  const form = multipart([{ name: 'file', data: csv, filename: 'planilha.csv', contentType: 'text/csv' }]);
  return request(t, { method: 'POST', url: `/api/admin/import?dryRun=${dryRun}`, payload: form.payload, headers: form.headers, token });
};

test('GET /admin/stats: shape and counts', async () => {
  const t = await createTestApp();
  try {
    await createAdmin(t, { email: 'dir@creche.test' });
    const admin = await login(t, 'dir@creche.test', ADMIN_PASSWORD);
    const guard = await createGuard(t);
    const maria = await createGuardian(t, { email: 'maria@creche.test' });
    const noContact = await createGuardian(t, { email: null, password: null, name: 'Só Portaria' });
    const ana = createChild(t, { name: 'Ana' });
    const pedro = createChild(t, { name: 'Pedro', consentAt: null });
    const stale = createChild(t, { name: 'Stale' });
    const orphan = createChild(t, { name: 'Órfã' });
    link(t, ana.id, maria.id);
    link(t, pedro.id, maria.id);
    link(t, stale.id, maria.id);
    link(t, orphan.id, noContact.id);
    // Today (2026-09-10, SP): Ana in and out, Pedro in; Stale in since yesterday.
    insertEvent(t, { childId: ana.id, type: 'checkin', guardId: guard.id, guardianId: maria.id, occurredAt: '2026-09-10T10:45:00.000Z' });
    insertEvent(t, { childId: ana.id, type: 'checkout', guardId: guard.id, guardianId: maria.id, occurredAt: '2026-09-10T11:30:00.000Z', override: true, note: 'pessoa fora da lista' });
    insertEvent(t, { childId: pedro.id, type: 'checkin', guardId: guard.id, guardianId: maria.id, occurredAt: '2026-09-10T11:00:00.000Z' });
    insertEvent(t, { childId: stale.id, type: 'checkin', guardId: guard.id, guardianId: maria.id, occurredAt: '2026-09-09T11:00:00.000Z' });
    insertEvent(t, { childId: ana.id, type: 'denied', guardId: guard.id, personName: 'Fulano', occurredAt: '2026-09-08T11:00:00.000Z' });
    // School days without Órfã: 09-01..09-05 (Ana attended), 09-09 (Stale) and 09-10 → streak 7 (the denied event on 09-08 is not a school day).
    for (const day of ['01', '02', '03', '04', '05']) {
      insertEvent(t, { childId: ana.id, type: 'checkin', guardId: guard.id, guardianId: maria.id, occurredAt: `2026-09-${day}T11:00:00.000Z` });
    }
    t.db.prepare(`UPDATE children SET created_at = '2026-08-01T12:00:00.000Z'`).run();
    t.db
      .prepare(
        `INSERT INTO notifications (id, user_id, kind, batch_id, event_id, child_ids, channel, status, title, body, override, payload_json, error, attempts, dispatch_after, read_at, sent_at, created_at)
         VALUES ('n1', ?, 'checkout', 'b1', NULL, '[]', 'email', 'sent', 't', 'b', 0, NULL, NULL, 1, ?, NULL, ?, ?),
                ('n2', ?, 'checkout', 'b1', NULL, '[]', 'push', 'failed', 't', 'b', 0, NULL, 'boom', 3, ?, NULL, NULL, ?),
                ('n3', ?, 'checkin', 'b2', NULL, '[]', 'email', 'skipped', 't', 'b', 0, NULL, 'quota', 0, ?, NULL, NULL, ?)`
      )
      .run(maria.id, '2026-09-10T11:31:00.000Z', '2026-09-10T11:31:05.000Z', '2026-09-10T11:31:00.000Z', maria.id, '2026-09-10T11:31:00.000Z', '2026-09-10T11:31:00.000Z', maria.id, '2026-09-10T11:31:00.000Z', '2026-09-10T11:31:00.000Z');
    t.db
      .prepare(`INSERT INTO gate_heartbeats (session_id, user_id, queued_count, oldest_queued_at, app_version, at) VALUES ('s1', ?, 3, '2026-09-10T11:00:00.000Z', 'dev', '2026-09-10T11:50:00.000Z')`)
      .run(guard.id);

    const res = await get(t, '/api/admin/stats', admin);
    assert.equal(res.status, 200);
    const s = res.body;
    assert.equal(s.presentNow, 1, 'Pedro');
    assert.equal(s.stalePresentCount, 1, 'Stale');
    assert.equal(s.checkinsToday, 2);
    assert.equal(s.checkoutsToday, 1);
    assert.equal(s.childrenActive, 4);
    assert.equal(s.guardiansActive, 2);
    assert.equal(s.guardiansWithoutAccess, 1);
    assert.equal(s.childrenWithoutReachableGuardian, 1, 'Órfã only has a no-contact guardian');
    assert.equal(s.childrenWithoutConsent, 1);
    assert.deepEqual(s.childrenAbsent5Days.map((c: { name: string; absentStreakDays: number }) => [c.name, c.absentStreakDays]), [['Órfã', 7]]);
    assert.equal(s.staleChildren.length, 1);
    assert.equal(s.staleChildren[0].name, 'Stale');
    assert.equal(s.staleChildren[0].status.stale, true);
    assert.equal(s.recentOverrides.length, 1);
    assert.equal(s.recentConflicts.length, 0);
    assert.equal(s.recentDenied.length, 1);
    assert.deepEqual(s.notifications, { failedLast24h: 1, skippedLast24h: 1, emailsToday: 1, emailDailyLimit: 450, emailEnabled: true, pushEnabled: true });
    assert.equal(s.gate.length, 1);
    assert.equal(s.gate[0].queuedCount, 3);
    assert.equal(s.gate[0].guardName, guard.name);
    assert.equal(s.lastBackupAt, null);
    assert.equal(s.demoData, false);

    const gate = await get(t, '/api/admin/gate-status', admin);
    assert.deepEqual(gate.body, s.gate);
    const notif = await get(t, '/api/admin/notifications?status=failed', admin);
    assert.equal(notif.body.length, 1);
    assert.equal(notif.body[0].error, 'boom');
    assert.equal(notif.body[0].userName, maria.name);
    assert.equal((await get(t, '/api/admin/notifications', admin)).body.length, 3);
    assert.equal((await get(t, '/api/admin/notifications?status=weird', admin)).status, 400);

    const guardian = await login(t, 'maria@creche.test', GUARDIAN_PASSWORD);
    assert.equal((await get(t, '/api/admin/stats', guardian)).status, 403);
  } finally {
    await t.close();
  }
});

test('settings, test e-mail, audit paging', async () => {
  const t = await createTestApp();
  try {
    await createAdmin(t, { email: 'dir@creche.test' });
    const admin = await login(t, 'dir@creche.test', ADMIN_PASSWORD);
    const before = await get(t, '/api/admin/settings', admin);
    assert.deepEqual(before.body, { daycareName: 'Creche Teste', daycarePhone: '(11) 4002-8922', contactEmail: 'contato@creche.test' });
    t.clock.advance(1000);
    const updated = await patch(t, '/api/admin/settings', { daycareName: 'Creche Nova', daycarePhone: null }, admin);
    assert.deepEqual(updated.body, { daycareName: 'Creche Nova', daycarePhone: null, contactEmail: 'contato@creche.test' });
    assert.equal((await get(t, '/api/config')).body.daycareName, 'Creche Nova');
    assert.equal((await patch(t, '/api/admin/settings', { contactEmail: 'não é e-mail' }, admin)).status, 400);

    t.clock.advance(1000);
    assert.equal((await post(t, '/api/admin/test-email', undefined, admin)).status, 204);
    assert.equal(t.mailer.outbox[0].to, 'dir@creche.test');
    assert.match(t.mailer.outbox[0].subject, /^\[Creche Nova\] Teste de e-mail/);
    t.mailer.failWith = new Error('SMTP down');
    const failed = await post(t, '/api/admin/test-email', undefined, admin);
    assert.equal(failed.status, 503);
    assert.equal(failed.body.error.code, 'EMAIL_DISABLED');

    const page1 = await get(t, '/api/admin/audit?limit=2', admin);
    assert.equal(page1.body.items.length, 2);
    assert.ok(page1.body.nextBefore);
    const page2 = await get(t, `/api/admin/audit?limit=2&before=${encodeURIComponent(page1.body.nextBefore)}`, admin);
    assert.ok(page2.body.items.every((i: { at: string }) => i.at < page1.body.nextBefore));
    assert.ok(page1.body.items.some((i: { action: string }) => i.action === 'settings.update'));
  } finally {
    await t.close();
  }
});

test('e-mail disabled: test-email → 503, invites are not sent, config says so', async () => {
  const t = await createTestApp({ emailEnabled: false });
  try {
    await createAdmin(t, { email: 'dir@creche.test' });
    const admin = await login(t, 'dir@creche.test', ADMIN_PASSWORD);
    assert.equal((await get(t, '/api/config')).body.emailEnabled, false);
    assert.equal((await post(t, '/api/admin/test-email', undefined, admin)).status, 503);
    const created = await post(t, '/api/users', { name: 'Maria', email: 'maria@creche.test', role: 'guardian' }, admin);
    assert.equal(created.body.invite.sent, false);
    assert.ok(created.body.invite.inviteUrl);
  } finally {
    await t.close();
  }
});

test('import: template, header validation, dryRun then commit, re-import skips, matching rules', async () => {
  const t = await createTestApp();
  try {
    await createAdmin(t, { email: 'dir@creche.test' });
    const admin = await login(t, 'dir@creche.test', ADMIN_PASSWORD);
    const existing = await createGuardian(t, { email: 'carla@exemplo.com.br', name: 'Carla Lima' });

    const template = await get(t, '/api/admin/import/template.csv', admin);
    assert.equal(template.status, 200);
    assert.match(String(template.headers['content-type']), /text\/csv/);
    assert.ok(template.raw.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), 'BOM');
    assert.ok(String(template.body).includes('crianca;nascimento;turma;turno;resp_nome;resp_parentesco;resp_email;resp_telefone;pode_retirar;principal'));

    const badHeader = await csvUpload(t, admin, 'nome;data\r\nAna;2020-01-01\r\n', true);
    assert.equal(badHeader.status, 400);
    assert.equal(badHeader.body.error.code, 'VALIDATION');

    const csv =
      '\uFEFFcrianca;nascimento;turma;turno;resp_nome;resp_parentesco;resp_email;resp_telefone;pode_retirar;principal\r\n' +
      'Ana Souza;2022-03-15;Maternal I;manha;Maria Souza;Mãe;maria@exemplo.com.br;(11) 91234-5678;sim;sim\r\n' +
      'Ana Souza;2022-03-15;Maternal I;manha;José Souza;pai;;(11) 99876-5432;nao;\r\n' +
      'Pedro Lima;15/08/2021;Maternal II;Integral;Carla Lima;mae;CARLA@exemplo.com.br;;sim;sim\r\n' +
      '"Lima, João";2021-01-01;;;Maria Souza;avó;maria@exemplo.com.br;;sim;nao\r\n' +
      'Sem Parentesco;2021-01-01;;;Alguém;;;;;\r\n' +
      'Data Ruim;31/02/2021;;;;;;;;\r\n' +
      'Só Criança;2020-05-05;Maternal I;tarde;;;;;;\r\n';

    const dry = await csvUpload(t, admin, csv, true);
    assert.equal(dry.status, 200, JSON.stringify(dry.body));
    assert.equal(dry.body.dryRun, true);
    assert.deepEqual(
      dry.body.rows.map((r: { line: number; action: string; errors: string[] }) => [r.line, r.action, r.errors.length]),
      [
        [2, 'create_child', 0],
        [3, 'create_guardian', 0],
        [4, 'create_child', 0],
        [5, 'create_child', 0],
        [6, 'skip', 1],
        [7, 'skip', 1],
        [8, 'create_child', 0],
      ]
    );
    assert.deepEqual(dry.body.summary, { childrenCreated: 4, guardiansCreated: 2, linksCreated: 4, skipped: 2, errors: 2 });
    assert.equal((await get(t, '/api/children', admin)).body.length, 0, 'dry run writes nothing');
    assert.equal(t.mailer.outbox.length, 0);

    const commit = await csvUpload(t, admin, csv, false);
    assert.equal(commit.status, 200);
    assert.equal(commit.body.dryRun, false);
    assert.deepEqual(commit.body.summary, dry.body.summary);
    const children = await get(t, '/api/children', admin);
    assert.equal(children.body.length, 4);
    const ana = children.body.find((c: { name: string }) => c.name === 'Ana Souza');
    assert.equal(ana.birthDate, '2022-03-15');
    assert.equal(ana.shift, 'manha');
    assert.equal(ana.guardians.length, 2);
    const mariaLink = ana.guardians.find((g: { name: string }) => g.name === 'Maria Souza');
    assert.equal(mariaLink.relationship, 'mae');
    assert.equal(mariaLink.isPrimary, true);
    assert.equal(mariaLink.email, 'maria@exemplo.com.br');
    assert.equal(mariaLink.hasAccess, false);
    const joseLink = ana.guardians.find((g: { name: string }) => g.name === 'José Souza');
    assert.equal(joseLink.canPickup, false);
    const pedro = children.body.find((c: { name: string }) => c.name === 'Pedro Lima');
    assert.equal(pedro.birthDate, '2021-08-15');
    assert.equal(pedro.shift, 'integral');
    assert.equal(pedro.guardians[0].id, existing.id, 'matched the existing guardian by e-mail');
    const joao = children.body.find((c: { name: string }) => c.name === 'Lima, João');
    assert.equal(joao.guardians[0].name, 'Maria Souza');
    assert.equal(joao.guardians[0].relationship, 'avo');
    assert.equal(joao.guardians[0].id, mariaLink.id, 'same guardian reused within the file');
    assert.equal(t.mailer.outbox.length, 0, 'import never sends invites');
    assert.equal((await get(t, '/api/users?role=guardian', admin)).body.length, 3);

    const again = await csvUpload(t, admin, csv, false);
    assert.deepEqual(again.body.summary, { childrenCreated: 0, guardiansCreated: 0, linksCreated: 0, skipped: 7, errors: 7 });
    assert.equal((await get(t, '/api/children', admin)).body.length, 4);

    const audit = await get(t, '/api/admin/audit', admin);
    assert.equal(audit.body.items.filter((a: { action: string }) => a.action === 'import.commit').length, 2);
  } finally {
    await t.close();
  }
});

test('backup: POST creates a snapshot and sets lastBackupAt; GET streams a tar.gz with the snapshot and uploads', async () => {
  const t = await createTestApp();
  try {
    await createAdmin(t, { email: 'dir@creche.test' });
    const admin = await login(t, 'dir@creche.test', ADMIN_PASSWORD);
    const res = await post(t, '/api/admin/backup', undefined, admin);
    assert.equal(res.status, 200);
    assert.equal(res.body.lastBackupAt, t.clock.now().toISOString());
    const dir = path.join(t.config.dataDir, 'backups');
    const files = fs.readdirSync(dir);
    assert.equal(files.length, 1);
    assert.match(files[0], /^creche-2026-09-10-0900\.sqlite$/, 'named with the daycare local time');
    assert.equal(fs.readFileSync(path.join(dir, files[0])).subarray(0, 15).toString('latin1'), 'SQLite format 3');
    assert.equal((await get(t, '/api/admin/stats', admin)).body.lastBackupAt, res.body.lastBackupAt);

    // Rotation: an old snapshot disappears on the next run.
    const old = path.join(dir, 'creche-2026-01-01-0200.sqlite');
    fs.writeFileSync(old, 'x');
    const past = new Date(t.clock.now().getTime() - 20 * 86_400_000);
    fs.utimesSync(old, past, past);
    t.clock.advance(60_000);
    await post(t, '/api/admin/backup', undefined, admin);
    assert.equal(fs.existsSync(old), false);
    assert.equal(fs.readdirSync(dir).length, 2);

    fs.mkdirSync(path.join(t.config.dataDir, 'uploads'), { recursive: true });
    fs.writeFileSync(path.join(t.config.dataDir, 'uploads', 'x.jpg'), 'jpg');
    const archive = await get(t, '/api/admin/backup', admin);
    assert.equal(archive.status, 200);
    assert.equal(archive.headers['content-type'], 'application/gzip');
    assert.match(String(archive.headers['content-disposition']), /attachment; filename="creche-backup-.*\.tar\.gz"/);
    const tar = gunzipSync(archive.raw).toString('latin1');
    assert.ok(tar.includes('backups/creche-2026-09-10-0901'));
    assert.ok(tar.includes('uploads/x.jpg'));
  } finally {
    await t.close();
  }
});
