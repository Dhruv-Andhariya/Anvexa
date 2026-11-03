import type { CodeLanguage } from '../questions/question.types';

/**
 * The seam between the assessment logic and whatever executes candidate code.
 * Today the implementation is `PistonRunner` (a Piston instance on the hosting machine). The evaluator, scoring and
 * UI only know this interface, so the engine can be swapped by binding another class to `CODE_RUNNER`.
 */
export const CODE_RUNNER = Symbol('CODE_RUNNER');

export interface RunnerJob {
  language: CodeLanguage;
  /** The complete program (candidate code plus the harness that reads stdin and prints the result). */
  source: string;
  stdin: string;
}

export type RunnerVerdict = 'ok' | 'compile_error' | 'runtime_error' | 'time_limit' | 'internal_error';

export interface RunnerResult {
  verdict: RunnerVerdict;
  /** Short engine status, for logs, e.g. "Time limit exceeded (wall clock)". */
  statusText: string;
  stdout: string;
  stderr: string;
  compileOutput: string;
  /** CPU time in milliseconds, when the engine reports it. */
  timeMs: number | null;
  memoryKb: number | null;
}

export interface CodeRunner {
  /** Results come back in the order of `jobs`. Rejects with CodeRunnerUnavailableError or CodeRunnerBusyError. */
  runBatch(jobs: RunnerJob[]): Promise<RunnerResult[]>;
}

/** The engine cannot be reached or answered unexpectedly. Never carries the engine's URL. */
export class CodeRunnerUnavailableError extends Error {
  constructor(
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'CodeRunnerUnavailableError';
  }
}

/** Too many runs are already waiting. The candidate should simply try again in a moment. */
export class CodeRunnerBusyError extends Error {
  constructor(message = 'Many candidates are running code right now. Please try again in a few seconds.') {
    super(message);
    this.name = 'CodeRunnerBusyError';
  }
}
