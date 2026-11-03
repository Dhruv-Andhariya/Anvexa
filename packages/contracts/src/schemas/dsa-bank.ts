import { z } from 'zod';

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

/** A CODING question tied to a problem that exists in the bank, or carrying HR's own complete problem. */
export function isDsaQuestion(q: { kind: string; topics: readonly string[]; coding?: Pick<DsaProblemSpec, 'tests'> | null }): boolean {
  if (q.kind !== 'CODING') return false;
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
  questions: readonly { kind: string; topics: readonly string[]; coding?: Pick<DsaProblemSpec, 'tests'> | null }[];
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
    totalTimeOutsideMs: number;
    events: { type: string; severity: string; at: string; durationMs: number | null; detail: string | null }[];
  }[];
}
