import { z } from 'zod';

/**
 * M12 AI screening round (voice). Owner: screening module (apps/api/src/modules/screening).
 * Public part: what the candidate's screening page sees (only through their own link token, never any id).
 * HR part: the transcript and the structured summary, inside the company that owns the application.
 * Names start with "aiScreening" so they never clash with the M11 ATS "screening settings" contracts.
 */

/** The fixed question flow. One main question per step, then at most a few follow-ups (server-enforced). */
export const AI_SCREENING_STEPS = ['INTRO', 'EDUCATION', 'BACKGROUND', 'LOCATION', 'AVAILABILITY', 'CANDIDATE_QUESTIONS'] as const;
export const aiScreeningStepSchema = z.enum(AI_SCREENING_STEPS);
export type AiScreeningStep = z.infer<typeof aiScreeningStepSchema>;

/** MAIN = the step's question; FOLLOW_UP = a clarifying question; CLOSING = the goodbye (no answer expected). */
export const aiScreeningTurnKindSchema = z.enum(['MAIN', 'FOLLOW_UP', 'CLOSING']);
export type AiScreeningTurnKind = z.infer<typeof aiScreeningTurnKindSchema>;

/** Stored status. EXPIRED / INTERRUPTED shown to HR are derived from it (link expiry, idle time). */
export const aiScreeningStatusSchema = z.enum(['NOT_STARTED', 'IN_PROGRESS', 'COMPLETED', 'ENDED_EARLY']);
export type AiScreeningStatus = z.infer<typeof aiScreeningStatusSchema>;

/**
 * What HR sees: NOT_STARTED, IN_PROGRESS, COMPLETED, INTERRUPTED (ended early, or left midway and idle) and EXPIRED
 * (the link ran out before completion). A technical failure of the summary is shown on the result (resultStatus
 * FAILED + retry), never as the candidate's status: the transcript is complete either way.
 */
export const aiScreeningDisplayStatusSchema = z.enum(['NOT_STARTED', 'IN_PROGRESS', 'COMPLETED', 'INTERRUPTED', 'EXPIRED']);
export type AiScreeningDisplayStatus = z.infer<typeof aiScreeningDisplayStatusSchema>;

export const AI_SCREENING_CONSENT_VERSION = 'ai-screening-2026-10';

// ---------------------------------------------------------------- public (candidate) API

/** The question the AI is waiting for an answer to (or the closing words when done). */
export const aiScreeningQuestionSchema = z.object({
  seq: z.number().int().positive(),
  step: aiScreeningStepSchema,
  kind: aiScreeningTurnKindSchema,
  text: z.string(),
});
export type AiScreeningQuestion = z.infer<typeof aiScreeningQuestionSchema>;

/** One finished turn as the candidate sees it again after a refresh. */
export const aiScreeningTranscriptLineSchema = z.object({
  seq: z.number().int().positive(),
  step: aiScreeningStepSchema,
  question: z.string(),
  answer: z.string(),
  aiReply: z.string().nullable(),
});
export type AiScreeningTranscriptLine = z.infer<typeof aiScreeningTranscriptLineSchema>;

/** GET /api/v1/public/screening/session (header x-screening-token). Never contains ids, emails or the resume. */
export const aiScreeningPublicSessionSchema = z.object({
  status: aiScreeningStatusSchema,
  jobTitle: z.string(),
  companyName: z.string(),
  /** The first name only, to greet the candidate. */
  candidateFirstName: z.string(),
  expiresAt: z.string(),
  consentVersion: z.string(),
  consentGiven: z.boolean(),
  estimatedMinutes: z.number().int().positive(),
  /** Steps answered so far (0-6) out of totalSteps. */
  stepsDone: z.number().int().min(0),
  totalSteps: z.number().int().positive(),
  current: aiScreeningQuestionSchema.nullable(),
  transcript: z.array(aiScreeningTranscriptLineSchema),
});
export type AiScreeningPublicSession = z.infer<typeof aiScreeningPublicSessionSchema>;

/** POST /api/v1/public/screening/start - body { consent: true }. Starts or resumes; answers with the session. */
export const aiScreeningStartRequestSchema = z.object({
  consent: z.literal(true, { errorMap: () => ({ message: 'Please agree before starting.' }) }),
});
export type AiScreeningStartRequest = z.infer<typeof aiScreeningStartRequestSchema>;

/**
 * POST /api/v1/public/screening/answer - multipart: audio (file), seq, clientTurnId.
 * outcome RETRY = nothing usable was heard (nothing saved); ask again. ANSWERED = saved; `next` is the next question
 * (or the closing words with done = true).
 */
export const aiScreeningAnswerResultSchema = z.object({
  outcome: z.enum(['ANSWERED', 'RETRY']),
  message: z.string().nullable(),
  transcript: z.string().nullable(),
  aiReply: z.string().nullable(),
  done: z.boolean(),
  next: aiScreeningQuestionSchema.nullable(),
  stepsDone: z.number().int().min(0),
  totalSteps: z.number().int().positive(),
});
export type AiScreeningAnswerResult = z.infer<typeof aiScreeningAnswerResultSchema>;

