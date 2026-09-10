import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeCode,
  formatCode,
  isValidCode,
  parseCardContent,
  normalizeUid,
  cardUrl,
  pickupAllowed,
  authorizationValid,
  civilDate,
  addDays,
  formatDate,
  formatTime,
  formatDateTime,
  joinNames,
  shortName,
  searchKey,
  suggestAction,
  whatsappDigits,
  CODE_ALPHABET,
  CreateEventsBody,
  ScanLookupBody,
  CreateUserBody,
  ERROR_CODES,
  ERROR_HTTP_STATUS,
} from '../src/index.js';

const U1 = '6f1c1e2e-8f7a-4d3b-9c2a-1b2c3d4e5f60';
const U2 = '6f1c1e2e-8f7a-4d3b-9c2a-1b2c3d4e5f61';
const U3 = '6f1c1e2e-8f7a-4d3b-9c2a-1b2c3d4e5f62';

test('normalizeCode strips separators and upper-cases', () => {
  assert.equal(normalizeCode('7k3p-2q9m'), '7K3P2Q9M');
  assert.equal(normalizeCode(' 7K3P 2Q9M '), '7K3P2Q9M');
});

test('formatCode adds the dash for 8-char codes only', () => {
  assert.equal(formatCode('7K3P2Q9M'), '7K3P-2Q9M');
  assert.equal(formatCode('7K3P2Q'), '7K3P2Q');
});

test('isValidCode rejects ambiguous characters and wrong lengths', () => {
  assert.equal(isValidCode('7K3P-2Q9M'), true);
  assert.equal(isValidCode('0K3P-2Q9M'), false);
  assert.equal(isValidCode('IK3P-2Q9M'), false);
  assert.equal(isValidCode('7K3P-2Q9'), false);
  for (const ch of '01ILO') assert.equal(CODE_ALPHABET.includes(ch), false);
});

test('parseCardContent handles URLs, bare codes, and garbage', () => {
  assert.equal(parseCardContent('https://creche.exemplo.com.br/c/7K3P2Q9M'), '7K3P2Q9M');
  assert.equal(parseCardContent('https://creche.exemplo.com.br/c/7K3P-2Q9M?x=1'), '7K3P2Q9M');
  assert.equal(parseCardContent('7k3p-2q9m'), '7K3P2Q9M');
  assert.equal(parseCardContent('hello world'), null);
  assert.equal(parseCardContent('https://example.com/other'), null);
  assert.equal(parseCardContent(''), null);
});

test('normalizeUid lower-cases hex and strips separators', () => {
  assert.equal(normalizeUid('04:A3:2B:1C:5D:6E:80'), '04a32b1c5d6e80');
});

test('cardUrl strips trailing slashes', () => {
  assert.equal(cardUrl('https://x.com/', '7k3p-2q9m'), 'https://x.com/c/7K3P2Q9M');
});

test('pickupAllowed respects canPickup, blocked, validFrom and validUntil', () => {
  assert.equal(pickupAllowed({ canPickup: true, validUntil: null }, '2026-09-10'), true);
  assert.equal(pickupAllowed({ canPickup: false, validUntil: null }, '2026-09-10'), false);
  assert.equal(pickupAllowed({ canPickup: true, blocked: true }, '2026-09-10'), false);
  assert.equal(pickupAllowed({ canPickup: true, validUntil: '2026-09-10' }, '2026-09-10'), true);
  assert.equal(pickupAllowed({ canPickup: true, validUntil: '2026-09-09' }, '2026-09-10'), false);
  assert.equal(pickupAllowed({ canPickup: true, validFrom: '2026-09-11' }, '2026-09-10'), false);
  assert.equal(pickupAllowed({ canPickup: true, validFrom: '2026-09-10', validUntil: '2026-09-12' }, '2026-09-10'), true);
});

test('authorizationValid checks window and revocation', () => {
  const a = { validFrom: '2026-09-10', validUntil: '2026-09-12', revokedAt: null };
  assert.equal(authorizationValid(a, '2026-09-09'), false);
  assert.equal(authorizationValid(a, '2026-09-10'), true);
  assert.equal(authorizationValid(a, '2026-09-12'), true);
  assert.equal(authorizationValid(a, '2026-09-13'), false);
  assert.equal(authorizationValid({ ...a, revokedAt: '2026-09-10T00:00:00.000Z' }, '2026-09-10'), false);
});

test('civilDate uses the daycare zone, not UTC', () => {
  // 2026-09-10T23:30Z is still 2026-09-10 in São Paulo (UTC-3) and already 2026-09-11 in UTC.
  assert.equal(civilDate('2026-09-10T23:30:00.000Z', 'America/Sao_Paulo'), '2026-09-10');
  assert.equal(civilDate('2026-09-10T23:30:00.000Z', 'UTC'), '2026-09-10');
  assert.equal(civilDate('2026-09-11T02:30:00.000Z', 'America/Sao_Paulo'), '2026-09-10');
  assert.equal(civilDate('2026-09-11T02:30:00.000Z', 'UTC'), '2026-09-11');
});

