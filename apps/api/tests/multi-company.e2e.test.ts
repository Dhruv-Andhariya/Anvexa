import 'reflect-metadata';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { hashPassword } from '../src/modules/auth/password';

/**
 * End-to-end multi-company isolation test: the REAL AppModule (global AuthGuard, Prisma repositories, AiWorkerClient)
 * against a real PostgreSQL test database. Only the Python AI worker is replaced by a local HTTP stub.
 *
 *   TEST_DATABASE_URL=postgresql://hire:hire@localhost:5433/hireflow_test pnpm --filter api test:db
 *
 * The database must already be migrated (prisma migrate deploy). Rows use unique emails/slugs, nothing is deleted.
 */
const DB = process.env.TEST_DATABASE_URL;
const run = describe.skipIf(!DB);

const RUN = randomUUID().slice(0, 8);
const PASSWORD = 'correct horse battery';

const profile = (name: string) => ({
  name,
  industry: 'B2B SaaS',
  description: `${name} builds analytics dashboards for mid-sized retailers across India.`,
  benefits: ['Health insurance'],
});

const FORM = {
  title: 'Junior Backend Developer',
  experienceMin: 0,
  experienceMax: 2,
  mustHaveSkills: ['Node.js', 'SQL', 'REST'],
  locations: ['Ahmedabad'],
  workMode: 'HYBRID',
  employmentType: 'FULL_TIME',
  salaryMin: 400000,
  salaryMax: 600000,
};

const JD = {
  title: 'Junior Backend Developer',
  summary: 'You will build backend services.',
  aboutCompany: 'About us.',
  responsibilities: ['Build REST APIs.'],
  requirements: ['Node.js'],
  niceToHave: [],
  benefits: [],
};

