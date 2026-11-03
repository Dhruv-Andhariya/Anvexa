import { isDsaRound, type RoundAnswerInput, type SavedRound } from '@hireflow/contracts';

/**
 * Pure rules of the DSA (coding) rounds (no I/O). The candidate writes code on the dsa module's page; this file knows
 * only what the engine needs afterwards: the state kept per attempt, the marks it adds up to, and the answers handed to
 * the assessments module (which alone decides pass / fail from HR's pass rule).
 */

/** Stored on the attempt as `consentVersion` when a coding attempt starts (the page asks for consent before it starts). */
export const CODING_CONSENT_VERSION = 'dsa-1';

/** Minutes given when HR left the time limit of a coding round empty. */
export const DEFAULT_CODING_MINUTES = 60;

/** assessments.record accepts at most 50,000 characters of code per answer. */
const MAX_CODE_CHARS = 50_000;

export type CodingFinishReason = 'submitted' | 'time_expired' | 'disqualified';

export interface CodingQuestionState {
  attempts: number;
  /** Marks earned by the best submission so far (already marks x passed / total). */
  bestScore: number;
  passed: number;
  total: number;
  language: string | null;
  lastVerdict: string | null;
  /** Source of the best submission, kept for HR's review. Never sent to the browser. */
  bestCode: string | null;
}

export interface CodingState {
  progress: Record<string, CodingQuestionState>;
  finishReason: CodingFinishReason | null;
}

export const emptyCodingState = (): CodingState => ({ progress: {}, finishReason: null });

const round2 = (n: number) => Math.round(n * 100) / 100;
const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
const text = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : null);

/** Reads the attempt's JSON column safely: anything unexpected is dropped, never trusted. */
export function parseCodingState(value: unknown): CodingState {
  const out = emptyCodingState();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  const v = value as { progress?: unknown; finishReason?: unknown };
  if (v.finishReason === 'submitted' || v.finishReason === 'time_expired' || v.finishReason === 'disqualified') out.finishReason = v.finishReason;
  if (v.progress && typeof v.progress === 'object' && !Array.isArray(v.progress)) {
    for (const [id, raw] of Object.entries(v.progress as Record<string, unknown>)) {
      if (!raw || typeof raw !== 'object') continue;
      const r = raw as Record<string, unknown>;
      const best = typeof r.bestScore === 'number' && Number.isFinite(r.bestScore) && r.bestScore >= 0 ? r.bestScore : 0;
      out.progress[id] = {
        attempts: count(r.attempts),
        bestScore: round2(best),
        passed: count(r.passed),
        total: count(r.total),
        language: text(r.language, 20),
        lastVerdict: text(r.lastVerdict, 30),
        bestCode: text(r.bestCode, MAX_CODE_CHARS),
      };
    }
  }
  return out;
}

/** Marks of the round: the best submission of each of the round's questions (never more than the question's marks). */
export function codingMarks(round: Pick<SavedRound, 'questions'>, state: CodingState): number {
  return round2(round.questions.reduce((sum, q) => sum + Math.min(state.progress[q.id]?.bestScore ?? 0, q.marks), 0));
}

/** How many of the round's questions the candidate submitted at least once. */
export const codingAnswered = (round: Pick<SavedRound, 'questions'>, state: CodingState) =>
  round.questions.filter((q) => (state.progress[q.id]?.attempts ?? 0) > 0).length;

/** One answer per question for the assessments module: marks, solved or not, the best code and a one-line summary. */
export function toCodingAnswers(round: SavedRound, state: CodingState): RoundAnswerInput[] {
  return round.questions.map((q) => {
    const p = state.progress[q.id];
    const solved = !!p && p.total > 0 && p.passed === p.total;
    return {
      questionId: q.id,
      answer: p?.bestCode ?? null,
      selected: [],
      isCorrect: solved,
      marksAwarded: Math.min(p?.bestScore ?? 0, q.marks),
      feedback: p && p.attempts > 0 ? `${p.passed} of ${p.total} tests passed${p.language ? ` (${p.language})` : ''}, ${p.attempts} submission${p.attempts === 1 ? '' : 's'}` : 'Not attempted',
    };
  });
}

/** What the assessments module receives for a finished coding attempt. */
export function codingResultInput(round: SavedRound, state: CodingState) {
  return { answers: toCodingAnswers(round, state), marks: codingMarks(round, state) };
}

/** Coding rounds can be switched off (DSA_ROUNDS=off): they are then run by HR like before. */
export function codingRoundsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !['off', 'false', '0', 'no'].includes((env.DSA_ROUNDS ?? '').trim().toLowerCase());
}

/** Minutes the candidate gets: HR's time limit, or the default. */
export const codingMinutes = (round: Pick<SavedRound, 'timeLimitMinutes'>) => round.timeLimitMinutes ?? DEFAULT_CODING_MINUTES;

export { isDsaRound };
