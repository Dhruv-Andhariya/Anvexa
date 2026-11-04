import { aiInterviewReportSchema, type AiInterviewReport } from '@hireflow/contracts';
import { z } from 'zod';
import type { Decision, PlanTopic } from './flow';

export interface InterviewWorkerOptions {
  baseUrl: string;
  /** The topic plan at the start. The worker stops itself after INTERVIEW_PLAN_BUDGET_SECONDS (45 s). */
  planTimeoutMs: number;
  /**
   * One spoken answer (transcript + next question): INTERVIEW_TURN_BUDGET_SECONDS (24 s) on the worker. The whole
   * request must stay under the careers-site proxy's 30 s, or the candidate's browser sees a dropped connection.
   */
  turnTimeoutMs: number;
  speechTimeoutMs: number;
  reportTimeoutMs: number;
  fetch?: typeof fetch;
}

const positive = (raw: string | undefined, fallback: number) => (Number(raw) > 0 ? Number(raw) : fallback);

export const interviewWorkerOptionsFromEnv = (env: NodeJS.ProcessEnv = process.env): InterviewWorkerOptions => ({
  baseUrl: env.AI_WORKER_URL || 'http://localhost:8000',
  planTimeoutMs: positive(env.INTERVIEW_PLAN_TIMEOUT_MS, 55_000),
  turnTimeoutMs: positive(env.INTERVIEW_TURN_TIMEOUT_MS, 28_000),
  speechTimeoutMs: positive(env.SCREENING_SPEECH_TIMEOUT_MS, 30_000),
  reportTimeoutMs: positive(env.INTERVIEW_REPORT_TIMEOUT_MS, 115_000),
});

/** What the interviewer may know about the job: the approved JD the candidate applied to + the form's skills. */
export interface InterviewJobFacts {
  title: string;
  summary: string;
  responsibilities: string[];
  requirements: string[];
  niceToHave: string[];
  skills: string[];
  experienceLevel: string | null;
}

/** The parsed resume from the ATS step, in the worker's shape. */
export interface InterviewResumeFacts {
  summary: string;
  skills: string[];
  projects: { title: string; technologies: string[]; summary: string }[];
  experience: { organization: string; role: string; kind: string; months: number; summary: string }[];
  education: string[];
  certifications: string[];
  achievements: string[];
}

export const EMPTY_RESUME: InterviewResumeFacts = { summary: '', skills: [], projects: [], experience: [], education: [], certifications: [], achievements: [] };

export interface HrQuestionFacts {
  text: string;
  topics: string[];
  expectedAnswer: string | null;
}

const topicSchema = z.object({
  id: z.string(),
  title: z.string(),
  source: z.enum(['RESUME', 'JOB', 'SCENARIO', 'HR']),
  resumeRef: z.string().nullable(),
  skill: z.string().nullable(),
  goal: z.string(),
  question: z.string(),
  priority: z.number().int(),
});
const planResultSchema = z.object({ topics: z.array(topicSchema), model: z.string(), promptVersion: z.string() });

const decisionSchema = z.object({
  reading: z.string().nullable(),
  action: z.enum(['FOLLOW_UP', 'CLARIFY', 'NEXT_TOPIC', 'CONCLUDE']),
  question: z.string().nullable(),
  topicId: z.string().nullable(),
  newTopicTitle: z.string().nullable(),
  newTopicSource: z.enum(['RESUME', 'JOB', 'SCENARIO', 'HR']).nullable(),
  newTopicResumeRef: z.string().nullable(),
  coveredTopicIds: z.array(z.string()),
});
const turnResultSchema = z.object({
  audible: z.boolean(),
  transcript: z.string(),
  normalizedTranscript: z.string(),
  quality: z.enum(['CLEAR', 'PARTLY_UNCLEAR', 'UNCLEAR']),
  unclearTerms: z.array(z.string()),
  decision: decisionSchema.nullable(),
  model: z.string(),
  promptVersion: z.string(),
});
export type InterviewTurnResult = z.infer<typeof turnResultSchema>;

const reportResultSchema = z.object({ report: aiInterviewReportSchema, model: z.string(), promptVersion: z.string() });

export interface TurnInput {
  audio: { bytes: Buffer; mimeType: string };
  vocabulary: string[];
  question: { text: string; kind: string; topicId: string | null };
  decide: boolean;
  followUpAllowed: boolean;
  timing: { elapsedSeconds: number; remainingSeconds: number; durationMinutes: number; phase: 'CORE' | 'MAY_CONCLUDE' | 'FINAL' };
  plan: PlanTopic[];
  coveredTopicIds: string[];
  history: { seq: number; question: string; answer: string; topicId: string | null }[];
  job: InterviewJobFacts;
  resume: InterviewResumeFacts;
}

