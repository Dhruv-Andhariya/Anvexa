import {
  aiScreeningAnswerResultSchema,
  aiScreeningPublicSessionSchema,
  aiScreeningQuestionSchema,
  type AiScreeningAnswerResult,
  type AiScreeningPublicSession,
  type AiScreeningQuestion,
} from '@hireflow/contracts';
import { API_URL, ApiError } from './api';

/**
 * Browser client of the M12 AI screening API. The link token goes in a header (x-screening-token), never in an API
 * URL, and is only ever held in memory - never in localStorage / sessionStorage, never logged.
 */
const TOKEN_HEADER = 'x-screening-token';
const CSRF_HEADER = { 'x-requested-with': 'hireflow' } as const;

export class ScreeningApiError extends ApiError {
  constructor(
    status: number,
    code: string,
    message: string,
    readonly retryable: boolean,
    readonly current: AiScreeningQuestion | null = null,
  ) {
    super(status, code, message);
  }
}

async function readError(res: Response): Promise<ScreeningApiError> {
  const body = (await res.json().catch(() => ({}))) as { code?: unknown; message?: unknown; retryable?: unknown; current?: unknown };
  const code = typeof body.code === 'string' ? body.code : `HTTP_${res.status}`;
  const current = aiScreeningQuestionSchema.safeParse(body.current);
  return new ScreeningApiError(
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
    res = await fetch(`${API_URL}/public/screening${path}`, {
      ...init,
      cache: 'no-store',
      headers: { [TOKEN_HEADER]: token, ...CSRF_HEADER, ...(init.headers ?? {}) },
    });
  } catch {
    throw new ScreeningApiError(0, 'NETWORK_ERROR', 'Connection lost. Check your internet - your answers so far are saved.', true);
  }
  if (!res.ok) throw await readError(res);
  return res;
}

export async function getSession(token: string): Promise<AiScreeningPublicSession> {
  return aiScreeningPublicSessionSchema.parse(await (await call(token, '/session')).json());
}

export async function startSession(token: string, consent: boolean): Promise<AiScreeningPublicSession> {
  const res = await call(token, '/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(consent ? { consent: true } : {}) });
  return aiScreeningPublicSessionSchema.parse(await res.json());
}

export async function endSession(token: string): Promise<AiScreeningPublicSession> {
  const res = await call(token, '/end', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  return aiScreeningPublicSessionSchema.parse(await res.json());
}

/** The question spoken (WAV). Kept as a Blob so "repeat" never needs the network again. */
export async function getSpeech(token: string, seq: number): Promise<Blob> {
  return (await call(token, `/speech?seq=${seq}`)).blob();
}

export interface Recording {
  blob: Blob;
  mimeType: string;
  durationMs: number;
}

/** One answer. The same clientTurnId may be sent again safely (it is saved once). */
export async function sendAnswer(token: string, seq: number, clientTurnId: string, rec: Recording): Promise<AiScreeningAnswerResult> {
  const form = new FormData();
  form.append('seq', String(seq));
  form.append('clientTurnId', clientTurnId);
  form.append('durationMs', String(Math.round(rec.durationMs)));
  form.append('audio', rec.blob, `answer.${extensionFor(rec.mimeType)}`);
  const res = await call(token, '/answer', { method: 'POST', body: form });
  return aiScreeningAnswerResultSchema.parse(await res.json());
}

export function extensionFor(mime: string): string {
  const base = mime.split(';')[0]!.trim().toLowerCase();
  return base === 'audio/mp4' || base === 'audio/x-m4a' ? 'm4a' : base === 'audio/ogg' ? 'ogg' : base === 'audio/wav' ? 'wav' : 'webm';
}

/** An id for one recorded answer, used to make re-sends idempotent. */
export function newClientTurnId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
