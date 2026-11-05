import 'reflect-metadata';
import { HttpException } from '@nestjs/common';
import type { RoundInput, SavedRound } from '@hireflow/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import { AssessmentsService } from '../../src/modules/assessments';
import { RoundsConfigService } from '../../src/modules/rounds-config';
import { CODING_CONSENT_VERSION, codingMarks, parseCodingState, toCodingAnswers, type CodingState } from '../../src/modules/round-engine/coding-round';
import { dsaBaseUrlFromEnv, newAssessmentToken } from '../../src/modules/round-engine/link';
import { nextStep, roundKind } from '../../src/modules/round-engine/online-test';
import { RoundEngineService } from '../../src/modules/round-engine/round-engine.service';
import { RoundEngineWorker, type RoundEngineWorkerConfig } from '../../src/modules/round-engine/round-engine.worker';
import { MemoryAudit } from '../in-memory';
import { ACTOR, APP, FakeGenerator, JOB, MemoryAssessmentsStore, MemoryRoundsConfigStore, TENANT, student } from '../rounds/fakes';
import { FakeMailer, MemoryRoundEngineStore } from './fakes';

const T0 = new Date('2026-11-02T09:00:00Z');
const DAY = 24 * 60 * 60_000;
const MIN = 60_000;

const problem = (n: 1 | 2 | 3, marks: number, difficulty: 'EASY' | 'MEDIUM' | 'HARD') => ({
  kind: 'CODING' as const,
  text: `DSA problem ${n}`,
  marks,
  difficulty,
  topics: [`dsa:dsa-00${n}`],
});

/** Easy 10 + Medium 20 + Hard 30 = 60 marks; 25 to pass: the example HR gave. */
const dsa: RoundInput = {
  type: 'CODING',
  name: 'DSA Coding Round',
  description: 'Solve the problems. Any of Python, Java or C++.',
  timeLimitMinutes: 60,
  passRule: { mode: 'MARKS', value: 25 },
  questions: [problem(1, 10, 'EASY'), problem(2, 20, 'MEDIUM'), problem(3, 30, 'HARD')],
};
const aptitude: RoundInput = {
  type: 'APTITUDE',
  name: 'Aptitude',
  timeLimitMinutes: 20,
  passRule: { mode: 'MARKS', value: 1 },
  questions: [{ kind: 'MCQ', text: 'Q1', options: ['a', 'b'], correct: [1] }],
};
const interview: RoundInput = { type: 'HR_INTERVIEW', name: 'Personal Interview', passRule: { mode: 'INTERVIEWER_SCORE', value: 6, maxScore: 10 } };

let now: Date;
let store: MemoryRoundEngineStore;
let results: MemoryAssessmentsStore;
let audit: MemoryAudit;
let rounds: RoundsConfigService;
let engine: RoundEngineService;
let saved: SavedRound[];

const clock = () => new Date(now);
const status = (err: unknown) => (err as HttpException).getStatus();
const code = (err: unknown) => ((err as HttpException).getResponse() as { code: string }).code;
const caught = async (p: Promise<unknown>) => p.then(() => { throw new Error('expected an error'); }, (e: unknown) => e);

function invite(roundId: string, opts: { expiresAt?: Date; revoked?: boolean } = {}) {
  const t = newAssessmentToken();
  store.invites.push({
    id: `0192f3a1-dddd-7000-8000-${String(store.invites.length + 1).padStart(12, '0')}`,
    tenantId: TENANT,
    applicationId: APP,
    jobId: JOB,
    roundId,
    tokenHash: t.tokenHash,
    expiresAt: opts.expiresAt ?? new Date(now.getTime() + 7 * DAY),
    revokedAt: opts.revoked ? now : null,
    emailStatus: 'SENT',
    attempts: 1,
    sentAt: now,
    lastError: null,
  });
  return t.token;
}

