/**
 * Password hashing (scrypt), token generation and signatures.
 *
 * Stored password format: `scrypt$<N>$<r>$<p>$<salt b64>$<hash b64>`.
 */
import { createHash, createHmac, randomBytes, randomInt, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (password: string, salt: Buffer, keylen: number, options: { N: number; r: number; p: number; maxmem: number }) => Promise<Buffer>;

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEYLEN = 64;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored) {
    // Burn the same amount of work so "no password" is not distinguishable by timing.
    await scrypt(password, randomBytes(16), KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: 64 * 1024 * 1024 });
    return false;
  }
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = Buffer.from(parts[4], 'base64');
  const expected = Buffer.from(parts[5], 'base64');
  const actual = await scrypt(password, salt, expected.length, { N, r, p, maxmem: 64 * 1024 * 1024 });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

/** 32 random bytes as base64url (43 chars). Used for session and invite tokens. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function randomHex(bytes = 32): string {
  return randomBytes(bytes).toString('hex');
}

/** Constant-time string comparison (hashes both sides so lengths never leak). */
export function constantTimeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb) && a.length === b.length;
}

/** base64url(HMAC-SHA256(secret, value)).slice(0, 32) — file URL signatures. */
export function hmacSignature(secret: string, value: string): string {
  return createHmac('sha256', secret).update(value).digest('base64url').slice(0, 32);
}

/** Cryptographically random code from an alphabet. */
export function randomCode(alphabet: string, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[randomInt(alphabet.length)];
  return out;
}
