import { AI_INTERVIEW_LIMITS, aiInterviewRoundProblems } from '@hireflow/contracts';
import { describe, expect, it } from 'vitest';
import {
  EXTRA_QUESTIONS,
  clockOf,
  configFromRound,
  fallbackPlan,
  interviewerScore,
  linkHrQuestions,
  nextQuestion,
  vocabulary,
  type NextInput,
  type PlanTopic,
} from '../../src/modules/ai-interview/flow';
import { HR_Q, decision, rounds } from './fakes';

const round = rounds()[1]!;
const config = configFromRound(round, true);
const START = new Date('2026-11-03T10:00:00Z');
const at = (seconds: number) => new Date(START.getTime() + seconds * 1000);
const clock = (seconds: number, pausedSeconds = 0) => clockOf({ startedAt: START, pausedSeconds, pausedAt: null }, config, at(seconds));

const PLAN: PlanTopic[] = [
  { id: 't1', title: 'RAG', source: 'RESUME', resumeRef: 'RAG chatbot', skill: null, goal: '', question: 'How does a question flow through your RAG chatbot?', priority: 1 },
  { id: 't2', title: 'SQL', source: 'JOB', resumeRef: null, skill: null, goal: '', question: 'How would you prevent duplicate rows in a table?', priority: 1 },
  { id: 't3', title: 'Slow API', source: 'SCENARIO', resumeRef: null, skill: null, goal: '', question: 'Suppose your API becomes slow - how would you find the cause?', priority: 2 },
];

const input = (over: Partial<NextInput> = {}): NextInput => ({
  current: { kind: 'MAIN', source: 'RESUME', text: PLAN[0]!.question, topicId: 't1', topic: 'RAG', resumeRef: 'RAG chatbot' },
  seq: 3,
  followUpsOnTopic: 0,
  coveredTopics: [],
  plan: PLAN,
  decision: null,
  clock: clock(180),
  answeredInFinal: false,
  answeredTurns: 2,
  askedQuestions: ['Are you ready?', PLAN[0]!.question],
  closing: 'Thank you, that is the end.',
  ...over,
});

describe('interview configuration', () => {
  it('uses HR time limit within 10-30 minutes, and HR questions are kept for the interview', () => {
    expect(config).toMatchObject({ durationMinutes: 20, minMinutes: 14, cameraRequired: true, passRule: { value: 6, maxScore: 10 } });
    expect(config.hrQuestions).toEqual([{ id: HR_Q, text: 'Explain the difference between a process and a thread', topics: ['OS'], expectedAnswer: 'Threads share memory within a process.' }]);
    expect(configFromRound({ ...round, timeLimitMinutes: null }, true).durationMinutes).toBe(20);
    expect(configFromRound({ ...round, timeLimitMinutes: 90 }, true).durationMinutes).toBe(30);
    expect(configFromRound({ ...round, timeLimitMinutes: 5 }, true)).toMatchObject({ durationMinutes: 10, minMinutes: 10 });
  });

  it('the round editor refuses a length outside 10-30 minutes and a non-interviewer pass rule', () => {
    expect(aiInterviewRoundProblems({ type: 'AI_INTERVIEW', timeLimitMinutes: 45, passRule: null }).map((p) => p.field)).toEqual(['timeLimitMinutes']);
    expect(aiInterviewRoundProblems({ type: 'AI_INTERVIEW', timeLimitMinutes: 20, passRule: { mode: 'PERCENTAGE', value: 50, maxScore: null } }).map((p) => p.field)).toEqual(['passRule']);
    expect(aiInterviewRoundProblems({ type: 'AI_INTERVIEW', timeLimitMinutes: null, passRule: { mode: 'INTERVIEWER_SCORE', value: 6, maxScore: 10 } })).toEqual([]);
    expect(aiInterviewRoundProblems({ type: 'APTITUDE', timeLimitMinutes: 90, passRule: null })).toEqual([]);
  });
});

describe('server clock', () => {
  it('runs from the start, minus paused time, through the phases', () => {
    expect(clock(60)).toMatchObject({ elapsedSeconds: 60, remainingSeconds: 1140, phase: 'CORE' });
    expect(clock(14 * 60).phase).toBe('MAY_CONCLUDE');
    expect(clock(20 * 60 - 60).phase).toBe('FINAL');
    expect(clock(20 * 60 + 1)).toMatchObject({ phase: 'OVER', remainingSeconds: 0, pastGrace: false });
    expect(clock(20 * 60 + AI_INTERVIEW_LIMITS.graceSeconds + 1).pastGrace).toBe(true);
    expect(clock(600, 120)).toMatchObject({ elapsedSeconds: 480, pauseSecondsLeft: AI_INTERVIEW_LIMITS.maxPauseSeconds - 120 });
  });

  it('counts a running pause, but only up to the pause allowance', () => {
    const paused = clockOf({ startedAt: START, pausedSeconds: 0, pausedAt: at(300) }, config, at(400));
    expect(paused.elapsedSeconds).toBe(300);
    const long = clockOf({ startedAt: START, pausedSeconds: 0, pausedAt: at(300) }, config, at(300 + AI_INTERVIEW_LIMITS.maxPauseSeconds + 120));
    expect(long).toMatchObject({ elapsedSeconds: 420, pauseSecondsLeft: 0 });
  });
});

