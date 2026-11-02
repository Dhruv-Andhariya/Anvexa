import { difficultySchema, questionKindSchema, type Difficulty, type QuestionKind, type RoundType } from '@hireflow/contracts';
import { z } from 'zod';

export interface QuestionGeneratorOptions {
  baseUrl: string;
  timeoutMs: number;
  fetch?: typeof fetch;
}

export const questionGeneratorOptionsFromEnv = (env: NodeJS.ProcessEnv = process.env): QuestionGeneratorOptions => ({
  baseUrl: env.AI_WORKER_URL || 'http://localhost:8000',
  timeoutMs: Number(env.ROUND_QUESTIONS_WORKER_TIMEOUT_MS) > 0 ? Number(env.ROUND_QUESTIONS_WORKER_TIMEOUT_MS) : 90_000,
});

/** Only what the job is about: the approved JD and the requirements HR typed. Never candidate data. */
export interface QuestionJobFacts {
  title: string;
  summary: string;
  responsibilities: string[];
  requirements: string[];
  niceToHave: string[];
  mustHaveSkills: string[];
  niceToHaveSkills: string[];
  experienceMin: number | null;
  experienceMax: number | null;
}

export interface GenerateInput {
  job: QuestionJobFacts;
  round: { type: RoundType; name: string; description: string };
  count: number;
  difficulty: Difficulty;
  topics: string[];
  kinds: QuestionKind[];
  avoid: string[];
}

/** Loose on purpose: the API checks every question with the shared contract and drops the broken ones. */
const rawQuestionSchema = z.object({
  kind: questionKindSchema,
  text: z.string(),
  options: z.array(z.string()).default([]),
  correct: z.array(z.number().int()).default([]),
  modelAnswer: z.string().nullable().default(null),
  language: z.string().nullable().default(null),
  marks: z.number().int().default(1),
  difficulty: difficultySchema.nullable().default(null),
  topics: z.array(z.string()).default([]),
});
const generateResultSchema = z.object({ questions: z.array(z.unknown()), model: z.string(), promptVersion: z.string() });
export type RawGeneratedQuestion = z.infer<typeof rawQuestionSchema>;

export class QuestionGeneratorError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'QuestionGeneratorError';
  }
}

/** Typed client for the AI worker's POST /v1/rounds/questions. */
export class QuestionGeneratorClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: QuestionGeneratorOptions) {
    this.fetchImpl = options.fetch ?? fetch;
  }

  /** Returns every suggestion that has the right shape, and how many did not. */
  async generate(input: GenerateInput): Promise<{ questions: RawGeneratedQuestion[]; invalid: number; model: string; promptVersion: string }> {
    let res: Response;
    try {
      res = await this.fetchImpl(new URL('/v1/rounds/questions', this.options.baseUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch (err) {
      if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        throw new QuestionGeneratorError('The AI took too long to write the questions. Try fewer questions.', 'AI_WORKER_TIMEOUT', 504);
      }
      throw new QuestionGeneratorError('The AI service is not reachable right now.', 'AI_WORKER_UNAVAILABLE', 503);
    }
    const json: unknown = await res.json().catch(() => undefined);
    if (!res.ok) {
      if (res.status === 429) throw new QuestionGeneratorError('The AI is busy right now. Please try again in a minute.', 'AI_BUSY', 429);
      if (res.status === 404) throw new QuestionGeneratorError('The AI service is out of date. Restart the AI worker.', 'AI_WORKER_OUTDATED', 503);
      throw new QuestionGeneratorError('The AI could not write questions this time. Please try again.', 'AI_WORKER_FAILED', 502);
    }
    const parsed = generateResultSchema.safeParse(json);
    if (!parsed.success) throw new QuestionGeneratorError('The AI service sent an unexpected answer.', 'AI_WORKER_BAD_RESPONSE', 502);
    const questions: RawGeneratedQuestion[] = [];
    for (const q of parsed.data.questions) {
      const one = rawQuestionSchema.safeParse(q);
      if (one.success) questions.push(one.data);
    }
    return { questions, invalid: parsed.data.questions.length - questions.length, model: parsed.data.model, promptVersion: parsed.data.promptVersion };
  }
}
