import {
  aiInterviewAnswerResultSchema,
  aiInterviewPublicSessionSchema,
  aiInterviewQuestionSchema,
  aiInterviewViolationResultSchema,
  type AiInterviewAnswerResult,
  type AiInterviewEventType,
  type AiInterviewViolationResult,
  type AiInterviewViolationType,
  type AiInterviewPauseRequest,
  type AiInterviewPublicSession,
  type AiInterviewQuestion,
} from '@hireflow/contracts';
import { API_URL, ApiError } from './api';
import { extensionFor, type Recording } from './screening-api';

/**
 * Browser client of the AI technical interview API. The link token goes in a header (x-interview-token), never in an
 * API URL, and is only ever held in memory - never in localStorage / sessionStorage, never logged.
 */
const TOKEN_HEADER = 'x-interview-token';
const CSRF_HEADER = { 'x-requested-with': 'hireflow' } as const;

export class InterviewApiError extends ApiError {
  constructor(
    status: number,
    code: string,
    message: string,
    readonly retryable: boolean,
    readonly current: AiInterviewQuestion | null = null,
  ) {
    super(status, code, message);
  }
}

async function readError(res: Response): Promise<InterviewApiError> {
  const body = (await res.json().catch(() => ({}))) as { code?: unknown; message?: unknown; retryable?: unknown; current?: unknown };
  const code = typeof body.code === 'string' ? body.code : `HTTP_${res.status}`;
  const current = aiInterviewQuestionSchema.safeParse(body.current);
  return new InterviewApiError(
    res.status,
    code,
    typeof body.message === 'string' ? body.message : 'Something went wrong. Please try again.',
    body.retryable === true || res.status >= 500 || res.status === 429,
    current.success ? current.data : null,
  );
}

async function call(token: string, path: string, init: RequestInit = {}): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}/public/interview${path}`, {
      ...init,
      cache: 'no-store',
      headers: { [TOKEN_HEADER]: token, ...CSRF_HEADER, ...(init.headers ?? {}) },
    });
  } catch {
    throw new InterviewApiError(0, 'NETWORK_ERROR', 'Connection lost. Check your internet - your answers so far are saved.', true);
  }
  if (!res.ok) throw await readError(res);
  return res;
}

const json = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

export async function getSession(token: string): Promise<AiInterviewPublicSession> {
  return aiInterviewPublicSessionSchema.parse(await (await call(token, '/session')).json());
}

export async function startSession(token: string): Promise<AiInterviewPublicSession> {
  return aiInterviewPublicSessionSchema.parse(await (await call(token, '/start', json({ consent: true, camera: true, microphone: true }))).json());
}

export async function resumeSession(token: string): Promise<AiInterviewPublicSession> {
  return aiInterviewPublicSessionSchema.parse(await (await call(token, '/resume', json({ camera: true, microphone: true }))).json());
}

/** keepalive: still delivered when the page is being closed. */
export async function pauseSession(token: string, reason: AiInterviewPauseRequest['reason'], keepalive = false): Promise<AiInterviewPublicSession | null> {
  const res = await call(token, '/pause', { ...json({ reason }), keepalive });
  return keepalive ? null : aiInterviewPublicSessionSchema.parse(await res.json());
}

export async function endSession(token: string): Promise<AiInterviewPublicSession> {
  return aiInterviewPublicSessionSchema.parse(await (await call(token, '/end', json({}))).json());
}

export async function repeatQuestion(token: string): Promise<number> {
  const body = (await (await call(token, '/repeat', json({}))).json()) as { repeatsLeft?: number };
  return typeof body.repeatsLeft === 'number' ? body.repeatsLeft : 0;
}

export interface PageEvent {
  type: AiInterviewEventType;
  occurredAt: string;
  detail?: string;
}

/** Device / connection facts for the hiring team. Best effort: a lost event never interrupts the interview. */
export async function sendEvents(token: string, events: PageEvent[], keepalive = false): Promise<void> {
  if (!events.length) return;
  await call(token, '/events', { ...json({ events: events.slice(0, 50) }), keepalive }).catch(() => undefined);
}

/**
 * One monitored incident (interview protection). Sent with keepalive: it is usually sent while the page is being
 * hidden. The same incident id may be sent again safely (counted once). The answer is the SERVER's warning count.
 */
export async function reportViolation(token: string, incident: { id: string; type: AiInterviewViolationType; detail?: string }): Promise<AiInterviewViolationResult> {
  const res = await call(token, '/violation', { ...json({ incidentId: incident.id, type: incident.type, ...(incident.detail ? { detail: incident.detail } : {}) }), keepalive: true });
  return aiInterviewViolationResultSchema.parse(await res.json());
}

/** The candidate read warning N (so it is not shown again after a reload). Best effort. */
export async function acknowledgeWarning(token: string, warningNumber: number): Promise<void> {
  await call(token, '/violation/ack', json({ warningNumber })).catch(() => undefined);
}

/** The question spoken (WAV). Kept as a Blob so "repeat" never needs the network again. */
export async function getSpeech(token: string, seq: number): Promise<Blob> {
  return (await call(token, `/speech?seq=${seq}`)).blob();
}

/** One answer. The same clientTurnId may be sent again safely (it is saved once). */
export async function sendAnswer(token: string, seq: number, clientTurnId: string, rec: Recording): Promise<AiInterviewAnswerResult> {
  const form = new FormData();
  form.append('seq', String(seq));
  form.append('clientTurnId', clientTurnId);
  form.append('durationMs', String(Math.round(rec.durationMs)));
  form.append('audio', rec.blob, `answer.${extensionFor(rec.mimeType)}`);
  const res = await call(token, '/answer', { method: 'POST', body: form });
  return aiInterviewAnswerResultSchema.parse(await res.json());
}
