import { LocalRunner } from './support/local-runner';
import { defineExecutionSuite } from './support/execution-suite';

/**
 * Same end-to-end suite, executed with locally installed Python / Java / g++ instead of Judge0.
 * Verifies the harnesses, the dataset's expected outputs and the evaluator independently of Judge0.
 * It does NOT prove Judge0 works - see dsa-judge0.integration.test.ts for that.
 *
 * SLOW (about 5 minutes: it compiles Java and C++ dozens of times) and needs the toolchains installed, so it only runs
 * on request:  DSA_SLOW_TESTS=on pnpm --filter api exec vitest run tests/dsa-local-runner.test.ts
 */
const missing = LocalRunner.toolchainProblems();
const skipReason =
  process.env.DSA_SLOW_TESTS !== 'on'
    ? 'slow suite, opt in with DSA_SLOW_TESTS=on'
    : missing.length
      ? `missing local toolchain: ${missing.join(', ')}`
      : null;

defineExecutionSuite('DSA through local toolchains (not Judge0)', () => new LocalRunner(), skipReason);
