import { randomInt, timingSafeEqual } from 'node:crypto';
import { hashToken } from './tokens';

/** Shared by login 2FA and sign-up email verification: 6-digit codes sent by email. */

export const codeValidMinutes = () => Number(process.env.LOGIN_CODE_TTL_MINUTES) || 10;
export const codeMaxAttempts = () => Number(process.env.LOGIN_CODE_MAX_ATTEMPTS) || 5;

export const newCode = () => String(randomInt(0, 1_000_000)).padStart(6, '0');

/**
 * The code is hashed together with the challenge token, which only the browser has: a leaked database row alone
 * cannot be brute-forced back to the code.
 */
export const codeHash = (challenge: string, code: string) => hashToken(`${challenge}:${code}`);

export const sameHash = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** "d***@company.com" - enough to recognise the inbox, not enough to learn the address. */
export const maskEmail = (email: string) => {
  const at = email.indexOf('@');
  return at > 0 ? `${email[0]}***${email.slice(at)}` : '***';
};

/** `name`=email: on; `name`=off: off; unset: on in production, off elsewhere (local dev, tests). */
export function emailCodeSwitch(name: string): boolean {
  const mode = (process.env[name] ?? '').trim().toLowerCase();
  if (mode === 'email') return true;
  if (mode === 'off') return false;
  return process.env.NODE_ENV === 'production';
}

/** Message for a wrong code, or for the last wrong one that used up the challenge. */
export const wrongCodeMessage = (left: number) =>
  left > 0 ? `That code is not right. ${left} ${left === 1 ? 'try' : 'tries'} left.` : 'Too many wrong codes. Ask for a new one.';
