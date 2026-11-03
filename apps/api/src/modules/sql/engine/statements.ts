/**
 * Splits SQL text into its statements at the semicolons that are really statement ends: not inside a string
 * ('...'), a quoted name ("...", `...`, [...]) or a comment (-- ..., /* ... *\/). Statements that hold only
 * whitespace or comments are dropped.
 *
 * Used to accept exactly ONE query from a candidate: SQLite's prepare() silently ignores anything after the first
 * statement, so "SELECT 1; DROP TABLE t" would otherwise look like a valid answer. (The tail could never run anyway:
 * the database is read-only for the candidate - see the worker.)
 */
export function sqlStatements(sql: string): string[] {
  const out: string[] = [];
  let start = 0;
  let meaningful = false;
  let i = 0;
  const push = (end: number) => {
    if (meaningful) out.push(sql.slice(start, end).trim());
    start = end + 1;
    meaningful = false;
  };
  while (i < sql.length) {
    const c = sql[i]!;
    const next = sql[i + 1];
    if (c === '-' && next === '-') {
      const nl = sql.indexOf('\n', i);
      i = nl === -1 ? sql.length : nl + 1;
      continue;
    }
    if (c === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 2;
      continue;
    }
    const close = c === "'" ? "'" : c === '"' ? '"' : c === '`' ? '`' : c === '[' ? ']' : null;
    if (close) {
      meaningful = true;
      // a doubled quote ('it''s') stays inside the literal
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === close) {
          if (close !== ']' && sql[j + 1] === close) j += 2;
          else break;
        } else j += 1;
      }
      i = j + 1;
      continue;
    }
    if (c === ';') push(i);
    else if (!/\s/.test(c)) meaningful = true;
    i += 1;
  }
  push(sql.length);
  return out;
}

/** Why this text is not exactly one statement (null = it is). Readable for candidates and HR. */
export function singleStatementProblem(sql: string): string | null {
  const n = sqlStatements(sql).length;
  if (n === 0) return 'Write a SQL query first.';
  if (n > 1) return `Write one query only (found ${n} statements separated by ";").`;
  return null;
}
