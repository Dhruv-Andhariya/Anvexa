import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import type { RoundInput } from '@hireflow/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaService } from '../../src/common/prisma.service';
import { PrismaAssessmentsStore } from '../../src/modules/assessments/assessments.store';
import { AssessmentsService } from '../../src/modules/assessments';
import { DsaService } from '../../src/modules/dsa/dsa.service';
import { RESULT_MARKER } from '../../src/modules/dsa/evaluation/harness';
import type { CodeRunner, RunnerJob, RunnerResult } from '../../src/modules/dsa/execution/code-runner';
import { PrismaProctorStore } from '../../src/modules/dsa/proctoring/prisma-proctor.store';
import { DSA_PROCTOR_POLICY, policyFromEnv } from '../../src/modules/dsa/proctoring/proctoring.policy';
import { ProctoringService, inviteRefFor } from '../../src/modules/dsa/proctoring/proctoring.service';
import { CONSENT_VERSION } from '../../src/modules/dsa/proctoring/proctoring.types';
import { DsaHrController } from '../../src/modules/dsa/dsa-hr.controller';
import { BankQuestionRepository } from '../../src/modules/dsa/questions/bank-question.repository';
import { MOCK_QUESTIONS } from '../../src/modules/dsa/questions/mock-questions.data';
import { EngineSessionStore } from '../../src/modules/dsa/session/engine-session.store';
import { RoundInvitationResolver } from '../../src/modules/dsa/session/round-invitation.resolver';
import { RoundsConfigService } from '../../src/modules/rounds-config';
import { PrismaRoundsConfigStore } from '../../src/modules/rounds-config/rounds-config.store';
import { RoundEngineService } from '../../src/modules/round-engine/round-engine.service';
import { PrismaRoundEngineStore } from '../../src/modules/round-engine/round-engine.store';
import { RoundEngineWorker, type RoundEngineWorkerConfig } from '../../src/modules/round-engine/round-engine.worker';
import { seedApplication, seedCompany, seedJob } from '../ats/seed';
import { FixedTenant, MemoryAudit } from '../in-memory';
import { FakeGenerator } from '../rounds/fakes';
import { FakeMailer } from './fakes';

/**
 * The DSA round, end to end, against a REAL database: AI screening completed -> invitation email with the personal DSA
 * link -> the candidate's coding session (through the dsa module) -> result in round_results -> outcome email.
 *   TEST_DATABASE_URL=postgresql://user:pass@localhost:5432/hireflow_test pnpm --filter api test
 * (every migration applied, including 20261102120000_dsa_round).
 */
const DB = process.env.TEST_DATABASE_URL;
const MIN = 60_000;
const ACTOR = { id: randomUUID(), name: 'Priya HR' };
const SOLVED = 'SOLVED_MARKER';

const problem = (n: 1 | 2 | 3, marks: number, difficulty: 'EASY' | 'MEDIUM' | 'HARD') => ({ kind: 'CODING' as const, text: `DSA problem ${n}`, marks, difficulty, topics: [`dsa:dsa-00${n}`] });
/** Easy 10 + Medium 20 + Hard 30 = 60 marks, 25 to pass. */
const dsaRound: RoundInput = {
  type: 'CODING',
  name: 'DSA Coding Round',
  description: 'Solve the problems.',
  timeLimitMinutes: 60,
  passRule: { mode: 'MARKS', value: 25 },
  questions: [problem(1, 10, 'EASY'), problem(2, 20, 'MEDIUM'), problem(3, 30, 'HARD')],
};
const interview: RoundInput = { type: 'HR_INTERVIEW', name: 'Personal Interview', passRule: { mode: 'INTERVIEWER_SCORE', value: 6, maxScore: 10 } };

const ok = (stdout: string): RunnerResult => ({ verdict: 'ok', statusText: 'OK', stdout, stderr: '', compileOutput: '', timeMs: 5, memoryKb: 1000 });
const expectedByStdin = new Map(MOCK_QUESTIONS.flatMap((q) => q.testCases.map((t) => [t.stdin, t.expectedOutput] as const)));
/** Passes every test when the candidate's code carries the marker, prints a wrong answer otherwise. */
const runner: CodeRunner = {
  async runBatch(jobs: RunnerJob[]) {
    return jobs.map((j) => ok(`\n${RESULT_MARKER}${j.source.includes(SOLVED) ? expectedByStdin.get(j.stdin) : 'wrong'}\n`));
  },
};

