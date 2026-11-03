import { describe, expect, it } from 'vitest';
import { parseCodeRequest } from '../src/modules/dsa/dsa.dto';
import { DsaService } from '../src/modules/dsa/dsa.service';
import { outputsMatch } from '../src/modules/dsa/evaluation/evaluator';
import { RESULT_MARKER, buildProgram, cleanDiagnostics, splitStdout } from '../src/modules/dsa/evaluation/harness';
import {
  CodeRunnerBusyError,
  CodeRunnerUnavailableError,
  type CodeRunner,
  type RunnerJob,
  type RunnerResult,
} from '../src/modules/dsa/execution/code-runner';
import { MockQuestionRepository } from '../src/modules/dsa/questions/mock-question.repository';
import { MOCK_QUESTIONS } from '../src/modules/dsa/questions/mock-questions.data';
import { toPublicQuestion } from '../src/modules/dsa/questions/question.types';
import { DemoInvitationResolver } from '../src/modules/dsa/session/invitation.resolver';
import { InMemorySessionStore } from '../src/modules/dsa/session/session.store';

const TOKEN = 'demo-dsa-token';
const ok = (stdout: string): RunnerResult => ({
  verdict: 'ok',
  statusText: 'OK',
  stdout,
  stderr: '',
  compileOutput: '',
  timeMs: 5,
  memoryKb: 1000,
});
const expectedByStdin = new Map(MOCK_QUESTIONS.flatMap((q) => q.testCases.map((t) => [t.stdin, t.expectedOutput] as const)));