/** POST /api/v1/public/screening/end - the candidate stops early. They can resume while the link is valid. */
export const aiScreeningEndRequestSchema = z.object({ reason: z.enum(['CANDIDATE_ENDED']).default('CANDIDATE_ENDED') });

// ---------------------------------------------------------------- structured summary (AI worker output)

const text = z.string().nullable();
/** Turn numbers (seq) whose answers support a field, so HR can check it against the transcript. */
const evidence = z.array(z.number().int().positive()).default([]);

export const aiScreeningExtractionSchema = z.object({
  introduction: z.object({ statedName: text, summary: text, evidence }),
  education: z.object({
    degree: text,
    fieldOfStudy: text,
    institution: text,
    currentYearOrSemester: text,
    expectedGraduation: text,
    evidence,
  }),
  background: z.object({
    projects: z.array(z.string()).default([]),
    internshipsOrWork: z.array(z.string()).default([]),
    interests: z.array(z.string()).default([]),
    summary: text,
    evidence,
  }),
  location: z.object({
    currentLocation: text,
    willingToWorkAtJobLocation: z.enum(['YES', 'NO', 'UNSURE', 'UNKNOWN']),
    relocationNotes: text,
    evidence,
  }),
  availability: z.object({
    currentStatus: text,
    availability: text,
    joiningTimeline: text,
    constraints: text,
    collegePermission: z.enum(['REQUIRED', 'NOT_REQUIRED', 'NOT_SURE', 'NOT_APPLICABLE', 'UNKNOWN']),
    evidence,
  }),
  candidateQuestions: z
    .array(z.object({ question: z.string(), answerGiven: text, answeredFromVerifiedInfo: z.boolean(), evidence }))
    .default([]),
  /** Things the candidate did not answer or that stayed unclear (HR may follow up). */
  unclear: z.array(z.string()).default([]),
  summary: text,
});
export type AiScreeningExtraction = z.infer<typeof aiScreeningExtractionSchema>;

// ---------------------------------------------------------------- HR API

export const aiScreeningReviewStatusSchema = z.enum(['PENDING', 'REVIEWED', 'NEEDS_FOLLOW_UP']);
export type AiScreeningReviewStatus = z.infer<typeof aiScreeningReviewStatusSchema>;

export const aiScreeningResultStatusSchema = z.enum(['PENDING', 'DONE', 'FAILED']);
export type AiScreeningResultStatus = z.infer<typeof aiScreeningResultStatusSchema>;

/** One row of GET /api/v1/screening/jobs/:jobId - every shortlisted application that got a screening link. */
export const aiScreeningSummarySchema = z.object({
  applicationId: z.string(),
  candidateName: z.string(),
  status: aiScreeningDisplayStatusSchema,
  linkExpiresAt: z.string().nullable(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  lastActivityAt: z.string().nullable(),
  stepsDone: z.number().int().min(0),
  totalSteps: z.number().int().positive(),
  resultStatus: aiScreeningResultStatusSchema.nullable(),
  reviewStatus: aiScreeningReviewStatusSchema,
});
export type AiScreeningSummary = z.infer<typeof aiScreeningSummarySchema>;

export const aiScreeningJobListSchema = z.object({ jobId: z.string(), items: z.array(aiScreeningSummarySchema) });
export type AiScreeningJobList = z.infer<typeof aiScreeningJobListSchema>;

export const aiScreeningHrTurnSchema = z.object({
  seq: z.number().int().positive(),
  step: aiScreeningStepSchema,
  kind: aiScreeningTurnKindSchema,
  question: z.string(),
  answer: z.string(),
  aiReply: z.string().nullable(),
  answeredAt: z.string(),
  answerSeconds: z.number().nullable(),
});
export type AiScreeningHrTurn = z.infer<typeof aiScreeningHrTurnSchema>;

/** GET /api/v1/screening/applications/:applicationId */
export const aiScreeningDetailSchema = aiScreeningSummarySchema.extend({
  jobId: z.string(),
  jobTitle: z.string(),
  consentGivenAt: z.string().nullable(),
  endedReason: z.string().nullable(),
  turns: z.array(aiScreeningHrTurnSchema),
  result: z
    .object({
      status: aiScreeningResultStatusSchema,
      extraction: aiScreeningExtractionSchema.nullable(),
      error: z.string().nullable(),
      model: z.string().nullable(),
      updatedAt: z.string(),
    })
    .nullable(),
});
export type AiScreeningDetail = z.infer<typeof aiScreeningDetailSchema>;

/** PUT /api/v1/screening/applications/:applicationId/review */
export const aiScreeningReviewRequestSchema = z.object({ reviewStatus: aiScreeningReviewStatusSchema });
export type AiScreeningReviewRequest = z.infer<typeof aiScreeningReviewRequestSchema>;
