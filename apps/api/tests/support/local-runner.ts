import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CodeRunner, RunnerJob, RunnerResult } from '../../src/modules/dsa/execution/code-runner';

/**
 * TEST-ONLY runner that executes programs with the toolchains installed on the developer machine.
 * It exists so the harnesses, test data and evaluator can be verified without a sandboxed runner.
 * It is NOT a sandbox and must never be used by the application. Results from it are not Piston results.
 */
const CPU_LIMIT_MS = 4000;
const PYTHON = process.env.DSA_LOCAL_PYTHON || 'python';

const result = (r: Partial<RunnerResult>): RunnerResult => ({
  verdict: 'ok',
  statusText: 'Accepted',
  stdout: '',
  stderr: '',
  compileOutput: '',
  timeMs: null,
  memoryKb: null,
  ...r,
});

function exec(cmd: string, args: string[], cwd: string, input = '', timeout = CPU_LIMIT_MS) {
  const started = Date.now();
  const p = spawnSync(cmd, args, { cwd, input, timeout, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, killSignal: 'SIGKILL' });
  return { p, ms: Date.now() - started };
}

export class LocalRunner implements CodeRunner {
  static toolchainProblems(): string[] {
    const problems: string[] = [];
    const dir = mkdtempSync(join(tmpdir(), 'dsa-probe-'));
    try {
      if (spawnSync(PYTHON, ['--version']).status !== 0) problems.push('python');
      if (spawnSync('javac', ['-version']).status !== 0) problems.push('javac');
      if (spawnSync('g++', ['--version']).status !== 0) problems.push('g++');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    return problems;
  }

  async runBatch(jobs: RunnerJob[]): Promise<RunnerResult[]> {
    const out: RunnerResult[] = [];
    // Compile once per distinct source, mirroring what a single sandboxed compile would produce for each job.
    for (const job of jobs) out.push(this.runOne(job));
    return out;
  }

  private runOne(job: RunnerJob): RunnerResult {
    const dir = mkdtempSync(join(tmpdir(), 'dsa-run-'));
    try {
      let runCmd: [string, string[]];
      if (job.language === 'python') {
        writeFileSync(join(dir, 'script.py'), job.source);
        runCmd = [PYTHON, ['script.py']];
      } else if (job.language === 'java') {
        writeFileSync(join(dir, 'Main.java'), job.source);
        const c = exec('javac', ['Main.java'], dir, '', 60_000);
        if (c.p.status !== 0) return result({ verdict: 'compile_error', statusText: 'Compilation Error', compileOutput: `${c.p.stderr}${c.p.stdout}` });
        runCmd = ['java', ['-Xmx256m', '-cp', '.', 'Main']];
      } else {
        writeFileSync(join(dir, 'main.cpp'), job.source);
        const c = exec('g++', ['-O2', '-std=c++17', 'main.cpp', '-o', 'main.exe'], dir, '', 60_000);
        if (c.p.status !== 0) return result({ verdict: 'compile_error', statusText: 'Compilation Error', compileOutput: `${c.p.stderr}${c.p.stdout}` });
        runCmd = [join(dir, 'main.exe'), []];
      }
      const { p, ms } = exec(runCmd[0], runCmd[1], dir, job.stdin);
      if (p.error && (p.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
        return result({ verdict: 'time_limit', statusText: 'Time Limit Exceeded', stdout: p.stdout ?? '', timeMs: ms });
      }
      if (p.status !== 0) {
        return result({ verdict: 'runtime_error', statusText: 'Runtime Error (NZEC)', stdout: p.stdout ?? '', stderr: p.stderr || `exit code ${p.status}`, timeMs: ms });
      }
      return result({ stdout: p.stdout ?? '', stderr: p.stderr ?? '', timeMs: ms });
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch {
        // A killed JVM can still hold the directory on Windows; the OS temp cleaner removes it later.
      }
    }
  }
}
