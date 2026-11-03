import { Injectable } from '@nestjs/common';
import type { Language } from '../questions/question.types';
import {
  CodeRunnerUnavailableError,
  type CodeRunner,
  type RunnerJob,
  type RunnerResult,
} from './code-runner';
import { ConcurrencyLimiter } from './limiter';

/**
 * Runs candidate code on a Piston instance (https://github.com/engineer-man/piston) on the hosting machine.
 * Piston has no authentication: it must only be reachable from this backend (bound to 127.0.0.1, see
 * docs/dsa-piston-hosting.md). Its URL never reaches the browser.
 */

const MB = 1024 * 1024;

export interface LanguageLimits {
  /** Wall-clock limit for the run, ms. */
  runTimeoutMs: number;
  runCpuMs: number;
  runMemoryBytes: number;
  compileTimeoutMs: number;
  compileCpuMs: number;
  compileMemoryBytes: number;
}

export interface PistonOptions {
  baseUrl: string;
  /** Executions running at the same time, across ALL candidates. Keep at or below Piston's own job cap. */
  concurrency: number;
  /** How many of one submission's test cases run at the same time (the rest wait their turn). */
  perSubmission: number;
  queueTimeoutMs: number;
  maxQueue: number;
  requestTimeoutMs: number;
  limits: Record<Language, LanguageLimits>;
  fetch?: typeof fetch;
}

const num = (v: string | undefined, fallback: number) => {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) && n > 0 ? n : fallback;
};

export const pistonOptionsFromEnv = (env: NodeJS.ProcessEnv = process.env): PistonOptions => {
  const runTimeout = num(env.DSA_RUN_TIMEOUT_MS, 5000);
  const runCpu = num(env.DSA_RUN_CPU_MS, 4000);
  const runMem = num(env.DSA_RUN_MEMORY_MB, 256) * MB;
  const compileTimeout = num(env.DSA_COMPILE_TIMEOUT_MS, 10_000);
  const compileMem = num(env.DSA_COMPILE_MEMORY_MB, 512) * MB;
  const base: LanguageLimits = {
    runTimeoutMs: runTimeout,
    runCpuMs: runCpu,
    runMemoryBytes: runMem,
    compileTimeoutMs: compileTimeout,
    compileCpuMs: compileTimeout,
    compileMemoryBytes: compileMem,
  };
  return {
    baseUrl: (env.PISTON_URL || 'http://127.0.0.1:2000').replace(/\/+$/, ''),
    concurrency: Math.floor(num(env.DSA_RUNNER_CONCURRENCY, 3)),
    perSubmission: Math.floor(num(env.DSA_RUNNER_PER_SUBMISSION, 2)),
    queueTimeoutMs: num(env.DSA_RUNNER_QUEUE_TIMEOUT_MS, 60_000),
    maxQueue: Math.floor(num(env.DSA_RUNNER_MAX_QUEUE, 60)),
    requestTimeoutMs: num(env.DSA_RUNNER_REQUEST_TIMEOUT_MS, 60_000),
    limits: {
      python: base,
      cpp: base,
      // Piston runs Java in source-file mode: javac and the program share one run, so its limits cover both.
      java: {
        ...base,
        runTimeoutMs: num(env.DSA_JAVA_RUN_TIMEOUT_MS, 8000),
        runCpuMs: num(env.DSA_JAVA_RUN_CPU_MS, 7000),
        runMemoryBytes: num(env.DSA_JAVA_RUN_MEMORY_MB, 512) * MB,
      },
    },
  };
};

const SPEC: Record<Language, { language: string; file: string }> = {
  python: { language: 'python', file: 'main.py' },
  java: { language: 'java', file: 'Main.java' },
  cpp: { language: 'c++', file: 'main.cpp' },
};

interface PistonStage {
  stdout?: string;
  stderr?: string;
  output?: string;
  code?: number | null;
  signal?: string | null;
  message?: string | null;
  status?: string | null;
  cpu_time?: number | null;
  wall_time?: number | null;
  memory?: number | null;
}
interface PistonResponse {
  compile?: PistonStage;
  run?: PistonStage;
}

const failure = (verdict: RunnerResult['verdict'], statusText: string, extra: Partial<RunnerResult> = {}): RunnerResult => ({
  verdict,
  statusText,
  stdout: '',
  stderr: '',
  compileOutput: '',
  timeMs: null,
  memoryKb: null,
  ...extra,
});

/** Piston prints this after a failed compile (a leftover of its gcc script); it only confuses candidates. */
const stripNoise = (s: string) =>
  s
    .split('\n')
    .filter((l) => !/^chmod: cannot access 'a\.out'/.test(l))
    .join('\n');

