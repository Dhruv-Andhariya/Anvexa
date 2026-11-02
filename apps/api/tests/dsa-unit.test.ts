import { describe, expect, it } from 'vitest';
import { parseCodeRequest } from '../src/modules/dsa/dsa.dto';
import { DsaService } from '../src/modules/dsa/dsa.service';
import { outputsMatch } from '../src/modules/dsa/evaluation/evaluator';
import { RESULT_MARKER, buildProgram, cleanDiagnostics, splitStdout } from '../src/modules/dsa/evaluation/harness';
import {
  Judge0Client,
  Judge0UnavailableError,
  judge0OptionsFromEnv,
  type CodeRunner,
  type Judge0Job,
  type Judge0Result,
} from '../src/modules/dsa/judge0/judge0.client';
import { MockQuestionRepository } from '../src/modules/dsa/questions/mock-question.repository';
import { MOCK_QUESTIONS } from '../src/modules/dsa/questions/mock-questions.data';
import { toPublicQuestion } from '../src/modules/dsa/questions/question.types';
import { DemoInvitationResolver } from '../src/modules/dsa/session/invitation.resolver';
import { InMemorySessionStore } from '../src/modules/dsa/session/session.store';

const TOKEN = 'demo-dsa-token';
const ok = (stdout: string): Judge0Result => ({
  verdict: 'ok',
  statusText: 'Accepted',
  stdout,
  stderr: '',
  compileOutput: '',
  timeMs: 5,
  memoryKb: 1000,
});
const expectedByStdin = new Map(MOCK_QUESTIONS.flatMap((q) => q.testCases.map((t) => [t.stdin, t.expectedOutput] as const)));

/** Fake runner that behaves like a perfect solution: echoes each test's expected value. */
const perfectRunner: CodeRunner = {
  async runBatch(jobs: Judge0Job[]) {
    return jobs.map((j) => ok(`\n${RESULT_MARKER}${expectedByStdin.get(j.stdin)}\n`));
  },
};

function makeService(runner: CodeRunner, clock = { t: 1_700_000_000_000 }) {
  const service = new DsaService(
    new DemoInvitationResolver(),
    new MockQuestionRepository(),
    new InMemorySessionStore(),
    runner,
    () => clock.t,
  );
  return { service, clock };
}

const body = (questionId = 'dsa-001', language = 'python', code = 'x = 1') => ({ questionId, language, code });
const rejectsWith = async (p: Promise<unknown>, code: string, status: number) => {
  await expect(p).rejects.toMatchObject({ response: { code }, status });
};

describe('question data', () => {
  it('has exactly the three required questions with correct marks and difficulty', () => {
    expect(MOCK_QUESTIONS.map((q) => [q.title, q.difficulty, q.marks])).toEqual([
      ['Two Sum', 'Easy', 10],
      ['Longest Substring Without Repeating Characters', 'Medium', 20],
      ['Median of Two Sorted Arrays', 'Hard', 30],
    ]);
  });

  it('every question has samples, public and hidden tests, constraints and starter code for all languages', () => {
    for (const q of MOCK_QUESTIONS) {
      expect(q.testCases.some((t) => !t.hidden)).toBe(true);
      expect(q.testCases.some((t) => t.hidden)).toBe(true);
      expect(q.samples.length).toBeGreaterThan(0);
      expect(q.constraints.length).toBeGreaterThan(0);
      expect(q.inputFormat && q.outputFormat && q.description).toBeTruthy();
      for (const lang of ['python', 'java', 'cpp'] as const) expect(q.starterCode[lang].length).toBeGreaterThan(10);
    }
  });

  it('public projection never contains hidden test input or expected output', () => {
    for (const q of MOCK_QUESTIONS) {
      const json = JSON.stringify(toPublicQuestion(q));
      const esc = (s: string) => JSON.stringify(s).slice(1, -1); // how the value would appear inside the JSON
      for (const t of q.testCases.filter((c) => c.hidden)) {
        expect(json).not.toContain(esc(t.display)); // displays always carry a "name = " prefix, so never trivially short
        if (t.stdin.trim().length >= 4) expect(json).not.toContain(esc(t.stdin.trim()));
      }
      expect(json).not.toMatch(/"stdin"|"testCases"|"harness"|"comparator"/);
      expect(toPublicQuestion(q).hiddenTestCount).toBe(q.testCases.filter((c) => c.hidden).length);
    }
  });
});

