import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codeHint, formatCodeInput } from '../src/lib/codeField';

test('formats XXXX-XXXX live, uppercase, ignoring separators', () => {
  assert.equal(formatCodeInput('7k3').display, '7K3');
  assert.equal(formatCodeInput('7k3p').display, '7K3P');
  assert.equal(formatCodeInput('7k3p2').display, '7K3P-2');
  assert.equal(formatCodeInput('7k3p-2q9m').display, '7K3P-2Q9M');
  assert.equal(formatCodeInput('7K3P 2Q9M').normalized, '7K3P2Q9M');
  assert.equal(formatCodeInput('7k3p2q9mXYZ').normalized, '7K3P2Q9M', 'capped at 8 chars');
});

test('valid only when complete and every char is in the alphabet', () => {
  const partial = formatCodeInput('AAAA22');
  assert.equal(partial.complete, false);
  assert.equal(partial.valid, false);
  const ok = formatCodeInput('aaaa2222');
  assert.equal(ok.complete, true);
  assert.equal(ok.valid, true);
  assert.deepEqual(ok.invalidChars, []);
  const bad = formatCodeInput('AAAA-0O1I');
  assert.equal(bad.complete, true);
  assert.equal(bad.valid, false);
  assert.deepEqual(bad.invalidChars, ['0', 'O', '1', 'I']);
});

test('hint lists the ambiguous characters typed', () => {
  assert.equal(codeHint(formatCodeInput('AAAA')), null);
  assert.match(codeHint(formatCodeInput('AL0')) ?? '', /L, 0/);
  assert.match(codeHint(formatCodeInput('AL0')) ?? '', /não usam 0, O, 1, I nem L/);
});
