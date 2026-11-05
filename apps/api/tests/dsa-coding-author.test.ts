import 'reflect-metadata';
import { HttpException } from '@nestjs/common';
import { codingCsvTemplate, type RoundInput } from '@hireflow/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import { RoundsConfigService } from '../src/modules/rounds-config';
import type { CodingAuthorClient, CodingAuthorInput, RawCodingProblem } from '../src/modules/dsa/authoring/coding-author.client';
import { CodingAuthorService, languageNeutral } from '../src/modules/dsa/authoring/coding-author.service';
import type { CodeRunner, RunnerJob, RunnerResult } from '../src/modules/dsa/execution/code-runner';
import { MemoryAudit } from './in-memory';
import { ACTOR, FakeGenerator, JOB, MemoryRoundsConfigStore, TENANT } from './rounds/fakes';

/** A runner that "executes" by looking the stdin up: the reference solution's real outputs. */
class FakeRunner implements CodeRunner {
  jobs: RunnerJob[] = [];
  constructor(private readonly outputs: Record<string, string | null>) {}
  async runBatch(jobs: RunnerJob[]): Promise<RunnerResult[]> {
    this.jobs.push(...jobs);
    return jobs.map((j) => {
      const out = this.outputs[j.stdin];
      return { verdict: out === null || out === undefined ? 'runtime_error' : 'ok', statusText: '', stdout: out ?? '', stderr: '', compileOutput: '', timeMs: 1, memoryKb: 1 };
    });
  }
}

class FakeClient {
  calls: CodingAuthorInput[] = [];
  constructor(private readonly problems: RawCodingProblem[]) {}
  async problems_(input: CodingAuthorInput) {
    this.calls.push(input);
    return { problems: this.problems, invalid: 0, model: 'fake', promptVersion: 'coding_problems.v2' };
  }
}

const sum = (extra: Partial<RawCodingProblem> = {}): RawCodingProblem => ({
  title: 'Sum of numbers',
  statement: 'Read n numbers and print their sum.',
  inputFormat: 'n, then n numbers',
  outputFormat: 'the sum',
  constraints: '1 <= n <= 100',
  difficulty: 'EASY',
  marks: 10,
  referenceSolution: 'n=int(input());print(sum(map(int,input().split())))',
  // the model's own output is WRONG on purpose: the runner's output must win
  samples: [{ input: '3\n1 2 3', output: '7' }],
  hiddenInputs: ['1\n5', '2\n-1 1', 'bad'],
  ...extra,
});

let rounds: RoundsConfigService;
let roundsStore: MemoryRoundsConfigStore;
const code = (e: unknown) => ((e as HttpException).getResponse() as { code: string }).code;
const caught = (p: Promise<unknown>) => p.then(() => { throw new Error('expected an error'); }, (e: unknown) => e);
const file = (name: string, text: string, mimetype = 'application/octet-stream') => ({ originalname: name, mimetype, size: Buffer.byteLength(text), buffer: Buffer.from(text) });

function service(problems: RawCodingProblem[], outputs: Record<string, string | null>) {
  const client = new FakeClient(problems);
  const runner = new FakeRunner(outputs);
  const asClient = { problems: (i: CodingAuthorInput) => client.problems_(i) } as unknown as CodingAuthorClient;
  return { svc: new CodingAuthorService(rounds, runner, asClient, new MemoryAudit()), client, runner };
}

beforeEach(() => {
  roundsStore = new MemoryRoundsConfigStore();
  roundsStore.addJob(TENANT, JOB);
  rounds = new RoundsConfigService(roundsStore, new MemoryAudit(), new FakeGenerator().asClient());
});

