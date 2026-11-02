import 'reflect-metadata';
import { PrismaClient } from '@prisma/client';
import { jobCandidatesSchema, screeningJobSchema } from '@hireflow/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../src/common/prisma.service';
import { AtsProcessor, type AtsProcessorConfig } from '../../src/modules/ats/ats-processor.service';
import { AtsWorkerError, type AtsWorkerClient, type ScreenInput } from '../../src/modules/ats/ats-worker.client';
import { CandidatesService } from '../../src/modules/ats/candidates.service';
import { DecisionService } from '../../src/modules/ats/decision.service';
import { ScreeningSettingsService } from '../../src/modules/ats/screening-settings.service';
import { MemoryAudit } from '../in-memory';
import { screenResult, seedApplication, seedCompany, seedJob } from './seed';

/** The HR "Shortlisted Students" lists against a REAL database (TEST_DATABASE_URL). */
const DB = process.env.TEST_DATABASE_URL;
const ACTOR = { id: '0192f3a1-0000-7000-8000-0000000000aa', name: 'Priya Shah' };

describe.skipIf(!DB)('Shortlisted Students lists (real database)', () => {
  let db: PrismaClient;
  let prisma: PrismaService;
  let tenantId: string;
  const audit = new MemoryAudit();
  const service = (screeningUrl: string | null = null) => new CandidatesService(prisma, screeningUrl);

  /**
   * Applications whose resume text is their score ("%PDF-1.4 91"). "broken" = unreadable (HR review);
   * "later" = applied after the screening round ran (still waiting).
   */
  async function job(minAtsScore: number | null, resumes: (number | 'broken' | 'later')[], title = 'Backend Developer') {
    const j = await seedJob(db, tenantId, { title, minAtsScore });
    const seed = (r: number | string) => seedApplication(db, tenantId, j, { name: `Student ${r}`, resume: Buffer.from(`%PDF-1.4 ${r}`) });
    const apps = [];
    for (const r of resumes.filter((r) => r !== 'later')) apps.push(await seed(r));
    const worker = {
      screen: vi.fn(async (input: ScreenInput) => {
        const text = input.resume.bytes.toString().split(' ')[1]!;
        if (text === 'broken') throw new AtsWorkerError('The resume has no readable text.', false, 'RESUME_UNREADABLE');
        return screenResult(Number(text));
      }),
    } as unknown as AtsWorkerClient;
    const config: AtsProcessorConfig = { enabled: false, pollMs: 1000, concurrency: 4, maxAttempts: 1, staleMs: 60_000, onlyTenantId: tenantId };
    // automatic rejections off: these tests are about the lists and HR's own decisions
    await new AtsProcessor(prisma, worker, { get: vi.fn() } as never, new ScreeningSettingsService(prisma, audit as never, false, false), audit as never, config, false, false).tick();
    for (const r of resumes.filter((r) => r === 'later')) apps.push(await seed(r));
    return { ...j, apps };
  }

  beforeAll(async () => {
    if (!/test/i.test(new URL(DB!).pathname)) throw new Error('TEST_DATABASE_URL must point at a database whose name contains "test"');
    db = new PrismaClient({ datasourceUrl: DB });
    prisma = db as unknown as PrismaService;
  });
  afterAll(async () => db?.$disconnect());
  beforeEach(async () => {
    tenantId = await seedCompany(db);
  });

  it('opens on ONLY the candidates who met the job’s minimum ATS score, best first', async () => {
    const j = await job(70, [55, 91, 70, 'broken', 'later', 69]);
    const res = jobCandidatesSchema.parse(await service().candidates(tenantId, j.jobId, undefined));
    expect(res.view).toBe('shortlisted');
    expect(res.candidates.map((c) => c.score)).toEqual([91, 70]);
    expect(res.candidates.every((c) => c.decision === 'SHORTLISTED')).toBe(true);
    expect(res.counts).toEqual({ total: 6, shortlisted: 2, notShortlisted: 2, undecided: 0, needsReview: 1, pending: 1 });
    expect(res.minAtsScore).toBe(70);
    const top = res.candidates[0]!;
    expect(top).toMatchObject({ name: 'Student 91', matchedSkills: ['Node.js', 'SQL'], missingSkills: ['REST'], status: 'SCORED' });
    expect(top.breakdown).toHaveLength(5);
    expect(top.profile?.projects[0]?.title).toBe('Expense API');
    expect(top.resume).toMatchObject({ fileName: 'resume.pdf', mimeType: 'application/pdf' });
  });

  it('the other lists show the rest for HR review, never mixed into the default one', async () => {
    const j = await job(70, [55, 91, 'broken', 'later']);
    const names = async (view: string) => (await service().candidates(tenantId, j.jobId, view)).candidates.map((c) => c.name);
    expect(await names('not_shortlisted')).toEqual(['Student 55']);
    expect(await names('needs_review')).toEqual(['Student broken']);
    expect(await names('pending')).toEqual(['Student later']);
    expect((await names('all')).sort()).toEqual(['Student 55', 'Student 91', 'Student broken', 'Student later']);
    expect((await service().candidates(tenantId, j.jobId, 'not_shortlisted')).candidates[0]!.lastError).toBeNull();
    expect((await service().candidates(tenantId, j.jobId, 'needs_review')).candidates[0]!.status).toBe('NEEDS_REVIEW');
    expect((await service().candidates(tenantId, j.jobId, 'bogus').catch((e) => e)).getStatus()).toBe(400);
  });

  it('different jobs, different thresholds: the same scores sort differently', async () => {
    const strict = await job(85, [80, 90], 'Data Scientist');
    const easy = await job(60, [80, 90], 'Support Engineer');
    expect((await service().candidates(tenantId, strict.jobId, 'shortlisted')).candidates.map((c) => c.score)).toEqual([90]);
    expect((await service().candidates(tenantId, easy.jobId, 'shortlisted')).candidates.map((c) => c.score)).toEqual([90, 80]);
    const jobs = (await service().jobs(tenantId)).map((x) => screeningJobSchema.parse(x));
    expect(jobs.map((x) => [x.title, x.minAtsScore, x.counts.shortlisted]).sort()).toEqual([
      ['Data Scientist', 85, 1],
      ['Support Engineer', 60, 2],
    ]);
  });

  it('HR’s decision moves a candidate between lists; the email status and link expiry are shown', async () => {
    const j = await job(70, [55, 91]);
    const [low] = j.apps;
    const decisions = new DecisionService(prisma, audit as never, 'https://screen.example', false, false);
    await decisions.setDecision(tenantId, low!.applicationId, { decision: 'SHORTLISTED' }, ACTOR);
    const list = await service('https://screen.example').candidates(tenantId, j.jobId, 'shortlisted');
    expect(list.shortlistEmailsReady).toBe(true);
    const moved = list.candidates.find((c) => c.applicationId === low!.applicationId)!;
    expect(moved).toMatchObject({ systemDecision: 'NOT_SHORTLISTED', hrDecision: 'SHORTLISTED', decision: 'SHORTLISTED' });

    await decisions.sendEmails(tenantId, { kind: 'SHORTLIST', applicationIds: [low!.applicationId] }, ACTOR);
    const queued = (await service().candidates(tenantId, j.jobId, 'shortlisted')).candidates.find((c) => c.applicationId === low!.applicationId)!;
    expect(queued.decisionEmail).toMatchObject({ kind: 'SHORTLIST', status: 'QUEUED' });
    expect(queued.screeningLinkExpiresAt).toBeNull(); // only once actually sent
    expect((await service().candidates(tenantId, j.jobId, undefined)).shortlistEmailsReady).toBe(false);
  });

  it('a job without a minimum score lists screened candidates as undecided, not as rejected', async () => {
    const j = await job(null, [95, 20]);
    const res = await service().candidates(tenantId, j.jobId, 'shortlisted');
    expect(res.candidates).toEqual([]);
    expect(res.counts).toMatchObject({ undecided: 2, shortlisted: 0, notShortlisted: 0 });
    expect((await service().candidates(tenantId, j.jobId, 'all')).candidates.map((c) => c.decision)).toEqual([null, null]);
  });

  it('only the company’s own HR team sees its candidates', async () => {
    const j = await job(70, [91]);
    const other = await seedCompany(db, 'Other');
    expect((await service().candidates(other, j.jobId, undefined).catch((e) => e)).getStatus()).toBe(404);
    expect(await service().jobs(other)).toEqual([]);
  });
});
