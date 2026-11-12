import { z } from 'zod';
import type { ProctorIncidentOutcome, ProctorIncidentReview, ProctorIncidentType } from './coding-proctoring';
import { sqlSpecProblems } from './sql-bank';

/**
 * The DSA problem bank, as HR and the round engine see it: id, title, difficulty, suggested marks and a one-line
 * summary. Everything a candidate must never see (the full statement's hidden tests, expected outputs) lives only in
 * the API (apps/api/src/modules/dsa/questions); a test there keeps the two lists in step.
 *
 * A CODING question becomes a DSA problem in one of two ways, both chosen by HR in the rounds editor:
 *  - a bank problem: the marker topic `dsa:<id>` on the question;
 *  - HR's own problem: `coding` (DsaProblemSpec) on the question - title, input / output format, constraints and the
 *    test cases, stored with the question (round_questions.coding_spec). The question text is the statement.
 * A round whose questions are ALL DSA problems is a DSA round: the round engine runs it online (invitation email, timed
 * coding page, automatic result) like the aptitude test, instead of leaving it to HR.
 */

export const DSA_TOPIC_PREFIX = 'dsa:';

export const DSA_SPEC_LIMITS = {
  titleMax: 120,
  formatMax: 2000,
  testsMax: 30,
  testInputMax: 20_000,
  testOutputMax: 5_000,
} as const;

/**
 * One test case of HR's own problem: what the program reads on stdin and the output it must print (compared line by
 * line, ignoring trailing spaces and blank lines at the end). Sample tests are shown to the candidate and used by
 * "Run"; hidden tests only grade "Submit" and never leave the API.
 */
export const dsaTestCaseSchema = z.object({
  input: z.string().max(DSA_SPEC_LIMITS.testInputMax, `A test input can have at most ${DSA_SPEC_LIMITS.testInputMax} characters`),
  output: z.string().trim().min(1, 'Enter the expected output of every test').max(DSA_SPEC_LIMITS.testOutputMax),
  hidden: z.boolean().default(false),
});
export type DsaTestCase = z.output<typeof dsaTestCaseSchema>;

/**
 * HR's own DSA problem. The candidate writes a full program in Python, Java or C++ that reads the input from stdin and
 * prints the answer to stdout.
 */
export const dsaProblemSpecSchema = z.object({
  title: z.string().trim().min(1, 'Give the problem a title').max(DSA_SPEC_LIMITS.titleMax),
  inputFormat: z.string().trim().max(DSA_SPEC_LIMITS.formatMax).default(''),
  outputFormat: z.string().trim().max(DSA_SPEC_LIMITS.formatMax).default(''),
  /** One constraint per line. */
  constraints: z.string().trim().max(DSA_SPEC_LIMITS.formatMax).default(''),
  tests: z.array(dsaTestCaseSchema).max(DSA_SPEC_LIMITS.testsMax, `At most ${DSA_SPEC_LIMITS.testsMax} test cases`).default([]),
});
export type DsaProblemSpecInput = z.input<typeof dsaProblemSpecSchema>;
export type DsaProblemSpec = z.output<typeof dsaProblemSpecSchema>;

/** What HR still has to add before their problem can be graded (empty = ready). Same text in the editor and the API. */
export function dsaSpecProblems(spec: Pick<DsaProblemSpec, 'tests'>): string[] {
  const problems: string[] = [];
  if (!spec.tests.some((t) => !t.hidden)) problems.push('Add at least one sample test (shown to candidates and used by Run).');
  return problems;
}

export interface DsaBankEntry {
  id: string;
  title: string;
  difficulty: 'EASY' | 'MEDIUM' | 'HARD';
  /** Suggested marks (HR may change them per round). */
  marks: number;
  summary: string;
}

