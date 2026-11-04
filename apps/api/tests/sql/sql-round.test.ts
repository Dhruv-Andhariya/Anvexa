import 'reflect-metadata';
import { HttpException } from '@nestjs/common';
import { isDsaRound, type RoundInput, type SavedRound, type SqlBankQuestion } from '@hireflow/contracts';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AssessmentsService } from '../../src/modules/assessments';
import { DsaService } from '../../src/modules/dsa/dsa.service';
import type { CodeRunner } from '../../src/modules/dsa/execution/code-runner';
import { policyFromEnv } from '../../src/modules/dsa/proctoring/proctoring.policy';
import { ProctoringService } from '../../src/modules/dsa/proctoring/proctoring.service';
import { InMemoryProctorStore } from '../../src/modules/dsa/proctoring/proctoring.store';
import { CONSENT_VERSION } from '../../src/modules/dsa/proctoring/proctoring.types';
import { BankQuestionRepository } from '../../src/modules/dsa/questions/bank-question.repository';
import { EngineSessionStore } from '../../src/modules/dsa/session/engine-session.store';
import { RoundInvitationResolver } from '../../src/modules/dsa/session/round-invitation.resolver';
import { RoundsConfigService } from '../../src/modules/rounds-config';
import { codingKindOf } from '../../src/modules/round-engine/coding-round';
import { buildRoundInviteEmail } from '../../src/modules/round-engine/emails';
import { newAssessmentToken } from '../../src/modules/round-engine/link';
import { nextStep, roundKind } from '../../src/modules/round-engine/online-test';
import { RoundEngineService } from '../../src/modules/round-engine/round-engine.service';
import { SqlBankService } from '../../src/modules/sql/bank/sql-bank.service';
import { MemoryAudit } from '../in-memory';
import { ACTOR, APP, FakeGenerator, JOB, MemoryAssessmentsStore, MemoryRoundsConfigStore, TENANT, student } from '../rounds/fakes';
import { MemoryRoundEngineStore } from '../round-engine/fakes';
import { MemorySqlBankStore, testSandbox } from './fakes';

const T0 = Date.parse('2026-11-04T09:00:00Z');
const noPrograms: CodeRunner = { runBatch: async () => { throw new Error('a SQL round never runs a program'); } } as unknown as CodeRunner;
const sandbox = testSandbox();

// HR's SQL bank, filled with the starter questions (in a real company: the database, sql_questions)
let avgPerDept: SqlBankQuestion;
let neverOrdered: SqlBankQuestion;
beforeAll(async () => {
  const bank = new SqlBankService(new MemorySqlBankStore(), sandbox, new MemoryAudit());
  await bank.importStarter(TENANT, ACTOR);
  const list = await bank.list(TENANT);
  avgPerDept = await bank.get(TENANT, list.find((q) => q.title === 'Average salary per department')!.id);
  neverOrdered = await bank.get(TENANT, list.find((q) => q.title === 'Customers who never ordered')!.id);
}, 120_000);

/** What the rounds editor saves when HR picks a bank question: a copy of it on a CODING question. */
const fromBank = (q: SqlBankQuestion) => ({ kind: 'CODING' as const, text: q.description, marks: q.marks, difficulty: q.difficulty, topics: q.topics, sql: q.problem });

const aptitude: RoundInput = { type: 'APTITUDE', name: 'Aptitude', timeLimitMinutes: 20, passRule: { mode: 'MARKS', value: 1 }, questions: [{ kind: 'MCQ', text: 'Q1', options: ['a', 'b'], correct: [1] }] };
const interview: RoundInput = { type: 'HR_INTERVIEW', name: 'Personal Interview', passRule: { mode: 'INTERVIEWER_SCORE', value: 6, maxScore: 10 } };
const sqlRound = (): RoundInput => ({
  type: 'SQL',
  name: 'SQL Assessment',
  description: 'Two SQL problems.',
  timeLimitMinutes: 30,
  passRule: { mode: 'MARKS', value: 15 },
  questions: [fromBank(avgPerDept), fromBank(neverOrdered)],
});

const AVG_OK = 'SELECT department, AVG(salary) AS average_salary FROM employees GROUP BY department';
const NEVER_OK = 'SELECT customer_id, name FROM customers c WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.customer_id)';
const NEVER_NULL_TRAP = 'SELECT customer_id, name FROM customers WHERE customer_id NOT IN (SELECT customer_id FROM orders)';

let now: number;
let store: MemoryRoundEngineStore;
let results: MemoryAssessmentsStore;
let engine: RoundEngineService;
let saved: SavedRound[];
let service: DsaService;
let token: string;

