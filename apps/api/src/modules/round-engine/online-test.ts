import {
  ONLINE_TEST_KINDS,
  type AssessmentAnswer,
  type AssessmentQuestion,
  type ProctorEventType,
  type ProctorSeverity,
  type RoundAnswerInput,
  type RoundOutcomeEmailKind,
  type SavedRound,
} from '@hireflow/contracts';

/**
 * Pure rules of the online test rounds (no I/O): which rounds run online, what the candidate may see, which answers
 * are valid, and what happens after a result. Pass / fail itself is decided by the assessments module (grading.ts).
 */

/** A save / submit may arrive this long after the deadline (slow network) and still count. */
export const DEADLINE_GRACE_MS = 30_000;

/** The answers as stored on the attempt: questionId -> selection. */
export type StoredAnswers = Record<string, { selected: number[]; marked: boolean }>;

const ONLINE = new Set<string>(ONLINE_TEST_KINDS);

/**
 * Run online and graded automatically: a pass rule that is not an interviewer's score, at least one question, and
 * only multiple-choice / true-false questions. Anything else (coding, descriptive, interviews) is run by HR.
 */
export function isOnlineRound(round: Pick<SavedRound, 'passRule' | 'questions'>): boolean {
  return (
    !!round.passRule &&
    round.passRule.mode !== 'INTERVIEWER_SCORE' &&
    round.questions.length > 0 &&
    round.questions.every((q) => ONLINE.has(q.kind))
  );
}

/**
 * Run on the DSA coding page (candidate app /dsa/[token], dsa module) and graded from its score: a pass rule that is
 * not an interviewer's score and only coding questions. HR's questions describe the round; the problems the student
 * solves (with hidden tests) come from the dsa module.
 */
export function isCodingRound(round: Pick<SavedRound, 'passRule' | 'questions'>): boolean {
  return (
    !!round.passRule &&
    round.passRule.mode !== 'INTERVIEWER_SCORE' &&
    round.questions.length > 0 &&
    round.questions.every((q) => q.kind === 'CODING')
  );
}

/** The round engine invites students to it (an MCQ test on the careers site or the DSA coding page). */
export const isInvitedRound = (round: Pick<SavedRound, 'passRule' | 'questions'>) => isOnlineRound(round) || isCodingRound(round);

/** What the candidate sees of each question: never the correct option(s), model answer or topics. */
export function publicQuestions(round: SavedRound): AssessmentQuestion[] {
  return [...round.questions]
    .sort((a, b) => a.position - b.position)
    .map((q) => ({
      id: q.id,
      position: q.position,
      kind: q.kind as AssessmentQuestion['kind'],
      text: q.text,
      options: q.options,
      marks: q.marks,
      // "select all that apply" only when HR marked several options correct
      multiple: q.kind === 'MCQ' && q.correct.length > 1,
    }));
}

export class InvalidAnswersError extends Error {
  constructor(readonly problems: string[]) {
    super(problems.join(' '));
    this.name = 'InvalidAnswersError';
  }
}

/** Checks every answer against the round (question exists, options exist, one pick for single-answer questions). */
export function cleanAnswers(round: SavedRound, answers: AssessmentAnswer[]): StoredAnswers {
  const byId = new Map(publicQuestions(round).map((q) => [q.id, q]));
  const out: StoredAnswers = {};
  const problems: string[] = [];
  for (const a of answers) {
    const q = byId.get(a.questionId);
    if (!q) {
      problems.push('An answer is for a question that is not part of this test.');
      continue;
    }
    if (out[a.questionId]) problems.push(`Question ${q.position} is answered twice.`);
    const selected = [...new Set(a.selected)].sort((x, y) => x - y);
    if (selected.some((i) => i >= q.options.length)) problems.push(`Question ${q.position}: that option does not exist.`);
    if (!q.multiple && selected.length > 1) problems.push(`Question ${q.position}: choose one option only.`);
    out[a.questionId] = { selected, marked: a.marked };
  }
  if (problems.length) throw new InvalidAnswersError(problems);
  return out;
}

/** Answers for the assessments module: every question, unanswered ones with no selection (graded as wrong, 0 marks). */
export function toRoundAnswers(round: SavedRound, stored: StoredAnswers): RoundAnswerInput[] {
  return round.questions.map((q) => ({ questionId: q.id, selected: stored[q.id]?.selected ?? [] }));
}

export const answeredCount = (stored: StoredAnswers) => Object.values(stored).filter((a) => a.selected.length > 0).length;

/** Reads the attempt's JSON column safely (anything unexpected is dropped, never trusted). */
export function parseStoredAnswers(value: unknown): StoredAnswers {
  const out: StoredAnswers = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [id, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as { selected?: unknown; marked?: unknown };
    const selected = Array.isArray(r.selected) ? r.selected.filter((n): n is number => Number.isInteger(n) && n >= 0) : [];
    out[id] = { selected, marked: r.marked === true };
  }
  return out;
}

export type NextStep =
  | { kind: 'INVITE'; round: SavedRound }
  | { kind: 'EMAIL'; email: RoundOutcomeEmailKind; nextRoundName: string | null };

/**
 * What follows a finished round, in HR's round order (position): a failed round ends the journey (matches stageOf()
 * in grading.ts); a passed one leads to the next online or coding round's invitation, or - when the next round is
 * run by HR (interview, descriptive...) or there is none - to an email saying so.
 */
export function nextStep(rounds: SavedRound[], current: SavedRound, passed: boolean): NextStep {
  if (!passed) return { kind: 'EMAIL', email: 'REJECTED', nextRoundName: null };
  const next = [...rounds].sort((a, b) => a.position - b.position).find((r) => r.position > current.position);
  if (!next) return { kind: 'EMAIL', email: 'CLEARED_ALL', nextRoundName: null };
  if (isInvitedRound(next)) return { kind: 'INVITE', round: next };
  return { kind: 'EMAIL', email: 'CLEARED_NEXT_BY_HR', nextRoundName: next.name };
}

/** How HR sees each event. WARNING = worth a look; it never changes a result by itself. */
export const SEVERITY: Record<ProctorEventType, ProctorSeverity> = {
  ASSESSMENT_STARTED: 'INFO',
  ASSESSMENT_SUBMITTED: 'INFO',
  ASSESSMENT_TIMED_OUT: 'INFO',
  CAMERA_STARTED: 'INFO',
  CAMERA_STOPPED: 'WARNING',
  CAMERA_PERMISSION_REVOKED: 'WARNING',
  TAB_SWITCH: 'WARNING',
  FULLSCREEN_EXIT: 'WARNING',
  CONNECTION_LOST: 'INFO',
};
