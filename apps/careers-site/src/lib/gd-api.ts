import {
  gdJoinResultSchema,
  gdLiveStateSchema,
  gdPrivateTalkConnectionSchema,
  gdPublicSessionSchema,
  gdRecordingStartedSchema,
  type GdClientEventType,
  type GdJoinResult,
  type GdLiveState,
  type GdPrivateTalkConnection,
  type GdPublicSession,
  type GdRecordingStarted,
} from '@hireflow/contracts';
import { API_URL, ApiError } from './api';

/**
 * Browser client of the M18 group discussion API. Like the assessment page: the personal link token goes in a header
 * (x-gd-token), never in an API URL, and is only ever held in memory.
 */
const TOKEN_HEADER = 'x-gd-token';
const CSRF_HEADER = { 'x-requested-with': 'hireflow' } as const;

export class GdApiError extends ApiError {
  constructor(
    status: number,
    code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(status, code, message);
  }
}

async function call(token: string, path: string, init: RequestInit = {}, json = true): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}/public/gd${path}`, {
      ...init,
      cache: 'no-store',
      headers: { [TOKEN_HEADER]: token, ...CSRF_HEADER, ...(json ? { 'content-type': 'application/json' } : {}), ...(init.headers ?? {}) },
    });
  } catch {
    throw new GdApiError(0, 'NETWORK_ERROR', 'Connection lost. Retrying…', true);
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { code?: unknown; message?: unknown };
    throw new GdApiError(
      res.status,
      typeof body.code === 'string' ? body.code : `HTTP_${res.status}`,
      typeof body.message === 'string' ? body.message : 'Something went wrong. Please try again.',
      res.status >= 500 || res.status === 429,
    );
  }
  return res;
}

export const getGdSession = async (token: string): Promise<GdPublicSession> => gdPublicSessionSchema.parse(await (await call(token, '/session')).json());

export const joinGd = async (token: string): Promise<GdJoinResult> =>
  gdJoinResultSchema.parse(await (await call(token, '/join', { method: 'POST', body: JSON.stringify({ consent: true }) })).json());

export const getGdState = async (token: string): Promise<GdLiveState> => gdLiveStateSchema.parse(await (await call(token, '/state')).json());

export const getGdPrivateTalk = async (token: string): Promise<GdPrivateTalkConnection> =>
  gdPrivateTalkConnectionSchema.parse(await (await call(token, '/private')).json());

export async function sendGdEvents(token: string, events: { type: GdClientEventType; occurredAt: string }[]): Promise<void> {
  await call(token, '/events', { method: 'POST', body: JSON.stringify({ events }) });
}

export const startGdRecording = async (token: string, mimeType: string): Promise<GdRecordingStarted> =>
  gdRecordingStartedSchema.parse(await (await call(token, '/recordings', { method: 'POST', body: JSON.stringify({ mimeType }) })).json());

export async function uploadGdChunk(token: string, recordingId: string, seq: number, chunk: Blob): Promise<void> {
  const form = new FormData();
  form.append('seq', String(seq));
  form.append('chunk', chunk, `${seq}.chunk`);
  await call(token, `/recordings/${encodeURIComponent(recordingId)}/chunks`, { method: 'POST', body: form }, false);
}
