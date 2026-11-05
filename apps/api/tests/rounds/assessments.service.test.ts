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

  it('shows the AI screening, and where a student is in a round that has no result yet', async () => {
    store.students[1]!.aiScreening = { status: 'INVITED', review: null };
    store.students[1]!.roundProgress = { [saved[0]!.id]: 'Invited', [saved[1]!.id]: 'Test in progress' };
    const view = await service.job(TENANT, JOB);
    expect(view.students.find((s) => s.applicationId === APP)!.aiScreening).toEqual({ status: 'COMPLETED', review: 'PENDING' });
    const ravi = view.students.find((s) => s.applicationId === SECOND_APP)!;
    expect(ravi.aiScreening).toEqual({ status: 'INVITED', review: null });
    // a recorded result wins over the progress text
    expect(ravi.rounds.map((c) => [c.outcome, c.progress])).toEqual([
      ['FAILED', null],
      ['NOT_ATTEMPTED', 'Test in progress'],
      ['NOT_ATTEMPTED', null],
    ]);
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

  it('the job list has only the jobs HR created assessment rounds for', async () => {
    const NO_ROUNDS = '0192f3a1-bbbb-7000-8000-000000000009';
    roundsStore.addJob(TENANT, NO_ROUNDS);
    store.jobs.push({ id: NO_ROUNDS, tenantId: TENANT, title: 'No rounds yet' });
    expect((await service.jobs(TENANT)).map((j) => j.jobId)).toEqual([JOB]);
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

describe('HR changes the passing criterion, also after students started', () => {
  const record = (applicationId: string, n: number) => service.record(TENANT, { applicationId, roundId: saved[0]!.id, answers: aptitudeAnswers(n) });

  it('works on locked rounds, re-grades every result of that round and lists who changed', async () => {
    await record(APP, 7); // 7 of 10: fails "8 correct"
    await record(SECOND_APP, 9); // passes
    expect((await rounds.forRoundEngine(TENANT, JOB))!.locked).toBe(true);
    const res = await service.changePassRule(TENANT, JOB, saved[0]!.id, { passRule: { mode: 'CORRECT_COUNT', value: 6 } }, ACTOR);
    expect(res).toMatchObject({ roundId: saved[0]!.id, passRule: { mode: 'CORRECT_COUNT', value: 6, maxScore: null }, regraded: 2 });
    expect(res.changed).toEqual([{ applicationId: APP, name: 'Asha Patel', before: 'FAILED', after: 'PASSED', overridden: false }]);
    expect((await rounds.forRoundEngine(TENANT, JOB))!.rounds[0]!.passRule).toEqual({ mode: 'CORRECT_COUNT', value: 6, maxScore: null });
    expect((await service.student(TENANT, APP)).rounds[0]).toMatchObject({ outcome: 'PASSED' });
    // the questions stay frozen
    expect(code(await rounds.save(TENANT, JOB, { rounds: [aptitude], complete: true }, ACTOR).catch((e: unknown) => e))).toBe('ROUNDS_LOCKED');
  });

  it('can switch the criterion (marks / percentage) for the same answers; HR overrides are kept', async () => {
    await record(APP, 5);
    await service.override(TENANT, APP, saved[0]!.id, { passed: true, reason: 'Interview went very well' }, ACTOR);
    const res = await service.changePassRule(TENANT, JOB, saved[0]!.id, { passRule: { mode: 'PERCENTAGE', value: 40 } }, ACTOR);
    expect(res.changed).toEqual([{ applicationId: APP, name: 'Asha Patel', before: 'FAILED', after: 'PASSED', overridden: true }]);
    expect((await service.student(TENANT, APP)).rounds[0]).toMatchObject({ outcome: 'PASSED', override: { passed: true } });
  });

  it('refuses a pass mark above the total, and changes nothing', async () => {
    await record(APP, 7);
    const err = await service.changePassRule(TENANT, JOB, saved[0]!.id, { passRule: { mode: 'CORRECT_COUNT', value: 11 } }, ACTOR).catch((e: unknown) => e);
    expect([status(err), code(err)]).toEqual([400, 'INVALID_PASS_RULE']);
    expect((await rounds.forRoundEngine(TENANT, JOB))!.rounds[0]!.passRule).toEqual({ mode: 'CORRECT_COUNT', value: 8, maxScore: null });
  });

  it('refuses a criterion the recorded results cannot be graded with, and changes nothing', async () => {
    await record(APP, 7);
    const err = await service.changePassRule(TENANT, JOB, saved[0]!.id, { passRule: { mode: 'INTERVIEWER_SCORE', value: 5, maxScore: 10 } }, ACTOR).catch((e: unknown) => e);
    expect(code(err)).toBe('PASS_RULE_INCOMPATIBLE');
    expect((await rounds.forRoundEngine(TENANT, JOB))!.rounds[0]!.passRule!.mode).toBe('CORRECT_COUNT');
  });

  it("another company's round is not found", async () => {
    const err = await service.changePassRule(OTHER_TENANT, JOB, saved[0]!.id, { passRule: { mode: 'CORRECT_COUNT', value: 6 } }, ACTOR).catch((e: unknown) => e);
    expect(status(err)).toBe(404);
  });
});

describe('HR sets the total marks of a round (e.g. out of 50, 60 or 1000)', () => {
  // aptitude: 10 questions of 1 mark
  const record = (applicationId: string, n: number) => service.record(TENANT, { applicationId, roundId: saved[0]!.id, answers: aptitudeAnswers(n) });

  it('scales the marks to HR\'s total, so the pass mark can be any number up to that total', async () => {
    await rounds.save(TENANT, JOB, { rounds: [{ ...aptitude, passRule: { mode: 'MARKS', value: 30, maxScore: 50 } }, sql, interview], complete: true }, ACTOR);
    saved = (await rounds.forRoundEngine(TENANT, JOB))!.rounds;
    expect(saved[0]!.passRule).toEqual({ mode: 'MARKS', value: 30, maxScore: 50 });
    expect(await record(APP, 7)).toMatchObject({ outcome: 'PASSED', score: 35, maxScore: 50, passMark: 30 }); // 7 of 10 = 35 of 50
    expect(await record(SECOND_APP, 5)).toMatchObject({ outcome: 'FAILED', score: 25, maxScore: 50 });
  });

  it('a pass mark above the questions\' own total is fine once HR sets a bigger total; above HR\'s total it is refused', async () => {
    const save = (passRule: unknown) => rounds.save(TENANT, JOB, { rounds: [{ ...aptitude, passRule } as RoundInput], complete: true }, ACTOR);
    await expect(save({ mode: 'MARKS', value: 600, maxScore: 1000 })).resolves.toBeTruthy();
    expect(code(await save({ mode: 'MARKS', value: 22 }).catch((e: unknown) => e))).toBe('INVALID_ROUNDS'); // no total: out of the 10 question marks
    expect(code(await save({ mode: 'MARKS', value: 60, maxScore: 50 }).catch((e: unknown) => e))).toBe('INVALID_ROUNDS');
  });

  it('also works when changing the criterion after students started (re-graded with the new total)', async () => {
    await record(APP, 4); // 4 of 10 marks: fails "8 correct"
    const res = await service.changePassRule(TENANT, JOB, saved[0]!.id, { passRule: { mode: 'MARKS', value: 20, maxScore: 50 } }, ACTOR);
    expect(res.passRule).toEqual({ mode: 'MARKS', value: 20, maxScore: 50 });
    expect(res.changed).toEqual([expect.objectContaining({ applicationId: APP, before: 'FAILED', after: 'PASSED' })]); // 20 of 50
    expect((await service.student(TENANT, APP)).rounds[0]).toMatchObject({ outcome: 'PASSED', score: 20, maxScore: 50 });
  });
});
