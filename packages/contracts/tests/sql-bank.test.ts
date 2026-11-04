import { describe, expect, it } from 'vitest';
import { SQL_LIMITS, sqlProblemSpecSchema, sqlQuestionInputSchema, sqlSpecProblems } from '../src';

const input = {
  title: 'Employees per department',
  description: 'Count employees per department.',
  difficulty: 'EASY',
  marks: 5,
  schemaSql: 'CREATE TABLE employees (id INTEGER, department TEXT);',
  referenceQuery: 'SELECT department, COUNT(*) AS n FROM employees GROUP BY department',
  tests: [{ dataSql: "INSERT INTO employees VALUES (1, 'IT');" }, { dataSql: '', hidden: true }],
};

describe('SQL bank question (what HR writes)', () => {
  it('fills the defaults: any order, 2 s per query, active, starter query empty (= SELECT * FROM the first table)', () => {
    expect(sqlQuestionInputSchema.parse(input)).toMatchObject({ orderMatters: false, timeLimitMs: 2000, active: true, starterQuery: '', topics: [], tests: [{ name: '', hidden: false }, { hidden: true }] });
  });

  it('needs a title, a description, the schema, the reference query and at least one sample dataset', () => {
    const r = sqlQuestionInputSchema.safeParse({ ...input, title: ' ', description: '', schemaSql: '', referenceQuery: '', tests: [{ dataSql: '', hidden: true }] });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.map((i) => i.message)).toEqual(
        expect.arrayContaining([
          'Give the question a title',
          'Describe what the query must return',
          'Write the CREATE TABLE statements',
          'Write the reference (correct) query',
          'Add at least one sample dataset (shown to candidates and used by Run).',
        ]),
      );
    }
  });

  it('keeps marks, time limit and dataset count within limits', () => {
    expect(sqlQuestionInputSchema.safeParse({ ...input, marks: 0 }).success).toBe(false);
    expect(sqlQuestionInputSchema.safeParse({ ...input, timeLimitMs: SQL_LIMITS.timeLimitMaxMs + 1 }).success).toBe(false);
    expect(sqlQuestionInputSchema.safeParse({ ...input, tests: Array.from({ length: SQL_LIMITS.testsMax + 1 }, () => ({ dataSql: '' })) }).success).toBe(false);
  });

  it('a problem is gradable with at least one sample dataset', () => {
    expect(sqlSpecProblems({ tests: [{ hidden: false }] })).toEqual([]);
    expect(sqlSpecProblems({ tests: [{ hidden: true }] })).toHaveLength(1);
  });

  it('the computed problem keeps result values typed (numbers, text, NULL)', () => {
    const p = sqlProblemSpecSchema.parse({
      title: 't',
      schemaSql: 's',
      starterQuery: '',
      referenceQuery: 'q',
      orderMatters: false,
      timeLimitMs: 2000,
      tables: [],
      tests: [{ name: '', dataSql: '', hidden: false, data: [], expected: { columns: ['a', 'b', 'c'], rows: [[1.5, 'x', null]] } }],
    });
    expect(p.bankId).toBeNull();
    expect(p.tests[0]!.expected.rows[0]).toEqual([1.5, 'x', null]);
  });
});
