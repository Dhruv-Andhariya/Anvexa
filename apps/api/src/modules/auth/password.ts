import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';

const scrypt = (password: string, salt: Buffer, keylen: number, opts: ScryptOptions) =>
  new Promise<Buffer>((resolve, reject) =>
    scryptCb(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key))),
  );

// OWASP-recommended scrypt cost (N=2^15, r=8, p=1). Stored with the hash, so it can be raised later.
const N = 2 ** 15;
const R = 8;
const P = 1;
const KEYLEN = 64;
const maxmem = (n: number, r: number) => 256 * n * r; // 2x what scrypt needs

/** "scrypt$N$r$p$salt$hash" (base64url). Node's built-in scrypt: no native dependency needed. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, KEYLEN, { N, r: R, p: P, maxmem: maxmem(N, R) });
  return ['scrypt', N, R, P, salt.toString('base64url'), key.toString('base64url')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, salt, hash] = stored.split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64url');
  const cost = { N: Number(n), r: Number(r), p: Number(p) };
  const key = await scrypt(password, Buffer.from(salt, 'base64url'), expected.length, { ...cost, maxmem: maxmem(cost.N, cost.r) });
  return timingSafeEqual(key, expected);
}

/** Verified against when the email is unknown, so a failed login takes the same time either way. */
let dummy: Promise<string> | undefined;
export const dummyPasswordHash = () => (dummy ??= hashPassword(randomBytes(16).toString('hex')));
