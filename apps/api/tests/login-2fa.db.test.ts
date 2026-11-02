import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import type { EmailMessage } from '../src/modules/applications/email/confirmation-email';
import type { Mailer } from '../src/modules/applications/email/mailer';
import { AUTH_MAILER } from '../src/modules/auth/password-reset.service';

/**
 * Login 2FA (LOGIN_2FA=email) over HTTP against a REAL PostgreSQL. Only the mailer is replaced, so no email leaves
 * the test.
 *
 *   TEST_DATABASE_URL=postgresql://hire:hire@localhost:5432/hireflow_test pnpm --filter api test
 */
const DB = process.env.TEST_DATABASE_URL;
const RUN = randomUUID().slice(0, 8);
const PASSWORD = 'correct horse battery';

describe.skipIf(!DB)('login 2FA by email code (real database)', () => {
  let app: INestApplication;
  let base: string;
  let prisma: PrismaClient;
  const sent: { to: string; message: EmailMessage }[] = [];
  const saved2fa = process.env.LOGIN_2FA;

  const call = async (path: string, body: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'hireflow' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined, cookie: res.headers.get('set-cookie')?.split(';')[0] };
  };
  const me = async (cookie: string) => (await fetch(`${base}/auth/me`, { headers: { cookie } })).status;
  const lastCode = () => /login code is: (\d{6})/.exec(sent.at(-1)!.message.text)![1]!;
  /** A different 6-digit code than the right one. */
  const wrong = (code: string) => String((Number(code) + 1) % 1_000_000).padStart(6, '0');
  const signup = async (tag: string) => {
    const email = `${tag}-${RUN}@example.com`;
    expect((await call('/auth/signup', { name: '2FA Tester', email, password: PASSWORD })).status).toBe(201);
    return email;
  };

  beforeAll(async () => {
    if (!/test/i.test(new URL(DB!).pathname)) throw new Error('TEST_DATABASE_URL must point at a *test* database');
    process.env.DATABASE_URL = DB;
    process.env.LOGIN_2FA = 'email';
    delete process.env.GMAIL_USER;
    delete process.env.SMTP_URL;
    prisma = new PrismaClient({ datasourceUrl: DB });
    app = await NestFactory.create(AppModule, { logger: false });
    app.setGlobalPrefix('api/v1');
    const fake: Mailer = { enabled: true, send: async (to, message) => void sent.push({ to, message }) };
    Object.assign(app.get<Mailer>(AUTH_MAILER), fake);
    await app.listen(0);
    base = `${(await app.getUrl()).replace('[::1]', 'localhost')}/api/v1`;
  }, 60_000);

  afterAll(async () => {
    if (saved2fa === undefined) delete process.env.LOGIN_2FA;
    else process.env.LOGIN_2FA = saved2fa;
    await app?.close();
    await prisma?.$disconnect();
  });

  it('the right password alone gives no session: the emailed code does', async () => {
    const email = await signup('ok');
    const login = await call('/auth/login', { email, password: PASSWORD });
    expect(login.status).toBe(200);
    expect(login.cookie).toBeUndefined();
    expect(login.body).toMatchObject({ codeRequired: true, emailHint: 'o***@example.com' });
    expect(sent.at(-1)!.to).toBe(email);

    const verify = await call('/auth/login/verify', { challenge: login.body.challenge, code: lastCode() });
    expect(verify.status).toBe(200);
    expect(verify.body.user.email).toBe(email);
    expect(await me(verify.cookie!)).toBe(200);

    // single use, and only hashes are stored
    expect((await call('/auth/login/verify', { challenge: login.body.challenge, code: lastCode() })).body.code).toBe('LOGIN_CODE_EXPIRED');
    const rows = await prisma.loginChallenge.findMany({ where: { user: { email } } });
    expect(rows.every((r) => !r.tokenHash.includes(login.body.challenge) && !r.codeHash.includes(lastCode()))).toBe(true);
  });

  it('a wrong password never sends a code', async () => {
    const email = await signup('wrongpw');
    const before = sent.length;
    expect((await call('/auth/login', { email, password: 'not the password' })).status).toBe(401);
    expect(sent).toHaveLength(before);
  });

  it('allows 5 tries per code, then the code is dead even if right', async () => {
    const email = await signup('tries');
    const { body } = await call('/auth/login', { email, password: PASSWORD });
    const code = lastCode();
    for (let left = 4; left >= 1; left--) {
      const res = await call('/auth/login/verify', { challenge: body.challenge, code: wrong(code) });
      expect(res.body).toMatchObject({ code: 'LOGIN_CODE_WRONG', message: expect.stringContaining(`${left} `) });
    }
    expect((await call('/auth/login/verify', { challenge: body.challenge, code: wrong(code) })).body.code).toBe('LOGIN_CODE_EXPIRED');
    expect((await call('/auth/login/verify', { challenge: body.challenge, code })).body.code).toBe('LOGIN_CODE_EXPIRED');
  });

  it('a newer code replaces the older one, and an expired code is refused', async () => {
    const email = await signup('newer');
    const first = await call('/auth/login', { email, password: PASSWORD });
    const firstCode = lastCode();
    const second = await call('/auth/login', { email, password: PASSWORD });
    expect((await call('/auth/login/verify', { challenge: first.body.challenge, code: firstCode })).body.code).toBe('LOGIN_CODE_EXPIRED');

    await prisma.loginChallenge.updateMany({ where: { user: { email }, usedAt: null }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await call('/auth/login/verify', { challenge: second.body.challenge, code: lastCode() })).body.code).toBe('LOGIN_CODE_EXPIRED');
  });

  it('rejects a malformed code without using an attempt', async () => {
    const email = await signup('format');
    const { body } = await call('/auth/login', { email, password: PASSWORD });
    expect((await call('/auth/login/verify', { challenge: body.challenge, code: '12ab' })).status).toBe(400);
    expect((await call('/auth/login/verify', { challenge: body.challenge, code: lastCode() })).status).toBe(200);
  });
});
