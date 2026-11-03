export const DSA_LIFECYCLE = Symbol('DSA_LIFECYCLE');

/**
 * Told when an attempt's clock starts and when the attempt ends, so the hiring workflow (round engine) can record it,
 * grade it and move the candidate on. Optional: without it the module runs on its own (demo, tests).
 */
export interface AssessmentLifecycle {
  /** Before the clock starts; throwing stops the start (the attempt would otherwise never be graded). */
  started(token: string, startedAt: number, deadlineAt: number): Promise<void>;
  /** After the final state is saved. */
  finished(token: string, reason: 'submitted' | 'time_expired' | 'disqualified'): Promise<void>;
}
