import type { AssessmentState, QuestionProgress } from './dsa-api';

/**
 * A submission the server accepted is being judged while this page was not waiting for its answer (the page was
 * reloaded, or another tab sent it). The page watches it through the assessment state: `judging` says it is still
 * running; once it is gone, the question's submission count tells whether its result was recorded (the count went up)
 * or not (the code runner failed, or it was abandoned: nothing recorded, the candidate may submit again).
 */
export interface JudgingWatch {
  questionId: string;
  /** The question's submission count when the watch began (the judged one is not counted yet). */
  attemptsBefore: number;
}

export type JudgingOutcome =
  | { kind: 'judging' }
  | { kind: 'recorded'; progress: QuestionProgress }
  | { kind: 'not_recorded' }
  | { kind: 'ended' };

/** Starts watching when the server reports a submission being judged (null = nothing to watch). */
export function watchFor(state: AssessmentState): JudgingWatch | null {
  const j = state.status === 'in_progress' ? state.judging : null;
  if (!j) return null;
  return { questionId: j.questionId, attemptsBefore: state.progress.find((p) => p.questionId === j.questionId)?.attempts ?? 0 };
}

/** What a fresh assessment state says about the watched submission. */
export function judgingOutcome(watch: JudgingWatch, state: AssessmentState): JudgingOutcome {
  if (state.status !== 'in_progress') return { kind: 'ended' };
  if (state.judging?.questionId === watch.questionId) return { kind: 'judging' };
  const progress = state.progress.find((p) => p.questionId === watch.questionId);
  if (progress && progress.attempts > watch.attemptsBefore) return { kind: 'recorded', progress };
  return { kind: 'not_recorded' };
}

/** How often the page asks while a submission is being judged. */
export const JUDGING_POLL_MS = 3000;

export const NOT_RECORDED_MESSAGE =
  'Your earlier submission could not be judged because of a problem on our side, so nothing was recorded for it. Please submit again.';

/** The saved result, in words (the server keeps the BEST submission of each question). */
export function recordedMessage(progress: QuestionProgress, marks: number): string {
  const n = progress.attempts;
  return `Your earlier submission was judged and saved. Best score for this question: ${progress.bestScore} / ${marks} (${n} ${n === 1 ? 'submission' : 'submissions'}).`;
}