/** Fake runner that behaves like a perfect solution: echoes each test's expected value. */
const perfectRunner: CodeRunner = {
  async runBatch(jobs: RunnerJob[]) {
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

  it('cleanDiagnostics maps compiler lines back onto the candidate code and hides the runner\'s file names', () => {
    const cpp = buildProgram('cpp', 'two-sum', 'class Solution {};\nint x = ;\n');
    expect(cleanDiagnostics("main.cpp.cpp:4:9: error: expected primary-expression", cpp.mapLine)).toBe('solution:2:9: error: expected primary-expression');
    const py = buildProgram('python', 'two-sum', 'def two_sum(a, b):\n    pass\n');
    expect(cleanDiagnostics('  File "/box/submission/main.py", line 2\nSyntaxError: x', py.mapLine)).toBe('  File "solution", line 1\nSyntaxError: x');
    // a message about a harness line is not blamed on the candidate
    expect(cleanDiagnostics('main.cpp.cpp:2:1: error: boom', cpp.mapLine)).toBe('solution:?:1: error: boom');
    expect(cleanDiagnostics("x\nchmod: cannot access 'a.out': No such file or directory", cpp.mapLine)).toBe('x');
  });

  it('buildProgram puts candidate code before the harness for Python and C++, and maps lines exactly', () => {
    const p = buildProgram('cpp', 'two-sum', 'class Solution {};');
    expect(p.source.indexOf('class Solution {};')).toBeLessThan(p.source.indexOf('int main'));
    expect(p.mapLine(1)).toBeNull(); // prelude: #include
    expect(p.mapLine(2)).toBeNull(); // prelude: using namespace
    expect(p.mapLine(3)).toBe(1); // the candidate's first line
  });

  it('for Java the harness Main comes FIRST (the runner launches the first class), imports move above it, and lines still map back', () => {
    const code = 'import java.util.*;\n\nclass Solution {\n    int f() { return 1; }\n}\nimport java.io.*;\n';
    const p = buildProgram('java', 'two-sum', code);
    const lines = p.source.split('\n');
    expect(p.source.indexOf('public class Main')).toBeLessThan(p.source.indexOf('class Solution'));
    expect(lines[0]).toBe('import java.util.*;');
    expect(lines[1]).toBe('import java.io.*;'); // the late import is moved up too
    const solutionLine = lines.findIndex((l) => l.startsWith('class Solution')) + 1;
    expect(p.mapLine(solutionLine)).toBe(3); // `class Solution {` was line 3 of the candidate's code
    expect(p.mapLine(1)).toBe(1);
    expect(p.mapLine(2)).toBe(6);
    expect(p.mapLine(lines.findIndex((l) => l.includes('hfEmit(String v)')) + 1)).toBeNull(); // harness code
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
    let seq = 0; // position of the test case within the submission (cases arrive in two batches)
    const flaky: CodeRunner = {
      async runBatch(jobs) {
        return jobs.map((j) => ok(`\n${RESULT_MARKER}${passEverything || seq++ % 2 === 0 ? expectedByStdin.get(j.stdin) : 'wrong'}\n`));
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
    seq = 0;
    const worse = await service.submit(TOKEN, body());
    expect(worse.progress.bestScore).toBe(10); // best kept
    expect(worse.progress.attempts).toBe(3);
  });

  it('turns code runner outages into a 503 without recording progress or leaking internals', async () => {
    const down: CodeRunner = {
      runBatch: async () => {
        throw new CodeRunnerUnavailableError('The code runner is not reachable right now. Please try again shortly.', 'ECONNREFUSED http://127.0.0.1:2000');
      },
    };
    const { service } = makeService(down);
    await service.start(TOKEN);
    await expect(service.submit(TOKEN, body())).rejects.toMatchObject({ status: 503, response: { code: 'CODE_RUNNER_UNAVAILABLE' } });
    const state = await service.getState(TOKEN);
    expect(state.progress.every((p) => p.attempts === 0 && p.bestScore === 0)).toBe(true);
    try {
      await service.run(TOKEN, body());
    } catch (e) {
      expect(JSON.stringify((e as { response: unknown }).response)).not.toMatch(/localhost|127\.0\.0\.1|2000/);
    }
  });

  it('a busy runner is a retryable 503 and nothing is recorded', async () => {
    const busy: CodeRunner = {
      runBatch: async () => {
        throw new CodeRunnerBusyError();
      },
    };
    const { service } = makeService(busy);
    await service.start(TOKEN);
    await expect(service.submit(TOKEN, body())).rejects.toMatchObject({ status: 503, response: { code: 'CODE_RUNNER_BUSY' } });
    expect((await service.getState(TOKEN)).progress.every((p) => p.attempts === 0)).toBe(true);
    // and the candidate is not left stuck behind a "previous run still in progress" lock
    await expect(service.run(TOKEN, body())).rejects.toMatchObject({ response: { code: 'CODE_RUNNER_BUSY' } });
  });

  it('runs the first test case alone, so code that does not compile costs one run, not one per test', async () => {
    const batches: number[] = [];
    const broken: CodeRunner = {
      async runBatch(jobs) {
        batches.push(jobs.length);
        return jobs.map(() => ({ ...ok(''), verdict: 'compile_error' as const, statusText: 'Compilation failed', compileOutput: 'main.cpp.cpp:3:1: error: boom' }));
      },
    };
    const { service } = makeService(broken);
    await service.start(TOKEN);
    const res = await service.submit(TOKEN, body('dsa-001', 'cpp'));
    expect(batches).toEqual([1]); // the other test cases were never started
    expect(res).toMatchObject({ verdict: 'compile_error', score: 0, total: 8 });
    expect(res.compileOutput).toContain('error: boom');
    expect(res.compileOutput).not.toContain('main.cpp.cpp');
  });

  it('when the first case compiles, the remaining cases run in one further batch', async () => {
    const batches: number[] = [];
    const counting: CodeRunner = {
      async runBatch(jobs) {
        batches.push(jobs.length);
        return jobs.map((j) => ok(`\n${RESULT_MARKER}${expectedByStdin.get(j.stdin)}\n`));
      },
    };
    const { service } = makeService(counting);
    await service.start(TOKEN);
    const res = await service.submit(TOKEN, body());
    expect(batches).toEqual([1, res.total - 1]);
    expect(res.verdict).toBe('passed');
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