describe('comparison and harness helpers', () => {
  it('exact comparison ignores surrounding whitespace only', () => {
    expect(outputsMatch('exact', ' [0,1]\n', '[0,1]')).toBe(true);
    expect(outputsMatch('exact', '[0, 1]', '[0,1]')).toBe(false);
  });

  it('float comparison uses a tolerance and rejects non-numbers', () => {
    expect(outputsMatch('float', '2.50000', '2.5')).toBe(true);
    expect(outputsMatch('float', '2.5001', '2.5')).toBe(false);
    expect(outputsMatch('float', '', '2.5')).toBe(false);
    expect(outputsMatch('float', 'abc', '2.5')).toBe(false);
  });

  it('splitStdout separates the returned value from candidate prints', () => {
    expect(splitStdout(`hello\nworld\n\n${RESULT_MARKER}[0,1]\n`)).toEqual({ result: '[0,1]', userOutput: 'hello\nworld\n' });
    expect(splitStdout('only prints')).toEqual({ result: null, userOutput: 'only prints' });
  });

  it('cleanDiagnostics maps compiler lines back onto the candidate code', () => {
    expect(cleanDiagnostics('/box/main.cpp:5:3: error: expected', 2)).toBe('solution:3:3: error: expected');
    expect(cleanDiagnostics('File "/box/script.py", line 4', 1)).toBe('File "solution", line 3');
  });

  it('buildProgram puts candidate code before the harness and reports the prelude size', () => {
    const p = buildProgram('cpp', 'two-sum', 'class Solution {};');
    expect(p.lineOffset).toBe(2);
    expect(p.source.indexOf('class Solution {};')).toBeLessThan(p.source.indexOf('int main'));
  });
});

describe('request validation', () => {
  it('rejects unknown languages, empty code and oversized code', () => {
    expect(() => parseCodeRequest({ ...body(), language: 'ruby' })).toThrow();
    expect(() => parseCodeRequest({ ...body(), code: '   ' })).toThrow();
    expect(() => parseCodeRequest({ ...body(), code: 'x'.repeat(70_000) })).toThrow();
    expect(() => parseCodeRequest({ language: 'python', code: 'x' })).toThrow();
    expect(parseCodeRequest(body())).toEqual(body());
  });
});

