import { describe, expect, it } from 'vitest';
import { backgroundJobsOn } from '../src/common/feature-flags';
import { aiInterviewWorkerConfigFromEnv } from '../src/modules/ai-interview/ai-interview.worker';
import { atsProcessorConfigFromEnv } from '../src/modules/ats/ats-processor.service';
import { gdWorkerConfigFromEnv } from '../src/modules/group-discussion/gd.worker';
import { roundEngineWorkerConfigFromEnv } from '../src/modules/round-engine/round-engine.worker';

/**
 * A teammate's laptop shares the live database but must never send candidate emails (its links would point at its own
 * localhost / tunnel): BACKGROUND_JOBS=off turns every worker and email sender off.
 */
describe('BACKGROUND_JOBS', () => {
  it('is on by default and off for off / false / 0 / no', () => {
    expect(backgroundJobsOn({})).toBe(true);
    expect(backgroundJobsOn({ BACKGROUND_JOBS: 'on' })).toBe(true);
    for (const v of ['off', 'OFF', 'false', '0', 'no', ' off ']) expect(backgroundJobsOn({ BACKGROUND_JOBS: v })).toBe(false);
  });

  it('turns every worker and the queued emails off', () => {
    const off = { BACKGROUND_JOBS: 'off' };
    expect(atsProcessorConfigFromEnv(off).enabled).toBe(false);
    expect(atsProcessorConfigFromEnv(off).emailsEnabled).toBe(false);
    expect(roundEngineWorkerConfigFromEnv(off).enabled).toBe(false);
    expect(gdWorkerConfigFromEnv(off).enabled).toBe(false);
    expect(aiInterviewWorkerConfigFromEnv(off).enabled).toBe(false);
  });

  it('leaves the workers on when it is not set', () => {
    expect(atsProcessorConfigFromEnv({}).enabled).toBe(true);
    expect(atsProcessorConfigFromEnv({}).emailsEnabled).toBe(true);
    expect(roundEngineWorkerConfigFromEnv({}).enabled).toBe(true);
    expect(gdWorkerConfigFromEnv({}).enabled).toBe(true);
    expect(aiInterviewWorkerConfigFromEnv({}).enabled).toBe(true);
  });
});
