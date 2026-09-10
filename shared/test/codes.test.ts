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
  CODE_ALPHABET,
  CreateEventsBody,
  ScanLookupBody,
} from '../src/index.js';

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
  assert.equal(isValidCode('0K3P-2Q9M'), false); // 0 not in alphabet
  assert.equal(isValidCode('IK3P-2Q9M'), false); // I not in alphabet
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

test('pickupAllowed respects canPickup and validUntil', () => {
  assert.equal(pickupAllowed({ canPickup: true, validUntil: null }, '2026-09-10'), true);
  assert.equal(pickupAllowed({ canPickup: false, validUntil: null }, '2026-09-10'), false);
  assert.equal(pickupAllowed({ canPickup: true, validUntil: '2026-09-10' }, '2026-09-10'), true);
  assert.equal(pickupAllowed({ canPickup: true, validUntil: '2026-09-09' }, '2026-09-10'), false);
});

test('CreateEventsBody requires guardian or person and note on override', () => {
  const base = {
    clientId: '6f1c1e2e-8f7a-4d3b-9c2a-1b2c3d4e5f60',
    childIds: ['6f1c1e2e-8f7a-4d3b-9c2a-1b2c3d4e5f61'],
    type: 'checkout',
    method: 'nfc',
  };
  assert.equal(CreateEventsBody.safeParse(base).success, false);
  assert.equal(CreateEventsBody.safeParse({ ...base, guardianId: base.childIds[0] }).success, true);
  assert.equal(CreateEventsBody.safeParse({ ...base, personName: 'Ana', override: true }).success, false);
  assert.equal(CreateEventsBody.safeParse({ ...base, personName: 'Ana', override: true, note: 'mãe ligou' }).success, true);
  assert.equal(
    CreateEventsBody.safeParse({ ...base, guardianId: base.childIds[0], occurredAt: '2026-09-10T10:00:00-03:00' }).success,
    true
  );
});

test('ScanLookupBody requires uid or code', () => {
  assert.equal(ScanLookupBody.safeParse({}).success, false);
  assert.equal(ScanLookupBody.safeParse({ code: '7K3P-2Q9M' }).success, true);
});
