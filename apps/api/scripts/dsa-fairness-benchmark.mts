/**
 * DSA language-fairness benchmark (Phase 2). OPT-IN, never part of the test suite (it is not a *.test.ts file and
 * lives outside tests/). Measures equivalent reference solutions in Python, Java and C++ on the REAL hosting Piston,
 * so execution limits can be decided from evidence. It changes nothing: no limits, no Piston settings, no compiler
 * flags, no database, no Gemini.
 *
 * Run from apps/api (Node >= 23.6: TypeScript types are stripped natively, no build step):
 *
 *   node scripts/dsa-fairness-benchmark.mts                      # DRY RUN (default): plan + execution count, no jobs
 *   node scripts/dsa-fairness-benchmark.mts --profile=smoke --run  # tiny validation run (a few dozen executions)
 *   node scripts/dsa-fairness-benchmark.mts --mode=isolated --run  # full run, one job at a time
 *   node scripts/dsa-fairness-benchmark.mts --mode=concurrent3 --run  # full run, three jobs at once (production cap)
 *   node scripts/dsa-fairness-benchmark.mts --summarize-from=<dir>/raw.json  # rebuild summaries only, NO Piston call
 *
 * Options: --profile=full|smoke  --mode=isolated|concurrent3  --limits=ceiling|production  --warmup=3  --reps=30
 *          --seed=42  --out=<dir>  --langs=python,java,cpp  --algos=two-sum-hash,two-sum-nested,ls-window,ls-quadratic
 * PISTON_URL (default http://127.0.0.1:2000) is the hosting Piston. Results: <out>/raw.json, summary.json, summary.md.
 *
 * The programs are built with the SAME harness the API uses (src/modules/dsa/evaluation/harness.ts: buildProgram), and
 * sent with the same language / file names as PistonRunner (src/modules/dsa/execution/piston.runner.ts), so compile
 * and run behave exactly as for candidates (C++: `g++ -std=c++17`, no -O2; Java: single-file launcher, javac inside
 * the run). Nothing local is substituted: if Piston cannot be reached the script stops and says so.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { buildProgram, splitStdout } from '../src/modules/dsa/evaluation/harness.ts';

type Lang = 'python' | 'java' | 'cpp';
type Kind = 'two-sum' | 'longest-substring';
type AlgoId = 'two-sum-hash' | 'two-sum-nested' | 'ls-window' | 'ls-quadratic';

// ------------------------------------------------------------------------------------------------ options

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? 'true'] as [string, string];
  }),
);
const opt = (k: string, d: string) => args.get(k) ?? d;
const RUN = args.get('run') === 'true';
const PROFILE = opt('profile', 'full');
const MODE = opt('mode', 'isolated');
const LIMITS = opt('limits', 'ceiling');
const WARMUP = Number(opt('warmup', PROFILE === 'smoke' ? '1' : '3'));
const REPS = Number(opt('reps', PROFILE === 'smoke' ? '3' : '30'));
const SEED = Number(opt('seed', '42'));
const LANGS = opt('langs', 'python,java,cpp').split(',') as Lang[];
const ALGOS = opt('algos', 'two-sum-hash,two-sum-nested,ls-window,ls-quadratic').split(',') as AlgoId[];
const PISTON_URL = (process.env.PISTON_URL || 'http://127.0.0.1:2000').replace(/\/+$/, '');
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = resolve(opt('out', join('benchmark-results', `dsa-fairness-${STAMP}-${MODE}-${PROFILE}`)));
const WORKERS = MODE === 'concurrent3' ? 3 : 1;

if (!['full', 'smoke'].includes(PROFILE) || !['isolated', 'concurrent3'].includes(MODE) || !['ceiling', 'production'].includes(LIMITS)) {
  throw new Error('Use --profile=full|smoke, --mode=isolated|concurrent3, --limits=ceiling|production');
}

// ------------------------------------------------------------------------------------------------ Piston request
// Same language ids / file names as PistonRunner (SPEC in piston.runner.ts).
const SPEC: Record<Lang, { language: string; file: string }> = {
  python: { language: 'python', file: 'main.py' },
  java: { language: 'java', file: 'Main.java' },
  cpp: { language: 'c++', file: 'main.cpp' },
};

const MB = 1024 * 1024;
/**
 * `ceiling` (default): the hosting Piston's own ceilings (infra/piston/piston.env), so slow points are measured up to
 * 8 s instead of being cut at the production limit. `production`: the API's current defaults (piston.runner.ts,
 * pistonOptionsFromEnv), to see what candidates get today. Neither changes any configuration.
 */
