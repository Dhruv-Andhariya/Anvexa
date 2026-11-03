import { HttpException } from '@nestjs/common';
import { beforeEach, describe, expect, it } from 'vitest';
import { SqlBankService } from '../../src/modules/sql/bank/sql-bank.service';
import { MemoryAudit } from '../in-memory';
import { MemorySqlBankStore, testSandbox } from './fakes';

const T1 = '0192f3a1-0000-7000-8000-000000000001';
const T2 = '0192f3a1-0000-7000-8000-000000000002';
const HR = { id: '0192f3a1-aaaa-7000-8000-000000000001', name: 'Hina HR' };

/** What HR types in the SQL question form. */
const question = (over: Record<string, unknown> = {}) => ({
  title: 'Employees per department',
  description: 'Show how many employees each department has. Columns: department, employee_count.',
  difficulty: 'EASY',
  marks: 5,
  topics: ['GROUP BY'],
  schemaSql: 'CREATE TABLE employees (id INTEGER PRIMARY KEY, name TEXT, department TEXT);',
  referenceQuery: 'SELECT department, COUNT(*) AS employee_count FROM employees GROUP BY department',
  tests: [
    { name: 'Sample', dataSql: "INSERT INTO employees VALUES (1, 'Rahul', 'IT'), (2, 'Priya', 'HR'), (3, 'Amit', 'IT');", hidden: false },
    { name: 'Hidden', dataSql: "INSERT INTO employees VALUES (1, 'Neha', 'Sales');", hidden: true },
  ],
  ...over,
});

const status = (e: unknown) => (e as HttpException).getStatus();
const body = (e: unknown) => (e as HttpException).getResponse() as { code: string; issues?: { message: string }[] };
const caught = (p: Promise<unknown>) => p.then(() => { throw new Error('expected an error'); }, (e: unknown) => e);

let store: MemorySqlBankStore;
let audit: MemoryAudit;
let bank: SqlBankService;
beforeEach(() => {
  store = new MemorySqlBankStore();
  audit = new MemoryAudit();
  bank = new SqlBankService(store, testSandbox(), audit);
});

