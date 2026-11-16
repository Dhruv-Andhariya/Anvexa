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

/**
 * A submission the server ACCEPTED (while the attempt ran, before its deadline) whose tests are still being run. It is
 * judged by when it was accepted, not by when its tests finish: the result is recorded even if the attempt closed
 * meanwhile, and the attempt is not graded until it is in (or until it is clearly abandoned, PENDING_SUBMISSION_MAX_MS).
 */
export interface PendingSubmission {
  id: string;
  questionId: string;
  /** Server time of acceptance (ISO). */
  acceptedAt: string;
}

export interface CodingState {
  progress: Record<string, CodingQuestionState>;
  finishReason: CodingFinishReason | null;
  /** At most one accepted submission being judged (one at a time per attempt). */
  pending?: PendingSubmission | null;
}

/** No `pending` key: it is only present while an accepted submission is being judged (null once its result is in). */
export const emptyCodingState = (): CodingState => ({ progress: {}, finishReason: null });

/**
 * After this long an accepted submission whose result never arrived (the API stopped while judging it) no longer holds
 * the attempt: it is graded without it. Longer than any judging can take: each code-runner request waits at most 60 s
 * in the queue and runs at most 60 s, a submission has at most 10 of them, 2 at a time (5 x 120 s = 10 minutes).
 */
export const PENDING_SUBMISSION_MAX_MS = 15 * 60_000;

/**
 * What to store when a coding attempt ends with the state the page last had: the STORED results win per question (a
 * submission recorded meanwhile is never overwritten by an older copy), questions only the page knows are kept, and the
 * stored pending submission stays pending (its result is recorded when its tests finish).
 */
export function mergeCodingState(stored: CodingState | null, given: CodingState): CodingState {
  return {
    progress: { ...given.progress, ...(stored?.progress ?? {}) },
    finishReason: given.finishReason ?? stored?.finishReason ?? null,
    pending: stored?.pending ?? null,
  };
}

/** An accepted submission is still being judged (and not abandoned). */
export const pendingActive = (state: CodingState | null | undefined, now: Date): boolean => {
  const p = state?.pending;
  if (!p) return false;
  const at = Date.parse(p.acceptedAt);
  return Number.isFinite(at) && now.getTime() - at < PENDING_SUBMISSION_MAX_MS;
};

const round2 = (n: number) => Math.round(n * 100) / 100;
const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
const text = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : null);

/** Reads the attempt's JSON column safely: anything unexpected is dropped, never trusted. */
export function parseCodingState(value: unknown): CodingState {
  const out = emptyCodingState();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  const v = value as { progress?: unknown; finishReason?: unknown; pending?: unknown };
  if (v.finishReason === 'submitted' || v.finishReason === 'time_expired' || v.finishReason === 'disqualified') out.finishReason = v.finishReason;
  if (v.pending && typeof v.pending === 'object' && !Array.isArray(v.pending)) {
    const p = v.pending as Record<string, unknown>;
    const pid = text(p.id, 64);
    const qid = text(p.questionId, 64);
    const at = text(p.acceptedAt, 40);
    if (pid && qid && at && Number.isFinite(Date.parse(at))) out.pending = { id: pid, questionId: qid, acceptedAt: at };
  }
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

/** What a coding round's problems are: SQL queries only, programs only, or both (for the invitation's wording). */
export function codingKindOf(round: Pick<SavedRound, 'questions'>): 'code' | 'sql' | 'mixed' {
  const sql = round.questions.filter((q) => q.sql).length;
  return sql === 0 ? 'code' : sql === round.questions.length ? 'sql' : 'mixed';
}

export type CodingKind = ReturnType<typeof codingKindOf>;

/**
 * Which coding rounds the AI camera watches (DSA_PROCTOR_CAMERA): `all` (default: SQL and DSA rounds), `sql` (SQL-only
 * rounds; DSA rounds without the camera), `off`. on / true count as all, false / 0 / no as off.
 */
export type CameraMode = 'all' | 'sql' | 'off';

export function cameraModeFromEnv(env: NodeJS.ProcessEnv = process.env): CameraMode {
  const v = (env.DSA_PROCTOR_CAMERA ?? '').trim().toLowerCase();
  if (['off', 'false', '0', 'no'].includes(v)) return 'off';
  return v === 'sql' ? 'sql' : 'all';
}

/** Is a coding attempt of this kind camera-monitored under `mode`? (`sql` mode: SQL-only rounds, not mixed ones.) */
export const cameraMonitored = (kind: CodingKind, mode: CameraMode): boolean => mode === 'all' || (mode === 'sql' && kind === 'sql');

export { isDsaRound };
