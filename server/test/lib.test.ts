import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/index.js';
import { constantTimeEqual, hashPassword, hmacSignature, randomCode, randomToken, verifyPassword } from '../src/lib/crypto.js';
import { LIMITS, assertNotLimited, checkLimit, pruneAttempts, recordFailure } from '../src/lib/ratelimit.js';
import { dayEndIso, dayRange, dayStartIso, isValidCivilDate, minusMonthsIso, zonedParts } from '../src/lib/time.js';
import { parseCsv, toCsv } from '../src/services/csv.js';
import { snapshotName } from '../src/services/backup.js';
import { deriveStatus } from '../src/services/status.js';
import { detectImage } from '../src/lib/photos.js';
import { loadConfig } from '../src/config.js';
import { ensureInitialAdmin, seedSettings, StartupError } from '../src/bootstrap.js';

const TZ = 'America/Sao_Paulo';

test('time: civil day ranges in the daycare zone (UTC-3)', () => {
  assert.equal(dayStartIso('2026-09-10', TZ), '2026-09-10T03:00:00.000Z');
  assert.equal(dayEndIso('2026-09-10', TZ), '2026-09-11T02:59:59.000Z');
  assert.deepEqual(dayRange('2026-09-10', '2026-09-11', TZ), ['2026-09-10T03:00:00.000Z', '2026-09-12T03:00:00.000Z']);
  assert.deepEqual(zonedParts(new Date('2026-09-10T02:30:00.000Z'), TZ), { year: 2026, month: 9, day: 9, hour: 23, minute: 30, second: 0 });
  // A zone with DST: Europe/Lisbon on a transition day still yields consistent boundaries.
  assert.equal(dayStartIso('2026-03-29', 'Europe/Lisbon'), '2026-03-29T00:00:00.000Z');
  assert.equal(dayStartIso('2026-03-30', 'Europe/Lisbon'), '2026-03-29T23:00:00.000Z');
  assert.equal(isValidCivilDate('2024-02-29'), true);
  assert.equal(isValidCivilDate('2023-02-29'), false);
  assert.equal(isValidCivilDate('2023-13-01'), false);
  assert.equal(minusMonthsIso(new Date('2026-09-10T12:00:00.000Z'), 24), '2024-09-10T12:00:00.000Z');
  assert.equal(snapshotName(new Date('2026-09-10T12:34:00.000Z'), TZ), 'creche-2026-09-10-0934.sqlite');
});

test('crypto: scrypt round trip, tokens, signatures', async () => {
  const hash = await hashPassword('senha-secreta');
  assert.match(hash, /^scrypt\$16384\$8\$1\$/);
  assert.equal(await verifyPassword('senha-secreta', hash), true);
  assert.equal(await verifyPassword('senha-errada', hash), false);
  assert.equal(await verifyPassword('qualquer', null), false);
  assert.equal(await verifyPassword('qualquer', 'lixo'), false);
  const token = randomToken();
  assert.equal(token.length, 43);
  assert.match(token, /^[A-Za-z0-9_-]+$/);
  assert.equal(hmacSignature('s', 'id').length, 32);
  assert.equal(hmacSignature('s', 'id'), hmacSignature('s', 'id'));
  assert.notEqual(hmacSignature('s', 'id'), hmacSignature('s2', 'id'));
  assert.equal(constantTimeEqual('abc', 'abc'), true);
  assert.equal(constantTimeEqual('abc', 'abd'), false);
  assert.equal(constantTimeEqual('abc', 'ab'), false);
  const code = randomCode('AB', 8);
  assert.match(code, /^[AB]{8}$/);
});

test('ratelimit: failures within the window, retryAfter, prune', () => {
  const db = openDb(':memory:');
  const now = new Date('2026-09-10T12:00:00.000Z');
  const key = 'id:x@y';
  assert.equal(checkLimit(db, key, LIMITS.loginIdentifier, now).limited, false);
  for (let i = 0; i < 5; i++) recordFailure(db, key, new Date(now.getTime() + i * 1000));
  const check = checkLimit(db, key, LIMITS.loginIdentifier, new Date(now.getTime() + 10_000));
  assert.equal(check.limited, true);
  assert.equal(check.retryAfterSeconds, 15 * 60 - 10);
  assert.throws(() => assertNotLimited(db, key, LIMITS.loginIdentifier, now), (e: { code: string }) => e.code === 'RATE_LIMITED');
  assert.equal(checkLimit(db, key, LIMITS.loginIdentifier, new Date(now.getTime() + 16 * 60_000)).limited, false);
  assert.equal(pruneAttempts(db, new Date(now.getTime() + 25 * 3_600_000)), 5);
  db.close();
});