test('addDays handles month boundaries', () => {
  assert.equal(addDays('2026-09-30', 1), '2026-10-01');
  assert.equal(addDays('2026-01-01', -1), '2025-12-31');
});

test('formatters render pt-BR in the daycare zone', () => {
  const iso = '2026-09-10T20:32:05.000Z';
  assert.equal(formatDate(iso, 'America/Sao_Paulo'), '10/09/2026');
  assert.equal(formatTime(iso, 'America/Sao_Paulo'), '17:32');
  assert.equal(formatTime(iso, 'America/Sao_Paulo', true), '17:32:05');
  assert.equal(formatDateTime(iso, 'America/Sao_Paulo'), '10/09/2026 às 17:32');
});

test('joinNames, shortName, searchKey', () => {
  assert.equal(joinNames([]), '');
  assert.equal(joinNames(['Ana']), 'Ana');
  assert.equal(joinNames(['Ana', 'Pedro']), 'Ana e Pedro');
  assert.equal(joinNames(['Ana', 'Pedro', 'João']), 'Ana, Pedro e João');
  assert.equal(joinNames(['A', 'B', 'C', 'D', 'E']), 'A, B, C +2');
  assert.equal(shortName('Maria da Silva'), 'Maria S.');
  assert.equal(shortName('Ana'), 'Ana');
  assert.equal(searchKey('  João Ávila '), 'joao avila');
});

test('suggestAction follows the deterministic rule', () => {
  const st = (present: boolean, stale = false) => ({ present, since: null, lastEvent: null, stale });
  assert.deepEqual(suggestAction([{ id: 'a', status: st(false) }, { id: 'b', status: st(false) }]).action, 'checkin');
  assert.deepEqual(suggestAction([{ id: 'a', status: st(false) }]).selected, ['a']);
  assert.deepEqual(suggestAction([{ id: 'a', status: st(true) }, { id: 'b', status: st(true) }]).action, 'checkout');
  const mixed = suggestAction([{ id: 'a', status: st(true) }, { id: 'b', status: st(false) }]);
  assert.equal(mixed.action, 'mixed');
  assert.deepEqual(mixed.selected, []);
  // stale counts as out
  const stale = suggestAction([{ id: 'a', status: st(true, true) }]);
  assert.equal(stale.action, 'checkin');
});

test('whatsappDigits normalizes Brazilian numbers', () => {
  assert.equal(whatsappDigits('(11) 98765-4321'), '5511987654321');
  assert.equal(whatsappDigits('+55 11 98765-4321'), '5511987654321');
  assert.equal(whatsappDigits('011 98765-4321'), '5511987654321');
  assert.equal(whatsappDigits('1234'), null);
  assert.equal(whatsappDigits(null), null);
});

test('CreateEventsBody enforces guardian/person, override note and unregistered checkout rules', () => {
  const base = { type: 'checkout', method: 'nfc', events: [{ clientId: U1, childId: U2 }] };
  assert.equal(CreateEventsBody.safeParse(base).success, false);
  assert.equal(CreateEventsBody.safeParse({ ...base, guardianId: U3 }).success, true);
  // unregistered person on checkout needs override + note
  assert.equal(CreateEventsBody.safeParse({ ...base, personName: 'Ana' }).success, false);
  assert.equal(CreateEventsBody.safeParse({ ...base, personName: 'Ana', override: true }).success, false);
  assert.equal(CreateEventsBody.safeParse({ ...base, personName: 'Ana', override: true, note: 'mãe ligou autorizando' }).success, true);
  // unregistered person with an authorization does not need override
  assert.equal(CreateEventsBody.safeParse({ ...base, personName: 'Ana', authorizationId: U3 }).success, true);
  // checkin with unregistered person never needs override
  assert.equal(CreateEventsBody.safeParse({ ...base, type: 'checkin', personName: 'Ana' }).success, true);
  // duplicate clientIds rejected
  assert.equal(
    CreateEventsBody.safeParse({ ...base, guardianId: U3, events: [{ clientId: U1, childId: U2 }, { clientId: U1, childId: U3 }] }).success,
    false
  );
  assert.equal(CreateEventsBody.safeParse({ ...base, guardianId: U3, occurredAt: '2026-09-10T10:00:00-03:00', queued: true }).success, true);
});

test('CreateUserBody requires email or login for staff and forbids guardian passwords', () => {
  assert.equal(CreateUserBody.safeParse({ name: 'Carlos', role: 'guard' }).success, false);
  assert.equal(CreateUserBody.safeParse({ name: 'Carlos', role: 'guard', login: 'carlos', pin: '1234' }).success, true);
  assert.equal(CreateUserBody.safeParse({ name: 'Maria', role: 'guardian' }).success, true);
  assert.equal(CreateUserBody.safeParse({ name: 'Maria', role: 'guardian', password: 'senha-forte-1' }).success, false);
});

test('ScanLookupBody requires uid or code', () => {
  assert.equal(ScanLookupBody.safeParse({}).success, false);
  assert.equal(ScanLookupBody.safeParse({ code: '7K3P-2Q9M' }).success, true);
});

test('every error code has an HTTP status', () => {
  for (const c of ERROR_CODES) assert.ok(ERROR_HTTP_STATUS[c] >= 400);
});