const REQUEST_LIMITS: Record<'ceiling' | 'production', Record<Lang, Record<string, number>>> = {
  ceiling: {
    python: { run_timeout: 8000, run_cpu_time: 8000, run_memory_limit: 256 * MB, compile_timeout: 15000, compile_cpu_time: 15000, compile_memory_limit: 512 * MB },
    cpp: { run_timeout: 8000, run_cpu_time: 8000, run_memory_limit: 256 * MB, compile_timeout: 15000, compile_cpu_time: 15000, compile_memory_limit: 512 * MB },
    java: { run_timeout: 8000, run_cpu_time: 8000, run_memory_limit: 512 * MB, compile_timeout: 15000, compile_cpu_time: 15000, compile_memory_limit: 512 * MB },
  },
  production: {
    python: { run_timeout: 5000, run_cpu_time: 4000, run_memory_limit: 256 * MB, compile_timeout: 10000, compile_cpu_time: 10000, compile_memory_limit: 512 * MB },
    cpp: { run_timeout: 5000, run_cpu_time: 4000, run_memory_limit: 256 * MB, compile_timeout: 10000, compile_cpu_time: 10000, compile_memory_limit: 512 * MB },
    java: { run_timeout: 8000, run_cpu_time: 7000, run_memory_limit: 512 * MB, compile_timeout: 10000, compile_cpu_time: 10000, compile_memory_limit: 512 * MB },
  },
};

