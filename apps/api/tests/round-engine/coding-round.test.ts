import 'reflect-metadata';
import { HttpException } from '@nestjs/common';
import type { RoundInput, SavedRound } from '@hireflow/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import type { PrismaService } from '../../src/common/prisma.service';
import { AssessmentsService } from '../../src/modules/assessments';
import { DsaService } from '../../src/modules/dsa/dsa.service';
import { RESULT_MARKER } from '../../src/modules/dsa/evaluation/harness';
import { RoundEngineBridge } from '../../src/modules/dsa/integration/round-engine.bridge';
import type { CodeRunner, Judge0Job } from '../../src/modules/dsa/judge0/judge0.client';
import { DISABLED_POLICY } from '../../src/modules/dsa/proctoring/proctoring.policy';
import { ProctoringService } from '../../src/modules/dsa/proctoring/proctoring.service';
import { InMemoryProctorStore } from '../../src/modules/dsa/proctoring/proctoring.store';
import { MockQuestionRepository } from '../../src/modules/dsa/questions/mock-question.repository';
import { MOCK_QUESTIONS } from '../../src/modules/dsa/questions/mock-questions.data';
import { RoundsConfigService } from '../../src/modules/rounds-config';
import { newAssessmentToken } from '../../src/modules/round-engine/link';
import { isCodingRound, isOnlineRound, nextStep } from '../../src/modules/round-engine/online-test';
import { RoundEngineService } from '../../src/modules/round-engine/round-engine.service';
import { RoundEngineWorker, type RoundEngineWorkerConfig } from '../../src/modules/round-engine/round-engine.worker';
import { MemoryAudit } from '../in-memory';
import { ACTOR, APP, FakeGenerator, JOB, MemoryAssessmentsStore, MemoryRoundsConfigStore, TENANT, student } from '../rounds/fakes';
import { FakeMailer, MemoryRoundEngineStore } from './fakes';

const T0 = new Date('2026-11-02T09:00:00Z');
const DAY = 24 * 60 * 60_000;

const aptitude: RoundInput = {
  type: 'APTITUDE',
  name: 'Aptitude & English Literacy',
  timeLimitMinutes: 30,
  passRule: { mode: 'CORRECT_COUNT', value: 1 },
  questions: [{ kind: 'MCQ', text: 'Q1', options: ['a', 'b'], correct: [1] }],
};
/** HR's coding round: its pass rule and time limit apply; the problems come from the dsa module (60 marks). */
const dsaRound: RoundInput = {
  type: 'CODING',
  name: 'DSA Round',
  description: 'Solve as many problems as you can.',
  timeLimitMinutes: 45,
  passRule: { mode: 'PERCENTAGE', value: 50 },
  questions: [{ kind: 'CODING', text: 'Data structures and algorithms', marks: 10 }],
};
const interview: RoundInput = { type: 'HR_INTERVIEW', name: 'Personal Interview', passRule: { mode: 'INTERVIEWER_SCORE', value: 6, maxScore: 10 } };

/** Prints the expected answer of every test case: every submission is fully correct. */
const expectedByStdin = new Map(MOCK_QUESTIONS.flatMap((q) => q.testCases.map((t) => [t.stdin, t.expectedOutput] as const)));
const perfectRunner: CodeRunner = {
  async runBatch(jobs: Judge0Job[]) {
    return jobs.map((j) => ({
      verdict: 'ok' as const, statusText: 'Accepted', stderr: '', compileOutput: '', timeMs: 3, memoryKb: 100,
      stdout: `\n${RESULT_MARKER}${expectedByStdin.get(j.stdin)}\n`,
    }));
  },
};

/** dsa_sessions in memory, stored as JSON like the database does. */
class FakeDsaDb {
  rows = new Map<string, { inviteId: string; tenantId: string; state: unknown }>();
  dsaSession = {
    findUnique: async ({ where }: { where: { inviteId: string } }) => structuredClone(this.rows.get(where.inviteId) ?? null),
    upsert: async ({ where, create, update }: { where: { inviteId: string }; create: { inviteId: string; tenantId: string; state: unknown }; update: { state: unknown } }) => {
      const row = this.rows.get(where.inviteId);
      this.rows.set(where.inviteId, JSON.parse(JSON.stringify(row ? { ...row, ...update } : create)));
    },
  };
}

