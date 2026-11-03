import type { DsaRoundQuestion } from '../session/invitation.resolver';
import { formatTable } from '../../sql/engine/compare';
import type { Difficulty, DsaQuestion } from './question.types';

const DIFFICULTY: Record<'EASY' | 'MEDIUM' | 'HARD', Difficulty> = { EASY: 'Easy', MEDIUM: 'Medium', HARD: 'Hard' };

/**
 * A SQL problem as the coding page runs it, from the round's copy of the SQL bank question: the question text is the
 * statement, the answer is one query (language "sql"), and every dataset is a test case (sample ones shown with their
 * tables and expected result; hidden ones never leave the API - toPublicQuestion whitelists what is sent).
 */
export function fromSqlProblem(q: DsaRoundQuestion & { sql: NonNullable<DsaRoundQuestion['sql']> }): DsaQuestion {
  const { statement, difficulty, spec } = q.sql;
  let samples = 0;
  let hidden = 0;
  return {
    id: q.id,
    title: spec.title,
    difficulty: DIFFICULTY[difficulty ?? 'MEDIUM'],
    marks: q.marks,
    description: statement,
    inputFormat: '',
    outputFormat: '',
    constraints: [],
    samples: [],
    starterCode: { sql: spec.starterQuery },
    languages: ['sql'],
    harness: 'sql',
    comparator: 'exact',
    sql: spec,
    testCases: spec.tests.map((t) => {
      const id = t.hidden ? `h${++hidden}` : `s${++samples}`;
      return {
        id,
        display: t.hidden ? '' : t.name || `Sample data ${samples}`,
        stdin: '',
        expectedOutput: t.hidden ? '' : formatTable(t.expected),
        hidden: t.hidden,
        sql: { dataSql: t.dataSql, expected: t.expected, data: t.hidden ? [] : t.data },
      };
    }),
  };
}