interface Res {
  status: number;
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

let app: INestApplication;
let worker: Server;
let prisma: PrismaClient;
let base: string;
const workerCalls: { company: { name: string }; title: string }[] = [];

/** A browser: keeps its own session cookie and sends the CSRF header like the dashboard does. */
class Browser {
  cookie = '';
  async call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
    const res = await fetch(base + path, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-requested-with': 'hireflow',
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = res.headers.getSetCookie().find((c) => c.startsWith('hireflow_session='));
    if (setCookie) this.cookie = setCookie.split(';')[0]!;
    return { status: res.status, body: await res.json().catch(() => undefined) };
  }
  login(email: string, password = PASSWORD) {
    return this.call('POST', '/auth/login', { email, password });
  }
}

const tokenOf = (inviteUrl: string) => inviteUrl.split('/invite/')[1]!;

async function accept(inviteUrl: string, name: string) {
  const b = new Browser();
  const res = await b.call('POST', '/auth/invitations/accept', { token: tokenOf(inviteUrl), name, password: PASSWORD });
  expect(res.status).toBe(200);
  return b;
}

interface CompanyFixture {
  id: string;
  admin: Browser;
  hr: Browser;
  hrUserId: string;
  adminUserId: string;
  jobId: string;
  versionIds: string[];
}

const platform = new Browser();
let A: CompanyFixture;
let B: CompanyFixture;

/**
 * Full workflow for one company, the way a new company's HR uses HireFlow:
 * sign up -> register company (profile) -> invite HR -> job -> generate -> edit -> regenerate.
 */
async function onboard(letter: string): Promise<CompanyFixture> {
  const admin = new Browser();
  const signup = await admin.call('POST', '/auth/signup', { name: `Admin ${letter}`, email: `admin-${letter}-${RUN}@example.com`, password: PASSWORD });
  expect(signup.status).toBe(201);
  expect(signup.body.company).toBeNull(); // no company until they register one
  expect((await admin.call('GET', '/jobs')).body.code).toBe('NO_COMPANY');

  // step 1: registering the company IS saving its profile; the registrant becomes Company Admin
  const registered = await admin.call('POST', '/companies', profile(`Company ${letter} ${RUN}`));
  expect(registered.status).toBe(201);
  expect(registered.body.company).toMatchObject({ name: `Company ${letter} ${RUN}`, role: 'COMPANY_ADMIN', status: 'ACTIVE' });
  const me = await admin.call('GET', '/auth/me');
  expect(me.body.company.id).toBe(registered.body.company.id);

  const invite = await admin.call('POST', '/company/invitations', { email: `hr-${letter}-${RUN}@example.com`, role: 'HR_MEMBER' });
  expect(invite.status).toBe(201);
  const hr = await accept(invite.body.inviteUrl, `HR ${letter}`);
  const hrMe = await hr.call('GET', '/auth/me');
  expect(hrMe.body.company.role).toBe('HR_MEMBER');

  // the Company Admin can still edit the profile later; HR loads it automatically, never re-enters it
  expect((await admin.call('PUT', '/company-profile', profile(`Company ${letter} ${RUN}`))).status).toBe(200);
  expect((await hr.call('GET', '/company-profile')).body.name).toBe(`Company ${letter} ${RUN}`);

  // step 2-4 as the HR member
  const job = await hr.call('POST', '/jobs', { ...FORM, title: `Backend Dev ${letter}` });
  expect(job.status).toBe(201);
  const jobId = job.body.id as string;
  const gen = await hr.call('POST', `/jobs/${jobId}/jd/generate`);
  expect(gen.status).toBe(200);
  expect(gen.body.versions[0].companySnapshot.name).toBe(`Company ${letter} ${RUN}`);
  const v1 = gen.body.versions[0].id;
  const edit = await hr.call('PATCH', `/jobs/${jobId}/jd`, { baseVersionId: v1, content: { ...JD, summary: `Edited by ${letter}` } });
  expect(edit.status).toBe(200);
  const regen = await hr.call('POST', `/jobs/${jobId}/jd/generate`);
  expect(regen.body.versions.map((v: { version: number }) => v.version)).toEqual([3, 2, 1]);

  return {
    id: registered.body.company.id,
    admin,
    hr,
    hrUserId: hrMe.body.user.id,
    adminUserId: me.body.user.id,
    jobId,
    versionIds: regen.body.versions.map((v: { id: string }) => v.id),
  };
}

run('multi-company isolation (real database)', () => {
  beforeAll(async () => {
    if (!/test/i.test(new URL(DB!).pathname)) throw new Error('TEST_DATABASE_URL must point at a *test* database');
    process.env.DATABASE_URL = DB;
    process.env.LOGIN_MAX_ATTEMPTS = '5';

    worker = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        workerCalls.push(JSON.parse(raw));
        res.writeHead(200, { 'content-type': 'application/json', 'x-llm-model': 'stub', 'x-prompt-version': 'jd_generate.v3' });
        res.end(JSON.stringify(JD));
      });
    });
    await new Promise<void>((r) => worker.listen(0, r));
    process.env.AI_WORKER_URL = `http://127.0.0.1:${(worker.address() as AddressInfo).port}`;

    prisma = new PrismaClient({ datasourceUrl: DB });
    await prisma.user.create({
      data: { email: `platform-${RUN}@example.com`, name: 'Platform Admin', passwordHash: await hashPassword(PASSWORD), isPlatformAdmin: true },
    });

    app = await NestFactory.create(AppModule, { logger: false });
    app.setGlobalPrefix('api/v1');
    await app.listen(0);
    base = `${(await app.getUrl()).replace('[::1]', 'localhost')}/api/v1`;

