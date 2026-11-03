import { Judge0Client, judge0OptionsFromEnv } from '../src/modules/dsa/judge0/judge0.client';
import { defineExecutionSuite } from './support/execution-suite';

/**
 * Live tests against the local Judge0 CE instance (JUDGE0_URL, default http://localhost:2358).
 * Probes with a REAL execution (reachability alone is not enough). If Judge0 cannot execute code the
 * suite is skipped with the reason printed. A skip is NOT a pass.
 */
const options = judge0OptionsFromEnv();

async function probe(): Promise<string | null> {
  try {
    const [res] = await new Judge0Client(options).runBatch([
      { language: 'python', source: 'print("ok")', stdin: '' },
    ]);
    if (res.verdict === 'ok' && res.stdout.trim() === 'ok') return null;
    return `Judge0 is reachable but cannot execute code: ${res.statusText} ${res.stderr}`.trim();
  } catch (err) {
    return `Judge0 request failed: ${err instanceof Error ? `${err.message} (${(err as { detail?: string }).detail ?? ''})` : String(err)}`;
  }
}

const skipReason = await probe();
defineExecutionSuite('DSA through live Judge0', () => new Judge0Client(options), skipReason);