// ------------------------------------------------------------------------------------------------ reference solutions
// Equivalent logic in every language (same loops, same data structure, same early exit), wrapped by the API harness.
const SOLUTIONS: Record<AlgoId, { kind: Kind; complexity: string; code: Record<Lang, string> }> = {
  'two-sum-hash': {
    kind: 'two-sum',
    complexity: 'O(n)',
    code: {
      python: `def two_sum(nums, target):
    seen = {}
    for i, x in enumerate(nums):
        if target - x in seen:
            return [seen[target - x], i]
        seen[x] = i
    return []
`,
      java: `import java.util.*;
class Solution {
    public int[] twoSum(int[] nums, int target) {
        Map<Long, Integer> seen = new HashMap<>();
        for (int i = 0; i < nums.length; i++) {
            Integer j = seen.get((long) target - nums[i]);
            if (j != null) return new int[]{j, i};
            seen.put((long) nums[i], i);
        }
        return new int[]{};
    }
}
`,
      cpp: `class Solution {
public:
    vector<int> twoSum(vector<int>& nums, int target) {
        unordered_map<long long, int> seen;
        for (int i = 0; i < (int)nums.size(); i++) {
            auto it = seen.find((long long)target - nums[i]);
            if (it != seen.end()) return {it->second, i};
            seen[nums[i]] = i;
        }
        return {};
    }
};
`,
    },
  },
  'two-sum-nested': {
    kind: 'two-sum',
    complexity: 'O(n^2)',
    code: {
      python: `def two_sum(nums, target):
    n = len(nums)
    for i in range(n):
        for j in range(i + 1, n):
            if nums[i] + nums[j] == target:
                return [i, j]
    return []
`,
      java: `class Solution {
    public int[] twoSum(int[] nums, int target) {
        int n = nums.length;
        for (int i = 0; i < n; i++) {
            for (int j = i + 1; j < n; j++) {
                if ((long) nums[i] + nums[j] == target) return new int[]{i, j};
            }
        }
        return new int[]{};
    }
}
`,
      cpp: `class Solution {
public:
    vector<int> twoSum(vector<int>& nums, int target) {
        int n = nums.size();
        for (int i = 0; i < n; i++) {
            for (int j = i + 1; j < n; j++) {
                if ((long long)nums[i] + nums[j] == target) return {i, j};
            }
        }
        return {};
    }
};
`,
    },
  },
  'ls-window': {
    kind: 'longest-substring',
    complexity: 'O(n)',
    // hash map in all three (the test fixture's C++ uses a 256-slot array; here the data structure is identical)
    code: {
      python: `def length_of_longest_substring(s):
    last = {}
    start = best = 0
    for i, ch in enumerate(s):
        if ch in last and last[ch] >= start:
            start = last[ch] + 1
        last[ch] = i
        best = max(best, i - start + 1)
    return best
`,
      java: `import java.util.*;
class Solution {
    public int lengthOfLongestSubstring(String s) {
        Map<Character, Integer> last = new HashMap<>();
        int start = 0, best = 0;
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            Integer p = last.get(c);
            if (p != null && p >= start) start = p + 1;
            last.put(c, i);
            best = Math.max(best, i - start + 1);
        }
        return best;
    }
}
`,
      cpp: `class Solution {
public:
    int lengthOfLongestSubstring(string s) {
        unordered_map<char, int> last;
        int start = 0, best = 0;
        for (int i = 0; i < (int)s.size(); i++) {
            char c = s[i];
            auto it = last.find(c);
            if (it != last.end() && it->second >= start) start = it->second + 1;
            last[c] = i;
            best = max(best, i - start + 1);
        }
        return best;
    }
};
`,
    },
  },
  'ls-quadratic': {
    kind: 'longest-substring',
    complexity: 'O(n^2)',
    // every substring start, scanning to the end WITHOUT an early exit: genuinely quadratic. (The usual "stop at the
    // first repeat" brute force is only O(n * alphabet) on these inputs - see the report.)
    code: {
      python: `def length_of_longest_substring(s):
    n = len(s)
    best = 0
    for i in range(n):
        seen = set()
        dup = False
        for j in range(i, n):
            if s[j] in seen:
                dup = True
            seen.add(s[j])
            if not dup and j - i + 1 > best:
                best = j - i + 1
    return best
`,
      java: `import java.util.*;
class Solution {
    public int lengthOfLongestSubstring(String s) {
        int n = s.length(), best = 0;
        for (int i = 0; i < n; i++) {
            Set<Character> seen = new HashSet<>();
            boolean dup = false;
            for (int j = i; j < n; j++) {
                char c = s.charAt(j);
                if (seen.contains(c)) dup = true;
                seen.add(c);
                if (!dup && j - i + 1 > best) best = j - i + 1;
            }
        }
        return best;
    }
}
`,
      cpp: `class Solution {
public:
    int lengthOfLongestSubstring(string s) {
        int n = s.size(), best = 0;
        for (int i = 0; i < n; i++) {
            unordered_set<char> seen;
            bool dup = false;
            for (int j = i; j < n; j++) {
                char c = s[j];
                if (seen.count(c)) dup = true;
                seen.insert(c);
                if (!dup && j - i + 1 > best) best = j - i + 1;
            }
        }
        return best;
    }
};
`,
    },
  },
};

// ------------------------------------------------------------------------------------------------ datasets
// Identical stdin for every language, in the harness' format (mock-questions.data.ts): "<n> v1 .. vn" then target.
interface Dataset {
  id: string;
  kind: Kind;
  n: number;
  /** within the problem's stated constraint (a test-size point) or only used to fit the growth curve */
  role: 'baseline' | 'test-size' | 'fit-only';
  stdin: string;
  expected: string;
}

/** Values 1..n, target 2n-1: the only pair is the LAST two indices, so nested loops do the full n(n-1)/2 work. */
function twoSum(n: number, role: Dataset['role']): Dataset {
  const nums = Array.from({ length: n }, (_, i) => i + 1);
  return { id: `ts-n${n}`, kind: 'two-sum', n, role, stdin: `${[n, ...nums].join(' ')}\n${2 * n - 1}\n`, expected: `[${n - 2},${n - 1}]` };
}

const PRINTABLE = Array.from({ length: 94 }, (_, i) => String.fromCharCode(33 + i)).join(''); // '!'..'~', no spaces
const LETTERS = 'abcdefghijklmnopqrstuvwxyz';
function longestSubstring(n: number, alphabet: string, name: string, role: Dataset['role']): Dataset {
  const s = alphabet.repeat(Math.ceil(n / alphabet.length)).slice(0, n);
  return { id: `ls-${name}-n${n}`, kind: 'longest-substring', n, role, stdin: `${s}\n`, expected: String(Math.min(n, alphabet.length)) };
}

