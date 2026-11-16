import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CodeRunnerUnavailableError, type RunnerJob } from '../src/modules/dsa/execution/code-runner';
import { PISTON_RUNTIMES, PistonRunner, pistonOptionsFromEnv } from '../src/modules/dsa/execution/piston.runner';

/** Runtime versions are pinned: the API asks Piston for exact versions, the same ones the start script installs. */
const options = (fetchImpl: typeof fetch) => ({ ...pistonOptionsFromEnv({}), baseUrl: 'http://piston.internal:2000', fetch: fetchImpl });
const stage = { stdout: '1\n', stderr: '', output: '1\n', code: 0, signal: null, message: null, status: null, cpu_time: 1, wall_time: 1, memory: 1 };

describe('Piston runtime versions', () => {
  it('pins exactly Python 3.12.0, Java 15.0.2 and C++ (gcc) 10.2.0', () => {
    expect(PISTON_RUNTIMES).toEqual({
      python: { language: 'python', version: '3.12.0', file: 'main.py' },
      java: { language: 'java', version: '15.0.2', file: 'Main.java' },
      cpp: { language: 'c++', version: '10.2.0', file: 'main.cpp' },
    });
    for (const r of Object.values(PISTON_RUNTIMES)) expect(r.version).toMatch(/^\d+\.\d+\.\d+$/); // never '*' or a range
  });

  it.each(Object.entries(PISTON_RUNTIMES))('a %s run asks Piston for exactly that version', async (lang, spec) => {
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string));
      return new Response(JSON.stringify({ language: spec.language, version: spec.version, run: stage }));
    }) as unknown as typeof fetch;
    await new PistonRunner(options(fetchImpl)).runBatch([{ language: lang as RunnerJob['language'], source: 'x', stdin: '' }]);
    expect(bodies[0]).toMatchObject({ language: spec.language, version: spec.version });
  });

  it('matches the packages infra/piston/start-piston.ps1 installs (the gcc package provides c++)', () => {
    const script = readFileSync(join(__dirname, '..', '..', '..', 'infra', 'piston', 'start-piston.ps1'), 'utf8');
    const line = script.split('\n').find((l) => l.trim().startsWith('$Packages ='))!;
    const installed = Object.fromEntries([...line.matchAll(/@\('([\w+]+)',\s*'([\d.]+)'\)/g)].map((m) => [m[1], m[2]]));
    expect(installed).toEqual({ python: '3.12.0', java: '15.0.2', gcc: '10.2.0' });
    expect(PISTON_RUNTIMES.python.version).toBe(installed.python);
    expect(PISTON_RUNTIMES.java.version).toBe(installed.java);
    expect(PISTON_RUNTIMES.cpp.version).toBe(installed.gcc);
    expect(script).not.toMatch(/version\s*=\s*'\*'/); // its smoke test asks for the pinned versions too
  });

  it('a version Piston does not have (HTTP 400) is a runner failure, never the candidate\'s error', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ message: 'python-3.12.0 runtime is unknown' }), { status: 400 })) as unknown as typeof fetch;
    const err = await new PistonRunner(options(fetchImpl)).runBatch([{ language: 'python', source: 'x', stdin: '' }]).catch((e) => e);
    expect(err).toBeInstanceOf(CodeRunnerUnavailableError);
  });
});