describe('AI-written coding problems', () => {
  it('every expected output comes from running the reference solution, never from the model', async () => {
    const { svc, runner, client } = service([sum()], { '3\n1 2 3\n': '6\n', '1\n5\n': '5', '2\n-1 1\n': '0  \n\n', 'bad\n': null });
    const res = await svc.generate(TENANT, JOB, { count: 1, difficulty: 'EASY' }, ACTOR);
    expect(client.calls[0]).toMatchObject({ mode: 'generate', count: 1, difficulty: 'EASY', job: { title: 'AI Engineer' } });
    expect(runner.jobs.every((j) => j.language === 'python')).toBe(true);
    const [p] = res.problems;
    expect(p!.question).toMatchObject({ kind: 'CODING', text: 'Read n numbers and print their sum.', marks: 10, difficulty: 'EASY', source: 'AI' });
    expect(p!.coding ?? p!.question.coding.tests).toEqual([
      { input: '3\n1 2 3\n', output: '6', hidden: false },
      { input: '1\n5\n', output: '5', hidden: true },
      { input: '2\n-1 1\n', output: '0', hidden: true },
    ]);
    expect(p!.notes).toEqual(['1 hidden test(s) were left out because the reference solution failed on them.']);
  });

  it('a problem whose solution does not run on its samples is dropped, with the reason', async () => {
    const { svc } = service([sum({ title: 'Broken' })], { '3\n1 2 3\n': null });
    const res = await svc.generate(TENANT, JOB, {}, ACTOR);
    expect(res.problems).toEqual([]);
    expect(res.dropped).toEqual([{ title: 'Broken', reason: expect.stringContaining('did not run correctly') }]);
  });

  it('is refused once students started (the rounds are locked)', async () => {
    await rounds.save(TENANT, JOB, { rounds: [{ type: 'APTITUDE', name: 'A', passRule: { mode: 'CORRECT_COUNT', value: 1 }, questions: [{ kind: 'MCQ', text: 'Q', options: ['a', 'b'], correct: [0] }] } as RoundInput], complete: true }, ACTOR);
    await rounds.lockForAttempts(TENANT, JOB);
    const { svc } = service([sum()], {});
    expect(code(await caught(svc.generate(TENANT, JOB, {}, ACTOR)))).toBe('ROUNDS_LOCKED');
  });
});