/** Turns Piston's answer into a RunnerResult. Pure, so it is unit-tested without a Piston instance. */
export function mapPistonResponse(language: Language, r: PistonResponse, limits: LanguageLimits): RunnerResult {
  const compile = r.compile;
  const run = r.run;
  if (compile && compile.code !== 0 && compile.code !== undefined && compile.status !== 'TO') {
    return failure('compile_error', 'Compilation failed', {
      compileOutput: stripNoise(compile.output ?? compile.stderr ?? ''),
      timeMs: compile.cpu_time ?? null,
    });
  }
  if (compile?.status === 'TO') return failure('compile_error', 'Compilation time limit exceeded', { compileOutput: 'Compilation time limit exceeded.' });
  if (!run) return failure('internal_error', 'No run stage in the runner response');

  const stats = {
    timeMs: run.cpu_time ?? null,
    memoryKb: run.memory == null ? null : Math.round(run.memory / 1024),
  };
  const stdout = run.stdout ?? '';
  const stderr = run.stderr ?? '';

  if (run.status === 'TO') return failure('time_limit', run.message ?? 'Time limit exceeded', { stdout, stderr, ...stats });
  if (run.status === 'XX') return failure('internal_error', run.message ?? 'Internal error in the runner', { stderr: run.message ?? '', ...stats });

  // Java compiles inside the run (source-file mode): a compile failure shows up as this message.
  if (language === 'java' && /error: compilation failed/.test(stderr)) {
    return failure('compile_error', 'Compilation failed', { compileOutput: stderr, ...stats });
  }
  // Killed because the memory cap was reached (exit 137 with memory at the cap).
  if (run.code === 137 && run.memory != null && run.memory >= limits.runMemoryBytes * 0.9) {
    return failure('runtime_error', 'Memory limit exceeded', {
      stdout,
      stderr: `Memory limit exceeded (${Math.round(limits.runMemoryBytes / MB)} MB).`,
      ...stats,
    });
  }
  if (run.signal || (run.code !== undefined && run.code !== null && run.code !== 0) || run.status) {
    const why = run.signal ? `Killed by signal ${run.signal}` : (run.message ?? 'Runtime error');
    return failure('runtime_error', why, { stdout, stderr: stderr || `${why}.`, ...stats });
  }
  return { verdict: 'ok', statusText: 'OK', stdout, stderr, compileOutput: '', ...stats };
}

@Injectable()
export class PistonRunner implements CodeRunner {
  private readonly fetchImpl: typeof fetch;
  private readonly limiter: ConcurrencyLimiter;

  constructor(private readonly options: PistonOptions = pistonOptionsFromEnv()) {
    this.fetchImpl = options.fetch ?? fetch;
    this.limiter = new ConcurrencyLimiter(options.concurrency, options.maxQueue, options.queueTimeoutMs);
  }

  /** For health checks and tests: how busy the runner is. */
  get load() {
    return this.limiter.stats;
  }

  async runBatch(jobs: RunnerJob[]): Promise<RunnerResult[]> {
    const results: RunnerResult[] = new Array(jobs.length);
    let next = 0;
    let failed: unknown = null;
    // Only a few of one submission's cases run at a time, and every execution also passes the global limiter,
    // so one candidate cannot take the whole machine.
    const worker = async () => {
      for (;;) {
        if (failed) return;
        const i = next++;
        if (i >= jobs.length) return;
        try {
          results[i] = await this.limiter.run(() => this.execute(jobs[i]));
        } catch (err) {
          failed = err;
          return;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.options.perSubmission, jobs.length) }, worker));
    if (failed) throw failed;
    return results;
  }

  private async execute(job: RunnerJob): Promise<RunnerResult> {
    const spec = SPEC[job.language];
    const lim = this.options.limits[job.language];
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.options.baseUrl}/api/v2/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          language: spec.language,
          version: '*',
          files: [{ name: spec.file, content: job.source }],
          stdin: job.stdin,
          run_timeout: lim.runTimeoutMs,
          run_cpu_time: lim.runCpuMs,
          run_memory_limit: lim.runMemoryBytes,
          compile_timeout: lim.compileTimeoutMs,
          compile_cpu_time: lim.compileCpuMs,
          compile_memory_limit: lim.compileMemoryBytes,
        }),
        signal: AbortSignal.timeout(this.options.requestTimeoutMs),
      });
    } catch (err) {
      throw new CodeRunnerUnavailableError(
        'The code runner is not reachable right now. Please try again shortly.',
        err instanceof Error ? err.message : String(err),
      );
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new CodeRunnerUnavailableError('The code runner could not process this request.', `HTTP ${res.status} ${text.slice(0, 300)}`);
    }
    let body: PistonResponse;
    try {
      body = (await res.json()) as PistonResponse;
    } catch {
      throw new CodeRunnerUnavailableError('The code runner returned an unexpected response.', 'invalid JSON');
    }
    return mapPistonResponse(job.language, body, lim);
  }
}
