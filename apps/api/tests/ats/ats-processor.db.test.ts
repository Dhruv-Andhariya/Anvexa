import 'reflect-metadata';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../src/common/prisma.service';
import { AtsProcessor, type AtsProcessorConfig } from '../../src/modules/ats/ats-processor.service';
import { AtsWorkerError, type AtsWorkerClient, type ScreenInput } from '../../src/modules/ats/ats-worker.client';
import { ScreeningSettingsService } from '../../src/modules/ats/screening-settings.service';
import { MemoryAudit } from '../in-memory';
import { screenResult, seedApplication, seedCompany, seedJob } from './seed';

/**
 * M10/M11 background screening against a REAL database (FOR UPDATE SKIP LOCKED, unique keys, cascades).
 *   TEST_DATABASE_URL=postgresql://hire:hire@localhost:5432/hireflow_test pnpm --filter api test
 */
const DB = process.env.TEST_DATABASE_URL;
const CONFIG: AtsProcessorConfig = { enabled: false, pollMs: 1000, concurrency: 2, maxAttempts: 3, staleMs: 60_000 };

describe.skipIf(!DB)('ATS background screening (real database)', () => {
  let db: PrismaClient;
  let audit: MemoryAudit;
  let tenantId: string;

  /** Fake AI worker: answers per application with `answer`, records every input. */
  const fakeWorker = (answer: (input: ScreenInput) => Promise<ReturnType<typeof screenResult>>) => {
    const calls: ScreenInput[] = [];
    const worker = { screen: vi.fn(async (input: ScreenInput) => (calls.push(input), answer(input))) } as unknown as AtsWorkerClient;
    return { worker, calls };
  };
  const processor = (worker: AtsWorkerClient, config: Partial<AtsProcessorConfig> = {}) => {
    const prisma = db as unknown as PrismaService;
    return new AtsProcessor(prisma, worker, { get: vi.fn() } as never, new ScreeningSettingsService(prisma, audit as never, undefined, false), audit as never, { ...CONFIG, onlyTenantId: tenantId, ...config }, undefined, false);
  };
  const evaluation = (applicationId: string) => db.atsEvaluation.findUniqueOrThrow({ where: { applicationId } });

  beforeAll(async () => {
    if (!/test/i.test(new URL(DB!).pathname)) throw new Error('TEST_DATABASE_URL must point at a database whose name contains "test"');
    db = new PrismaClient({ datasourceUrl: DB });
  });
  afterAll(async () => db?.$disconnect());
  beforeEach(async () => {
    audit = new MemoryAudit();
    tenantId = await seedCompany(db);
  });

  it('queues every application once and scores it against each job’s own threshold (several roles)', async () => {
    const backend = await seedJob(db, tenantId, { title: 'Backend Developer', minAtsScore: 70 });
    const data = await seedJob(db, tenantId, { title: 'Data Analyst', minAtsScore: 85 });
    const a1 = await seedApplication(db, tenantId, backend);
    const a2 = await seedApplication(db, tenantId, data);
    const { worker, calls } = fakeWorker(async () => screenResult(80));

    expect(await processor(worker).tick()).toBe(2);
    const [e1, e2] = [await evaluation(a1.applicationId), await evaluation(a2.applicationId)];
    expect(e1).toMatchObject({ status: 'SCORED', score: 80, minAtsScore: 70, systemDecision: 'SHORTLISTED', model: 'fake-model', promptVersion: 'resume_screen.v1' });
    expect(e2).toMatchObject({ status: 'SCORED', score: 80, minAtsScore: 85, systemDecision: 'NOT_SHORTLISTED' });
    expect(e1.matchedSkills).toEqual(['Node.js', 'SQL']);
    expect((e1.breakdown as unknown[]).length).toBe(5);
    expect(calls.map((c) => c.form.title).sort()).toEqual(['Backend Developer', 'Data Analyst']);
    expect(audit.entries.filter((e) => e.action === 'ats.scored')).toHaveLength(2);
    expect(JSON.stringify(audit.entries)).not.toContain('Hackathon'); // never resume content in the audit log

    expect(await processor(worker).tick()).toBe(0); // nothing is screened twice
    expect(calls).toHaveLength(2);
  });

  it('experience below the job minimum is rejected at once - no AI call - and gets the rejection email', async () => {
    const job = await seedJob(db, tenantId, { title: 'AI Engineer', experience: [2, 4], minAtsScore: 60 });
    const junior = await seedApplication(db, tenantId, job, { experienceYears: 1.5 });
    const enough = await seedApplication(db, tenantId, job, { experienceYears: 2 });
    const more = await seedApplication(db, tenantId, job, { experienceYears: 6 }); // above the range is not rejected
    const older = await seedApplication(db, tenantId, job, { experienceYears: null }); // applied before the field existed
    const { worker, calls } = fakeWorker(async () => screenResult(80));
    const prisma = db as unknown as PrismaService;
    const withEmails = new AtsProcessor(prisma, worker, { get: vi.fn() } as never, new ScreeningSettingsService(prisma, audit as never, undefined, false), audit as never, { ...CONFIG, onlyTenantId: tenantId }, true, false);

    expect(await withEmails.tick()).toBe(4);
    expect(await evaluation(junior.applicationId)).toMatchObject({
      status: 'SCORED', score: null, systemDecision: 'NOT_SHORTLISTED', autoRejectionReason: 'EXPERIENCE_BELOW_REQUIRED', minAtsScore: 60, model: null,
    });
    for (const a of [enough, more, older]) {
      expect(await evaluation(a.applicationId)).toMatchObject({ status: 'SCORED', score: 80, systemDecision: 'SHORTLISTED', autoRejectionReason: null });
    }
    expect(calls).toHaveLength(3); // the rejected resume never reached the AI worker
    const emails = await db.candidateEmail.findMany({ where: { tenantId } });
    expect(emails).toEqual([expect.objectContaining({ applicationId: junior.applicationId, kind: 'REJECTION', status: 'QUEUED' })]);
    expect(audit.entries.find((e) => e.action === 'ats.auto_rejected')).toMatchObject({
      subjectId: junior.applicationId,
      metadata: { reason: 'EXPERIENCE_BELOW_REQUIRED', experienceYears: 1.5, experienceMin: 2, autoRejected: true },
    });

    // a later change of the minimum ATS score does not flip the experience rejection (it has no score)
    await new ScreeningSettingsService(prisma, audit as never, undefined, false).save(tenantId, job.jobId, { minAtsScore: 10 }, null);
    expect(await evaluation(junior.applicationId)).toMatchObject({ systemDecision: 'NOT_SHORTLISTED' });
  });

  it('a job open to freshers rejects nobody for experience', async () => {
    const job = await seedJob(db, tenantId, { experience: [0, 1] });
    const fresher = await seedApplication(db, tenantId, job, { experienceYears: 0 });
    const { worker, calls } = fakeWorker(async () => screenResult(80));
    await processor(worker).tick();
    expect(await evaluation(fresher.applicationId)).toMatchObject({ score: 80, autoRejectionReason: null });
    expect(calls).toHaveLength(1);
  });

  it('screens against the JD version the student applied to, with the resume bytes', async () => {
    const job = await seedJob(db, tenantId);
    const app = await seedApplication(db, tenantId, job, { resume: Buffer.from('%PDF-1.4 my resume') });
    const v2 = await db.jdVersion.create({ data: { id: crypto.randomUUID(), tenantId, jobId: job.jobId, version: 2, source: 'HR_EDIT', content: { title: 'X', summary: 'NEW VERSION', responsibilities: ['a'], requirements: ['b'] } } });
    await db.job.update({ where: { id: job.jobId }, data: { currentJdVersionId: v2.id } });
    const { worker, calls } = fakeWorker(async () => screenResult(75));
    await processor(worker).tick();
    expect(calls[0]!.jd.summary).not.toBe('NEW VERSION');
    expect(calls[0]!.resume).toMatchObject({ fileName: 'resume.pdf', mimeType: 'application/pdf' });
    expect(calls[0]!.resume.bytes.toString()).toBe('%PDF-1.4 my resume');
    expect((await evaluation(app.applicationId)).jdVersionId).toBe(job.jdVersionId);
  });

  it('a technical error is retried later, then goes to HR review - never a rejection', async () => {
    const job = await seedJob(db, tenantId);
    const app = await seedApplication(db, tenantId, job);
    const { worker } = fakeWorker(async () => {
      throw new AtsWorkerError('The AI service is not reachable right now.', true, 'AI_WORKER_UNAVAILABLE');
    });
    const p = processor(worker);
    await p.tick();
    let e = await evaluation(app.applicationId);
    expect(e).toMatchObject({ status: 'PENDING', attempts: 1, systemDecision: null, lastError: 'The AI service is not reachable right now.' });
    expect(e.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 30_000); // backoff

    // jump past each backoff: 3rd failed try = HR review
    for (let i = 0; i < 2; i++) await p.tick(new Date(Date.now() + 2 * 60 * 60_000 * (i + 1)));
    e = await evaluation(app.applicationId);
    expect(e).toMatchObject({ status: 'NEEDS_REVIEW', attempts: 3, systemDecision: null, score: null });
  });

  it('an unreadable resume or a missing file goes straight to HR review', async () => {
    const job = await seedJob(db, tenantId);
    const unreadable = await seedApplication(db, tenantId, job);
    const noFile = await seedApplication(db, tenantId, job, { resume: null });
    const { worker, calls } = fakeWorker(async () => {
      throw new AtsWorkerError('The resume has no readable text (it may be a scanned image).', false, 'RESUME_UNREADABLE');
    });
    await processor(worker).tick();
    expect(await evaluation(unreadable.applicationId)).toMatchObject({ status: 'NEEDS_REVIEW', attempts: 1, systemDecision: null });
    expect(await evaluation(noFile.applicationId)).toMatchObject({ status: 'NEEDS_REVIEW', lastError: 'The application has no resume file.' });
    expect(calls).toHaveLength(1); // no AI call without a file
  });

  it('a job without a minimum ATS score is scored, but nobody is sorted until HR sets one', async () => {
    const job = await seedJob(db, tenantId, { minAtsScore: null });
    const app = await seedApplication(db, tenantId, job);
    await processor(fakeWorker(async () => screenResult(90)).worker).tick();
    expect(await evaluation(app.applicationId)).toMatchObject({ status: 'SCORED', score: 90, minAtsScore: null, systemDecision: null });

    // HR sets the score: open candidates are sorted against it
    await new ScreeningSettingsService(db as unknown as PrismaService, audit as never, undefined, false).save(tenantId, job.jobId, { minAtsScore: 95 }, null);
    expect(await evaluation(app.applicationId)).toMatchObject({ minAtsScore: 95, systemDecision: 'NOT_SHORTLISTED' });
  });

  it('two processors running at once never screen the same resume twice', async () => {
    const job = await seedJob(db, tenantId);
    const apps = await Promise.all(Array.from({ length: 6 }, () => seedApplication(db, tenantId, job)));
    const { worker, calls } = fakeWorker(async () => {
      await new Promise((r) => setTimeout(r, 30));
      return screenResult(72);
    });
    await Promise.all([processor(worker).tick(), processor(worker).tick(), processor(worker).tick()]);
    const screened = calls.map((c) => c.resume.bytes.length);
    expect(screened).toHaveLength(6);
    for (const a of apps) expect((await evaluation(a.applicationId)).status).toBe('SCORED');
  });

  it('a claim left behind by a crashed process is taken over', async () => {
    const job = await seedJob(db, tenantId);
    const app = await seedApplication(db, tenantId, job);
    const p = processor(fakeWorker(async () => screenResult(60)).worker);
    await p.enqueueNew();
    await db.atsEvaluation.update({ where: { applicationId: app.applicationId }, data: { status: 'PROCESSING', lockedAt: new Date(Date.now() - 2 * 60_000), attempts: 1 } });
    await p.tick();
    expect(await evaluation(app.applicationId)).toMatchObject({ status: 'SCORED', attempts: 2 });
  });

  it('deleting the application (student’s DPDP erase) deletes its evaluation too', async () => {
    const job = await seedJob(db, tenantId);
    const app = await seedApplication(db, tenantId, job);
    await processor(fakeWorker(async () => screenResult(88)).worker).tick();
    await db.$transaction([
      db.resumeFile.deleteMany({ where: { tenantId } }),
      db.resume.deleteMany({ where: { applicationId: app.applicationId } }),
      db.application.delete({ where: { id: app.applicationId } }),
    ]);
    expect(await db.atsEvaluation.findUnique({ where: { applicationId: app.applicationId } })).toBeNull();
  });

  it('a used-up AI quota pauses all screening and is not counted as a failed try', async () => {
    const job = await seedJob(db, tenantId);
    const apps = [await seedApplication(db, tenantId, job), await seedApplication(db, tenantId, job)];
    const { worker, calls } = fakeWorker(async () => {
      throw new AtsWorkerError('The AI service is busy (quota reached). Trying again later.', true, 'LLM_RATE_LIMITED', 120, true);
    });
    const p = processor(worker, { concurrency: 1 });
    await p.tick();
    expect(calls).toHaveLength(1); // the second resume was not sent into the same wall
    const first = await db.atsEvaluation.findMany({ where: { tenantId }, orderBy: { attempts: 'desc' } });
    expect(first.every((e) => e.status === 'PENDING' && e.attempts === 0)).toBe(true);
    expect(await p.tick()).toBe(0); // still paused
    for (const a of apps) expect((await evaluation(a.applicationId)).status).toBe('PENDING');
  });
});
