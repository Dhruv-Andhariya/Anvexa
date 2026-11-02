import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';

/**
 * "Continue with Google" over HTTP against a REAL PostgreSQL. Only Google's token endpoint is faked (it returns an
 * ID token with the claims each test sets); the browser redirects, cookies and database are real.
 *
 *   TEST_DATABASE_URL=postgresql://hire:hire@localhost:5432/hireflow_test pnpm --filter api test
 */
const DB = process.env.TEST_DATABASE_URL;
const RUN = randomUUID().slice(0, 8);
const CLIENT_ID = 'test-client.apps.googleusercontent.com';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DASHBOARD = 'http://localhost:3000';

describe.skipIf(!DB)('Continue with Google (real database)', () => {
  let app: INestApplication;
  let base: string;
  let prisma: PrismaClient;
  const realFetch = globalThis.fetch;
  const savedEnv = { ...process.env };
  /** Claims the fake Google token endpoint puts into the next ID token. */
  let claims: Record<string, unknown> = {};
  const tokenRequests: URLSearchParams[] = [];

  const idToken = (c: Record<string, unknown>) =>
    ['e30', Buffer.from(JSON.stringify(c)).toString('base64url'), 'sig'].join('.');
  const googleUser = (email: string, over: Record<string, unknown> = {}) => ({
    iss: 'https://accounts.google.com',
    aud: CLIENT_ID,
    exp: Math.floor(Date.now() / 1000) + 300,
    sub: String(Math.floor(Math.random() * 1e15)),
    email,
    email_verified: true,
    name: 'Google Person',
    ...over,
  });

  const get = (path: string, cookie?: string) =>
    realFetch(`${base}${path}`, { redirect: 'manual', headers: cookie ? { cookie } : {} });
  const cookieFrom = (res: Response, name: string) =>
    res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`) && !c.startsWith(`${name}=;`))?.split(';')[0];

  /** The whole browser round trip: start -> (Google) -> callback. Returns where the browser ends up + session cookie. */
  async function signInWithGoogle(next?: string, tamper?: { state?: string; error?: string }) {
    const start = await get(`/auth/google/start${next ? `?next=${encodeURIComponent(next)}` : ''}`);
    expect(start.status).toBe(302);
    const google = new URL(start.headers.get('location')!);
    expect(google.origin + google.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(google.searchParams.get('code_challenge_method')).toBe('S256');
    const stateCookie = cookieFrom(start, 'hireflow_google_oauth')!;
    const q = new URLSearchParams(
      tamper?.error ? { error: tamper.error, state: google.searchParams.get('state')! } : { code: 'one-time-code', state: tamper?.state ?? google.searchParams.get('state')! },
    );
    const back = await get(`/auth/google/callback?${q}`, stateCookie);
    expect(back.status).toBe(302);
    return { location: back.headers.get('location')!, session: cookieFrom(back, 'hireflow_session') };
  }
  const me = async (cookie: string) => (await realFetch(`${base}/auth/me`, { headers: { cookie } })).json();

  beforeAll(async () => {
    if (!/test/i.test(new URL(DB!).pathname)) throw new Error('TEST_DATABASE_URL must point at a *test* database');
    Object.assign(process.env, { DATABASE_URL: DB, GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: 'test-secret', HR_DASHBOARD_URL: DASHBOARD });
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url) !== TOKEN_URL) return realFetch(url, init);
      tokenRequests.push(new URLSearchParams(String(init?.body)));
      return new Response(JSON.stringify({ id_token: idToken(claims) }), { headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    prisma = new PrismaClient({ datasourceUrl: DB });
    app = await NestFactory.create(AppModule, { logger: false });
    app.setGlobalPrefix('api/v1');
    await app.listen(0);
    base = `${(await app.getUrl()).replace('[::1]', 'localhost')}/api/v1`;
  }, 60_000);

  afterAll(async () => {
    globalThis.fetch = realFetch;
    process.env = savedEnv;
    await app?.close();
    await prisma?.$disconnect();
  });

  it('shows the Google button only when configured', async () => {
    expect(await (await realFetch(`${base}/auth/providers`)).json()).toEqual({ google: true });
  });

  it('a new Google user gets an account (no company yet) and lands on register-company', async () => {
    const email = `g-new-${RUN}@example.com`;
    claims = googleUser(email.toUpperCase(), { name: 'Priya Shah' });
    const { location, session } = await signInWithGoogle();
    expect(location).toBe(`${DASHBOARD}/register-company`);
    expect((await me(session!)).user).toMatchObject({ email, name: 'Priya Shah', isPlatformAdmin: false });
    // PKCE: the verifier went to Google with the code
    expect(tokenRequests.at(-1)!.get('code_verifier')).toMatch(/^[\w-]{40,}$/);

    // second time: the same account, found by the Google id
    const again = await signInWithGoogle('/jobs');
    expect(again.location).toBe(`${DASHBOARD}/jobs`);
    expect((await me(again.session!)).user.email).toBe(email);
    expect(await prisma.user.count({ where: { email } })).toBe(1);
  });

  it('links an existing password account with the same verified email', async () => {
    const email = `g-link-${RUN}@example.com`;
    const signup = await realFetch(`${base}/auth/signup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'hireflow' },
      body: JSON.stringify({ name: 'Password Person', email, password: 'correct horse battery' }),
    });
    expect(signup.status).toBe(201);
    claims = googleUser(email);
    const { session } = await signInWithGoogle();
    expect((await me(session!)).user).toMatchObject({ email, name: 'Password Person' });
    expect((await prisma.user.findUniqueOrThrow({ where: { email } })).googleSub).toBe(claims.sub);

    // a DIFFERENT Google account claiming the same email is refused
    claims = googleUser(email);
    const other = await signInWithGoogle();
    expect(other.location).toBe(`${DASHBOARD}/login?oauth_error=account_mismatch`);
    expect(other.session).toBeUndefined();
  });

  it.each([
    ['an unverified Google email', { email_verified: false }, 'unverified_email'],
    ['a token for another app', { aud: 'someone-else' }, 'rejected'],
    ['an expired token', { exp: Math.floor(Date.now() / 1000) - 10 }, 'rejected'],
  ])('refuses %s', async (_what, over, reason) => {
    claims = googleUser(`g-bad-${RUN}-${reason}@example.com`, over);
    const { location, session } = await signInWithGoogle();
    expect(location).toBe(`${DASHBOARD}/login?oauth_error=${reason}`);
    expect(session).toBeUndefined();
  });

  it('refuses a callback whose state does not match this browser (login CSRF)', async () => {
    claims = googleUser(`g-csrf-${RUN}@example.com`);
    const { location, session } = await signInWithGoogle(undefined, { state: 'attacker-state' });
    expect(location).toBe(`${DASHBOARD}/login?oauth_error=expired`);
    expect(session).toBeUndefined();
  });

  it('handles "cancel" on Google, and never redirects off-site', async () => {
    expect((await signInWithGoogle(undefined, { error: 'access_denied' })).location).toBe(`${DASHBOARD}/login?oauth_error=cancelled`);
    claims = googleUser(`g-next-${RUN}@example.com`);
    expect((await signInWithGoogle('//evil.example/x')).location).toBe(`${DASHBOARD}/register-company`);
  });

  it('a disabled account cannot sign in with Google', async () => {
    const email = `g-off-${RUN}@example.com`;
    claims = googleUser(email);
    await signInWithGoogle();
    await prisma.user.update({ where: { email }, data: { isActive: false } });
    const { location, session } = await signInWithGoogle();
    expect(location).toBe(`${DASHBOARD}/login?oauth_error=account_disabled`);
    expect(session).toBeUndefined();
  });
});
