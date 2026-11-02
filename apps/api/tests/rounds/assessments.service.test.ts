import 'reflect-metadata';
import { HttpException } from '@nestjs/common';
import type { RoundInput, SavedRound } from '@hireflow/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import { AssessmentsService } from '../../src/modules/assessments';
import { gradeResult, stageOf } from '../../src/modules/assessments/grading';
import { RoundsConfigService } from '../../src/modules/rounds-config';
import { MemoryAudit } from '../in-memory';
import { ACTOR, APP, FakeGenerator, JOB, MemoryAssessmentsStore, MemoryRoundsConfigStore, OTHER_JOB, OTHER_TENANT, TENANT, student } from './fakes';

const OTHER_APP = '0192f3a1-aaaa-7000-8000-000000000002';
const SECOND_APP = '0192f3a1-aaaa-7000-8000-000000000003';

const aptitude: RoundInput = {
  type: 'APTITUDE',
  name: 'Online Aptitude Exam',
  passRule: { mode: 'CORRECT_COUNT', value: 8 },
  questions: Array.from({ length: 10 }, (_, i) => ({ kind: 'MCQ' as const, text: `Q${i + 1}`, options: ['a', 'b', 'c'], correct: [1] })),
};
const sql: RoundInput = {
  type: 'SQL',
  name: 'SQL Round',
  passRule: { mode: 'PERCENTAGE', value: 60 },
  questions: [
    { kind: 'CODING', text: 'Top 3 salaries', marks: 10, language: 'SQL' },
    { kind: 'SHORT_ANSWER', text: 'What is a JOIN?', marks: 5 },
  ],
};
const interview: RoundInput = { type: 'HR_INTERVIEW', name: 'Personal Interview', passRule: { mode: 'INTERVIEWER_SCORE', value: 6, maxScore: 10 } };

let roundsStore: MemoryRoundsConfigStore;
let store: MemoryAssessmentsStore;
let audit: MemoryAudit;
let rounds: RoundsConfigService;
let service: AssessmentsService;
let saved: SavedRound[];
const status = (err: unknown) => (err as HttpException).getStatus();
const code = (err: unknown) => ((err as HttpException).getResponse() as { code: string }).code;
/** n correct answers out of the 10 aptitude questions (option 1 is right). */
const aptitudeAnswers = (n: number) => saved[0]!.questions.map((q, i) => ({ questionId: q.id, selected: [i < n ? 1 : 0] }));

beforeEach(async () => {
  roundsStore = new MemoryRoundsConfigStore();
  roundsStore.addJob(TENANT, JOB);
  roundsStore.addJob(OTHER_TENANT, OTHER_JOB);
  store = new MemoryAssessmentsStore();
  store.jobs.push({ id: JOB, tenantId: TENANT, title: 'AI Engineer' }, { id: OTHER_JOB, tenantId: OTHER_TENANT, title: 'Other' });
  store.students.push(
    { ...student(), tenantId: TENANT },
    { ...student({ applicationId: SECOND_APP, name: 'Ravi Shah', email: 'ravi@example.com' }), tenantId: TENANT },
    { ...student({ applicationId: OTHER_APP, jobId: OTHER_JOB }), tenantId: OTHER_TENANT },
  );
  audit = new MemoryAudit();
  rounds = new RoundsConfigService(roundsStore, audit, new FakeGenerator().asClient());
  service = new AssessmentsService(store, rounds, audit);
  saved = (await rounds.save(TENANT, JOB, { rounds: [aptitude, sql, interview], complete: true }, ACTOR)).rounds;
  await rounds.save(OTHER_TENANT, OTHER_JOB, { rounds: [aptitude], complete: true }, ACTOR);
});

