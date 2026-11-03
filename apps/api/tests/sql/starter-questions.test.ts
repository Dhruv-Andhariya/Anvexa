import { sqlQuestionInputSchema, type SqlProblemSpec } from '@hireflow/contracts';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildProblem } from '../../src/modules/sql/bank/build-problem';
import { STARTER_SQL_QUESTIONS } from '../../src/modules/sql/bank/starter-questions';
import { compareResults } from '../../src/modules/sql/engine/compare';
import { testSandbox } from './fakes';

const sandbox = testSandbox();
const built = new Map<string, SqlProblemSpec>();

/** Every starter question runs: the schema and all datasets load and the reference query works on each. */
beforeAll(async () => {
  for (const s of STARTER_SQL_QUESTIONS) {
    const { seedKey, ...input } = s;
    const { problems, problem } = await buildProblem(sandbox, sqlQuestionInputSchema.parse(input), null);
    expect(problems, `${seedKey}: ${problems.join(' | ')}`).toEqual([]);
    built.set(seedKey, problem!);
  }
}, 180_000);

/** Runs `query` the way a candidate's submission is judged; true = every dataset matches. */
async function judge(seedKey: string, query: string): Promise<boolean[]> {
  const p = built.get(seedKey)!;
  const out = await sandbox.query({ schemaSql: p.schemaSql, datasets: p.tests.map((t) => t.dataSql), query, timeLimitMs: p.timeLimitMs });
  return out.map((o, i) => o.ok && compareResults(o.result, p.tests[i]!.expected, p.orderMatters).equal);
}

describe('the 15 starter SQL questions', () => {
  it('are 5 easy, 5 medium and 5 hard, with unique seed keys and titles', () => {
    expect(STARTER_SQL_QUESTIONS).toHaveLength(15);
    const count = (d: string) => STARTER_SQL_QUESTIONS.filter((q) => q.difficulty === d).length;
    expect([count('EASY'), count('MEDIUM'), count('HARD')]).toEqual([5, 5, 5]);
    expect(new Set(STARTER_SQL_QUESTIONS.map((q) => q.seedKey)).size).toBe(15);
    expect(new Set(STARTER_SQL_QUESTIONS.map((q) => q.title)).size).toBe(15);
  });

  it('each has at least 2 sample and 3 hidden datasets, tables to show, and a result to expect', () => {
    for (const [key, p] of built) {
      expect(p.tests.filter((t) => !t.hidden).length, key).toBeGreaterThanOrEqual(2);
      expect(p.tests.filter((t) => t.hidden).length, key).toBeGreaterThanOrEqual(3);
      expect(p.tables.length, key).toBeGreaterThan(0);
      for (const t of p.tests) expect(t.expected.columns.length, key).toBeGreaterThan(0);
      // the sample datasets show their rows; hidden ones show nothing
      expect(p.tests.filter((t) => t.hidden).every((t) => t.data.length === 0), key).toBe(true);
      expect(p.tests.filter((t) => !t.hidden).every((t) => t.data.length === p.tables.length), key).toBe(true);
    }
  });

  it('the sample datasets give a non-empty expected result (the candidate has something to aim at)', () => {
    for (const [key, p] of built) {
      expect(p.tests.some((t) => !t.hidden && t.expected.rows.length > 0), key).toBe(true);
    }
  });

  it('the reference query passes every dataset of its own question', async () => {
    for (const s of STARTER_SQL_QUESTIONS) expect(await judge(s.seedKey, s.referenceQuery), s.seedKey).not.toContain(false);
  }, 120_000);

  it('the expected results are what the example in the brief says (department averages)', async () => {
    const p = built.get('starter:06')!;
    expect(p.tests[0]!.expected).toEqual({
      columns: ['department', 'average_salary'],
      rows: expect.arrayContaining([['IT', 58000], ['HR', 31500], ['Sales', 37750]]),
    });
    expect(built.get('starter:04')!.tests[0]!.expected.rows).toEqual(expect.arrayContaining([['IT', 4], ['HR', 2], ['Sales', 2]]));
  });

  // the hidden datasets catch the usual mistakes (and so tell a right answer from an almost-right one)
  it.each([
    ['starter:01', 'SELECT id, name, salary FROM employees WHERE salary >= 30000', 'counts the boundary 30000'],
    ['starter:02', "SELECT id, name FROM employees WHERE city LIKE 'ahmedabad'", 'LIKE ignores case'],
    ['starter:03', 'SELECT name, salary FROM employees ORDER BY salary DESC', 'no tie-break by name'],
    ['starter:07', 'SELECT department, COUNT(*) AS employee_count FROM employees GROUP BY department HAVING COUNT(*) >= 3', '>= instead of >'],
    ['starter:09', 'SELECT c.customer_id, c.name, COUNT(*) AS order_count FROM customers c LEFT JOIN orders o ON o.customer_id = c.customer_id GROUP BY c.customer_id', 'COUNT(*) counts 1 for no order'],
    ['starter:10', 'SELECT salary AS second_highest_salary FROM employees ORDER BY salary DESC LIMIT 1 OFFSET 1', 'ties at the top'],
    ['starter:11', 'SELECT salary AS third_highest_salary FROM employees ORDER BY salary DESC LIMIT 1 OFFSET 2', 'no DISTINCT'],
    ['starter:13', 'SELECT customer_id, name FROM customers WHERE customer_id NOT IN (SELECT customer_id FROM orders)', 'NOT IN meets a NULL'],
    ['starter:14', 'SELECT p.category, p.product_name, MAX(s.quantity) AS total_quantity FROM products p JOIN sales s ON s.product_id = p.product_id GROUP BY p.category', 'largest single sale, not the total'],
    ['starter:15', "SELECT strftime('%Y-%m', order_date) AS month, SUM(amount) AS revenue FROM orders GROUP BY month ORDER BY month DESC", 'newest month first'],
  ])('%s: a typical mistake (%s) fails a dataset', async (key, query) => {
    expect(await judge(key, query)).toContain(false);
  }, 60_000);
});