beforeEach(async () => {
  now = T0;
  const roundsStore = new MemoryRoundsConfigStore();
  roundsStore.addJob(TENANT, JOB);
  results = new MemoryAssessmentsStore();
  results.jobs.push({ id: JOB, tenantId: TENANT, title: 'Data Analyst' });
  results.students.push({ ...student(), tenantId: TENANT });
  store = new MemoryRoundEngineStore();
  store.contexts.set(APP, { tenantId: TENANT, applicationId: APP, jobId: JOB, candidateName: 'Asha Patel', email: 'asha@example.com', jobTitle: 'Data Analyst', companyName: 'Pattern Labs', companyWebsite: null });
  const audit = new MemoryAudit();
  const rounds = new RoundsConfigService(roundsStore, audit, new FakeGenerator().asClient());
  engine = new RoundEngineService(store, rounds, new AssessmentsService(results, rounds, audit), audit, { cameraRequired: true }, () => new Date(now));
  saved = (await rounds.save(TENANT, JOB, { rounds: [aptitude, sqlRound(), interview], complete: true }, ACTOR)).rounds;
  // the candidate was invited to the SQL round (as the engine does after a passed aptitude test)
  const t = newAssessmentToken();
  store.invites.push({ id: '0192f3a1-dddd-7000-8000-000000000001', tenantId: TENANT, applicationId: APP, jobId: JOB, roundId: saved[1]!.id, tokenHash: t.tokenHash, expiresAt: new Date(T0 + 7 * 86_400_000), revokedAt: null, emailStatus: 'SENT', attempts: 1, sentAt: new Date(T0), lastError: null });
  token = t.token;
  const proctoring = new ProctoringService(new InMemoryProctorStore(), { ...policyFromEnv({}), enabled: true, maxStrikes: 2 }, () => now);
  service = new DsaService(new RoundInvitationResolver(engine), new BankQuestionRepository(), new EngineSessionStore(engine), noPrograms, () => now, proctoring, sandbox);
});

const begin = async () => {
  await service.proctorStart(token, { consent: true, consentVersion: CONSENT_VERSION, fullscreen: true, camera: true });
  return service.start(token);
};
const qid = (i: number) => saved[1]!.questions[i]!.id;
const code = (err: unknown) => ((err as HttpException).getResponse() as { code: string }).code;

describe('a SQL round is run by the round engine like a DSA round', () => {
  it('HR’s round of SQL bank questions is an online coding round that follows the aptitude test', () => {
    expect(saved[1]!.questions[0]!.sql).toMatchObject({ bankId: avgPerDept.id, title: 'Average salary per department' });
    expect(isDsaRound(saved[1]!)).toBe(true);
    expect(roundKind(saved[1]!)).toBe('CODING');
    expect(nextStep(saved, saved[0]!, true)).toMatchObject({ kind: 'INVITE', roundKind: 'CODING', round: { id: saved[1]!.id } });
    expect(codingKindOf(saved[1]!)).toBe('sql');
  });

  it('the invitation email speaks of SQL problems, not of Python / Java / C++', () => {
    const mail = buildRoundInviteEmail({
      candidateName: 'Asha', jobTitle: 'Data Analyst', companyName: 'Pattern Labs', companyWebsite: null, roundName: 'SQL Assessment', clearedStep: 'Aptitude',
      timeLimitMinutes: 30, questionCount: 2, instructions: '', link: 'https://x.example/dsa/t', linkExpiresAt: new Date(T0), cameraRequired: false, coding: true, codingKind: 'sql',
    });
    expect(mail.text).toContain('2 SQL problems');
    expect(mail.text).toContain('one SQL query');
    expect(mail.text).not.toContain('Python');
  });

  it('a round copy keeps working when the bank question is later edited or deleted (it is a copy)', () => {
    expect(saved[1]!.questions[1]!.sql!.tests.length).toBe(neverOrdered.problem.tests.length);
  });
});