const TWO_SUM_SIZES: [number, Dataset['role']][] =
  PROFILE === 'smoke' ? [[2, 'baseline'], [1000, 'test-size'], [10000, 'test-size']] : [[2, 'baseline'], [10, 'test-size'], [1000, 'test-size'], [5000, 'test-size'], [10000, 'test-size'], [20000, 'fit-only'], [40000, 'fit-only']];
const LS_SIZES: [number, Dataset['role']][] =
  PROFILE === 'smoke' ? [[1000, 'test-size'], [50000, 'test-size']] : [[10, 'test-size'], [1000, 'test-size'], [10000, 'test-size'], [50000, 'test-size'], [100000, 'fit-only'], [200000, 'fit-only']];

const DATASETS: Dataset[] = [
  ...TWO_SUM_SIZES.map(([n, role]) => twoSum(n, role)),
  longestSubstring(2, 'ab', 'baseline', 'baseline'),
  ...LS_SIZES.flatMap(([n, role]) => [longestSubstring(n, PRINTABLE, 'distinct94', role), longestSubstring(n, LETTERS, 'alpha26', role)]),
];

// ------------------------------------------------------------------------------------------------ plan
interface Point {
  key: string;
  lang: Lang;
  algo: AlgoId;
  dataset: Dataset;
  source: string;
}

const points: Point[] = [];
for (const lang of LANGS) {
  for (const algo of ALGOS) {
    const sol = SOLUTIONS[algo];
    if (!sol) throw new Error(`unknown algorithm ${algo}`);
    const source = buildProgram(lang, sol.kind, sol.code[lang]).source; // exactly what candidates' code runs inside
    for (const dataset of DATASETS.filter((d) => d.kind === sol.kind)) {
      points.push({ key: `${lang}|${algo}|${dataset.id}`, lang, algo, dataset, source });
    }
  }
}

// deterministic shuffle (mulberry32): languages and solutions interleaved, same order for the same --seed
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffle<T>(xs: T[], rand: () => number): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const maxExecutions = points.length * (WARMUP + REPS);

// ------------------------------------------------------------------------------------------------ execution
interface StageOut {
  cpu_ms: number | null;
  wall_ms: number | null;
  memory_bytes: number | null;
  code: number | null;
  signal: string | null;
  status: string | null;
  message: string | null;
}
interface Sample {
  point: string;
  lang: Lang;
  algo: AlgoId;
  complexity: string;
  dataset: string;
  n: number;
  role: Dataset['role'];
  phase: 'warmup' | 'measure';
  rep: number;
  mode: string;
  workers: number;
  limits: string;
  runtimeVersion: string | null;
  startedAt: string;
  clientMs: number;
  httpStatus: number | null;
  infraError: string | null;
  compile: StageOut | null;
  run: StageOut | null;
  correct: boolean | null;
}

const stageOf = (s: Record<string, unknown> | undefined): StageOut | null =>
  s
    ? {
        cpu_ms: typeof s.cpu_time === 'number' ? s.cpu_time : null,
        wall_ms: typeof s.wall_time === 'number' ? s.wall_time : null,
        memory_bytes: typeof s.memory === 'number' ? s.memory : null,
        code: typeof s.code === 'number' ? s.code : null,
        signal: typeof s.signal === 'string' ? s.signal : null,
        status: typeof s.status === 'string' ? s.status : null,
        message: typeof s.message === 'string' ? s.message.slice(0, 200) : null,
      }
    : null;

