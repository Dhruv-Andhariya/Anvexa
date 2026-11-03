import 'reflect-metadata';
import type { RoundInput, SavedRound } from '@hireflow/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import { AssessmentsService } from '../../src/modules/assessments';
import { BankQuestionRepository } from '../../src/modules/dsa/questions/bank-question.repository';
import { STDIO_STARTER_CODE } from '../../src/modules/dsa/questions/hr-problem';
import { toPublicQuestion, type DsaQuestion } from '../../src/modules/dsa/questions/question.types';
import { toInvitation } from '../../src/modules/dsa/session/round-invitation.resolver';
import { Evaluator, outputsMatch } from '../../src/modules/dsa/evaluation/evaluator';
import type { CodeRunner, RunnerJob, RunnerResult } from '../../src/modules/dsa/execution/code-runner';
import { RoundsConfigService } from '../../src/modules/rounds-config';
import { newAssessmentToken } from '../../src/modules/round-engine/link';
import { nextStep, roundKind } from '../../src/modules/round-engine/online-test';
import { RoundEngineService } from '../../src/modules/round-engine/round-engine.service';
import { HR_PROBLEM } from '../dsa-fixtures';
import { MemoryAudit } from '../in-memory';
import { ACTOR, APP, FakeGenerator, JOB, MemoryAssessmentsStore, MemoryRoundsConfigStore, TENANT, student } from '../rounds/fakes';
import { MemoryRoundEngineStore } from './fakes';

/**
 * HR's own DSA problem (typed in the rounds editor at publish time) from saving to the DSA page. Running it through real
 * compilers (Piston and local toolchains, Python / Java / C++) is in tests/support/execution-suite.ts.
 */
const sumProblem = HR_PROBLEM;

const dsa: RoundInput = { type: 'CODING', name: 'DSA Coding Round', timeLimitMinutes: 45, passRule: { mode: 'MARKS', value: 5 }, questions: [sumProblem] };
const aptitude: RoundInput = { type: 'APTITUDE', name: 'Aptitude', timeLimitMinutes: 20, passRule: { mode: 'MARKS', value: 1 }, questions: [{ kind: 'MCQ', text: 'Q1', options: ['a', 'b'], correct: [1] }] };

let store: MemoryRoundEngineStore;
let rounds: RoundsConfigService;
let engine: RoundEngineService;
let saved: SavedRound[];

beforeEach(async () => {
  const roundsStore = new MemoryRoundsConfigStore();
  roundsStore.addJob(TENANT, JOB);
  const results = new MemoryAssessmentsStore();
  results.jobs.push({ id: JOB, tenantId: TENANT, title: 'AI Engineer' });
  results.students.push({ ...student(), tenantId: TENANT });
  store = new MemoryRoundEngineStore();
  store.contexts.set(APP, { tenantId: TENANT, applicationId: APP, jobId: JOB, candidateName: 'Asha Patel', email: 'asha@example.com', jobTitle: 'AI Engineer', companyName: 'Pattern Labs', companyWebsite: null });
  const audit = new MemoryAudit();
  rounds = new RoundsConfigService(roundsStore, audit, new FakeGenerator().asClient());
  engine = new RoundEngineService(store, rounds, new AssessmentsService(results, rounds, audit), audit, { cameraRequired: true }, () => new Date('2026-11-03T09:00:00Z'));
  saved = (await rounds.save(TENANT, JOB, { rounds: [aptitude, dsa], complete: true }, ACTOR)).rounds;
});

function invite(roundId: string) {
  const t = newAssessmentToken();
  store.invites.push({
    id: `0192f3a1-eeee-7000-8000-${String(store.invites.length + 1).padStart(12, '0')}`,
    tenantId: TENANT,
    applicationId: APP,
    jobId: JOB,
    roundId,
    tokenHash: t.tokenHash,
    expiresAt: new Date('2026-11-10T08:00:00Z'),
    revokedAt: null,
    emailStatus: 'SENT',
    attempts: 1,
    sentAt: new Date('2026-11-03T08:00:00Z'),
    lastError: null,
  });
  return t.token;
}

async function hrQuestions(): Promise<DsaQuestion[]> {
  const token = invite(saved[1]!.id);
  const ctx = await engine.openCodingRound(token);
  return new BankQuestionRepository().findForAssessment('a', toInvitation(token, ctx, false));
}