describe('recording a round result (round engine)', () => {
  it('8 of 10 correct passes the aptitude round; choice answers are graded against the saved options', async () => {
    const res = await service.record(TENANT, { applicationId: APP, roundId: saved[0]!.id, answers: aptitudeAnswers(8) });
    expect(res).toMatchObject({ outcome: 'PASSED', score: 8, maxScore: 10, passMark: 8 });
    expect(store.results[0]!.answers.filter((a) => a.isCorrect)).toHaveLength(8);
  });

  it('7 of 10 correct fails it', async () => {
    const res = await service.record(TENANT, { applicationId: APP, roundId: saved[0]!.id, correctCount: 7 });
    expect(res.outcome).toBe('FAILED');
  });

  it('turns marks into a percentage, and uses the interviewer score for interviews', async () => {
    expect((await service.record(TENANT, { applicationId: APP, roundId: saved[1]!.id, marks: 9 })).score).toBe(60);
    expect((await service.record(TENANT, { applicationId: APP, roundId: saved[2]!.id, interviewerScore: 5 })).outcome).toBe('FAILED');
  });

  it('locks the rounds with the first result', async () => {
    await service.record(TENANT, { applicationId: APP, roundId: saved[0]!.id, correctCount: 9 });
    expect((await rounds.get(TENANT, JOB)).locked).toBe(true);
    expect(code(await rounds.save(TENANT, JOB, { rounds: [aptitude] }, ACTOR).catch((e) => e))).toBe('ROUNDS_LOCKED');
  });

  it('refuses impossible numbers and questions of another round', async () => {
    const tooMany = await service.record(TENANT, { applicationId: APP, roundId: saved[0]!.id, correctCount: 11 }).catch((e) => e);
    expect([status(tooMany), code(tooMany)]).toEqual([422, 'INVALID_ROUND_RESULT']);
    const missing = await service.record(TENANT, { applicationId: APP, roundId: saved[2]!.id }).catch((e) => e);
    expect(status(missing)).toBe(422);
    const wrongQuestion = await service
      .record(TENANT, { applicationId: APP, roundId: saved[0]!.id, answers: [{ questionId: saved[1]!.questions[0]!.id, answer: 'x' }] })
      .catch((e) => e);
    expect(status(wrongQuestion)).toBe(422);
    expect(store.results).toHaveLength(0);
  });

  it('never accepts a round of another job or another company', async () => {
    const otherRound = (await rounds.forRoundEngine(OTHER_TENANT, OTHER_JOB))!.rounds[0]!.id;
    expect(code(await service.record(TENANT, { applicationId: APP, roundId: otherRound, correctCount: 9 }).catch((e) => e))).toBe('ROUND_NOT_FOUND');
    // another company's student does not exist for this tenant
    expect(status(await service.record(TENANT, { applicationId: OTHER_APP, roundId: saved[0]!.id, correctCount: 9 }).catch((e) => e))).toBe(404);
  });

  it('sending the same result again replaces it (one row per student per round)', async () => {
    await service.record(TENANT, { applicationId: APP, roundId: saved[0]!.id, correctCount: 5 });
    await service.record(TENANT, { applicationId: APP, roundId: saved[0]!.id, correctCount: 9 });
    expect(store.results).toHaveLength(1);
    expect(store.results[0]!.score).toBe(9);
  });
});