async function execute(p: Point, phase: Sample['phase'], rep: number): Promise<Sample> {
  const spec = SPEC[p.lang];
  const started = new Date();
  const t0 = performance.now();
  const base: Omit<Sample, 'clientMs' | 'httpStatus' | 'infraError' | 'compile' | 'run' | 'correct' | 'runtimeVersion'> = {
    point: p.key,
    lang: p.lang,
    algo: p.algo,
    complexity: SOLUTIONS[p.algo].complexity,
    dataset: p.dataset.id,
    n: p.dataset.n,
    role: p.dataset.role,
    phase,
    rep,
    mode: MODE,
    workers: WORKERS,
    limits: LIMITS,
    startedAt: started.toISOString(),
  };
  try {
    const res = await fetch(`${PISTON_URL}/api/v2/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        language: spec.language,
        version: '*', // as in production (one version per language is installed; the resolved one is recorded)
        files: [{ name: spec.file, content: p.source }],
        stdin: p.dataset.stdin,
        ...REQUEST_LIMITS[LIMITS as 'ceiling' | 'production'][p.lang],
      }),
      signal: AbortSignal.timeout(120_000),
    });
    const clientMs = Math.round(performance.now() - t0);
    if (!res.ok) {
      return { ...base, clientMs, httpStatus: res.status, infraError: `HTTP ${res.status}`, compile: null, run: null, correct: null, runtimeVersion: null };
    }
    const body = (await res.json()) as { version?: string; compile?: Record<string, unknown>; run?: Record<string, unknown> };
    const run = stageOf(body.run);
    const stdout = typeof body.run?.stdout === 'string' ? body.run.stdout : '';
    const { result } = splitStdout(stdout, p.dataset.kind);
    const correct = run && run.status === null && run.code === 0 ? (result ?? '').trim() === p.dataset.expected : null;
    return { ...base, clientMs, httpStatus: res.status, infraError: null, compile: stageOf(body.compile), run, correct, runtimeVersion: body.version ?? null };
  } catch (err) {
    return {
      ...base,
      clientMs: Math.round(performance.now() - t0),
      httpStatus: null,
      infraError: err instanceof Error ? `${err.name}: ${err.message}`.slice(0, 200) : 'unknown',
      compile: null,
      run: null,
      correct: null,
      runtimeVersion: null,
    };
  }
}

/** Runs the jobs with WORKERS at once (1 = isolated, 3 = the production concurrency cap). */
async function pool<T>(jobs: (() => Promise<T>)[], onDone: (n: number) => void): Promise<T[]> {
  const out: T[] = new Array(jobs.length);
  let next = 0;
  let done = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= jobs.length) return;
      out[i] = await jobs[i]();
      onDone(++done);
    }
  };
  await Promise.all(Array.from({ length: Math.min(WORKERS, jobs.length) }, worker));
  return out;
}

// ------------------------------------------------------------------------------------------------ statistics
// Summaries are rounded to 2 decimals (Piston reports CPU time as a float, e.g. 2043.0000000000002); raw.json keeps
// every value exactly as Piston returned it.
const r2 = (x: number) => Math.round(x * 100) / 100;
const pct = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
function stats(values: (number | null)[]) {
  const v = values.filter((x): x is number => typeof x === 'number').sort((a, b) => a - b);
  if (!v.length) return null;
  const mean = v.reduce((s, x) => s + x, 0) / v.length;
  const sd = Math.sqrt(v.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(1, v.length - 1));
  return {
    n: v.length,
    median: r2(pct(v, 50)),
    p5: r2(pct(v, 5)),
    p95: r2(pct(v, 95)),
    p99: r2(pct(v, 99)),
    min: r2(v[0]),
    max: r2(v[v.length - 1]),
    mean: r2(mean),
    cv: mean ? Math.round((sd / mean) * 1000) / 1000 : null,
  };
}

/** One row per benchmark point, built from the samples themselves (so a saved raw.json can be summarised again). */
function summarize(samples: Sample[], censoredKeys: Set<string>) {
  const order: string[] = [];
  const first = new Map<string, Sample>();
  for (const s of samples) {
    if (!first.has(s.point)) {
      first.set(s.point, s);
      order.push(s.point);
    }
  }
  const byPoint = new Map<string, Sample[]>();
  for (const s of samples.filter((x) => x.phase === 'measure')) byPoint.set(s.point, [...(byPoint.get(s.point) ?? []), s]);
  return order.map((key) => {
    const p = first.get(key)!;
    const xs = byPoint.get(key) ?? [];
    const ok = xs.filter((s) => !s.infraError && s.run);
    const statuses: Record<string, number> = {};
    for (const s of xs) {
      const k = s.infraError ? 'INFRA_ERROR' : s.run?.status ?? (s.correct ? 'OK' : 'WRONG_OR_NO_RESULT');
      statuses[k] = (statuses[k] ?? 0) + 1;
    }
    return {
      point: key,
      lang: p.lang,
      algo: p.algo,
      complexity: p.complexity,
      dataset: p.dataset,
      n: p.n,
      role: p.role,
      censored: censoredKeys.has(key) || xs.length === 0 ? 'skipped (warm-ups timed out)' : null,
      samples: xs.length,
      statuses,
      correctRuns: ok.filter((s) => s.correct === true).length,
      runCpuMs: stats(ok.map((s) => s.run!.cpu_ms)),
      runWallMs: stats(ok.map((s) => s.run!.wall_ms)),
      runMemoryMB: stats(ok.map((s) => (s.run!.memory_bytes === null ? null : Math.round((s.run!.memory_bytes / MB) * 10) / 10))),
      compileCpuMs: stats(ok.map((s) => s.compile?.cpu_ms ?? null)),
      compileWallMs: stats(ok.map((s) => s.compile?.wall_ms ?? null)),
      clientMs: stats(xs.map((s) => s.clientMs)),
    };
  });
}

type Row = ReturnType<typeof summarize>[number];

/** The accepted (O(n)) and the rejected (O(n^2)) reference of each problem. */
const PAIRS: Record<Kind, { accepted: AlgoId; rejected: AlgoId }> = {
  'two-sum': { accepted: 'two-sum-hash', rejected: 'two-sum-nested' },
  'longest-substring': { accepted: 'ls-window', rejected: 'ls-quadratic' },
};

/**
 * Can a time limit tell the two complexity classes apart, per language, at the MAXIMUM test size of each problem?
 * Separable on a metric when the rejected class's p5 is above the accepted class's p95 (or the rejected class timed out
 * at the benchmark limit: censored). Both CPU and wall time are shown: Piston's CPU time adds up every thread, which
 * for Java includes javac, the JIT and the GC (CPU > wall even for n = 2), so for Java the PRIMARY metric is wall time.
 * Net values subtract the language's n = 2 baseline median (startup / javac overhead) to show the algorithm's own cost.
 * No noise margin is applied here: that is a decision for the limit policy (use CV and the isolated vs concurrent runs).
 */
function separability(rows: Row[]) {
  const find = (lang: Lang, algo: AlgoId, dataset: string) => rows.find((r) => r.lang === lang && r.algo === algo && r.dataset === dataset);
  const out: {
    lang: Lang;
    problem: Kind;
    dataset: string;
    n: number;
    metric: 'runCpuMs' | 'runWallMs';
    primary: boolean;
    acceptedP95: number | null;
    rejectedP5: number | 'censored' | null;
    ratio: number | null;
    netAcceptedP95: number | null;
    netRejectedP5: number | 'censored' | null;
    separable: boolean | null;
  }[] = [];
  const langs = [...new Set(rows.map((r) => r.lang))];
  for (const lang of langs) {
    for (const problem of Object.keys(PAIRS) as Kind[]) {
      const { accepted, rejected } = PAIRS[problem];
      const accRows = rows.filter((r) => r.lang === lang && r.algo === accepted && r.role === 'test-size');
      if (!accRows.length) continue;
      const maxN = Math.max(...accRows.map((r) => r.n));
      const baseline = rows.find((r) => r.lang === lang && r.algo === accepted && r.role === 'baseline');
      for (const acc of accRows.filter((r) => r.n === maxN)) {
        const rej = find(lang, rejected, acc.dataset);
        if (!rej) continue;
        for (const metric of ['runCpuMs', 'runWallMs'] as const) {
          const aP95 = acc[metric]?.p95 ?? null;
          const rP5: number | 'censored' | null = rej.censored ? 'censored' : (rej[metric]?.p5 ?? null);
          const base = baseline?.[metric]?.median ?? null;
          const separable = rP5 === 'censored' ? true : aP95 !== null && rP5 !== null ? rP5 > aP95 : null;
          out.push({
            lang,
            problem,
            dataset: acc.dataset,
            n: acc.n,
            metric,
            primary: lang === 'java' ? metric === 'runWallMs' : metric === 'runCpuMs',
            acceptedP95: aP95,
            rejectedP5: rP5,
            ratio: typeof rP5 === 'number' && aP95 ? r2(rP5 / aP95) : null,
            netAcceptedP95: aP95 !== null && base !== null ? r2(aP95 - base) : null,
            netRejectedP5: rP5 === 'censored' ? 'censored' : rP5 !== null && base !== null ? r2(rP5 - base) : null,
            separable,
          });
        }
      }
    }
  }
  return out;
}

function markdown(summary: Row[], meta: Record<string, unknown>): string {
  const f = (s: ReturnType<typeof stats>) => (s ? `${s.median} / ${s.p95} / ${s.p99} / ${s.min}-${s.max} / ${s.cv}` : '-');
  const sep = separability(summary);
  const yes = (b: boolean | null) => (b === null ? 'unknown' : b ? 'yes' : 'NO');
  const lines = [
    '# DSA fairness benchmark',
    '',
    '```json',
    JSON.stringify(meta, null, 2),
    '```',
    '',
    'Columns: median / p95 / p99 / min-max / CV (coefficient of variation). Times in ms (Piston-reported). With 30',
    'samples p99 is effectively the maximum. "censored": every warm-up hit the limit, so no measured runs were made.',
    '',
    '| lang | algorithm | dataset | n | role | statuses | correct | run CPU ms | run wall ms | compile wall ms (C++) | memory MB |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
    ...summary.map(
      (r) =>
        `| ${r.lang} | ${r.algo} ${r.complexity} | ${r.dataset} | ${r.n} | ${r.role} | ${r.censored ?? JSON.stringify(r.statuses)} | ${r.correctRuns}/${r.samples} | ${f(r.runCpuMs)} | ${f(r.runWallMs)} | ${f(r.compileWallMs)} | ${r.runMemoryMB ? r.runMemoryMB.median : '-'} |`,
    ),
    '',
    '## Complexity separability at the maximum test size',
    '',
    'Accepted = O(n) reference, rejected = O(n^2) reference, same dataset. Separable when the rejected p5 is above the',
    'accepted p95, or the rejected class timed out at the benchmark limit ("censored"). **Primary metric: CPU time for',
    'Python and C++, WALL time for Java** (Piston\'s CPU time adds up all threads; Java\'s includes javac, the JIT and the GC,',
    'so it exceeds wall time even for n = 2). Net = minus the language\'s n = 2 baseline median. No noise margin applied.',
    '',
    '| lang | problem | dataset | n | metric | primary | accepted p95 | rejected p5 | ratio | net accepted p95 | net rejected p5 | separable |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|',
    ...sep.map(
      (s) =>
        `| ${s.lang} | ${s.problem} | ${s.dataset} | ${s.n} | ${s.metric === 'runWallMs' ? 'wall' : 'CPU'} | ${s.primary ? '**yes**' : 'no'} | ${s.acceptedP95 ?? '-'} | ${s.rejectedP5 ?? '-'} | ${s.ratio ?? '-'} | ${s.netAcceptedP95 ?? '-'} | ${s.netRejectedP5 ?? '-'} | ${yes(s.separable)} |`,
    ),
  ];
  return lines.join('\n') + '\n';
}

/** Rebuilds summary.json / summary.md from a saved raw.json. No Piston call at all. */
function summarizeFrom(rawPath: string, outDir: string) {
  const { meta, samples } = JSON.parse(readFileSync(rawPath, 'utf8')) as { meta: Record<string, unknown>; samples: Sample[] };
  const censored = new Set<string>(Array.isArray(meta.censoredPoints) ? (meta.censoredPoints as string[]) : []);
  const summary = summarize(samples, censored);
  const fullMeta = { ...meta, summarizedAt: new Date().toISOString(), summarizedFrom: rawPath };
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'summary.json'), JSON.stringify({ meta: fullMeta, summary, separability: separability(summary) }, null, 1));
  writeFileSync(join(outDir, 'summary.md'), markdown(summary, fullMeta));
  console.log(`summaries rebuilt from ${rawPath} (${samples.length} samples, ${summary.length} points) -> ${outDir}; no Piston call`);
}

