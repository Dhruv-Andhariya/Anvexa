import type { JobForm } from '@hireflow/contracts';
import { describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  approveJob,
  createJob,
  editJobJd,
  forgotPassword,
  generateJobJd,
  getCompanyProfile,
  getSession,
  login,
  logout,
  registerCompany,
  resetPassword,
  revokeInvitation,
  saveCompanyProfile,
  signup,
} from '../src/lib/api';

const BASE = 'http://api.test/api/v1';

const FORM: JobForm = {
  title: 'Junior Backend Developer',
  experienceMin: 0,
  experienceMax: 2,
  mustHaveSkills: ['Node.js', 'SQL', 'REST'],
  niceToHaveSkills: [],
  currency: 'INR',
  salaryType: 'CTC',
  locations: ['Ahmedabad'],
  workMode: 'HYBRID',
  employmentType: 'FULL_TIME',
  openings: 1,
};

const COMPANY = {
  name: 'Acme Analytics',
  industry: 'B2B SaaS',
  description: 'Acme builds analytics dashboards for mid-sized retailers across India.',
  benefits: [],
};

const JD = {
  title: 'Junior Backend Developer',
  summary: 'You will build backend services.',
  aboutCompany: 'Acme builds dashboards.',
  responsibilities: ['Build REST APIs.'],
  requirements: ['Node.js'],
  niceToHave: [],
  benefits: [],
};

const NOW = '2026-10-12T10:00:00.000Z';
const JOB = {
  id: 'job-1',
  title: FORM.title,
  status: 'JD_GENERATED',
  versionCount: 1,
  createdAt: NOW,
  updatedAt: NOW,
  form: FORM,
  currentJdVersionId: 'v1',
  versions: [
    { id: 'v1', version: 1, source: 'AI', content: JD, companySnapshot: COMPANY, promptVersion: 'jd_generate.v3', model: 'm', createdAt: NOW },
  ],
  approval: null,
};

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
// a fresh Response per call: a body can only be read once
const mockFetch = (status: number, body: unknown) => vi.fn<typeof fetch>().mockImplementation(async () => json(status, body));

describe('company profile client', () => {
  it('returns null when no profile has been saved yet', async () => {
    const fetch = mockFetch(404, { code: 'COMPANY_PROFILE_NOT_FOUND', message: 'x' });
    await expect(getCompanyProfile({ fetch, baseUrl: BASE })).resolves.toBeNull();
    expect(fetch.mock.calls[0]![0]).toBe(`${BASE}/company-profile`);
  });

  it('saves the profile with PUT', async () => {
    const fetch = mockFetch(200, { ...COMPANY, id: 'c1', updatedAt: NOW });
    await expect(saveCompanyProfile(COMPANY, { fetch, baseUrl: BASE })).resolves.toMatchObject({ id: 'c1' });
    const [, init] = fetch.mock.calls[0]!;
    expect(init?.method).toBe('PUT');
    expect(JSON.parse(String(init?.body))).toEqual(COMPANY);
  });
});

