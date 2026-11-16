import 'reflect-metadata';
import { HttpException } from '@nestjs/common';
import type { RoundInput, SavedRound } from '@hireflow/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import { AssessmentsService } from '../../src/modules/assessments';
import { MemoryPipelineStore, PipelineService } from '../../src/modules/pipeline';
import { RoundModules, RoundsConfigService } from '../../src/modules/rounds-config';
import { newAssessmentToken } from '../../src/modules/round-engine/link';
import { RoundEngineService } from '../../src/modules/round-engine/round-engine.service';
import { MemoryAudit } from '../in-memory';
import { ACTOR, FakeGenerator, JOB, MemoryAssessmentsStore, MemoryRoundsConfigStore, TENANT, student } from '../rounds/fakes';
import { MemoryRoundEngineStore } from '../round-engine/fakes';

/**
 * The whole pipeline with the real round engine, assessments and pipeline services (in-memory stores):
 * aptitude test -> Stage 2 in HR's order GD -> SQL -> SQL #2 -> technical (AI) interview -> personal interview.
 * Candidates A-D of the orchestrator acceptance checks.
 */

const APP = { A: 'a0000000-0000-7000-8000-00000000000a', B: 'a0000000-0000-7000-8000-00000000000b', C: 'a0000000-0000-7000-8000-00000000000c', D: 'a0000000-0000-7000-8000-00000000000d' };
type Who = keyof typeof APP;
const T0 = new Date('2026-11-04T09:00:00Z');

/** 4 MCQs of 1 mark (option 1 right) + 1 of 2 marks; 4 of 6 marks to pass. */
const aptitude: RoundInput = {
  type: 'APTITUDE',
  name: 'Aptitude & English',
  timeLimitMinutes: 30,
  passRule: { mode: 'MARKS', value: 4 },
  questions: [
    ...Array.from({ length: 4 }, (_, i) => ({ kind: 'MCQ' as const, text: `Q${i + 1}`, options: ['a', 'b', 'c'], correct: [1] })),
    { kind: 'MCQ' as const, text: 'Pick two', options: ['x', 'y', 'z'], correct: [0, 2], marks: 2 },
  ],
};
const gd: RoundInput = { type: 'GROUP_DISCUSSION', name: 'Group Discussion', passRule: { mode: 'INTERVIEWER_SCORE', value: 15, maxScore: 30 } };
// two SQL questions with different marks, and a second SQL round (stands in for DSA, which the engine runs itself)
const sql: RoundInput = {
  type: 'SQL',
  name: 'SQL Round',
  passRule: { mode: 'MARKS', value: 10 },
  questions: [
    { kind: 'CODING', text: 'Top salaries', marks: 10, language: 'SQL' },
    { kind: 'CODING', text: 'Running totals', marks: 15, language: 'SQL' },
  ],
};
const sql2: RoundInput = { ...sql, name: 'SQL Round 2', questions: [{ kind: 'CODING', text: 'Gaps and islands', marks: 20, language: 'SQL' }] };
const tech: RoundInput = { type: 'AI_INTERVIEW', name: 'Technical Interview', passRule: { mode: 'INTERVIEWER_SCORE', value: 6, maxScore: 10 } };
const pi: RoundInput = { type: 'HR_INTERVIEW', name: 'Personal Interview', passRule: { mode: 'INTERVIEWER_SCORE', value: 6, maxScore: 10 } };

let now: Date;
let saved: SavedRound[];
let results: MemoryAssessmentsStore;
let store: MemoryRoundEngineStore;
let pipelineStore: MemoryPipelineStore;
let pipeline: PipelineService;
let assessments: AssessmentsService;
let engine: RoundEngineService;
let modules: RoundModules;
let rounds: RoundsConfigService;

const code = (err: unknown) => ((err as HttpException).getResponse() as { code: string }).code;
const caught = async (p: Promise<unknown>) => p.then(() => { throw new Error('expected an error'); }, (e: unknown) => e);
const round = (name: string) => saved.find((r) => r.name === name)!;
const emailsOf = (who: Who) => store.outcomeEmails.filter((e) => e.applicationId === APP[who]).map((e) => `${e.kind}@${saved.find((r) => r.id === e.roundId)!.name}`);
const invitesOf = (who: Who) => store.invites.filter((i) => i.applicationId === APP[who]).map((i) => saved.find((r) => r.id === i.roundId)!.name);

