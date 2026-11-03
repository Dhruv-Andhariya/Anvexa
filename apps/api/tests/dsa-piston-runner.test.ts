import { describe, expect, it } from 'vitest';
import { CodeRunnerBusyError, CodeRunnerUnavailableError, type RunnerJob } from '../src/modules/dsa/execution/code-runner';
import { ConcurrencyLimiter } from '../src/modules/dsa/execution/limiter';
import { PistonRunner, mapPistonResponse, pistonOptionsFromEnv, type PistonOptions } from '../src/modules/dsa/execution/piston.runner';

const MB = 1024 * 1024;
const limits = pistonOptionsFromEnv({}).limits;
const stage = (over: Record<string, unknown> = {}) => ({
  stdout: '', stderr: '', output: '', code: 0, signal: null, message: null, status: null, cpu_time: 10, wall_time: 20, memory: 5_000_000, ...over,
});

describe('mapPistonResponse (Piston answers, copied from a real Piston 3 instance)', () => {
  it('a normal run', () => {
    const r = mapPistonResponse('python', { run: stage({ stdout: '5\n', cpu_time: 79, memory: 19_080_000 }) }, limits.python);
    expect(r).toMatchObject({ verdict: 'ok', stdout: '5\n', timeMs: 79 });
    expect(r.memoryKb).toBe(Math.round(19_080_000 / 1024));
  });

  it('C++ compile error comes from the compile stage; the leftover gcc-script noise is removed', () => {
    const err = "main.cpp.cpp: In function 'int main()':\nmain.cpp.cpp:1:21: error: expected ';'\nchmod: cannot access 'a.out': No such file or directory\n";
    const r = mapPistonResponse('cpp', { compile: stage({ code: 1, output: err, stderr: err, status: 'RE' }), run: stage({ code: 1, stderr: err }) }, limits.cpp);
    expect(r.verdict).toBe('compile_error');
    expect(r.compileOutput).toContain('expected');
    expect(r.compileOutput).not.toContain('chmod');
  });

  it('Java compiles inside the run, so its compile error is recognised from the message', () => {
    const stderr = 'Main.java.java:1: error: illegal start of expression\n1 error\nerror: compilation failed\n';
    expect(mapPistonResponse('java', { run: stage({ code: 1, stderr, status: 'RE' }) }, limits.java)).toMatchObject({ verdict: 'compile_error' });
  });

  it('a Java exception is a runtime error, not a compile error', () => {
    const stderr = 'Exception in thread "main" java.lang.RuntimeException: boom\n\tat Main.main(Main.java.java:1)\n';
    expect(mapPistonResponse('java', { run: stage({ code: 1, stderr, status: 'RE' }) }, limits.java)).toMatchObject({ verdict: 'runtime_error' });
  });

  it('a timeout is a time limit', () => {
    const r = mapPistonResponse('python', { run: stage({ code: null, signal: 'SIGKILL', status: 'TO', message: 'Time limit exceeded (wall clock)', cpu_time: 2079 }) }, limits.python);
    expect(r).toMatchObject({ verdict: 'time_limit', timeMs: 2079 });
  });

  it('a compile that times out is a compile error with a clear message', () => {
    expect(mapPistonResponse('cpp', { compile: stage({ code: null, status: 'TO' }), run: stage() }, limits.cpp)).toMatchObject({
      verdict: 'compile_error',
      compileOutput: 'Compilation time limit exceeded.',
    });
  });

  it('exit 137 with memory at the cap is a memory-limit runtime error with a readable message', () => {
    const r = mapPistonResponse('python', { run: stage({ code: 137, status: 'RE', memory: 268_432_000, stderr: 'Killed' }) }, limits.python);
    expect(r).toMatchObject({ verdict: 'runtime_error', statusText: 'Memory limit exceeded' });
    expect(r.stderr).toBe('Memory limit exceeded (256 MB).');
  });

  it('exit 137 with little memory used is not blamed on memory', () => {
    const r = mapPistonResponse('python', { run: stage({ code: 137, status: 'RE', memory: 5_000_000, stderr: 'Killed' }) }, limits.python);
    expect(r.statusText).not.toBe('Memory limit exceeded');
  });

  it('a crash and a Python exception are runtime errors with their stderr', () => {
    expect(mapPistonResponse('cpp', { compile: stage(), run: stage({ code: 139, stderr: 'Segmentation fault' }) }, limits.cpp)).toMatchObject({ verdict: 'runtime_error', stderr: 'Segmentation fault' });
    expect(mapPistonResponse('python', { run: stage({ code: 1, stderr: 'ZeroDivisionError', status: 'RE' }) }, limits.python).stderr).toBe('ZeroDivisionError');
  });

  it('killed by a signal without a timeout (e.g. output limit) is a runtime error', () => {
    expect(mapPistonResponse('python', { run: stage({ code: null, signal: 'SIGKILL', status: 'SG', message: 'Killed' }) }, limits.python)).toMatchObject({ verdict: 'runtime_error' });
  });

  it('an internal error in the runner is reported as such, with no success', () => {
    expect(mapPistonResponse('python', { run: stage({ status: 'XX', message: 'sandbox failed' }) }, limits.python)).toMatchObject({ verdict: 'internal_error' });
    expect(mapPistonResponse('python', {}, limits.python)).toMatchObject({ verdict: 'internal_error' });
  });
});

