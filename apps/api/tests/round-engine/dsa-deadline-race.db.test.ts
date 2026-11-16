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
import { policyFromEnv } from '../../src/modules/dsa/proctoring/proctoring.policy';
import { ProctoringService } from '../../src/modules/dsa/proctoring/proctoring.service';
import { BankQuestionRepository } from '../../src/modules/dsa/questions/bank-question.repository';
import { MOCK_QUESTIONS } from '../../src/modules/dsa/questions/mock-questions.data';
import { EngineSessionStore } from '../../src/modules/dsa/session/engine-session.store';
import { RoundInvitationResolver } from '../../src/modules/dsa/session/round-invitation.resolver';
import { RoundsConfigService } from '../../src/modules/rounds-config';
import { PrismaRoundsConfigStore } from '../../src/modules/rounds-config/rounds-config.store';
import { PENDING_SUBMISSION_MAX_MS } from '../../src/modules/round-engine/coding-round';
import { newAssessmentToken } from '../../src/modules/round-engine/link';
import { DEADLINE_GRACE_MS } from '../../src/modules/round-engine/online-test';
import { RoundEngineService } from '../../src/modules/round-engine/round-engine.service';
import { PrismaRoundEngineStore } from '../../src/modules/round-engine/round-engine.store';
import { seedApplication, seedCompany, seedJob } from '../ats/seed';
import { MemoryAudit } from '../in-memory';
import { FakeGenerator } from '../rounds/fakes';

/**
 * A DSA submission is judged by WHEN THE SERVER ACCEPTED IT, not by when its tests finished. Real database (the
 * isolated test database), one shared controllable clock for the engine (incl. its time-out sweep) and the DSA service,
 * and a code runner held at a gate so each test decides exactly when the tests finish relative to the deadline and the
 * sweep.
 *   TEST_DATABASE_URL=postgresql://user:pass@localhost:5432/<a test database> pnpm --filter api test
 */
const DB = process.env.TEST_DATABASE_URL;
const MIN = 60_000;
const SOLVED = 'SOLVED_MARKER';

const problem = (n: 1 | 2 | 3, marks: number, difficulty: 'EASY' | 'MEDIUM' | 'HARD') => ({ kind: 'CODING' as const, text: `DSA problem ${n}`, marks, difficulty, topics: [`dsa:dsa-00${n}`] });
/** Easy 10 + Medium 20 + Hard 30 = 60 marks, 25 to pass. 60 minutes. */
const dsaRound: RoundInput = {
  type: 'CODING',
  name: 'DSA Coding Round',
  description: 'Solve the problems.',
  timeLimitMinutes: 60,
  passRule: { mode: 'MARKS', value: 25 },
  questions: [problem(1, 10, 'EASY'), problem(2, 20, 'MEDIUM'), problem(3, 30, 'HARD')],
};

const expectedByStdin = new Map(MOCK_QUESTIONS.flatMap((q) => q.testCases.map((t) => [t.stdin, t.expectedOutput] as const)));
const ok = (stdout: string): RunnerResult => ({ verdict: 'ok', statusText: 'OK', stdout, stderr: '', compileOutput: '', timeMs: 5, memoryKb: 1000 });
const failed = (): RunnerResult => ({ verdict: 'internal_error', statusText: 'Internal Error', stdout: '', stderr: 'sandbox failure', compileOutput: '', timeMs: null, memoryKb: null });

/** Passes every test when the code carries SOLVED, fails them otherwise. Held at `gate` until the test opens it. */
class GatedRunner implements CodeRunner {
  calls = 0;
  mode: 'normal' | 'infra_error' = 'normal';
  private open!: () => void;
  private gate: Promise<void> = Promise.resolve();
  hold() {
    this.gate = new Promise<void>((r) => (this.open = r));
  }
  release() {
    this.open?.();
  }
  async runBatch(jobs: RunnerJob[]) {
    this.calls += 1;
    await this.gate;
    if (this.mode === 'infra_error') return jobs.map(failed);
    return jobs.map((j) => ok(`\n${RESULT_MARKER}${j.source.includes(SOLVED) ? expectedByStdin.get(j.stdin) : 'wrong'}\n`));
  }
}
const code = (solved: boolean) => `def solve():\n    pass  # ${solved ? SOLVED : 'nope'}\n`;
/** Waits for a condition (polling), failing the test after 15 s. */
async function until(check: () => Promise<boolean>, what: string) {
  for (const end = Date.now() + 15_000; Date.now() < end; await new Promise((r) => setTimeout(r, 25))) if (await check()) return;
  throw new Error(`timed out waiting for: ${what}`);
}

