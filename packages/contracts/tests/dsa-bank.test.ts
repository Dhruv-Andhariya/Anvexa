import { describe, expect, it } from 'vitest';
import {
  DSA_BANK,
  dsaBankEntry,
  dsaBankIdOf,
  dsaTopicFor,
  isDsaQuestion,
  isDsaRound,
  questionProblems,
  saveRoundsRequestSchema,
} from '../src';

const coding = (topics: string[], marks = 10) => ({ kind: 'CODING', text: 'q', options: [], correct: [], modelAnswer: null, language: null, marks, difficulty: null, topics, source: 'HR' });

describe('DSA problem bank', () => {
  it('has unique ids, a title, a difficulty and positive marks for every problem', () => {
    expect(new Set(DSA_BANK.map((p) => p.id)).size).toBe(DSA_BANK.length);
    for (const p of DSA_BANK) {
      expect(p.title.length).toBeGreaterThan(0);
      expect(['EASY', 'MEDIUM', 'HARD']).toContain(p.difficulty);
      expect(p.marks).toBeGreaterThan(0);
    }
  });

  it('ties a question to a problem through the dsa:<id> topic', () => {
    expect(dsaTopicFor('dsa-001')).toBe('dsa:dsa-001');
    expect(dsaBankIdOf(['arrays', 'dsa:dsa-002'])).toBe('dsa-002');
    expect(dsaBankIdOf(['arrays'])).toBeNull();
    expect(dsaBankEntry('dsa-001')?.title).toBe('Two Sum');
    expect(dsaBankEntry('nope')).toBeUndefined();
  });

  it('a DSA question is a CODING question pointing at a problem that exists', () => {
    expect(isDsaQuestion({ kind: 'CODING', topics: ['dsa:dsa-001'] })).toBe(true);
    expect(isDsaQuestion({ kind: 'CODING', topics: ['dsa:dsa-999'] })).toBe(false);
    expect(isDsaQuestion({ kind: 'CODING', topics: [] })).toBe(false);
    expect(isDsaQuestion({ kind: 'MCQ', topics: ['dsa:dsa-001'] })).toBe(false);
  });

  it('a DSA round needs a score rule and only DSA questions', () => {
    const q = [{ kind: 'CODING', topics: ['dsa:dsa-001'] }, { kind: 'CODING', topics: ['dsa:dsa-002'] }];
    expect(isDsaRound({ passRule: { mode: 'MARKS' }, questions: q })).toBe(true);
    expect(isDsaRound({ passRule: null, questions: q })).toBe(false);
    expect(isDsaRound({ passRule: { mode: 'INTERVIEWER_SCORE' }, questions: q })).toBe(false);
    expect(isDsaRound({ passRule: { mode: 'MARKS' }, questions: [] })).toBe(false);
    expect(isDsaRound({ passRule: { mode: 'MARKS' }, questions: [...q, { kind: 'CODING', topics: [] }] })).toBe(false);
  });
});