describe('job workflow client', () => {
  it('creates a job, generates, edits and approves via the job endpoints', async () => {
    const fetch = mockFetch(200, JOB);
    const opts = { fetch, baseUrl: BASE };
    await createJob(FORM, opts);
    await generateJobJd('job-1', opts);
    await editJobJd('job-1', { baseVersionId: 'v1', content: JD }, opts);
    await approveJob('job-1', { jdVersionId: 'v1', companyDetailsVerified: true }, opts);
    expect(fetch.mock.calls.map(([url, init]) => `${init?.method} ${url}`)).toEqual([
      `POST ${BASE}/jobs`,
      `POST ${BASE}/jobs/job-1/jd/generate`,
      `PATCH ${BASE}/jobs/job-1/jd`,
      `POST ${BASE}/jobs/job-1/approve`,
    ]);
  });

  it('maps AI errors to friendly messages', async () => {
    const err = await generateJobJd('job-1', { fetch: mockFetch(429, { code: 'LLM_RATE_LIMITED', message: 'x' }) }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 429, code: 'LLM_RATE_LIMITED' });
    expect((err as ApiError).message).toMatch(/quota/);
  });

  it('falls back to the server message for unknown codes', async () => {
    const fetch = mockFetch(400, { code: 'INVALID_JOB_FORM', message: 'The job form is invalid.' });
    await expect(createJob(FORM, { fetch })).rejects.toThrow('The job form is invalid.');
  });

  it('reports a network failure', async () => {
    const failing = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(generateJobJd('job-1', { fetch: failing })).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
  });

  it('never shows a response that does not match the contract', async () => {
    const broken = { ...JOB, versions: [{ ...JOB.versions[0], content: { ...JD, requirements: [] } }] };
    await expect(generateJobJd('job-1', { fetch: mockFetch(200, broken) })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
});

describe('session client', () => {
  const SESSION = {
    user: { id: 'u1', email: 'priya@acme.dev', name: 'Priya', isPlatformAdmin: false },
    company: { id: 'c1', name: 'Acme', slug: 'acme', status: 'ACTIVE', role: 'HR_MEMBER' },
    companies: [{ id: 'c1', name: 'Acme', slug: 'acme', status: 'ACTIVE', role: 'HR_MEMBER' }],
  };

  it('sends the session cookie and the CSRF header on every request', async () => {
    const fetch = mockFetch(200, JOB);
    await createJob(FORM, { fetch, baseUrl: BASE });
    const [, init] = fetch.mock.calls[0]!;
    expect(init?.credentials).toBe('include');
    expect(init?.headers).toMatchObject({ 'x-requested-with': 'hireflow', 'content-type': 'application/json' });
  });

  it('logs in without ever handling a token in JavaScript', async () => {
    const fetch = mockFetch(200, SESSION);
    await expect(login({ email: 'priya@acme.dev', password: 'secret secret' }, { fetch, baseUrl: BASE })).resolves.toMatchObject({
      company: { role: 'HR_MEMBER' },
    });
    expect(fetch.mock.calls[0]![0]).toBe(`${BASE}/auth/login`);
  });

  it('signs up, then registers the company with its profile', async () => {
    const fetch = mockFetch(201, SESSION);
    const opts = { fetch, baseUrl: BASE };
    await signup({ name: 'Priya', email: 'priya@acme.dev', password: 'long enough pass' }, opts);
    await registerCompany(COMPANY, opts);
    expect(fetch.mock.calls.map(([url, init]) => `${init?.method} ${url}`)).toEqual([`POST ${BASE}/auth/signup`, `POST ${BASE}/companies`]);
    expect(JSON.parse(String(fetch.mock.calls[1]![1]?.body))).toEqual(COMPANY);
  });

  it('explains a duplicate sign-up', async () => {
    const err = await signup({ name: 'P', email: 'p@a.dev', password: 'long enough pass' }, { fetch: mockFetch(409, { code: 'EMAIL_TAKEN', message: 'x' }) }).catch(
      (e: unknown) => e,
    );
    expect((err as ApiError).message).toMatch(/Log in instead/);
  });

  it('returns null when not logged in', async () => {
    await expect(getSession({ fetch: mockFetch(401, { code: 'UNAUTHENTICATED', message: 'x' }) })).resolves.toBeNull();
  });

  it('accepts 204 responses', async () => {
    const noContent = vi.fn<typeof fetch>().mockImplementation(async () => new Response(null, { status: 204 }));
    await expect(logout({ fetch: noContent })).resolves.toBeUndefined();
    await expect(revokeInvitation('i1', { fetch: noContent })).resolves.toBeUndefined();
  });

  it('asks for a reset link and sets the new password', async () => {
    const noContent = vi.fn<typeof fetch>().mockImplementation(async () => new Response(null, { status: 204 }));
    await forgotPassword({ email: 'priya@acme.dev' }, { fetch: noContent, baseUrl: BASE });
    await resetPassword({ token: 't'.repeat(43), password: 'long enough pass' }, { fetch: noContent, baseUrl: BASE });
    expect(noContent.mock.calls.map(([url, init]) => `${init?.method} ${url}`)).toEqual([
      `POST ${BASE}/auth/password/forgot`,
      `POST ${BASE}/auth/password/reset`,
    ]);
    const err = await resetPassword(
      { token: 't'.repeat(43), password: 'long enough pass' },
      { fetch: mockFetch(404, { code: 'PASSWORD_RESET_INVALID', message: 'x' }) },
    ).catch((e: unknown) => e);
    expect((err as ApiError).message).toMatch(/Ask for a new one/);
  });

  it('shows a friendly message for a suspended company', async () => {
    const err = await createJob(FORM, { fetch: mockFetch(403, { code: 'COMPANY_SUSPENDED', message: 'x' }) }).catch((e: unknown) => e);
    expect((err as ApiError).message).toMatch(/suspended/);
  });
});
