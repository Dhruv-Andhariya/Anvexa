import { Logger } from '@nestjs/common';
import type { CodeRunner, RunnerResult } from '../execution/code-runner';
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

/** A program's output as lines: CRLF folded, trailing spaces per line and trailing blank lines dropped. */
const outputLines = (s: string) => s.replace(/\r\n/g, '\n').split('\n').map((l) => l.trimEnd()).join('\n').replace(/\n+$/, '');

export function outputsMatch(comparator: Comparator, actual: string, expected: string): boolean {
  if (comparator === 'lines') return outputLines(actual) === outputLines(expected);
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
    const jobs = cases.map((c) => ({ language, source: program.source, stdin: c.stdin }));

    // Run the first case on its own: code that does not compile fails the same way on every case, so there is no
    // point spending one compile per test case on it (this also keeps the hosting machine's load down).
    const first = jobs.length > 0 ? await this.runner.runBatch([jobs[0]]) : [];
    const firstFailure = this.compileFailure(language, first);
    if (firstFailure) {
      return this.compileResult(firstFailure, cases, labels, program.mapLine, first[0]);
    }
    const rest = jobs.length > 1 ? await this.runner.runBatch(jobs.slice(1)) : [];
    const results = [...first, ...rest];

    // A Python syntax error is only visible once the interpreter has run, so check every result too.
    const lateFailure = this.compileFailure(language, results);
    if (lateFailure) return this.compileResult(lateFailure, cases, labels, program.mapLine, results[0]);

    const out = cases.map((c, i) => this.grade(question, c, labels[i], results[i], program.mapLine));
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

  /** The result that proves the code does not compile, or undefined. */
  private compileFailure(language: Language, results: RunnerResult[]): RunnerResult | undefined {
    return results.find((r) => r.verdict === 'compile_error') ?? this.pythonSyntaxFailure(language, results);
  }

  private compileResult(
    failure: RunnerResult,
    cases: TestCase[],
    labels: string[],
    mapLine: (n: number) => number | null,
    fallback: RunnerResult,
  ): Evaluation {
    return {
      verdict: 'compile_error',
      passed: 0,
      total: cases.length,
      compileOutput: clip(cleanDiagnostics(failure.compileOutput || failure.stderr, mapLine)),
      cases: cases.map((c, i) => this.redact(c, labels[i], 'compile_error', fallback, undefined, undefined, mapLine)),
    };
  }

  /**
   * Python has no compile step, so the runner reports a SyntaxError as a runtime error. When every run died with a
   * parse error from the real interpreter, surface it as a compile error, which is what the candidate needs to see.
   */
  private pythonSyntaxFailure(language: Language, results: RunnerResult[]): RunnerResult | undefined {
    if (language !== 'python' || results.length === 0) return undefined;
    const parseError = /^(SyntaxError|IndentationError|TabError)\b/m;
    const first = results[0];
    const allSyntax = results.every((r) => r.verdict === 'runtime_error' && parseError.test(r.stderr));
    return allSyntax ? { ...first, verdict: 'compile_error', compileOutput: first.stderr } : undefined;
  }

  private grade(question: DsaQuestion, c: TestCase, label: string, r: RunnerResult, mapLine: (n: number) => number | null): CaseResult {
    const stdio = question.harness === 'stdio';
    const { result, userOutput } = splitStdout(r.stdout, question.harness);
    let status: CaseStatus;
    if (r.verdict === 'time_limit') status = 'time_limit';
    else if (r.verdict === 'runtime_error') status = 'runtime_error';
    else if (r.verdict === 'internal_error') status = 'internal_error';
    else if (result !== null && outputsMatch(question.comparator, result, c.expectedOutput)) status = 'passed';
    else status = 'wrong_answer';
    // a whole program's stdout IS its answer: shown once (as the output), not twice
    return this.redact(c, label, status, r, result, stdio ? '' : userOutput, mapLine);
  }

  private redact(
    c: TestCase,
    label: string,
    status: CaseStatus,
    r: RunnerResult,
    result: string | null = null,
    userOutput = '',
    mapLine: (n: number) => number | null = (n) => n,
  ): CaseResult {
    if (status === 'internal_error') {
      logger.error(`Runner internal error on ${c.id}: ${r.statusText} ${r.stderr}`.trim());
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
      stderr: clip(cleanDiagnostics(r.stderr, mapLine)),
    };
  }
}
