import { randomUUID } from 'node:crypto';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../../src/common/prisma.service';
import { EICAR_SIGNATURE } from '../../src/modules/applications/resume/virus-scanner';
import { FORM, JD } from '../publisher/fixtures';
import { PDF } from './fixtures';

/**
 * M06-M09 end to end over HTTP against a REAL PostgreSQL, starting where Intern 1's flow ends:
 * HR signs up, registers the company, creates the job, a JD version exists and HR approves it (all with Intern 1's
 * real endpoints; only the AI generation is replaced by inserting the version). Then: publish -> public job page ->
 * phone OTP -> apply with resume -> parser view -> student data rights.
 *
 *   TEST_DATABASE_URL=postgresql://hire:hire@localhost:5432/hireflow_test pnpm --filter api test
 *
 * The database must already be migrated (prisma migrate deploy). Fresh random companies each run.
 * Resume files: in the database by default; with RESUME_STORAGE=s3 (+ S3_ENDPOINT, S3_BUCKET, S3_REGION,
 * S3_ACCESS_KEY, S3_SECRET_KEY, e.g. the adobe/s3mock container) they must be in the bucket instead.
 */
const DB = process.env.TEST_DATABASE_URL;
const RUN = randomUUID().slice(0, 8);
const S3_MODE = process.env.RESUME_STORAGE?.toLowerCase() === 's3';

