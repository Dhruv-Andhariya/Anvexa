import { LocalRunner } from './support/local-runner';
import { defineExecutionSuite } from './support/execution-suite';

/**
 * Same end-to-end suite, executed with locally installed Python / Java / g++ instead of Piston.
 * Verifies the harnesses, the dataset's expected outputs and the evaluator independently of Piston.
 * It does NOT prove Piston works - see dsa-piston.integration.test.ts for that.
 */
const missing = LocalRunner.toolchainProblems();
defineExecutionSuite(
  'DSA through local toolchains (not Piston)',
  () => new LocalRunner(),
  missing.length ? `missing local toolchain: ${missing.join(', ')}` : null,
);