describe('HR writes the DSA problem in the rounds editor (publish time)', () => {
  it('is saved with the round and read back exactly as HR wrote it', async () => {
    const q = (await rounds.get(TENANT, JOB)).rounds[1]!.questions[0]!;
    expect(q.coding).toEqual({ ...sumProblem.coding });
    expect(q.text).toBe(sumProblem.text);
  });

  it('makes the round a DSA round that follows the aptitude round like a bank-problem round does', () => {
    expect(roundKind(saved[0]!)).toBe('TEST');
    expect(roundKind(saved[1]!)).toBe('CODING');
    expect(nextStep(saved, saved[0]!, true)).toMatchObject({ kind: 'INVITE', roundKind: 'CODING', round: { id: saved[1]!.id } });
    expect(nextStep(saved, saved[1]!, true)).toEqual({ kind: 'EMAIL', email: 'CLEARED_ALL', nextRoundName: null });
    expect(nextStep(saved, saved[1]!, false)).toEqual({ kind: 'EMAIL', email: 'REJECTED', nextRoundName: null });
  });

  it('cannot be saved without a sample test, or together with a bank problem', async () => {
    const noSample = { ...sumProblem, coding: { ...sumProblem.coding, tests: sumProblem.coding.tests.filter((t) => t.hidden) } };
    await expect(rounds.save(TENANT, JOB, { rounds: [{ ...dsa, questions: [noSample] }], complete: false }, ACTOR)).rejects.toThrow();
    const both = { ...sumProblem, topics: ['dsa:dsa-001'] };
    await expect(rounds.save(TENANT, JOB, { rounds: [{ ...dsa, questions: [both] }], complete: false }, ACTOR)).rejects.toThrow();
  });

  it('is what the candidate gets on the DSA page: HR statement and samples, never the hidden tests', async () => {
    const [q] = await hrQuestions();
    expect(q).toMatchObject({ id: saved[1]!.questions[0]!.id, title: 'Sum of numbers', marks: 10, difficulty: 'Easy', harness: 'stdio', comparator: 'lines' });
    expect(q!.constraints).toEqual(['1 <= n <= 1000', '-10^6 <= a[i] <= 10^6']);
    const pub = toPublicQuestion(q!);
    expect(pub.description).toBe(sumProblem.text);
    expect(pub.samples).toEqual([{ input: '3\n1 2 3', output: '6', explanation: '' }]);
    expect(pub.sampleTests).toEqual([{ id: 's1', input: '3\n1 2 3', expectedOutput: '6' }]);
    expect(pub.hiddenTestCount).toBe(2);
    expect(JSON.stringify(pub)).not.toContain('4000000');
    expect(pub.starterCode).toEqual(STDIO_STARTER_CODE);
  });
});

describe('judging a program for HR’s problem', () => {
  it('compares the whole output line by line, ignoring trailing spaces and blank lines', () => {
    expect(outputsMatch('lines', '1 2\r\n3  \n\n', '1 2\n3')).toBe(true);
    expect(outputsMatch('lines', '1 2\n3', '1 2 3')).toBe(false);
    expect(outputsMatch('lines', '', '0')).toBe(false);
  });

  it('runs the candidate program unchanged with each test input on stdin', async () => {
    const jobs: RunnerJob[] = [];
    const runner = {
      runBatch: async (batch: RunnerJob[]) => {
        jobs.push(...batch);
        return batch.map((j): RunnerResult => ({ verdict: 'ok', statusText: 'Accepted', stdout: j.stdin.startsWith('3') ? '6\n' : '0\n', stderr: '', compileOutput: '', timeMs: 1, memoryKb: 1 }));
      },
    } as unknown as CodeRunner;
    const [q] = await hrQuestions();
    const e = await new Evaluator(runner).evaluate(q!, 'python', 'print(6)', q!.testCases);
    expect(jobs.map((j) => j.source)).toEqual(['print(6)\n', 'print(6)\n', 'print(6)\n']);
    expect(jobs.map((j) => j.stdin)).toEqual(['3\n1 2 3\n', '1\n-5\n', '4\n1000000 1000000 1000000 1000000\n']);
    expect(e).toMatchObject({ verdict: 'failed', passed: 1, total: 3 });
    expect(e.cases[0]).toMatchObject({ status: 'passed', input: '3\n1 2 3', expected: '6', actual: '6\n', stdout: '' });
    expect(e.cases[1]).toEqual({ id: 'h1', label: 'Hidden test 1', hidden: true, status: 'wrong_answer', timeMs: 1, memoryKb: 1 });
  });
});