/** The aptitude test taken on the careers site (invite -> start -> submit), through the engine. */
async function takeAptitude(who: Who, passIt: boolean) {
  const t = newAssessmentToken();
  store.invites.push({
    id: `b0000000-0000-7000-8000-00000000000${who.toLowerCase()}`.slice(0, 36),
    tenantId: TENANT,
    applicationId: APP[who],
    jobId: JOB,
    roundId: saved[0]!.id,
    tokenHash: t.tokenHash,
    expiresAt: new Date(now.getTime() + 7 * 86_400_000),
    revokedAt: null,
    emailStatus: 'SENT',
    attempts: 1,
    sentAt: now,
    lastError: null,
  });
  await engine.start(t.token, { consent: true });
  const qs = saved[0]!.questions;
  const answers = [...qs.slice(0, 4).map((q) => ({ questionId: q.id, selected: [passIt ? 1 : 0], marked: false })), { questionId: qs[4]!.id, selected: passIt ? [0, 2] : [1], marked: false }];
  await engine.submit(t.token, { revision: 1, answers });
}

/** GD: HR's rubric marks recorded as the GD result (what GdResultsService.confirm() does), then the student moves on. */
async function takeGd(who: Who, score: number) {
  const r = await assessments.record(TENANT, { applicationId: APP[who], roundId: round('Group Discussion').id, interviewerScore: score });
  await engine.continueAfterExternalRound(TENANT, APP[who], round('Group Discussion').id, r.outcome === 'PASSED');
}

/** A SQL round: the module reports marks per question. */
const takeSql = (who: Who, name: string, marks: number[]) =>
  engine.recordModuleResult(TENANT, 'SQL', {
    applicationId: APP[who],
    roundId: round(name).id,
    answers: round(name).questions.map((q, i) => ({ questionId: q.id, answer: 'SELECT ...', marksAwarded: marks[i]! })),
  });

const takeTech = (who: Who, score: number) =>
  engine.recordModuleResult(TENANT, 'AI_INTERVIEW', { applicationId: APP[who], roundId: round('Technical Interview').id, interviewerScore: score });

/** Stage 2 = GD 30 + SQL 25 + SQL2 20 = 75 marks; HR wants all rounds passed AND >= 70 %. */
beforeEach(async () => {
  now = new Date(T0);
  const roundsStore = new MemoryRoundsConfigStore();
  roundsStore.addJob(TENANT, JOB);
  results = new MemoryAssessmentsStore();
  results.jobs.push({ id: JOB, tenantId: TENANT, title: 'Graduate Engineer' });
  store = new MemoryRoundEngineStore();
  for (const [who, id] of Object.entries(APP)) {
    results.students.push({ ...student({ applicationId: id, name: `Candidate ${who}`, email: `${who.toLowerCase()}@example.com`, phone: `+91 90000 0000${who.charCodeAt(0) - 64}` }), tenantId: TENANT });
    store.contexts.set(id, { tenantId: TENANT, applicationId: id, jobId: JOB, candidateName: `Candidate ${who}`, email: `${who.toLowerCase()}@example.com`, jobTitle: 'Graduate Engineer', companyName: 'Pattern Labs', companyWebsite: null });
  }
  const audit = new MemoryAudit();
  rounds = new RoundsConfigService(roundsStore, audit, new FakeGenerator().asClient());
  modules = new RoundModules();
  modules.connect('SQL');
  modules.connect('AI_INTERVIEW');
  assessments = new AssessmentsService(results, rounds, audit, modules);
  pipelineStore = new MemoryPipelineStore();
  pipeline = new PipelineService(pipelineStore, rounds, assessments, audit);
  engine = new RoundEngineService(store, rounds, assessments, audit, { cameraRequired: false }, () => new Date(now), modules, pipeline);
  saved = (await rounds.save(TENANT, JOB, { rounds: [aptitude, gd, sql, sql2, tech, pi], complete: true }, ACTOR)).rounds;
  await pipeline.saveSettings(TENANT, JOB, { stage2Rule: 'BOTH', stage2MinPercent: 70 }, ACTOR);
});

