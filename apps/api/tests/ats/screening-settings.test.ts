import 'reflect-metadata';
import { HttpException } from '@nestjs/common';
import { jobFormSchema, publicJobSchema } from '@hireflow/contracts';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../src/common/prisma.service';
import { ScreeningSettingsService } from '../../src/modules/ats';
import { isMissingTable } from '../../src/modules/ats/screening-settings.service';
import { JobsService } from '../../src/modules/jobs/jobs.service';
import type { AiWorkerClient } from '../../src/modules/jobs/ai-worker.client';
import type { CompanyProfileService } from '../../src/modules/tenants';
import { FixedTenant, InMemoryJobs, MemoryAudit } from '../in-memory';

const TENANT = '0192f3a1-0000-7000-8000-000000000001';
const JOB = '0192f3a1-7c2e-7a10-8b2c-123456789abc';
const ACTOR = { id: '0192f3a1-0000-7000-8000-0000000000aa', name: 'Priya Shah' };
const FORM = {
  title: 'Junior Backend Developer',
  experienceMin: 0,
  experienceMax: 2,
  mustHaveSkills: ['Node.js', 'SQL', 'REST'],
  locations: ['Ahmedabad'],
  workMode: 'HYBRID',
  employmentType: 'FULL_TIME',
};
const missingTable = () => Object.assign(new Error('The table `job_screening_settings` does not exist'), { code: 'P2021' });

/** Fake Prisma with only what the settings service uses. jobOwner = the tenant that owns JOB. */
function fakeDb(jobOwner: string | null = TENANT) {
  const saved = new Map<string, { jobId: string; tenantId: string; minAtsScore: number; updatedAt: Date }>();
  const evaluations = { updateMany: vi.fn().mockResolvedValue({ count: 0 }), findMany: vi.fn().mockResolvedValue([]) };
  const emails = { createMany: vi.fn().mockResolvedValue({ count: 0 }) };
  const settings = {
    findFirst: vi.fn(async ({ where }: { where: { tenantId: string; jobId: string } }) => {
      const row = saved.get(where.jobId);
      return row && row.tenantId === where.tenantId ? row : null;
    }),
    upsert: vi.fn(async ({ create, update }: { create: { jobId: string; tenantId: string; minAtsScore: number }; update: { minAtsScore: number } }) => {
      const row = { ...create, ...update, updatedAt: new Date('2026-10-26T10:00:00Z') };
      saved.set(create.jobId, row);
      return row;
    }),
  };
  const db = {
    job: { findFirst: vi.fn(async ({ where }: { where: { id: string; tenantId: string } }) => (where.tenantId === jobOwner && where.id === JOB ? { id: JOB } : null)) },
    jobScreeningSettings: settings,
    atsEvaluation: evaluations,
    candidateEmail: emails,
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(db)),
  };
  return { db: db as unknown as PrismaService, raw: db, saved };
}

const service = (db: PrismaService, audit = new MemoryAudit(), autoReject = false, autoShortlist = false) =>
  new ScreeningSettingsService(db, audit as never, autoReject, autoShortlist);

