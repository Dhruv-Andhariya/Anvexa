import { resumeScreenResultSchema, type JdContent, type JobForm, type ResumeScreenResult } from '@hireflow/contracts';

export interface AtsWorkerOptions {
  baseUrl: string;
  timeoutMs: number;
  fetch?: typeof fetch;
}

export const atsWorkerOptionsFromEnv = (env: NodeJS.ProcessEnv = process.env): AtsWorkerOptions => ({
  baseUrl: env.AI_WORKER_URL || 'http://localhost:8000',
  // the worker stops itself after RESUME_SCREEN_BUDGET_SECONDS (80s); wait a little longer than that
  timeoutMs: Number(env.ATS_WORKER_TIMEOUT_MS) > 0 ? Number(env.ATS_WORKER_TIMEOUT_MS) : 100_000,
});

/**
 * Why screening did not work. Never a reason to reject a student:
 *  - retryable: network, timeout, AI busy or out of quota -> try again later
 *  - review: the file cannot be read, or the worker refused the input -> HR looks at it by hand
 * Messages are safe to store and show (no resume content, no provider payloads).
 */
export class AtsWorkerError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly code: string,
    /** Seconds to wait before trying again (the worker's Retry-After on a quota error). */
    readonly retryAfterSeconds?: number,
    /** The AI quota is used up: every resume would fail the same way, so screening pauses as a whole. */
    readonly quota = false,
  ) {
    super(message);
    this.name = 'AtsWorkerError';
  }
}

export interface ScreenInput {
  resume: { fileName: string; mimeType: string; bytes: Buffer };
  form: JobForm;
  jd: JdContent;
}

/** Thin typed client for the AI worker's POST /v1/resume/screen. */
export class AtsWorkerClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: AtsWorkerOptions) {
    this.fetchImpl = options.fetch ?? fetch;
  }

  async screen(input: ScreenInput): Promise<ResumeScreenResult> {
    const { form, jd } = input;
    const body = {
      resume: { fileName: input.resume.fileName.slice(0, 200), mimeType: input.resume.mimeType, contentBase64: input.resume.bytes.toString('base64') },
      // only what screening needs from the approved version (never anything private)
      job: {
        title: form.title,
        department: form.department,
        experienceMin: form.experienceMin,
        experienceMax: form.experienceMax,
        mustHaveSkills: form.mustHaveSkills,
        niceToHaveSkills: form.niceToHaveSkills,
        employmentType: form.employmentType,
        shortDescription: form.shortDescription,
      },
      jd: { title: jd.title, summary: jd.summary, responsibilities: jd.responsibilities, requirements: jd.requirements, niceToHave: jd.niceToHave },
    };

    let res: Response;
    try {
      res = await this.fetchImpl(new URL('/v1/resume/screen', this.options.baseUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch (err) {
      if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        throw new AtsWorkerError('The AI service took too long to read the resume.', true, 'AI_WORKER_TIMEOUT');
      }
      throw new AtsWorkerError('The AI service is not reachable right now.', true, 'AI_WORKER_UNAVAILABLE');
    }

    const json: unknown = await res.json().catch(() => undefined);
    if (!res.ok) throw errorFor(res, json);
    const parsed = resumeScreenResultSchema.safeParse(json);
    if (!parsed.success) throw new AtsWorkerError('The AI service sent an unexpected answer.', true, 'AI_WORKER_BAD_RESPONSE');
    return parsed.data;
  }
}

function errorFor(res: Response, json: unknown): AtsWorkerError {
  const detail = (json as { detail?: unknown } | undefined)?.detail;
  const code = typeof (detail as { code?: unknown })?.code === 'string' ? (detail as { code: string }).code : `HTTP_${res.status}`;
  const message = typeof (detail as { message?: unknown })?.message === 'string' ? (detail as { message: string }).message.slice(0, 300) : '';

  if (code === 'RESUME_UNREADABLE') return new AtsWorkerError(message || 'The resume could not be read.', false, code);
  if (res.status === 429) {
    const after = Number(res.headers.get('retry-after'));
    return new AtsWorkerError('The AI service is busy (quota reached). Trying again later.', true, code, Number.isInteger(after) && after > 0 ? after : undefined, true);
  }
  // 404: an AI worker from before resume screening existed (not restarted yet) - not the student's fault
  if (res.status === 404) return new AtsWorkerError('The AI service does not offer resume screening yet (restart the AI worker).', true, code);
  if (res.status >= 500 || res.status === 408) return new AtsWorkerError('The AI service failed to read the resume. Trying again later.', true, code);
  // 4xx: the worker refused this input (e.g. LLM_BLOCKED, a job without skills) - sending it again will not help
  return new AtsWorkerError(message || `The AI service could not screen this resume (${res.status}).`, false, code);
}
