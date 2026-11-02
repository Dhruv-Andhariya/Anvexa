import type { AssessmentQuestion } from '@hireflow/contracts';
import { describe, expect, it } from 'vitest';
import { AssessmentApiError } from '../src/lib/assessment-api';
import {
  choose,
  clearAnswer,
  describeError,
  formatRemaining,
  paletteState,
  pickKnown,
  remainingMs,
  summary,
  toAnswerList,
  toggleMarked,
  type AnswerMap,
} from '../src/lib/assessment-ui';
import { cameraProblemOf } from '../src/lib/camera';

const single: AssessmentQuestion = { id: 'q1', position: 1, kind: 'MCQ', text: 'One', options: ['a', 'b', 'c'], marks: 1, multiple: false };
const multi: AssessmentQuestion = { id: 'q2', position: 2, kind: 'MCQ', text: 'Many', options: ['a', 'b', 'c'], marks: 2, multiple: true };
const tf: AssessmentQuestion = { id: 'q3', position: 3, kind: 'TRUE_FALSE', text: 'TF', options: ['True', 'False'], marks: 1, multiple: false };

describe('answering', () => {
  it('a single-answer question keeps one choice; "select all" toggles options', () => {
    let m: AnswerMap = {};
    m = choose(m, single, 0);
    m = choose(m, single, 2);
    expect(m.q1!.selected).toEqual([2]);
    m = choose(m, multi, 2);
    m = choose(m, multi, 0);
    expect(m.q2!.selected).toEqual([0, 2]);
    m = choose(m, multi, 2);
    expect(m.q2!.selected).toEqual([0]);
  });

  it('mark for review and clear keep each other', () => {
    let m: AnswerMap = choose({}, single, 1);
    m = toggleMarked(m, 'q1');
    expect(paletteState(m, 'q1')).toBe('answered-marked');
    m = clearAnswer(m, 'q1');
    expect(paletteState(m, 'q1')).toBe('marked');
    m = toggleMarked(m, 'q1');
    expect(paletteState(m, 'q1')).toBe('unanswered');
  });

  it('counts answered / not answered / marked for the palette and the submit dialog', () => {
    let m: AnswerMap = choose({}, single, 1);
    m = toggleMarked(m, 'q2');
    expect(summary([single, multi, tf], m)).toEqual({ total: 3, answered: 1, marked: 1, unanswered: 2 });
  });

  it('sends only touched questions, and a stale local draft cannot add unknown questions', () => {
    const m: AnswerMap = { q1: { selected: [1], marked: false }, q2: { selected: [], marked: false }, zz: { selected: [0], marked: false } };
    expect(toAnswerList(m)).toEqual([
      { questionId: 'q1', selected: [1], marked: false },
      { questionId: 'zz', selected: [0], marked: false },
    ]);
    expect(Object.keys(pickKnown(m, [single, multi]))).toEqual(['q1', 'q2']);
  });
});

describe('timer', () => {
  it('counts down by the server clock, never below zero', () => {
    const deadline = '2026-11-02T10:00:00.000Z';
    const device = Date.parse('2026-11-02T09:00:00.000Z');
    // the device clock is 2 minutes slow: server = device + 120 s
    expect(remainingMs(deadline, 120_000, device)).toBe(58 * 60_000);
    expect(remainingMs(deadline, 0, device + 2 * 60 * 60_000)).toBe(0);
  });

  it('formats mm:ss and h:mm:ss', () => {
    expect(formatRemaining(65_000)).toBe('1:05');
    expect(formatRemaining(9_500)).toBe('0:10');
    expect(formatRemaining(2 * 3600_000 + 5 * 60_000)).toBe('2:05:00');
  });
});

describe('errors', () => {
  it('link problems end the page with a clear title; other errors can be retried', () => {
    expect(describeError(new AssessmentApiError(410, 'ASSESSMENT_LINK_EXPIRED', 'expired', false))).toMatchObject({ fatal: true, title: 'This link has expired' });
    expect(describeError(new AssessmentApiError(404, 'SOMETHING', 'x', false))).toMatchObject({ fatal: true, title: 'This link does not work' });
    expect(describeError(new AssessmentApiError(0, 'NETWORK_ERROR', 'Connection lost.', true))).toMatchObject({ fatal: false, message: 'Connection lost.' });
  });

  it('maps camera errors to what the candidate can do', () => {
    expect(cameraProblemOf({ name: 'NotAllowedError' })).toBe('denied');
    expect(cameraProblemOf({ name: 'NotFoundError' })).toBe('not_found');
    expect(cameraProblemOf({ name: 'NotReadableError' })).toBe('in_use');
    expect(cameraProblemOf(new Error('?'))).toBe('unknown');
  });
});