describe('the candidate takes the SQL round on the coding page', () => {
  it('sees "SQL Assessment", SQL only, the tables and the sample data - never a hidden dataset or the reference query', async () => {
    const state = await begin();
    expect(state).toMatchObject({ title: 'SQL Assessment', languages: ['sql'], durationMinutes: 30, totalMarks: 25 });
    const q = state.questions![0]!;
    expect(q).toMatchObject({ title: 'Average salary per department', languages: ['sql'], starterCode: { sql: 'SELECT *\nFROM employees;' }, hiddenTestCount: 3 });
    expect(q.sql!.tables).toEqual([{ name: 'employees', columns: [{ name: 'id', type: 'INTEGER' }, { name: 'name', type: 'TEXT' }, { name: 'department', type: 'TEXT' }, { name: 'city', type: 'TEXT' }, { name: 'salary', type: 'INTEGER' }] }]);
    expect(q.sql!.samples).toHaveLength(2);
    expect(q.sql!.samples[0]!.data[0]!.rows).toHaveLength(8);
    expect(q.sql!.samples[0]!.expected.columns).toEqual(['department', 'average_salary']);
    const sent = JSON.stringify(state);
    expect(sent).not.toContain('AVG(salary) AS average_salary'); // the reference query
    expect(sent).not.toContain('Aarav'); // a row of a hidden dataset
    expect(sent).not.toContain('INSERT INTO');
  }, 30_000);

  it('Run executes the query on the sample datasets and shows the result tables', async () => {
    await begin();
    const run = await service.run(token, { questionId: qid(0), language: 'sql', code: AVG_OK });
    expect(run).toMatchObject({ verdict: 'passed', passed: 2, total: 2 });
    expect(run.cases[0]).toMatchObject({ status: 'passed', label: 'Sample dataset 1', table: { columns: ['department', 'average_salary'] }, expectedTable: { columns: ['department', 'average_salary'] } });
    const wrong = await service.run(token, { questionId: qid(0), language: 'sql', code: 'SELECT department, AVG(salary) AS avg FROM employees GROUP BY department' });
    expect(wrong.cases[0]).toMatchObject({ status: 'wrong_answer', stderr: 'Column 2 should be named "average_salary" (got "avg"). Use AS to name a column.' });
    const syntax = await service.run(token, { questionId: qid(0), language: 'sql', code: 'SELECT * FORM employees' });
    expect(syntax).toMatchObject({ verdict: 'compile_error', compileOutput: 'near "FORM": syntax error' });
    // a write is refused before it runs (when SQLite prepares it), so it is reported once, like a syntax error
    const destructive = await service.run(token, { questionId: qid(0), language: 'sql', code: 'DELETE FROM employees' });
    expect(destructive.verdict).toBe('compile_error');
    expect(destructive.compileOutput).toMatch(/^Only reading queries are allowed/);
  }, 60_000);

  it('Submit judges the hidden datasets too (only pass / fail of those reaches the page), and the best submission counts', async () => {
    await begin();
    const trap = await service.submit(token, { questionId: qid(1), language: 'sql', code: NEVER_NULL_TRAP });
    expect(trap.verdict).toBe('failed');
    const hidden = trap.cases.filter((c) => c.hidden);
    expect(hidden.some((c) => c.status === 'wrong_answer')).toBe(true);
    for (const c of hidden) expect(Object.keys(c).sort()).toEqual(['hidden', 'id', 'label', 'memoryKb', 'status', 'timeMs']);
    const ok = await service.submit(token, { questionId: qid(1), language: 'sql', code: NEVER_OK });
    expect(ok).toMatchObject({ verdict: 'passed', passed: 5, total: 5, score: 15, maxScore: 15 });
  }, 60_000);

  it('a SQL question takes SQL only; a program is refused', async () => {
    await begin();
    const err = await service.run(token, { questionId: qid(0), language: 'python', code: 'print(1)' }).catch((e: unknown) => e);
    expect(code(err)).toBe('WRONG_LANGUAGE');
  }, 30_000);

  it('finishing grades the round in the assessments module (score, pass mark) with the queries kept for HR, and the student moves on', async () => {
    await begin();
    await service.submit(token, { questionId: qid(0), language: 'sql', code: AVG_OK });
    await service.submit(token, { questionId: qid(1), language: 'sql', code: NEVER_OK });
    now += 10 * 60_000;
    await service.finish(token);
    expect(results.results).toHaveLength(1);
    expect(results.results[0]).toMatchObject({ roundId: saved[1]!.id, score: 25, maxScore: 25, passMark: 15, systemPassed: true });
    expect(JSON.stringify(results.results[0])).toContain('NOT EXISTS'); // the submitted query, for HR's review
    expect(store.outcomeEmails).toEqual([expect.objectContaining({ kind: 'CLEARED_NEXT_BY_HR', nextRoundName: 'Personal Interview' })]);
  }, 60_000);
});

describe('proctoring on a SQL round: the same rules as DSA (two warnings, the third violation ends it)', () => {
  it('warning 1, warning 2, then the attempt ends as a proctoring violation and is graded with what was submitted', async () => {
    await begin();
    await service.submit(token, { questionId: qid(0), language: 'sql', code: AVG_OK });
    const send = (type: string, sec: number) => service.proctorEvents(token, { events: [{ type, at: T0 + sec * 1000 }] });
    now = T0 + 60_000;
    expect(await send('FULLSCREEN_EXIT', 10)).toMatchObject({ strikesUsed: 1, strikesAllowed: 2, ended: false });
    now = T0 + 120_000;
    expect(await send('TAB_SWITCH', 70)).toMatchObject({ strikesUsed: 2, strikesAllowed: 2, ended: false });
    now = T0 + 180_000;
    expect(await send('SCREENSHOT_ATTEMPT', 130)).toMatchObject({ ended: true });
    const state = await service.getState(token);
    expect(state.status).toBe('finished');
    const after = await service.submit(token, { questionId: qid(1), language: 'sql', code: NEVER_OK }).catch((e: unknown) => e);
    expect(code(after)).toBe('ATTEMPT_ENDED');
    expect(results.results[0]).toMatchObject({ score: 10, systemPassed: false });
  }, 60_000);
});
