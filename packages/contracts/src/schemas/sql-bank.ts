import { z } from 'zod';

/**
 * SQL questions (owner: apps/api/src/modules/sql). HR keeps a bank of SQL questions per company in the database
 * (sql_questions): a schema (CREATE TABLE ...), test datasets (INSERT ...) and a reference query. The API runs the
 * reference query on every dataset to get the expected result, so expected outputs are always real query results.
 *
 * A round question becomes a SQL problem when HR picks a bank question in the rounds editor: the editor stores a copy
 * of it on the question (`sql`, round_questions.sql_spec), so editing or deleting the bank question later never
 * changes a round students may already be taking. A round whose questions are all coding problems (DSA or SQL) is run
 * online by the round engine on the candidate app's coding page (timer, proctoring, automatic result), like DSA.
 *
 * Candidates write ONE read-only query (SQLite dialect). Results are compared as tables: column names, values (numbers
 * with a small tolerance), NULLs, duplicate rows; row order only when the question says it matters.
 */

export const SQL_LIMITS = {
  titleMax: 120,
  descriptionMax: 4000,
  schemaSqlMax: 20_000,
  dataSqlMax: 50_000,
  queryMax: 10_000,
  testsMax: 20,
  testNameMax: 80,
  topicsMax: 10,
  topicMax: 60,
  marksMax: 100,
  timeLimitMinMs: 500,
  timeLimitMaxMs: 10_000,
  /** Rows of each table shown to candidates for a sample dataset. */
  previewRowsMax: 50,
  /** Rows a query may return; more is an error (it protects the server and the page). */
  resultRowsMax: 1000,
} as const;

/** One value of a result: SQLite's INTEGER / REAL -> number, TEXT -> string, NULL -> null (BLOB -> hex text). */
export const sqlCellSchema = z.union([z.string(), z.number(), z.null()]);
export type SqlCell = z.infer<typeof sqlCellSchema>;

/** A query result (or a table's rows): column names in order and the rows. */
export const sqlResultSchema = z.object({
  columns: z.array(z.string()),
  rows: z.array(z.array(sqlCellSchema)),
});
export type SqlResult = z.infer<typeof sqlResultSchema>;

/** A table of the question's schema, as the candidate sees it. */
export const sqlTableSchema = z.object({
  name: z.string(),
  columns: z.array(z.object({ name: z.string(), type: z.string() })),
});
export type SqlTable = z.infer<typeof sqlTableSchema>;

const text = (max: number, message = 'Required') => z.string().trim().min(1, message).max(max, `Use at most ${max} characters`);

/** One dataset HR writes: INSERT statements run on a fresh copy of the schema. Hidden = never shown to candidates. */
export const sqlTestInputSchema = z.object({
  name: z.string().trim().max(SQL_LIMITS.testNameMax).default(''),
  dataSql: z.string().max(SQL_LIMITS.dataSqlMax, `A dataset can have at most ${SQL_LIMITS.dataSqlMax} characters`).default(''),
  hidden: z.boolean().default(false),
});
export type SqlTestInput = z.input<typeof sqlTestInputSchema>;

/** POST / PUT /api/v1/sql-hr/questions: a bank question as HR writes it. */
export const sqlQuestionInputSchema = z
  .object({
    title: text(SQL_LIMITS.titleMax, 'Give the question a title'),
    description: text(SQL_LIMITS.descriptionMax, 'Describe what the query must return'),
    difficulty: z.enum(['EASY', 'MEDIUM', 'HARD']),
    marks: z.number().int('Use a whole number').min(1, 'At least 1 mark').max(SQL_LIMITS.marksMax),
    topics: z.array(z.string().trim().min(1).max(SQL_LIMITS.topicMax)).max(SQL_LIMITS.topicsMax).default([]),
    schemaSql: text(SQL_LIMITS.schemaSqlMax, 'Write the CREATE TABLE statements'),
    /** What the editor holds at the start (empty = "SELECT *\nFROM <first table>;"). */
    starterQuery: z.string().max(SQL_LIMITS.queryMax).default(''),
    /** The correct answer. Never sent to candidates. */
    referenceQuery: text(SQL_LIMITS.queryMax, 'Write the reference (correct) query'),
    /** true = the rows must come in the reference query's order (the question asks for an ORDER BY). */
    orderMatters: z.boolean().default(false),
    /** Time one query may take on one dataset. */
    timeLimitMs: z.number().int().min(SQL_LIMITS.timeLimitMinMs).max(SQL_LIMITS.timeLimitMaxMs).default(2000),
    tests: z.array(sqlTestInputSchema).min(1, 'Add at least one dataset').max(SQL_LIMITS.testsMax, `At most ${SQL_LIMITS.testsMax} datasets`),
    active: z.boolean().default(true),
  })
  .superRefine((q, ctx) => {
    if (!q.tests.some((t) => !t.hidden)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['tests'], message: 'Add at least one sample dataset (shown to candidates and used by Run).' });
    }
  });
