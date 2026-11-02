import 'reflect-metadata';
import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiWorkerClient } from '../src/modules/jobs/ai-worker.client';
import { JobsController } from '../src/modules/jobs/jobs.controller';
import { JobsRepository } from '../src/modules/jobs/jobs.repository';
import { JobsService } from '../src/modules/jobs/jobs.service';
import { CompanyProfileController } from '../src/modules/tenants/company-profile.controller';
import { CompanyProfileRepository } from '../src/modules/tenants/company-profile.repository';
import { CompanyProfileService } from '../src/modules/tenants/company-profile.service';
import { TenantContext } from '../src/modules/tenants/tenant-context';
import { AuditService } from '../src/modules/audit';
import { FixedTenant, InMemoryCompanyProfiles, InMemoryJobs, MemoryAudit } from './in-memory';

const COMPANY = {
  name: 'Acme Analytics',
  industry: 'B2B SaaS',
  description: 'Acme builds analytics dashboards for mid-sized retailers across India.',
  productsServices: 'Retail analytics platform',
  website: 'https://acme.dev',
  careersUrl: 'https://acme.dev/careers',
  benefits: ['Health insurance'],
};

const FORM = {
  title: 'Junior Backend Developer',
  experienceMin: 0,
  experienceMax: 2,
  mustHaveSkills: ['Node.js', 'SQL', 'REST'],
  locations: ['Ahmedabad'],
  workMode: 'HYBRID',
  employmentType: 'FULL_TIME',
};

const JD = {
  title: 'Junior Backend Developer',
  summary: 'You will build backend services.',
  aboutCompany: 'Acme builds analytics dashboards for retailers.',
  responsibilities: ['Build REST APIs.'],
  requirements: ['Node.js', 'SQL', 'REST'],
  niceToHave: [],
  benefits: ['Health insurance'],
};

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const workerOk = () =>
  vi.fn<typeof fetch>().mockImplementation(async () =>
    json(200, JD, { 'x-llm-model': 'gemini-test', 'x-prompt-version': 'jd_generate.v3' }),
  );

let app: INestApplication | undefined;

async function start(worker: typeof fetch = workerOk(), timeoutMs = 5_000) {
  const jobs = new InMemoryJobs();
  const tenant = new FixedTenant();
  const audit = new MemoryAudit();
  const profiles = new InMemoryCompanyProfiles();
  @Module({
    controllers: [CompanyProfileController, JobsController],
    providers: [
      CompanyProfileService,
      JobsService,
      { provide: TenantContext, useValue: tenant },
      { provide: AuditService, useValue: audit },
      { provide: CompanyProfileRepository, useValue: profiles },
      { provide: JobsRepository, useValue: jobs },
      { provide: AiWorkerClient, useValue: new AiWorkerClient({ baseUrl: 'http://worker.test', timeoutMs, fetch: worker }) },
    ],
  })
  class TestModule {}

  app = await NestFactory.create(TestModule, { logger: false });
  app.setGlobalPrefix('api/v1');
  await app.listen(0);
  const base = `${(await app.getUrl()).replace('[::1]', 'localhost')}/api/v1`;
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => undefined) };
  };
  return { call, jobs, tenant, audit, profiles };
}

