import type { SqlProblemSpec } from '@hireflow/contracts';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/lib/api';
import { fromSaved, newQuestion, newRound, toRequest, validate } from '../src/lib/rounds';
import { addStarterSqlQuestions, createSqlQuestion, deleteSqlQuestion, setSqlQuestionActive } from '../src/lib/sql-bank-api';

const ID = '0192f3a1-7c2e-7a10-8b2c-123456789abc';
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A copy of a SQL bank question, as the rounds editor stores it on a coding question. */
const problem: SqlProblemSpec = {
  bankId: ID,
  title: 'Employees per department',
  schemaSql: 'CREATE TABLE employees (id INTEGER, department TEXT);',
  starterQuery: 'SELECT *\nFROM employees;',
  referenceQuery: 'SELECT department, COUNT(*) AS employee_count FROM employees GROUP BY department',
  orderMatters: false,
  timeLimitMs: 2000,
  tables: [{ name: 'employees', columns: [{ name: 'id', type: 'INTEGER' }, { name: 'department', type: 'TEXT' }] }],
  tests: [
    { name: 'Sample', dataSql: "INSERT INTO employees VALUES (1, 'IT');", hidden: false, data: [{ name: 'employees', columns: ['id', 'department'], rows: [[1, 'IT']] }], expected: { columns: ['department', 'employee_count'], rows: [['IT', 1]] } },
    { name: 'Hidden', dataSql: '', hidden: true, data: [], expected: { columns: ['department', 'employee_count'], rows: [] } },
  ],
};

const sqlRound = () => {
  const r = newRound('SQL');
  r.passMode = 'MARKS';
  r.passValue = '5';
  r.questions = [{ ...newQuestion('CODING'), text: 'Show how many employees each department has.', marks: '10', sql: problem }];
  return r;
};

describe('a SQL round in the rounds editor', () => {
  it('sends the SQL bank question copy with the coding question, and passes the same rules as the API', () => {
    const req = toRequest([sqlRound()], true);
    expect(req.rounds[0]!.questions?.[0]).toMatchObject({ kind: 'CODING', sql: problem, coding: null });
    expect(validate([sqlRound()], true).ok).toBe(true);
  });

  it('refuses a SQL problem on a non-coding question, or together with a DSA problem', () => {
    const onMcq = sqlRound();
    onMcq.questions = [{ ...newQuestion('DESCRIPTIVE'), text: 'x', sql: problem }];
    // a non-coding question never sends its SQL copy (the editor drops it), so the round is just not a SQL round
    expect(toRequest([onMcq], false).rounds[0]!.questions?.[0]?.sql).toBeNull();
    const both = sqlRound();
    both.questions[0]!.topics = ['dsa:dsa-001'];
    const v = validate([both], false);
    expect(v.ok).toBe(false);
    expect(JSON.stringify(v)).toContain('A question can have one problem only');
  });

  it('keeps the copy when the saved rounds are loaded back', () => {
    const saved = fromSaved([
      {
        id: ID,
        position: 1,
        type: 'SQL',
        name: 'SQL',
        description: '',
        timeLimitMinutes: 30,
        passRule: { mode: 'MARKS', value: 5, maxScore: null },
        questions: [{ id: ID, position: 1, kind: 'CODING', text: 't', options: [], correct: [], modelAnswer: null, language: 'SQL', marks: 10, difficulty: 'EASY', topics: [], source: 'HR', coding: null, sql: problem }],
        totals: { questions: 1, marks: 10 },
      },
    ]);
    expect(saved[0]!.questions[0]!.sql).toEqual(problem);
  });
});

describe('SQL question bank api client', () => {
  it('creates a question with the session cookie and CSRF header (never a company id)', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json(201, { id: ID, title: 'x' }));
    await createSqlQuestion({ title: 'x', description: 'd', difficulty: 'EASY', marks: 1, schemaSql: 's', referenceQuery: 'q', tests: [{ dataSql: '' }] }, { fetch, baseUrl: 'http://api.test' });
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe('http://api.test/sql-hr/questions');
    expect(init).toMatchObject({ method: 'POST', credentials: 'include' });
    expect((init!.headers as Record<string, string>)['x-requested-with']).toBe('hireflow');
    expect(JSON.parse(String(init!.body))).not.toHaveProperty('tenantId');
  });

  it('activates / deactivates, deletes (204) and adds the starter questions', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(json(200, { id: ID, active: false })).mockResolvedValueOnce(new Response(null, { status: 204 })).mockResolvedValueOnce(json(200, { added: 15, skipped: 0 }));
    await setSqlQuestionActive(ID, false, { fetch, baseUrl: 'http://api.test' });
    expect(fetch.mock.calls[0]![1]).toMatchObject({ method: 'PATCH', body: JSON.stringify({ active: false }) });
    await expect(deleteSqlQuestion(ID, { fetch, baseUrl: 'http://api.test' })).resolves.toBeUndefined();
    expect(String(fetch.mock.calls[1]![0])).toBe(`http://api.test/sql-hr/questions/${ID}`);
    await expect(addStarterSqlQuestions({ fetch, baseUrl: 'http://api.test' })).resolves.toEqual({ added: 15, skipped: 0 });
  });

  it('shows why a question was not saved (it does not run)', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json(422, { code: 'SQL_QUESTION_NOT_RUNNABLE', message: 'The reference query fails on dataset 1: no such column: x' }));
    const err = await createSqlQuestion({ title: 'x', description: 'd', difficulty: 'EASY', marks: 1, schemaSql: 's', referenceQuery: 'q', tests: [{ dataSql: '' }] }, { fetch }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.message).toBe('The reference query fails on dataset 1: no such column: x');
  });
});
