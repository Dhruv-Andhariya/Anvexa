import { Logger } from '@nestjs/common';
import type { CodeRunner, Judge0Result } from '../judge0/judge0.client';
import type { Comparator, DsaQuestion, Language, TestCase } from '../questions/question.types';
import { buildProgram, cleanDiagnostics, splitStdout } from './harness';

export type CaseStatus =
  | 'passed'
  | 'wrong_answer'
  | 'runtime_error'
  | 'time_limit'
  | 'compile_error'
  | 'internal_error';

/** What the client receives for one test case. Hidden cases carry NO input, expected value or output. */
export interface CaseResult {
  id: string;
  label: string;
  hidden: boolean;
  status: CaseStatus;
  timeMs: number | null;
  memoryKb: number | null;
  input?: string;
  expected?: string;
  actual?: string;
  stdout?: string;
  stderr?: string;
}

export type Verdict = 'passed' | 'failed' | 'compile_error' | 'internal_error';

export interface Evaluation {
  verdict: Verdict;
  passed: number;
  total: number;
  compileOutput: string;
  cases: CaseResult[];
}

const logger = new Logger('DsaEvaluator');
const FLOAT_TOLERANCE = 1e-5;
const MAX_TEXT = 4000;

const clip = (s: string) => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}\n... (output truncated)` : s);

export function outputsMatch(comparator: Comparator, actual: string, expected: string): boolean {
  const a = actual.trim().replace(/\r\n/g, '\n');
  const e = expected.trim().replace(/\r\n/g, '\n');
  if (comparator === 'float') {
    const x = Number(a);
    const y = Number(e);
    if (a === '' || Number.isNaN(x) || Number.isNaN(y)) return false;
    return Math.abs(x - y) <= FLOAT_TOLERANCE * Math.max(1, Math.abs(y));
  }
  return a === e;
}

function caseLabels(cases: TestCase[]): string[] {
  let samples = 0;
  let hidden = 0;
  return cases.map((c) => (c.hidden ? `Hidden test ${++hidden}` : `Sample test ${++samples}`));
}

export class Evaluator {
  constructor(private readonly runner: CodeRunner) {}

  /** Executes `code` against `cases` through the runner and compares real output. Nothing is assumed to pass. */
  async evaluate(question: DsaQuestion, language: Language, code: string, cases: TestCase[]): Promise<Evaluation> {
    const program = buildProgram(language, question.harness, code);
    const labels = caseLabels(cases);
    const results = await this.runner.runBatch(
      cases.map((c) => ({ language, source: program.source, stdin: c.stdin })),
    );

    const compileFailure = results.find((r) => r.verdict === 'compile_error') ?? this.pythonSyntaxFailure(language, results);
    if (compileFailure) {
      return {
        verdict: 'compile_error',
        passed: 0,
        total: cases.length,
        compileOutput: clip(cleanDiagnostics(compileFailure.compileOutput || compileFailure.stderr, program.lineOffset)),
        cases: cases.map((c, i) => this.redact(c, labels[i], 'compile_error', results[i])),
      };
    }

    const out = cases.map((c, i) => this.grade(question.comparator, c, labels[i], results[i], program.lineOffset));
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

  /**
   * Python has no compile step, so Judge0 reports a SyntaxError as a runtime error. When every run died with a
   * parse error from the real interpreter, surface it as a compile error, which is what the candidate needs to see.
   */
  private pythonSyntaxFailure(language: Language, results: Judge0Result[]): Judge0Result | undefined {
    if (language !== 'python' || results.length === 0) return undefined;
    const parseError = /^(SyntaxError|IndentationError|TabError)\b/m;
    const first = results[0];
    const allSyntax = results.every((r) => r.verdict === 'runtime_error' && parseError.test(r.stderr));
    return allSyntax ? { ...first, verdict: 'compile_error', compileOutput: first.stderr } : undefined;
  }

  private grade(comparator: Comparator, c: TestCase, label: string, r: Judge0Result, lineOffset: number): CaseResult {
    const { result, userOutput } = splitStdout(r.stdout);
    let status: CaseStatus;
    if (r.verdict === 'time_limit') status = 'time_limit';
    else if (r.verdict === 'runtime_error') status = 'runtime_error';
    else if (r.verdict === 'internal_error') status = 'internal_error';
    else if (result !== null && outputsMatch(comparator, result, c.expectedOutput)) status = 'passed';
    else status = 'wrong_answer';
    return this.redact(c, label, status, r, result, userOutput, lineOffset);
  }

  private redact(
    c: TestCase,
    label: string,
    status: CaseStatus,
    r: Judge0Result,
    result: string | null = null,
    userOutput = '',
    lineOffset = 0,
  ): CaseResult {
    if (status === 'internal_error') {
      logger.error(`Judge0 internal error on ${c.id}: ${r.statusText} ${r.stderr}`.trim());
      r = { ...r, stderr: 'The code runner failed to execute this test. This is not caused by your code; please try again.' };
    }
    const base: CaseResult = {
      id: c.id,
      label,
      hidden: c.hidden,
      status,
      timeMs: r.timeMs,
      memoryKb: r.memoryKb,
    };
    if (c.hidden || status === 'compile_error') return base; // hidden details never leave the backend
    return {
      ...base,
      input: c.display,
      expected: c.expectedOutput,
      actual: result ?? '',
      stdout: clip(userOutput),
      stderr: clip(cleanDiagnostics(r.stderr, lineOffset)),
    };
  }
}