describe('candidates A-D through the whole pipeline', () => {
  it('A passes everything and lands in the personal interview section; B, C and D stop with their own reason', async () => {
    // Stage 1
    await takeAptitude('A', true);
    await takeAptitude('B', false);
    await takeAptitude('C', true);
    await takeAptitude('D', true);
    // Stage 2 in HR's order: GD -> SQL -> SQL 2
    await takeGd('A', 27); // 27/30
    await takeSql('A', 'SQL Round', [9, 14]); // 23/25
    await takeSql('A', 'SQL Round 2', [18]); // 18/20 -> 68/75 = 90.66 %
    await takeGd('C', 16); // passes GD (15)
    await takeSql('C', 'SQL Round', [5, 6]); // 11/25 passes (10)
    await takeSql('C', 'SQL Round 2', [10]); // 10/20 passes (10) -> 37/75 = 49.33 % < 70
    await takeGd('D', 25);
    await takeSql('D', 'SQL Round', [10, 13]);
    await takeSql('D', 'SQL Round 2', [17]); // 55/75 = 73.33 %
    // the technical interview module only gets students who passed Stage 2 overall
    store.waitingByType.set('AI_INTERVIEW', (['A', 'C', 'D'] as Who[]).map((w) => ({ tenantId: TENANT, applicationId: APP[w], jobId: JOB, roundId: round('Technical Interview').id })));
    expect((await engine.waitingForModule('AI_INTERVIEW')).map((r) => r.applicationId)).toEqual([APP.A, APP.D]);
    await takeTech('A', 8);
    await takeTech('D', 3);

    const statuses = await pipeline.statuses(TENANT, JOB);
    const statusOf = (w: Who) => statuses.students.find((s) => s.applicationId === APP[w])!.status;
    expect(statusOf('A')).toBe('IN_PERSONAL_INTERVIEW');
    expect(statusOf('B')).toBe('REJECTED_APTITUDE');
    expect(statusOf('C')).toBe('REJECTED_MODULE2_OVERALL');
    expect(statusOf('D')).toBe('REJECTED_TECH_INTERVIEW');
    expect(statuses.students.find((s) => s.applicationId === APP.C)!.stage2).toMatchObject({ decided: true, passed: false, allRoundsPassed: true, scored: 37, total: 75, percent: 49.33 });

    // emails, only from pipeline transitions: A "HR will call you" for the personal interview, the others one rejection each
    expect(emailsOf('A')).toEqual(['CLEARED_NEXT_BY_HR@Technical Interview']);
    expect(emailsOf('B')).toEqual(['REJECTED@Aptitude & English']);
    expect(emailsOf('C')).toEqual(['REJECTED@SQL Round 2']);
    expect(emailsOf('D')).toEqual(['REJECTED@Technical Interview']);
    // a rejected student is never invited further
    expect(invitesOf('B')).toEqual(['Aptitude & English']);

    // the personal interview section: only A, with every score, and HR's call status
    const board = await pipeline.piBoard(TENANT, JOB);
    expect(board.hasPersonalInterviewRound).toBe(true);
    expect(board.candidates).toHaveLength(1);
    expect(board.candidates[0]).toMatchObject({
      name: 'Candidate A',
      phone: '+91 90000 00001',
      status: 'IN_PERSONAL_INTERVIEW',
      aptitudePercent: 100,
      stage2Percent: 90.66,
      techInterview: { score: 8, maxScore: 10 },
      call: { status: 'NOT_CALLED' },
    });
    await pipeline.updatePiCall(TENANT, JOB, APP.A, { status: 'SELECTED', notes: 'Offer to follow' }, ACTOR);
    expect((await pipeline.statuses(TENANT, JOB)).students.find((s) => s.applicationId === APP.A)!.status).toBe('SELECTED');
    // only students at the personal interview can be called
    expect(code(await caught(pipeline.updatePiCall(TENANT, JOB, APP.D, { status: 'CALLED' }, ACTOR)))).toBe('NOT_AT_PERSONAL_INTERVIEW');
  });

  it('a result sent twice changes nothing: one result, one email, one invitation', async () => {
    await takeAptitude('A', true);
    await takeGd('A', 27);
    await takeGd('A', 27);
    await takeSql('A', 'SQL Round', [9, 14]);
    await takeSql('A', 'SQL Round', [9, 14]);
    await takeSql('A', 'SQL Round 2', [3]); // fails its own rule
    await takeSql('A', 'SQL Round 2', [3]);
    expect(results.results.filter((r) => r.applicationId === APP.A)).toHaveLength(4);
    expect(emailsOf('A')).toEqual(['REJECTED@SQL Round 2']);
    expect((await pipeline.statuses(TENANT, JOB)).students.find((s) => s.applicationId === APP.A)!.status).toBe('REJECTED_MODULE2_ROUND');
  });

  it('marks above a question’s marks are refused, never clamped', async () => {
    await takeAptitude('A', true);
    const err = await caught(takeSql('A', 'SQL Round', [11, 14])); // question 1 is worth 10
    // the assessments module's existing answer for an impossible result (422, the request itself was well-formed)
    expect((err as HttpException).getStatus()).toBe(422);
    expect(results.results.some((r) => r.roundId === round('SQL Round').id)).toBe(false);
  });

  it('with rejection emails switched off a rejected student gets no email, and HR still sees the reason', async () => {
    await pipeline.saveSettings(TENANT, JOB, { stage2Rule: 'BOTH', stage2MinPercent: 70, rejectionEmails: false }, ACTOR);
    await takeAptitude('B', false);
    expect(emailsOf('B')).toEqual([]);
    expect((await pipeline.statuses(TENANT, JOB)).students.find((s) => s.applicationId === APP.B)!.status).toBe('REJECTED_APTITUDE');
  });

  it('pipeline rules and the rubric are frozen once the first student started', async () => {
    await pipeline.saveRubric(TENANT, JOB, round('Group Discussion').id, { parameters: [{ name: 'Communication', maxMarks: 10 }, { name: 'Content', maxMarks: 20 }] }, ACTOR);
    expect(code(await caught(pipeline.saveRubric(TENANT, JOB, round('SQL Round').id, { parameters: [{ name: 'X', maxMarks: 5 }] }, ACTOR)))).toBe('RUBRIC_NOT_FOR_ROUND');
    await takeAptitude('A', true);
    expect(code(await caught(pipeline.saveSettings(TENANT, JOB, { stage2Rule: 'ALL_ROUNDS_PASSED' }, ACTOR)))).toBe('PIPELINE_LOCKED');
    expect(code(await caught(pipeline.saveRubric(TENANT, JOB, round('Group Discussion').id, { parameters: [] }, ACTOR)))).toBe('PIPELINE_LOCKED');
    expect((await pipeline.rubricView(TENANT, JOB, round('Group Discussion').id)).totalMarks).toBe(30);
    expect(() => pipeline.checkRubricScores([{ name: 'Communication', maxMarks: 10 }], [{ parameter: 'Communication', marks: 11 }])).toThrow();
  });

  it('without any pipeline settings the old behaviour holds: every round passed is enough', async () => {
    pipelineStore.settings.clear();
    await takeAptitude('C', true);
    await takeGd('C', 16);
    await takeSql('C', 'SQL Round', [5, 6]);
    await takeSql('C', 'SQL Round 2', [10]);
    expect(emailsOf('C')).toEqual([]); // handed to the technical interview module, no rejection
    expect((await pipeline.statuses(TENANT, JOB)).students.find((s) => s.applicationId === APP.C)!.status).toBe('IN_TECH_INTERVIEW');
  });
});