describe('HR results view', () => {
  beforeEach(async () => {
    await service.record(TENANT, { applicationId: APP, roundId: saved[0]!.id, correctCount: 9 });
    await service.record(TENANT, { applicationId: SECOND_APP, roundId: saved[0]!.id, correctCount: 3 });
  });

  it('shows every student with status and score per round, and pass / fail counts', async () => {
    const view = await service.job(TENANT, JOB);
    expect(view.rounds.map((r) => [r.name, r.passRuleText, r.counts])).toEqual([
      ['Online Aptitude Exam', '8 of 10 correct', { passed: 1, failed: 1, notAttempted: 0 }],
      ['SQL Round', '60% of 15 marks', { passed: 0, failed: 0, notAttempted: 2 }],
      ['Personal Interview', 'Interviewer score 6 of 10', { passed: 0, failed: 0, notAttempted: 2 }],
    ]);
    const asha = view.students.find((s) => s.applicationId === APP)!;
    expect(asha).toMatchObject({ stage: 'IN_PROGRESS', atsScore: 82 });
    expect(asha.rounds[0]).toMatchObject({ outcome: 'PASSED', score: 9, maxScore: 10, passMark: 8 });
    expect(view.students.find((s) => s.applicationId === SECOND_APP)!.stage).toBe('NOT_CLEARED');
  });

  it('the full review has the resume score, the voice screening flag and every question with the answer', async () => {
    const review = await service.student(TENANT, APP);
    expect(review).toMatchObject({ jobTitle: 'AI Engineer', hasVoiceScreening: true, resume: { score: 82, decision: 'SHORTLISTED' } });
    expect(review.rounds).toHaveLength(3);
    expect(review.rounds[0]!.answers).toHaveLength(10);
    expect(review.rounds[1]).toMatchObject({ outcome: 'NOT_ATTEMPTED', passMark: 60, passMode: 'PERCENTAGE' });
  });

  it('HR overrides a fail with a reason; the system result stays and the change is audited', async () => {
    const review = await service.override(TENANT, SECOND_APP, saved[0]!.id, { passed: true, reason: 'Power cut during the test' }, ACTOR);
    expect(review.rounds[0]).toMatchObject({ outcome: 'PASSED', systemPassed: false, override: { passed: true, reason: 'Power cut during the test', by: 'Priya HR' } });
    expect(audit.entries.at(-1)).toMatchObject({ action: 'assessment.result_overridden', subjectId: SECOND_APP });

    const cleared = await service.override(TENANT, SECOND_APP, saved[0]!.id, { passed: null }, ACTOR);
    expect(cleared.rounds[0]).toMatchObject({ outcome: 'FAILED', override: null });
  });

  it('needs a reason, and a result to override', async () => {
    expect(status(await service.override(TENANT, APP, saved[0]!.id, { passed: false, reason: '' }, ACTOR).catch((e) => e))).toBe(400);
    expect(code(await service.override(TENANT, APP, saved[1]!.id, { passed: true, reason: 'Good attempt' }, ACTOR).catch((e) => e))).toBe('RESULT_NOT_FOUND');
  });

  it('another company never sees this job, its students or results', async () => {
    expect(status(await service.job(OTHER_TENANT, JOB).catch((e) => e))).toBe(404);
    expect(status(await service.student(OTHER_TENANT, APP).catch((e) => e))).toBe(404);
    expect(status(await service.override(OTHER_TENANT, APP, saved[0]!.id, { passed: true, reason: 'Trying to change it' }, ACTOR).catch((e) => e))).toBe(404);
    expect((await service.jobs(OTHER_TENANT)).map((j) => j.jobId)).toEqual([OTHER_JOB]);
    expect((await service.jobs(TENANT))[0]).toMatchObject({ jobId: JOB, roundsStatus: 'COMPLETE', roundCount: 3, students: 2, resultsReceived: 2 });
  });
});

describe('grading rules', () => {
  it('a student stops at the first failed round', () => {
    expect(stageOf(['PASSED', 'FAILED', 'NOT_ATTEMPTED'])).toBe('NOT_CLEARED');
    expect(stageOf(['PASSED', 'PASSED'])).toBe('CLEARED');
    expect(stageOf(['PASSED', 'NOT_ATTEMPTED'])).toBe('IN_PROGRESS');
    expect(stageOf(['NOT_ATTEMPTED'])).toBe('NOT_STARTED');
  });

  it('marks per answer can never be more than the question is worth', () => {
    expect(() => gradeResult(saved[1]!, { correctCount: null, marks: null, interviewerScore: null, answers: [
      { questionId: saved[1]!.questions[1]!.id, answer: 'x', selected: [], isCorrect: null, marksAwarded: 6, feedback: null },
    ] })).toThrow('worth at most 5 marks');
  });
});
