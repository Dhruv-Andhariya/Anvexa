import { z } from 'zod';
import type { QuestionJobFacts } from '../../rounds-config/question-generator.client';

export interface CodingAuthorOptions {
  baseUrl: string;
  timeoutMs: number;
  fetch?: typeof fetch;
}

export const codingAuthorOptionsFromEnv = (env: NodeJS.ProcessEnv = process.env): CodingAuthorOptions => ({
  baseUrl: env.AI_WORKER_URL || 'http://localhost:8000',
  timeoutMs: Number(env.CODING_PROBLEMS_WORKER_TIMEOUT_MS) > 0 ? Number(env.CODING_PROBLEMS_WORKER_TIMEOUT_MS) : 120_000,
});

export interface CodingAuthorInput {
  mode: 'generate' | 'extract';
  job: QuestionJobFacts;
  count: number;
  difficulty: 'EASY' | 'MEDIUM' | 'HARD';
  topics: string[];
  avoid: string[];
  document?: { contentBase64: string; mimeType: string };
}

/** Loose on purpose: the service checks every problem and runs its solution before HR sees it. */
const rawProblemSchema = z.object({
  title: z.string(),
  statement: z.string(),
  inputFormat: z.string().default(''),
  outputFormat: z.string().default(''),
  constraints: z.string().default(''),
  difficulty: z.enum(['EASY', 'MEDIUM', 'HARD']).default('MEDIUM'),
  marks: z.number().int().default(10),
  referenceSolution: z.string().default(''),
  samples: z.array(z.object({ input: z.string(), output: z.string() })).default([]),
  hiddenInputs: z.array(z.string()).default([]),
});
export type RawCodingProblem = z.infer<typeof rawProblemSchema>;
const resultSchema = z.object({ problems: z.array(z.unknown()), model: z.string(), promptVersion: z.string() });

export class CodingAuthorError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'CodingAuthorError';
  }
}

/** Typed client for the AI worker's POST /v1/rounds/coding-problems. */
export class CodingAuthorClient {
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly options: CodingAuthorOptions) {
    this.fetchImpl = options.fetch ?? fetch;
  }

  async problems(input: CodingAuthorInput): Promise<{ problems: RawCodingProblem[]; invalid: number; model: string; promptVersion: string }> {
    let res: Response;
    try {
      res = await this.fetchImpl(new URL('/v1/rounds/coding-problems', this.options.baseUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch (err) {
      if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        throw new CodingAuthorError('The AI took too long. Try fewer problems, or a shorter file.', 'AI_WORKER_TIMEOUT', 504);
      }
      throw new CodingAuthorError('The AI service is not reachable right now.', 'AI_WORKER_UNAVAILABLE', 503);
    }
    const json: unknown = await res.json().catch(() => undefined);
    if (!res.ok) {
      const detail = (json as { detail?: { code?: string; message?: string } } | undefined)?.detail;
      if (res.status === 422 && detail?.code === 'DOCUMENT_UNREADABLE') throw new CodingAuthorError(detail.message ?? 'The file could not be read.', 'DOCUMENT_UNREADABLE', 422);
      if (res.status === 429) throw new CodingAuthorError('The AI is busy right now. Please try again in a minute.', 'AI_BUSY', 429);
      if (res.status === 404) throw new CodingAuthorError('The AI service is out of date. Restart the AI worker.', 'AI_WORKER_OUTDATED', 503);
      throw new CodingAuthorError('The AI could not prepare the problems this time. Please try again.', 'AI_WORKER_FAILED', 502);
    }
    const parsed = resultSchema.safeParse(json);
    if (!parsed.success) throw new CodingAuthorError('The AI service sent an unexpected answer.', 'AI_WORKER_BAD_RESPONSE', 502);
    const problems: RawCodingProblem[] = [];
    for (const p of parsed.data.problems) {
      const one = rawProblemSchema.safeParse(p);
      if (one.success) problems.push(one.data);
    }
    return { problems, invalid: parsed.data.problems.length - problems.length, model: parsed.data.model, promptVersion: parsed.data.promptVersion };
  }
}
