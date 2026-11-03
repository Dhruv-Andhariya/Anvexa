import { Logger } from '@nestjs/common';
import { compareResults, formatTable } from '../../sql/engine/compare';
import type { SqlOutcome, SqlSandbox } from '../../sql/engine/sql-sandbox';
import type { DsaQuestion, TestCase } from '../questions/question.types';
import type { CaseResult, CaseStatus, Evaluation } from './evaluator';

const logger = new Logger('DsaSqlEvaluator');

/**
 * Judges a SQL answer: the query runs in the SQL sandbox on every dataset (a fresh database each), and its result
 * table is compared with the expected one (compareResults: columns, values, NULLs, duplicates, order only when the
 * question asks). Same shape of result as a program's evaluation, so scoring, progress and the page work unchanged.
 * Hidden datasets report only their status; sample ones also carry both tables and what differs.
 */
export class SqlEvaluator {
  constructor(private readonly sandbox: SqlSandbox) {}

  async evaluate(question: DsaQuestion, query: string, cases: TestCase[]): Promise<Evaluation> {
    const spec = question.sql;
    if (!spec) throw new Error(`Question ${question.id} is not a SQL problem`);
    const labels = labelsOf(cases);
    const outcomes = await this.sandbox.query({
      schemaSql: spec.schemaSql,
      datasets: cases.map((c) => c.sql?.dataSql ?? ''),
      query,
      timeLimitMs: spec.timeLimitMs,
    });

    // a query that does not compile fails the same way on every dataset: report it once, like a compile error
    const syntax = outcomes.find((o): o is Extract<SqlOutcome, { ok: false }> => !o.ok && o.kind === 'syntax');
    if (syntax) {
      return {
        verdict: 'compile_error',
        passed: 0,
        total: cases.length,
        compileOutput: syntax.message,
        cases: cases.map((c, i) => ({ id: c.id, label: labels[i]!, hidden: c.hidden, status: 'compile_error', timeMs: null, memoryKb: null })),
      };
    }

    const out = cases.map((c, i) => this.grade(question, c, labels[i]!, outcomes[i]!));
    const passed = out.filter((c) => c.status === 'passed').length;
    const allInternal = out.length > 0 && out.every((c) => c.status === 'internal_error');
    return {
      verdict: allInternal ? 'internal_error' : passed === out.length ? 'passed' : 'failed',
      passed,
      total: out.length,
      compileOutput: '',
      cases: out,
    };
  }

  private grade(question: DsaQuestion, c: TestCase, label: string, o: SqlOutcome): CaseResult {
    const expected = c.sql?.expected ?? { columns: [], rows: [] };
    let status: CaseStatus;
    let note = '';
    if (o.ok) {
      const cmp = compareResults(o.result, expected, question.sql!.orderMatters);
      status = cmp.equal ? 'passed' : 'wrong_answer';
      note = cmp.reason ?? '';
    } else if (o.kind === 'time_limit') {
      status = 'time_limit';
      note = o.message;
    } else if (o.kind === 'setup') {
      // HR's schema / dataset failed at run time: not the candidate's fault (it was checked when HR saved it)
      logger.error(`SQL dataset failed to load for question ${question.id} (${c.id}): ${o.message}`);
      status = 'internal_error';
      note = 'This dataset could not be prepared. This is not caused by your query; please try again.';
    } else {
      status = 'runtime_error';
      note = o.message;
    }
    const base: CaseResult = { id: c.id, label, hidden: c.hidden, status, timeMs: o.timeMs, memoryKb: null };
    if (c.hidden) return base; // hidden datasets: no data, no expected result, no output
    return {
      ...base,
      input: c.display,
      expected: formatTable(expected),
      actual: o.ok ? formatTable(o.result) : '',
      stdout: '',
      stderr: status === 'passed' ? '' : note,
      ...(o.ok ? { table: o.result } : {}),
      expectedTable: expected,
    };
  }
}

function labelsOf(cases: TestCase[]): string[] {
  let samples = 0;
  let hidden = 0;
  return cases.map((c) => (c.hidden ? `Hidden dataset ${++hidden}` : `Sample dataset ${++samples}`));
}
