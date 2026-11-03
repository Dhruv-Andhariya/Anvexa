import { PistonRunner, pistonOptionsFromEnv } from '../src/modules/dsa/execution/piston.runner';
import { defineExecutionSuite } from './support/execution-suite';

/**
 * Live tests against the Piston instance on this machine (PISTON_URL, default http://127.0.0.1:2000), through the
 * real harnesses, evaluator and scoring, for all three questions in Python, Java and C++.
 * Probes with a REAL execution (reachability alone is not enough). If Piston cannot execute code the suite is skipped
 * with the reason printed. A skip is NOT a pass.
 *
 * Start Piston first: infra/piston/start-piston.ps1 (docs/dsa-piston-hosting.md).
 */
const options = pistonOptionsFromEnv();

async function probe(): Promise<string | null> {
  try {
    const [res] = await new PistonRunner(options).runBatch([{ language: 'python', source: 'print("ok")', stdin: '' }]);
    if (res.verdict === 'ok' && res.stdout.trim() === 'ok') return null;
    return `Piston is reachable but cannot run code: ${res.statusText} ${res.stderr}`.trim();
  } catch (err) {
    return `Piston request failed: ${err instanceof Error ? `${err.message} (${(err as { detail?: string }).detail ?? ''})` : String(err)}`;
  }
}

const skipReason = await probe();
defineExecutionSuite('DSA through the live Piston runner', () => new PistonRunner(options), skipReason);
