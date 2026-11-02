import {
  assessmentPublicViewSchema,
  saveAssessmentAnswersResultSchema,
  type AssessmentAnswer,
  type AssessmentPublicView,
  type ClientProctorEventType,
  type SaveAssessmentAnswersResult,
} from '@hireflow/contracts';
import { API_URL, ApiError } from './api';

/**
 * Browser client of the M13 online assessment API. Like the screening page: the link token goes in a header
 * (x-assessment-token), never in an API URL, and is only ever held in memory - never in storage, never logged.
 */
const TOKEN_HEADER = 'x-assessment-token';
const CSRF_HEADER = { 'x-requested-with': 'hireflow' } as const;

export class AssessmentApiError extends ApiError {
  constructor(
    status: number,
    code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(status, code, message);
  }
}

async function call(token: string, path: string, init: RequestInit = {}): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}/public/assessment${path}`, {
      ...init,
      cache: 'no-store',
      keepalive: init.method !== undefined && init.method !== 'GET',
      headers: { [TOKEN_HEADER]: token, ...CSRF_HEADER, 'content-type': 'application/json', ...(init.headers ?? {}) },
    });
  } catch {
    throw new AssessmentApiError(0, 'NETWORK_ERROR', 'Connection lost. Your answers are kept on this device and saved when you are back online.', true);
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { code?: unknown; message?: unknown };
    throw new AssessmentApiError(
      res.status,
      typeof body.code === 'string' ? body.code : `HTTP_${res.status}`,
      typeof body.message === 'string' ? body.message : 'Something went wrong. Please try again.',
      res.status >= 500 || res.status === 429,
    );
  }
  return res;
}

export async function getAssessment(token: string): Promise<AssessmentPublicView> {
  return assessmentPublicViewSchema.parse(await (await call(token, '/session')).json());
}

export async function startAssessment(token: string): Promise<AssessmentPublicView> {
  return assessmentPublicViewSchema.parse(await (await call(token, '/start', { method: 'POST', body: JSON.stringify({ consent: true }) })).json());
}

export async function saveAnswers(token: string, revision: number, answers: AssessmentAnswer[]): Promise<SaveAssessmentAnswersResult> {
  const res = await call(token, '/answers', { method: 'PUT', body: JSON.stringify({ revision, answers }) });
  return saveAssessmentAnswersResultSchema.parse(await res.json());
}

export async function submitAssessment(token: string, revision: number, answers: AssessmentAnswer[]): Promise<AssessmentPublicView> {
  const res = await call(token, '/submit', { method: 'POST', body: JSON.stringify({ revision, answers }) });
  return assessmentPublicViewSchema.parse(await res.json());
}

export interface ProctorEventInput {
  type: ClientProctorEventType;
  occurredAt: string;
  detail?: Record<string, string | number | boolean>;
}

export async function sendEvents(token: string, events: ProctorEventInput[]): Promise<void> {
  await call(token, '/events', { method: 'POST', body: JSON.stringify({ events }) });
}
