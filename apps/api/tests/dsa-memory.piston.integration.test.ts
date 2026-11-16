import { describe, expect, it } from 'vitest';
import { DsaService } from '../src/modules/dsa/dsa.service';
import { PistonRunner, pistonOptionsFromEnv } from '../src/modules/dsa/execution/piston.runner';
import { MockQuestionRepository } from '../src/modules/dsa/questions/mock-question.repository';
import { DemoInvitationResolver } from '../src/modules/dsa/session/invitation.resolver';
import { InMemorySessionStore } from '../src/modules/dsa/session/session.store';

/**
 * Memory enforcement on the REAL candidate path (DsaService -> Evaluator -> harness -> PistonRunner -> installed Piston),
 * Two Sum (8 tests). Each solution allocates and TOUCHES a given amount of memory, then returns the correct answer.
 * The configured limits are not changed: Python / C++ 256 MB, Java 512 MB (javac and the JVM share Java's run).
 * Piston's raw run stage (status, exit code, signal, memory) is recorded for the report. Skipped when Piston cannot run
 * code (reason printed). A skip is NOT a pass.
 */
const base = pistonOptionsFromEnv();
const TOKEN = 'demo-dsa-token';
const T = 300_000;

let skip: string | null = null;
try {
  const [r] = await new PistonRunner(base).runBatch([{ language: 'python', source: 'print("ok")', stdin: '' }]);
  if (r.verdict !== 'ok') skip = `Piston cannot run code: ${r.statusText}`;
} catch (err) {
  skip = `Piston not reachable: ${err instanceof Error ? err.message : String(err)}`;
}
if (skip) console.warn(`[memory limits on the live Piston] SKIPPED: ${skip}`);

type Lang = 'python' | 'java' | 'cpp';
const code = (lang: Lang, mb: number) =>
  ({
    python: `def two_sum(nums, target):
    blob = b"x" * (${mb} * 1024 * 1024)  # filled, so every page is really used
    seen = {}
    for i, x in enumerate(nums):
        if target - x in seen:
            return [seen[target - x], i] if len(blob) > 0 else []
        seen[x] = i
    return []
`,
    java: `import java.util.*;
class Solution {
    public int[] twoSum(int[] nums, int target) {
        byte[] blob = new byte[${mb} * 1024 * 1024];
        for (int i = 0; i < blob.length; i += 4096) blob[i] = 1; // touch every page
        Map<Long, Integer> seen = new HashMap<>();
        for (int i = 0; i < nums.length; i++) {
            Integer j = seen.get((long) target - nums[i]);
            if (j != null && blob[0] == 1) return new int[]{j, i};
            seen.put((long) nums[i], i);
        }
        return new int[]{};
    }
}
`,
    cpp: `class Solution {
public:
    vector<int> twoSum(vector<int>& nums, int target) {
        vector<char> blob((size_t)${mb} << 20, 1); // filled, so every page is really used
        unordered_map<long long, int> seen;
        for (int i = 0; i < (int)nums.size(); i++) {
            auto it = seen.find((long long)target - nums[i]);
            if (it != seen.end() && blob[blob.size() - 1] == 1) return {it->second, i};
            seen[nums[i]] = i;
        }
        return {};
    }
};
`,
  })[lang];

/** Submits through the real service; returns the response and Piston's raw run stage of every test case. */
async function submit(lang: Lang, mb: number) {
  const raw: { status: unknown; code: unknown; signal: unknown; memoryMB: number | null; cpu: unknown; wall: unknown }[] = [];
  const recording = (async (url: string, init: RequestInit) => {
    const res = await fetch(url, init);
    const body = (await res.clone().json()) as { run?: Record<string, unknown> };
    const r = body.run ?? {};
    raw.push({
      status: r.status ?? null,
      code: r.code ?? null,
      signal: r.signal ?? null,
      memoryMB: typeof r.memory === 'number' ? Math.round((r.memory / 1048576) * 10) / 10 : null,
      cpu: r.cpu_time ?? null,
      wall: r.wall_time ?? null,
    });
    return res;
  }) as unknown as typeof fetch;
  const s = new DsaService(new DemoInvitationResolver(), new MockQuestionRepository(), new InMemorySessionStore(), new PistonRunner({ ...base, fetch: recording }));
  await s.start(TOKEN);
  const res = await s.submit(TOKEN, { questionId: 'dsa-001', language: lang, code: code(lang, mb) });
  // evidence for the report (one line per submission)
  console.log(
    `MEM ${lang} ${mb}MB -> verdict=${res.verdict} passed=${res.passed}/${res.total} score=${res.score} statuses=${JSON.stringify(
      res.cases.reduce((a: Record<string, number>, c) => ((a[c.status] = (a[c.status] ?? 0) + 1), a), {}),
    )} sampleStderr=${JSON.stringify((res.cases.find((c) => !c.hidden)?.stderr ?? '').slice(0, 120))} piston=${JSON.stringify(raw[raw.length - 1])} pistonAll=${JSON.stringify(
      raw.reduce((a: Record<string, number>, r) => {
        const k = `${r.status}/${r.code}/${r.signal}`;
        a[k] = (a[k] ?? 0) + 1;
        return a;
      }, {}),
    )} maxMemMB=${Math.max(...raw.map((r) => r.memoryMB ?? 0))}`,
  );
  return { res, raw };
}

const PLAN: { lang: Lang; limitMB: number; normal: number; near: number; above: number }[] = [
  { lang: 'python', limitMB: 256, normal: 8, near: 220, above: 400 },
  { lang: 'java', limitMB: 512, normal: 8, near: 400, above: 700 },
  { lang: 'cpp', limitMB: 256, normal: 8, near: 220, above: 400 },
];

describe.skipIf(!!skip)('memory limits on the live Piston (candidate path)', () => {
  for (const p of PLAN) {
    it(`${p.lang}: normal memory (${p.normal} MB) passes with full marks`, async () => {
      const { res } = await submit(p.lang, p.normal);
      expect(res.verdict).toBe('passed');
      expect(res.score).toBe(10);
    }, T);

    it(`${p.lang}: near the limit (${p.near} of ${p.limitMB} MB) still passes with full marks`, async () => {
      const { res } = await submit(p.lang, p.near);
      expect(res.verdict).toBe('passed');
      expect(res.score).toBe(10);
    }, T);

    for (const attempt of [1, 2]) {
      it(`${p.lang}: above the limit (${p.above} MB) is a candidate runtime error with no marks (attempt ${attempt})`, async () => {
        // not passed, no marks, a runtime error on every test, never a runner failure (503) and never a success
        const { res } = await submit(p.lang, p.above);
        expect(res.verdict).toBe('failed');
        expect(res.score).toBe(0);
        expect(res.passed).toBe(0);
        expect(res.cases.every((c) => c.status === 'runtime_error')).toBe(true);
      }, T);
    }
  }
});
