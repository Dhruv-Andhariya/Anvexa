import { aiScreeningExtractionSchema, type AiScreeningExtraction, type AiScreeningStep, type AiScreeningTurnKind } from '@hireflow/contracts';
import { z } from 'zod';

export interface ScreeningWorkerOptions {
  baseUrl: string;
  /** One spoken answer (transcript + decision). The worker stops itself after SCREENING_TURN_BUDGET_SECONDS (25s). */
  turnTimeoutMs: number;
  speechTimeoutMs: number;
  extractTimeoutMs: number;
  fetch?: typeof fetch;
}

export const screeningWorkerOptionsFromEnv = (env: NodeJS.ProcessEnv = process.env): ScreeningWorkerOptions => ({
  baseUrl: env.AI_WORKER_URL || 'http://localhost:8000',
  turnTimeoutMs: positive(env.SCREENING_WORKER_TIMEOUT_MS, 35_000),
  speechTimeoutMs: positive(env.SCREENING_SPEECH_TIMEOUT_MS, 30_000),
  extractTimeoutMs: positive(env.SCREENING_EXTRACT_TIMEOUT_MS, 75_000),
});

/** Verified job facts the AI may use when the candidate asks something. Only published information. */
export interface ScreeningJobFacts {
  title: string;
  companyName: string;
  locations: string[];
  workMode: string | null;
  employmentType: string | null;
  applicationDeadline: string | null;
  summary: string;
  responsibilities: string[];
  requirements: string[];
  niceToHave: string[];
  benefits: string[];
  aboutCompany: string;
  salary: string | null;
}

export interface TurnInput {
  step: AiScreeningStep;
  kind: AiScreeningTurnKind;
  question: string;
  audio: { bytes: Buffer; mimeType: string };
  history: { step: AiScreeningStep; question: string; answer: string }[];
  job: ScreeningJobFacts;
  followUpAllowed: boolean;
}

const turnResultSchema = z.object({
  audible: z.boolean(),
  transcript: z.string(),
  needsFollowUp: z.boolean(),
  followUpQuestion: z.string().nullable(),
  candidateAskedQuestion: z.boolean(),
  reply: z.string().nullable(),
  candidateIsDone: z.boolean(),
  model: z.string(),
  promptVersion: z.string(),
});
export type TurnResult = z.infer<typeof turnResultSchema>;

const extractResultSchema = z.object({ extraction: aiScreeningExtractionSchema, model: z.string(), promptVersion: z.string() });

/**
 * Why the AI part of a turn did not work. Safe to show (no transcript, no provider payloads).
 *  - retryable: network, timeout, AI busy -> the candidate records the answer again
 *  - audio: the recording itself is unusable -> the candidate records again (same thing, other message)
 */
export class ScreeningWorkerError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'ScreeningWorkerError';
  }
}

/** Typed client for the AI worker's /v1/screening/* endpoints. */
export class ScreeningWorkerClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: ScreeningWorkerOptions) {
    this.fetchImpl = options.fetch ?? fetch;
  }

  async turn(input: TurnInput): Promise<TurnResult> {
    const body = {
      step: input.step,
      kind: input.kind,
      question: input.question,
      audio: { contentBase64: input.audio.bytes.toString('base64'), mimeType: input.audio.mimeType },
      history: input.history.slice(-12),
      job: input.job,
      followUpAllowed: input.followUpAllowed,
    };
    const json = await this.post('/v1/screening/turn', body, this.options.turnTimeoutMs);
    const parsed = turnResultSchema.safeParse(json);
    if (!parsed.success) throw new ScreeningWorkerError('The AI service sent an unexpected answer.', 'AI_WORKER_BAD_RESPONSE', true);
    return parsed.data;
  }

  /** The AI interviewer's words as a WAV file. */
  async speak(text: string): Promise<Buffer> {
    const res = await this.send('/v1/screening/speak', { text }, this.options.speechTimeoutMs);
    if (!res.ok) throw errorFor(res, await res.json().catch(() => undefined));
    return Buffer.from(await res.arrayBuffer());
  }

  async extract(job: ScreeningJobFacts, turns: { seq: number; step: AiScreeningStep; kind: AiScreeningTurnKind; question: string; answer: string; aiReply: string | null }[]): Promise<{
    extraction: AiScreeningExtraction;
    model: string;
    promptVersion: string;
  }> {
    const json = await this.post('/v1/screening/extract', { job, turns }, this.options.extractTimeoutMs);
    const parsed = extractResultSchema.safeParse(json);
    if (!parsed.success) throw new ScreeningWorkerError('The AI service sent an unexpected summary.', 'AI_WORKER_BAD_RESPONSE', true);
    return parsed.data;
  }

  private async post(path: string, body: unknown, timeoutMs: number): Promise<unknown> {
    const res = await this.send(path, body, timeoutMs);
    const json: unknown = await res.json().catch(() => undefined);
    if (!res.ok) throw errorFor(res, json);
    return json;
  }

  private async send(path: string, body: unknown, timeoutMs: number): Promise<Response> {
    try {
      return await this.fetchImpl(new URL(path, this.options.baseUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        throw new ScreeningWorkerError('The AI interviewer took too long to respond.', 'AI_WORKER_TIMEOUT', true);
      }
      throw new ScreeningWorkerError('The AI interviewer is not reachable right now.', 'AI_WORKER_UNAVAILABLE', true);
    }
  }
}

function errorFor(res: Response, json: unknown): ScreeningWorkerError {
  const detail = (json as { detail?: unknown } | undefined)?.detail;
  const code = typeof (detail as { code?: unknown })?.code === 'string' ? (detail as { code: string }).code : `HTTP_${res.status}`;
  if (code === 'AUDIO_UNREADABLE') return new ScreeningWorkerError('We could not use that recording. Please answer again.', code, true);
  if (res.status === 429) {
    const after = Number(res.headers.get('retry-after'));
    return new ScreeningWorkerError('The AI interviewer is busy right now. Please try again in a moment.', code, true, Number.isInteger(after) && after > 0 ? after : undefined);
  }
  // 404: an AI worker from before the screening round existed (not restarted) - not the candidate's fault
  if (res.status === 404) return new ScreeningWorkerError('The AI interviewer is not available yet.', code, true);
  if (res.status >= 500 || res.status === 408) return new ScreeningWorkerError('The AI interviewer had a problem. Please try again.', code, true);
  return new ScreeningWorkerError('The AI interviewer could not process this answer. Please try again.', code, false);
}

function positive(raw: string | undefined, fallback: number): number {
  return Number(raw) > 0 ? Number(raw) : fallback;
}