test('csv: BOM, quotes, CRLF, trailing empty lines; toCsv escapes', () => {
  const rows = parseCsv('﻿a;b;c\r\n1;"x;y";"He said ""hi"""\r\n\r\n2;;\n');
  assert.deepEqual(rows, [
    ['a', 'b', 'c'],
    ['1', 'x;y', 'He said "hi"'],
    ['2', '', ''],
  ]);
  const out = toCsv([['a', 'b;c'], ['x"y', null]]);
  assert.equal(out, '﻿a;"b;c"\r\n"x""y";\r\n');
});

test('status derivation and image detection', () => {
  const base = {
    id: 'e1', client_id: null, batch_id: 'b', child_id: 'c', child_name: 'Ana', type: 'checkin' as const, guardian_id: null, guardian_name: null,
    guardian_relationship: null, person_name: 'X', person_document: '123', document_checked: 0, authorization_id: null, authorized_by_name: null,
    guard_id: 'g', guard_name: 'G', method: 'search' as const, credential_id: null, override: 0, conflict: null, queued: 0, directory_at: null, note: null,
    occurred_at: '2026-09-09T11:00:00.000Z', created_at: '2026-09-09T11:00:00.000Z', voided_at: null, voided_by: null, void_reason: null,
  };
  const now = new Date('2026-09-10T12:00:00.000Z');
  const stale = deriveStatus(base, { now, tz: TZ, admin: false });
  assert.equal(stale.present, true);
  assert.equal(stale.stale, true);
  assert.equal(stale.since, base.occurred_at);
  assert.equal(stale.lastEvent?.personDocument, null);
  assert.equal(deriveStatus(base, { now, tz: TZ, admin: true }).lastEvent?.personDocument, '123');
  const fresh = deriveStatus({ ...base, occurred_at: '2026-09-10T10:00:00.000Z' }, { now, tz: TZ, admin: false });
  assert.equal(fresh.stale, false);
  const out = deriveStatus({ ...base, type: 'checkout' }, { now, tz: TZ, admin: false });
  assert.deepEqual([out.present, out.since, out.stale], [false, null, false]);
  assert.deepEqual(deriveStatus(undefined, { now, tz: TZ, admin: false }), { present: false, since: null, lastEvent: null, stale: false });

  assert.equal(detectImage(Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0, 0]))?.mime, 'image/jpeg');
  assert.equal(detectImage(Buffer.from('RIFF....WEBPVP8 ', 'ascii'))?.mime, 'image/webp');
  assert.equal(detectImage(Buffer.from('<svg/>')), null);
});

test('config + bootstrap: defaults, refuses the example admin password, seeds settings once', async () => {
  const cfg = loadConfig({ TZ: '', SMTP_PORT: '', TRUST_PROXY: 'true' });
  assert.equal(cfg.tz, 'America/Sao_Paulo');
  assert.equal(cfg.smtp.port, 587);
  assert.equal(cfg.trustProxy, true);
  assert.equal(cfg.sessionTtlDays, 30);
  assert.throws(() => loadConfig({ TZ: 'Marte/Olympus' }), /fuso/);

  const db = openDb(':memory:');
  const config = loadConfig({ ADMIN_EMAIL: 'dir@x.test', ADMIN_PASSWORD: 'troque-esta-senha', DAYCARE_NAME: 'Primeira' });
  seedSettings(db, config);
  const version = db.prepare(`SELECT value FROM settings WHERE key = 'directory_version'`).get() as { value: string };
  assert.equal(version.value, '1');
  const vapid = db.prepare(`SELECT value FROM settings WHERE key = 'vapid_public_key'`).get() as { value: string };
  assert.ok(vapid.value.length > 40);
  seedSettings(db, loadConfig({ DAYCARE_NAME: 'Segunda' }));
  assert.equal((db.prepare(`SELECT value FROM settings WHERE key = 'daycare_name'`).get() as { value: string }).value, 'Primeira');

  await assert.rejects(ensureInitialAdmin(db, config), StartupError);
  await assert.rejects(ensureInitialAdmin(db, loadConfig({ ADMIN_EMAIL: 'dir@x.test', ADMIN_PASSWORD: 'curta' })), StartupError);
  const created = await ensureInitialAdmin(db, loadConfig({ ADMIN_EMAIL: 'dir@x.test', ADMIN_PASSWORD: 'senha-bem-comprida-1' }));
  assert.equal(created.created, true);
  const again = await ensureInitialAdmin(db, loadConfig({ ADMIN_EMAIL: 'dir@x.test', ADMIN_PASSWORD: 'troque-esta-senha' }));
  assert.equal(again.created, false, 'existing admin → the env password is irrelevant');
  db.close();
});
