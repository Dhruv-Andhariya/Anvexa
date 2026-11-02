import type { AssessmentStage, RoundOutcome } from '@hireflow/contracts';

/** Shared look of the Assessments pages (badges for round outcomes and overall status). */
export const pill = 'inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium';

export const OUTCOME_STYLE: Record<RoundOutcome, string> = {
  PASSED: 'border-success/40 bg-success-soft text-success',
  FAILED: 'border-danger/40 bg-danger-soft text-danger',
  NOT_ATTEMPTED: 'border-border text-muted',
};
export const OUTCOME_TEXT: Record<RoundOutcome, string> = { PASSED: 'Passed', FAILED: 'Failed', NOT_ATTEMPTED: 'Not attempted' };

export const STAGE_STYLE: Record<AssessmentStage, string> = {
  CLEARED: OUTCOME_STYLE.PASSED,
  NOT_CLEARED: OUTCOME_STYLE.FAILED,
  IN_PROGRESS: 'border-accent/40 bg-accent-soft text-accent',
  NOT_STARTED: OUTCOME_STYLE.NOT_ATTEMPTED,
};
export const STAGE_TEXT: Record<AssessmentStage, string> = {
  CLEARED: 'Cleared all rounds',
  NOT_CLEARED: 'Not cleared',
  IN_PROGRESS: 'In progress',
  NOT_STARTED: 'Not started',
};

const num = (n: number) => (Number.isInteger(n) ? n.toString() : n.toFixed(2).replace(/0+$/, '').replace(/\.$/, ''));
export const scoreText = (score: number, max: number | null) => (max === null ? num(score) : `${num(score)} / ${num(max)}`);