describe('AVERAGE_OF_ROUNDS: the technical rounds (GD, SQL, SQL 2) are judged together at the end', () => {
  // pass marks: GD 15/30 = 50 %, SQL 10/25 = 40 %, SQL 2 10/20 = 50 % -> the average must reach 46.67 %
  beforeEach(async () => {
    await pipeline.saveSettings(TENANT, JOB, { stage2Rule: 'AVERAGE_OF_ROUNDS' }, ACTOR);
  });

  it('a failed round does not stop the student; the average after the last one decides', async () => {
    await takeAptitude('A', true);
    await takeAptitude('C', true);
    await takeGd('A', 9); // 30 %: fails the GD on its own
    await takeSql('A', 'SQL Round', [3, 4]); // 28 %: fails SQL on its own
    await takeSql('A', 'SQL Round 2', [19]); // 95 % -> average 51 % >= 46.67 %
    await takeGd('C', 6); // 20 %
    await takeSql('C', 'SQL Round', [2, 3]); // 20 %
    await takeSql('C', 'SQL Round 2', [8]); // 40 % -> average 26.67 % < 46.67 %

    // nobody was rejected after the GD or the first SQL round: no email until the end
    expect(emailsOf('A')).toEqual([]);
    expect(emailsOf('C')).toEqual(['REJECTED@SQL Round 2']);
    const statuses = await pipeline.statuses(TENANT, JOB);
    const s = (w: Who) => statuses.students.find((x) => x.applicationId === APP[w])!;
    expect(s('A').status).toBe('IN_TECH_INTERVIEW');
    expect(s('A').stage2).toMatchObject({ decided: true, passed: true, allRoundsPassed: false, averagePercent: 51, requiredPercent: 46.66 });
    expect(s('C').status).toBe('REJECTED_MODULE2_OVERALL');
    // only A gets the technical interview link
    store.waitingByType.set('AI_INTERVIEW', (['A', 'C'] as Who[]).map((w) => ({ tenantId: TENANT, applicationId: APP[w], jobId: JOB, roundId: round('Technical Interview').id })));
    expect((await engine.waitingForModule('AI_INTERVIEW')).map((r) => r.applicationId)).toEqual([APP.A]);
  });

  it('the aptitude test still rejects on its own', async () => {
    await takeAptitude('B', false);
    expect(emailsOf('B')).toEqual(['REJECTED@Aptitude & English']);
  });
});

