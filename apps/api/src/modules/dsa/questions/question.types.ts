import type { SqlProblemSpec, SqlResult, SqlTable } from '@hireflow/contracts';

/** Languages of DSA problems: programs run by the code runner (Piston). */
export const CODE_LANGUAGES = ['python', 'java', 'cpp'] as const;
export type CodeLanguage = (typeof CODE_LANGUAGES)[number];

/** Every language the coding page accepts: SQL problems are answered with one query, run in the SQL sandbox. */
export const LANGUAGES = [...CODE_LANGUAGES, 'sql'] as const;
export type Language = (typeof LANGUAGES)[number];

export const isCodeLanguage = (l: string): l is CodeLanguage => (CODE_LANGUAGES as readonly string[]).includes(l);

export type Difficulty = 'Easy' | 'Medium' | 'Hard';

/**
 * How the evaluator compares the answer: `exact` / `float` for a harness' single result line, `lines` for a whole
 * program's stdout (line by line, trailing spaces and trailing blank lines ignored). SQL problems compare result
 * tables instead (sql/engine/compare.ts).
 */
export type Comparator = 'exact' | 'float' | 'lines';

/**
 * Which harness template wraps the candidate's function. One per bank problem shape; `stdio` = HR's own problems,
 * where the candidate writes the whole program (reads stdin, prints the answer) and nothing is wrapped around it;
 * `sql` = a SQL problem (no program at all: the query runs in the SQL sandbox).
 */
export type HarnessKind = 'two-sum' | 'longest-substring' | 'median-sorted-arrays' | 'stdio' | 'sql';

export interface TestCase {
  id: string;
  /** Human readable input, only ever shown for public (sample) cases. */
  display: string;
  /** Machine input piped to the program on stdin. Never leaves the backend for hidden cases. */
  stdin: string;
  expectedOutput: string;
  /** Public cases are shown to the candidate and used by "Run". Hidden cases are backend only. */
  hidden: boolean;
  /**
   * SQL problems: the dataset (INSERT statements), the expected result table and, for a sample dataset, the rows of
   * each table (shown to the candidate). Only toPublicQuestion decides what of it leaves the backend.
   */
  sql?: { dataSql: string; expected: SqlResult; data: PublicSqlProblem['samples'][number]['data'] };
}

export interface QuestionSample {
  input: string;
  output: string;
  explanation: string;
}

/**
 * Full question as stored by the data layer, hidden test cases included.
 * This type must never be serialised to a client; use `toPublicQuestion`.
 */
export interface DsaQuestion {
  id: string;
  title: string;
  difficulty: Difficulty;
  marks: number;
  description: string;
  inputFormat: string;
  outputFormat: string;
  constraints: string[];
  samples: QuestionSample[];
  /** One per language the question accepts. */
  starterCode: Partial<Record<Language, string>>;
  /** The languages the candidate may answer in (absent = the three code languages). */
  languages?: Language[];
  harness: HarnessKind;
  comparator: Comparator;
  testCases: TestCase[];
  /** SQL problems only: the problem as HR set it up (schema, order rule, time limit...). Never sent as is. */
  sql?: SqlProblemSpec;
}

export const languagesOf = (q: Pick<DsaQuestion, 'languages'>): Language[] => q.languages ?? [...CODE_LANGUAGES];

/** What a candidate sees of a SQL problem: the tables, and each SAMPLE dataset's rows and expected result. */
export interface PublicSqlProblem {
  tables: SqlTable[];
  /** true = the rows must come in the order the question asks for. */
  orderMatters: boolean;
  samples: { id: string; name: string; data: { name: string; columns: string[]; rows: SqlResult['rows'] }[]; expected: SqlResult }[];
}

/** What the candidate may see. Built by an explicit field whitelist in `toPublicQuestion`. */
export interface PublicQuestion {
  id: string;
  title: string;
  difficulty: Difficulty;
  marks: number;
  description: string;
  inputFormat: string;
  outputFormat: string;
  constraints: string[];
  samples: QuestionSample[];
  starterCode: Partial<Record<Language, string>>;
  languages: Language[];
  sampleTests: { id: string; input: string; expectedOutput: string }[];
  hiddenTestCount: number;
  /** SQL problems only. Never the reference query, hidden datasets or their results. */
  sql?: PublicSqlProblem;
}

export function toPublicQuestion(q: DsaQuestion): PublicQuestion {
  const out: PublicQuestion = {
    id: q.id,
    title: q.title,
    difficulty: q.difficulty,
    marks: q.marks,
    description: q.description,
    inputFormat: q.inputFormat,
    outputFormat: q.outputFormat,
    constraints: [...q.constraints],
    samples: q.samples.map((s) => ({ ...s })),
    starterCode: { ...q.starterCode },
    languages: languagesOf(q),
    sampleTests: q.testCases
      .filter((t) => !t.hidden)
      .map((t) => ({ id: t.id, input: t.display, expectedOutput: t.expectedOutput })),
    hiddenTestCount: q.testCases.filter((t) => t.hidden).length,
  };
  if (q.sql) {
    // sample datasets only: hidden ones contribute nothing but their count
    const visible = q.testCases.filter((t) => !t.hidden);
    out.sql = {
      tables: q.sql.tables.map((t) => ({ name: t.name, columns: t.columns.map((c) => ({ ...c })) })),
      orderMatters: q.sql.orderMatters,
      samples: visible.map((c) => ({
        id: c.id,
        name: c.display,
        data: (c.sql?.data ?? []).map((d) => ({ name: d.name, columns: [...d.columns], rows: d.rows.map((r) => [...r]) })),
        expected: { columns: [...(c.sql?.expected.columns ?? [])], rows: (c.sql?.expected.rows ?? []).map((r) => [...r]) },
      })),
    };
  }
  return out;
}