export type SqlQuestionInput = z.input<typeof sqlQuestionInputSchema>;
export type SqlQuestionDraft = z.output<typeof sqlQuestionInputSchema>;

/**
 * The problem as it runs: HR's text plus what the API computed by executing it (tables of the schema, each sample
 * dataset's rows, every dataset's expected result). Stored with the bank question and copied onto round questions.
 * HR and the API only: the candidate page gets a whitelisted view without hidden datasets or the reference query.
 */
export const sqlProblemSpecSchema = z.object({
  /** The bank question it was copied from (null = written for this round only). */
  bankId: z.string().nullable().default(null),
  title: text(SQL_LIMITS.titleMax),
  schemaSql: z.string().min(1).max(SQL_LIMITS.schemaSqlMax),
  starterQuery: z.string().max(SQL_LIMITS.queryMax),
  referenceQuery: z.string().min(1).max(SQL_LIMITS.queryMax),
  orderMatters: z.boolean(),
  timeLimitMs: z.number().int().min(SQL_LIMITS.timeLimitMinMs).max(SQL_LIMITS.timeLimitMaxMs),
  tables: z.array(sqlTableSchema),
  tests: z
    .array(
      z.object({
        name: z.string().max(SQL_LIMITS.testNameMax),
        dataSql: z.string().max(SQL_LIMITS.dataSqlMax),
        hidden: z.boolean(),
        /** Sample datasets only: the rows of every table (at most previewRowsMax each). [] for hidden ones. */
        data: z.array(sqlTableSchema.pick({ name: true }).extend({ columns: z.array(z.string()), rows: z.array(z.array(sqlCellSchema)) })),
        expected: sqlResultSchema,
      }),
    )
    .min(1)
    .max(SQL_LIMITS.testsMax),
});
export type SqlProblemSpec = z.output<typeof sqlProblemSpecSchema>;

/** What still stops a SQL problem from being graded (empty = ready). Same text in the editor and the API. */
export function sqlSpecProblems(spec: { tests: readonly { hidden: boolean }[] }): string[] {
  return spec.tests.some((t) => !t.hidden) ? [] : ['Add at least one sample dataset (shown to candidates and used by Run).'];
}

/** A bank question as HR sees it (GET /api/v1/sql-hr/questions/:id). */
export interface SqlBankQuestion {
  id: string;
  title: string;
  description: string;
  difficulty: 'EASY' | 'MEDIUM' | 'HARD';
  marks: number;
  topics: string[];
  active: boolean;
  /** Set on the starter questions Anvexa ships (so adding them twice does nothing). */
  seedKey: string | null;
  problem: SqlProblemSpec;
  createdAt: string;
  updatedAt: string;
}

/** GET /api/v1/sql-hr/questions: the bank, without the datasets (the list stays small). */
export interface SqlBankListItem {
  id: string;
  title: string;
  difficulty: 'EASY' | 'MEDIUM' | 'HARD';
  marks: number;
  topics: string[];
  active: boolean;
  tests: { sample: number; hidden: number };
  updatedAt: string;
}

/** POST /api/v1/sql-hr/questions/check: what HR's question produces, before saving (nothing is stored). */
export interface SqlCheckResult {
  ok: boolean;
  /** Readable problems (schema or dataset fails, the reference query fails...). Empty when ok. */
  problems: string[];
  problem: SqlProblemSpec | null;
}

/** POST /api/v1/sql-hr/questions/starter: adds the starter questions this company does not have yet. */
export interface SqlStarterImportResult {
  added: number;
  skipped: number;
}
