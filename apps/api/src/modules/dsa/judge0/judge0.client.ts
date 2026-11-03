import { Injectable } from '@nestjs/common';
import type { Language } from '../questions/question.types';

/** Judge0 CE language ids (v1.13.1). Overridable with JUDGE0_LANG_PYTHON / _JAVA / _CPP. */
const DEFAULT_LANGUAGE_IDS: Record<Language, number> = { python: 71, java: 62, cpp: 54 };

export interface Judge0Options {
  baseUrl: string;
  /** Optional. Sent as `authHeader` when the instance has AUTHN_TOKEN configured. */
  authToken?: string;
  authHeader: string;
  /** Hosted Judge0 on RapidAPI: sent as X-RapidAPI-Host (with JUDGE0_AUTH_HEADER=X-RapidAPI-Key). */
  rapidApiHost?: string;
  languageIds: Record<Language, number>;
  cpuTimeLimitSec: number;
  wallTimeLimitSec: number;
  memoryLimitKb: number;
  /**
   * DEV ONLY. Asks Judge0 to use per-process limits (isolate -m / -t) instead of cgroups, for hosts without
   * cgroup v1 (e.g. Docker Desktop on WSL2). Memory is then an address-space cap, not an accounted RSS limit,
   * and CPU/memory isolation is weaker. Never enable for real candidates; see docs/dsa-integration-notes.md.
   */
  perProcessLimits: boolean;
  /** Address-space cap used for Java in per-process mode (a JVM reserves GBs of virtual memory up front). */
  javaPerProcessMemoryLimitKb: number;
  pollIntervalMs: number;
  pollTimeoutMs: number;
  requestTimeoutMs: number;
  fetch?: typeof fetch;
}

export const judge0OptionsFromEnv = (): Judge0Options => ({
  baseUrl: (process.env.JUDGE0_URL || 'http://localhost:2358').replace(/\/+$/, ''),
  authToken: process.env.JUDGE0_AUTH_TOKEN || undefined,
  authHeader: process.env.JUDGE0_AUTH_HEADER || 'X-Auth-Token',
  rapidApiHost: process.env.JUDGE0_RAPIDAPI_HOST || undefined,
  languageIds: {
    python: Number(process.env.JUDGE0_LANG_PYTHON) || DEFAULT_LANGUAGE_IDS.python,
    java: Number(process.env.JUDGE0_LANG_JAVA) || DEFAULT_LANGUAGE_IDS.java,
    cpp: Number(process.env.JUDGE0_LANG_CPP) || DEFAULT_LANGUAGE_IDS.cpp,
  },
  cpuTimeLimitSec: Number(process.env.DSA_CPU_TIME_LIMIT_SEC) || 3,
  wallTimeLimitSec: Number(process.env.DSA_WALL_TIME_LIMIT_SEC) || 10,
  memoryLimitKb: Number(process.env.DSA_MEMORY_LIMIT_KB) || 256_000,
  perProcessLimits: process.env.JUDGE0_PER_PROCESS_LIMITS === 'true',
  javaPerProcessMemoryLimitKb: Number(process.env.DSA_JAVA_PER_PROCESS_MEMORY_LIMIT_KB) || 8_000_000,
  // every poll is a request: a hosted Judge0 counts them against the plan's quota
  pollIntervalMs: Number(process.env.DSA_JUDGE0_POLL_INTERVAL_MS) || 300,
  pollTimeoutMs: Number(process.env.DSA_JUDGE0_POLL_TIMEOUT_MS) || 60_000,
  requestTimeoutMs: Number(process.env.DSA_JUDGE0_REQUEST_TIMEOUT_MS) || 30_000,
});

export interface Judge0Job {
  language: Language;
  source: string;
  stdin: string;
}

export type Judge0Verdict =
  | 'ok'
  | 'compile_error'
  | 'runtime_error'
  | 'time_limit'
  | 'internal_error';

export interface Judge0Result {
  verdict: Judge0Verdict;
  /** Judge0 status description, e.g. "Runtime Error (NZEC)". */
  statusText: string;
  stdout: string;
  stderr: string;
  compileOutput: string;
  timeMs: number | null;
  memoryKb: number | null;
}

/** Thrown when Judge0 cannot be reached or answers unexpectedly. Never carries the URL or token. */
export class Judge0UnavailableError extends Error {
  constructor(
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'Judge0UnavailableError';
  }
}

export const JUDGE0_CLIENT = Symbol('JUDGE0_CLIENT');

export interface CodeRunner {
  runBatch(jobs: Judge0Job[]): Promise<Judge0Result[]>;
}