    expect((await platform.login(`platform-${RUN}@example.com`)).status).toBe(200);
    A = await onboard('A');
    B = await onboard('B');
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
    worker?.close();
  });

  describe('authentication', () => {
    it('rejects anonymous requests and wrong passwords, without revealing which part was wrong', async () => {
      const anon = new Browser();
      expect((await anon.call('GET', '/jobs')).status).toBe(401);
      expect((await anon.call('GET', '/auth/me')).body.code).toBe('UNAUTHENTICATED');
      const wrong = await anon.login(`admin-A-${RUN}@example.com`, 'wrong password!');
      const unknown = await anon.login(`nobody-${RUN}@example.com`, 'wrong password!');
      expect([wrong.status, unknown.status]).toEqual([401, 401]);
      expect(wrong.body).toEqual(unknown.body);
    });

    it('rate-limits repeated failed logins', async () => {
      const b = new Browser();
      const statuses: number[] = [];
      for (let i = 0; i < 7; i++) statuses.push((await b.login(`hr-B-${RUN}@example.com`, 'nope nope nope')).status);
      expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
      expect(statuses.at(-1)).toBe(429);
    });

    it('stores only a hash of the session token, in an httpOnly cookie', async () => {
      const b = new Browser();
      await b.login(`admin-B-${RUN}@example.com`);
      const token = decodeURIComponent(b.cookie.split('=')[1]!);
      expect(await prisma.session.count({ where: { tokenHash: token } })).toBe(0);
      const raw = await fetch(`${base}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-requested-with': 'hireflow' },
        body: JSON.stringify({ email: `admin-B-${RUN}@example.com`, password: PASSWORD }),
      });
      expect(raw.headers.getSetCookie()[0]).toMatch(/HttpOnly; SameSite=Lax/);
    });

    it('logout ends the session', async () => {
      const b = new Browser();
      await b.login(`hr-A-${RUN}@example.com`);
      expect((await b.call('GET', '/jobs')).status).toBe(200);
      const old = b.cookie;
      expect((await b.call('POST', '/auth/logout')).status).toBe(204);
      b.cookie = old; // replaying the old cookie must not work
      expect((await b.call('GET', '/jobs')).status).toBe(401);
    });

    it('blocks writes without the CSRF header', async () => {
      const res = await A.hr.call('POST', '/jobs', FORM, { 'x-requested-with': '' });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('CSRF_CHECK_FAILED');
    });

    it('sign-up never grants platform admin or a company role', async () => {
      const b = new Browser();
      const res = await b.call('POST', '/auth/signup', {
        name: 'Sneaky',
        email: `sneaky-${RUN}@example.com`,
        password: PASSWORD,
        isPlatformAdmin: true,
        role: 'COMPANY_ADMIN',
        companyId: A.id,
      });
      expect(res.status).toBe(201);
      expect(res.body.user.isPlatformAdmin).toBe(false);
      expect(res.body.company).toBeNull();
      expect(res.body.companies).toEqual([]);
      expect((await b.call('GET', `/jobs/${A.jobId}`)).status).toBe(403);
      expect((await b.call('GET', '/admin/companies')).status).toBe(403);
      expect((await b.call('POST', '/auth/company', { companyId: A.id })).body.code).toBe('NOT_A_MEMBER');
    });

    it('rejects a second account with the same email', async () => {
      const res = await new Browser().call('POST', '/auth/signup', { name: 'Dup', email: `ADMIN-A-${RUN}@example.com`, password: PASSWORD });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('EMAIL_TAKEN');
    });

    it('two companies with the same name are still separate', async () => {
      const ids: string[] = [];
      for (const n of [1, 2]) {
        const b = new Browser();
        await b.call('POST', '/auth/signup', { name: `Twin ${n}`, email: `twin-${n}-${RUN}@example.com`, password: PASSWORD });
        const res = await b.call('POST', '/companies', profile(`Twin Corp ${RUN}`));
        expect(res.status).toBe(201);
        ids.push(res.body.company.id);
      }
      const slugs = await prisma.tenant.findMany({ where: { id: { in: ids } }, select: { slug: true } });
      expect(new Set(slugs.map((s) => s.slug)).size).toBe(2);
    });

    it('company registration needs a valid profile and a login', async () => {
      expect((await new Browser().call('POST', '/companies', profile('Anon Corp'))).status).toBe(401);
      const b = new Browser();
      await b.call('POST', '/auth/signup', { name: 'Bad Profile', email: `badprofile-${RUN}@example.com`, password: PASSWORD });
      const res = await b.call('POST', '/companies', { name: 'X' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_COMPANY_PROFILE');
    });

    it('platform admins cannot create companies or send company invitations', async () => {
      expect((await platform.call('POST', '/admin/companies', { name: 'X', slug: 'x', adminEmail: 'x@y.z' })).status).toBe(404);
      expect((await platform.call('POST', `/admin/companies/${A.id}/admin-invitations`, { email: 'x@y.z' })).status).toBe(404);
    });
  });

  describe('JD workflow per company', () => {
    it('sent each company its OWN profile to the AI', () => {
      const a = workerCalls.filter((c) => c.title === 'Backend Dev A');
      const b = workerCalls.filter((c) => c.title === 'Backend Dev B');
      expect(a.length).toBe(2);
      expect(b.length).toBe(2);
      expect(a.every((c) => c.company.name === `Company A ${RUN}`)).toBe(true);
      expect(b.every((c) => c.company.name === `Company B ${RUN}`)).toBe(true);
    });

    it('records who wrote each version and who approved, from the session', async () => {
      const job = await A.hr.call('GET', `/jobs/${A.jobId}`);
      const res = await A.hr.call('POST', `/jobs/${A.jobId}/approve`, {
        jdVersionId: job.body.currentJdVersionId,
        approvedBy: 'Spoofed Name',
        companyDetailsVerified: true,
      });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('APPROVED');
      expect(res.body.approval).toMatchObject({ approvedBy: 'HR A', approvedById: A.hrUserId });
      const versions = await prisma.jdVersion.findMany({ where: { jobId: A.jobId } });
      expect(versions.every((v) => v.createdBy === A.hrUserId)).toBe(true);
      expect((await prisma.job.findUnique({ where: { id: A.jobId } }))!.createdById).toBe(A.hrUserId);
      expect(await prisma.auditLog.count({ where: { tenantId: A.id, action: 'job.approved', subjectId: A.jobId } })).toBe(1);

      // locked after approval
      expect((await A.hr.call('POST', `/jobs/${A.jobId}/jd/generate`)).body.code).toBe('JOB_APPROVED');
    });

    it('Company B completes its own approval independently', async () => {
      const job = await B.admin.call('GET', `/jobs/${B.jobId}`);
      const res = await B.admin.call('POST', `/jobs/${B.jobId}/approve`, { jdVersionId: job.body.currentJdVersionId, companyDetailsVerified: true });
      expect(res.status).toBe(200);
      expect(res.body.approval.approvedById).toBe(B.adminUserId);
    });
  });

  describe('company data isolation', () => {
    it('lists only the caller company jobs', async () => {
      const a = await A.hr.call('GET', '/jobs');
      const b = await B.hr.call('GET', '/jobs');
      expect(a.body.map((j: { id: string }) => j.id)).toEqual([A.jobId]);
      expect(b.body.map((j: { id: string }) => j.id)).toEqual([B.jobId]);
    });

    it("cannot read, change, regenerate, edit, approve or see versions of another company's job", async () => {
      const other = B.jobId;
      const attempts: [string, string, unknown?][] = [
        ['GET', `/jobs/${other}`],
        ['PATCH', `/jobs/${other}`, FORM],
        ['POST', `/jobs/${other}/jd/generate`],
        ['PATCH', `/jobs/${other}/jd`, { baseVersionId: B.versionIds[0], content: JD }],
        ['POST', `/jobs/${other}/approve`, { jdVersionId: B.versionIds[0], companyDetailsVerified: true }],
      ];
      for (const user of [A.hr, A.admin]) {
        for (const [method, path, body] of attempts) {
          const res = await user.call(method, path, body);
          expect(res.status, `${method} ${path}`).toBe(404);
          expect(JSON.stringify(res.body)).not.toContain('Company B');
        }
      }
      const versionsB = await prisma.jdVersion.count({ where: { jobId: other } });
      expect(versionsB).toBe(3); // nothing was added to B
    });

    it('ignores company ids smuggled in headers, query strings and bodies', async () => {
      const headers = { 'x-tenant-id': B.id, 'x-company-id': B.id };
      const list = await A.hr.call('GET', `/jobs?tenantId=${B.id}&companyId=${B.id}`, undefined, headers);
      expect(list.body.map((j: { id: string }) => j.id)).toEqual([A.jobId]);
      const created = await A.hr.call('POST', '/jobs', { ...FORM, tenantId: B.id, companyId: B.id }, headers);
      expect(created.status).toBe(201);
      expect((await prisma.job.findUnique({ where: { id: created.body.id } }))!.tenantId).toBe(A.id);
      expect((await A.hr.call('GET', '/company-profile', undefined, headers)).body.name).toBe(`Company A ${RUN}`);
    });

    it('cannot switch the session into a company the user does not belong to', async () => {
      const res = await A.admin.call('POST', '/auth/company', { companyId: B.id });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('NOT_A_MEMBER');
      expect((await A.admin.call('GET', '/auth/me')).body.company.id).toBe(A.id);
    });

    it("Company Admin cannot manage another company's members or invitations", async () => {
      const bTeam = await B.admin.call('GET', '/company/members');
      const bInvite = await B.admin.call('POST', '/company/invitations', { email: `pending-B-${RUN}@example.com`, role: 'HR_MEMBER' });

      const disable = await A.admin.call('PATCH', `/company/members/${B.hrUserId}`, { status: 'DISABLED' });
      expect(disable.status).toBe(404);
      const revoke = await A.admin.call('DELETE', `/company/invitations/${bInvite.body.id}`);
      expect(revoke.status).toBe(404);
      const aTeam = await A.admin.call('GET', '/company/members');
      expect(aTeam.body.members.map((m: { userId: string }) => m.userId)).not.toContain(B.hrUserId);

      const after = await B.admin.call('GET', '/company/members');
      expect(after.body.members).toEqual(bTeam.body.members);
      expect(after.body.invitations.map((i: { id: string }) => i.id)).toContain(bInvite.body.id);
    });

    it('the database rejects a JD version whose company differs from its job', async () => {
      await expect(
        prisma.jdVersion.create({
          data: { tenantId: A.id, jobId: B.jobId, version: 99, source: 'HR_EDIT', content: JD },
        }),
      ).rejects.toThrow();
    });
  });

  describe('roles', () => {
    it('HR Member cannot do Company Admin or Platform Admin actions', async () => {
      const checks: [string, string, unknown?][] = [
        ['PUT', '/company-profile', profile('Hijacked')],
        ['GET', '/company/members'],
        ['POST', '/company/invitations', { email: `x-${RUN}@example.com`, role: 'COMPANY_ADMIN' }],
        ['PATCH', `/company/members/${A.hrUserId}`, { role: 'COMPANY_ADMIN' }],
        ['GET', '/admin/companies'],
        ['PATCH', `/admin/companies/${B.id}`, { status: 'SUSPENDED' }],
      ];
      for (const [method, path, body] of checks) {
        const res = await A.hr.call(method, path, body);
        expect(res.status, `${method} ${path}`).toBe(403);
      }
      expect((await A.hr.call('GET', '/auth/me')).body.company.role).toBe('HR_MEMBER');
    });

    it('Company Admin cannot use platform endpoints or grant platform admin', async () => {
      expect((await A.admin.call('GET', '/admin/companies')).status).toBe(403);
      expect((await A.admin.call('PATCH', `/admin/companies/${B.id}`, { status: 'SUSPENDED' })).status).toBe(403);
      const res = await A.admin.call('POST', '/company/invitations', { email: `pa-${RUN}@example.com`, role: 'PLATFORM_ADMIN' });
      expect(res.status).toBe(400);
    });

    it('Platform Admin manages companies but cannot read company jobs', async () => {
      const list = await platform.call('GET', '/admin/companies');
      expect(list.body.map((c: { id: string }) => c.id)).toEqual(expect.arrayContaining([A.id, B.id]));
      const res = await platform.call('GET', '/jobs');
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('NO_COMPANY');
    });

    it('a company always keeps one active Company Admin', async () => {
      const res = await A.admin.call('PATCH', `/company/members/${A.adminUserId}`, { role: 'HR_MEMBER' });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('LAST_COMPANY_ADMIN');
    });

    it('a disabled member loses access immediately, and regains it when re-enabled', async () => {
      expect((await A.admin.call('PATCH', `/company/members/${A.hrUserId}`, { status: 'DISABLED' })).status).toBe(200);
      expect((await A.hr.call('GET', '/jobs')).body.code).toBe('NO_COMPANY');
      expect((await A.admin.call('PATCH', `/company/members/${A.hrUserId}`, { status: 'ACTIVE' })).status).toBe(200);
      expect((await A.hr.call('GET', '/jobs')).status).toBe(200);
    });
  });

  describe('suspension', () => {
    it('a suspended company cannot use any protected operation; others are unaffected', async () => {
      expect((await platform.call('PATCH', `/admin/companies/${B.id}`, { status: 'SUSPENDED' })).body.status).toBe('SUSPENDED');
      for (const [method, path] of [
        ['GET', '/jobs'],
        ['GET', `/jobs/${B.jobId}`],
        ['POST', '/jobs'],
        ['GET', '/company-profile'],
        ['GET', '/company/members'],
      ] as const) {
        const res = await B.admin.call(method, path, method === 'POST' ? FORM : undefined);
        expect(res.status, `${method} ${path}`).toBe(403);
        expect(res.body.code).toBe('COMPANY_SUSPENDED');
      }
      // login still works so the UI can explain the suspension
      expect((await B.hr.call('GET', '/auth/me')).body.company.status).toBe('SUSPENDED');
      expect((await A.hr.call('GET', '/jobs')).status).toBe(200);

      await platform.call('PATCH', `/admin/companies/${B.id}`, { status: 'ACTIVE' });
      expect((await B.admin.call('GET', '/jobs')).status).toBe(200);
    });
  });

  describe('invitations', () => {
    it('are single-use', async () => {
      const inv = await A.admin.call('POST', '/company/invitations', { email: `once-${RUN}@example.com`, role: 'HR_MEMBER' });
      await accept(inv.body.inviteUrl, 'Once');
      const again = await new Browser().call('POST', '/auth/invitations/accept', { token: tokenOf(inv.body.inviteUrl), name: 'Again', password: PASSWORD });
      expect(again.status).toBe(404);
      expect(again.body.code).toBe('INVITATION_INVALID');
    });

    it("cannot be used to take over an existing account (needs that account's password)", async () => {
      // B's admin invites A's HR member: accepting requires A-HR's real password
      const inv = await B.admin.call('POST', '/company/invitations', { email: `hr-A-${RUN}@example.com`, role: 'HR_MEMBER' });
      const preview = await new Browser().call('GET', `/auth/invitations/${tokenOf(inv.body.inviteUrl)}`);
      expect(preview.body).toMatchObject({ existingUser: true, companyName: `Company B ${RUN}` });
      const hijack = await new Browser().call('POST', '/auth/invitations/accept', { token: tokenOf(inv.body.inviteUrl), password: 'attacker password' });
      expect(hijack.status).toBe(401);

      // the real owner accepts: one account, two companies, data still separated per session company
      const owner = await new Browser().call('POST', '/auth/invitations/accept', { token: tokenOf(inv.body.inviteUrl), password: PASSWORD });
      expect(owner.status).toBe(200);
      expect(owner.body.company.id).toBe(B.id);
      expect(owner.body.companies.map((c: { id: string }) => c.id).sort()).toEqual([A.id, B.id].sort());
    });
  });
});