let now: Date;
let store: MemoryRoundEngineStore;
let results: MemoryAssessmentsStore;
let audit: MemoryAudit;
let rounds: RoundsConfigService;
let engine: RoundEngineService;
let db: FakeDsaDb;
let dsa: DsaService;
let bridge: RoundEngineBridge;
let saved: SavedRound[];

const clock = () => new Date(now);
const code = (err: unknown) => ((err as HttpException).getResponse() as { code: string }).code;
const caught = async (p: Promise<unknown>) => p.then(() => { throw new Error('expected an error'); }, (e: unknown) => e);

/** What the DsaModule wires up: the DSA page running on the round engine (a new one = an API restart). */
function dsaPage() {
  bridge = new RoundEngineBridge(engine, db as unknown as PrismaService, new MockQuestionRepository());
  bridge.onModuleInit();
  const proctoring = new ProctoringService(new InMemoryProctorStore(), DISABLED_POLICY, () => now.getTime());
  dsa = new DsaService(bridge, new MockQuestionRepository(), bridge, perfectRunner, () => now.getTime(), proctoring, bridge);
}

function invite(roundId: string, opts: { expiresAt?: Date } = {}) {
  const t = newAssessmentToken();
  store.invites.push({
    id: `0192f3a1-dddd-7000-8000-${String(store.invites.length + 1).padStart(12, '0')}`,
    tenantId: TENANT,
    applicationId: APP,
    jobId: JOB,
    roundId,
    tokenHash: t.tokenHash,
    expiresAt: opts.expiresAt ?? new Date(now.getTime() + 7 * DAY),
    revokedAt: null,
    emailStatus: 'SENT',
    attempts: 1,
    sentAt: now,
    lastError: null,
  });
  return t.token;
}

function worker(config: Partial<RoundEngineWorkerConfig> = {}, mailer = new FakeMailer()) {
  const w = new RoundEngineWorker(
    store,
    engine,
    rounds,
    mailer,
    audit,
    {
      enabled: false,
      pollMs: 5000,
      autoInvite: true,
      baseUrl: 'https://careers.example.com/assessment/{token}',
      dsaBaseUrl: 'https://dsa.example.com/dsa/{token}',
      linkDays: 7,
      allowLocalLinks: false,
      ...config,
    },
    { cameraRequired: true },
    clock,
  );
  return { w, mailer };
}

const submit = (token: string, questionId: string) => dsa.submit(token, { questionId, language: 'python', code: 'def solve(): pass' });
const dsaResult = () => results.results.find((r) => r.roundId === saved[1]!.id);

beforeEach(async () => {
  now = new Date(T0);
  const roundsStore = new MemoryRoundsConfigStore();
  roundsStore.addJob(TENANT, JOB);
  results = new MemoryAssessmentsStore();
  results.jobs.push({ id: JOB, tenantId: TENANT, title: 'AI Engineer' });
  results.students.push({ ...student(), tenantId: TENANT });
  store = new MemoryRoundEngineStore();
  store.contexts.set(APP, {
    tenantId: TENANT, applicationId: APP, jobId: JOB, candidateName: 'Asha Patel', email: 'asha@example.com',
    jobTitle: 'AI Engineer', companyName: 'Pattern Labs', companyWebsite: null,
  });
  audit = new MemoryAudit();
  rounds = new RoundsConfigService(roundsStore, audit, new FakeGenerator().asClient());
  engine = new RoundEngineService(store, rounds, new AssessmentsService(results, rounds, audit), audit, { cameraRequired: true }, clock);
  saved = (await rounds.save(TENANT, JOB, { rounds: [aptitude, dsaRound, interview], complete: true }, ACTOR)).rounds;
  db = new FakeDsaDb();
  dsaPage();
});

