import { spawn } from 'node:child_process';
import { SQL_LIMITS, type SqlCell, type SqlResult, type SqlTable } from '@hireflow/contracts';
import { CodeRunnerUnavailableError } from '../../dsa/execution/code-runner';
import { ConcurrencyLimiter } from '../../dsa/execution/limiter';
import { singleStatementProblem } from './statements';
import { SQL_WORKER_SOURCE } from './worker-source';

export const SQL_SANDBOX = Symbol('SQL_SANDBOX');

/** How one query did on one dataset. */
export type SqlOutcome =
  | { ok: true; result: SqlResult; timeMs: number }
  | {
      ok: false;
      /** setup = HR's schema / dataset failed; syntax = the query does not compile; error = it failed while running. */
      kind: 'setup' | 'syntax' | 'error' | 'too_many_rows' | 'time_limit';
      message: string;
      timeMs: number | null;
    };

/** A table of a dataset as HR's question set it up (inspect mode). */
export type SqlTableData = SqlTable & { rows: SqlCell[][] };

export type SqlInspectOutcome = SqlOutcome & { tables: SqlTableData[] };

export interface SqlSandboxOptions {
  /** Queries (processes) running at once on the machine; the rest wait in line. */
  concurrency: number;
  maxQueue: number;
  queueTimeoutMs: number;
  /** SQLite memory cap per process. */
  heapBytes: number;
  /** Time to start a process (on top of the first dataset's limit). */
  startupMs: number;
}

const num = (raw: string | undefined, fallback: number) => (Number(raw) > 0 ? Number(raw) : fallback);

export const sqlSandboxOptionsFromEnv = (env: NodeJS.ProcessEnv = process.env): SqlSandboxOptions => ({
  concurrency: num(env.SQL_RUNNER_CONCURRENCY, 4),
  maxQueue: num(env.SQL_RUNNER_MAX_QUEUE, 100),
  queueTimeoutMs: num(env.SQL_RUNNER_QUEUE_TIMEOUT_MS, 60_000),
  heapBytes: num(env.SQL_RUNNER_HEAP_MB, 64) * 1024 * 1024,
  startupMs: num(env.SQL_RUNNER_STARTUP_MS, 5000),
});

const READ_ONLY_HINT = 'Only reading queries are allowed (SELECT / WITH): the data cannot be changed, so INSERT, UPDATE, DELETE, CREATE, DROP, ALTER, ATTACH and PRAGMA are not available.';

/** SQLite's message, made readable for a candidate. */
export function readableSqlError(raw: string): string {
  const text = raw.replace(/^Error:\s*/, '').trim();
  if (/not authorized|readonly database|read-only/i.test(text)) return READ_ONLY_HINT;
  if (/out of memory/i.test(text)) return 'The query used too much memory.';
  return text;
}

interface WorkerLine {
  i: number;
  ok: boolean;
  stage?: 'setup' | 'prepare' | 'run';
  error?: string;
  tooManyRows?: boolean;
  columns?: string[];
  rows?: SqlCell[][];
  tables?: SqlTableData[];
}

interface WorkerJob {
  mode: 'query' | 'inspect';
  schemaSql: string;
  query: string;
  datasets: { dataSql: string; preview?: boolean }[];
  timeLimitMs: number;
}

/**
 * Runs SQL in a sandbox: a separate Node process per run with an in-memory SQLite database per dataset, read-only for
 * the query (see worker-source.ts). A dataset that takes longer than its limit gets the process killed; the datasets
 * after it are not run (a query that times out on one dataset would almost always time out on the others too).
 * Never connects to the application's database, and the process gets no environment (no secrets).
 */
export class SqlSandbox {
  private readonly limiter: ConcurrencyLimiter;

  constructor(private readonly options: SqlSandboxOptions = sqlSandboxOptionsFromEnv()) {
    this.limiter = new ConcurrencyLimiter(options.concurrency, options.maxQueue, options.queueTimeoutMs);
  }

  get load() {
    return this.limiter.stats;
  }

  /** The candidate's (or HR's) query on each dataset. */
  async query(input: { schemaSql: string; datasets: string[]; query: string; timeLimitMs: number }): Promise<SqlOutcome[]> {
    const problem = singleStatementProblem(input.query);
    if (problem) return input.datasets.map(() => ({ ok: false, kind: 'syntax', message: problem, timeMs: null }));
    const lines = await this.limiter.run(() =>
      this.spawn({ mode: 'query', schemaSql: input.schemaSql, query: input.query, datasets: input.datasets.map((dataSql) => ({ dataSql })), timeLimitMs: input.timeLimitMs }),
    );
    return lines.map((l) => this.outcome(l.line, l.timeMs, input.timeLimitMs));
  }

