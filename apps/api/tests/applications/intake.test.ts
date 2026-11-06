import { HttpException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { ApplicationsService, candidateEmailKey, uniqueViolation } from '../../src/modules/applications/applications.service';
import { MyDataService } from '../../src/modules/applications/my-data.service';
import { OtpService } from '../../src/modules/applications/otp/otp.service';
import {
  DatabaseResumeStorage,
  ResumeStorageError,
  type ResumeStorage,
} from '../../src/modules/applications/resume/resume-storage';
import { PDF } from './fixtures';

/**
 * Service logic with a fake Prisma (no database): the OTP lock, intake conflict handling and the DPDP delete.
 * The same paths against a real PostgreSQL are in flow.db.test.ts.
 */
const TENANT = '0192f3a1-0000-7000-8000-000000000001';
const tick = () => new Promise((r) => setTimeout(r, 1));
const prismaError = (code: string, meta: Record<string, unknown>) =>
  new Prisma.PrismaClientKnownRequestError(`${code} test`, { code, clientVersion: 'test', meta });
const errorOf = async (p: Promise<unknown>) => (await p.then(() => undefined, (e: unknown) => e)) as HttpException;

describe('OtpService.send', () => {
  /** A fake DB where every query yields, so parallel requests interleave like they do on a real connection pool. */
  function fakeDb() {
    const rows: { tenantId: string; phone: string; createdAt: Date }[] = [];
    const locks = new Map<string, Promise<void>>();
    const sql: string[] = [];
    const db = {
      async $transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
        let release = () => {};
        const tx = {
          // pg_advisory_xact_lock: wait while another transaction holds the same key; freed at commit/rollback.
          $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
            sql.push(strings.join('?'));
            const key = values.join(':');
            while (locks.has(key)) await locks.get(key);
            locks.set(key, new Promise<void>((r) => (release = () => (locks.delete(key), r()))));
            return 1;
          },
          phoneOtpChallenge: {
            findMany: async ({ where }: { where: { tenantId: string; phone: string } }) => {
              await tick();
              return rows.filter((r) => r.tenantId === where.tenantId && r.phone === where.phone).reverse();
            },
            create: async ({ data }: { data: { tenantId: string; phone: string; createdAt: Date } }) => {
              await tick();
              rows.push(data);
            },
          },
        };
        try {
          return await fn(tx);
        } finally {
          release();
        }
      },
    };
    return { db, rows, sql };
  }

  it('lets only one of many parallel "send code" requests for a phone through (30 s gap holds)', async () => {
    const { db, rows, sql } = fakeDb();
    const sender = { kind: 'dev' as const, send: vi.fn().mockResolvedValue(undefined) };
    const otp = new OtpService(db as never, sender, 'x'.repeat(32));
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => otp.send(TENANT, '+919876543210')));

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const codes = results.flatMap((r) => (r.status === 'rejected' ? [(r.reason as HttpException).getResponse()] : []));
    expect(codes).toEqual(Array(4).fill(expect.objectContaining({ code: 'OTP_TOO_SOON' })));
    expect(rows).toHaveLength(1);
    expect(sender.send).toHaveBeenCalledTimes(1);
    expect(sql[0]).toMatch(/pg_advisory_xact_lock\(hashtext\(/);
  });

  it('different phones do not wait for each other', async () => {
    const { db, rows } = fakeDb();
    const otp = new OtpService(db as never, { kind: 'dev', send: async () => {} }, 'x'.repeat(32));
    await Promise.all([otp.send(TENANT, '+919876543210'), otp.send(TENANT, '+919876543211')]);
    expect(rows).toHaveLength(2);
  });
});