describe('completing the rounds: SQL / Coding rounds must run online (their link emailed, graded by the system)', () => {
  const plainSql: RoundInput = { type: 'SQL', name: 'SQL', passRule: { mode: 'MARKS', value: 5 }, questions: [{ kind: 'CODING', text: 'Write an SQL query to list the documents', marks: 10, language: 'SQL' }] };
  const mcqSql: RoundInput = { type: 'SQL', name: 'SQL MCQ', passRule: { mode: 'MARKS', value: 1 }, questions: [{ kind: 'MCQ', text: 'Which clause filters groups?', options: ['WHERE', 'HAVING'], correct: [1] }] };
  const plainCoding: RoundInput = { type: 'CODING', name: 'Coding', passRule: { mode: 'MARKS', value: 5 }, questions: [{ kind: 'CODING', text: 'Reverse a list', marks: 10, language: 'Python' }] };

  const service = (connected: ('SQL' | 'DSA')[]) => {
    const roundsStore = new MemoryRoundsConfigStore();
    roundsStore.addJob(TENANT, JOB);
    const m = new RoundModules();
    connected.forEach((x) => m.connect(x));
    return new RoundsConfigService(roundsStore, new MemoryAudit(), new FakeGenerator().asClient(), m);
  };

  it('refuses a SQL round with a question the system cannot run (no SQL bank question), and a plain-text coding round', async () => {
    const err = await caught(service(['DSA']).save(TENANT, JOB, { rounds: [aptitude, plainSql], complete: true }, ACTOR));
    expect(code(err)).toBe('ROUND_NOT_ONLINE');
    expect(((err as HttpException).getResponse() as { message: string }).message).toMatch(/^Round 2 \(SQL\): every question must be a SQL question from your SQL question bank/);
    expect(code(await caught(service(['DSA']).save(TENANT, JOB, { rounds: [plainCoding], complete: true }, ACTOR)))).toBe('ROUND_NOT_ONLINE');
  });

  it('a draft may hold them; a multiple-choice SQL round runs online; a connected SQL module runs its own questions', async () => {
    expect((await service(['DSA']).save(TENANT, JOB, { rounds: [plainSql], complete: false }, ACTOR)).status).toBe('DRAFT');
    expect((await service(['DSA']).save(TENANT, JOB, { rounds: [mcqSql], complete: true }, ACTOR)).status).toBe('COMPLETE');
    expect((await service(['DSA', 'SQL']).save(TENANT, JOB, { rounds: [plainSql], complete: true }, ACTOR)).status).toBe('COMPLETE');
  });
});
