import 'reflect-metadata';
import { GD_DEFAULT_SETTINGS, type RoundInput } from '@hireflow/contracts';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaService } from '../../src/common/prisma.service';
import { uuidv7 } from '../../src/common/uuidv7';
import { GdService } from '../../src/modules/group-discussion/gd.service';
import { PrismaGdStore } from '../../src/modules/group-discussion/gd.store';
import { GdWorker } from '../../src/modules/group-discussion/gd.worker';
import { RoundsConfigService } from '../../src/modules/rounds-config';
import { PrismaRoundsConfigStore } from '../../src/modules/rounds-config/rounds-config.store';
import { seedApplication, seedCompany, seedJob } from '../ats/seed';
import { MemoryAudit } from '../in-memory';
import { FakeGenerator } from '../rounds/fakes';

/** The GD store's SQL against a REAL database (TEST_DATABASE_URL, a database whose name contains "test"). */
const DB = process.env.TEST_DATABASE_URL;
const ACTOR = { id: '0192f3a1-0000-7000-8000-0000000000aa', name: 'Priya Shah' };

const aptitude: RoundInput = {
  type: 'APTITUDE',
  name: 'Aptitude',
  passRule: { mode: 'MARKS', value: 1 },
  questions: [{ kind: 'MCQ', text: 'Q1', options: ['a', 'b'], correct: [1] }],
};
const gd: RoundInput = {
  type: 'GROUP_DISCUSSION',
  name: 'Group Discussion',
  passRule: { mode: 'INTERVIEWER_SCORE', value: 6, maxScore: 10 },
  questions: [
    { kind: 'INTERVIEW', text: 'Should AI replace exams?' },
    { kind: 'INTERVIEW', text: 'Work from home or office?' },
  ],
};

