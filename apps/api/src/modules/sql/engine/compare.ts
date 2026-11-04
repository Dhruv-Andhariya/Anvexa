import type { SqlCell, SqlResult } from '@hireflow/contracts';

/** Relative tolerance for numbers (AVG and other floating-point results). */
const TOLERANCE = 1e-6;

export function cellsEqual(actual: SqlCell, expected: SqlCell): boolean {
  if (actual === null || expected === null) return actual === expected;
  if (typeof actual === 'number' && typeof expected === 'number') {
    return Math.abs(actual - expected) <= TOLERANCE * Math.max(1, Math.abs(expected));
  }
  // a number where text is expected (or the other way round) is a different data type: not equal
  return typeof actual === typeof expected && actual === expected;
}

/** Sort key of a row that ignores the tiny differences cellsEqual() tolerates. */
const rowKey = (row: SqlCell[]) =>
  JSON.stringify(row.map((c) => (c === null ? ['z'] : typeof c === 'number' ? ['n', Number(c.toPrecision(10))] : ['s', c])));

const sortRows = (rows: SqlCell[][]) => [...rows].sort((a, b) => (rowKey(a) < rowKey(b) ? -1 : rowKey(a) > rowKey(b) ? 1 : 0));

const rowsEqual = (a: SqlCell[][], b: SqlCell[][]) => a.length === b.length && a.every((row, i) => row.length === b[i]!.length && row.every((c, j) => cellsEqual(c, b[i]![j]!)));

const show = (c: SqlCell) => (c === null ? 'NULL' : typeof c === 'string' ? `'${c}'` : String(c));
const showRow = (row: SqlCell[]) => `(${row.map(show).join(', ')})`;

/**
 * Compares a query result with the expected one as tables, never as text: the columns (count and names, ignoring
 * case), every value (numbers with a small tolerance, NULL only equals NULL, a number never equals text), duplicate
 * rows count. Row order counts only when `orderMatters` (the question asks for an ORDER BY).
 * `reason` says what differs, for the candidate on sample datasets (never shown for hidden ones).
 */
export function compareResults(actual: SqlResult, expected: SqlResult, orderMatters: boolean): { equal: boolean; reason: string | null } {
  if (actual.columns.length !== expected.columns.length) {
    return {
      equal: false,
      reason: `Expected ${expected.columns.length} column${expected.columns.length === 1 ? '' : 's'} (${expected.columns.join(', ')}), got ${actual.columns.length} (${actual.columns.join(', ')}).`,
    };
  }
  for (let i = 0; i < expected.columns.length; i++) {
    if (actual.columns[i]!.trim().toLowerCase() !== expected.columns[i]!.trim().toLowerCase()) {
      return { equal: false, reason: `Column ${i + 1} should be named "${expected.columns[i]}" (got "${actual.columns[i]}"). Use AS to name a column.` };
    }
  }
  if (actual.rows.length !== expected.rows.length) {
    return { equal: false, reason: `Expected ${expected.rows.length} row${expected.rows.length === 1 ? '' : 's'}, got ${actual.rows.length}.` };
  }
  if (orderMatters) {
    if (rowsEqual(actual.rows, expected.rows)) return { equal: true, reason: null };
    if (rowsEqual(sortRows(actual.rows), sortRows(expected.rows))) {
      return { equal: false, reason: 'The rows are right but not in the order the question asks for (check ORDER BY).' };
    }
  } else {
    const a = sortRows(actual.rows);
    const e = sortRows(expected.rows);
    if (rowsEqual(a, e)) return { equal: true, reason: null };
  }
  const missing = expected.rows.find((row) => !actual.rows.some((r) => r.length === row.length && r.every((c, j) => cellsEqual(c, row[j]!))));
  return { equal: false, reason: missing ? `Expected a row ${showRow(missing)} that your result does not have.` : 'Some values differ from the expected result.' };
}

/** A result as a plain text table (for logs, tests and the text fields of a case result). */
export function formatTable(result: SqlResult, maxRows = 50): string {
  const head = result.columns;
  const body = result.rows.slice(0, maxRows).map((r) => r.map((c) => (c === null ? 'NULL' : String(c))));
  const widths = head.map((h, i) => Math.min(40, Math.max(h.length, ...body.map((r) => (r[i] ?? '').length))));
  const line = (cells: string[]) => cells.map((c, i) => c.slice(0, 40).padEnd(widths[i]!)).join(' | ').trimEnd();
  const out = [line(head), widths.map((w) => '-'.repeat(w)).join('-+-'), ...body.map(line)];
  if (result.rows.length > maxRows) out.push(`... ${result.rows.length - maxRows} more row(s)`);
  if (!result.rows.length) out.push('(no rows)');
  return out.join('\n');
}