describe.skipIf(!DB)('DSA round (real database)', () => {
  let db: PrismaClient;
  let prisma: PrismaService;
  let audit: MemoryAudit;
  let tenantId: string;
  let mailer: FakeMailer;
  let rounds: RoundsConfigService;
  let engine: RoundEngineService;
  let worker: RoundEngineWorker;

  const workerConfig = (over: Partial<RoundEngineWorkerConfig> = {}): RoundEngineWorkerConfig => ({
    enabled: false,
    pollMs: 5000,
    autoInvite: true,
    baseUrl: 'https://careers.example.com/assessment/{token}',
    dsaBaseUrl: 'https://candidates.example.com/dsa/{token}',
    linkDays: 7,
    allowLocalLinks: false,
    ...over,
  });
  const makeWorker = (over: Partial<RoundEngineWorkerConfig> = {}) =>
    new RoundEngineWorker(new PrismaRoundEngineStore(prisma), engine, rounds, mailer, audit as never, workerConfig(over), { cameraRequired: true });

  /** A fresh DSA service on top of the database: building another one is what an API restart does. */
  const dsaService = () =>
    new DsaService(
      new RoundInvitationResolver(engine),
      new BankQuestionRepository(),
      new EngineSessionStore(engine),
      runner,
      Date.now,
      new ProctoringService(new PrismaProctorStore(prisma), { ...policyFromEnv({}), enabled: true }, Date.now),
    );

  /** Seeds a student with a completed AI screening for a job whose rounds are `roundInputs`. */
  async function seedStudent(roundInputs: RoundInput[]) {
    const job = await seedJob(db, tenantId, { title: 'Backend Developer' });
    const student = await seedApplication(db, tenantId, job, { name: 'Asha Patel' });
    await db.screeningSession.create({ data: { tenantId, applicationId: student.applicationId, jobId: job.jobId, status: 'COMPLETED', completedAt: new Date() } });
    const saved = (await rounds.save(tenantId, job.jobId, { rounds: roundInputs, complete: true }, ACTOR)).rounds;
    return { ...student, jobId: job.jobId, saved };
  }

  /**
   * The worker serves the whole database in small batches (this database may hold rows of earlier runs), so a test
   * keeps running it until the message for ITS student is out.
   */
  async function until(found: () => boolean, step: () => Promise<unknown>) {
    for (let i = 0; i < 40 && !found(); i++) await step();
  }

  /** Runs discover + send and returns the personal DSA token from the email. */
  async function invited(applicationEmail: string) {
    await until(() => mailer.sent.some((m) => m.to === applicationEmail), async () => {
      await makeWorker().discover();
      await makeWorker().sendInvites();
    });
    const mail = mailer.sent.find((m) => m.to === applicationEmail);
    expect(mail, 'the invitation email was sent').toBeDefined();
    const token = /https:\/\/candidates\.example\.com\/dsa\/([A-Za-z0-9_-]{43})/.exec(mail!.message.text)?.[1];
    expect(token, 'the email carries a personal DSA link').toBeDefined();
    return { token: token!, mail: mail! };
  }

  const consent = { consent: true, consentVersion: CONSENT_VERSION, fullscreen: true, camera: true };
  const code = (solved: boolean) => `def solve():\n    pass  # ${solved ? SOLVED : 'nope'}\n`;

  beforeAll(async () => {
    if (!/test/i.test(new URL(DB!).pathname)) throw new Error('TEST_DATABASE_URL must point at a database whose name contains "test"');
    db = new PrismaClient({ datasourceUrl: DB });
    prisma = db as unknown as PrismaService;
  });
  afterAll(async () => db?.$disconnect());
  beforeEach(async () => {
    audit = new MemoryAudit();
    mailer = new FakeMailer();
    tenantId = await seedCompany(db);
    rounds = new RoundsConfigService(new PrismaRoundsConfigStore(prisma), audit as never, new FakeGenerator().asClient());
    engine = new RoundEngineService(new PrismaRoundEngineStore(prisma), rounds, new AssessmentsService(new PrismaAssessmentsStore(prisma), rounds, audit as never), audit as never, { cameraRequired: true }, () => new Date());
    worker = makeWorker();
  });

  it('PASS: screening done -> DSA invitation -> candidate solves two problems -> result 30 of 60 -> cleared email', async () => {
    const s = await seedStudent([dsaRound]);
    const { token, mail } = await invited(s.email);

    // 1. the email: the DSA link, the DSA wording
    expect(mail.message.subject).toBe("Congratulations! You've Been Shortlisted for Backend Developer – Next Step: DSA Coding Round");
    expect(mail.message.text).toContain('3 coding problems · 60 minutes');
    expect(await db.roundInvite.count({ where: { applicationId: s.applicationId, emailStatus: 'SENT' } })).toBe(1);

    // 2. the candidate opens the link: no questions yet, no score shown later
    const svc = dsaService();
    const before = await svc.getState(token);
    expect(before).toMatchObject({ status: 'not_started', candidateName: 'Asha', durationMinutes: 60, totalMarks: 60, showScore: false });
    expect(before.questions).toBeUndefined();
    await svc.proctorStart(token, consent);
    const started = await svc.start(token);
    expect(started.status).toBe('in_progress');
    expect(started.questions!.map((q) => [q.marks, q.difficulty])).toEqual([[10, 'Easy'], [20, 'Medium'], [30, 'Hard']]);
    // the candidate gets the problem under HR's round-question id (and never a hidden test)
    expect(started.questions!.map((q) => q.id)).toEqual(s.saved[0]!.questions.map((q) => q.id));
    expect(JSON.stringify(started)).not.toContain('hiddenInput');

    // 3. an API restart in the middle: a brand-new service on the same database continues the same attempt
    const q = s.saved[0]!.questions;
    const first = await svc.submit(token, { questionId: q[0]!.id, language: 'python', code: code(true) });
    expect(first).toMatchObject({ score: 10, maxScore: 10 });
    expect(JSON.stringify(first)).not.toContain(SOLVED); // the stored source is never sent back
    const restarted = dsaService();
    const resumed = await restarted.getState(token);
    expect(resumed.status).toBe('in_progress');
    expect(resumed.progress.find((p) => p.questionId === q[0]!.id)).toMatchObject({ bestScore: 10, attempts: 1 });
    expect(JSON.stringify(resumed)).not.toContain(SOLVED);
    const second = await restarted.submit(token, { questionId: q[1]!.id, language: 'python', code: code(true) });
    expect(second.score).toBe(20);
    // a wrong later submission never lowers the best score
    await restarted.submit(token, { questionId: q[0]!.id, language: 'python', code: code(false) });

    // 4. finish: result, no score for the candidate
    const done = await restarted.finish(token);
    expect(done.status).toBe('finished');
    expect(done.result).toMatchObject({ reason: 'submitted', totalScore: 0, maxScore: 0, questions: [] });
    expect(JSON.stringify(done)).not.toMatch(/"totalScore":(?!0)/);

    const attempt = await db.roundAttempt.findUniqueOrThrow({ where: { applicationId_roundId: { applicationId: s.applicationId, roundId: s.saved[0]!.id } } });
    expect(attempt).toMatchObject({ status: 'SUBMITTED', systemPassed: true, consentVersion: 'dsa-1' });
    expect(attempt.progressedAt).not.toBeNull();
    expect((attempt.codingState as { progress: Record<string, { bestScore: number; bestCode: string }> }).progress[q[0]!.id]).toMatchObject({ bestScore: 10 });

    const result = await db.roundResult.findUniqueOrThrow({ where: { applicationId_roundId: { applicationId: s.applicationId, roundId: s.saved[0]!.id } } });
    expect(result).toMatchObject({ score: 30, maxScore: 60, passMark: 25, systemPassed: true });
    const answers = result.answers as { questionId: string; answer: string | null; marksAwarded: number; isCorrect: boolean }[];
    expect(answers.map((a) => a.marksAwarded)).toEqual([10, 20, 0]);
    expect(answers[0]!.answer).toContain(SOLVED); // HR can review the best submission

    // 5. the outcome email goes out through the worker
    const email = await db.roundOutcomeEmail.findFirstOrThrow({ where: { applicationId: s.applicationId } });
    expect(email.kind).toBe('CLEARED_ALL');
    await until(() => mailer.sent.some((m) => m.to === s.email && m.message.subject.startsWith('Congratulations')), () => worker.sendOutcomeEmails());
    const cleared = mailer.sent.find((m) => m.to === s.email && m.message.subject.startsWith('Congratulations'));
    expect(cleared).toBeDefined();
    expect(cleared!.message.text).not.toMatch(/(30|60|25)|score|marks/i);
  });

  it('FAIL: 10 of 60 with 25 needed -> rejection email, nothing else is invited', async () => {
    const s = await seedStudent([dsaRound, interview]);
    const { token } = await invited(s.email);
    const svc = dsaService();
    await svc.proctorStart(token, consent);
    await svc.start(token);
    await svc.submit(token, { questionId: s.saved[0]!.questions[0]!.id, language: 'python', code: code(true) });
    await svc.finish(token);

    const result = await db.roundResult.findFirstOrThrow({ where: { applicationId: s.applicationId } });
    expect(result).toMatchObject({ score: 10, maxScore: 60, passMark: 25, systemPassed: false });
    const email = await db.roundOutcomeEmail.findFirstOrThrow({ where: { applicationId: s.applicationId } });
    expect(email.kind).toBe('REJECTED');
    await until(() => mailer.sent.some((m) => m.to === s.email && m.message.subject.startsWith('Application Update')), () => worker.sendOutcomeEmails());
    expect(mailer.sent.find((m) => m.to === s.email && m.message.subject.startsWith('Application Update'))!.message.subject).toBe('Application Update – Backend Developer at Acme');
    expect(await db.roundInvite.count({ where: { applicationId: s.applicationId } })).toBe(1); // no further invitation
  });

  it('PASS with an HR interview next: the student is told HR will contact them', async () => {
    const s = await seedStudent([dsaRound, interview]);
    const { token } = await invited(s.email);
    const svc = dsaService();
    await svc.proctorStart(token, consent);
    await svc.start(token);
    for (const q of s.saved[0]!.questions.slice(0, 2)) await svc.submit(token, { questionId: q.id, language: 'java', code: code(true) });
    await svc.finish(token);
    const email = await db.roundOutcomeEmail.findFirstOrThrow({ where: { applicationId: s.applicationId } });
    expect(email).toMatchObject({ kind: 'CLEARED_NEXT_BY_HR', nextRoundName: 'Personal Interview' });
  });

  it('a candidate who never comes back is timed out by the worker with the saved progress', async () => {
    const s = await seedStudent([dsaRound]);
    const { token } = await invited(s.email);
    const svc = dsaService();
    await svc.proctorStart(token, consent);
    await svc.start(token);
    await svc.submit(token, { questionId: s.saved[0]!.questions[1]!.id, language: 'cpp', code: code(true) });
    // the hour is over (the check constraint wants the deadline after the start)
    await db.roundAttempt.updateMany({ where: { applicationId: s.applicationId }, data: { startedAt: new Date(Date.now() - 2 * 60 * MIN), deadlineAt: new Date(Date.now() - 60 * MIN) } });
    await worker.sweepOverdue();
    const attempt = await db.roundAttempt.findFirstOrThrow({ where: { applicationId: s.applicationId } });
    expect(attempt.status).toBe('TIMED_OUT');
    const result = await db.roundResult.findFirstOrThrow({ where: { applicationId: s.applicationId } });
    expect(result).toMatchObject({ score: 20, systemPassed: false });
    // the page, opened afterwards, shows the end and refuses more code
    const late = await dsaService().getState(token);
    expect(late.status).toBe('finished');
    expect(late.result!.reason).toBe('time_expired');
    await expect(dsaService().submit(token, { questionId: s.saved[0]!.questions[0]!.id, language: 'python', code: code(true) })).rejects.toMatchObject({ response: { code: 'TIME_EXPIRED' } });
  });

  it('the integrity record is stored in the database, per invitation, and goes with the application', async () => {
    const s = await seedStudent([dsaRound]);
    const { token } = await invited(s.email);
    const svc = dsaService();
    await svc.proctorStart(token, consent);
    await svc.start(token);
    await svc.proctorEvents(token, { events: [{ type: 'CONTEXT_MENU', at: Date.now() }] }).catch(() => undefined);
    const row = await db.dsaProctorSession.findUniqueOrThrow({ where: { inviteRef: inviteRefFor(token) } });
    expect(row).toMatchObject({ tenantId, applicationId: s.applicationId, roundId: s.saved[0]!.id });
    expect(JSON.stringify(row.session)).not.toContain(token); // the link token is never stored with proctoring data
    // a restarted service sees the same record
    expect(await dsaService().getState(token)).toMatchObject({ proctoring: { started: true } });
    // erasing an application removes its resume first (resumes have no cascade); everything else follows by cascade
    const resumeIds = (await db.resume.findMany({ where: { applicationId: s.applicationId }, select: { id: true } })).map((r) => r.id);
    await db.resumeFile.deleteMany({ where: { resumeId: { in: resumeIds } } });
    await db.resume.deleteMany({ where: { applicationId: s.applicationId } });
    await db.application.delete({ where: { id: s.applicationId } });
    expect(await db.dsaProctorSession.count({ where: { inviteRef: inviteRefFor(token) } })).toBe(0);
    expect(await db.roundAttempt.count({ where: { applicationId: s.applicationId } })).toBe(0);
  });

  it('a token opens only its own round: another student, a withdrawn link, a made-up token', async () => {
    const a = await seedStudent([dsaRound]);
    const b = await seedStudent([dsaRound]);
    const { token: tokenA } = await invited(a.email);
    const { token: tokenB } = await invited(b.email);
    expect(tokenA).not.toBe(tokenB);
    const svc = dsaService();
    await svc.proctorStart(tokenA, consent);
    await svc.start(tokenA);
    expect(await db.roundAttempt.count({ where: { applicationId: b.applicationId } })).toBe(0);
    await expect(svc.getState('x'.repeat(43))).rejects.toMatchObject({ response: { code: 'INVALID_TOKEN' } });
    await engine.revoke(tenantId, a.applicationId, a.saved[0]!.id, null);
    await expect(svc.getState(tokenA)).rejects.toMatchObject({ response: { code: 'ASSESSMENT_LINK_REVOKED' } });
    expect((await svc.getState(tokenB)).status).toBe('not_started');
  });

  it('discovery (real SQL): DSA rounds are found only for bank problems, only while coding rounds are on', async () => {
    const dsa = await seedStudent([dsaRound]);
    const plain = await seedStudent([{ ...dsaRound, name: 'Coding (HR runs it)', passRule: { mode: 'MARKS', value: 5 }, questions: [{ kind: 'CODING', text: 'Write anything', marks: 10, topics: [] }] }]);
    const store = new PrismaRoundEngineStore(prisma);
    const apps = async (flag: boolean) => (await store.screeningsToInvite(500, flag)).map((r) => r.applicationId);
    expect(await apps(true)).toContain(dsa.applicationId);
    expect(await apps(true)).not.toContain(plain.applicationId); // a coding question without a bank problem: HR runs it
    expect(await apps(false)).not.toContain(dsa.applicationId); // DSA_ROUNDS=off
    // an MCQ round is still found with coding rounds off
    const mcq = await seedStudent([{ type: 'APTITUDE', name: 'Aptitude', passRule: { mode: 'MARKS', value: 1 }, questions: [{ kind: 'MCQ', text: 'Q', options: ['a', 'b'], correct: [0] }] }]);
    expect(await apps(false)).toContain(mcq.applicationId);
  });

  it("HR reads the integrity record of their own company's student only", async () => {
    const s = await seedStudent([dsaRound]);
    const { token } = await invited(s.email);
    const svc = dsaService();
    await svc.proctorStart(token, consent);
    await svc.start(token);
    // a real violation: leaving full screen, then coming back
    await svc.proctorEvents(token, { events: [{ type: 'FULLSCREEN_EXIT' }] });
    await svc.proctorEvents(token, { events: [{ type: 'FULLSCREEN_RETURN' }] });
    const proctoring = new ProctoringService(new PrismaProctorStore(prisma), { ...policyFromEnv({}), enabled: true }, Date.now);
    const hr = (tenant: string) => new DsaHrController(new PrismaProctorStore(prisma), proctoring, new FixedTenant(tenant));
    const mine = await hr(tenantId).review(s.applicationId);
    expect(mine.applicationId).toBe(s.applicationId);
    expect(mine.rounds).toHaveLength(1);
    expect(mine.rounds[0]).toMatchObject({ roundId: s.saved[0]!.id, fullscreenExitCount: 1, strikesAllowed: 2, strikesUsed: 1 });
    expect(mine.rounds[0]!.events.map((e) => e.type)).toContain('FULLSCREEN_EXIT');
    expect(JSON.stringify(mine)).not.toContain(token);
    // another company asking for the same application id gets nothing
    const other = await hr(await seedCompany(db, 'Other Co')).review(s.applicationId);
    expect(other.rounds).toEqual([]);
  });

  it('shows HR the coding attempt next to the result', async () => {
    const s = await seedStudent([dsaRound]);
    const { token } = await invited(s.email);
    const svc = dsaService();
    await svc.proctorStart(token, consent);
    await svc.start(token);
    await svc.submit(token, { questionId: s.saved[0]!.questions[0]!.id, language: 'python', code: code(true) });
    await svc.finish(token);
    const view = await engine.forApplication(tenantId, s.applicationId);
    expect(view.rounds[0]).toMatchObject({ online: true, kind: 'CODING', invite: { emailStatus: 'SENT' }, attempt: { status: 'SUBMITTED', answered: 1, questionCount: 3 } });
  });
});
