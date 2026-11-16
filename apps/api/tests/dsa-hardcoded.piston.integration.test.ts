import { describe, expect, it } from 'vitest';
import { DsaService } from '../src/modules/dsa/dsa.service';
import { RESULT_MARKER } from '../src/modules/dsa/evaluation/harness';
import { PistonRunner, pistonOptionsFromEnv } from '../src/modules/dsa/execution/piston.runner';
import { MockQuestionRepository } from '../src/modules/dsa/questions/mock-question.repository';
import { MOCK_QUESTIONS } from '../src/modules/dsa/questions/mock-questions.data';
import { DemoInvitationResolver } from '../src/modules/dsa/session/invitation.resolver';
import { InMemorySessionStore } from '../src/modules/dsa/session/session.store';

/**
 * Hard-coded answers and forged result markers, on the REAL candidate path (DsaService -> harness -> PistonRunner ->
 * installed Piston), Two Sum (2 sample + 6 hidden tests). The expected score of each variant is COMPUTED from the real
 * test data (a hard-coded answer may coincide with a hidden test's answer), then compared with what the service gives:
 * marks x passed / total, the existing policy. Skipped when Piston cannot run code (reason printed). A skip is NOT a pass.
 */
const base = pistonOptionsFromEnv();
const TOKEN = 'demo-dsa-token';
const T = 300_000;
const TWO_SUM = MOCK_QUESTIONS.find((q) => q.id === 'dsa-001')!;
const round2 = (n: number) => Math.round(n * 100) / 100;

let skip: string | null = null;
try {
  const [r] = await new PistonRunner(base).runBatch([{ language: 'python', source: 'print("ok")', stdin: '' }]);
  if (r.verdict !== 'ok') skip = `Piston cannot run code: ${r.statusText}`;
} catch (err) {
  skip = `Piston not reachable: ${err instanceof Error ? err.message : String(err)}`;
}
if (skip) console.warn(`[hard-coded outputs on the live Piston] SKIPPED: ${skip}`);

/** How many of Two Sum's tests (samples + hidden) a given answer function would pass, from the real test data. */
function expectedPassed(answer: (target: number) => string | null, which: 'all' | 'samples' = 'all') {
  const cases = TWO_SUM.testCases.filter((t) => which === 'all' || !t.hidden);
  return { passed: cases.filter((t) => answer(Number(t.stdin.split('\n')[1])) === t.expectedOutput).length, total: cases.length };
}
/** The hard-coded answers below: the public samples' outputs keyed by their target, [0,1] otherwise. */
const hardCoded = (target: number) => (target === 9 ? '[0,1]' : target === 6 ? '[1,2]' : '[0,1]');

type Lang = 'python' | 'java' | 'cpp';
const FAKE = `\\n${RESULT_MARKER}[0,1]\\n`; // escaped for the source text of each language