describe('coding rounds run on the DSA page', () => {
  it('a coding-only round with a score rule is a DSA round; passing the round before it invites to it', () => {
    expect(isCodingRound(saved[1]!)).toBe(true);
    expect(isOnlineRound(saved[1]!)).toBe(false);
    expect(isCodingRound(saved[0]!)).toBe(false);
    expect(isCodingRound(saved[2]!)).toBe(false);
    expect(nextStep(saved, saved[0]!, true)).toMatchObject({ kind: 'INVITE', round: { id: saved[1]!.id } });
    expect(nextStep(saved, saved[0]!, false)).toEqual({ kind: 'EMAIL', email: 'REJECTED', nextRoundName: null });
  });

  it('passing aptitude -> DSA invitation emailed with the DSA page link, which opens the DSA test (and only it)', async () => {
    const apt = invite(saved[0]!.id);
    await engine.start(apt, { consent: true });
    await engine.submit(apt, { revision: 1, answers: [{ questionId: saved[0]!.questions[0]!.id, selected: [1] }] });
    expect(store.invites.filter((i) => i.roundId === saved[1]!.id)).toHaveLength(1);
    expect(store.outcomeEmails).toHaveLength(0);

    const { w, mailer } = worker();
    expect(await w.sendInvites()).toBe(1);
    const { to, message } = mailer.sent[0]!;
    expect(to).toBe('asha@example.com');
    expect(message.subject).toBe('Next Step: DSA Round for AI Engineer at Pattern Labs');
    expect(message.text).toContain('coding problems, solved in Python, Java or C++ · 45 minutes');
    expect(message.text).toContain('Thank you for completing the Aptitude & English Literacy');
    expect(message.text).not.toMatch(/webcam/);
    const link = /https:\/\/dsa\.example\.com\/dsa\/([A-Za-z0-9_-]+)/.exec(message.text);
    expect(link).not.toBeNull();
    const token = link![1]!;

    expect(await bridge.resolve(token)).toEqual({ token, assessmentId: saved[1]!.id, candidateName: 'Asha Patel', durationMinutes: 45 });
    expect((await dsa.getState(token)).status).toBe('not_started');
    // the links do not cross: the MCQ page refuses a DSA link, the DSA page an MCQ link
    expect(code(await caught(engine.view(token)))).toBe('ASSESSMENT_UNAVAILABLE');
    expect(await bridge.resolve(apt)).toBeNull();
  });

  it('holds the DSA invitation while the DSA page has no public link', async () => {
    await store.queueInvite(TENANT, APP, JOB, saved[1]!.id);
    const { w, mailer } = worker({ dsaBaseUrl: null });
    await w.sendInvites();
    expect(store.invites[0]!.lastError).toMatch(/DSA_SITE_URL/);
    store.invites[0]!.emailStatus = 'QUEUED';
    await worker({ dsaBaseUrl: 'http://localhost:3001/dsa/{token}' }, mailer).w.sendInvites();
    expect(mailer.sent).toHaveLength(0);
    expect(store.invites[0]).toMatchObject({ emailStatus: 'QUEUED', attempts: 0, tokenHash: null });
  });

  it('PASS: all problems solved -> graded against HR pass rule, result notes for HR, next step queued', async () => {
    const token = invite(saved[1]!.id);
    const started = await dsa.start(token);
    expect(started.durationMinutes).toBe(45);
    expect(store.attempts).toHaveLength(1);
    expect(store.attempts[0]!.deadlineAt!.getTime() - store.attempts[0]!.startedAt.getTime()).toBe(45 * 60_000);

    for (const q of MOCK_QUESTIONS) await submit(token, q.id);
    const done = await dsa.finish(token);
    expect(done.result).toMatchObject({ totalScore: 60, maxScore: 60 });

    expect(store.attempts[0]!.status).toBe('SUBMITTED');
    expect(dsaResult()).toMatchObject({ score: 100, maxScore: 100, passMark: 50, systemPassed: true });
    expect(dsaResult()!.notes).toContain('DSA coding test: 60 of 60 marks, 3 of 3 problems solved.');
    expect(store.outcomeEmails).toEqual([expect.objectContaining({ roundId: saved[1]!.id, kind: 'CLEARED_NEXT_BY_HR', nextRoundName: 'Personal Interview' })]);

    // finishing again changes nothing
    await dsa.finish(token);
    expect(store.outcomeEmails).toHaveLength(1);

    // HR's round panel: an online round, with problems solved out of the DSA problems
    const hr = await engine.forApplication(TENANT, APP);
    expect(hr.rounds[1]).toMatchObject({ online: true, attempt: { status: 'SUBMITTED', answered: 3, questionCount: 3 }, outcomeEmail: { kind: 'CLEARED_NEXT_BY_HR' } });
  });

  it('FAIL: below the pass mark -> rejection email', async () => {
    const token = invite(saved[1]!.id);
    await dsa.start(token);
    await submit(token, MOCK_QUESTIONS[0]!.id); // 10 of 60 marks = 1.66 of HR's 10 marks (rounded down) = 16.6%
    await dsa.finish(token);
    expect(dsaResult()).toMatchObject({ score: 16.6, systemPassed: false });
    expect(store.outcomeEmails).toEqual([expect.objectContaining({ roundId: saved[1]!.id, kind: 'REJECTED' })]);

    const { w, mailer } = worker();
    await w.sendOutcomeEmails();
    expect(mailer.sent[0]!.message.subject).toBe('Application Update – AI Engineer at Pattern Labs');
    expect(mailer.sent[0]!.message.text).toContain('Thank you for taking the DSA Round');
  });

  it('a test left open is graded by the worker when its time runs out (saved best scores count)', async () => {
    const token = invite(saved[1]!.id);
    await dsa.start(token);
    await submit(token, MOCK_QUESTIONS[0]!.id);
    await submit(token, MOCK_QUESTIONS[1]!.id); // 30 of 60 = exactly the 50% pass mark
    now = new Date(now.getTime() + 46 * 60_000);
    await worker().w.sweepOverdue();
    expect(store.attempts[0]!.status).toBe('TIMED_OUT');
    expect(dsaResult()).toMatchObject({ score: 50, systemPassed: true });
    expect(store.outcomeEmails).toHaveLength(1);

    // the page shows the end too; telling the engine again is harmless
    expect((await dsa.getState(token)).result).toMatchObject({ reason: 'time_expired', totalScore: 30 });
    expect(store.outcomeEmails).toHaveLength(1);
  });

  it('keeps the attempt across an API restart, and never stores the link token', async () => {
    const token = invite(saved[1]!.id);
    await dsa.start(token);
    await submit(token, MOCK_QUESTIONS[0]!.id);
    dsaPage(); // new process: nothing in memory
    const state = await dsa.getState(token);
    expect(state.status).toBe('in_progress');
    expect(state.progress.find((p) => p.questionId === MOCK_QUESTIONS[0]!.id)).toMatchObject({ bestScore: 10 });
    expect(JSON.stringify([...db.rows.values()])).not.toContain(token);
  });

  it('a withdrawn or expired link stops working on the DSA page', async () => {
    const token = invite(saved[1]!.id);
    await engine.revoke(TENANT, APP, saved[1]!.id, ACTOR);
    expect(code(await caught(dsa.getState(token)))).toBe('INVALID_TOKEN');
    const expired = invite(saved[1]!.id, { expiresAt: new Date(now.getTime() - 1) });
    expect(code(await caught(dsa.getState(expired)))).toBe('INVALID_TOKEN');
  });

  it('students told "HR will contact you" before the DSA round ran online are invited to it now, once', async () => {
    store.clearedBeforeCoding.push({ tenantId: TENANT, applicationId: APP, jobId: JOB, roundId: saved[1]!.id });
    const { w } = worker();
    expect(await w.discover()).toBe(1);
    expect(await w.discover()).toBe(0);
    expect(store.invites).toEqual([expect.objectContaining({ roundId: saved[1]!.id, emailStatus: 'QUEUED' })]);
    // never for a round that is not a coding round
    expect(await engine.inviteToCodingRound({ tenantId: TENANT, applicationId: APP, jobId: JOB, roundId: saved[2]!.id })).toBe(false);
  });
});
