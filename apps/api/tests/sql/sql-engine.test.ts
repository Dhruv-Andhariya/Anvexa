import { describe, expect, it } from 'vitest';
import { compareResults, formatTable } from '../../src/modules/sql/engine/compare';
import { SqlSandbox, readableSqlError } from '../../src/modules/sql/engine/sql-sandbox';
import { singleStatementProblem, sqlStatements } from '../../src/modules/sql/engine/statements';

const SCHEMA = `
CREATE TABLE departments (department_id INTEGER PRIMARY KEY, department_name TEXT NOT NULL);
CREATE TABLE employees (employee_id INTEGER PRIMARY KEY, name TEXT NOT NULL, department_id INTEGER REFERENCES departments(department_id), salary INTEGER);
`;
const DATA = `
INSERT INTO departments VALUES (101, 'IT'), (102, 'HR'), (103, 'Finance');
INSERT INTO employees VALUES (1, 'Rahul', 101, 50000), (2, 'Priya', 102, 60000), (3, 'Amit', 101, 70000), (4, 'Neha', 103, 45000), (5, 'Karan', 102, 80000);
`;
const AVG_BY_DEPT = `SELECT d.department_name, AVG(e.salary) AS average_salary
FROM employees e JOIN departments d ON d.department_id = e.department_id
GROUP BY d.department_name`;

const sandbox = new SqlSandbox({ concurrency: 2, maxQueue: 10, queueTimeoutMs: 30_000, heapBytes: 64 * 1024 * 1024, startupMs: 5000 });
const one = async (query: string, timeLimitMs = 2000, data = DATA) => (await sandbox.query({ schemaSql: SCHEMA, datasets: [data], query, timeLimitMs }))[0]!;

describe('the SQL sandbox runs real queries', () => {
  it('JOIN + GROUP BY + AVG on the question data', async () => {
    const r = await one(AVG_BY_DEPT);
    expect(r.ok && r.result).toEqual({ columns: ['department_name', 'average_salary'], rows: expect.arrayContaining([['IT', 60000], ['HR', 70000], ['Finance', 45000]]) });
  }, 30_000);

  it('every dataset gets its own fresh database', async () => {
    const rows = await sandbox.query({
      schemaSql: SCHEMA,
      datasets: [DATA, "INSERT INTO departments VALUES (1, 'Ops');"],
      query: 'SELECT COUNT(*) AS n FROM departments',
      timeLimitMs: 2000,
    });
    expect(rows.map((r) => r.ok && r.result.rows)).toEqual([[[3]], [[1]]]);
  }, 30_000);

  it('WHERE / LIKE / BETWEEN / IN / CASE / subquery / UNION / LEFT and RIGHT JOIN / window functions / NULL handling', async () => {
    const queries = [
      "SELECT name FROM employees WHERE name LIKE 'P%' AND salary BETWEEN 50000 AND 65000 AND department_id IN (101, 102)",
      "SELECT name, CASE WHEN salary >= 60000 THEN 'high' ELSE 'low' END AS band FROM employees",
      'SELECT name FROM employees WHERE salary > (SELECT AVG(salary) FROM employees)',
      'SELECT name FROM employees WHERE department_id = 101 UNION SELECT department_name FROM departments',
      'SELECT d.department_name, e.name FROM departments d LEFT JOIN employees e ON e.department_id = d.department_id',
      'SELECT d.department_name, e.name FROM employees e RIGHT JOIN departments d ON e.department_id = d.department_id',
      'SELECT name, RANK() OVER (ORDER BY salary DESC) AS r FROM employees',
      'SELECT COALESCE(NULL, 0) AS z, NULL IS NULL AS n',
    ];
    for (const q of queries) {
      const r = await one(q);
      expect(r.ok, `${q}: ${!r.ok ? r.message : ''}`).toBe(true);
    }
  }, 60_000);
});