const VARIANTS: Record<string, { code: Record<Lang, string>; answer: (target: number) => string | null }> = {
  // 1) returns the public samples' answers without solving anything
  'hard-coded sample answers': {
    answer: hardCoded,
    code: {
      python: `def two_sum(nums, target):\n    if target == 9:\n        return [0, 1]\n    if target == 6:\n        return [1, 2]\n    return [0, 1]\n`,
      java: `class Solution {\n    public int[] twoSum(int[] nums, int target) {\n        if (target == 9) return new int[]{0, 1};\n        if (target == 6) return new int[]{1, 2};\n        return new int[]{0, 1};\n    }\n}\n`,
      cpp: `class Solution {\npublic:\n    vector<int> twoSum(vector<int>& nums, int target) {\n        if (target == 9) return {0, 1};\n        if (target == 6) return {1, 2};\n        return {0, 1};\n    }\n};\n`,
    },
  },
  // 2) PRINTS the sample output instead of returning it (the harness takes only the returned value)
  'prints the sample output, returns nothing': {
    answer: () => '[]',
    code: {
      python: `def two_sum(nums, target):\n    print("[0,1]")\n    return []\n`,
      java: `class Solution {\n    public int[] twoSum(int[] nums, int target) {\n        System.out.println("[0,1]");\n        return new int[]{};\n    }\n}\n`,
      cpp: `class Solution {\npublic:\n    vector<int> twoSum(vector<int>& nums, int target) {\n        cout << "[0,1]" << endl;\n        return {};\n    }\n};\n`,
    },
  },
  // 3) forges the harness' result marker and exits before the harness can print the real result
  'forged result marker, then exits early': {
    answer: () => '[0,1]',
    code: {
      python: `import os, sys\ndef two_sum(nums, target):\n    sys.stdout.write("${FAKE}")\n    sys.stdout.flush()\n    os._exit(0)\n`,
      java: `class Solution {\n    public int[] twoSum(int[] nums, int target) {\n        System.out.print("${FAKE}");\n        System.out.flush();\n        System.exit(0);\n        return null;\n    }\n}\n`,
      cpp: `class Solution {\npublic:\n    vector<int> twoSum(vector<int>& nums, int target) {\n        cout << "${FAKE}" << flush;\n        exit(0);\n    }\n};\n`,
    },
  },
  // 4) forges the marker but then returns normally: the harness' own (later) marker must win
  'forged result marker, then returns a wrong answer': {
    answer: () => '[5,5]',
    code: {
      python: `import sys\ndef two_sum(nums, target):\n    sys.stdout.write("${FAKE}")\n    return [5, 5]\n`,
      java: `class Solution {\n    public int[] twoSum(int[] nums, int target) {\n        System.out.print("${FAKE}");\n        return new int[]{5, 5};\n    }\n}\n`,
      cpp: `class Solution {\npublic:\n    vector<int> twoSum(vector<int>& nums, int target) {\n        cout << "${FAKE}";\n        return {5, 5};\n    }\n};\n`,
    },
  },
  // 5) exits before any result is printed: no marker at all
  'no result marker (exits early)': {
    answer: () => null,
    code: {
      python: `import os\ndef two_sum(nums, target):\n    os._exit(0)\n`,
      java: `class Solution {\n    public int[] twoSum(int[] nums, int target) {\n        System.exit(0);\n        return null;\n    }\n}\n`,
      cpp: `class Solution {\npublic:\n    vector<int> twoSum(vector<int>& nums, int target) {\n        exit(0);\n    }\n};\n`,
    },
  },
};

async function service() {
  const s = new DsaService(new DemoInvitationResolver(), new MockQuestionRepository(), new InMemorySessionStore(), new PistonRunner(base));
  await s.start(TOKEN);
  return s;
}

describe.skipIf(!!skip)('hard-coded outputs on the live Piston (candidate path)', () => {
  for (const lang of ['python', 'java', 'cpp'] as Lang[]) {
    it(`${lang}: Run on hard-coded sample answers passes the public samples, records nothing`, async () => {
      const s = await service();
      const res = await s.run(TOKEN, { questionId: 'dsa-001', language: lang, code: VARIANTS['hard-coded sample answers'].code[lang] });
      const exp = expectedPassed(hardCoded, 'samples');
      expect(res.total).toBe(exp.total); // Run judges the samples only
      expect(res.passed).toBe(exp.passed);
      expect(res.cases.every((c) => !c.hidden)).toBe(true);
      const p = (await s.getState(TOKEN)).progress.find((x) => x.questionId === 'dsa-001')!;
      expect(p.attempts).toBe(0); // Run never records a score
    }, T);

    for (const [name, v] of Object.entries(VARIANTS)) {
      it(`${lang}: Submit "${name}" is judged on the hidden tests too and never gets full marks`, async () => {
        const res = await (await service()).submit(TOKEN, { questionId: 'dsa-001', language: lang, code: v.code[lang] });
        const exp = expectedPassed(v.answer);
        console.log(`HC ${lang} "${name}": passed ${res.passed}/${res.total} (expected ${exp.passed}/${exp.total}) score=${res.score} verdict=${res.verdict} hiddenPassed=${res.cases.filter((c) => c.hidden && c.status === 'passed').length}/${res.cases.filter((c) => c.hidden).length}`);
        expect(res.total).toBe(exp.total);
        expect(res.passed).toBe(exp.passed); // exactly the tests the hard-coded answer happens to match
        expect(res.score).toBe(round2((TWO_SUM.marks * exp.passed) / exp.total)); // existing policy: marks x passed / total
        expect(res.score).toBeLessThan(TWO_SUM.marks);
        expect(res.verdict).not.toBe('passed');
        expect(res.cases.filter((c) => c.hidden).every((c) => !('expected' in c) && !('actual' in c) && !('input' in c))).toBe(true);
      }, T);
    }
  }
});
