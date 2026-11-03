import { execFile } from 'node:child_process';
import { freemem, totalmem } from 'node:os';
import { describe, expect, it } from 'vitest';
import { DsaService } from '../src/modules/dsa/dsa.service';
import { PistonRunner, pistonOptionsFromEnv } from '../src/modules/dsa/execution/piston.runner';
import { MockQuestionRepository } from '../src/modules/dsa/questions/mock-question.repository';
import { MOCK_QUESTIONS } from '../src/modules/dsa/questions/mock-questions.data';
import type { Language } from '../src/modules/dsa/questions/question.types';
import type { DsaInvitation, InvitationResolver } from '../src/modules/dsa/session/invitation.resolver';
import { InMemorySessionStore } from '../src/modules/dsa/session/session.store';
import { CORRECT } from './dsa-fixtures';

/**
 * OPT-IN load test, against the real Piston on this machine:
 *   DSA_LOAD_STUDENTS=10 DSA_LOAD_LANG=java DSA_LOAD_QUESTION=dsa-002 pnpm exec vitest run tests/dsa-piston-load.test.ts
 * N students press Submit at the same moment (one question, one language, or `mixed` = Python/Java/C++ in turn).
 * It reports how long each took, how many were refused as "busy", and the peak memory use of the machine and of
 * the Piston container. Each student must still get the right score: speed never costs correctness.
 */
const N = Number(process.env.DSA_LOAD_STUDENTS || 0);
const LANG = process.env.DSA_LOAD_LANG || 'mixed';
const QUESTION = process.env.DSA_LOAD_QUESTION || 'dsa-001';

class ManyStudents implements InvitationResolver {
  async resolve(token: string): Promise<DsaInvitation | null> {
    return { token, assessmentId: 'load', candidateName: token, durationMinutes: 60 };
  }
}

const sh = (cmd: string, args: string[]) =>
  new Promise<string>((resolve) => execFile(cmd, args, { timeout: 8000 }, (_e, out) => resolve(String(out ?? '').trim())));

const pct = (xs: number[], p: number) => xs.slice().sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))];

describe.skipIf(!N)('Piston under load', () => {
  it(`${N} students submit ${QUESTION} (${LANG}) at the same moment`, async () => {
    const runner = new PistonRunner(pistonOptionsFromEnv());
    const service = new DsaService(new ManyStudents(), new MockQuestionRepository(), new InMemorySessionStore(), runner);
    const question = MOCK_QUESTIONS.find((q) => q.id === QUESTION)!;
    const langs: Language[] = ['python', 'java', 'cpp'];
    const students = Array.from({ length: N }, (_, i) => ({
      token: `student-${i}`,
      language: (LANG === 'mixed' ? langs[i % 3] : LANG) as Language,
    }));
    await Promise.all(students.map((s) => service.start(s.token)));

    // sample machine memory and the Piston container while the burst runs
    let minFreeGb = freemem() / 1e9;
    let peakContainer = '';
    let peakContainerMb = 0;
    let peakCpu = 0;
    const sampler = setInterval(() => {
      minFreeGb = Math.min(minFreeGb, freemem() / 1e9);
    }, 250);
    const dockerSampler = setInterval(async () => {
      const out = await sh('docker', ['stats', '--no-stream', '--format', '{{.MemUsage}}|{{.CPUPerc}}', 'hireflow-piston']);
      const [mem, cpu] = out.split('|');
      const mb = Number.parseFloat(mem) * (/GiB/.test(mem ?? '') ? 1024 : 1);
      if (mb > peakContainerMb) { peakContainerMb = mb; peakContainer = mem; }
      peakCpu = Math.max(peakCpu, Number.parseFloat(cpu) || 0);
    }, 1500);

    const started = Date.now();
    const outcomes = await Promise.all(
      students.map(async (s) => {
        const t0 = Date.now();
        try {
          const res = await service.submit(s.token, { questionId: QUESTION, language: s.language, code: CORRECT[QUESTION][s.language] });
          return { s, ms: Date.now() - t0, kind: res.score === res.maxScore ? 'correct' : `WRONG(${res.verdict} ${res.passed}/${res.total})` };
        } catch (e) {
          const code = (e as { response?: { code?: string } }).response?.code ?? (e as Error).message;
          return { s, ms: Date.now() - t0, kind: code === 'CODE_RUNNER_BUSY' ? 'busy' : `ERROR(${code})` };
        }
      }),
    );
    const wall = Date.now() - started;
    clearInterval(sampler);
    clearInterval(dockerSampler);

    const count = (k: string) => outcomes.filter((o) => o.kind === k).length;
    const okMs = outcomes.filter((o) => o.kind === 'correct').map((o) => o.ms);
    const cases = question.testCases.length;
    const report = [
      `LOAD RESULT  students=${N}  lang=${LANG}  question=${QUESTION} (${cases} test cases)  runner cap=${pistonOptionsFromEnv().concurrency} at once`,
      `  all finished after ${(wall / 1000).toFixed(1)} s`,
      `  correct: ${count('correct')}   busy-refused: ${count('busy')}   wrong: ${outcomes.filter((o) => o.kind.startsWith('WRONG')).length}   errors: ${outcomes.filter((o) => o.kind.startsWith('ERROR')).length}`,
      okMs.length ? `  time to result for correct ones: min ${(Math.min(...okMs) / 1000).toFixed(1)} s, median ${(pct(okMs, 50) / 1000).toFixed(1)} s, p95 ${(pct(okMs, 95) / 1000).toFixed(1)} s, max ${(Math.max(...okMs) / 1000).toFixed(1)} s` : '  (no correct results)',
      ...(LANG === 'mixed'
        ? (['python', 'java', 'cpp'] as Language[]).map((l) => {
            const xs = outcomes.filter((o) => o.s.language === l && o.kind === 'correct').map((o) => o.ms);
            return xs.length ? `    ${l}: n=${xs.length} median ${(pct(xs, 50) / 1000).toFixed(1)} s, max ${(Math.max(...xs) / 1000).toFixed(1)} s` : `    ${l}: no results`;
          })
        : []),
      `  machine RAM: lowest free ${minFreeGb.toFixed(2)} GB of ${(totalmem() / 1e9).toFixed(1)} GB`,
      `  Piston container: peak memory ${peakContainer || 'n/a'}, peak CPU ${peakCpu.toFixed(0)}%`,
      `  failures: ${[...new Set(outcomes.filter((o) => o.kind !== 'correct' && o.kind !== 'busy').map((o) => o.kind))].join(', ') || 'none'}`,
    ];
    console.log('\n' + report.join('\n') + '\n');

    // correctness is not negotiable; being refused as "busy" is an acceptable, visible outcome
    expect(outcomes.filter((o) => o.kind.startsWith('WRONG') || o.kind.startsWith('ERROR'))).toEqual([]);
  }, 900_000);
});