describe('uniqueViolation', () => {
  it('tells an application duplicate from the candidate-create race', () => {
    expect(uniqueViolation(prismaError('P2002', { modelName: 'Candidate', target: ['tenant_id', 'phone'] }))).toBe('candidate');
    expect(uniqueViolation(prismaError('P2002', { target: 'candidates_tenant_id_phone_key' }))).toBe('candidate');
    expect(uniqueViolation(prismaError('P2002', { modelName: 'Application', target: ['tenant_id', 'job_id', 'email'] }))).toBe('application');
    expect(uniqueViolation(prismaError('P2002', { target: 'applications_tenant_id_job_id_candidate_id_key' }))).toBe('application');
    expect(uniqueViolation(prismaError('P2002', { target: ['tenantId', 'jobId', 'candidateId'] }))).toBe('application');
    expect(uniqueViolation(prismaError('P2002', { modelName: 'Resume', target: ['id'] }))).toBeUndefined();
    expect(uniqueViolation(prismaError('P2003', {}))).toBeUndefined();
    expect(uniqueViolation(new Error('x'))).toBeUndefined();
  });
});

describe('ApplicationsService.submit', () => {
  const FORM = {
    name: 'Asha Patel', email: 'Asha.Patel@Example.com', phone: '98765 43210', city: 'Ahmedabad', college: 'LDCE', degree: 'B.E.',
    branch: 'Computer', graduationYear: 2026, scoreType: 'CGPA', scoreValue: 8.4, experienceYears: 1, consents: { dataProcessing: true, aiEvaluation: true },
    otpToken: 'signed-proof-token',
  };
  const found = {
    view: { status: 'LIVE', jd: { title: 'Backend Intern' } },
    company: { tenantId: TENANT, slug: 'acme', name: 'Acme', careersPageUrl: null },
    listing: { jobId: 'job-1', slug: 'backend-intern', approved: { jdVersionId: 'jdv-1' } },
  };

  function setup(
    failures: { candidate?: unknown[]; application?: unknown[]; duplicate?: boolean; closedBeforeSave?: boolean } = {},
    storage: ResumeStorage = new DatabaseResumeStorage(),
  ) {
    const candidateFails = [...(failures.candidate ?? [])];
    const applicationFails = [...(failures.application ?? [])];
    const calls = {
      transactions: 0,
      findFirst: [] as unknown[],
      created: [] as Record<string, unknown>[],
      resumes: [] as Record<string, unknown>[],
      resumeFiles: 0,
    };
    const tx = {
      // The listing status re-read (FOR SHARE) at the start of the save transaction.
      $queryRaw: async () => [{ status: failures.closedBeforeSave ? 'CLOSED' : 'LIVE' }],
      application: {
        findFirst: async (q: unknown) => (calls.findFirst.push(q), failures.duplicate ? { id: 'old' } : null),
        create: async ({ data }: { data: Record<string, unknown> }) => {
          const fail = applicationFails.shift();
          if (fail) throw fail;
          calls.created.push(data);
        },
      },
      candidate: {
        upsert: async () => {
          const fail = candidateFails.shift();
          if (fail) throw fail;
          return { id: 'cand-1' };
        },
      },
      resume: { create: async ({ data }: { data: Record<string, unknown> }) => (calls.resumes.push(data), {}) },
      resumeFile: { create: async () => (calls.resumeFiles++, {}) },
      consent: { createMany: async () => ({}) },
    };
    const db = { application: tx.application, $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => (calls.transactions++, fn(tx)) };
    const jobs = { job: async () => found, urls: () => ({ jobPage: 'https://c/acme/jobs/x', myData: 'https://c/acme/my-data' }) };
    const emails = { enabled: true, enqueue: vi.fn() };
    const service = new ApplicationsService(
      db as never,
      jobs as never,
      { checkProof: () => ({}) } as never,
      { name: 'test', scan: async () => 'clean' } as never,
      emails as never,
      storage,
    );
    const submit = () =>
      service.submit({ companySlug: 'acme', jobSlug: 'backend-intern', application: JSON.stringify(FORM), resume: { buffer: PDF, originalname: 'cv.pdf' } });
    return { submit, calls, emails };
  }

  it('dedupes by the email typed on the application (lower-case) or the phone, and stores that email', async () => {
    const { submit, calls, emails } = setup();
    const receipt = await submit();
    expect(calls.findFirst[0]).toEqual({
      where: { tenantId: TENANT, jobId: 'job-1', OR: [{ email: 'asha.patel@example.com' }, { candidate: { phone: '+919876543210' } }] },
      select: { id: true },
    });
    expect(calls.created[0]).toMatchObject({ email: 'asha.patel@example.com', candidateId: 'cand-1' });
    // Queued (not yet sent), with the candidate key so a data deletion can cancel it.
    expect(receipt.confirmationEmailSent).toBe(true);
    expect(emails.enqueue).toHaveBeenCalledWith(expect.objectContaining({ key: candidateEmailKey(TENANT, 'cand-1') }));
  });

  it('refuses with 410 JOB_CLOSED when HR closed the job while the resume was being checked', async () => {
    const { submit, calls, emails } = setup({ closedBeforeSave: true });
    const err = await errorOf(submit());
    expect(err.getStatus()).toBe(410);
    expect(err.getResponse()).toMatchObject({ code: 'JOB_CLOSED', message: "We're sorry, this job is no longer open." });
    expect(calls.created).toHaveLength(0);
    expect(emails.enqueue).not.toHaveBeenCalled();
  });

  it('retries once when a parallel apply of the same new phone (another job) created the candidate first', async () => {
    const { submit, calls } = setup({ candidate: [prismaError('P2002', { modelName: 'Candidate', target: ['tenant_id', 'phone'] })] });
    expect((await submit()).jobId).toBe('job-1');
    expect(calls.transactions).toBe(2);
  });

  it('does not loop: a second candidate conflict is a real error, not "already applied"', async () => {
    const conflict = () => prismaError('P2002', { modelName: 'Candidate', target: ['tenant_id', 'phone'] });
    const { submit, calls } = setup({ candidate: [conflict(), conflict()] });
    const err = await errorOf(submit());
    expect(err).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect(calls.transactions).toBe(2);
  });

  it.each([
    [{ modelName: 'Application', target: ['tenant_id', 'job_id', 'email'] }],
    [{ modelName: 'Application', target: ['tenant_id', 'job_id', 'candidate_id'] }],
  ])('maps a lost race on the application unique indexes to 409 ALREADY_APPLIED (%#)', async (meta) => {
    const { submit, calls } = setup({ application: [prismaError('P2002', meta)] });
    const err = await errorOf(submit());
    expect(err.getStatus()).toBe(409);
    expect(err.getResponse()).toMatchObject({ code: 'ALREADY_APPLIED' });
    expect(calls.transactions).toBe(1);
  });

  it('keeps the bytes in the database when no cloud storage is configured (local dev)', async () => {
    const { submit, calls } = setup();
    await submit();
    expect(calls.resumes[0]).toMatchObject({ storageKey: null });
    expect(calls.resumeFiles).toBe(1);
  });

  describe('with cloud storage (S3)', () => {
    const fakeS3 = (fail = false) => {
      const files = new Map<string, Buffer>();
      const storage: ResumeStorage = {
        kind: 's3',
        put: vi.fn(async (key: string, bytes: Buffer) => {
          if (fail) throw new ResumeStorageError('TimeoutError');
          files.set(key, bytes);
        }),
        get: vi.fn(async (key: string) => {
          const bytes = files.get(key);
          if (!bytes) throw new ResumeStorageError('NoSuchKey');
          return bytes;
        }),
        delete: vi.fn(async (keys: string[]) => void keys.forEach((k) => files.delete(k))),
      };
      return { storage, files };
    };

    it('uploads the file first and records only its key: no bytes in the database', async () => {
      const { storage, files } = fakeS3();
      const { submit, calls } = setup({}, storage);
      await submit();
      const key = calls.resumes[0]!.storageKey as string;
      expect(key).toBe(`${TENANT}/resumes/${calls.resumes[0]!.id}.pdf`); // never the student's file name
      expect(files.get(key)).toEqual(PDF);
      expect(calls.resumeFiles).toBe(0);
    });

    it('removes the uploaded file again when the record cannot be saved', async () => {
      const { storage, files } = fakeS3();
      const { submit } = setup({ application: [prismaError('P2002', { modelName: 'Application', target: ['tenant_id', 'job_id', 'email'] })] }, storage);
      expect((await errorOf(submit())).getStatus()).toBe(409);
      expect(storage.delete).toHaveBeenCalledTimes(1);
      expect(files.size).toBe(0);
    });

    it('answers 503 (and saves nothing) when the storage is down', async () => {
      const { storage } = fakeS3(true);
      const { submit, calls } = setup({}, storage);
      const err = await errorOf(submit());
      expect(err.getStatus()).toBe(503);
      expect(err.getResponse()).toMatchObject({ code: 'RESUME_STORAGE_UNAVAILABLE' });
      expect(calls.transactions).toBe(0);
    });

    it('does not upload anything for a repeat submit', async () => {
      const { storage } = fakeS3();
      const { submit } = setup({ duplicate: true }, storage);
      expect((await errorOf(submit())).getResponse()).toMatchObject({ code: 'ALREADY_APPLIED' });
      expect(storage.put).not.toHaveBeenCalled();
    });
  });
});

