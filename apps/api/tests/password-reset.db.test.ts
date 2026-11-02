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
 * "Forgot password" over HTTP against a REAL PostgreSQL (the real AppModule; only the mailer is replaced, so no
 * email ever leaves the test).
 *
 *   TEST_DATABASE_URL=postgresql://hire:hire@localhost:5432/hireflow_test pnpm --filter api test
 */
const DB = process.env.TEST_DATABASE_URL;
const RUN = randomUUID().slice(0, 8);
const OLD = 'correct horse battery';
const NEW = 'a brand new password';

describe.skipIf(!DB)('password reset (real database)', () => {
  let app: INestApplication;
  let base: string;
  let prisma: PrismaClient;
  const sent: { to: string; message: EmailMessage }[] = [];

  const call = async (path: string, body: unknown, cookie?: string) => {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'hireflow', ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined, cookie: res.headers.get('set-cookie')?.split(';')[0] };
  };
  const me = async (cookie: string) => (await fetch(`${base}/auth/me`, { headers: { cookie } })).status;
  const linkToken = () => /\/reset-password\/([\w-]+)/.exec(sent.at(-1)!.message.text)![1]!;
  const waitForEmails = async (n: number) => {
    for (let i = 0; i < 50 && sent.length < n; i++) await new Promise((r) => setTimeout(r, 20));
    expect(sent).toHaveLength(n);
  };

  beforeAll(async () => {
    if (!/test/i.test(new URL(DB!).pathname)) throw new Error('TEST_DATABASE_URL must point at a *test* database');
    process.env.DATABASE_URL = DB;
    // never a real mail server from a test
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
    await app?.close();
    await prisma?.$disconnect();
  });

  it('emails a one-time link, sets the new password and logs out every session', async () => {
    const email = `reset-${RUN}@example.com`;
    const signup = await call('/auth/signup', { name: 'Reset Tester', email, password: OLD });
    expect(signup.status).toBe(201);
    const oldSession = signup.cookie!;
    expect(await me(oldSession)).toBe(200);

    // unknown email: the same answer, no email
    expect((await call('/auth/password/forgot', { email: `nobody-${RUN}@example.com` })).status).toBe(204);
    expect((await call('/auth/password/forgot', { email: email.toUpperCase() })).status).toBe(204);
    await waitForEmails(1);
    expect(sent[0]!.to).toBe(email);
    expect(sent[0]!.message.text).toContain('http://localhost:3000/reset-password/');

    // a newer link replaces the older one
    const first = linkToken();
    expect((await call('/auth/password/forgot', { email })).status).toBe(204);
    await waitForEmails(2);
    const second = linkToken();
    expect((await call('/auth/password/reset', { token: first, password: NEW })).body.code).toBe('PASSWORD_RESET_INVALID');

    // too short a password is refused and does not use up the link
    expect((await call('/auth/password/reset', { token: second, password: 'short' })).status).toBe(400);
    expect((await call('/auth/password/reset', { token: second, password: NEW })).status).toBe(204);

    expect(await me(oldSession)).toBe(401); // logged out everywhere
    expect((await call('/auth/login', { email, password: OLD })).status).toBe(401);
    expect((await call('/auth/login', { email, password: NEW })).status).toBe(200);

    // single use
    expect((await call('/auth/password/reset', { token: second, password: 'yet another password' })).status).toBe(404);
    const rows = await prisma.passwordReset.findMany({ where: { user: { email } } });
    expect(rows.every((r) => r.usedAt !== null && !r.tokenHash.includes(second))).toBe(true); // only the hash is stored
  });

  it('refuses an expired link', async () => {
    const email = `expired-${RUN}@example.com`;
    expect((await call('/auth/signup', { name: 'Expired Tester', email, password: OLD })).status).toBe(201);
    const before = sent.length;
    expect((await call('/auth/password/forgot', { email })).status).toBe(204);
    await waitForEmails(before + 1);
    await prisma.passwordReset.updateMany({ where: { user: { email } }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await call('/auth/password/reset', { token: linkToken(), password: NEW })).body.code).toBe('PASSWORD_RESET_INVALID');
    expect((await call('/auth/login', { email, password: OLD })).status).toBe(200);
  });
});
