import { describe, expect, it } from 'vitest';
import { DsaService } from '../src/modules/dsa/dsa.service';
import { PistonRunner, pistonOptionsFromEnv } from '../src/modules/dsa/execution/piston.runner';
import { MockQuestionRepository } from '../src/modules/dsa/questions/mock-question.repository';
import { DemoInvitationResolver } from '../src/modules/dsa/session/invitation.resolver';
import { InMemorySessionStore } from '../src/modules/dsa/session/session.store';

/**
 * Java package / import handling (harness.ts buildProgram) checked against the REAL Java compiler: the candidate path
 * DsaService -> Evaluator -> buildProgram -> PistonRunner -> the installed Piston Java runtime, on bank problem
 * dsa-001 (Two Sum, 8 tests). Skipped (with the reason printed) when Piston cannot run Java. A skip is NOT a pass.
 */
const options = pistonOptionsFromEnv();
const TOKEN = 'demo-dsa-token';
const T = 180_000;

async function probe(): Promise<string | null> {
  try {
    const [r] = await new PistonRunner(options).runBatch([
      { language: 'java', source: 'public class Main { public static void main(String[] a) { System.out.println("ok"); } }', stdin: '' },
    ]);
    return r.verdict === 'ok' && r.stdout.trim() === 'ok' ? null : `Piston cannot run Java: ${r.statusText} ${r.stderr}`.trim();
  } catch (err) {
    return `Piston request failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}
const skipReason = await probe();
if (skipReason) console.warn(`[Java through the live Piston runner] SKIPPED: ${skipReason}`);

async function service() {
  const s = new DsaService(new DemoInvitationResolver(), new MockQuestionRepository(), new InMemorySessionStore(), new PistonRunner(options));
  await s.start(TOKEN);
  return s;
}

// The same correct O(n) Two Sum body in every case; only the header / class declaration differs.
const BODY = `    public int[] twoSum(int[] nums, int target) {
        Map<Long, Integer> seen = new HashMap<>();
        for (int i = 0; i < nums.length; i++) {
            Integer j = seen.get((long) target - nums[i]);
            if (j != null) return new int[]{j, i};
            seen.put((long) nums[i], i);
        }
        return new int[]{};
    }
}
`;

const CASES: [string, string][] = [
  ['1 package declaration', `package com.example.app;\nimport java.util.HashMap;\nimport java.util.Map;\n\nclass Solution {\n${BODY}`],
  ['2 import with trailing comment', `import java.util.HashMap; // lookup table\nimport java.util.Map; /* the interface */\n\nclass Solution {\n${BODY}`],
  [
    '3 several imports on one line, incl. static imports',
    `import java.util.Map; import java.util.HashMap;\nimport static java.lang.Math.max; import static java.lang.Math.min;\n\nclass Solution {\n    int clamp(int v) { return max(0, min(v, 1)); }\n${BODY}`,
  ],
  ['4 package declaration after the imports', `import java.util.*;\npackage app.after;\n\nclass Solution {\n${BODY}`],
  ['5 class Solution', `import java.util.*;\n\nclass Solution {\n${BODY}`],
  ['6 public class Solution', `import java.util.*;\n\npublic class Solution {\n${BODY}`],
  [
    '7 no package and no import',
    `class Solution {\n${BODY.replace('Map<Long, Integer> seen = new HashMap<>();', 'java.util.Map<Long, Integer> seen = new java.util.HashMap<>();')}`,
  ],
];

describe.skipIf(!!skipReason)('Java through the live Piston runner: package and import handling', () => {
  for (const [name, code] of CASES) {
    it(`${name}: compiles, runs and passes every sample and hidden test`, async () => {
      const res = await (await service()).submit(TOKEN, { questionId: 'dsa-001', language: 'java', code });
      expect(res.compileOutput).toBe('');
      expect(res.verdict).toBe('passed');
      expect(res.passed).toBe(res.total);
      expect(res.total).toBe(8);
      expect(res.score).toBe(10);
    }, T);
  }

  it('a compile error after moved header lines points at the candidate\'s own line', async () => {
    const code = [
      'package com.example.app; // line 1',
      '// line 2: a comment',
      'import java.util.*; // line 3',
      'class Solution {',
      '    public int[] twoSum(int[] nums, int target) {',
      '        int x = ;', // line 6: the error
      '        return new int[]{};',
      '    }',
      '}',
      '',
    ].join('\n');
    const res = await (await service()).submit(TOKEN, { questionId: 'dsa-001', language: 'java', code });
    expect(res.verdict).toBe('compile_error');
    expect(res.score).toBe(0);
    expect(res.compileOutput).toMatch(/solution:6\b/);
    expect(res.compileOutput).not.toMatch(/Main\.java/);
  }, T);

  it('a runtime exception after moved header lines is a runtime error whose trace points at the candidate\'s line', async () => {
    const code = [
      'package com.example.app;',
      'import java.util.HashMap; // trailing comment',
      'import java.util.Map; import static java.lang.Math.max;',
      '',
      'class Solution {',
      '    public int[] twoSum(int[] nums, int target) {',
      '        if (max(nums.length, 0) > 0) throw new IllegalStateException("boom");', // line 7
      '        return new int[]{};',
      '    }',
      '}',
      '',
    ].join('\n');
    const res = await (await service()).run(TOKEN, { questionId: 'dsa-001', language: 'java', code });
    expect(res.verdict).toBe('failed');
    const sample = res.cases.find((c) => !c.hidden)!;
    expect(sample.status).toBe('runtime_error');
    expect(sample.stderr).toContain('IllegalStateException: boom');
    expect(sample.stderr).toMatch(/solution:7\b/);
  }, T);
});