/** The best submissions of the three problems, in HR's question order: [easy, medium, hard] marks earned. */
function state(marks: [number, number, number]): CodingState {
  const out: CodingState = { progress: {}, finishReason: null };
  saved.find((r) => r.type === 'CODING')!.questions.forEach((q, i) => {
    const earned = marks[i]!;
    out.progress[q.id] = { attempts: earned > 0 ? 1 : 0, bestScore: earned, passed: earned > 0 ? 3 : 0, total: earned === q.marks ? 3 : 6, language: 'python', lastVerdict: earned === q.marks ? 'passed' : 'failed', bestCode: earned > 0 ? `solution ${i + 1}` : null };
  });
  return out;
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
      dsaBaseUrl: 'https://candidates.example.com/dsa/{token}',
      linkDays: 7,
      allowLocalLinks: false,
      ...config,
    },
    { cameraRequired: true },
    clock,
  );
  return { w, mailer };
}

async function setup(roundInputs: RoundInput[]) {
  saved = (await rounds.save(TENANT, JOB, { rounds: roundInputs, complete: true }, ACTOR)).rounds;
}

beforeEach(() => {
  now = new Date(T0);
  const roundsStore = new MemoryRoundsConfigStore();
  roundsStore.addJob(TENANT, JOB);
  results = new MemoryAssessmentsStore();
  results.jobs.push({ id: JOB, tenantId: TENANT, title: 'AI Engineer' });
  results.students.push({ ...student(), tenantId: TENANT });
  store = new MemoryRoundEngineStore();
  store.contexts.set(APP, {
    tenantId: TENANT,
    applicationId: APP,
    jobId: JOB,
    candidateName: 'Asha Patel',
    email: 'asha@example.com',
    jobTitle: 'AI Engineer',
    companyName: 'Pattern Labs',
    companyWebsite: 'https://pattern.example.com',
  });
  audit = new MemoryAudit();
  rounds = new RoundsConfigService(roundsStore, audit, new FakeGenerator().asClient());
  engine = new RoundEngineService(store, rounds, new AssessmentsService(results, rounds, audit), audit, { cameraRequired: true }, clock);
});

describe('which rounds the engine runs as a DSA round', () => {
  beforeEach(() => setup([aptitude, dsa, interview]));

  it('a round whose questions are all bank problems with a score rule is a coding round', () => {
    expect(roundKind(saved[0]!)).toBe('TEST');
    expect(roundKind(saved[1]!)).toBe('CODING');
    expect(roundKind(saved[2]!)).toBeNull();
  });

  it('is left to HR when coding rounds are switched off, when a question has no bank problem, or the rule is an interviewer score', () => {
    expect(roundKind(saved[1]!, false)).toBeNull();
    const plain = { ...saved[1]!, questions: [...saved[1]!.questions, { ...saved[1]!.questions[0]!, id: 'x', topics: [] }] };
    expect(roundKind(plain)).toBeNull();
    expect(roundKind({ ...saved[1]!, passRule: { mode: 'INTERVIEWER_SCORE', value: 5, maxScore: 10 } })).toBeNull();
  });

  it('after the aptitude test a pass leads to the DSA invitation; a pass of the DSA round leads to the HR interview', () => {
    expect(nextStep(saved, saved[0]!, true)).toMatchObject({ kind: 'INVITE', roundKind: 'CODING', round: { id: saved[1]!.id } });
    expect(nextStep(saved, saved[1]!, true)).toEqual({ kind: 'EMAIL', email: 'CLEARED_NEXT_BY_HR', nextRoundName: 'Personal Interview' });
    expect(nextStep(saved, saved[1]!, false)).toEqual({ kind: 'EMAIL', email: 'REJECTED', nextRoundName: null });
  });

  it('the rounds editor cannot save a problem that is not in the bank, or a bank problem on a non-coding question', async () => {
    const bad = (q: object): RoundInput => ({ ...dsa, name: 'Bad', questions: [{ ...problem(1, 10, 'EASY'), ...q } as never] });
    const unknown = await caught(rounds.save(TENANT, JOB, { rounds: [bad({ topics: ['dsa:dsa-999'] })], complete: false }, ACTOR));
    expect(code(unknown)).toBe('INVALID_ROUNDS');
    const notCoding = await caught(rounds.save(TENANT, JOB, { rounds: [bad({ kind: 'DESCRIPTIVE' })], complete: false }, ACTOR));
    expect(code(notCoding)).toBe('INVALID_ROUNDS');
  });
});