describe('ConcurrencyLimiter', () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('never runs more than the limit at once, and serves the queue in order', async () => {
    const limiter = new ConcurrencyLimiter(2, 50, 5000);
    let active = 0;
    let peak = 0;
    const order: number[] = [];
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        limiter.run(async () => {
          active += 1;
          peak = Math.max(peak, active);
          order.push(i);
          await sleep(15);
          active -= 1;
        }),
      ),
    );
    expect(peak).toBe(2);
    expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(limiter.stats).toEqual({ active: 0, queued: 0, max: 2 });
  });

  it('refuses work when the queue is full, and when a run waits too long', async () => {
    const full = new ConcurrencyLimiter(1, 1, 5000);
    const hold = full.run(() => sleep(60)); // takes the slot
    const queued = full.run(async () => 'queued ok'); // fills the queue
    await expect(full.run(async () => 'x')).rejects.toBeInstanceOf(CodeRunnerBusyError);
    await hold;
    expect(await queued).toBe('queued ok');

    const slow = new ConcurrencyLimiter(1, 10, 20);
    const blocker = slow.run(() => sleep(120));
    await expect(slow.run(async () => 'x')).rejects.toBeInstanceOf(CodeRunnerBusyError);
    await blocker;
    expect(slow.stats.queued).toBe(0); // the timed-out waiter left the queue
  });

  it('a failing run still frees its slot', async () => {
    const limiter = new ConcurrencyLimiter(1, 5, 1000);
    await expect(limiter.run(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(await limiter.run(async () => 'next')).toBe('next');
  });
});

