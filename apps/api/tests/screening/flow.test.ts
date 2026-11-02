import { describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS, followUpAllowed, mainQuestion, nextQuestion, type FlowState, type QuestionContext, type TurnDecision } from '../../src/modules/screening/flow';

const CTX: QuestionContext = { candidateFirstName: 'Asha', jobTitle: 'Backend Intern', companyName: 'Acme', locations: ['Ahmedabad', 'Pune'], workMode: 'HYBRID', employmentType: 'INTERNSHIP' };
const START = new Date('2026-10-29T10:00:00Z');
const state = (over: Partial<FlowState> = {}): FlowState => ({
  step: 'INTRO',
  followUpsInStep: 0,
  candidateQuestions: 0,
  stepsDone: 0,
  answeredTurns: 1,
  startedAt: START,
  now: new Date(START.getTime() + 60_000),
  ...over,
});
const plain: TurnDecision = { needsFollowUp: false, followUpQuestion: null, candidateAskedQuestion: false, reply: null, candidateIsDone: false };

describe('screening flow', () => {
  it('asks the six steps in order', () => {
    const order = ['INTRO', 'EDUCATION', 'BACKGROUND', 'LOCATION', 'AVAILABILITY', 'CANDIDATE_QUESTIONS'] as const;
    for (let i = 0; i < order.length - 1; i++) {
      const out = nextQuestion(state({ step: order[i], stepsDone: i, answeredTurns: i + 1 }), plain, CTX, DEFAULT_LIMITS);
      expect(out.next).toMatchObject({ step: order[i + 1], kind: 'MAIN' });
      expect(out.done).toBe(false);
    }
  });

  it('uses the job location in the location question', () => {
    expect(mainQuestion('LOCATION', CTX)).toBe('Where are you currently based, and would you be comfortable working from Ahmedabad or Pune in a hybrid setup?');
    expect(mainQuestion('LOCATION', { ...CTX, workMode: 'REMOTE' })).toContain('This role is remote');
    expect(mainQuestion('CANDIDATE_QUESTIONS', CTX)).toContain('the internship');
    expect(mainQuestion('CANDIDATE_QUESTIONS', { ...CTX, employmentType: 'FULL_TIME' })).not.toContain('internship');
  });

  it('allows one follow-up per step, two in AVAILABILITY (college NOC)', () => {
    expect(followUpAllowed(state({ step: 'EDUCATION', followUpsInStep: 1 }), DEFAULT_LIMITS)).toBe(false);
    expect(followUpAllowed(state({ step: 'AVAILABILITY', followUpsInStep: 1 }), DEFAULT_LIMITS)).toBe(true);
    expect(followUpAllowed(state({ step: 'CANDIDATE_QUESTIONS' }), DEFAULT_LIMITS)).toBe(false);
  });

  it('stops follow-ups and skips to the candidate questions when time is up', () => {
    const late = state({ step: 'BACKGROUND', stepsDone: 2, now: new Date(START.getTime() + 16 * 60_000) });
    const out = nextQuestion(late, { ...plain, needsFollowUp: true, followUpQuestion: 'More?' }, CTX, DEFAULT_LIMITS);
    expect(out.next).toMatchObject({ step: 'CANDIDATE_QUESTIONS', kind: 'MAIN' });
  });

  it('ends after the last allowed candidate question, with the reply before the goodbye', () => {
    const out = nextQuestion(
      state({ step: 'CANDIDATE_QUESTIONS', stepsDone: 5, candidateQuestions: 2 }),
      { ...plain, candidateAskedQuestion: true, reply: 'HR will share that.' },
      CTX,
      DEFAULT_LIMITS,
    );
    expect(out.done).toBe(true);
    expect(out.next.kind).toBe('CLOSING');
    expect(out.next.text.startsWith('HR will share that. Thank you, Asha.')).toBe(true);
    expect(out.stepsDone).toBe(6);
  });

  it('never goes past the turn limit', () => {
    const out = nextQuestion(state({ step: 'EDUCATION', stepsDone: 1, answeredTurns: DEFAULT_LIMITS.maxTurns }), plain, CTX, DEFAULT_LIMITS);
    expect(out.done).toBe(true);
  });
});
