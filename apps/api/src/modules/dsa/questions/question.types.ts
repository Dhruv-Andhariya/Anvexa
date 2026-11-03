export const LANGUAGES = ['python', 'java', 'cpp'] as const;
export type Language = (typeof LANGUAGES)[number];

export type Difficulty = 'Easy' | 'Medium' | 'Hard';

/**
 * How the evaluator compares the answer: `exact` / `float` for a harness' single result line, `lines` for a whole
 * program's stdout (line by line, trailing spaces and trailing blank lines ignored).
 */
export type Comparator = 'exact' | 'float' | 'lines';

/**
 * Which harness template wraps the candidate's function. One per bank problem shape; `stdio` = HR's own problems,
 * where the candidate writes the whole program (reads stdin, prints the answer) and nothing is wrapped around it.
 */
export type HarnessKind = 'two-sum' | 'longest-substring' | 'median-sorted-arrays' | 'stdio';

export interface TestCase {
  id: string;
  /** Human readable input, only ever shown for public (sample) cases. */
  display: string;
  /** Machine input piped to the program on stdin. Never leaves the backend for hidden cases. */
  stdin: string;
  expectedOutput: string;
  /** Public cases are shown to the candidate and used by "Run". Hidden cases are backend only. */
  hidden: boolean;
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
  starterCode: Record<Language, string>;
  harness: HarnessKind;
  comparator: Comparator;
  testCases: TestCase[];
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
  starterCode: Record<Language, string>;
  sampleTests: { id: string; input: string; expectedOutput: string }[];
  hiddenTestCount: number;
}

export function toPublicQuestion(q: DsaQuestion): PublicQuestion {
  return {
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
    sampleTests: q.testCases
      .filter((t) => !t.hidden)
      .map((t) => ({ id: t.id, input: t.display, expectedOutput: t.expectedOutput })),
    hiddenTestCount: q.testCases.filter((t) => t.hidden).length,
  };
}