describe('next question', () => {
  it('after the greeting: the first planned topic', () => {
    const n = nextQuestion(input({ current: { kind: 'INTRO', source: 'INTRO', text: 'Are you ready?', topicId: null, topic: null, resumeRef: null }, askedQuestions: ['Are you ready?'] }));
    expect(n.pending).toMatchObject({ kind: 'MAIN', source: 'RESUME', topicId: 't1', resumeRef: 'RAG chatbot' });
    expect(n.coveredTopics).toEqual([]);
  });

  it('a follow-up stays on the topic, up to the per-topic limit', () => {
    const q = 'How did you choose the number of chunks to retrieve?';
    const n = nextQuestion(input({ decision: decision({ action: 'FOLLOW_UP', reading: 'INCOMPLETE', question: q }) }));
    expect(n.pending).toMatchObject({ kind: 'FOLLOW_UP', source: 'FOLLOW_UP', topicId: 't1', text: q });
    expect(n.followUpsOnTopic).toBe(1);
    const limit = nextQuestion(input({ followUpsOnTopic: AI_INTERVIEW_LIMITS.followUpsPerTopic, decision: decision({ action: 'FOLLOW_UP', question: q }) }));
    expect(limit.pending).toMatchObject({ kind: 'MAIN', topicId: 't2' });
    expect(limit.coveredTopics).toContain('t1');
  });

  it('a question asked before is never asked again: the plan continues', () => {
    const n = nextQuestion(input({ decision: decision({ action: 'FOLLOW_UP', question: PLAN[0]!.question }) }));
    expect(n.pending.topicId).toBe('t2');
  });

  it('the AI can choose a planned topic or a new grounded one', () => {
    expect(nextQuestion(input({ decision: decision({ topicId: 't3' }) })).pending).toMatchObject({ topicId: 't3', text: PLAN[2]!.question, source: 'SCENARIO' });
    const n = nextQuestion(input({ decision: decision({ question: 'How did you evaluate your chatbot answers?', newTopicSource: 'RESUME', newTopicTitle: 'Evaluation', newTopicResumeRef: 'RAG chatbot' }) }));
    expect(n.pending).toMatchObject({ kind: 'MAIN', source: 'RESUME', topicId: 'x3', resumeRef: 'RAG chatbot' });
  });

  it('never concludes before the minimum time; after it, the AI may conclude', () => {
    expect(nextQuestion(input({ decision: decision({ action: 'CONCLUDE' }) })).done).toBe(false);
    const later = nextQuestion(input({ clock: clock(15 * 60), decision: decision({ action: 'CONCLUDE' }) }));
    expect(later).toMatchObject({ done: true, endedReason: 'AI_CONCLUDED', pending: { kind: 'CLOSING' } });
  });

  it('when the plan is used up before the minimum time, it keeps asking (never repeating)', () => {
    const n = nextQuestion(input({ coveredTopics: ['t2', 't3'] }));
    expect(n.pending.text).toBe(EXTRA_QUESTIONS[0]);
    const after = nextQuestion(input({ coveredTopics: ['t2', 't3'], clock: clock(15 * 60) }));
    expect(after.done).toBe(true);
  });

  it('time: over -> closing; in the last 90 seconds only one last question', () => {
    expect(nextQuestion(input({ clock: clock(20 * 60 + 5) }))).toMatchObject({ done: true, endedReason: 'TIME_UP' });
    expect(nextQuestion(input({ clock: clock(20 * 60 - 60) })).done).toBe(false);
    expect(nextQuestion(input({ clock: clock(20 * 60 - 30), answeredInFinal: true }))).toMatchObject({ done: true, endedReason: 'TIME_UP' });
    expect(nextQuestion(input({ answeredTurns: AI_INTERVIEW_LIMITS.maxTurns }))).toMatchObject({ done: true, endedReason: 'MAX_TURNS' });
  });
});

describe('plan helpers', () => {
  it('the rule plan names only real resume items and asks every HR question', () => {
    const plan = fallbackPlan(config, { skills: ['Python'], projects: [{ title: 'RAG chatbot for college notes', technologies: ['LangChain'] }], experience: [] }, ['Python', 'SQL']);
    expect(plan.filter((t) => t.source === 'RESUME').map((t) => t.resumeRef)).toEqual(['RAG chatbot for college notes']);
    expect(plan.find((t) => t.source === 'HR')).toMatchObject({ hrQuestionId: HR_Q, question: 'Explain the difference between a process and a thread?' });
    expect(plan.every((t) => t.question.endsWith('?'))).toBe(true);
    expect(plan.map((t) => t.id)).toEqual(plan.map((_, i) => `t${i + 1}`));
  });

  it('links HR topics in the AI plan back to their round question', () => {
    const linked = linkHrQuestions([{ ...PLAN[0]!, source: 'HR', question: 'Could you explain how a process differs from a thread?' }], config.hrQuestions);
    expect(linked[0]!.hrQuestionId).toBe(HR_Q);
  });

  it('scales the AI score to the pass rule and builds the spelling list', () => {
    expect(interviewerScore(72, { value: 6, maxScore: 10 })).toEqual({ score: 7, maxScore: 10, passMark: 6 });
    expect(interviewerScore(null, { value: 6, maxScore: 10 })!.score).toBe(0);
    expect(interviewerScore(72, null)).toBeNull();
    expect(vocabulary({ skills: ['Python', 'python', 'ChromaDB'], projects: [{ title: 'x', technologies: ['LangChain'] }], experience: [] }, ['FastAPI'])).toEqual(['FastAPI', 'Python', 'ChromaDB', 'LangChain']);
  });
});
