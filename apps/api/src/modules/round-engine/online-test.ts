import {
  ROUND_MODULE_OF,
  isDsaRound,
  isOnlineRound,
  type AssessmentAnswer,
  type AssessmentQuestion,
  type ProctorEventType,
  type ProctorSeverity,
  type RoundAnswerInput,
  type RoundModule,
  type RoundOutcomeEmailKind,
  type SavedRound,
} from '@hireflow/contracts';
import { codingRoundsEnabled } from './coding-round';

/**
 * Pure rules of the online test rounds (no I/O): which rounds run online, what the candidate may see, which answers
 * are valid, and what happens after a result. Pass / fail itself is decided by the assessments module (grading.ts).
 */

/** A save / submit may arrive this long after the deadline (slow network) and still count. */
export const DEADLINE_GRACE_MS = 30_000;

/** The answers as stored on the attempt: questionId -> selection. */
export type StoredAnswers = Record<string, { selected: number[]; marked: boolean }>;

/** Which rounds run online (shared with the HR dashboard through contracts). */
export { isOnlineRound };

/** How the engine runs a round: an online test (MCQ page on the careers site), a DSA coding round, or not at all (HR runs it). */
export type RoundKind = 'TEST' | 'CODING';

/** A round the engine runs by itself, and how. Coding rounds follow DSA_ROUNDS (off = HR runs them). */
export function roundKind(round: Pick<SavedRound, 'passRule' | 'questions'>, codingEnabled: boolean = codingRoundsEnabled()): RoundKind | null {
  if (isOnlineRound(round)) return 'TEST';
  if (codingEnabled && isDsaRound(round)) return 'CODING';
  return null;
}

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
  | { kind: 'INVITE'; round: SavedRound; roundKind: RoundKind }
  | { kind: 'EMAIL'; email: RoundOutcomeEmailKind; nextRoundName: string | null }
  /** The next round is an AI group discussion: the group-discussion module (M18) takes the student from here. */
  | { kind: 'GROUP_DISCUSSION'; round: SavedRound }
  /** The next round is run by another connected round module (DSA, SQL, AI interview): it takes the student from here. */
  | { kind: 'MODULE'; module: RoundModule; round: SavedRound };

/**
 * What follows a finished round, in HR's round order (position): a failed round ends the journey (matches stageOf()
 * in grading.ts); a passed one leads to the next online round's invitation, to the GD module's pool when the next
 * round is a group discussion (and that module is on), to the next round's module when it is connected (DSA, SQL,
 * AI interview), or - when the next round is run by HR (interview...) or there is none - to an email saying so.
 */
export function nextStep(
  rounds: SavedRound[],
  current: SavedRound,
  passed: boolean,
  opts: { groupDiscussion?: boolean; modules?: ReadonlySet<RoundModule> } = {},
): NextStep {
  if (!passed) return { kind: 'EMAIL', email: 'REJECTED', nextRoundName: null };
  const next = [...rounds].sort((a, b) => a.position - b.position).find((r) => r.position > current.position);
  if (!next) return { kind: 'EMAIL', email: 'CLEARED_ALL', nextRoundName: null };
  const nextKind = roundKind(next);
  if (nextKind) return { kind: 'INVITE', round: next, roundKind: nextKind };
  if (opts.groupDiscussion && next.type === 'GROUP_DISCUSSION') return { kind: 'GROUP_DISCUSSION', round: next };
  const module = ROUND_MODULE_OF[next.type];
  // DSA rounds are the engine's own (roundKind CODING above); a coding round without DSA problems is run by HR
  if (module && module !== 'GROUP_DISCUSSION' && module !== 'DSA' && opts.modules?.has(module)) return { kind: 'MODULE', module, round: next };
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
