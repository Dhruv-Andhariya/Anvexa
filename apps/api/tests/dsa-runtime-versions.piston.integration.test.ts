import { describe, expect, it } from 'vitest';
import { CodeRunnerUnavailableError, type RunnerJob } from '../src/modules/dsa/execution/code-runner';
import { PISTON_RUNTIMES, PistonRunner, pistonOptionsFromEnv } from '../src/modules/dsa/execution/piston.runner';

/**
 * Live check of the pinned runtimes on the installed Piston: one tiny program per language through the real
 * PistonRunner, reading the version Piston actually RESOLVED from its reply. Skipped (reason printed) when Piston is
 * not reachable. A skip is NOT a pass.
 */
const base = pistonOptionsFromEnv();
let reachable: string | null = null;
try {
  const res = await fetch(`${base.baseUrl}/api/v2/runtimes`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) reachable = `Piston answered HTTP ${res.status}`;
} catch (err) {
  reachable = `Piston not reachable: ${err instanceof Error ? err.message : String(err)}`;
}
if (reachable) console.warn(`[pinned runtimes on the live Piston] SKIPPED: ${reachable}`);

const PROGRAMS: Record<RunnerJob['language'], string> = {
  python: 'print(sum(map(int, input().split())))',
  java: 'public class Main { public static void main(String[] a) { java.util.Scanner s = new java.util.Scanner(System.in); System.out.println(s.nextInt() + s.nextInt()); } }',
  cpp: '#include <iostream>\nint main(){ int a,b; std::cin>>a>>b; std::cout<<a+b<<std::endl; }',
};

describe.skipIf(!!reachable)('pinned runtimes on the live Piston', () => {
  it.each(Object.keys(PROGRAMS) as RunnerJob['language'][])('%s: runs on exactly the pinned version', async (lang) => {
    const resolved: { language?: string; version?: string }[] = [];
    const sent: { version?: string }[] = [];
    const recordingFetch = (async (url: string, init: RequestInit) => {
      sent.push(JSON.parse(init.body as string));
      const res = await fetch(url, init);
      resolved.push(await res.clone().json());
      return res;
    }) as unknown as typeof fetch;
    const [r] = await new PistonRunner({ ...base, fetch: recordingFetch }).runBatch([{ language: lang, source: PROGRAMS[lang], stdin: '2 3\n' }]);
    expect(r.verdict).toBe('ok');
    expect(r.stdout.trim()).toBe('5');
    expect(sent[0].version).toBe(PISTON_RUNTIMES[lang].version);
    expect(resolved[0]).toMatchObject({ language: PISTON_RUNTIMES[lang].language, version: PISTON_RUNTIMES[lang].version });
  }, 60_000);

  it('a version that is not installed is refused by Piston and reported as a runner failure (nothing runs)', async () => {
    const wrongVersion = (async (url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      return fetch(url, { ...init, body: JSON.stringify({ ...body, version: '3.11.0' }) });
    }) as unknown as typeof fetch;
    const err = await new PistonRunner({ ...base, fetch: wrongVersion }).runBatch([{ language: 'python', source: 'print(1)', stdin: '' }]).catch((e) => e);
    expect(err).toBeInstanceOf(CodeRunnerUnavailableError);
  }, 60_000);
});