describe.skipIf(!DB)('group discussion store (real database)', () => {
  let db: PrismaClient;
  let prisma: PrismaService;
  let audit: MemoryAudit;
  let store: PrismaGdStore;
  let rounds: RoundsConfigService;
  let service: GdService;
  let tenantId: string;

  const result = (tenantId: string, applicationId: string, jobId: string, roundId: string, systemPassed: boolean, overridePassed: boolean | null = null) =>
    db.roundResult.create({
      data: {
        id: uuidv7(), tenantId, applicationId, jobId, roundId, passMode: 'MARKS', score: systemPassed ? 1 : 0, maxScore: 1, passMark: 1, systemPassed,
        ...(overridePassed === null ? {} : { overridePassed, overrideReason: 'HR review', overriddenById: ACTOR.id, overriddenByName: ACTOR.name, overriddenAt: new Date() }),
      },
    });
  const mine = async () => (await store.poolCandidates(1000)).filter((c) => c.tenantId === tenantId);

  beforeAll(async () => {
    if (!/test/i.test(new URL(DB!).pathname)) throw new Error('TEST_DATABASE_URL must point at a database whose name contains "test"');
    db = new PrismaClient({ datasourceUrl: DB });
    prisma = db as unknown as PrismaService;
  });
  afterAll(async () => db?.$disconnect());
  beforeEach(async () => {
    audit = new MemoryAudit();
    store = new PrismaGdStore(prisma);
    rounds = new RoundsConfigService(new PrismaRoundsConfigStore(prisma), audit as never, new FakeGenerator().asClient());
    service = new GdService(store, rounds, audit as never, () => new Date());
    tenantId = await seedCompany(db);
  });

  it('pools students who passed every earlier round (HR override counts), or finished AI screening when the GD is first', async () => {
    const job = await seedJob(db, tenantId, { title: 'Analyst' });
    const [apt, gdRound] = (await rounds.save(tenantId, job.jobId, { rounds: [aptitude, gd], complete: true }, ACTOR)).rounds;
    const passed = await seedApplication(db, tenantId, job, { name: 'Passed' });
    const failed = await seedApplication(db, tenantId, job, { name: 'Failed' });
    const overridden = await seedApplication(db, tenantId, job, { name: 'Overridden' });
    const overriddenDown = await seedApplication(db, tenantId, job, { name: 'Overridden down' });
    await seedApplication(db, tenantId, job, { name: 'No result' });
    await result(tenantId, passed.applicationId, job.jobId, apt!.id, true);
    await result(tenantId, failed.applicationId, job.jobId, apt!.id, false);
    await result(tenantId, overridden.applicationId, job.jobId, apt!.id, false, true);
    await result(tenantId, overriddenDown.applicationId, job.jobId, apt!.id, true, false);

    const firstJob = await seedJob(db, tenantId, { title: 'Trainee' });
    const [gdFirst] = (await rounds.save(tenantId, firstJob.jobId, { rounds: [gd], complete: true }, ACTOR)).rounds;
    const screened = await seedApplication(db, tenantId, firstJob, { name: 'Screened' });
    const notScreened = await seedApplication(db, tenantId, firstJob, { name: 'Not screened' });
    await db.screeningSession.create({ data: { tenantId, applicationId: screened.applicationId, jobId: firstJob.jobId, status: 'COMPLETED', completedAt: new Date() } });
    await db.screeningSession.create({ data: { tenantId, applicationId: notScreened.applicationId, jobId: firstJob.jobId, status: 'IN_PROGRESS' } });

    // a draft configuration never feeds a pool
    const draftJob = await seedJob(db, tenantId, { title: 'Draft' });
    await rounds.save(tenantId, draftJob.jobId, { rounds: [gd], complete: false }, ACTOR);

    const found = await mine();
    expect(found.map((c) => [c.applicationId, c.roundId]).sort()).toEqual(
      [
        [passed.applicationId, gdRound!.id],
        [overridden.applicationId, gdRound!.id],
        [screened.applicationId, gdFirst!.id],
      ].sort(),
    );

    const worker = new GdWorker(store, null as never, null as never, null as never, audit as never, { enabled: false, pollMs: 10_000, livePollMs: 1000 });
    expect(await worker.fillPools()).toBeGreaterThanOrEqual(3);
    expect(await mine()).toEqual([]);
    const people = await store.participants(tenantId, gdRound!.id);
    expect(people.map((p) => [p.name, p.attendance, p.college])).toEqual(
      expect.arrayContaining([
        ['Passed', 'WAITING', 'LD College of Engineering'],
        ['Overridden', 'WAITING', 'LD College of Engineering'],
      ]),
    );
    expect(await store.addToPool({ tenantId, applicationId: passed.applicationId, jobId: job.jobId, roundId: gdRound!.id })).toBe(false);
  });

  it('schedules, refuses a second scheduling of the same students, changes a topic and cancels', async () => {
    const job = await seedJob(db, tenantId, { title: 'Analyst' });
    const [, gdRound] = (await rounds.save(tenantId, job.jobId, { rounds: [aptitude, gd], complete: true }, ACTOR)).rounds;
    for (let i = 0; i < 7; i++) {
      const app = await seedApplication(db, tenantId, job, { name: `S${i}` });
      await store.addToPool({ tenantId, applicationId: app.applicationId, jobId: job.jobId, roundId: gdRound!.id });
    }
    const startsAt = new Date(Date.now() + 2 * 60 * 60_000).toISOString();
    const view = await service.createEvent(tenantId, gdRound!.id, { name: 'Day 1', startsAt, settings: { ...GD_DEFAULT_SETTINGS, minGroupSize: 3, maxGroupSize: 4 } }, ACTOR);
    expect(view.pool).toEqual([]);
    expect(view.events[0]!.batches.map((b) => b.participants.length)).toEqual([4, 3]);
    expect(view.events[0]!.batches.map((b) => b.topic?.text)).toEqual(['Should AI replace exams?', 'Work from home or office?']);
    expect(await db.gdBatch.count({ where: { tenantId } })).toBe(2);

    // the same students again (e.g. a second HR tab): rolled back, nothing written
    const pool = await store.participants(tenantId, gdRound!.id);
    const again = await store.createEvent({
      id: uuidv7(), tenantId, jobId: job.jobId, roundId: gdRound!.id, name: 'Dup', startsAt: new Date(startsAt), settings: GD_DEFAULT_SETTINGS, undersized: false, createdById: null,
      batches: [{ id: uuidv7(), number: 1, startsAt: new Date(startsAt), endsAt: new Date(Date.parse(startsAt) + 3600_000), roomName: `gd-dup-${uuidv7()}`, topicQuestionId: null, topicText: null, participantIds: pool.map((p) => p.id) }],
    });
    expect(again).toBe(false);
    expect(await db.gdEvent.count({ where: { tenantId } })).toBe(1);
    expect(await db.gdBatch.count({ where: { tenantId } })).toBe(2);

    const batch = view.events[0]!.batches[0]!;
    const changed = await service.setBatchTopic(tenantId, batch.id, { topicId: view.topics[1]!.id }, ACTOR);
    expect(changed.events[0]!.batches[0]!.topic?.text).toBe('Work from home or office?');
    expect(await store.countBatches(tenantId, gdRound!.id)).toBe(2);

    const otherTenant = await seedCompany(db, 'Other');
    expect(await store.getRound(otherTenant, gdRound!.id)).toBeNull();
    expect(await store.cancelEvent(otherTenant, view.events[0]!.id, null, new Date())).toBe('NOT_FOUND');

    const cancelled = await service.cancelEvent(tenantId, view.events[0]!.id, ACTOR);
    expect(cancelled.events[0]!.status).toBe('CANCELLED');
    expect(cancelled.pool).toHaveLength(7);
    expect(await store.countBatches(tenantId, gdRound!.id)).toBe(0);
    expect(await store.cancelEvent(tenantId, view.events[0]!.id, null, new Date())).toBe('ALREADY_CANCELLED');
  });

  it('refuses to cancel once a group opened and deletes a student\'s GD row with their application', async () => {
    const job = await seedJob(db, tenantId, { title: 'Analyst' });
    const [, gdRound] = (await rounds.save(tenantId, job.jobId, { rounds: [aptitude, gd], complete: true }, ACTOR)).rounds;
    const app = await seedApplication(db, tenantId, job, { name: 'Solo' });
    await store.addToPool({ tenantId, applicationId: app.applicationId, jobId: job.jobId, roundId: gdRound!.id });
    const view = await service.createEvent(tenantId, gdRound!.id, { name: 'Day 1', startsAt: new Date(Date.now() + 3600_000).toISOString(), settings: GD_DEFAULT_SETTINGS }, ACTOR);
    expect(view.events[0]!.undersized).toBe(true);
    await db.gdBatch.updateMany({ where: { tenantId }, data: { status: 'LOBBY_OPEN' } });
    expect(await store.cancelEvent(tenantId, view.events[0]!.id, null, new Date())).toBe('STARTED');

    // like the student's "delete my data" (my-data.service.ts): resume files, resumes, then the application
    const resumes = await db.resume.findMany({ where: { applicationId: app.applicationId }, select: { id: true } });
    await db.resumeFile.deleteMany({ where: { resumeId: { in: resumes.map((r) => r.id) } } });
    await db.resume.deleteMany({ where: { applicationId: app.applicationId } });
    await db.application.delete({ where: { id: app.applicationId } });
    expect(await db.gdParticipant.count({ where: { tenantId } })).toBe(0);
  });
});
