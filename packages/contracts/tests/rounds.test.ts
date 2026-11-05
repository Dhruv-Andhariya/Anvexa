import { describe, expect, it } from 'vitest';
import {
  describePassRule,
  overrideRoundResultRequestSchema,
  roundQuestionInputSchema,
  roundsCompletionProblems,
  saveRoundsRequestSchema,
  type RoundInput,
} from '../src';

const mcq = (correct = [1]) => ({ kind: 'MCQ' as const, text: '2 + 2 = ?', options: ['3', '4', '5'], correct });
const aptitude = (questions = 10, passValue = 8, mode: 'CORRECT_COUNT' | 'MARKS' | 'PERCENTAGE' = 'CORRECT_COUNT'): RoundInput => ({
  type: 'APTITUDE',
  name: 'Online Aptitude Exam',
  passRule: { mode, value: passValue },
  questions: Array.from({ length: questions }, () => mcq()),
});
const issues = (input: unknown) => {
  const r = saveRoundsRequestSchema.safeParse(input);
  return r.success ? [] : r.error.issues.map((i) => i.message);
};

describe('round questions', () => {
  it('accepts a valid MCQ and defaults marks to 1', () => {
    expect(roundQuestionInputSchema.parse(mcq()).marks).toBe(1);
  });
  it('rejects an MCQ without a correct option or with too few options', () => {
    expect(roundQuestionInputSchema.safeParse(mcq([])).success).toBe(false);
    expect(roundQuestionInputSchema.safeParse({ ...mcq(), options: ['only one'], correct: [0] }).success).toBe(false);
    expect(roundQuestionInputSchema.safeParse(mcq([7])).success).toBe(false);
  });
  it('needs exactly one answer for true / false', () => {
    expect(roundQuestionInputSchema.safeParse({ kind: 'TRUE_FALSE', text: 'SQL is a language', correct: [0] }).success).toBe(true);
    expect(roundQuestionInputSchema.safeParse({ kind: 'TRUE_FALSE', text: 'SQL is a language', correct: [] }).success).toBe(false);
  });
  it('does not allow correct options on open questions', () => {
    expect(roundQuestionInputSchema.safeParse({ kind: 'DESCRIPTIVE', text: 'Explain joins', correct: [0] }).success).toBe(false);
  });
});

describe('pass mark', () => {
  it('allows 8 of 10 correct', () => {
    expect(issues({ rounds: [aptitude(10, 8)], complete: true })).toEqual([]);
  });
  it('never allows more correct answers than questions, even in a draft', () => {
    expect(issues({ rounds: [aptitude(10, 11)] })).toContain('The pass mark cannot be more than the 10 questions.');
  });
  it('limits marks to the total marks and percentage to 100', () => {
    expect(issues({ rounds: [aptitude(4, 5, 'MARKS')] })).toContain('The pass mark (5) is more than the total (4). Set the total in "out of" to 5 or more, or lower the pass mark.');
    expect(issues({ rounds: [aptitude(4, 101, 'PERCENTAGE')] })).toContain('The pass mark cannot be more than 100%.');
  });
  it('checks an interviewer score against its maximum', () => {
    const round = { type: 'HR_INTERVIEW', name: 'HR Interview', passRule: { mode: 'INTERVIEWER_SCORE', value: 7, maxScore: 5 } };
    expect(issues({ rounds: [round] })).toContain('The pass score cannot be more than 5.');
    expect(issues({ rounds: [{ ...round, passRule: { ...round.passRule, maxScore: 10 } }], complete: true })).toEqual([]);
  });
  it('describes the rule for HR', () => {
    const q = Array.from({ length: 10 }, () => ({ marks: 2 }));
    expect(describePassRule({ mode: 'CORRECT_COUNT', value: 8, maxScore: null }, q)).toBe('8 of 10 correct');
    expect(describePassRule({ mode: 'PERCENTAGE', value: 60, maxScore: null }, q)).toBe('60% of 20 marks');
  });
});

describe('draft vs complete', () => {
  it('saves an unfinished draft', () => {
    expect(issues({ rounds: [{ type: 'CODING', name: 'Coding' }] })).toEqual([]);
  });
  it('lists what is missing before the rounds are complete', () => {
    expect(roundsCompletionProblems([])).toEqual(['Add at least one assessment round.']);
    const problems = roundsCompletionProblems([{ name: 'Coding', passRule: null, questions: [] }]);
    expect(problems).toEqual(['Round 1 (Coding): choose the passing criterion.']);
    expect(issues({ rounds: [{ type: 'CODING', name: 'Coding' }], complete: true })).toEqual(problems);
  });
  it('requires questions unless an interviewer scores the round', () => {
    expect(roundsCompletionProblems([{ name: 'SQL', passRule: { mode: 'PERCENTAGE', value: 50, maxScore: null }, questions: [] }])).toEqual([
      'Round 1 (SQL): add at least one question.',
    ]);
  });
  it('rejects two rounds with the same name', () => {
    expect(issues({ rounds: [aptitude(), { ...aptitude(), name: 'online aptitude exam ' }] })).toContain('Two rounds are called "online aptitude exam".');
  });
});

describe('result override', () => {
  it('needs a reason unless the override is removed', () => {
    expect(overrideRoundResultRequestSchema.safeParse({ passed: true, reason: '' }).success).toBe(false);
    expect(overrideRoundResultRequestSchema.safeParse({ passed: true, reason: 'Network failure during the test' }).success).toBe(true);
    expect(overrideRoundResultRequestSchema.safeParse({ passed: null }).success).toBe(true);
  });
});