export const DSA_BANK: readonly DsaBankEntry[] = [
  {
    id: 'dsa-001',
    title: 'Two Sum',
    difficulty: 'EASY',
    marks: 10,
    summary: 'Given an array of integers and a target, return the indices of the two numbers that add up to the target.',
  },
  {
    id: 'dsa-002',
    title: 'Longest Substring Without Repeating Characters',
    difficulty: 'MEDIUM',
    marks: 20,
    summary: 'Given a string, find the length of the longest substring without repeating characters.',
  },
  {
    id: 'dsa-003',
    title: 'Median of Two Sorted Arrays',
    difficulty: 'HARD',
    marks: 30,
    summary: 'Given two sorted arrays, return the median of the two sorted arrays in O(log(m + n)).',
  },
];

export const dsaTopicFor = (bankId: string) => `${DSA_TOPIC_PREFIX}${bankId}`;

/** The bank id a question's topics point to (null = none). Only the first marker counts. */
export function dsaBankIdOf(topics: readonly string[]): string | null {
  const marker = topics.find((t) => t.startsWith(DSA_TOPIC_PREFIX));
  return marker ? marker.slice(DSA_TOPIC_PREFIX.length) : null;
}

export const dsaBankEntry = (id: string): DsaBankEntry | undefined => DSA_BANK.find((p) => p.id === id);

/** What decides whether a round question is an online coding problem. */
export interface CodingProblemRef {
  kind: string;
  topics: readonly string[];
  coding?: Pick<DsaProblemSpec, 'tests'> | null;
  sql?: { tests: readonly { hidden: boolean }[] } | null;
}

/**
 * A CODING question tied to a problem that exists in the bank, carrying HR's own complete problem, or carrying a SQL
 * problem from the SQL question bank.
 */
export function isDsaQuestion(q: CodingProblemRef): boolean {
  if (q.kind !== 'CODING') return false;
  // a SQL problem (sql-bank.ts) runs on the same coding page: one read-only query per question instead of a program
  if (q.sql) return sqlSpecProblems(q.sql).length === 0;
  if (q.coding) return dsaSpecProblems(q.coding).length === 0;
  const id = dsaBankIdOf(q.topics);
  return id !== null && dsaBankEntry(id) !== undefined;
}

/**
 * The one definition of a DSA round, shared by the round engine and the HR editor: a pass rule that is not an
 * interviewer's score, at least one question, and every question a DSA problem (bank or HR's own).
 */
export function isDsaRound(round: {
  passRule: { mode: string } | null;
  questions: readonly CodingProblemRef[];
}): boolean {
  return !!round.passRule && round.passRule.mode !== 'INTERVIEWER_SCORE' && round.questions.length > 0 && round.questions.every(isDsaQuestion);
}

/**
 * GET /api/v1/dsa-hr/applications/:applicationId/proctoring - what the browser noticed during a student's DSA coding
 * round(s), for HR's review. Observations only: they never changed the result (an exception: the attempt ends when the
 * allowed number of warnings is used up, which the status says).
 */
export interface DsaProctoringReview {
  applicationId: string;
  rounds: {
    roundId: string;
    /** DSA (programs), SQL, or both in one round. Each round has its own warning count. Missing on older records. */
    module?: 'DSA' | 'SQL' | 'MIXED' | null;
    /** Confirmed incidents that became warnings, and how many are allowed before termination. */
    warningCount?: number;
    maxWarnings?: number;
    /** The attempt was terminated by the warning limit (backend-enforced). */
    terminatedAt?: string | null;
    terminationReason?: string | null;
    cameraMonitored?: boolean;
    /** Version of the detection rules / models the record was made with. */
    detectionVersion?: string | null;
    /** Validated incidents and observations, with what the server did and HR's review. Metadata only: no images. */
    incidents?: {
      id: number;
      type: string;
      category: ProctorIncidentType;
      at: string;
      durationMs: number | null;
      confidence: number | null;
      detail: string | null;
      outcome: ProctorIncidentOutcome | null;
      warningNumber: number | null;
      /** Why it did not become a warning (technical, too short, low confidence...). */
      note: string | null;
      /** Evidence kept: metadata only (type, time, duration, confidence). No image or video is ever stored. */
      evidence: 'METADATA_ONLY';
      review: ProctorIncidentReview | null;
    }[];
    status: 'clean' | 'warning' | 'review' | 'disqualified';
    flagged: boolean;
    reasons: string[];
    totalViolations: number;
    strikesAllowed: number;
    strikesUsed: number;
    fullscreenExitCount: number;
    tabSwitchCount: number;
    copyPasteAttempts: number;
    devToolsAttempts: number;
    /** Webcam (when the company requires it). Missing from records made before webcam proctoring. */
    cameraOffCount?: number;
    noFaceCount?: number;
    multipleFacesCount?: number;
    totalTimeOutsideMs: number;
    events: { type: string; severity: string; at: string; durationMs: number | null; detail: string | null }[];
  }[];
}