interface Res {
  status: number;
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

/** The saved resume file: from the bucket (RESUME_STORAGE=s3, nothing in resume_files) or from resume_files. */
async function storedFile(db: PrismaService, resume: { id: string; storageKey: string | null }): Promise<Buffer> {
  const inDb = await db.resumeFile.findUnique({ where: { resumeId: resume.id } });
  if (!S3_MODE) return Buffer.from(inDb!.content);
  expect(inDb).toBeNull();
  const s3 = new S3Client({
    region: process.env.S3_REGION!,
    endpoint: process.env.S3_ENDPOINT,
    forcePathStyle: true,
    credentials: { accessKeyId: process.env.S3_ACCESS_KEY!, secretAccessKey: process.env.S3_SECRET_KEY! },
  });
  const got = await s3.send(new GetObjectCommand({ Bucket: process.env.S3_BUCKET!, Key: resume.storageKey! }));
  return Buffer.from(await got.Body!.transformToByteArray());
}

describe.skipIf(!DB)('M06-M09 flow (real database)', () => {
  let app: INestApplication;
  let base: string;
  let db: PrismaService;

  /** An HR browser: keeps its session cookie and sends the CSRF header like the dashboard does. */
  class Browser {
    cookie = '';
    async call(method: string, path: string, body?: unknown): Promise<Res> {
      const res = await fetch(`${base}/api/v1${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          'x-requested-with': 'hireflow',
          ...(this.cookie ? { cookie: this.cookie } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const setCookie = res.headers.getSetCookie().find((c) => c.startsWith('hireflow_session='));
      if (setCookie) this.cookie = setCookie.split(';')[0]!;
      return { status: res.status, body: res.status === 204 ? undefined : await res.json().catch(() => undefined) };
    }
  }

  /** The careers site: no login; JSON or multipart, always with the CSRF header. */
  const pub = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const multipart = body instanceof FormData;
    const res = await fetch(`${base}/api/v1/public${path}`, {
      method,
      headers: { 'x-requested-with': 'hireflow', ...(multipart || body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: multipart ? body : body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => undefined) };
  };

  const hr = new Browser();
  const otherHr = new Browser();
  let companySlug = '';
  let otherSlug = '';
  let jobId = '';
  let jobSlug = '';
  let otpToken = '';
  const phone = `+9198${String(Date.now()).slice(-8)}`;

  async function registerCompany(browser: Browser, who: string) {
    const signup = await browser.call('POST', '/auth/signup', { name: `${who} HR`, email: `${who}.${RUN}@example.com`, password: 'correct horse battery' });
    expect(signup.status).toBe(201);
    const company = await browser.call('POST', '/companies', {
      name: `${who} Tech ${RUN}`,
      industry: 'B2B SaaS',
      description: `${who} Tech builds hiring software for colleges across India.`,
      careersUrl: `https://${who}.example/careers`,
      benefits: [],
    });
    expect(company.status).toBe(201);
    return company.body.company.slug as string;
  }

  /** Intern 1's steps 2-4: job form -> JD version (normally written by the AI) -> HR approval. */
  async function approvedJob(browser: Browser): Promise<string> {
    // M11: HR's private minimum ATS score goes next to the form (needed to publish; never stored in the form).
    const job = await browser.call('POST', '/jobs', { ...FORM, screening: { minAtsScore: 73 } });
    expect(job.status).toBe(201);
    const id = job.body.id as string;
    const tenantId = (await db.job.findUniqueOrThrow({ where: { id } })).tenantId;
    const version = await db.jdVersion.create({ data: { tenantId, jobId: id, version: 1, source: 'AI', content: JD, model: 'test' } });
    await db.job.update({ where: { id }, data: { status: 'JD_GENERATED', currentJdVersionId: version.id } });
    const approve = await browser.call('POST', `/jobs/${id}/approve`, { jdVersionId: version.id, companyDetailsVerified: true });
    expect(approve.status).toBe(200);
    // M05: publishing needs complete assessment rounds; their names become the public selection process.
    const rounds = await browser.call('PUT', `/rounds/jobs/${id}`, {
      complete: true,
      rounds: [
        { type: 'CODING', name: 'Coding round', passRule: { mode: 'MARKS', value: 5 }, questions: [{ kind: 'CODING', text: 'Reverse a string', marks: 10 }] },
        { type: 'TECHNICAL_INTERVIEW', name: 'Interview', passRule: { mode: 'INTERVIEWER_SCORE', value: 6, maxScore: 10 } },
      ],
    });
    expect(rounds.status).toBe(200);
    return id;
  }

  beforeAll(async () => {
    Object.assign(process.env, {
      DATABASE_URL: DB,
      VIRUS_SCANNER: 'dev-eicar-only',
      OTP_PROVIDER: 'dev',
      CAREERS_SITE_URL: 'http://localhost:3300',
      AI_WORKER_URL: 'http://127.0.0.1:1', // validator unreachable -> basic checks + a warning
      LINKEDIN_ACCESS_TOKEN: '',
      SMTP_URL: '', // no mail server in tests: the application is saved, confirmationEmailSent is false
    });
    const { AppModule } = await import('../../src/app.module');
    app = await NestFactory.create(AppModule, { logger: false });
    app.setGlobalPrefix('api/v1');
    await app.listen(0);
    base = (await app.getUrl()).replace('[::1]', 'localhost');
    db = app.get(PrismaService);

    companySlug = await registerCompany(hr, 'acme');
    otherSlug = await registerCompany(otherHr, 'other');
    jobId = await approvedJob(hr);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('lists the approved job on the publish page, not yet published', async () => {
    const jobs = await hr.call('GET', '/publisher/jobs');
    expect(jobs.status).toBe(200);
    expect(jobs.body).toEqual([expect.objectContaining({ jobId, version: 1, listing: null, applications: 0 })]);
    expect((await otherHr.call('GET', '/publisher/jobs')).body).toEqual([]);
  });

  it('needs a login and the right company', async () => {
    expect((await new Browser().call('GET', '/publisher/jobs')).status).toBe(401);
    expect((await otherHr.call('POST', `/publisher/jobs/${jobId}/preview`, {})).status).toBe(404);
  });

  it('previews, then publishes the approved JD (careers live, LinkedIn honestly not configured)', async () => {
    const body = { selectionProcess: ['Coding round', 'Interview'] };
    const preview = await hr.call('POST', `/publisher/jobs/${jobId}/preview`, body);
    expect(preview.status).toBe(200);
    expect(preview.body.errors).toEqual([]);
    expect(preview.body.warnings[0]).toMatch(/validator could not be reached/);
    const careers = preview.body.channels.find((c: { channel: string }) => c.channel === 'careers');
    expect(careers.text).toContain(JD.summary);
    expect(careers.links.careers).toBe('https://acme.example/careers');

    const res = await hr.call('POST', `/publisher/jobs/${jobId}/publish`, body);
    expect(res.status).toBe(200);
    jobSlug = res.body.slug;
    const status = Object.fromEntries(res.body.posts.map((p: { channel: string; status: string }) => [p.channel, p.status]));
    expect(status).toEqual({ careers: 'PUBLISHED', linkedin: 'NOT_CONFIGURED' });

    // Publishing again never creates a second post.
    await hr.call('POST', `/publisher/jobs/${jobId}/publish`, body);
    const posts = await hr.call('GET', `/publisher/jobs/${jobId}/posts`);
    expect(posts.body.posts).toHaveLength(2);
    expect(posts.body.version).toBe(1);

    const audit = await db.auditLog.findMany({ where: { subjectId: jobId, action: 'job.published' } });
    expect(audit.length).toBeGreaterThanOrEqual(1);
    expect(audit[0]!.actorUserId).toBeTruthy();
  });

  it('a draft (not approved) job cannot be published', async () => {
    const draft = await hr.call('POST', '/jobs', { ...FORM, title: 'Draft only role' });
    const res = await hr.call('POST', `/publisher/jobs/${draft.body.id}/publish`, {});
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('JOB_NOT_APPROVED');
  });

  it('serves the approved job publicly, and only under its own company', async () => {
    const job = await pub('GET', `/${companySlug}/jobs/${jobSlug}`);
    expect(job.status).toBe(200);
    expect(job.body).toMatchObject({ status: 'LIVE', version: 1, jd: { title: JD.title }, company: { careersPageUrl: 'https://acme.example/careers' } });
    expect((await pub('GET', `/${otherSlug}/jobs/${jobSlug}`)).status).toBe(404);
    expect((await pub('GET', `/${companySlug}/jobs`)).body).toHaveLength(1);
  });

  it('keeps the minimum ATS score private: HR of the company only, never in the stored form or any public answer', async () => {
    const settings = await hr.call('GET', `/ats/jobs/${jobId}/settings`);
    expect(settings.body).toMatchObject({ jobId, settings: { minAtsScore: 73 } });
    expect((await otherHr.call('GET', `/ats/jobs/${jobId}/settings`)).status).toBe(404);
    expect((await otherHr.call('PUT', `/ats/jobs/${jobId}/settings`, { minAtsScore: 1 })).status).toBe(404);
    expect((await new Browser().call('GET', `/ats/jobs/${jobId}/settings`)).status).toBe(401);
    const stored = await db.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(JSON.stringify(stored.formData)).not.toMatch(/screening|minAtsScore|min_ats/i);
    for (const path of [`/${companySlug}/jobs/${jobSlug}`, `/${companySlug}/jobs`]) {
      const res = await pub('GET', path);
      expect(JSON.stringify(res.body)).not.toMatch(/screening|minAtsScore|min_ats/i);
    }
  });

  it('verifies the phone with OTP', async () => {
    const sent = await pub('POST', '/otp/send', { companySlug, phone });
    expect(sent.body.devCode).toMatch(/^\d{6}$/);
    const bad = await pub('POST', '/otp/verify', { companySlug, phone, code: sent.body.devCode === '000000' ? '111111' : '000000' });
    expect(bad.status).toBe(400);
    const ok = await pub('POST', '/otp/verify', { companySlug, phone, code: sent.body.devCode });
    otpToken = ok.body.otpToken;
    expect(otpToken).toBeTruthy();
    expect((await pub('POST', '/otp/send', { companySlug, phone })).status).toBe(429);
  });

  it('many parallel "send code" requests for one phone create exactly one code (per-phone lock)', async () => {
    const racer = `+9197${String(Date.now()).slice(-8)}`;
    const statuses = await Promise.all(Array.from({ length: 6 }, () => pub('POST', '/otp/send', { companySlug, phone: racer }).then((r) => r.status)));
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    expect(statuses.filter((s) => s === 429)).toHaveLength(5);
    expect(await db.phoneOtpChallenge.count({ where: { phone: racer } })).toBe(1);
  });

  const form = (resume: Buffer, name: string, overrides: Record<string, unknown> = {}) => {
    const fd = new FormData();
    fd.set('companySlug', companySlug);
    fd.set('jobSlug', jobSlug);
    fd.set(
      'application',
      JSON.stringify({
        name: 'Asha Patel', email: `asha.${RUN}@example.com`, phone, city: 'Ahmedabad',
        college: 'LD College of Engineering', degree: 'B.E.', branch: 'Computer', graduationYear: 2026,
        scoreType: 'CGPA', scoreValue: 8.4, experienceYears: 1.5, consents: { dataProcessing: true, aiEvaluation: true }, otpToken, source: 'linkedin',
        ...overrides,
      }),
    );
    fd.set('resume', new Blob([new Uint8Array(resume)]), name);
    return fd;
  };

  it('rejects wrong file types and infected files before saving anything', async () => {
    expect((await pub('POST', '/applications', form(Buffer.from('MZ fake exe'), 'cv.pdf'))).status).toBe(415);
    expect((await pub('POST', '/applications', form(Buffer.concat([PDF, Buffer.from(EICAR_SIGNATURE)]), 'cv.pdf'))).status).toBe(422);
    expect(await db.application.count({ where: { jobId } })).toBe(0);
  });

  it('refuses a project link that is not a full https link', async () => {
    const res = await pub('POST', '/applications', form(PDF, 'cv.pdf', { projectUrl: 'javascript:alert(1)' }));
    expect(res.status).toBe(400);
  });

  it('rejects an application whose phone was not verified', async () => {
    expect((await pub('POST', '/applications', form(PDF, 'cv.pdf', { otpToken: 'forged.token-value' }))).status).toBe(401);
  });

  it('saves the application against the approved version, resume details and bytes separately, and blocks duplicates', async () => {
    const res = await pub('POST', '/applications', form(PDF, 'Asha CV.pdf', { projectUrl: 'https://asha-todo.example.app' }));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ jobId, jobTitle: JD.title, confirmationEmailSent: false });

    const application = await db.application.findUniqueOrThrow({ where: { id: res.body.applicationId } });
    const approval = await db.jobApproval.findFirstOrThrow({ where: { jobId } });
    expect(application.jdVersionId).toBe(approval.jdVersionId);
    const resume = await db.resume.findUniqueOrThrow({ where: { applicationId: application.id } });
    expect(resume).toMatchObject({ mimeType: 'application/pdf', scanStatus: 'CLEAN', scannedBy: 'dev-eicar-only' });
    expect((await storedFile(db, resume)).equals(PDF)).toBe(true);
    expect(await db.consent.count({ where: { applicationId: application.id } })).toBe(2);
    expect(application.email).toBe(`asha.${RUN}@example.com`); // the email of THIS application, for dedupe
    expect(application.projectUrl).toBe('https://asha-todo.example.app');
    const forHr = await hr.call('GET', `/applications/jobs/${jobId}`);
    expect(forHr.body.applications[0]).toMatchObject({ projectUrl: 'https://asha-todo.example.app', portfolioUrl: null });

    expect((await pub('POST', '/applications', form(PDF, 'Asha CV.pdf'))).status).toBe(409);
    expect((await hr.call('GET', '/publisher/jobs')).body[0].applications).toBe(1);
  });

  it('blocks the same email from another phone for the same job (any letter case)', async () => {
    const other = `+9196${String(Date.now()).slice(-8)}`;
    const sent = await pub('POST', '/otp/send', { companySlug, phone: other });
    const ok = await pub('POST', '/otp/verify', { companySlug, phone: other, code: sent.body.devCode });
    const res = await pub('POST', '/applications', form(PDF, 'cv.pdf', { phone: other, otpToken: ok.body.otpToken, email: `ASHA.${RUN}@Example.com` }));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ALREADY_APPLIED');
    // The database enforces it too, whatever the letter case.
    const existing = await db.application.findFirstOrThrow({ where: { jobId } });
    const err = await db.$executeRawUnsafe(`UPDATE applications SET email = 'ASHA@X.IN' WHERE id = $1::uuid`, existing.id).catch((e: Error) => e);
    expect(String(err)).toMatch(/applications_email_lower_case/);
  });

  it('lets the student see their own data with a verified phone, and not without', async () => {
    const res = await pub('POST', '/my-data', { companySlug, phone, otpToken });
    expect(res.status).toBe(200);
    expect(res.body.candidate).toMatchObject({ name: 'Asha Patel', phone });
    expect(res.body.applications[0]).toMatchObject({ jobTitle: JD.title, resumeFileName: 'Asha CV.pdf' });
    expect((await pub('POST', '/my-data', { companySlug, phone, otpToken: 'forged.token-value' })).status).toBe(401);
  });

  it('closing the job stops applications; reopening allows them again', async () => {
    expect((await hr.call('POST', `/publisher/jobs/${jobId}/close`)).status).toBe(200);
    expect((await pub('GET', `/${companySlug}/jobs/${jobSlug}`)).body.status).toBe('CLOSED');
    expect((await pub('POST', '/applications', form(PDF, 'cv.pdf', { email: `late.${RUN}@example.com` }))).status).toBe(410);
    expect((await otherHr.call('POST', `/publisher/jobs/${jobId}/close`)).status).toBe(404);
    expect((await hr.call('POST', `/publisher/jobs/${jobId}/reopen`)).status).toBe(200);
    expect((await pub('GET', `/${companySlug}/jobs/${jobSlug}`)).body.status).toBe('LIVE');
    const actions = (await db.auditLog.findMany({ where: { subjectId: jobId }, orderBy: { createdAt: 'asc' } })).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['job.approved', 'job.published', 'job.closed', 'job.reopened']));
  });