describe('DsaService', () => {
  it('rejects unknown tokens', async () => {
    const { service } = makeService(perfectRunner);
    await rejectsWith(service.getState('nope'), 'INVALID_TOKEN', 404);
    await rejectsWith(service.getState('__proto__'), 'INVALID_TOKEN', 404);
  });

  it('hides questions until the assessment is started, then serves them without hidden tests', async () => {
    const { service } = makeService(perfectRunner);
    const before = await service.getState(TOKEN);
    expect(before.status).toBe('not_started');
    expect(before.questions).toBeUndefined();
    expect(before.overview).toHaveLength(3);
    expect(before.totalMarks).toBe(60);

    const after = await service.start(TOKEN);
    expect(after.status).toBe('in_progress');
    expect(after.questions).toHaveLength(3);
    const json = JSON.stringify(after);
    for (const q of MOCK_QUESTIONS)
      for (const t of q.testCases.filter((c) => c.hidden)) expect(json).not.toContain(JSON.stringify(t.display).slice(1, -1));
  });

  it('refuses to run or submit before the assessment starts', async () => {
    const { service } = makeService(perfectRunner);
    await rejectsWith(service.run(TOKEN, body()), 'NOT_STARTED', 409);
    await rejectsWith(service.submit(TOKEN, body()), 'NOT_STARTED', 409);
  });

  it('start is idempotent and the deadline is computed by the server clock', async () => {
    const { service, clock } = makeService(perfectRunner);
    const first = await service.start(TOKEN);
    expect(first.remainingSeconds).toBe(3600);
    clock.t += 90_000;
    const second = await service.start(TOKEN);
    expect(second.startedAt).toBe(first.startedAt);
    expect(second.deadlineAt).toBe(first.deadlineAt);
    expect(second.remainingSeconds).toBe(3510);
  });

  it('run uses only the public sample tests and returns their details', async () => {
    const { service } = makeService(perfectRunner);
    await service.start(TOKEN);
    const res = await service.run(TOKEN, body());
    expect(res.total).toBe(MOCK_QUESTIONS[0].testCases.filter((t) => !t.hidden).length);
    expect(res.verdict).toBe('passed');
    expect(res.cases.every((c) => !c.hidden && c.input && c.expected)).toBe(true);
  });

  it('submit judges hidden tests but never returns their input, expected value or output', async () => {
    const { service } = makeService(perfectRunner);
    await service.start(TOKEN);
    const res = await service.submit(TOKEN, body());
    const hidden = res.cases.filter((c) => c.hidden);
    expect(hidden.length).toBeGreaterThan(0);
    for (const c of hidden) {
      expect(c).not.toHaveProperty('input');
      expect(c).not.toHaveProperty('expected');
      expect(c).not.toHaveProperty('actual');
      expect(c).not.toHaveProperty('stdout');
      expect(c).not.toHaveProperty('stderr');
    }
    expect(res.score).toBe(10);
    expect(res.passed).toBe(res.total);
  });

  it('never marks a submission as passed unless the program printed a verified result', async () => {
    const silent: CodeRunner = { runBatch: async (jobs) => jobs.map(() => ok('')) };
    const { service } = makeService(silent);
    await service.start(TOKEN);
    const res = await service.submit(TOKEN, body());
    expect(res.verdict).toBe('failed');
    expect(res.passed).toBe(0);
    expect(res.score).toBe(0);
    expect(res.cases.every((c) => c.status === 'wrong_answer')).toBe(true);
  });

  it('scores proportionally and keeps the best submission per question', async () => {
    let passEverything = false;
    const flaky: CodeRunner = {
      async runBatch(jobs) {
        return jobs.map((j, i) => ok(`\n${RESULT_MARKER}${passEverything || i % 2 === 0 ? expectedByStdin.get(j.stdin) : 'wrong'}\n`));
      },
    };
    const { service } = makeService(flaky);
    await service.start(TOKEN);
    const partial = await service.submit(TOKEN, body());
    expect(partial.passed).toBe(Math.ceil(partial.total / 2));
    expect(partial.score).toBe(Math.round((10 * partial.passed * 100) / partial.total) / 100);

    passEverything = true;
    expect((await service.submit(TOKEN, body())).score).toBe(10);
    passEverything = false;
    const worse = await service.submit(TOKEN, body());
    expect(worse.progress.bestScore).toBe(10); // best kept
    expect(worse.progress.attempts).toBe(3);
  });

  it('turns Judge0 outages into a 503 without recording progress or leaking internals', async () => {
    const down: CodeRunner = {
      runBatch: async () => {
        throw new Judge0UnavailableError('The code runner is not reachable right now. Please try again shortly.', 'ECONNREFUSED http://localhost:2358');
      },
    };
    const { service } = makeService(down);
    await service.start(TOKEN);
    await expect(service.submit(TOKEN, body())).rejects.toMatchObject({ status: 503, response: { code: 'JUDGE0_UNAVAILABLE' } });
    const state = await service.getState(TOKEN);
    expect(state.progress.every((p) => p.attempts === 0 && p.bestScore === 0)).toBe(true);
    try {
      await service.run(TOKEN, body());
    } catch (e) {
      expect(JSON.stringify((e as { response: unknown }).response)).not.toContain('localhost');
    }
  });

  it('compile errors surface once and score zero', async () => {
    const broken: CodeRunner = {
      runBatch: async (jobs) =>
        jobs.map(() => ({ ...ok(''), verdict: 'compile_error' as const, statusText: 'Compilation Error', compileOutput: '/box/main.cpp:3:1: error: boom' })),
    };
    const { service } = makeService(broken);
    await service.start(TOKEN);
    const res = await service.submit(TOKEN, body('dsa-001', 'cpp'));
    expect(res.verdict).toBe('compile_error');
    expect(res.compileOutput).toContain('error: boom');
    expect(res.score).toBe(0);
  });

  it('serialises runs per candidate (BUSY) so the code runner cannot be flooded', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const slow: CodeRunner = {
      runBatch: async (jobs) => {
        await gate;
        return jobs.map((j) => ok(`\n${RESULT_MARKER}${expectedByStdin.get(j.stdin)}\n`));
      },
    };
    const { service } = makeService(slow);
    await service.start(TOKEN);
    const first = service.run(TOKEN, body());
    await new Promise((r) => setTimeout(r, 10));
    await rejectsWith(service.run(TOKEN, body()), 'BUSY', 429);
    release();
    expect((await first).verdict).toBe('passed');
  });

  it('the server ends the assessment when time is up and rejects later runs', async () => {
    const { service, clock } = makeService(perfectRunner);
    await service.start('demo-dsa-short'); // 1 minute
    await service.submit('demo-dsa-short', body());
    clock.t += 61_000;
    const state = await service.getState('demo-dsa-short');
    expect(state.status).toBe('finished');
    expect(state.remainingSeconds).toBe(0);
    expect(state.result?.reason).toBe('time_expired');
    expect(state.result?.totalScore).toBe(10);
    expect(state.questions).toBeUndefined();
    await rejectsWith(service.run('demo-dsa-short', body()), 'TIME_EXPIRED', 403);
    await rejectsWith(service.submit('demo-dsa-short', body()), 'TIME_EXPIRED', 403);
  });

  it('finish returns the final result and locks the assessment', async () => {
    const { service } = makeService(perfectRunner);
    await rejectsWith(service.finish(TOKEN), 'NOT_STARTED', 409);
    await service.start(TOKEN);
    await service.submit(TOKEN, body('dsa-001'));
    await service.submit(TOKEN, body('dsa-003', 'java'));
    const state = await service.finish(TOKEN);
    expect(state.status).toBe('finished');
    expect(state.result).toMatchObject({ reason: 'submitted', totalScore: 40, maxScore: 60 });
    expect(state.result?.percentage).toBeCloseTo(66.67, 2);
    expect(state.result?.questions.map((q) => q.solved)).toEqual([true, false, true]);
    await rejectsWith(service.submit(TOKEN, body()), 'ALREADY_FINISHED', 403);
    expect((await service.finish(TOKEN)).result?.totalScore).toBe(40); // idempotent
  });

  it('rejects unknown questions', async () => {
    const { service } = makeService(perfectRunner);
    await service.start(TOKEN);
    await rejectsWith(service.run(TOKEN, body('dsa-999')), 'UNKNOWN_QUESTION', 404);
  });
});

