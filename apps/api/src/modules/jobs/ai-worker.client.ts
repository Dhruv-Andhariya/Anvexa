import { HttpStatus } from '@nestjs/common';
import { jdContentSchema, type CompanyProfile, type JdContent, type JobForm } from '@hireflow/contracts';
import { apiError } from '../../common/api-error';

export interface AiWorkerOptions {
  baseUrl: string;
  timeoutMs: number;
  fetch?: typeof fetch;
}

export const aiWorkerOptionsFromEnv = (): AiWorkerOptions => ({
  baseUrl: process.env.AI_WORKER_URL || 'http://localhost:8000',
  // Gemini generation can take tens of seconds. The worker stops retrying / falling back once its total budget
  // (JD_GENERATION_BUDGET_SECONDS, default 80s) is spent, so it answers before this timeout.
  timeoutMs: Number(process.env.AI_WORKER_TIMEOUT_MS) || 90_000,
});

export interface GeneratedJd {
  content: JdContent;
  model: string | null;
  promptVersion: string | null;
}

/** Worker error codes that are safe to pass through to the browser (see ai_worker/llm_gateway/errors.py). */
const PASSTHROUGH_STATUS = new Set([422, 429, 502, 503, 504]);

/** Thin typed HTTP client for the Python AI worker. Never forwards raw worker/provider payloads. */
export class AiWorkerClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: AiWorkerOptions) {
    this.fetchImpl = options.fetch ?? fetch;
  }

  /** Step 3: the worker receives BOTH inputs - the job form and the saved company profile. */
  async generateJd(form: JobForm, company: CompanyProfile): Promise<GeneratedJd> {
    let res: Response;
    try {
      res = await this.fetchImpl(new URL('/v1/jd/generate', this.options.baseUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...form, company }),
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch (err) {
      if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        throw apiError(HttpStatus.GATEWAY_TIMEOUT, 'AI_WORKER_TIMEOUT', 'JD generation took too long. Please try again.');
      }
      throw apiError(HttpStatus.SERVICE_UNAVAILABLE, 'AI_WORKER_UNAVAILABLE', 'The AI service is not reachable right now.');
    }

    const body: unknown = await res.json().catch(() => undefined);

    if (!res.ok) {
      const detail = workerErrorDetail(body);
      if (PASSTHROUGH_STATUS.has(res.status) && detail) {
        const err = apiError(res.status, detail.code, detail.message);
        const retryAfter = Number(res.headers.get('retry-after'));
        if (res.status === 429 && Number.isInteger(retryAfter) && retryAfter > 0) {
          (err.getResponse() as Record<string, unknown>).retryAfterSeconds = retryAfter; // from the worker's Retry-After
        }
        throw err;
      }
      if (res.status === 422) {
        throw apiError(HttpStatus.BAD_REQUEST, 'INVALID_JOB_FORM', 'The AI service rejected the job form.');
      }
      throw apiError(HttpStatus.BAD_GATEWAY, 'AI_WORKER_ERROR', 'The AI service failed to generate the job description.');
    }

    const parsed = jdContentSchema.safeParse(body);
    if (!parsed.success) {
      throw apiError(HttpStatus.BAD_GATEWAY, 'AI_WORKER_INVALID_RESPONSE', 'The AI service returned an invalid job description.');
    }
    return {
      content: parsed.data,
      model: res.headers.get('x-llm-model'),
      promptVersion: res.headers.get('x-prompt-version'),
    };
  }
}

function workerErrorDetail(body: unknown): { code: string; message: string } | undefined {
  const detail = (body as { detail?: unknown } | undefined)?.detail;
  if (detail && typeof detail === 'object') {
    const { code, message } = detail as Record<string, unknown>;
    if (typeof code === 'string' && typeof message === 'string') return { code, message };
  }
  return undefined;
}