describe('PistonRunner', () => {
  const options = (fetchImpl: typeof fetch, over: Partial<PistonOptions> = {}): PistonOptions => ({
    ...pistonOptionsFromEnv({}),
    baseUrl: 'http://piston.internal:2000',
    fetch: fetchImpl,
    ...over,
  });
  const ok = (stdout = '5\n') => new Response(JSON.stringify({ run: stage({ stdout }) }));
  const job = (language: RunnerJob['language'] = 'python', stdin = '2 3\n'): RunnerJob => ({ language, source: 'print(1)', stdin });

  it('sends the program, stdin and per-language limits, and never sends credentials', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return ok();
    }) as unknown as typeof fetch;
    const runner = new PistonRunner(options(fetchImpl));
    const results = await runner.runBatch([job('python'), job('java'), job('cpp')]);
    expect(results.map((r) => r.verdict)).toEqual(['ok', 'ok', 'ok']);
    const bodies = calls.map((c) => JSON.parse(c.init.body as string));
    expect(calls.every((c) => c.url === 'http://piston.internal:2000/api/v2/execute')).toBe(true);
    expect(bodies.map((b) => [b.language, b.files[0].name])).toEqual([['python', 'main.py'], ['java', 'Main.java'], ['c++', 'main.cpp']]);
    expect(bodies[0]).toMatchObject({ version: '*', stdin: '2 3\n', run_memory_limit: 256 * MB, compile_memory_limit: 512 * MB });
    expect(bodies[1].run_memory_limit).toBe(512 * MB); // Java gets more: the JVM and javac share one run
    expect(bodies[1].run_timeout).toBeGreaterThan(bodies[0].run_timeout);
    for (const c of calls) expect(JSON.stringify(c.init.headers)).not.toMatch(/auth|token|key/i);
  });

  it('returns results in the order of the jobs', async () => {
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      const stdin = JSON.parse(init.body as string).stdin as string;
      await new Promise((r) => setTimeout(r, stdin === 'slow\n' ? 40 : 1));
      return ok(`out:${stdin.trim()}\n`);
    }) as unknown as typeof fetch;
    const runner = new PistonRunner(options(fetchImpl, { perSubmission: 3 }));
    const res = await runner.runBatch([job('python', 'slow\n'), job('python', 'a\n'), job('python', 'b\n')]);
    expect(res.map((r) => r.stdout.trim())).toEqual(['out:slow', 'out:a', 'out:b']);
  });

  it('caps parallelism per submission AND across all candidates', async () => {
    let active = 0;
    let peak = 0;
    const fetchImpl = (async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 15));
      active -= 1;
      return ok();
    }) as unknown as typeof fetch;

    const one = new PistonRunner(options(fetchImpl, { concurrency: 10, perSubmission: 2 }));
    await one.runBatch(Array.from({ length: 8 }, () => job()));
    expect(peak).toBe(2); // one submission never uses more than its share

    peak = 0;
    const shared = new PistonRunner(options(fetchImpl, { concurrency: 3, perSubmission: 2 }));
    await Promise.all(Array.from({ length: 6 }, () => shared.runBatch(Array.from({ length: 4 }, () => job())))); // 6 candidates at once
    expect(peak).toBe(3); // the machine-wide cap holds no matter how many candidates submit together
    expect(shared.load).toEqual({ active: 0, queued: 0, max: 3 });
  });

  it('stops starting new cases once one fails', async () => {
    let started = 0;
    const fetchImpl = (async () => {
      started += 1;
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const runner = new PistonRunner(options(fetchImpl, { perSubmission: 1 }));
    await expect(runner.runBatch(Array.from({ length: 8 }, () => job()))).rejects.toBeInstanceOf(CodeRunnerUnavailableError);
    expect(started).toBe(1);
  });

  it('reports an unreachable or failing Piston without leaking its address', async () => {
    const refused = (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
    const err = await new PistonRunner(options(refused)).runBatch([job()]).catch((e) => e);
    expect(err).toBeInstanceOf(CodeRunnerUnavailableError);
    expect(err.message).not.toMatch(/piston\.internal|2000/);

    const http500 = (async () => new Response('{"message":"boom"}', { status: 500 })) as unknown as typeof fetch;
    const err2 = await new PistonRunner(options(http500)).runBatch([job()]).catch((e) => e);
    expect(err2).toBeInstanceOf(CodeRunnerUnavailableError);
    expect(err2.message).not.toMatch(/piston\.internal|2000/);
    expect(err2.detail).toContain('HTTP 500');

    const notJson = (async () => new Response('<html>')) as unknown as typeof fetch;
    expect(await new PistonRunner(options(notJson)).runBatch([job()]).catch((e) => e)).toBeInstanceOf(CodeRunnerUnavailableError);
  });

  it('refuses with "busy" when more runs are waiting than the queue allows', async () => {
    const fetchImpl = (async () => { await new Promise((r) => setTimeout(r, 60)); return ok(); }) as unknown as typeof fetch;
    const runner = new PistonRunner(options(fetchImpl, { concurrency: 1, perSubmission: 1, maxQueue: 1 }));
    const results = await Promise.allSettled([1, 2, 3, 4].map(() => runner.runBatch([job()])));
    expect(results.filter((r) => r.status === 'fulfilled').length).toBe(2); // one running + one queued
    expect(results.filter((r) => r.status === 'rejected' && r.reason instanceof CodeRunnerBusyError).length).toBe(2);
  });

  it('reads its settings from the environment, with safe defaults', () => {
    const d = pistonOptionsFromEnv({});
    expect(d).toMatchObject({ baseUrl: 'http://127.0.0.1:2000', concurrency: 3, perSubmission: 2 });
    const custom = pistonOptionsFromEnv({ PISTON_URL: 'http://10.0.0.5:2000/', DSA_RUNNER_CONCURRENCY: '5', DSA_RUN_MEMORY_MB: '128' });
    expect(custom).toMatchObject({ baseUrl: 'http://10.0.0.5:2000', concurrency: 5 });
    expect(custom.limits.python.runMemoryBytes).toBe(128 * MB);
    expect(pistonOptionsFromEnv({ DSA_RUNNER_CONCURRENCY: 'nonsense' }).concurrency).toBe(3);
  });
});