describe('MyDataService.erase', () => {
  function setup(fail?: unknown, storageFails = false) {
    const sql: string[] = [];
    const tx = {
      phoneOtpChallenge: { deleteMany: async () => ({}) },
      $queryRaw: async (strings: TemplateStringsArray) => (sql.push(strings.join('?')), [{ id: 'cand-1' }]),
      application: {
        findMany: async () => [{ id: 'app-1' }],
        deleteMany: async () => {
          if (fail) throw fail;
          return { count: 1 };
        },
      },
      resume: { findMany: async () => [{ id: 'res-1', storageKey: `${TENANT}/resumes/res-1.pdf` }, { id: 'res-0', storageKey: null }], deleteMany: async () => ({}) },
      resumeFile: { deleteMany: async () => ({}) },
      consent: { deleteMany: async () => ({}) },
      candidate: { delete: async () => ({}) },
    };
    // No candidate lookup outside the transaction: `db` has only $transaction.
    const db = { $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx) };
    const emails = { cancel: vi.fn().mockReturnValue(1) };
    const audit = { record: vi.fn().mockResolvedValue(undefined) };
    const storage = {
      kind: 's3' as const,
      put: vi.fn(),
      delete: vi.fn(async () => {
        if (storageFails) throw new ResumeStorageError('AccessDenied');
      }),
    };
    const service = new MyDataService(
      db as never,
      { company: async () => ({ tenantId: TENANT }) } as never,
      { checkProof: () => ({}) } as never,
      audit as never,
      emails as never,
      storage,
    );
    const erase = () => service.erase({ companySlug: 'acme', phone: '9876543210', otpToken: 'signed-proof-token', confirm: true });
    return { erase, sql, emails, audit, storage };
  }

  it('locks the candidate inside the delete transaction and cancels their queued emails afterwards', async () => {
    const { erase, sql, emails, audit } = setup();
    expect(await erase()).toEqual({ deletedApplications: 1 });
    expect(sql[0]).toMatch(/FROM "candidates" WHERE .* FOR UPDATE/);
    expect(emails.cancel).toHaveBeenCalledWith(candidateEmailKey(TENANT, 'cand-1'));
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'candidate.data_deleted', subjectId: 'cand-1' }));
  });

  it('answers a clear, retryable 409 (not 500) when a new reference blocks the delete; nothing is cancelled', async () => {
    const { erase, emails, audit } = setup(prismaError('P2003', { field_name: 'consents_application_id_fkey' }));
    const err = await errorOf(erase());
    expect(err.getStatus()).toBe(409);
    expect(err.getResponse()).toMatchObject({ code: 'DELETE_CONFLICT', retryable: true });
    expect(emails.cancel).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('deletes the resume files from cloud storage after the records', async () => {
    const { erase, storage } = setup();
    await erase();
    expect(storage.delete).toHaveBeenCalledWith([`${TENANT}/resumes/res-1.pdf`]);
  });

  it('still erases the records when the storage delete fails (logged for an operator)', async () => {
    const { erase, audit } = setup(undefined, true);
    expect(await erase()).toEqual({ deletedApplications: 1 });
    expect(audit.record).toHaveBeenCalled();
  });
});