describe('the DSA link', () => {
  it('is taken from DSA_ASSESSMENT_URL or CANDIDATE_APP_URL, and never localhost in production', () => {
    expect(dsaBaseUrlFromEnv({ CANDIDATE_APP_URL: 'https://cand.example.com/' })).toBe('https://cand.example.com/dsa/{token}');
    expect(dsaBaseUrlFromEnv({ DSA_ASSESSMENT_URL: 'https://x.example.com/dsa/{token}', CANDIDATE_APP_URL: 'https://other' })).toBe('https://x.example.com/dsa/{token}');
    expect(dsaBaseUrlFromEnv({})).toBeNull();
    expect(dsaBaseUrlFromEnv({ CANDIDATE_APP_URL: 'http://localhost:3001', NODE_ENV: 'production' })).toBeNull();
    expect(dsaBaseUrlFromEnv({ CANDIDATE_APP_URL: 'ftp://x' })).toBeNull();
  });
});

describe('after AI screening: the DSA invitation email', () => {
  beforeEach(() => setup([dsa, interview]));

  it('invites a student whose AI screening is complete when the first round is a DSA round', async () => {
    store.completedScreenings.push({ tenantId: TENANT, applicationId: APP, jobId: JOB, roundId: saved[0]!.id });
    const { w } = worker();
    expect(await w.discover()).toBe(1);
    expect(store.invites).toHaveLength(1);
    expect(store.invites[0]).toMatchObject({ applicationId: APP, roundId: saved[0]!.id, emailStatus: 'QUEUED' });
  });

  it('emails the personal DSA link (not the careers-site link) with coding wording and no camera requirement', async () => {
    store.completedScreenings.push({ tenantId: TENANT, applicationId: APP, jobId: JOB, roundId: saved[0]!.id });
    const { w, mailer } = worker();
    await w.discover();
    expect(await w.sendInvites()).toBe(1);
    expect(mailer.sent).toHaveLength(1);
    const { to, message } = mailer.sent[0]!;
    expect(to).toBe('asha@example.com');
    expect(message.subject).toBe("Congratulations! You've Been Shortlisted for AI Engineer – Next Step: DSA Coding Round");
    const link = /https:\/\/candidates\.example\.com\/dsa\/([A-Za-z0-9_-]{43})/.exec(message.text);
    expect(link).not.toBeNull();
    expect(message.text).not.toContain('careers.example.com');
    expect(message.text).toContain('3 coding problems · 60 minutes');
    expect(message.text).toContain('Python, Java or C++');
    expect(message.text).toContain('Nothing needs to be installed');
    expect(message.text).not.toMatch(/webcam/i);
    // the link in the email opens exactly this student's coding round
    const ctx = await engine.openCodingRound(link![1]);
    expect(ctx).toMatchObject({ applicationId: APP, candidateName: 'Asha Patel', minutes: 60, attempt: null });
    expect(ctx.round.id).toBe(saved[0]!.id);
    // nothing in the email reveals marks or the pass mark
    expect(message.text).not.toMatch(/25|pass mark|passing/i);
  });

  it('waits (no attempt used) while the DSA link is not set up, and sends once it is', async () => {
    store.completedScreenings.push({ tenantId: TENANT, applicationId: APP, jobId: JOB, roundId: saved[0]!.id });
    const waiting = worker({ dsaBaseUrl: null });
    await waiting.w.discover();
    await waiting.w.sendInvites();
    expect(waiting.mailer.sent).toHaveLength(0);
    expect(store.invites[0]).toMatchObject({ emailStatus: 'QUEUED' });
    expect(store.invites[0]!.lastError).toContain('DSA link');
    now = new Date(now.getTime() + 6 * MIN);
    const ready = worker();
    await ready.w.sendInvites();
    expect(ready.mailer.sent).toHaveLength(1);
  });

  it('a localhost DSA link is held back (a candidate could never open it) unless local links are allowed', async () => {
    store.completedScreenings.push({ tenantId: TENANT, applicationId: APP, jobId: JOB, roundId: saved[0]!.id });
    const local = worker({ dsaBaseUrl: 'http://localhost:3001/dsa/{token}' });
    await local.w.discover();
    await local.w.sendInvites();
    expect(local.mailer.sent).toHaveLength(0);
  });
});