describe('HR manages SQL questions (stored in the database, no code change)', () => {
  it('creates a question: the expected results are computed by running the reference query, the tables are read from the schema', async () => {
    const q = await bank.create(T1, question(), HR);
    expect(q).toMatchObject({ title: 'Employees per department', difficulty: 'EASY', marks: 5, active: true, seedKey: null });
    expect(q.problem.tables).toEqual([{ name: 'employees', columns: [{ name: 'id', type: 'INTEGER' }, { name: 'name', type: 'TEXT' }, { name: 'department', type: 'TEXT' }] }]);
    expect(q.problem.tests[0]!.expected).toEqual({ columns: ['department', 'employee_count'], rows: expect.arrayContaining([['IT', 2], ['HR', 1]]) });
    expect(q.problem.tests[0]!.data).toEqual([{ name: 'employees', columns: ['id', 'name', 'department'], rows: [[1, 'Rahul', 'IT'], [2, 'Priya', 'HR'], [3, 'Amit', 'IT']] }]);
    expect(q.problem.tests[1]).toMatchObject({ hidden: true, data: [], expected: { rows: [['Sales', 1]] } });
    expect(q.problem.starterQuery).toBe('SELECT *\nFROM employees;');
    expect(q.problem.bankId).toBe(q.id);
    expect(audit.entries.map((e) => e.action)).toEqual(['sql.question_created']);
    expect(await bank.list(T1)).toEqual([expect.objectContaining({ id: q.id, tests: { sample: 1, hidden: 1 } })]);
  }, 30_000);

  it('refuses a question that does not run, saying why (422), and stores nothing', async () => {
    const broken = await caught(bank.create(T1, question({ referenceQuery: 'SELECT departmnt FROM employees' }), HR));
    expect(status(broken)).toBe(422);
    expect(body(broken)).toMatchObject({ code: 'SQL_QUESTION_NOT_RUNNABLE', issues: [{ message: 'The reference query fails on dataset 1 (sample): no such column: departmnt' }, expect.anything()] });
    const badData = await caught(bank.create(T1, question({ tests: [{ dataSql: 'INSERT INTO nope VALUES (1);' }] }), HR));
    expect(body(badData).issues?.[0]?.message).toMatch(/^The schema \(or every dataset\) fails: no such table: nope/);
    const writes = await caught(bank.create(T1, question({ referenceQuery: 'DELETE FROM employees' }), HR));
    expect(body(writes).issues?.[0]?.message).toMatch(/Only reading queries are allowed/);
    expect(store.rows).toEqual([]);
  }, 30_000);

  it('refuses invalid fields (400) with the same messages as the form', async () => {
    const e = await caught(bank.create(T1, question({ title: ' ', tests: [{ dataSql: '', hidden: true }] }), HR));
    expect(status(e)).toBe(400);
    expect(body(e).issues?.map((i) => i.message)).toEqual(expect.arrayContaining(['Give the question a title', 'Add at least one sample dataset (shown to candidates and used by Run).']));
  });

  it('check runs a question without saving it', async () => {
    const r = await bank.check(question());
    expect(r).toMatchObject({ ok: true, problems: [], problem: { title: 'Employees per department' } });
    expect((await bank.check(question({ schemaSql: 'CREATE TABLE (' }))).ok).toBe(false);
    expect(store.rows).toEqual([]);
  }, 30_000);

  it('edits, deactivates, reactivates and deletes; another company sees none of it', async () => {
    const q = await bank.create(T1, question(), HR);
    const edited = await bank.update(T1, q.id, question({ marks: 8, referenceQuery: 'SELECT department, COUNT(*) AS employee_count FROM employees GROUP BY department ORDER BY department', orderMatters: true }), HR);
    expect(edited).toMatchObject({ marks: 8, problem: { orderMatters: true, tests: [{ expected: { rows: [['HR', 1], ['IT', 2]] } }, expect.anything()] } });
    expect((await bank.setActive(T1, q.id, false, HR)).active).toBe(false);
    expect((await bank.setActive(T1, q.id, true, HR)).active).toBe(true);
    expect(status(await caught(bank.get(T2, q.id)))).toBe(404);
    expect(status(await caught(bank.update(T2, q.id, question(), HR)))).toBe(404);
    expect(status(await caught(bank.setActive(T2, q.id, false, HR)))).toBe(404);
    expect(status(await caught(bank.remove(T2, q.id, HR)))).toBe(404);
    expect(await bank.list(T2)).toEqual([]);
    await bank.remove(T1, q.id, HR);
    expect(await bank.list(T1)).toEqual([]);
    expect(audit.entries.map((e) => e.action)).toEqual([
      'sql.question_created',
      'sql.question_updated',
      'sql.question_deactivated',
      'sql.question_activated',
      'sql.question_deleted',
    ]);
  }, 30_000);

  it('adds the 15 starter questions once per company (a second time adds nothing)', async () => {
    expect(await bank.importStarter(T1, HR)).toEqual({ added: 15, skipped: 0 });
    expect(await bank.importStarter(T1, HR)).toEqual({ added: 0, skipped: 15 });
    const list = await bank.list(T1);
    expect(list).toHaveLength(15);
    expect(list.every((q) => q.tests.sample >= 2 && q.tests.hidden >= 3)).toBe(true);
    // HR deleted one: adding again brings back only that one
    await bank.remove(T1, list[0]!.id, HR);
    expect(await bank.importStarter(T1, HR)).toEqual({ added: 1, skipped: 14 });
    expect(await bank.importStarter(T2, HR)).toEqual({ added: 15, skipped: 0 });
  }, 120_000);
});