/** Steps 1 + 2: save the profile and create a job. */
async function withJob(worker?: typeof fetch, timeoutMs?: number) {
  const api = await start(worker, timeoutMs);
  await api.call('PUT', '/company-profile', COMPANY);
  const { body: job } = await api.call('POST', '/jobs', FORM);
  return { ...api, jobId: job.id as string };
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('step 1 - company profile', () => {
  it('is 404 until saved, then returns the saved profile', async () => {
    const { call } = await start();
    expect((await call('GET', '/company-profile')).body.code).toBe('COMPANY_PROFILE_NOT_FOUND');

    const saved = await call('PUT', '/company-profile', { ...COMPANY, name: '  Acme Analytics  ' });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ ...COMPANY, id: expect.any(String) });

    const again = await call('PUT', '/company-profile', { ...COMPANY, industry: 'Retail tech', website: undefined });
    expect(again.body.id).toBe(saved.body.id); // one profile per company: saving again updates it
    expect((await call('GET', '/company-profile')).body).toMatchObject({ industry: 'Retail tech' });
    expect((await call('GET', '/company-profile')).body.website).toBeUndefined();
  });

  it('rejects an invalid profile with field issues', async () => {
    const { call } = await start();
    const res = await call('PUT', '/company-profile', { ...COMPANY, description: 'short', website: 'acme' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_COMPANY_PROFILE');
    expect(res.body.issues.map((i: { path: string }) => i.path)).toEqual(expect.arrayContaining(['description', 'website']));
  });
});

describe('step 2 - create job', () => {
  it('requires the company profile first', async () => {
    const { call } = await start();
    const res = await call('POST', '/jobs', FORM);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('COMPANY_PROFILE_REQUIRED');
  });

  it('saves a DRAFT job with the validated form', async () => {
    const { call } = await start();
    await call('PUT', '/company-profile', COMPANY);
    const res = await call('POST', '/jobs', { ...FORM, title: '  Junior Backend Developer  ', unknownField: 'dropped' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'DRAFT', title: 'Junior Backend Developer', versions: [], approval: null });
    expect(res.body.form).not.toHaveProperty('unknownField');
    expect(res.body.form.niceToHaveSkills).toEqual([]); // contract defaults applied

    const list = await call('GET', '/jobs');
    expect(list.body).toEqual([expect.objectContaining({ id: res.body.id, status: 'DRAFT', versionCount: 0 })]);
  });

  it('rejects an invalid form without saving it', async () => {
    const { call, jobs } = await start();
    await call('PUT', '/company-profile', COMPANY);
    const res = await call('POST', '/jobs', { ...FORM, mustHaveSkills: ['Node.js'] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_JOB_FORM');
    expect(jobs.jobs.size).toBe(0);
  });

  it('returns 404 for unknown or malformed job ids', async () => {
    const { call } = await start();
    expect((await call('GET', '/jobs/not-a-uuid')).status).toBe(404);
    expect((await call('GET', '/jobs/0190a3c4-0000-7000-8000-000000000000')).body.code).toBe('JOB_NOT_FOUND');
  });
});

describe('step 3 - generate JD', () => {
  it('sends the job form AND the company profile to the worker and stores a traced version', async () => {
    const worker = workerOk();
    const { call, jobId } = await withJob(worker);

    const res = await call('POST', `/jobs/${jobId}/jd/generate`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('JD_GENERATED');
    const [v1] = res.body.versions;
    expect(v1).toMatchObject({ version: 1, source: 'AI', content: JD, model: 'gemini-test', promptVersion: 'jd_generate.v3' });
    expect(v1.content.companyUrl).toBe(COMPANY.website); // added by the API from the company profile
    expect(v1.content).not.toHaveProperty('careersUrl'); // the careers page link is not added to JDs
    expect(v1.companySnapshot).toMatchObject(COMPANY);
    expect(v1.companySnapshot).not.toHaveProperty('id'); // only profile fields reach the AI
    expect(res.body.currentJdVersionId).toBe(v1.id);

    const [url, init] = worker.mock.calls[0]!;
    expect(String(url)).toBe('http://worker.test/v1/jd/generate');
    const sent = JSON.parse(String(init!.body));
    expect(sent).toMatchObject({ title: FORM.title, mustHaveSkills: FORM.mustHaveSkills, company: COMPANY });
  });

  it('uses the profile website even if the AI returns its own link, and adds none without a website', async () => {
    const sneaky = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => json(200, { ...JD, companyUrl: 'https://evil.example', careersUrl: 'https://evil.example/apply' }));
    const { call, jobId } = await withJob(sneaky);
    const res = await call('POST', `/jobs/${jobId}/jd/generate`);
    expect(res.body.versions[0].content.companyUrl).toBe(COMPANY.website);
    expect(res.body.versions[0].content).not.toHaveProperty('careersUrl');

    const { website: _w, ...noWebsite } = COMPANY;
    await call('PUT', '/company-profile', noWebsite);
    const again = await call('POST', `/jobs/${jobId}/jd/generate`);
    expect(again.body.versions[0].content).not.toHaveProperty('companyUrl');
  });

  it('regenerating keeps every earlier version', async () => {
    const { call, jobId } = await withJob();
    await call('POST', `/jobs/${jobId}/jd/generate`);
    const res = await call('POST', `/jobs/${jobId}/jd/generate`);
    expect(res.body.versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);
    expect(res.body.currentJdVersionId).toBe(res.body.versions[0].id);
  });

  it.each([
    [429, 'LLM_RATE_LIMITED'],
    [503, 'LLM_NOT_CONFIGURED'],
    [504, 'LLM_TIMEOUT'],
    [502, 'LLM_INVALID_OUTPUT'],
    [422, 'LLM_BLOCKED'],
  ])('passes through safe AI error %i %s and stores nothing', async (status, code) => {
    const { call, jobId } = await withJob(vi.fn<typeof fetch>().mockResolvedValue(json(status, { detail: { code, message: 'safe msg' } })));
    const res = await call('POST', `/jobs/${jobId}/jd/generate`);
    expect(res.status).toBe(status);
    expect(res.body).toEqual({ statusCode: status, code, message: 'safe msg' });
    expect((await call('GET', `/jobs/${jobId}`)).body).toMatchObject({ status: 'DRAFT', versions: [] });
  });

  it('passes the worker Retry-After through on 429', async () => {
    const limited = json(429, { detail: { code: 'LLM_RATE_LIMITED', message: 'slow down' } }, { 'retry-after': '31' });
    const { call, jobId } = await withJob(vi.fn<typeof fetch>().mockResolvedValue(limited));
    const res = await call('POST', `/jobs/${jobId}/jd/generate`);
    expect(res.body).toEqual({ statusCode: 429, code: 'LLM_RATE_LIMITED', message: 'slow down', retryAfterSeconds: 31 });
  });

  it('answers 422 (not 500) when the saved company profile no longer validates', async () => {
    const { call, jobId, profiles, tenant } = await withJob();
    const saved = await profiles.find(tenant.id);
    profiles.rows.set(tenant.id, { ...saved!, description: 'too short' }); // e.g. saved before a rule was tightened
    const res = await call('POST', `/jobs/${jobId}/jd/generate`);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('INVALID_COMPANY_PROFILE');
  });

  it('maps an unexpected worker 500 to a generic 502 without leaking details', async () => {
    const { call, jobId } = await withJob(vi.fn<typeof fetch>().mockResolvedValue(json(500, { detail: 'Traceback: secret stuff' })));
    const res = await call('POST', `/jobs/${jobId}/jd/generate`);
    expect(res.status).toBe(502);
    expect(JSON.stringify(res.body)).not.toContain('secret');
    expect(res.body.code).toBe('AI_WORKER_ERROR');
  });

  it('rejects a worker response that does not match JdContent', async () => {
    const { call, jobId } = await withJob(vi.fn<typeof fetch>().mockResolvedValue(json(200, { ...JD, responsibilities: [] })));
    expect((await call('POST', `/jobs/${jobId}/jd/generate`)).body.code).toBe('AI_WORKER_INVALID_RESPONSE');
  });

  it('returns 503 when the worker is unreachable and 504 when it times out', async () => {
    const down = await withJob(vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed')));
    expect((await down.call('POST', `/jobs/${down.jobId}/jd/generate`)).body.code).toBe('AI_WORKER_UNAVAILABLE');
    await app?.close();

    const hang: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason)));
    const slow = await withJob(hang, 50);
    const res = await slow.call('POST', `/jobs/${slow.jobId}/jd/generate`);
    expect(res.status).toBe(504);
    expect(res.body.code).toBe('AI_WORKER_TIMEOUT');
  });
});

describe('step 4 - review, edit, approve', () => {
  async function generated() {
    const api = await withJob();
    const { body } = await api.call('POST', `/jobs/${api.jobId}/jd/generate`);
    return { ...api, v1: body.versions[0].id as string };
  }

  it('saves an HR edit as a new version and keeps the company snapshot', async () => {
    const { call, jobId, v1 } = await generated();
    const edited = { ...JD, summary: '  Edited by HR.  ', aboutCompany: 'Acme, edited.' };
    const res = await call('PATCH', `/jobs/${jobId}/jd`, { baseVersionId: v1, content: edited });
    expect(res.status).toBe(200);
    const [v2, old] = res.body.versions;
    expect(v2).toMatchObject({ version: 2, source: 'HR_EDIT', model: null, promptVersion: null });
    expect(v2.content.summary).toBe('Edited by HR.');
    expect(v2.content.companyUrl).toBe(COMPANY.website); // kept on edit
    expect(v2.companySnapshot).toEqual(old.companySnapshot);
    expect(old.content.summary).toBe(JD.summary); // the AI version is never overwritten
  });

  it('an HR edit cannot change or remove the company link', async () => {
    const { call, jobId, v1 } = await generated();
    const changed = await call('PATCH', `/jobs/${jobId}/jd`, { baseVersionId: v1, content: { ...JD, companyUrl: 'https://other.example' } });
    expect(changed.body.versions[0].content.companyUrl).toBe(COMPANY.website);
    const v2 = changed.body.versions[0].id;
    const removed = await call('PATCH', `/jobs/${jobId}/jd`, { baseVersionId: v2, content: JD });
    expect(removed.body.versions[0].content.companyUrl).toBe(COMPANY.website);
  });

  it('rejects an edit based on an older version', async () => {
    const { call, jobId, v1 } = await generated();
    await call('POST', `/jobs/${jobId}/jd/generate`); // v2 written in "another tab"
    const res = await call('PATCH', `/jobs/${jobId}/jd`, { baseVersionId: v1, content: JD });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('STALE_JD_VERSION');
  });

  it('rejects an incomplete edit', async () => {
    const { call, jobId, v1 } = await generated();
    const res = await call('PATCH', `/jobs/${jobId}/jd`, { baseVersionId: v1, content: { ...JD, responsibilities: [] } });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_JD');
  });

  it('cannot approve before a JD exists', async () => {
    const { call, jobId } = await withJob();
    const res = await call('POST', `/jobs/${jobId}/approve`, { jdVersionId: 'x', companyDetailsVerified: true });
    expect(res.body.code).toBe('JD_NOT_GENERATED');
  });

  it('requires HR to verify the company details', async () => {
    const { call, jobId, v1 } = await generated();
    const res = await call('POST', `/jobs/${jobId}/approve`, { jdVersionId: v1, companyDetailsVerified: false });
    expect(res.status).toBe(400);
    expect(res.body.issues[0].path).toBe('companyDetailsVerified');
  });

  it('only approves the current version', async () => {
    const { call, jobId, v1 } = await generated();
    await call('POST', `/jobs/${jobId}/jd/generate`);
    const res = await call('POST', `/jobs/${jobId}/approve`, { jdVersionId: v1, companyDetailsVerified: true });
    expect(res.body.code).toBe('STALE_JD_VERSION');
  });

  it('approves and then locks the job', async () => {
    const { call, jobId, v1, tenant, audit } = await generated();
    const res = await call('POST', `/jobs/${jobId}/approve`, {
      jdVersionId: v1,
      approvedBy: 'Someone Else', // ignored: the approver is the logged-in user
      companyDetailsVerified: true,
      note: 'Looks good',
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('APPROVED');
    expect(res.body.approval).toMatchObject({
      jdVersionId: v1,
      approvedBy: tenant.actor.name,
      approvedById: tenant.actor.id,
      companyDetailsVerified: true,
      note: 'Looks good',
    });
    expect(audit.entries.map((e) => e.action)).toEqual(['company_profile.saved', 'job.created', 'jd.generated', 'job.approved']);

    for (const [method, path, body] of [
      ['POST', `/jobs/${jobId}/jd/generate`, undefined],
      ['PATCH', `/jobs/${jobId}/jd`, { baseVersionId: v1, content: JD }],
      ['PATCH', `/jobs/${jobId}`, FORM],
      ['POST', `/jobs/${jobId}/approve`, { jdVersionId: v1, companyDetailsVerified: true }],
    ] as const) {
      const locked = await call(method, path, body);
      expect(locked.status).toBe(409);
      expect(locked.body.code).toBe('JOB_APPROVED');
    }
  });

  it('lets HR change the requirements before approval; the old JD is no longer current', async () => {
    const { call, jobId, v1 } = await generated();
    const res = await call('PATCH', `/jobs/${jobId}`, { ...FORM, title: 'Backend Developer' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ title: 'Backend Developer', status: 'DRAFT', currentJdVersionId: null });
    expect(res.body.versions.map((v: { id: string }) => v.id)).toEqual([v1]); // history kept
  });

  it('saving the same requirements keeps the current JD', async () => {
    const { call, jobId, v1 } = await generated();
    const res = await call('PATCH', `/jobs/${jobId}`, { ...FORM, mustHaveSkills: [...FORM.mustHaveSkills] });
    expect(res.body).toMatchObject({ status: 'JD_GENERATED', currentJdVersionId: v1 });
  });

  it('cannot approve or edit the old JD after the requirements changed and regeneration failed', async () => {
    let fail = false;
    const worker = vi.fn<typeof fetch>().mockImplementation(async () =>
      fail ? json(503, { detail: { code: 'LLM_UNAVAILABLE', message: 'busy' } }) : json(200, JD),
    );
    const { call, jobId } = await withJob(worker);
    const v1 = (await call('POST', `/jobs/${jobId}/jd/generate`)).body.versions[0].id;
    await call('PATCH', `/jobs/${jobId}`, { ...FORM, mustHaveSkills: ['Go', 'Kafka', 'gRPC'] });
    fail = true;
    expect((await call('POST', `/jobs/${jobId}/jd/generate`)).status).toBe(503);

    const approve = await call('POST', `/jobs/${jobId}/approve`, { jdVersionId: v1, companyDetailsVerified: true });
    expect(approve.status).toBe(409);
    expect(approve.body.code).toBe('JD_NOT_GENERATED');
    expect((await call('PATCH', `/jobs/${jobId}/jd`, { baseVersionId: v1, content: JD })).body.code).toBe('JD_NOT_GENERATED');

    fail = false; // generating again works from "no current version"
    const again = await call('POST', `/jobs/${jobId}/jd/generate`);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ status: 'JD_GENERATED', currentJdVersionId: again.body.versions[0].id });
    expect(again.body.versions).toHaveLength(2);
    expect(JSON.parse(String(worker.mock.calls.at(-1)![1]!.body)).mustHaveSkills).toEqual(['Go', 'Kafka', 'gRPC']);
  });

  it('restoring an old version keeps the company details of THAT version', async () => {
    const { call, jobId, v1 } = await generated(); // v1 written from COMPANY
    await call('PUT', '/company-profile', { ...COMPANY, name: 'Acme Renamed', website: 'https://renamed.example' });
    const v2 = (await call('POST', `/jobs/${jobId}/jd/generate`)).body.versions[0];
    expect(v2.companySnapshot.name).toBe('Acme Renamed');

    const res = await call('PATCH', `/jobs/${jobId}/jd`, { baseVersionId: v2.id, basedOnVersionId: v1, content: JD });
    expect(res.status).toBe(200);
    const [v3] = res.body.versions;
    expect(v3.companySnapshot).toMatchObject({ name: COMPANY.name });
    expect(v3.content.companyUrl).toBe(COMPANY.website);
  });

  it('rejects a restore from a version of another job', async () => {
    const { call, jobId, v1 } = await generated();
    const { body: other } = await call('POST', '/jobs', FORM);
    const otherV1 = (await call('POST', `/jobs/${other.id}/jd/generate`)).body.versions[0].id;
    const res = await call('PATCH', `/jobs/${jobId}/jd`, { baseVersionId: v1, basedOnVersionId: otherV1, content: JD });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('JD_VERSION_NOT_FOUND');
  });

  it('refuses to approve a JD with a blank summary', async () => {
    const { call, jobId } = await withJob(vi.fn<typeof fetch>().mockResolvedValue(json(200, { ...JD, summary: '   ' })));
    const v1 = (await call('POST', `/jobs/${jobId}/jd/generate`)).body.versions[0].id;
    const res = await call('POST', `/jobs/${jobId}/approve`, { jdVersionId: v1, companyDetailsVerified: true });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('JD_INCOMPLETE');
    expect((await call('GET', `/jobs/${jobId}`)).body.status).toBe('JD_GENERATED');
  });
});

describe('delete job', () => {
  it('deletes the job for good (any status) and logs it', async () => {
    const { call, jobId, audit } = await withJob();
    const res = await call('DELETE', `/jobs/${jobId}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ jobId, deletedApplications: 0, notRemoved: [] });
    expect((await call('GET', `/jobs/${jobId}`)).status).toBe(404);
    expect((await call('GET', '/jobs')).body).toEqual([]);
    expect(audit.entries.at(-1)).toMatchObject({ action: 'job.deleted', subjectId: jobId });
  });

  it('is 404 for an unknown job', async () => {
    const { call } = await withJob();
    expect((await call('DELETE', '/jobs/00000000-0000-4000-8000-000000000000')).body.code).toBe('JOB_NOT_FOUND');
  });
});
