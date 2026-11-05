import type { RoundAnswer, RoundOutcome, SavedRound } from '@hireflow/contracts';

/** A result the rules cannot accept (wrong round, impossible score...). Safe to show to the caller. */
export class InvalidResultError extends Error {
  constructor(readonly problems: string[]) {
    super(problems.join(' '));
    this.name = 'InvalidResultError';
  }
}

export interface ResultNumbers {
  correctCount: number | null;
  marks: number | null;
  interviewerScore: number | null;
  answers: RoundAnswer[];
}

export interface Graded {
  correctCount: number | null;
  marks: number | null;
  interviewerScore: number | null;
  answers: RoundAnswer[];
  /** In the pass rule's unit. */
  score: number;
  maxScore: number;
  passMark: number;
  systemPassed: boolean;
}

const sameSet = (a: number[], b: number[]) => a.length === b.length && a.every((x) => b.includes(x));
const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Applies the round's (locked) passing criterion to what the round engine sent. The one place where pass / fail is
 * decided. Choice answers the engine did not grade are graded here against the saved correct options.
 */
export function gradeResult(round: SavedRound, input: ResultNumbers): Graded {
  const rule = round.passRule;
  if (!rule) throw new InvalidResultError(['This round has no passing criterion.']);
  const byId = new Map(round.questions.map((q) => [q.id, q]));
  const problems: string[] = [];
  const seen = new Set<string>();

  const answers = input.answers.map((a) => {
    const q = byId.get(a.questionId);
    if (!q) {
      problems.push(`Question ${a.questionId} is not part of this round.`);
      return a;
    }
    if (seen.has(a.questionId)) problems.push(`Question ${a.questionId} is answered twice.`);
    seen.add(a.questionId);
    if (a.marksAwarded !== null && a.marksAwarded > q.marks) problems.push(`Question ${q.position} is worth at most ${q.marks} marks.`);
    if (a.isCorrect !== null || !(q.kind === 'MCQ' || q.kind === 'TRUE_FALSE')) return a;
    const isCorrect = a.selected.length ? sameSet(a.selected, q.correct) : false;
    return { ...a, isCorrect, marksAwarded: a.marksAwarded ?? (isCorrect ? q.marks : 0) };
  });

  const totalMarks = round.questions.reduce((sum, q) => sum + q.marks, 0);
  const gradedCorrect = answers.some((a) => a.isCorrect !== null) ? answers.filter((a) => a.isCorrect).length : null;
  const gradedMarks = answers.some((a) => a.marksAwarded !== null) ? answers.reduce((sum, a) => sum + (a.marksAwarded ?? 0), 0) : null;
  const correctCount = input.correctCount ?? gradedCorrect;
  const marks = input.marks ?? gradedMarks;

  let score: number;
  let maxScore: number;
  switch (rule.mode) {
    case 'CORRECT_COUNT':
      maxScore = round.questions.length;
      if (correctCount === null) problems.push('Send correctCount (or graded answers) for this round.');
      else if (correctCount > maxScore) problems.push(`correctCount cannot be more than the ${maxScore} questions.`);
      score = correctCount ?? 0;
      break;
    case 'MARKS':
      // HR may set the round's total (e.g. out of 50): the student's marks are scaled to it
      maxScore = rule.maxScore ?? totalMarks;
      if (marks === null) problems.push('Send marks (or marks per answer) for this round.');
      else if (marks > totalMarks) problems.push(`marks cannot be more than the ${totalMarks} total marks.`);
      score = rule.maxScore && totalMarks ? round2(((marks ?? 0) / totalMarks) * rule.maxScore) : round2(marks ?? 0);
      break;
    case 'PERCENTAGE':
      maxScore = 100;
      if (marks === null) problems.push('Send marks (or marks per answer) for this round.');
      else if (marks > totalMarks) problems.push(`marks cannot be more than the ${totalMarks} total marks.`);
      score = totalMarks ? round2(((marks ?? 0) / totalMarks) * 100) : 0;
      break;
    case 'INTERVIEWER_SCORE':
      maxScore = rule.maxScore ?? 0;
      if (input.interviewerScore === null) problems.push('Send interviewerScore for this round.');
      else if (input.interviewerScore > maxScore) problems.push(`interviewerScore cannot be more than ${maxScore}.`);
      score = round2(input.interviewerScore ?? 0);
      break;
  }
  if (problems.length) throw new InvalidResultError(problems);
  return {
    correctCount,
    marks: marks === null ? null : round2(marks),
    interviewerScore: input.interviewerScore,
    answers,
    score,
    maxScore,
    passMark: rule.value,
    systemPassed: score >= rule.value,
  };
}

/** What counts: HR's override, else the system result. */
export const outcomeOf = (r: { systemPassed: boolean; override: { passed: boolean } | null } | undefined): RoundOutcome =>
  !r ? 'NOT_ATTEMPTED' : (r.override?.passed ?? r.systemPassed) ? 'PASSED' : 'FAILED';

/** A student stops at the first failed round; all passed = cleared. */
export function stageOf(outcomes: RoundOutcome[]) {
  if (outcomes.includes('FAILED')) return 'NOT_CLEARED' as const;
  if (outcomes.length && outcomes.every((o) => o === 'PASSED')) return 'CLEARED' as const;
  return outcomes.includes('PASSED') ? ('IN_PROGRESS' as const) : ('NOT_STARTED' as const);
}