describe('DSA after the aptitude round: the DSA email goes only to students who passed aptitude', () => {
  beforeEach(() => setup([aptitude, dsa, interview]));

  /** The student takes the aptitude test (1 MCQ, option 1 is right, 1 mark needed) and submits. */
  async function takeAptitude(right: boolean) {
    const token = invite(saved[0]!.id);
    await engine.start(token, { consent: true });
    await engine.submit(token, { revision: 1, answers: [{ questionId: saved[0]!.questions[0]!.id, selected: [right ? 1 : 0], marked: false }] });
  }

  it('AI screening completed invites to the aptitude round only, never straight to the DSA round', async () => {
    store.completedScreenings.push({ tenantId: TENANT, applicationId: APP, jobId: JOB, roundId: saved[0]!.id });
    expect(await engine.inviteToFirstRound({ tenantId: TENANT, applicationId: APP, jobId: JOB, roundId: saved[1]!.id })).toBe(false);
    const { w, mailer } = worker();
    await w.discover();
    await w.sendInvites();
    expect(store.invites.map((i) => i.roundId)).toEqual([saved[0]!.id]);
    expect(mailer.sent.map((m) => m.message.subject)).toEqual(["Congratulations! You've Been Shortlisted for AI Engineer – Next Step: Aptitude"]);
  });

  it('FAILED aptitude: no DSA invitation is created or emailed; the student gets the rejection email', async () => {
    await takeAptitude(false);
    expect(results.results[0]).toMatchObject({ roundId: saved[0]!.id, systemPassed: false });
    expect(store.invites.some((i) => i.roundId === saved[1]!.id)).toBe(false);
    expect(store.outcomeEmails).toEqual([expect.objectContaining({ roundId: saved[0]!.id, kind: 'REJECTED' })]);
    const { w, mailer } = worker();
    await w.sendInvites();
    await w.sendOutcomeEmails();
    expect(mailer.sent.map((m) => m.message.subject)).toEqual(['Application Update – AI Engineer at Pattern Labs']);
    expect(mailer.sent.some((m) => /dsa\//.test(m.message.text))).toBe(false);
  });

  it('PASSED aptitude: the DSA invitation (and no outcome email) is sent, with the personal DSA link', async () => {
    await takeAptitude(true);
    expect(results.results[0]).toMatchObject({ roundId: saved[0]!.id, systemPassed: true });
    expect(store.outcomeEmails).toHaveLength(0);
    expect(store.invites.filter((i) => i.roundId === saved[1]!.id)).toHaveLength(1);
    const { w, mailer } = worker();
    await w.sendInvites();
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]!.message.subject).toBe("Congratulations! You've Been Shortlisted for AI Engineer – Next Step: DSA Coding Round");
    expect(mailer.sent[0]!.message.text).toContain('Based on your performance in the Aptitude');
    expect(mailer.sent[0]!.message.text).toContain('you have been shortlisted for the next stage of our recruitment process: the DSA Coding Round');
    expect(mailer.sent[0]!.message.text).toMatch(/https:\/\/candidates\.example\.com\/dsa\/[A-Za-z0-9_-]{43}/);
  });

  it('an HR override to PASSED made before the result is processed counts as passed (the DSA email follows)', async () => {
    const token = invite(saved[0]!.id);
    await engine.start(token, { consent: true });
    // HR's override lives on the result; the outcome the engine acts on includes it
    const attemptId = store.attempts[0]!.id;
    await store.finishAttempt(attemptId, 'SUBMITTED', new Date(now));
    await results.upsertResult(TENANT, 'r1', {
      applicationId: APP, jobId: JOB, roundId: saved[0]!.id, passMode: 'MARKS', correctCount: 0, marks: 0, interviewerScore: null,
      answers: [], score: 0, maxScore: 1, passMark: 1, systemPassed: false, notes: null, startedAt: null, submittedAt: new Date(now),
    } as never);
    await results.setOverride(TENANT, APP, saved[0]!.id, { passed: true, reason: 'Re-evaluated', byId: null, byName: 'HR', at: new Date(now) });
    await engine.progress(attemptId);
    expect(store.invites.filter((i) => i.roundId === saved[1]!.id)).toHaveLength(1);
    expect(store.outcomeEmails).toHaveLength(0);
  });
});

