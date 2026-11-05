import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { RoundsConfigService } from '../src/modules/rounds-config';
import type { CodingAuthorClient } from '../src/modules/dsa/authoring/coding-author.client';
import { CodingAuthorService } from '../src/modules/dsa/authoring/coding-author.service';
import { PistonRunner, pistonOptionsFromEnv } from '../src/modules/dsa/execution/piston.runner';
import { MemoryAudit } from './in-memory';
import { ACTOR, FakeGenerator, JOB, MemoryRoundsConfigStore, TENANT } from './rounds/fakes';

/** The AI's reference solution really runs on Piston and its output becomes the expected output. Skipped without Piston. */
const options = pistonOptionsFromEnv();
const probe = async () => {
  try {
    const [r] = await new PistonRunner(options).runBatch([{ language: 'python', source: 'print("ok")', stdin: '' }]);
    return r?.verdict === 'ok' && r.stdout.trim() === 'ok' ? null : 'Piston cannot run code';
  } catch {
    return 'Piston is not reachable';
  }
};
const skip = await probe();

describe.skipIf(!!skip)(`coding problems through the live Piston runner${skip ? ` (skipped: ${skip})` : ''}`, () => {
  it('computes every expected output by running the Python reference solution', async () => {
    const store = new MemoryRoundsConfigStore();
    store.addJob(TENANT, JOB);
    const rounds = new RoundsConfigService(store, new MemoryAudit(), new FakeGenerator().asClient());
    const client = {
      problems: async () => ({
        problems: [
          {
            title: 'Sum of numbers',
            statement: 'Read n numbers and print their sum.',
            inputFormat: '',
            outputFormat: '',
            constraints: '',
            difficulty: 'EASY' as const,
            marks: 10,
            referenceSolution: 'n=int(input())\nprint(sum(map(int,input().split())))',
            samples: [{ input: '3\n1 2 3', output: 'wrong on purpose' }],
            hiddenInputs: ['2\n-5 5', '4\n1000000000 1000000000 1000000000 1000000000'],
          },
        ],
        invalid: 0,
        model: 'fake',
        promptVersion: 'coding_problems.v1',
      }),
    } as unknown as CodingAuthorClient;
    const svc = new CodingAuthorService(rounds, new PistonRunner(options), client, new MemoryAudit());
    const res = await svc.generate(TENANT, JOB, { count: 1 }, ACTOR);
    expect(res.problems[0]!.question.coding.tests.map((t) => [t.output, t.hidden])).toEqual([
      ['6', false],
      ['0', true],
      ['4000000000', true],
    ]);
  }, 60_000);
});