interface RawSubmission {
  token?: string;
  status?: { id: number; description: string };
  stdout?: string | null;
  stderr?: string | null;
  compile_output?: string | null;
  message?: string | null;
  time?: string | null;
  memory?: number | null;
}

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const unb64 = (s: string | null | undefined) => (s ? Buffer.from(s, 'base64').toString('utf8') : '');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Judge0 status ids: 1 In Queue, 2 Processing, 3 Accepted, 4 Wrong Answer, 5 TLE, 6 Compilation Error,
// 7-12 Runtime errors, 13 Internal Error, 14 Exec Format Error.
const isFinished = (r: RawSubmission) => (r.status?.id ?? 1) > 2;

@Injectable()
export class Judge0Client implements CodeRunner {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: Judge0Options = judge0OptionsFromEnv()) {
    this.fetchImpl = options.fetch ?? fetch;
  }

  async runBatch(jobs: Judge0Job[]): Promise<Judge0Result[]> {
    if (jobs.length === 0) return [];
    const created = await this.request<{ token: string }[]>('POST', '/submissions/batch?base64_encoded=true', {
      submissions: jobs.map((j) => ({
        language_id: this.options.languageIds[j.language],
        source_code: b64(j.source),
        stdin: b64(j.stdin),
        cpu_time_limit: this.options.cpuTimeLimitSec,
        wall_time_limit: this.options.wallTimeLimitSec,
        memory_limit:
          this.options.perProcessLimits && j.language === 'java'
            ? this.options.javaPerProcessMemoryLimitKb
            : this.options.memoryLimitKb,
        ...(this.options.perProcessLimits
          ? { enable_per_process_and_thread_time_limit: true, enable_per_process_and_thread_memory_limit: true }
          : {}),
      })),
    });
    if (!Array.isArray(created) || created.length !== jobs.length || created.some((c) => !c?.token)) {
      throw new Judge0UnavailableError('The code runner returned an unexpected response.', 'batch-create shape');
    }
    const tokens = created.map((c) => c.token);
    const raw = await this.poll(tokens);
    return raw.map((r) => this.normalise(r));
  }

  private async poll(tokens: string[]): Promise<RawSubmission[]> {
    const deadline = Date.now() + this.options.pollTimeoutMs;
    const fields = 'token,status,stdout,stderr,compile_output,message,time,memory';
    const path = `/submissions/batch?base64_encoded=true&fields=${fields}&tokens=${tokens.join(',')}`;
    for (;;) {
      await sleep(this.options.pollIntervalMs);
      const res = await this.pollOnce(path);
      const subs = res?.submissions;
      if (!Array.isArray(subs) || subs.length !== tokens.length) {
        throw new Judge0UnavailableError('The code runner returned an unexpected response.', 'batch-poll shape');
      }
      // Preserve request order regardless of how Judge0 orders the batch.
      const byToken = new Map(subs.map((s) => [s.token, s]));
      const ordered = tokens.map((t) => byToken.get(t));
      if (ordered.every((s): s is RawSubmission => !!s && isFinished(s))) return ordered;
      if (Date.now() > deadline) {
        throw new Judge0UnavailableError('The code runner took too long to respond.', 'poll timeout');
      }
    }
  }

  /** A busy Judge0 can stall one poll; polling is read-only, so retry a few times before giving up. */
  private async pollOnce(path: string): Promise<{ submissions: RawSubmission[] }> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.request<{ submissions: RawSubmission[] }>('GET', path);
      } catch (err) {
        if (attempt >= 3 || !(err instanceof Judge0UnavailableError)) throw err;
        await sleep(attempt * 500);
      }
    }
  }

  private normalise(r: RawSubmission): Judge0Result {
    const id = r.status?.id ?? 13;
    const verdict: Judge0Verdict =
      id === 3 ? 'ok' : id === 6 ? 'compile_error' : id === 5 ? 'time_limit' : id >= 7 && id <= 12 ? 'runtime_error' : 'internal_error';
    const seconds = r.time == null ? null : Number(r.time);
    return {
      verdict,
      statusText: r.status?.description ?? 'Unknown',
      stdout: unb64(r.stdout),
      stderr: [unb64(r.stderr), id === 13 || id === 14 ? unb64(r.message) : ''].filter(Boolean).join('\n'),
      compileOutput: unb64(r.compile_output),
      timeMs: seconds == null || Number.isNaN(seconds) ? null : Math.round(seconds * 1000),
      memoryKb: r.memory ?? null,
    };
  }

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (this.options.authToken) headers[this.options.authHeader] = this.options.authToken;
    if (this.options.rapidApiHost) headers['X-RapidAPI-Host'] = this.options.rapidApiHost;
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.options.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.options.requestTimeoutMs),
      });
    } catch (err) {
      throw new Judge0UnavailableError(
        'The code runner is not reachable right now. Please try again shortly.',
        err instanceof Error ? err.message : String(err),
      );
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Judge0UnavailableError(
        res.status === 401 || res.status === 403
          ? 'The code runner rejected our credentials.'
          : 'The code runner could not process this request.',
        `HTTP ${res.status} ${text.slice(0, 300)}`,
      );
    }
    return (await res.json()) as T;
  }
}