// ---------------------------------------------------------------- authoring coding problems (rounds editor)

/** "Generate with AI" in a DSA coding round: new problems for the job, each with tests the API verified. */
export const codingProblemsGenerateRequestSchema = z
  .object({
    count: z.number().int().min(1).max(5).default(3),
    difficulty: z.enum(['EASY', 'MEDIUM', 'HARD']).default('MEDIUM'),
    topics: z.array(z.string().trim().min(1).max(60)).max(10).default([]),
    /** Titles already in the round (not repeated). */
    avoid: z.array(z.string().max(200)).max(100).default([]),
  })
  .strict();
export type CodingProblemsGenerateRequest = z.input<typeof codingProblemsGenerateRequestSchema>;

/** One problem ready for the rounds editor (nothing is saved until HR saves the round). */
export interface AuthoredCodingProblem {
  /** Where it came from: written by the AI, read from HR's PDF / Word file, or a row of HR's CSV file. */
  origin: 'ai' | 'document' | 'csv';
  question: {
    kind: 'CODING';
    text: string;
    marks: number;
    difficulty: 'EASY' | 'MEDIUM' | 'HARD';
    topics: string[];
    source: 'HR' | 'AI';
    coding: DsaProblemSpec;
  };
  /** What HR should know or still do (e.g. "add hidden tests"); empty = ready to use. */
  notes: string[];
}
export interface CodingProblemsResult {
  problems: AuthoredCodingProblem[];
  /** Problems that could not be used, with why (e.g. its solution did not run). */
  dropped: { title: string; reason: string }[];
}

/**
 * HR's CSV file: one problem per row. Column names are matched without regard to case, spaces or underscores. Cells
 * may hold several lines (quoted, as spreadsheets save them) or "\n" for a line break.
 */
export const CODING_CSV_COLUMNS = {
  required: ['title', 'statement', 'sample_input', 'sample_output'],
  optional: ['input_format', 'output_format', 'constraints', 'difficulty', 'marks', 'sample_input_2', 'sample_output_2'],
  /** hidden_input_1 / hidden_output_1 ... hidden_input_10 / hidden_output_10 */
  hiddenPairs: 10,
} as const;

/** A CSV template HR can download, with one filled example row. */
export function codingCsvTemplate(): string {
  const hidden = Array.from({ length: 3 }, (_, i) => [`hidden_input_${i + 1}`, `hidden_output_${i + 1}`]).flat();
  const header = ['title', 'statement', 'input_format', 'output_format', 'constraints', 'difficulty', 'marks', 'sample_input', 'sample_output', ...hidden];
  const row = [
    'Sum of an array',
    'Read n integers and print their sum.',
    'First line: n. Second line: n integers separated by spaces.',
    'One integer: the sum.',
    '1 <= n <= 100000\n-10^9 <= a[i] <= 10^9',
    'EASY',
    '10',
    '3\n1 2 3',
    '6',
    '1\n5',
    '5',
    '4\n-1 1 -2 2',
    '0',
    '2\n1000000000 1000000000',
    '2000000000',
  ];
  const cell = (s: string) => `"${s.replace(/"/g, '""')}"`;
  return [header.map(cell).join(','), row.map(cell).join(',')].join('\r\n') + '\r\n';
}

/** RFC 4180 CSV (quoted cells, "" for a quote, line breaks inside quotes; a leading BOM is ignored). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const s = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}