// ------------------------------------------------------------------------------------------------ main
async function runtimes(): Promise<Record<string, string>> {
  const res = await fetch(`${PISTON_URL}/api/v2/runtimes`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Piston answered HTTP ${res.status} on /api/v2/runtimes`);
  const list = (await res.json()) as { language: string; version: string }[];
  return Object.fromEntries(list.filter((r) => ['python', 'java', 'c++'].includes(r.language)).map((r) => [r.language, r.version]));
}

async function main() {
  // --summarize-from=<raw.json>: rebuild the summaries of an earlier run; no Piston call, no job
  const from = args.get('summarize-from');
  if (from) {
    const raw = resolve(from);
    summarizeFrom(raw, args.has('out') ? OUT : dirname(raw));
    return;
  }
  console.log(`DSA fairness benchmark - profile=${PROFILE} mode=${MODE} (${WORKERS} job(s) at once) limits=${LIMITS}`);
  console.log(`languages=${LANGS.join(',')} algorithms=${ALGOS.join(',')} warm-up=${WARMUP} measured=${REPS} seed=${SEED}`);
  console.log(`benchmark points: ${points.length} (${DATASETS.length} datasets); at most ${maxExecutions} Piston executions`);
  console.log('(a point whose warm-ups ALL hit the time limit is recorded as censored and not measured, so the real count is lower)');

  let versions: Record<string, string>;
  try {
    versions = await runtimes();
  } catch (err) {
    console.error(`\nCannot reach the hosting Piston at ${PISTON_URL} (${err instanceof Error ? err.message : err}).`);
    console.error('Start it (infra/piston/start-piston.ps1) or set PISTON_URL. Nothing local is substituted.');
    process.exitCode = 2;
    return;
  }
  console.log(`Piston runtimes: ${JSON.stringify(versions)}`);
  if (!RUN) {
    console.log('\nDRY RUN: nothing was executed. Add --run to start the jobs.');
    return;
  }

  mkdirSync(OUT, { recursive: true });
  const rand = rng(SEED);
  const samples: Sample[] = [];
  const t0 = Date.now();
  const progress = (label: string, total: number) => (n: number) => {
    if (n % 25 === 0 || n === total) console.log(`  ${label}: ${n}/${total} (${Math.round((Date.now() - t0) / 1000)} s)`);
  };

  // 1) warm-ups for every point, interleaved
  const warm = shuffle(points.flatMap((p) => Array.from({ length: WARMUP }, (_, r) => ({ p, r }))), rand);
  console.log(`\nwarm-up: ${warm.length} executions`);
  samples.push(...(await pool(warm.map(({ p, r }) => () => execute(p, 'warmup', r)), progress('warm-up', warm.length))));

  // a point is censored when every warm-up timed out (status TO): measuring it 30 more times only burns runner time
  const censored = new Set(
    points
      .filter((p) => {
        const w = samples.filter((s) => s.point === p.key && s.phase === 'warmup');
        return w.length > 0 && w.every((s) => s.run?.status === 'TO');
      })
      .map((p) => p.key),
  );

  // 2) measured runs, interleaved across languages / solutions / sizes
  const measure = shuffle(points.filter((p) => !censored.has(p.key)).flatMap((p) => Array.from({ length: REPS }, (_, r) => ({ p, r }))), rand);
  console.log(`measured: ${measure.length} executions (${censored.size} censored point(s) skipped)`);
  samples.push(...(await pool(measure.map(({ p, r }) => () => execute(p, 'measure', r)), progress('measured', measure.length))));

  const meta = {
    createdAt: new Date().toISOString(),
    pistonUrl: PISTON_URL,
    runtimes: versions,
    profile: PROFILE,
    mode: MODE,
    workers: WORKERS,
    limits: LIMITS,
    requestLimits: REQUEST_LIMITS[LIMITS as 'ceiling' | 'production'],
    warmup: WARMUP,
    reps: REPS,
    seed: SEED,
    points: points.length,
    executions: samples.length,
    censoredPoints: [...censored],
    durationSec: Math.round((Date.now() - t0) / 1000),
    notes: [
      'C++ is compiled by Piston as `g++ -std=c++17` (no -O2); Java runs the single-file launcher (javac inside the run stage).',
      'Times are Piston-reported per stage; clientMs is the HTTP round trip seen by this script (includes queueing).',
    ],
  };
  const summary = summarize(samples, censored);
  writeFileSync(join(OUT, 'raw.json'), JSON.stringify({ meta, samples }, null, 1));
  writeFileSync(join(OUT, 'summary.json'), JSON.stringify({ meta, summary, separability: separability(summary) }, null, 1));
  writeFileSync(join(OUT, 'summary.md'), markdown(summary, meta));
  const wrong = samples.filter((s) => s.correct === false).length;
  const infra = samples.filter((s) => s.infraError).length;
  console.log(`\ndone in ${meta.durationSec} s: ${samples.length} executions, ${wrong} wrong answer(s), ${infra} infrastructure error(s)`);
  console.log(`results: ${OUT}`);
}

await main();