describe("problems from HR's PDF / Word file", () => {
  it('keeps the document\'s examples and adds hidden tests when the solution reproduces them', async () => {
    const { svc, client } = service([sum({ samples: [{ input: '3\n1 2 3', output: '6' }] })], { '3\n1 2 3\n': '6', '1\n5\n': '5', '2\n-1 1\n': '0', 'bad\n': '0' });
    const res = await svc.importFile(TENANT, JOB, file('questions.docx', 'PK...'), ACTOR);
    expect(client.calls[0]).toMatchObject({ mode: 'extract', document: { mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' } });
    expect(res.problems[0]!.origin).toBe('document');
    expect(res.problems[0]!.question.coding.tests.filter((t) => t.hidden)).toHaveLength(3);
  });

  it("when the AI's solution disagrees with the document, only the document's examples are kept and HR is told", async () => {
    const { svc } = service([sum({ samples: [{ input: '3\n1 2 3', output: '6' }] })], { '3\n1 2 3\n': '999', '1\n5\n': '5' });
    const res = await svc.importFile(TENANT, JOB, file('paper.pdf', '%PDF'), ACTOR);
    expect(res.problems[0]!.question.coding.tests).toEqual([{ input: '3\n1 2 3\n', output: '6', hidden: false }]);
    expect(res.problems[0]!.notes.join(' ')).toContain('add hidden tests yourself');
  });

  it('refuses old .doc files, other types and files over 5 MB', async () => {
    const { svc } = service([], {});
    expect(code(await caught(svc.importFile(TENANT, JOB, file('old.doc', 'x'), ACTOR)))).toBe('FILE_TYPE_NOT_SUPPORTED');
    expect(code(await caught(svc.importFile(TENANT, JOB, file('pic.png', 'x', 'image/png'), ACTOR)))).toBe('FILE_TYPE_NOT_SUPPORTED');
    expect(code(await caught(svc.importFile(TENANT, JOB, { ...file('big.pdf', 'x'), size: 6 * 1024 * 1024 }, ACTOR)))).toBe('FILE_TOO_LARGE');
    expect(code(await caught(svc.importFile(TENANT, JOB, undefined, ACTOR)))).toBe('FILE_REQUIRED');
  });
});

describe("HR's CSV file (taken exactly as written, no AI)", () => {
  it('the downloadable template imports as one ready problem with its sample and hidden tests', async () => {
    const { svc, client, runner } = service([], {});
    const res = await svc.importFile(TENANT, JOB, file('problems.csv', codingCsvTemplate()), ACTOR);
    expect(client.calls).toEqual([]);
    expect(runner.jobs).toEqual([]);
    expect(res.dropped).toEqual([]);
    const p = res.problems[0]!;
    expect(p).toMatchObject({ origin: 'csv', notes: [], question: { marks: 10, difficulty: 'EASY', source: 'HR', coding: { title: 'Sum of an array', constraints: '1 <= n <= 100000\n-10^9 <= a[i] <= 10^9' } } });
    expect(p.question.coding.tests).toEqual([
      { input: '3\n1 2 3\n', output: '6', hidden: false },
      { input: '1\n5\n', output: '5', hidden: true },
      { input: '4\n-1 1 -2 2\n', output: '0', hidden: true },
      { input: '2\n1000000000 1000000000\n', output: '2000000000', hidden: true },
    ]);
  });

  it('reads quoted multi-line cells, flexible column names, and reports rows it cannot use', async () => {
    const csv = 'Title,Statement,Sample Input,Sample Output,Marks\r\n"Reverse","Reverse the line.\nKeep spaces.","abc","cba",25\r\nEmpty,,x,y,5\r\n';
    const { svc } = service([], {});
    const res = await svc.importFile(TENANT, JOB, file('p.csv', csv, 'text/csv'), ACTOR);
    expect(res.problems.map((p) => [p.question.coding.title, p.question.text, p.question.marks])).toEqual([['Reverse', 'Reverse the line.\nKeep spaces.', 25]]);
    expect(res.problems[0]!.notes[0]).toContain('No hidden tests');
    expect(res.dropped).toEqual([{ title: 'Empty', reason: 'It has no problem statement.' }]);
  });

  it('a CSV without the needed columns is refused with the list of what is missing', async () => {
    const { svc } = service([], {});
    const err = await caught(svc.importFile(TENANT, JOB, file('p.csv', 'name,question\nA,B\n'), ACTOR));
    expect(code(err)).toBe('CSV_COLUMNS_MISSING');
    expect((err as HttpException).message).toContain('title, statement, sample_input, sample_output');
  });
});

describe('AI-written problems never mention a programming language', () => {
  it('removes every sentence that names a language or says "any language"; the task itself stays', () => {
    expect(
      languageNeutral('Given an array, print the largest value. Write your solution in Python, Java or C++. You may use any programming language.\nRead from standard input.'),
    ).toBe('Given an array, print the largest value.\nRead from standard input.');
    expect(languageNeutral('Implement it in your preferred language. Print the sum.')).toBe('Print the sum.');
    expect(languageNeutral('Use C# or Node.js if you like. Print the count.')).toBe('Print the count.');
    // words that only look like a language name stay
    expect(languageNeutral('Print the maximum. Constraints are given below.')).toBe('Print the maximum. Constraints are given below.');
  });

  it("applies to the statement, formats and constraints of AI problems, never to HR's own file", async () => {
    const mention = sum({ statement: 'Read n numbers and print their sum. Solve it in Java.', inputFormat: 'n then n numbers (read with Python input())', samples: [{ input: '3\n1 2 3', output: '6' }] });
    const outputs = { '3\n1 2 3\n': '6', '1\n5\n': '5', '2\n-1 1\n': '0', 'bad\n': '0' };
    const ai = await service([mention], outputs).svc.generate(TENANT, JOB, {}, ACTOR);
    expect(ai.problems[0]!.question.text).toBe('Read n numbers and print their sum.');
    expect(ai.problems[0]!.question.coding.inputFormat).toBe('');
    const doc = await service([mention], outputs).svc.importFile(TENANT, JOB, file('mine.pdf', '%PDF'), ACTOR);
    expect(doc.problems[0]!.question.text).toContain('Solve it in Java.');
  });
});