describe.skipIf(!DB)('DSA submission deadline race (real database)', () => {
  let db: PrismaClient;
  let prisma: PrismaService;
  let audit: MemoryAudit;
  let tenantId: string;
  let rounds: RoundsConfigService;
  let engine: RoundEngineService;
  let runner: GatedRunner;
  let clock: number;

  /** One "API instance": production wiring of the DSA service on the database, sharing the test clock. */
  const dsaService = () =>
    new DsaService(new RoundInvitationResolver(engine), new BankQuestionRepository(), new EngineSessionStore(engine), runner, () => clock, new ProctoringService(new PrismaProctorStore(prisma), { ...policyFromEnv({}), enabled: false }, () => clock));

  async function seedStudent() {
    const job = await seedJob(db, tenantId, { title: 'Backend Developer' });
    const student = await seedApplication(db, tenantId, job, { name: 'Asha Patel' });
    const saved = (await rounds.save(tenantId, job.jobId, { rounds: [dsaRound], complete: true }, { id: randomUUID(), name: 'Priya HR' })).rounds;
    return { ...student, jobId: job.jobId, saved, q: saved[0]!.questions.map((x) => x.id) };
  }
  /**
   * The DSA invitation as the worker leaves it once emailed (SENT, the personal link's token hash, 7 days), created
   * directly: the worker's shared invitation queue is not used, so test files running at the same time never pick up
   * each other's invitations (dsa-round.db.test.ts covers the invitation email itself). Then Start: the attempt's
   * clock begins at `clock`.
   */
  async function started() {
    const s = await seedStudent();
    const { token, tokenHash } = newAssessmentToken();
    await db.roundInvite.create({
      data: { id: randomUUID(), tenantId, applicationId: s.applicationId, jobId: s.jobId, roundId: s.saved[0]!.id, tokenHash, expiresAt: new Date(clock + 7 * 24 * 60 * MIN), emailStatus: 'SENT', sentAt: new Date(clock) },
    });
    await dsaService().start(token);
    const attempt = await db.roundAttempt.findFirstOrThrow({ where: { applicationId: s.applicationId } });
    return { ...s, token, attemptId: attempt.id, deadline: attempt.deadlineAt!.getTime() };
  }
  const attemptOf = (attemptId: string) => db.roundAttempt.findUniqueOrThrow({ where: { id: attemptId } });
  /**
   * The time-out sweep for THESE attempts: exactly what RoundEngineWorker.sweepOverdue() does with each attempt past its
   * deadline + grace (engine.finish(attempt, 'TIMED_OUT')). Only this test's attempts: the worker's own sweep would
   * also close other test files' attempts in the shared test database when the test clock is ahead.
   */
  async function sweep(...attemptIds: string[]) {
    const store = new PrismaRoundEngineStore(prisma);
    for (const id of attemptIds) {
      const a = await store.getAttempt(id);
      if (!a || a.status !== 'IN_PROGRESS' || !a.deadlineAt || a.deadlineAt.getTime() >= clock - DEADLINE_GRACE_MS) throw new Error('the attempt is not overdue for the sweep');
      await engine.finish(a, 'TIMED_OUT');
    }
  }
  const stateOf = async (attemptId: string) =>
    (await attemptOf(attemptId)).codingState as { progress: Record<string, { attempts: number; bestScore: number; bestCode: string | null }>; pending?: { id: string; acceptedAt: string } | null; finishReason: string | null };
  /** The submissions were ACCEPTED (stored as pending) and their tests are running (held at the gate). */
  const waitAccepted = (attemptIds: string[], callsBefore: number) =>
    until(async () => runner.calls >= callsBefore + attemptIds.length && (await Promise.all(attemptIds.map(stateOf))).every((st) => !!st.pending), 'the submissions to be accepted and running');
  const resultOf = (applicationId: string) => db.roundResult.findMany({ where: { applicationId } });

  beforeAll(async () => {
    if (!/test/i.test(new URL(DB!).pathname)) throw new Error('TEST_DATABASE_URL must point at a database whose name contains "test"');
    db = new PrismaClient({ datasourceUrl: DB });
    prisma = db as unknown as PrismaService;
  });
  afterAll(async () => db?.$disconnect());
  beforeEach(async () => {
    clock = Date.now();
    audit = new MemoryAudit();
    runner = new GatedRunner();
    tenantId = await seedCompany(db);
    rounds = new RoundsConfigService(new PrismaRoundsConfigStore(prisma), audit as never, new FakeGenerator().asClient());
    engine = new RoundEngineService(new PrismaRoundEngineStore(prisma), rounds, new AssessmentsService(new PrismaAssessmentsStore(prisma), rounds, audit as never), audit as never, { cameraRequired: true }, () => new Date(clock));
  });

  it('accepted 10 s before the deadline, tests finish 60 s after it, the sweep closes the attempt meanwhile: the result is SAVED, graded and shown to HR', async () => {
    const s = await started();
    clock = s.deadline - 10_000;
    runner.hold();
    const calls0 = runner.calls;
    const pending = dsaService().submit(s.token, { questionId: s.q[0]!, language: 'python', code: code(true) });
    await waitAccepted([s.attemptId], calls0);
    // accepted durably before the tests ran
    expect((await stateOf(s.attemptId)).pending).toMatchObject({ acceptedAt: new Date(s.deadline - 10_000).toISOString() });

    // the deadline passes, then the time-out sweep (deadline + 30 s grace) closes the attempt while the tests still run
    clock = s.deadline + 60_000;
    await sweep(s.attemptId);
    const swept = await attemptOf(s.attemptId);
    expect(swept.status).toBe('TIMED_OUT');
    expect((await stateOf(s.attemptId)).pending).not.toBeNull(); // the sweep never erases an accepted submission
    expect(swept.progressedAt).toBeNull(); // nothing graded / no email yet: the result is still coming
    expect(await resultOf(s.applicationId)).toHaveLength(0);
    await engine.progress(s.attemptId); // what the worker's recovery pass does: it waits too
    expect((await attemptOf(s.attemptId)).progressedAt).toBeNull();

    // the tests finish: the result is stored, THEN shown to the candidate
    runner.release();
    const res = await pending;
    expect(res).toMatchObject({ score: 10, maxScore: 10, passed: 8, total: 8 });
    const state = await stateOf(s.attemptId);
    expect(state.pending).toBeNull();
    expect(state.progress[s.q[0]!]).toMatchObject({ attempts: 1, bestScore: 10 });
    expect(state.progress[s.q[0]!]!.bestCode).toContain(SOLVED);
    // graded with it, once; the attempt stays closed
    const after = await attemptOf(s.attemptId);
    expect(after.status).toBe('TIMED_OUT');
    expect(after.progressedAt).not.toBeNull();
    const results = await resultOf(s.applicationId);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ score: 10, maxScore: 60, systemPassed: false });
    expect((await db.roundOutcomeEmail.findMany({ where: { applicationId: s.applicationId } })).map((e) => e.kind)).toEqual(['REJECTED']);
    // HR sees what the candidate saw
    const view = await engine.forApplication(tenantId, s.applicationId);
    expect(view.rounds[0]).toMatchObject({ attempt: { status: 'TIMED_OUT', answered: 1 } });
    const answers = results[0]!.answers as { marksAwarded: number }[];
    expect(answers.map((a) => a.marksAwarded)).toEqual([10, 0, 0]);
  });

  it('accepted right before the sweep runs: kept and graded with it (a passing result moves the student on)', async () => {
    const s = await started();
    // two problems solved earlier: 10 + 20 = 30 of 60 already passes; this last one adds 30
    for (const qid of [s.q[0]!, s.q[1]!]) await dsaService().submit(s.token, { questionId: qid, language: 'python', code: code(true) });
    clock = s.deadline - 1;
    runner.hold();
    const calls0 = runner.calls;
    const pending = dsaService().submit(s.token, { questionId: s.q[2]!, language: 'cpp', code: code(true) });
    await waitAccepted([s.attemptId], calls0);
    clock = s.deadline + 31_000;
    await sweep(s.attemptId);
    runner.release();
    expect(await pending).toMatchObject({ score: 30 });
    const results = await resultOf(s.applicationId);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ score: 60, systemPassed: true });
    expect((await db.roundOutcomeEmail.findMany({ where: { applicationId: s.applicationId } })).map((e) => e.kind)).toEqual(['CLEARED_ALL']);
  });

  it('exactly at the deadline, and after it: refused, never run, no marks', async () => {
    const s = await started();
    clock = s.deadline; // the boundary: the deadline itself is too late
    await expect(dsaService().submit(s.token, { questionId: s.q[0]!, language: 'python', code: code(true) })).rejects.toMatchObject({ response: { code: 'TIME_EXPIRED' } });
    expect(runner.calls).toBe(0);
    // the engine's own acceptance check agrees, at and after the deadline
    expect(await engine.acceptCodingSubmission(s.token, s.q[0]!)).toEqual({ accepted: false, reason: 'ENDED' }); // the page closed it at the deadline
    const t = await started();
    clock = t.deadline;
    expect(await engine.acceptCodingSubmission(t.token, t.q[0]!)).toEqual({ accepted: false, reason: 'TIME_EXPIRED' });
    clock = t.deadline + 5_000;
    expect(await engine.acceptCodingSubmission(t.token, t.q[0]!)).toEqual({ accepted: false, reason: 'TIME_EXPIRED' });
    clock = t.deadline - 1; // one millisecond before: accepted
    expect(await engine.acceptCodingSubmission(t.token, t.q[0]!)).toMatchObject({ accepted: true });
    expect(runner.calls).toBe(0);
    expect((await stateOf(s.attemptId)).progress[s.q[0]!]).toBeUndefined();
  });

  it('two submissions at the same moment (two API instances): one is judged, the other is refused; one result', async () => {
    const s = await started();
    runner.hold();
    let refusedYet = false;
    const both = Promise.allSettled([
      dsaService().submit(s.token, { questionId: s.q[0]!, language: 'python', code: code(true) }).catch((e) => ((refusedYet = true), Promise.reject(e))),
      dsaService().submit(s.token, { questionId: s.q[1]!, language: 'java', code: code(true) }).catch((e) => ((refusedYet = true), Promise.reject(e))),
    ]);
    await until(async () => refusedYet && runner.calls >= 1, 'one judged, the other refused');
    runner.release();
    const [a, b] = await both;
    const judged = [a, b].filter((r) => r.status === 'fulfilled');
    const refused = [a, b].filter((r) => r.status === 'rejected');
    expect(judged).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect((refused[0] as PromiseRejectedResult).reason.getResponse()).toMatchObject({ code: 'BUSY' });
    const state = await stateOf(s.attemptId);
    expect(Object.values(state.progress).reduce((n, p) => n + p.attempts, 0)).toBe(1);
    expect(state.pending).toBeNull();
  });

  it('a result can be recorded only once (no duplicate result)', async () => {
    const s = await started();
    const acc = await engine.acceptCodingSubmission(s.token, s.q[0]!);
    expect(acc.accepted).toBe(true);
    const id = (acc as { id: string }).id;
    const build = (prev?: { attempts: number }) => ({ attempts: (prev?.attempts ?? 0) + 1, bestScore: 10, passed: 8, total: 8, language: 'python', lastVerdict: 'passed', bestCode: 'x' });
    expect(await engine.completeCodingSubmission(s.token, id, s.q[0]!, build)).toMatchObject({ attempts: 1 });
    expect(await engine.completeCodingSubmission(s.token, id, s.q[0]!, build)).toBeNull(); // the same submission again
    expect(await engine.completeCodingSubmission(s.token, randomUUID(), s.q[0]!, build)).toBeNull(); // one never accepted
    expect((await stateOf(s.attemptId)).progress[s.q[0]!]).toMatchObject({ attempts: 1 });
  });

  it('code runner failure while the attempt closes: 503, nothing recorded, the attempt is then graded without it', async () => {
    const s = await started();
    await dsaService().submit(s.token, { questionId: s.q[0]!, language: 'python', code: code(true) }); // 10 marks before
    clock = s.deadline - 5_000;
    runner.mode = 'infra_error';
    runner.hold();
    const calls0 = runner.calls;
    const pending = dsaService().submit(s.token, { questionId: s.q[1]!, language: 'python', code: code(true) });
    await waitAccepted([s.attemptId], calls0);
    clock = s.deadline + 40_000;
    await sweep(s.attemptId);
    expect((await attemptOf(s.attemptId)).progressedAt).toBeNull();
    runner.release();
    await expect(pending).rejects.toMatchObject({ response: { code: 'CODE_RUNNER_UNAVAILABLE' } });
    const state = await stateOf(s.attemptId);
    expect(state.pending).toBeNull();
    expect(state.progress[s.q[1]!]).toBeUndefined(); // not counted as an attempt
    expect(await resultOf(s.applicationId)).toEqual([expect.objectContaining({ score: 10 })]);
    expect((await attemptOf(s.attemptId)).progressedAt).not.toBeNull();
  });

  it('a page refresh / API restart while the tests run: the accepted submission is kept, a second one waits, the result arrives', async () => {
    const s = await started();
    runner.hold();
    const calls0 = runner.calls;
    const pending = dsaService().submit(s.token, { questionId: s.q[0]!, language: 'python', code: code(true) });
    await waitAccepted([s.attemptId], calls0);
    // the page is reloaded on another API instance: the attempt is there, and the accepted submission still holds it
    const fresh = dsaService();
    expect((await fresh.getState(s.token)).status).toBe('in_progress');
    await expect(fresh.submit(s.token, { questionId: s.q[1]!, language: 'python', code: code(true) })).rejects.toMatchObject({ response: { code: 'BUSY' } });
    runner.release();
    await pending;
    expect((await dsaService().getState(s.token)).progress.find((p) => p.questionId === s.q[0]!)).toMatchObject({ bestScore: 10, attempts: 1 });
  });

  it('refresh during judging: the state says which question is being judged (the page shows "Judging…"), then the saved score', async () => {
    const s = await started();
    runner.hold();
    const calls0 = runner.calls;
    const acceptedAt = clock;
    const pending = dsaService().submit(s.token, { questionId: s.q[0]!, language: 'python', code: code(true) });
    await waitAccepted([s.attemptId], calls0);
    // the reloaded page, on another API instance
    const during = await dsaService().getState(s.token);
    expect(during.judging).toEqual({ questionId: s.q[0]!, acceptedAt: new Date(acceptedAt).toISOString() });
    expect(during.progress.find((p) => p.questionId === s.q[0]!)).toMatchObject({ attempts: 0 }); // not saved yet: no score shown
    expect(Object.keys(during.judging!).sort()).toEqual(['acceptedAt', 'questionId']); // the submission's internal id is not sent
    runner.release();
    await pending;
    const after = await dsaService().getState(s.token);
    expect(after.judging).toBeNull();
    expect(after.progress.find((p) => p.questionId === s.q[0]!)).toMatchObject({ attempts: 1, bestScore: 10 }); // what the page then shows
  });

  it('refresh during judging that then fails (code runner): judging ends with nothing saved, so the page can say "submit again"', async () => {
    const s = await started();
    runner.mode = 'infra_error';
    runner.hold();
    const calls0 = runner.calls;
    const pending = dsaService().submit(s.token, { questionId: s.q[0]!, language: 'python', code: code(true) });
    await waitAccepted([s.attemptId], calls0);
    expect((await dsaService().getState(s.token)).judging).toMatchObject({ questionId: s.q[0]! });
    runner.release();
    await expect(pending).rejects.toMatchObject({ response: { code: 'CODE_RUNNER_UNAVAILABLE' } });
    const after = await dsaService().getState(s.token);
    expect(after.judging).toBeNull();
    expect(after.progress.find((p) => p.questionId === s.q[0]!)).toMatchObject({ attempts: 0 });
    // and the candidate can submit again at once
    runner.mode = 'normal';
    expect(await dsaService().submit(s.token, { questionId: s.q[0]!, language: 'python', code: code(true) })).toMatchObject({ score: 10 });
  });

  it('an abandoned accepted submission (API stopped) is no longer reported as judging after the same limit grading uses', async () => {
    const s = await started();
    runner.hold();
    const calls0 = runner.calls;
    const pending = dsaService().submit(s.token, { questionId: s.q[0]!, language: 'python', code: code(true) }).catch(() => undefined);
    await waitAccepted([s.attemptId], calls0);
    clock += PENDING_SUBMISSION_MAX_MS - 1_000;
    expect((await dsaService().getState(s.token)).judging).not.toBeNull();
    clock += 2_000;
    expect((await dsaService().getState(s.token)).judging).toBeNull();
    runner.release();
    await pending; // let it finish inside this test
  });

  it('the candidate presses Finish while a submission is being judged: it still counts (accepted before Finish)', async () => {
    const s = await started();
    runner.hold();
    const calls0 = runner.calls;
    const pending = dsaService().submit(s.token, { questionId: s.q[1]!, language: 'python', code: code(true) });
    await waitAccepted([s.attemptId], calls0);
    await dsaService().finish(s.token);
    expect((await attemptOf(s.attemptId)).status).toBe('SUBMITTED');
    expect(await resultOf(s.applicationId)).toHaveLength(0); // waits for the result
    runner.release();
    expect(await pending).toMatchObject({ score: 20 });
    expect(await resultOf(s.applicationId)).toEqual([expect.objectContaining({ score: 20 })]);
  });

  it('an accepted submission whose result never comes (API stopped) is abandoned after the limit: graded without it, a late result is refused', async () => {
    const s = await started();
    await dsaService().submit(s.token, { questionId: s.q[0]!, language: 'python', code: code(true) });
    clock = s.deadline - 1_000;
    runner.hold();
    const calls0 = runner.calls;
    const pending = dsaService().submit(s.token, { questionId: s.q[1]!, language: 'python', code: code(true) });
    await waitAccepted([s.attemptId], calls0);
    clock = s.deadline + 40_000;
    await sweep(s.attemptId);
    expect((await attemptOf(s.attemptId)).progressedAt).toBeNull();
    clock = s.deadline - 1_000 + PENDING_SUBMISSION_MAX_MS + 1;
    await engine.progress(s.attemptId); // what the worker's recovery pass does
    expect((await attemptOf(s.attemptId)).progressedAt).not.toBeNull(); // graded without the lost one
    runner.release();
    await expect(pending).rejects.toMatchObject({ response: { code: 'SUBMISSION_NOT_RECORDED' } }); // never shown as scored
    expect(await resultOf(s.applicationId)).toEqual([expect.objectContaining({ score: 10 })]);
  });

  it('several candidates submit at once just before their deadline, the sweep runs, all results are saved', async () => {
    const all = await Promise.all([started(), started(), started()]);
    clock = Math.max(...all.map((x) => x.deadline)) - 2_000;
    runner.hold();
    const calls0 = runner.calls;
    const pending = all.map((x, i) => dsaService().submit(x.token, { questionId: x.q[i]!, language: (['python', 'java', 'cpp'] as const)[i]!, code: code(true) }));
    await waitAccepted(all.map((x) => x.attemptId), calls0);
    clock += 2 * MIN;
    await sweep(...all.map((x) => x.attemptId));
    runner.release();
    const res = await Promise.all(pending);
    expect(res.map((r) => r.score)).toEqual([10, 20, 30]);
    for (const [i, x] of all.entries()) {
      expect((await stateOf(x.attemptId)).progress[x.q[i]!]).toMatchObject({ attempts: 1, bestScore: [10, 20, 30][i] });
      expect(await resultOf(x.applicationId)).toEqual([expect.objectContaining({ score: [10, 20, 30][i] })]);
    }
  });
});