describe('the SQL sandbox is read-only and isolated', () => {
  it.each([
    'DROP TABLE employees',
    'DELETE FROM employees',
    "UPDATE employees SET salary = 0",
    "INSERT INTO employees VALUES (9, 'X', 101, 1)",
    'CREATE TABLE x (a INT)',
    'ALTER TABLE employees ADD COLUMN x INT',
    "ATTACH DATABASE 'hack.db' AS h",
    'PRAGMA table_info(employees)',
    'BEGIN',
  ])('refuses %s with a readable message', async (q) => {
    const r = await one(q);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/Only reading queries are allowed/);
  }, 30_000);

  it('accepts exactly one statement ("SELECT 1; DROP TABLE t" is refused before anything runs)', async () => {
    const r = await one('SELECT 1; DROP TABLE employees');
    expect(r).toMatchObject({ ok: false, kind: 'syntax', message: 'Write one query only (found 2 statements separated by ";").' });
    expect(await one('SELECT 1;  -- done')).toMatchObject({ ok: true });
    expect(await one("SELECT ';' AS semi")).toMatchObject({ ok: true, result: { rows: [[';']] } });
  }, 30_000);

  it('reports a syntax error as SQLite says it', async () => {
    expect(await one('SELECT * FORM employees')).toMatchObject({ ok: false, kind: 'syntax', message: 'near "FORM": syntax error' });
    expect(await one('SELECT nope FROM employees')).toMatchObject({ ok: false, kind: 'syntax', message: 'no such column: nope' });
  }, 30_000);

  it('kills a query that never ends at the time limit, and the API process stays responsive meanwhile', async () => {
    const forever = 'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT COUNT(*) FROM c';
    let ticks = 0;
    const tick = setInterval(() => ticks++, 50);
    const started = Date.now();
    const r = await one(forever, 1000);
    clearInterval(tick);
    expect(r).toMatchObject({ ok: false, kind: 'time_limit' });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(ticks).toBeGreaterThan(5); // the event loop kept running while the query ran
  }, 30_000);

  it('stops at the row limit', async () => {
    const many = 'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 5000) SELECT x FROM c';
    expect(await one(many)).toMatchObject({ ok: false, kind: 'too_many_rows' });
  }, 30_000);

  it('a broken schema or dataset is reported as a setup problem (HR side), not as the candidate’s error', async () => {
    const [r] = await sandbox.query({ schemaSql: 'CREATE TABLE t (', datasets: [''], query: 'SELECT 1', timeLimitMs: 2000 });
    expect(r).toMatchObject({ ok: false, kind: 'setup' });
    const [a] = await sandbox.query({ schemaSql: SCHEMA, datasets: ["ATTACH DATABASE 'x.db' AS x;"], query: 'SELECT 1', timeLimitMs: 2000 });
    expect(a).toMatchObject({ ok: false, kind: 'setup' });
  }, 30_000);

  it('inspect lists the tables, their columns and the sample rows, and runs the reference query', async () => {
    const [r] = await sandbox.inspect({ schemaSql: SCHEMA, datasets: [{ dataSql: DATA, preview: true }], query: AVG_BY_DEPT, timeLimitMs: 2000 });
    expect(r!.ok).toBe(true);
    expect(r!.tables.map((t) => [t.name, t.columns.map((c) => `${c.name}:${c.type}`), t.rows.length])).toEqual([
      ['departments', ['department_id:INTEGER', 'department_name:TEXT'], 3],
      ['employees', ['employee_id:INTEGER', 'name:TEXT', 'department_id:INTEGER', 'salary:INTEGER'], 5],
    ]);
  }, 30_000);
});

describe('statements and messages', () => {
  it('splits only at real statement ends', () => {
    // semicolons inside strings, quoted names and comments are not statement ends (comments stay in the text)
    expect(sqlStatements("SELECT 'a;b' AS x; -- c;\n/* d; */ SELECT \"e;f\" FROM [g;h];")).toEqual(["SELECT 'a;b' AS x", '-- c;\n/* d; */ SELECT "e;f" FROM [g;h]']);
    expect(sqlStatements('-- only a comment; really\n/* and; this */')).toEqual([]);
    expect(sqlStatements("SELECT 'it''s; fine'")).toEqual(["SELECT 'it''s; fine'"]);
    expect(singleStatementProblem('   -- nothing\n')).toBe('Write a SQL query first.');
  });

  it('turns SQLite refusals into one readable sentence', () => {
    expect(readableSqlError('not authorized')).toMatch(/^Only reading queries are allowed/);
    expect(readableSqlError('no such table: emp')).toBe('no such table: emp');
  });
});

describe('comparing results as tables', () => {
  const expected = { columns: ['department', 'employee_count'], rows: [['HR', 1], ['IT', 3], ['Sales', 1]] };

  it('ignores row order unless the question asks for it', () => {
    const shuffled = { columns: ['department', 'employee_count'], rows: [['IT', 3], ['Sales', 1], ['HR', 1]] };
    expect(compareResults(shuffled, expected, false)).toEqual({ equal: true, reason: null });
    expect(compareResults(shuffled, expected, true)).toEqual({ equal: false, reason: 'The rows are right but not in the order the question asks for (check ORDER BY).' });
  });

  it('checks column names (case-insensitive) and count', () => {
    expect(compareResults({ columns: ['DEPARTMENT', 'Employee_Count'], rows: expected.rows }, expected, true).equal).toBe(true);
    expect(compareResults({ columns: ['department', 'cnt'], rows: expected.rows }, expected, true).reason).toBe('Column 2 should be named "employee_count" (got "cnt"). Use AS to name a column.');
    expect(compareResults({ columns: ['department'], rows: [['HR']] }, expected, true).reason).toMatch(/^Expected 2 columns/);
  });

  it('numbers with a tolerance, NULL only equals NULL, a number never equals text, duplicates count', () => {
    const avg = { columns: ['a'], rows: [[60000]] };
    expect(compareResults({ columns: ['a'], rows: [[60000.0000001]] }, avg, false).equal).toBe(true);
    expect(compareResults({ columns: ['a'], rows: [[60000.5]] }, avg, false).equal).toBe(false);
    expect(compareResults({ columns: ['a'], rows: [['60000']] }, avg, false).equal).toBe(false);
    expect(compareResults({ columns: ['a'], rows: [[null]] }, { columns: ['a'], rows: [[null]] }, false).equal).toBe(true);
    expect(compareResults({ columns: ['a'], rows: [[0]] }, { columns: ['a'], rows: [[null]] }, false).equal).toBe(false);
    expect(compareResults({ columns: ['a'], rows: [[1], [1]] }, { columns: ['a'], rows: [[1]] }, false).reason).toBe('Expected 1 row, got 2.');
    expect(compareResults({ columns: ['a'], rows: [[1], [2]] }, { columns: ['a'], rows: [[1], [1]] }, false).equal).toBe(false);
  });

  it('formats a result as a readable text table', () => {
    expect(formatTable(expected)).toBe('department | employee_count\n-----------+---------------\nHR         | 1\nIT         | 3\nSales      | 1');
  });
});
