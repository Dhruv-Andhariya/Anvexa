import type { SqlProblemSpec, SqlQuestionDraft } from '@hireflow/contracts';
import type { SqlSandbox } from '../engine/sql-sandbox';

/**
 * Turns what HR wrote into the problem that runs, by RUNNING it in the SQL sandbox: the schema and every dataset must
 * load, the reference query must succeed on every dataset (its result is the expected one), and the tables, columns
 * and sample rows are read from the real database. So an expected output can never be a typo.
 * Returns the problems found (readable for HR) or the problem.
 */
export async function buildProblem(
  sandbox: SqlSandbox,
  draft: Pick<SqlQuestionDraft, 'title' | 'schemaSql' | 'starterQuery' | 'referenceQuery' | 'orderMatters' | 'timeLimitMs' | 'tests'>,
  bankId: string | null,
): Promise<{ problems: string[]; problem: SqlProblemSpec | null }> {
  const outcomes = await sandbox.inspect({
    schemaSql: draft.schemaSql,
    datasets: draft.tests.map((t) => ({ dataSql: t.dataSql, preview: !t.hidden })),
    query: draft.referenceQuery,
    // HR's reference query may take a little longer than candidates get (it is run once, when saving)
    timeLimitMs: Math.max(draft.timeLimitMs, 2000),
  });
  const label = (i: number) => `Dataset ${i + 1}${draft.tests[i]!.name ? ` (${draft.tests[i]!.name})` : ''}`;
  const problems: string[] = [];
  const setupFailures = outcomes.flatMap((o, i) => (!o.ok && o.kind === 'setup' ? [{ i, message: o.message }] : []));
  if (setupFailures.length === outcomes.length && new Set(setupFailures.map((f) => f.message)).size === 1) {
    problems.push(`The schema (or every dataset) fails: ${setupFailures[0]!.message}`);
  } else {
    for (const f of setupFailures) problems.push(`${label(f.i)} fails to load: ${f.message}`);
  }
  outcomes.forEach((o, i) => {
    if (!o.ok && o.kind !== 'setup') problems.push(`The reference query fails on ${label(i).toLowerCase()}: ${o.message}`);
  });
  const tables = outcomes.find((o) => o.tables.length)?.tables ?? [];
  if (!problems.length && !tables.length) problems.push('The schema creates no table.');
  if (problems.length) return { problems, problem: null };

  const firstTable = tables[0]!.name;
  return {
    problems: [],
    problem: {
      bankId,
      title: draft.title,
      schemaSql: draft.schemaSql,
      starterQuery: draft.starterQuery.trim() ? draft.starterQuery : `SELECT *\nFROM ${firstTable};`,
      referenceQuery: draft.referenceQuery,
      orderMatters: draft.orderMatters,
      timeLimitMs: draft.timeLimitMs,
      tables: tables.map((t) => ({ name: t.name, columns: t.columns })),
      tests: draft.tests.map((t, i) => {
        const o = outcomes[i]!;
        return {
          name: t.name,
          dataSql: t.dataSql,
          hidden: t.hidden,
          data: t.hidden ? [] : o.tables.map((tb) => ({ name: tb.name, columns: tb.columns.map((c) => c.name), rows: tb.rows })),
          expected: o.ok ? o.result : { columns: [], rows: [] },
        };
      }),
    },
  };
}
