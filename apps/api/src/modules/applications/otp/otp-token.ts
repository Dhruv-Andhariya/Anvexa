import { createHmac, timingSafeEqual } from 'node:crypto';

/** Proof that `phone` was verified for `tenantId`, valid until `exp` (unix seconds). */
export interface PhoneProof {
  tenantId: string;
  phone: string;
  exp: number;
  /** The email the code was sent to (when codes go by email). */
  email?: string;
}

const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64url');
const sign = (secret: string, payload: string) => createHmac('sha256', secret).update(payload).digest('base64url');

/** Compact signed token: base64url(json).base64url(hmac). Not a JWT on purpose - nothing to misconfigure. */
export function signPhoneProof(secret: string, proof: PhoneProof): string {
  const payload = b64(JSON.stringify(proof));
  return `${payload}.${sign(secret, payload)}`;
}

export function verifyPhoneProof(secret: string, token: string, now = Date.now()): PhoneProof | undefined {
  const [payload, mac] = token.split('.');
  if (!payload || !mac) return undefined;
  const expected = Buffer.from(sign(secret, payload));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return undefined;
  try {
    const proof = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as PhoneProof;
    if (typeof proof.tenantId !== 'string' || typeof proof.phone !== 'string' || typeof proof.exp !== 'number') return undefined;
    if (proof.email !== undefined && typeof proof.email !== 'string') return undefined;
    return proof.exp * 1000 > now ? proof : undefined;
  } catch {
    return undefined;
  }
}

/** HMAC of an OTP code. Bound to tenant + phone so a code cannot be replayed elsewhere. */
export function hashOtp(secret: string, tenantId: string, phone: string, code: string): string {
  return createHmac('sha256', secret).update(`${tenantId}:${phone}:${code}`).digest('hex');
}

export function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && timingSafeEqual(x, y);
}