describe('Judge0Client', () => {
  const b64 = (s: string) => Buffer.from(s).toString('base64');
  const options = (fetchImpl: typeof fetch, extra = {}) => ({
    ...judge0OptionsFromEnv(),
    baseUrl: 'http://judge0.internal:2358',
    authToken: 'secret-token',
    pollIntervalMs: 1,
    fetch: fetchImpl,
    ...extra,
  });

  it('sends base64 payloads with limits and auth header, polls until done and keeps request order', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    let polls = 0;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (init?.method === 'POST') return new Response(JSON.stringify([{ token: 't1' }, { token: 't2' }]));
      polls += 1;
      const done = polls > 1;
      return new Response(
        JSON.stringify({
          submissions: [
            // deliberately reversed order
            { token: 't2', status: { id: done ? 6 : 2, description: 'x' }, compile_output: b64('boom'), time: null, memory: null },
            { token: 't1', status: { id: done ? 3 : 1, description: 'x' }, stdout: b64('héllo'), time: '0.012', memory: 3200 },
          ],
        }),
      );
    }) as unknown as typeof fetch;

    const client = new Judge0Client(options(fetchImpl));
    const res = await client.runBatch([
      { language: 'python', source: 'print(1)', stdin: 'in' },
      { language: 'cpp', source: 'int main(){}', stdin: '' },
    ]);
    expect(polls).toBe(2);
    expect(res[0]).toMatchObject({ verdict: 'ok', stdout: 'héllo', timeMs: 12, memoryKb: 3200 });
    expect(res[1]).toMatchObject({ verdict: 'compile_error', compileOutput: 'boom' });

    const post = JSON.parse(calls[0].init!.body as string);
    expect(post.submissions[0]).toMatchObject({ language_id: 71, source_code: b64('print(1)'), stdin: b64('in') });
    expect(post.submissions[1].language_id).toBe(54);
    expect(post.submissions[0].cpu_time_limit).toBeGreaterThan(0);
    expect((calls[0].init!.headers as Record<string, string>)['X-Auth-Token']).toBe('secret-token');
  });

  it('sends per-process limit flags only when the dev option is on, with a larger cap for Java', async () => {
    const bodies: { submissions: Record<string, unknown>[] }[] = [];
    const fetchImpl = (async (_u: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        bodies.push(JSON.parse(init.body as string));
        return new Response(JSON.stringify([{ token: 'a' }, { token: 'b' }]));
      }
      return new Response(
        JSON.stringify({ submissions: [{ token: 'a', status: { id: 3, description: 'ok' } }, { token: 'b', status: { id: 3, description: 'ok' } }] }),
      );
    }) as unknown as typeof fetch;
    const jobs = [
      { language: 'python' as const, source: 'x', stdin: '' },
      { language: 'java' as const, source: 'x', stdin: '' },
    ];
    await new Judge0Client(options(fetchImpl, { perProcessLimits: false })).runBatch(jobs);
    await new Judge0Client(options(fetchImpl, { perProcessLimits: true, javaPerProcessMemoryLimitKb: 8_000_000 })).runBatch(jobs);
    const [off, on] = bodies.map((b) => b.submissions);
    expect(off[0]).not.toHaveProperty('enable_per_process_and_thread_memory_limit');
    expect(off[1].memory_limit).toBe(off[0].memory_limit);
    expect(on[0]).toMatchObject({ enable_per_process_and_thread_time_limit: true, enable_per_process_and_thread_memory_limit: true });
    expect(on[1].memory_limit).toBe(8_000_000);
    expect(on[0].memory_limit).toBe(judge0OptionsFromEnv().memoryLimitKb);
  });

  it('maps timeouts and runtime errors', async () => {
    const fetchImpl = (async (_u: string, init?: RequestInit) =>
      init?.method === 'POST'
        ? new Response(JSON.stringify([{ token: 'a' }, { token: 'b' }, { token: 'c' }]))
        : new Response(
            JSON.stringify({
              submissions: [
                { token: 'a', status: { id: 5, description: 'Time Limit Exceeded' } },
                { token: 'b', status: { id: 11, description: 'Runtime Error (NZEC)' }, stderr: b64('Traceback') },
                { token: 'c', status: { id: 13, description: 'Internal Error' }, message: b64('No such file') },
              ],
            }),
          )) as unknown as typeof fetch;
    const res = await new Judge0Client(options(fetchImpl)).runBatch(
      ['a', 'b', 'c'].map(() => ({ language: 'java' as const, source: '', stdin: '' })),
    );
    expect(res.map((r) => r.verdict)).toEqual(['time_limit', 'runtime_error', 'internal_error']);
    expect(res[1].stderr).toBe('Traceback');
    expect(res[2].stderr).toContain('No such file');
  });

  it('reports failures without leaking the internal URL or token', async () => {
    const refused = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const err = await new Judge0Client(options(refused)).runBatch([{ language: 'python', source: 'x', stdin: '' }]).catch((e) => e);
    expect(err).toBeInstanceOf(Judge0UnavailableError);
    expect(err.message).not.toMatch(/judge0\.internal|secret-token|2358/);

    const http500 = (async () => new Response('{"error":"Internal Server Error"}', { status: 500 })) as unknown as typeof fetch;
    const err2 = await new Judge0Client(options(http500)).runBatch([{ language: 'python', source: 'x', stdin: '' }]).catch((e) => e);
    expect(err2).toBeInstanceOf(Judge0UnavailableError);
    expect(err2.message).not.toMatch(/judge0\.internal|secret-token|2358/);
    expect(err2.detail).toContain('HTTP 500');
  });

  it('retries a stalled poll instead of failing the whole evaluation', async () => {
    let polls = 0;
    const fetchImpl = (async (_u: string, init?: RequestInit) => {
      if (init?.method === 'POST') return new Response(JSON.stringify([{ token: 'a' }]));
      polls += 1;
      if (polls < 3) throw new TypeError('The operation was aborted due to timeout');
      return new Response(JSON.stringify({ submissions: [{ token: 'a', status: { id: 3, description: 'ok' }, stdout: b64('1') }] }));
    }) as unknown as typeof fetch;
    const [res] = await new Judge0Client(options(fetchImpl)).runBatch([{ language: 'python', source: 'x', stdin: '' }]);
    expect(res.verdict).toBe('ok');
    expect(polls).toBe(3);
  });

  it('gives up polling after the timeout', async () => {
    const fetchImpl = (async (_u: string, init?: RequestInit) =>
      init?.method === 'POST'
        ? new Response(JSON.stringify([{ token: 'a' }]))
        : new Response(JSON.stringify({ submissions: [{ token: 'a', status: { id: 2, description: 'Processing' } }] }))) as unknown as typeof fetch;
    await expect(
      new Judge0Client(options(fetchImpl, { pollTimeoutMs: 20 })).runBatch([{ language: 'python', source: 'x', stdin: '' }]),
    ).rejects.toBeInstanceOf(Judge0UnavailableError);
  });
});
