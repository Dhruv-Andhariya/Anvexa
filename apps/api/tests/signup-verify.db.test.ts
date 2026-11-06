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
 * Sign-up email verification (SIGNUP_VERIFY_EMAIL=email) over HTTP against a REAL PostgreSQL. Only the mailer is
 * replaced, so no email leaves the test.
 *
 *   TEST_DATABASE_URL=postgresql://hire:hire@localhost:5432/hireflow_test pnpm --filter api test
 */
const DB = process.env.TEST_DATABASE_URL;
const RUN = randomUUID().slice(0, 8);
const PASSWORD = 'correct horse battery';

describe.skipIf(!DB)('sign-up email verification (real database)', () => {
  let app: INestApplication;
  let base: string;
  let prisma: PrismaClient;
  const sent: { to: string; message: EmailMessage }[] = [];
  const saved = process.env.SIGNUP_VERIFY_EMAIL;

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
  const lastCode = () => /ANVEXA account is: (\d{6})/.exec(sent.at(-1)!.message.text)![1]!;
  const wrong = (code: string) => String((Number(code) + 1) % 1_000_000).padStart(6, '0');
  const users = (email: string) => prisma.user.count({ where: { email } });
  const start = (email: string, name = 'New HR') => call('/auth/signup', { name, email, password: PASSWORD });

  beforeAll(async () => {
    if (!/test/i.test(new URL(DB!).pathname)) throw new Error('TEST_DATABASE_URL must point at a *test* database');
    process.env.DATABASE_URL = DB;
    process.env.SIGNUP_VERIFY_EMAIL = 'email';
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
    if (saved === undefined) delete process.env.SIGNUP_VERIFY_EMAIL;
    else process.env.SIGNUP_VERIFY_EMAIL = saved;
    await app?.close();
    await prisma?.$disconnect();
  });

  it('creates no account until the emailed code is entered, then creates it logged in', async () => {
    const email = `new-${RUN}@example.com`;
    const res = await start(email.toUpperCase());
    expect(res.status).toBe(201);
    expect(res.cookie).toBeUndefined();
    expect(res.body).toMatchObject({ codeRequired: true, emailHint: 'n***@example.com' });
    expect(sent.at(-1)!.to).toBe(email);
    expect(await users(email)).toBe(0);

    const verify = await call('/auth/signup/verify', { challenge: res.body.challenge, code: lastCode() });
    expect(verify.status).toBe(201);
    expect(verify.body).toMatchObject({ user: { email, name: 'New HR' }, company: null });
    expect(await me(verify.cookie!)).toBe(200);
    expect(await users(email)).toBe(1);

    // the chosen password works (2FA is off in this test)
    expect((await call('/auth/login', { email, password: PASSWORD })).status).toBe(200);
    // single use
    expect((await call('/auth/signup/verify', { challenge: res.body.challenge, code: lastCode() })).body.code).toBe('SIGNUP_CODE_EXPIRED');
    // and the email is now taken: no new code is sent
    const before = sent.length;
    expect((await start(email)).body.code).toBe('EMAIL_TAKEN');
    expect(sent).toHaveLength(before);
  });

  it('a wrong code creates nothing; 5 tries per code', async () => {
    const email = `tries-${RUN}@example.com`;
    const { body } = await start(email);
    const code = lastCode();
    for (let left = 4; left >= 1; left--) {
      expect((await call('/auth/signup/verify', { challenge: body.challenge, code: wrong(code) })).body).toMatchObject({
        code: 'SIGNUP_CODE_WRONG',
        message: expect.stringContaining(`${left} `),
      });
    }
    expect((await call('/auth/signup/verify', { challenge: body.challenge, code: wrong(code) })).body.code).toBe('SIGNUP_CODE_EXPIRED');
    expect((await call('/auth/signup/verify', { challenge: body.challenge, code })).body.code).toBe('SIGNUP_CODE_EXPIRED');
    expect(await users(email)).toBe(0);
  });

  it('a newer code replaces the older one; an expired code is refused', async () => {
    const email = `newer-${RUN}@example.com`;
    const first = await start(email, 'First Name');
    const firstCode = lastCode();
    const second = await start(email, 'Second Name');
    expect((await call('/auth/signup/verify', { challenge: first.body.challenge, code: firstCode })).body.code).toBe('SIGNUP_CODE_EXPIRED');

    const secondCode = lastCode();
    await prisma.signupChallenge.updateMany({ where: { email, usedAt: null }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await call('/auth/signup/verify', { challenge: second.body.challenge, code: secondCode })).body.code).toBe('SIGNUP_CODE_EXPIRED');
    expect(await users(email)).toBe(0);
  });

  it('stores only hashes: no plain password, code or challenge', async () => {
    const email = `hashes-${RUN}@example.com`;
    const { body } = await start(email);
    const row = await prisma.signupChallenge.findFirstOrThrow({ where: { email, usedAt: null } });
    expect(row.passwordHash).toMatch(/^scrypt\$/);
    expect(JSON.stringify(row)).not.toContain(PASSWORD);
    expect(JSON.stringify(row)).not.toContain(body.challenge);
    expect(row.codeHash).not.toContain(lastCode());
  });

  it('two verified sign-ups for the same email: the second gets EMAIL_TAKEN', async () => {
    const email = `race-${RUN}@example.com`;
    const a = await start(email);
    const codeA = lastCode();
    // simulate: an account appeared for this email after the code was sent (e.g. an accepted invitation)
    await prisma.user.create({ data: { email, name: 'Already Here', passwordHash: 'scrypt$x' } });
    expect((await call('/auth/signup/verify', { challenge: a.body.challenge, code: codeA })).body.code).toBe('EMAIL_TAKEN');
  });
});
