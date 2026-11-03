// The browser talks ONLY to the HireFlow API. The code runner (Piston) is reachable only from the backend.
export const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000/api/v1';

// These types mirror apps/api/src/modules/dsa (dsa.service.ts, evaluator.ts, question.types.ts).
export type Language = 'python' | 'java' | 'cpp';
export type Difficulty = 'Easy' | 'Medium' | 'Hard';
export type SessionStatus = 'not_started' | 'in_progress' | 'finished';
export type CaseStatus = 'passed' | 'wrong_answer' | 'runtime_error' | 'time_limit' | 'compile_error' | 'internal_error';
export type Verdict = 'passed' | 'failed' | 'compile_error' | 'internal_error';

export interface PublicQuestion {
  id: string;
  title: string;
  difficulty: Difficulty;
  marks: number;
  description: string;
  inputFormat: string;
  outputFormat: string;
  constraints: string[];
  samples: { input: string; output: string; explanation: string }[];
  starterCode: Record<Language, string>;
  sampleTests: { id: string; input: string; expectedOutput: string }[];
  hiddenTestCount: number;
}

export interface QuestionProgress {
  questionId: string;
  attempts: number;
  bestScore: number;
  passed: number;
  total: number;
  language: Language | null;
  lastVerdict: string | null;
}

export interface QuestionResult {
  questionId: string;
  title: string;
  difficulty: string;
  marks: number;
  score: number;
  passed: number;
  total: number;
  attempts: number;
  language: Language | null;
  solved: boolean;
}

/** Browser events the page may report. Mirrors apps/api/src/modules/dsa/proctoring/proctoring.types.ts. */
export type ProctorInputType =
  | 'FULLSCREEN_EXIT'
  | 'FULLSCREEN_RETURN'
  | 'TAB_SWITCH'
  | 'TAB_RETURN'
  | 'WINDOW_BLUR'
  | 'WINDOW_RETURN'
  | 'COPY'
  | 'CUT'
  | 'PASTE'
  | 'SELECT_ALL'
  | 'CONTEXT_MENU'
  | 'DEVTOOLS_SHORTCUT'
  | 'VIEW_SOURCE'
  | 'SAVE_SHORTCUT'
  | 'PRINT_SHORTCUT'
  | 'SCREENSHOT_ATTEMPT'
  | 'SESSION_RESUMED';

export interface ProctorEventInput {
  type: ProctorInputType;
  /** Server-adjusted time (epoch ms). The server clamps it into the attempt window. */
  at?: number;
  detail?: string;
}

export interface ProctoringConfig {
  enabled: boolean;
  requireFullscreen: boolean;
  fullscreenReentry: 'block' | 'warn';
  autoEnd: boolean;
  /** Suspicious events tolerated as warnings; the next one ends the assessment. 0 = no limit. */
  maxStrikes: number;
  consentVersion: string;
  monitored: string[];
}

export interface ProctoringState extends ProctoringConfig {
  started: boolean;
  violationCount: number;
  level: 'ok' | 'warning' | 'final_warning';
  strikesAllowed: number;
  strikesUsed: number;
}

export interface ProctorRecordResponse {
  accepted: number;
  ignored: number;
  violationCount: number;
  level: 'ok' | 'warning' | 'final_warning';
  strikesAllowed: number;
  strikesUsed: number;
  ended: boolean;
}

export interface FinalResult {
  reason: 'submitted' | 'time_expired' | 'disqualified';
  finishedAt: string;
  totalScore: number;
  maxScore: number;
  percentage: number;
  questions: QuestionResult[];
}

export interface AssessmentState {
  status: SessionStatus;
  candidateName: string;
  title: string;
  durationMinutes: number;
  totalMarks: number;
  languages: Language[];
  overview: { id: string; title: string; difficulty: Difficulty; marks: number }[];
  serverTime: string;
  startedAt: string | null;
  deadlineAt: string | null;
  remainingSeconds: number | null;
  questions?: PublicQuestion[];
  progress: QuestionProgress[];
  result?: FinalResult;
  proctoring: ProctoringState;
  /** False for an HR round: the last page shows no score (the outcome comes by email). */
  showScore: boolean;
}

/** Hidden test cases arrive with only a label, status and timing: no input, expected value or output. */
export interface CaseResult {
  id: string;
  label: string;
  hidden: boolean;
  status: CaseStatus;
  timeMs: number | null;
  memoryKb: number | null;
  input?: string;
  expected?: string;
  actual?: string;
  stdout?: string;
  stderr?: string;
}

export interface RunResponse {
  questionId: string;
  language: Language;
  verdict: Verdict;
  passed: number;
  total: number;
  compileOutput: string;
  cases: CaseResult[];
  remainingSeconds: number;
}

export interface SubmitResponse extends RunResponse {
  score: number;
  maxScore: number;
  progress: QuestionProgress;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method,
      headers: {
        // The HireFlow API refuses every write without this header (CSRF check), even on public routes.
        ...(method === 'GET' ? {} : { 'X-Requested-With': 'hireflow' }),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
    });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Cannot reach the assessment server. Check your connection and try again.');
  }
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const d = (data ?? {}) as { code?: string; message?: string | string[] };
    const message = Array.isArray(d.message) ? d.message.join(' ') : d.message;
    throw new ApiError(res.status, d.code ?? 'ERROR', message || 'Something went wrong. Please try again.');
  }
  return data as T;
}

const base = (token: string) => `/dsa/${encodeURIComponent(token)}`;

export const getAssessment = (token: string) => request<AssessmentState>('GET', base(token));
export const startAssessment = (token: string) => request<AssessmentState>('POST', `${base(token)}/start`);
export const finishAssessment = (token: string) => request<AssessmentState>('POST', `${base(token)}/finish`);
export const runCode = (token: string, input: { questionId: string; language: Language; code: string }) =>
  request<RunResponse>('POST', `${base(token)}/run`, input);
export const submitCode = (token: string, input: { questionId: string; language: Language; code: string }) =>
  request<SubmitResponse>('POST', `${base(token)}/submit`, input);

/** Records consent (and that full screen was on). Must succeed before startAssessment when proctoring is enabled. */
export const startProctoring = (token: string, input: { consentVersion: string; fullscreen: boolean }) =>
  request<ProctoringConfig>('POST', `${base(token)}/proctor/start`, { consent: true, ...input });
export const sendProctorEvents = (token: string, events: ProctorEventInput[]) =>
  request<ProctorRecordResponse>('POST', `${base(token)}/proctor/events`, { events });

export const LANGUAGE_LABELS: Record<Language, string> = { python: 'Python', java: 'Java', cpp: 'C++' };

export function formatClock(totalSeconds: number): string {
  const s = Math.max(0, totalSeconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(sec).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
