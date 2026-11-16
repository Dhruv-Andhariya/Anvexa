import { describe, expect, it } from 'vitest';
import type { AssessmentState, QuestionProgress } from '@/lib/dsa-api';
import { NOT_RECORDED_MESSAGE, judgingOutcome, recordedMessage, watchFor } from '@/lib/dsa-judging';

/** The DSA page after a reload while a submission it sent is still being judged on the server. */
const progress = (questionId: string, attempts: number, bestScore = 0): QuestionProgress => ({
  questionId,
  attempts,
  bestScore,
  passed: bestScore > 0 ? 8 : 0,
  total: attempts > 0 ? 8 : 0,
  language: attempts > 0 ? 'python' : null,
  lastVerdict: attempts > 0 ? 'passed' : null,
});
const state = (over: Partial<AssessmentState>): AssessmentState =>
  ({
    status: 'in_progress',
    progress: [progress('q1', 1, 5), progress('q2', 0)],
    judging: null,
    ...over,
  }) as AssessmentState;

describe('a submission judged while the page was not waiting for it (reload)', () => {
  it('a reload during judging starts a watch on that question, counting the submissions saved so far', () => {
    const s = state({ judging: { questionId: 'q1', acceptedAt: '2026-11-16T10:00:00.000Z' } });
    expect(watchFor(s)).toEqual({ questionId: 'q1', attemptsBefore: 1 });
    expect(judgingOutcome(watchFor(s)!, s)).toEqual({ kind: 'judging' }); // the page shows "Judging…" and holds Submit
  });

  it('nothing to watch when nothing is being judged, or the attempt is over, or the API is older (no field)', () => {
    expect(watchFor(state({}))).toBeNull();
    expect(watchFor(state({ status: 'finished', judging: { questionId: 'q1', acceptedAt: 'x' } }))).toBeNull();
    const older = state({});
    delete (older as Partial<AssessmentState>).judging;
    expect(watchFor(older)).toBeNull();
  });

  it('still judging on the next refresh: keep waiting', () => {
    const watch = { questionId: 'q1', attemptsBefore: 1 };
    expect(judgingOutcome(watch, state({ judging: { questionId: 'q1', acceptedAt: 'x' } }))).toEqual({ kind: 'judging' });
  });

  it('judging over and one more submission saved: the saved result is shown (best score of the question)', () => {
    const watch = { questionId: 'q1', attemptsBefore: 1 };
    const out = judgingOutcome(watch, state({ progress: [progress('q1', 2, 10), progress('q2', 0)] }));
    expect(out).toEqual({ kind: 'recorded', progress: progress('q1', 2, 10) });
    expect(recordedMessage(progress('q1', 2, 10), 10)).toBe('Your earlier submission was judged and saved. Best score for this question: 10 / 10 (2 submissions).');
  });

  it('judging over but nothing saved (code runner failure / abandoned): an honest error, Submit allowed again', () => {
    const watch = { questionId: 'q1', attemptsBefore: 1 };
    expect(judgingOutcome(watch, state({}))).toEqual({ kind: 'not_recorded' });
    expect(NOT_RECORDED_MESSAGE).toMatch(/nothing was recorded.*submit again/i);
  });

  it('the attempt ended while waiting (time up / finished): the page moves to its end screen', () => {
    expect(judgingOutcome({ questionId: 'q1', attemptsBefore: 1 }, state({ status: 'finished' }))).toEqual({ kind: 'ended' });
  });

  it('a first submission of a question (nothing saved before) is recognised when it lands', () => {
    const s = state({ judging: { questionId: 'q2', acceptedAt: 'x' } });
    const watch = watchFor(s)!;
    expect(watch).toEqual({ questionId: 'q2', attemptsBefore: 0 });
    expect(judgingOutcome(watch, state({ progress: [progress('q1', 1, 5), progress('q2', 1, 20)] }))).toMatchObject({ kind: 'recorded' });
  });
});