describe('the candidate runs the DSA round', () => {
  let token: string;
  beforeEach(async () => {
    await setup([aptitude, dsa, interview]);
    token = invite(saved[1]!.id);
  });

  it('opens the round with its questions as HR set them, before anything started', async () => {
    const ctx = await engine.openCodingRound(token);
    expect(ctx.round.questions.map((q) => [q.marks, q.topics[0]])).toEqual([[10, 'dsa:dsa-001'], [20, 'dsa:dsa-002'], [30, 'dsa:dsa-003']]);
    expect(ctx).toMatchObject({ tenantId: TENANT, applicationId: APP, minutes: 60, attempt: null });
  });

  it('a multiple-choice link does not open the coding page, and a coding link does not open the multiple-choice page', async () => {
    const mcq = invite(saved[0]!.id);
    expect(code(await caught(engine.openCodingRound(mcq)))).toBe('ASSESSMENT_UNAVAILABLE');
    expect(code(await caught(engine.view(token)))).toBe('ASSESSMENT_UNAVAILABLE');
    expect(code(await caught(engine.openCodingRound('x'.repeat(43))))).toBe('ASSESSMENT_LINK_INVALID');
  });

  it('refuses a withdrawn link (410) and a link that expired before the start (410)', async () => {
    const revoked = invite(saved[1]!.id, { revoked: true });
    expect([status(await caught(engine.openCodingRound(revoked))), code(await caught(engine.openCodingRound(revoked)))]).toEqual([410, 'ASSESSMENT_LINK_REVOKED']);
    const expired = invite(saved[1]!.id, { expiresAt: new Date(now.getTime() - 1000) });
    expect(code(await caught(engine.openCodingRound(expired)))).toBe('ASSESSMENT_LINK_EXPIRED');
  });

  it('starts once: the clock is the round time limit from the start, a second start gives the same attempt', async () => {
    const a = await engine.startCodingAttempt(token, new Date(now));
    expect(a.deadlineAt!.getTime() - a.startedAt.getTime()).toBe(60 * MIN);
    expect(a.codingState).toEqual({ progress: {}, finishReason: null });
    const again = await engine.startCodingAttempt(token, new Date(now.getTime() + 5000));
    expect(again.id).toBe(a.id);
    expect(store.attempts).toHaveLength(1);
    expect(audit.entries.filter((e) => e.action === 'assessment.started')).toHaveLength(1);
    expect(store.attempts[0]).toMatchObject({ tenantId: TENANT, applicationId: APP });
    expect(CODING_CONSENT_VERSION).toBe('dsa-1');
  });

  it('never trusts a start time far from the server clock', async () => {
    const a = await engine.startCodingAttempt(token, new Date(now.getTime() - 3 * 60 * MIN));
    expect(a.startedAt.getTime()).toBe(now.getTime());
  });

  it('keeps the progress while running and refuses to store it after the attempt ended', async () => {
    await engine.startCodingAttempt(token, new Date(now));
    expect(await engine.saveCodingProgress(token, state([10, 0, 0]))).toBe(true);
    expect(store.attempts[0]!.codingState!.progress[saved[1]!.questions[0]!.id]!.bestScore).toBe(10);
    await engine.finishCodingAttempt(token, 'submitted', state([10, 0, 0]));
    expect(await engine.saveCodingProgress(token, state([10, 20, 30]))).toBe(false);
    expect(store.attempts[0]!.codingState!.progress[saved[1]!.questions[2]!.id]!.bestScore).toBe(0);
  });

  it('PASS: 30 of 60 marks with 25 needed records the result, and the student is told the HR interview is next', async () => {
    await engine.startCodingAttempt(token, new Date(now));
    await engine.finishCodingAttempt(token, 'submitted', state([10, 20, 0]));
    expect(results.results).toHaveLength(1);
    expect(results.results[0]).toMatchObject({ roundId: saved[1]!.id, score: 30, maxScore: 60, passMark: 25, systemPassed: true });
    expect(store.attempts[0]).toMatchObject({ status: 'SUBMITTED', systemPassed: true });
    expect(store.outcomeEmails).toHaveLength(1);
    expect(store.outcomeEmails[0]).toMatchObject({ kind: 'CLEARED_NEXT_BY_HR', nextRoundName: 'Personal Interview', roundId: saved[1]!.id });
    expect(store.invites.filter((i) => i.roundId !== saved[1]!.id)).toHaveLength(0);
  });

  it('FAIL: 10 of 60 marks with 25 needed records the result and queues the rejection email', async () => {
    await engine.startCodingAttempt(token, new Date(now));
    await engine.finishCodingAttempt(token, 'submitted', state([10, 0, 0]));
    expect(results.results[0]).toMatchObject({ score: 10, maxScore: 60, passMark: 25, systemPassed: false });
    expect(store.outcomeEmails).toHaveLength(1);
    expect(store.outcomeEmails[0]).toMatchObject({ kind: 'REJECTED', nextRoundName: null });
  });

  it('records the answers question by question: marks, solved or not, the best code and a summary', async () => {
    await engine.startCodingAttempt(token, new Date(now));
    await engine.finishCodingAttempt(token, 'submitted', state([10, 5, 0]));
    const answers = results.results[0]!.answers;
    expect(answers).toHaveLength(3);
    expect(answers[0]).toMatchObject({ questionId: saved[1]!.questions[0]!.id, answer: 'solution 1', isCorrect: true, marksAwarded: 10 });
    expect(answers[1]).toMatchObject({ answer: 'solution 2', isCorrect: false, marksAwarded: 5 });
    expect(answers[2]).toMatchObject({ answer: null, isCorrect: false, marksAwarded: 0, feedback: 'Not attempted' });
    expect(answers[0]!.feedback).toBe('3 of 3 tests passed (python), 1 submission');
  });

  it('finishing twice, or racing, never records twice or sends two emails', async () => {
    await engine.startCodingAttempt(token, new Date(now));
    await Promise.all([engine.finishCodingAttempt(token, 'submitted', state([10, 20, 0])), engine.finishCodingAttempt(token, 'submitted', state([10, 20, 0]))]);
    await engine.finishCodingAttempt(token, 'submitted', state([10, 20, 30]));
    expect(results.results).toHaveLength(1);
    expect(results.results[0]!.score).toBe(30);
    expect(store.outcomeEmails).toHaveLength(1);
    expect(audit.entries.filter((e) => e.action === 'assessment.progressed')).toHaveLength(1);
  });

  it('an ended attempt (disqualified) keeps what was submitted so far and is judged on it', async () => {
    await engine.startCodingAttempt(token, new Date(now));
    await engine.finishCodingAttempt(token, 'disqualified', state([10, 0, 0]));
    expect(store.attempts[0]).toMatchObject({ status: 'SUBMITTED' });
    expect(store.attempts[0]!.codingState!.finishReason).toBe('disqualified');
    expect(results.results[0]).toMatchObject({ score: 10, systemPassed: false });
    expect(store.outcomeEmails[0]!.kind).toBe('REJECTED');
  });

  it('a candidate who never comes back is timed out by the engine with the saved progress', async () => {
    await engine.startCodingAttempt(token, new Date(now));
    await engine.saveCodingProgress(token, state([10, 20, 0]));
    now = new Date(now.getTime() + 61 * MIN);
    const { w } = worker();
    await w.sweepOverdue();
    expect(store.attempts[0]).toMatchObject({ status: 'TIMED_OUT' });
    expect(results.results[0]).toMatchObject({ score: 30, systemPassed: true });
    expect(store.outcomeEmails).toHaveLength(1);
    // a re-sweep does nothing more
    await w.sweepOverdue();
    expect(results.results).toHaveLength(1);
  });

  it('a result that could not be recorded at first is recorded by the recovery pass, once', async () => {
    await engine.startCodingAttempt(token, new Date(now));
    // the attempt ended but the process stopped before the next step
    await store.saveCodingState(store.attempts[0]!.id, state([10, 20, 0]));
    await store.finishAttempt(store.attempts[0]!.id, 'SUBMITTED', new Date(now));
    now = new Date(now.getTime() + 2 * MIN);
    const { w } = worker();
    await w.recover();
    expect(results.results).toHaveLength(1);
    expect(store.outcomeEmails).toHaveLength(1);
  });

  it('keeps grading as a coding attempt even if coding rounds are switched off meanwhile', async () => {
    await engine.startCodingAttempt(token, new Date(now));
    const previous = process.env.DSA_ROUNDS;
    process.env.DSA_ROUNDS = 'off';
    try {
      await engine.progress(store.attempts[0]!.id); // still running: nothing to do
      await store.saveCodingState(store.attempts[0]!.id, state([10, 20, 0]));
      await store.finishAttempt(store.attempts[0]!.id, 'SUBMITTED', new Date(now));
      await engine.progress(store.attempts[0]!.id);
      expect(results.results[0]).toMatchObject({ score: 30 });
    } finally {
      if (previous === undefined) delete process.env.DSA_ROUNDS;
      else process.env.DSA_ROUNDS = previous;
    }
  });

  it('shows HR the coding attempt: kind, how many problems were submitted, time taken', async () => {
    await engine.startCodingAttempt(token, new Date(now));
    now = new Date(now.getTime() + 12 * MIN);
    await engine.finishCodingAttempt(token, 'submitted', state([10, 0, 0]));
    const view = await engine.forApplication(TENANT, APP);
    const round = view.rounds.find((r) => r.roundId === saved[1]!.id)!;
    expect(round).toMatchObject({ online: true, kind: 'CODING' });
    expect(round.attempt).toMatchObject({ status: 'SUBMITTED', answered: 1, questionCount: 3, timeTakenSeconds: 720 });
    expect(view.rounds.find((r) => r.roundId === saved[0]!.id)!.kind).toBe('TEST');
    expect(view.rounds.find((r) => r.roundId === saved[2]!.id)!.kind).toBeNull();
  });
});

describe('coding state is read defensively', () => {
  it('drops anything unexpected and caps marks at the question', () => {
    expect(parseCodingState(null)).toEqual({ progress: {}, finishReason: null });
    expect(parseCodingState('x')).toEqual({ progress: {}, finishReason: null });
    const s = parseCodingState({ finishReason: 'hacked', progress: { a: { bestScore: -5, attempts: 'many', passed: 2.7, total: 3, language: 'python', bestCode: 'x' }, b: 5 } });
    expect(s.finishReason).toBeNull();
    expect(Object.keys(s.progress)).toEqual(['a']);
    expect(s.progress.a).toMatchObject({ bestScore: 0, attempts: 0, passed: 2, total: 3 });
  });

  it('marks never exceed what a question is worth, whatever the stored state says', async () => {
    await setup([dsa]);
    const huge = state([999, 999, 999]);
    expect(codingMarks(saved[0]!, huge)).toBe(60);
    expect(toCodingAnswers(saved[0]!, huge).map((a) => a.marksAwarded)).toEqual([10, 20, 30]);
  });
});