describe('rounds editor rules for DSA problems', () => {
  it('accepts a known problem on a coding question and refuses anything else', () => {
    expect(questionProblems(coding(['dsa:dsa-001']) as never)).toEqual([]);
    expect(questionProblems(coding(['dsa:dsa-999']) as never)).toEqual(['This DSA problem is not in the problem bank.']);
    expect(questionProblems({ ...coding(['dsa:dsa-001']), kind: 'DESCRIPTIVE' } as never)).toEqual(['A DSA problem can only be attached to a coding question.']);
    expect(questionProblems(coding(['arrays']) as never)).toEqual([]);
  });

  it('HR’s own problem: a coding question with at least one sample test; not with a bank problem; not on other kinds', () => {
    const spec = { title: 'Sum', tests: [{ input: '1 2', output: '3', hidden: false }, { input: '5 5', output: '10', hidden: true }] };
    expect(questionProblems({ ...coding([]), coding: spec } as never)).toEqual([]);
    expect(questionProblems({ ...coding([]), coding: { ...spec, tests: [spec.tests[1]] } } as never)).toEqual([
      'Add at least one sample test (shown to candidates and used by Run).',
    ]);
    expect(questionProblems({ ...coding(['dsa:dsa-001']), coding: spec } as never)).toEqual(['Choose a bank problem or write your own, not both.']);
    expect(questionProblems({ ...coding([]), kind: 'DESCRIPTIVE', coding: spec } as never)).toEqual(['A DSA problem can only be attached to a coding question.']);
    expect(isDsaQuestion({ kind: 'CODING', topics: [], coding: spec })).toBe(true);
    expect(isDsaQuestion({ kind: 'CODING', topics: [], coding: { tests: [] } })).toBe(false);
    expect(isDsaRound({ passRule: { mode: 'MARKS' }, questions: [{ kind: 'CODING', topics: [], coding: spec }, { kind: 'CODING', topics: ['dsa:dsa-001'] }] })).toBe(true);
  });

  it('the save request keeps HR’s problem and refuses one without an expected output', () => {
    const own = { ...coding([]), coding: { title: 'Sum', tests: [{ input: '1 2', output: '3' }] } };
    const round = { type: 'CODING', name: 'DSA', passRule: { mode: 'MARKS', value: 5 }, questions: [own] };
    const parsed = saveRoundsRequestSchema.safeParse({ rounds: [round], complete: true });
    expect(parsed.success && parsed.data.rounds[0]!.questions[0]!.coding).toEqual({
      title: 'Sum',
      inputFormat: '',
      outputFormat: '',
      constraints: '',
      tests: [{ input: '1 2', output: '3', hidden: false }],
    });
    const blank = { ...own, coding: { title: 'Sum', tests: [{ input: '1 2', output: ' ' }] } };
    const bad = saveRoundsRequestSchema.safeParse({ rounds: [{ ...round, questions: [blank] }], complete: false });
    expect(bad.success).toBe(false);
    if (!bad.success) expect(bad.error.issues.map((i) => i.message)).toContain('Enter the expected output of every test');
  });

  it('a SQL problem (copy of a SQL bank question) makes a coding question an online problem; one problem per question', () => {
    const sql = { tests: [{ hidden: false }, { hidden: true }] };
    expect(isDsaQuestion({ kind: 'CODING', topics: [], sql })).toBe(true);
    expect(isDsaQuestion({ kind: 'CODING', topics: [], sql: { tests: [{ hidden: true }] } })).toBe(false);
    expect(isDsaRound({ passRule: { mode: 'MARKS' }, questions: [{ kind: 'CODING', topics: [], sql }, { kind: 'CODING', topics: ['dsa:dsa-001'] }] })).toBe(true);
    expect(questionProblems({ ...coding([]), sql } as never)).toEqual([]);
    expect(questionProblems({ ...coding([]), kind: 'MCQ', options: ['a', 'b'], correct: [0], sql } as never)).toContain('A SQL problem can only be attached to a coding question.');
    expect(questionProblems({ ...coding(['dsa:dsa-001']), sql } as never)).toEqual(['A question can have one problem only: a SQL problem, a DSA bank problem or your own.']);
    expect(questionProblems({ ...coding([]), sql: { tests: [{ hidden: true }] } } as never)).toEqual(['Add at least one sample dataset (shown to candidates and used by Run).']);
  });

  it('the save request rejects an unknown problem with the same message as the editor shows', () => {
    const round = { type: 'CODING', name: 'DSA', passRule: { mode: 'MARKS', value: 5 }, questions: [coding(['dsa:dsa-999'])] };
    const parsed = saveRoundsRequestSchema.safeParse({ rounds: [round], complete: false });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues.map((i) => i.message)).toContain('This DSA problem is not in the problem bank.');
    expect(saveRoundsRequestSchema.safeParse({ rounds: [{ ...round, questions: [coding(['dsa:dsa-001'])] }], complete: true }).success).toBe(true);
  });
});
