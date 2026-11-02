import { afterEach, describe, expect, it } from 'vitest';
import { clearSessionCookie, sessionCookie } from '../src/modules/auth/cookies';
import { maskEmail } from '../src/modules/auth/email-code';
import { loginTwoFactorEnabled } from '../src/modules/auth/login-code.service';

const saved = { COOKIE_SECURE: process.env.COOKIE_SECURE, NODE_ENV: process.env.NODE_ENV, LOGIN_2FA: process.env.LOGIN_2FA };
const set = (name: keyof typeof saved, value: string | undefined) =>
  value === undefined ? delete process.env[name] : (process.env[name] = value);

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) set(k as keyof typeof saved, v);
});

describe('session cookie Secure flag', () => {
  const isSecure = (cookie: string) => cookie.split('; ').includes('Secure');

  it('plain-HTTP local dev goes without Secure (browsers would drop it on http://)', () => {
    set('NODE_ENV', 'development');
    set('COOKIE_SECURE', 'false');
    expect(isSecure(sessionCookie('t', 1000))).toBe(false);
  });

  it('an HTTPS request always gets Secure, even with COOKIE_SECURE=false', () => {
    set('NODE_ENV', 'development');
    set('COOKIE_SECURE', 'false');
    expect(isSecure(sessionCookie('t', 1000, true))).toBe(true);
    expect(isSecure(clearSessionCookie(true))).toBe(true);
  });

  it('production always gets Secure, even with COOKIE_SECURE=false', () => {
    set('NODE_ENV', 'production');
    set('COOKIE_SECURE', 'false');
    expect(isSecure(sessionCookie('t', 1000))).toBe(true);
  });

  it('keeps HttpOnly and SameSite=Lax', () => {
    expect(sessionCookie('t', 1000)).toMatch(/HttpOnly; SameSite=Lax/);
  });
});

describe('login 2FA switch', () => {
  it.each([
    ['email', 'development', true],
    ['off', 'production', false],
    [undefined, 'production', true],
    [undefined, 'development', false],
    ['EMAIL ', 'development', true],
  ])('LOGIN_2FA=%s NODE_ENV=%s -> %s', (mode, env, expected) => {
    set('LOGIN_2FA', mode);
    set('NODE_ENV', env);
    expect(loginTwoFactorEnabled()).toBe(expected);
  });

  it('masks the email it shows', () => {
    expect(maskEmail('deepa.shah@company.com')).toBe('d***@company.com');
  });
});