export interface ReportInput {
  job: InterviewJobFacts;
  resume: InterviewResumeFacts;
  hrQuestions: HrQuestionFacts[];
  turns: { seq: number; kind: string; source: string; topic: string | null; question: string; answer: string; quality: string }[];
  durationMinutes: number;
  usedSeconds: number;
  status: 'COMPLETED' | 'INCOMPLETE';
}

/**
 * Why the AI part did not work. Safe to show (no transcript, no provider payloads).
 *  - retryable: network, timeout, AI busy -> the candidate sends the same recording again
 *  - AUDIO_UNREADABLE: the recording itself is unusable -> the candidate answers again
 */
export class InterviewWorkerError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'InterviewWorkerError';
  }
}

/** Typed client for the AI worker's /v1/interview/* endpoints. */
export class InterviewWorkerClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: InterviewWorkerOptions) {
    this.fetchImpl = options.fetch ?? fetch;
  }

  async plan(input: { candidateFirstName: string; durationMinutes: number; job: InterviewJobFacts; resume: InterviewResumeFacts; hrQuestions: HrQuestionFacts[] }) {
    const json = await this.post('/v1/interview/plan', input, this.options.planTimeoutMs);
    const parsed = planResultSchema.safeParse(json);
    if (!parsed.success) throw new InterviewWorkerError('The AI service sent an unexpected plan.', 'AI_WORKER_BAD_RESPONSE', true);
    return parsed.data;
  }

  async turn(input: TurnInput): Promise<InterviewTurnResult & { decision: Decision | null }> {
    const body = {
      ...input,
      audio: { contentBase64: input.audio.bytes.toString('base64'), mimeType: input.audio.mimeType },
      history: input.history.slice(-14),
      plan: input.plan.map(({ hrQuestionId: _hr, ...t }) => t),
    };
    const json = await this.post('/v1/interview/turn', body, this.options.turnTimeoutMs);
    const parsed = turnResultSchema.safeParse(json);
    if (!parsed.success) throw new InterviewWorkerError('The AI service sent an unexpected answer.', 'AI_WORKER_BAD_RESPONSE', true);
    return parsed.data;
  }

  /** The interviewer's words as a WAV file. */
  async speak(text: string): Promise<Buffer> {
    const res = await this.send('/v1/interview/speak', { text }, this.options.speechTimeoutMs);
    if (!res.ok) throw errorFor(res, await res.json().catch(() => undefined));
    return Buffer.from(await res.arrayBuffer());
  }

  async report(input: ReportInput): Promise<{ report: AiInterviewReport; model: string; promptVersion: string }> {
    const json = await this.post('/v1/interview/report', input, this.options.reportTimeoutMs);
    const parsed = reportResultSchema.safeParse(json);
    if (!parsed.success) throw new InterviewWorkerError('The AI service sent an unexpected report.', 'AI_WORKER_BAD_RESPONSE', true);
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
        throw new InterviewWorkerError('The AI interviewer took too long to respond.', 'AI_WORKER_TIMEOUT', true);
      }
      throw new InterviewWorkerError('The AI interviewer is not reachable right now.', 'AI_WORKER_UNAVAILABLE', true);
    }
  }
}

function errorFor(res: Response, json: unknown): InterviewWorkerError {
  const detail = (json as { detail?: unknown } | undefined)?.detail;
  const code = typeof (detail as { code?: unknown })?.code === 'string' ? (detail as { code: string }).code : `HTTP_${res.status}`;
  if (code === 'AUDIO_UNREADABLE') return new InterviewWorkerError('We could not use that recording. Please answer again.', code, true);
  if (res.status === 429) {
    const after = Number(res.headers.get('retry-after'));
    return new InterviewWorkerError('The AI interviewer is busy right now. Please try again in a moment.', code, true, Number.isInteger(after) && after > 0 ? after : undefined);
  }
  // 404: an AI worker from before this round existed (not restarted) - not the candidate's fault
  if (res.status === 404) return new InterviewWorkerError('The AI interviewer is not available yet.', code, true);
  if (res.status >= 500 || res.status === 408) return new InterviewWorkerError('The AI interviewer had a problem. Please try again.', code, true);
  return new InterviewWorkerError('The AI interviewer could not process this answer. Please try again.', code, false);
}