  it('a feature flag can switch the public apply API off', async () => {
    process.env.FEATURE_APPLICATIONS = 'off';
    try {
      const res = await pub('GET', `/${companySlug}/jobs/${jobSlug}`);
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('FEATURE_DISABLED');
    } finally {
      delete process.env.FEATURE_APPLICATIONS;
    }
  });

  it('lets the parser role read new resumes from the view but not change anything', async () => {
    const rows = await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE hireflow_resume_reader');
      return tx.$queryRawUnsafe<{ job_id: string; jd_version_id: string; content: Buffer | null; storage_key: string | null }[]>(
        'SELECT job_id, jd_version_id, content, storage_key FROM parser_resume_inbox WHERE job_id = $1::uuid',
        jobId,
      );
    });
    expect(rows).toHaveLength(1);
    if (S3_MODE) {
      expect(rows[0]!.content).toBeNull(); // the parser reads the file from the bucket
      expect(rows[0]!.storage_key).toMatch(/\/resumes\/.+\.pdf$/);
    } else {
      expect(Buffer.from(rows[0]!.content!).equals(PDF)).toBe(true);
    }

    for (const sql of ['SELECT 1 FROM resumes LIMIT 1', 'DELETE FROM resume_files', 'UPDATE parser_resume_inbox SET file_name = $1']) {
      const err = await db
        .$transaction(async (tx) => {
          await tx.$executeRawUnsafe('SET LOCAL ROLE hireflow_resume_reader');
          return tx.$executeRawUnsafe(sql, ...(sql.includes('$1') ? ['x'] : []));
        })
        .catch((e: Error) => e);
      expect(String(err)).toMatch(/permission denied|cannot update view/i);
    }
  });

  it('erases everything about the student on request, and the parser no longer sees the resume', async () => {
    const del = await pub('POST', '/my-data/delete', { companySlug, phone, otpToken, confirm: true });
    expect(del.status).toBe(200);
    expect(del.body).toEqual({ deletedApplications: 1 });
    expect(await db.application.count({ where: { jobId } })).toBe(0);
    expect(await db.candidate.count({ where: { phone } })).toBe(0);
    const inbox = await db.$queryRawUnsafe<unknown[]>('SELECT 1 FROM parser_resume_inbox WHERE job_id = $1::uuid', jobId);
    expect(inbox).toHaveLength(0);
    const audit = await db.auditLog.findMany({ where: { action: { startsWith: 'candidate.' }, metadata: { path: ['actor'], equals: 'candidate' } }, orderBy: { createdAt: 'desc' }, take: 2 });
    expect(audit.map((a) => a.action).sort()).toEqual(['candidate.data_deleted', 'candidate.data_viewed']);
    expect(JSON.stringify(audit)).not.toContain('Asha');
  });
});