  /** HR's question: the tables of each dataset (rows for the sample ones) and the reference query's result. */
  async inspect(input: { schemaSql: string; datasets: { dataSql: string; preview: boolean }[]; query: string; timeLimitMs: number }): Promise<SqlInspectOutcome[]> {
    const problem = singleStatementProblem(input.query);
    if (problem) return input.datasets.map(() => ({ ok: false, kind: 'syntax', message: problem, timeMs: null, tables: [] }));
    const lines = await this.limiter.run(() =>
      this.spawn({ mode: 'inspect', schemaSql: input.schemaSql, query: input.query, datasets: input.datasets, timeLimitMs: input.timeLimitMs }),
    );
    return lines.map((l) => ({ ...this.outcome(l.line, l.timeMs, input.timeLimitMs), tables: l.line?.tables ?? [] }));
  }

  private outcome(line: WorkerLine | null, timeMs: number | null, limitMs: number): SqlOutcome {
    if (!line) return { ok: false, kind: 'time_limit', message: `The query did not finish within ${limitMs / 1000} s.`, timeMs };
    if (line.ok) return { ok: true, result: { columns: line.columns ?? [], rows: line.rows ?? [] }, timeMs: timeMs ?? 0 };
    if (line.tooManyRows) {
      return { ok: false, kind: 'too_many_rows', message: `The query returned more than ${SQL_LIMITS.resultRowsMax} rows. Check your JOIN and WHERE conditions.`, timeMs };
    }
    const kind = line.stage === 'setup' ? 'setup' : line.stage === 'prepare' ? 'syntax' : 'error';
    return { ok: false, kind, message: kind === 'setup' ? (line.error ?? 'setup failed') : readableSqlError(line.error ?? 'error'), timeMs };
  }

  /** One process for the job; returns a line (null = not finished in time) and its time for every dataset. */
  private spawn(job: WorkerJob): Promise<{ line: WorkerLine | null; timeMs: number | null }[]> {
    return new Promise((resolve, reject) => {
      const results: { line: WorkerLine | null; timeMs: number | null }[] = [];
      const child = spawn(process.execPath, ['--no-warnings', '--max-old-space-size=128', '-e', SQL_WORKER_SOURCE], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        // nothing from the API's environment (database URL, keys...) reaches the process
        env: process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows' } : {},
      });
      let buffer = '';
      let stderr = '';
      let settled = false;
      let started = Date.now();
      let timer: NodeJS.Timeout;
      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) return reject(err);
        while (results.length < job.datasets.length) results.push({ line: null, timeMs: null });
        resolve(results);
      };
      const arm = (ms: number) => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          // this dataset ran out of time: kill the process; it and every dataset after it count as "time limit"
          results.push({ line: null, timeMs: job.timeLimitMs });
          child.kill('SIGKILL');
          finish();
        }, ms);
      };
      arm(this.options.startupMs + job.timeLimitMs);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        buffer += chunk;
        let nl = buffer.indexOf('\n');
        while (nl !== -1) {
          const raw = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          nl = buffer.indexOf('\n');
          if (!raw.trim()) continue;
          try {
            results.push({ line: JSON.parse(raw) as WorkerLine, timeMs: Date.now() - started });
          } catch {
            child.kill('SIGKILL');
            return finish(new CodeRunnerUnavailableError('The SQL runner failed. Please try again.', `bad worker output: ${raw.slice(0, 200)}`));
          }
          started = Date.now();
          if (results.length < job.datasets.length) arm(job.timeLimitMs);
        }
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => (stderr = (stderr + chunk).slice(-2000)));
      child.on('error', (err) => finish(new CodeRunnerUnavailableError('The SQL runner could not start. Please try again.', err.message)));
      child.on('close', (code) => {
        if (settled) return;
        if (results.length < job.datasets.length && code !== 0) {
          // the process died mid-way (e.g. memory): what finished counts, the rest failed with the reason
          const reason = /heap|memory/i.test(stderr) ? 'The query used too much memory.' : `The SQL runner stopped unexpectedly (${stderr.trim().split('\n').pop() ?? code}).`;
          while (results.length < job.datasets.length) results.push({ line: { i: results.length, ok: false, stage: 'run', error: reason }, timeMs: null });
        }
        finish();
      });
      child.stdin.on('error', () => undefined); // a killed child closes stdin early; the close handler reports it
      child.stdin.end(JSON.stringify({ ...job, maxRows: SQL_LIMITS.resultRowsMax, previewRows: SQL_LIMITS.previewRowsMax, heapBytes: this.options.heapBytes }));
    });
  }
}
