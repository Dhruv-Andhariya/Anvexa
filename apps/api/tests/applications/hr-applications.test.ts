import { HttpException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../src/common/prisma.service';
import type { AuditService } from '../../src/modules/audit';
import { attachmentHeader } from '../../src/modules/applications/hr-applications.controller';
import { HrApplicationsService } from '../../src/modules/applications/hr-applications.service';
import { DatabaseResumeStorage, ResumeStorageError, type ResumeStorage } from '../../src/modules/applications/resume/resume-storage';
import type { PublicJobsReader } from '../../src/modules/publisher';

const TENANT = '0192f3a1-0000-7000-8000-000000000001';
const OTHER_TENANT = '0192f3a1-0000-7000-8000-000000000002';
const JOB = '0192f3a1-7c2e-7a10-8b2c-123456789abc';
const APP = '0192f3a1-7c2e-7a10-8b2c-aaaaaaaaaaaa';
const actor = { id: 'user-1', name: 'HR' };

const appRow = {
  id: APP,
  tenantId: TENANT,
  jobId: JOB,
  createdAt: new Date('2026-10-15T11:05:32Z'),
  state: 'APPLIED',
  source: 'linkedin',
  email: 'asha@example.com',
  college: 'LD College',
  degree: 'B.E.',
  branch: 'Computer',
  graduationYear: 2026,
  scoreType: 'CGPA',
  scoreValue: { toNumber: () => 8.4 },
  experienceYears: { toNumber: () => 2.5 },
  linkedinUrl: null,
  githubUrl: 'https://github.com/asha',
  portfolioUrl: null,
  projectUrl: 'https://asha-todo.example.app',
  candidate: { name: 'Asha Patel', email: 'old@example.com', phone: '+919876543210', city: 'Ahmedabad' },
  resume: { fileName: 'Asha.pdf', mimeType: 'application/pdf', sizeBytes: 795 },
};

function setup(opts: { resume?: unknown; storage?: ResumeStorage } = {}) {
  const db = {
    application: { findMany: vi.fn(async ({ where }: { where: { tenantId: string } }) => (where.tenantId === TENANT ? [appRow] : [])) },
    resume: { findFirst: vi.fn(async () => opts.resume ?? null) },
  };
  const jobs = {
    jobTitles: vi.fn(async (tenantId: string, ids: string[]) =>
      new Map(tenantId === TENANT ? ids.filter((id) => id === JOB).map((id) => [id, 'Junior Backend Developer']) : []),
    ),
  };
  const audit = { record: vi.fn(async () => {}) };
  const service = new HrApplicationsService(
    db as unknown as PrismaService,
    jobs as unknown as PublicJobsReader,
    audit as unknown as AuditService,
    opts.storage ?? new DatabaseResumeStorage(),
  );
  return { service, db, audit };
}

const codeOf = async (p: Promise<unknown>) => {
  const err = await p.then(() => undefined, (e: unknown) => e);
  expect(err).toBeInstanceOf(HttpException);
  return ((err as HttpException).getResponse() as { code: string }).code;
};

describe('HrApplicationsService.listForJob', () => {
  it('lists the job applications with student details, application email first', async () => {
    const { service, db } = setup();
    const res = await service.listForJob(TENANT, JOB);
    expect(db.application.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: TENANT, jobId: JOB } }));
    expect(res.jobTitle).toBe('Junior Backend Developer');
    expect(res.applications).toEqual([
      expect.objectContaining({ applicationId: APP, name: 'Asha Patel', email: 'asha@example.com', scoreValue: 8.4, experienceYears: 2.5, githubUrl: 'https://github.com/asha' }),
    ]);
  });

  it("another company's job is a 404", async () => {
    const { service, db } = setup();
    expect(await codeOf(service.listForJob(OTHER_TENANT, JOB))).toBe('JOB_NOT_FOUND');
    expect(db.application.findMany).not.toHaveBeenCalled();
  });
});

describe('HrApplicationsService.resume', () => {
  it('reads a local-dev resume from resume_files and audits the download', async () => {
    const content = Buffer.from('%PDF-1.4 test');
    const { service, db, audit } = setup({
      resume: { id: 'r1', fileName: 'Asha.pdf', mimeType: 'application/pdf', storageKey: null, file: { content } },
    });
    const file = await service.resume(TENANT, APP, actor);
    expect(db.resume.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: TENANT, applicationId: APP } }));
    expect(file).toEqual({ fileName: 'Asha.pdf', mimeType: 'application/pdf', bytes: content });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT, actorUserId: 'user-1', action: 'application.resume_downloaded', subjectId: APP }),
    );
  });

  it('reads an S3 resume through the storage', async () => {
    const bytes = Buffer.from('docx bytes');
    const storage: ResumeStorage = { kind: 's3', put: vi.fn(), delete: vi.fn(), get: vi.fn(async () => bytes) };
    const { service } = setup({
      storage,
      resume: { id: 'r1', fileName: 'cv.docx', mimeType: 'x', storageKey: `${TENANT}/resumes/r1.docx`, file: null },
    });
    expect((await service.resume(TENANT, APP, actor)).bytes).toBe(bytes);
    expect(storage.get).toHaveBeenCalledWith(`${TENANT}/resumes/r1.docx`);
  });

  it('storage failure is a 502, missing resume a 404, and neither is audited', async () => {
    const storage: ResumeStorage = {
      kind: 's3',
      put: vi.fn(),
      delete: vi.fn(),
      get: vi.fn(async () => {
        throw new ResumeStorageError('AccessDenied');
      }),
    };
    const failing = setup({ storage, resume: { id: 'r1', fileName: 'a.pdf', mimeType: 'x', storageKey: 'k', file: null } });
    expect(await codeOf(failing.service.resume(TENANT, APP, actor))).toBe('RESUME_STORAGE_FAILED');
    expect(failing.audit.record).not.toHaveBeenCalled();

    const missing = setup();
    expect(await codeOf(missing.service.resume(OTHER_TENANT, APP, actor))).toBe('RESUME_NOT_FOUND');
  });
});

describe('attachmentHeader', () => {
  it('keeps the real name in filename* and a safe ASCII fallback', () => {
    expect(attachmentHeader('Naina_Resume (5).pdf')).toBe(
      `attachment; filename="Naina_Resume (5).pdf"; filename*=UTF-8''Naina_Resume%20(5).pdf`,
    );
    expect(attachmentHeader('रिज़्यूमे "x".pdf')).toMatch(/^attachment; filename="[_ ]+_x_\.pdf"; filename\*=UTF-8''/);
  });
});