describe('ScreeningSettingsService', () => {
  it('saves the minimum ATS score for the company’s own job and audits it', async () => {
    const { db, raw } = fakeDb();
    const audit = new MemoryAudit();
    const res = await service(db, audit).save(TENANT, JOB, { minAtsScore: 75 }, ACTOR);
    expect(res).toEqual({ jobId: JOB, settings: { minAtsScore: 75 }, updatedAt: '2026-10-26T10:00:00.000Z' });
    expect(raw.jobScreeningSettings.upsert).toHaveBeenCalledWith(expect.objectContaining({ create: expect.objectContaining({ tenantId: TENANT, minAtsScore: 75 }) }));
    expect(audit.entries.at(-1)).toMatchObject({ action: 'ats.settings_updated', subjectId: JOB, actorUserId: ACTOR.id });
    expect(await service(db).get(TENANT, JOB)).toMatchObject({ settings: { minAtsScore: 75 } });
  });

  it('re-sorts only candidates nobody decided on or emailed yet, against the new score', async () => {
    const { db, raw } = fakeDb();
    await service(db).save(TENANT, JOB, { minAtsScore: 60 }, ACTOR);
    const calls = raw.atsEvaluation.updateMany.mock.calls.map((c) => c[0]);
    expect(calls).toHaveLength(2);
    for (const c of calls) {
      expect(c.where).toMatchObject({ tenantId: TENANT, jobId: JOB, status: 'SCORED', hrDecision: null, application: { decisionEmail: { is: null } } });
    }
    expect(calls[0]).toMatchObject({ where: { score: { gte: 60 } }, data: { systemDecision: 'SHORTLISTED', minAtsScore: 60 } });
    expect(calls[1]).toMatchObject({ where: { score: { lt: 60 } }, data: { systemDecision: 'NOT_SHORTLISTED', minAtsScore: 60 } });
  });

  it('with automatic rejections on, the candidates now below the score are emailed (once each)', async () => {
    const { db, raw } = fakeDb();
    raw.atsEvaluation.findMany.mockResolvedValue([{ applicationId: 'app-1' }, { applicationId: 'app-2' }]);
    const audit = new MemoryAudit();
    await service(db, audit, true).save(TENANT, JOB, { minAtsScore: 80 }, ACTOR);
    const where = raw.atsEvaluation.findMany.mock.calls[0]![0].where;
    expect(where).toMatchObject({ tenantId: TENANT, jobId: JOB, status: 'SCORED', application: { decisionEmail: { is: null } } });
    const created = raw.candidateEmail.createMany.mock.calls[0]![0];
    expect(created.skipDuplicates).toBe(true);
    expect(created.data.map((d: { applicationId: string; kind: string }) => [d.applicationId, d.kind])).toEqual([['app-1', 'REJECTION'], ['app-2', 'REJECTION']]);
    expect(audit.entries.at(-1)!.metadata).toMatchObject({ autoRejected: 2 });

    const off = fakeDb();
    await service(off.db, new MemoryAudit(), false).save(TENANT, JOB, { minAtsScore: 80 }, ACTOR);
    expect(off.raw.candidateEmail.createMany).not.toHaveBeenCalled();
  });

  it.each([[-1], [101], [74.5], ['75'], [null]])('rejects %j as a minimum ATS score', async (minAtsScore) => {
    const { db, raw } = fakeDb();
    const err = await service(db).save(TENANT, JOB, { minAtsScore }, ACTOR).catch((e) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect(err.getStatus()).toBe(400);
    expect(raw.jobScreeningSettings.upsert).not.toHaveBeenCalled();
  });

  it('another company’s job is a 404 for reading and saving', async () => {
    const { db, raw } = fakeDb('0192f3a1-0000-7000-8000-000000000999');
    for (const call of [() => service(db).get(TENANT, JOB), () => service(db).save(TENANT, JOB, { minAtsScore: 70 }, ACTOR)]) {
      expect((await call().catch((e) => e)).getStatus()).toBe(404);
    }
    expect(raw.jobScreeningSettings.upsert).not.toHaveBeenCalled();
  });

  it('without the ATS migration: reading/saving says "not set up" (503), the publish check lets publishing go on', async () => {
    const { db, raw } = fakeDb();
    raw.jobScreeningSettings.findFirst.mockRejectedValue(missingTable());
    raw.$transaction.mockRejectedValue(missingTable());
    expect((await service(db).get(TENANT, JOB).catch((e) => e)).getResponse()).toMatchObject({ code: 'ATS_NOT_READY' });
    expect((await service(db).save(TENANT, JOB, { minAtsScore: 70 }, ACTOR).catch((e) => e)).getStatus()).toBe(503);
    expect(await service(db).isSet(TENANT, JOB)).toBe(true);
  });
});

describe('creating a job with a minimum ATS score', () => {
  const jobsService = (screening?: ScreeningSettingsService) => {
    const repo = new InMemoryJobs();
    const companies = { require: vi.fn().mockResolvedValue(undefined) } as unknown as CompanyProfileService;
    const svc = new JobsService(new FixedTenant(TENANT, ACTOR), companies, repo, {} as AiWorkerClient, new MemoryAudit() as never, screening);
    return { svc, repo };
  };

  it('saves the score apart from the job form - the stored (public) form never contains it', async () => {
    const save = vi.fn().mockResolvedValue({});
    const { svc, repo } = jobsService({ save } as unknown as ScreeningSettingsService);
    const job = await svc.create({ ...FORM, screening: { minAtsScore: 75 } });
    expect(save).toHaveBeenCalledWith(TENANT, job.id, { minAtsScore: 75 }, ACTOR);
    const stored = repo.jobs.get(job.id)!.form as Record<string, unknown>;
    expect(stored).not.toHaveProperty('screening');
    expect(JSON.stringify(stored)).not.toContain('75');
    expect(JSON.stringify(job)).not.toContain('minAtsScore');
  });

  it('an invalid score stops the request before any job is created', async () => {
    const save = vi.fn();
    const { svc, repo } = jobsService({ save } as unknown as ScreeningSettingsService);
    const err = await svc.create({ ...FORM, screening: { minAtsScore: 150 } }).catch((e) => e);
    expect(err.getStatus()).toBe(400);
    expect(err.getResponse()).toMatchObject({ code: 'INVALID_SCREENING_SETTINGS' });
    expect(repo.jobs.size).toBe(0);
    expect(save).not.toHaveBeenCalled();
  });

  it('the job is still created when saving the score fails (HR sets it again on the job page)', async () => {
    const save = vi.fn().mockRejectedValue(new Error('db down'));
    const { svc, repo } = jobsService({ save } as unknown as ScreeningSettingsService);
    await svc.create({ ...FORM, screening: { minAtsScore: 75 } });
    expect(repo.jobs.size).toBe(1);
  });
});

describe('the minimum ATS score is never public', () => {
  it('is not a job form field, so the public job (form) can never carry it', () => {
    const parsed = jobFormSchema.parse({ ...FORM, minAtsScore: 75, screening: { minAtsScore: 75 } });
    expect(parsed).not.toHaveProperty('minAtsScore');
    expect(parsed).not.toHaveProperty('screening');
    const formKeys = Object.keys(publicJobSchema.shape.form._def.schema._def.schema.shape);
    expect(formKeys.some((k) => /ats|screen|threshold/i.test(k))).toBe(false);
    expect(Object.keys(publicJobSchema.shape).some((k) => /ats|screen|threshold/i.test(k))).toBe(false);
  });
});

describe('isMissingTable', () => {
  it('knows "no such table" from normal and raw queries, and nothing else', () => {
    expect(isMissingTable({ code: 'P2021' })).toBe(true);
    expect(isMissingTable({ code: 'P2010', meta: { code: '42P01', message: 'relation "candidate_emails" does not exist' } })).toBe(true);
    expect(isMissingTable({ code: 'P2010', meta: { code: '23505' } })).toBe(false);
    expect(isMissingTable({ code: 'P2002' })).toBe(false);
    expect(isMissingTable(null)).toBe(false);
  });
});

describe('autoRejectionFromEnv', () => {
  it('is on unless switched off', async () => {
    const { autoRejectionFromEnv } = await import('../../src/modules/ats/auto-rejection');
    expect(autoRejectionFromEnv({})).toBe(true);
    expect(autoRejectionFromEnv({ AUTO_REJECTION_EMAILS: 'on' })).toBe(true);
    for (const v of ['off', 'false', '0', ' OFF ']) expect(autoRejectionFromEnv({ AUTO_REJECTION_EMAILS: v })).toBe(false);
  });
});

describe('automatic shortlist emails', () => {
  it('with automatic shortlists on, the candidates at or above the score get the shortlist email (once each)', async () => {
    const { db, raw } = fakeDb();
    raw.atsEvaluation.findMany.mockResolvedValue([{ applicationId: 'app-3' }]);
    const audit = new MemoryAudit();
    await service(db, audit, false, true).save(TENANT, JOB, { minAtsScore: 70 }, ACTOR);
    const where = raw.atsEvaluation.findMany.mock.calls[0]![0].where;
    expect(where).toMatchObject({ tenantId: TENANT, jobId: JOB, status: 'SCORED', application: { decisionEmail: { is: null } } });
    expect(where.OR).toEqual([{ hrDecision: 'SHORTLISTED' }, { hrDecision: null, systemDecision: 'SHORTLISTED' }]);
    const created = raw.candidateEmail.createMany.mock.calls[0]![0];
    expect(created.skipDuplicates).toBe(true);
    expect(created.data.map((d: { applicationId: string; kind: string }) => [d.applicationId, d.kind])).toEqual([['app-3', 'SHORTLIST']]);
    expect(audit.entries.at(-1)!.metadata).toMatchObject({ autoShortlisted: 1 });
  });

  it('is on by default and needs no HR click (the sender holds the email until the link is public)', async () => {
    const { autoShortlistFromEnv } = await import('../../src/modules/ats/auto-rejection');
    expect(autoShortlistFromEnv({})).toBe(true);
    expect(autoShortlistFromEnv({ AUTO_SHORTLIST_EMAILS: 'on' })).toBe(true);
    for (const v of ['off', 'false', '0']) expect(autoShortlistFromEnv({ AUTO_SHORTLIST_EMAILS: v })).toBe(false);
    const { isPublicLink } = await import('../../src/modules/ats/decision-email.sender');
    expect(isPublicLink('http://localhost:3300/screening/{token}')).toBe(false);
    expect(isPublicLink('https://abc.trycloudflare.com/screening/{token}')).toBe(true);
  });
});
