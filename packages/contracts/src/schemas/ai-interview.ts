import { z } from 'zod';

/**
 * AI technical interview round (voice). Owner: ai-interview module (apps/api/src/modules/ai-interview).
 * It runs the job rounds of type AI_INTERVIEW: a student who passed every earlier round (whichever rounds HR chose)
 * gets a personal link, talks to an AI interviewer about their own resume, the job and practical scenarios, and HR
 * reads an evidence-based report and makes the decision. The AI's score and recommendation are advice only.
 * Public part: what the candidate's interview page sees (only through their own link token, never any id).
 * HR part: transcript, report and decision, inside the company that owns the application.
 */

/** Bumped when the interview protection (warnings) was added to what the candidate agrees to. */
export const AI_INTERVIEW_CONSENT_VERSION = 'ai-interview-2026-11-protection-faces';

export const AI_INTERVIEW_LIMITS = {
  /** An answer recorded after the time ran out is still accepted this long (the candidate was mid-sentence). */
  graceSeconds: 60,
  /** Device or connection problems may pause the clock this long in total; after that the time runs again. */
  maxPauseSeconds: 10 * 60,
  /** Follow-up / clarifying questions on one topic before the interviewer moves on (server-enforced). */
  followUpsPerTopic: 2,
  /** Answered questions in one interview, whatever the time (a hard stop against loops). */
  maxTurns: 40,
  /** Times one question may be played again. */
  repeatsPerQuestion: 2,
  /** One spoken answer: longer recordings are cut by the page (and refused by the API). */
  maxAnswerSeconds: 240,
} as const;

/**
 * NOT_STARTED -> IN_PROGRESS <-> PAUSED -> COMPLETED; INCOMPLETE = abandoned / time ran out with the page closed;
 * TERMINATED = ended by the server after more warnings than the round allows (answers so far are kept; HR reviews).
 */
export const aiInterviewStatusSchema = z.enum(['NOT_STARTED', 'IN_PROGRESS', 'PAUSED', 'COMPLETED', 'INCOMPLETE', 'TERMINATED']);
export type AiInterviewStatus = z.infer<typeof aiInterviewStatusSchema>;

/** Interview states after which nothing more is accepted from the candidate. */
export const AI_INTERVIEW_ENDED_STATUSES: readonly AiInterviewStatus[] = ['COMPLETED', 'INCOMPLETE', 'TERMINATED'];

export const aiInterviewEndReasonSchema = z.enum(['AI_CONCLUDED', 'TIME_UP', 'MAX_TURNS', 'CANDIDATE_ENDED', 'ABANDONED', 'MAX_WARNINGS_EXCEEDED']);
export type AiInterviewEndReason = z.infer<typeof aiInterviewEndReasonSchema>;

/** INTRO = the greeting, MAIN = a new topic, FOLLOW_UP = deeper on the same topic, CLARIFY = "could you repeat / explain". */
export const aiInterviewQuestionKindSchema = z.enum(['INTRO', 'MAIN', 'FOLLOW_UP', 'CLARIFY', 'CLOSING']);
export type AiInterviewQuestionKind = z.infer<typeof aiInterviewQuestionKindSchema>;

/** Where a question comes from (HR sees it; it keeps every question traceable to the resume / job / HR). */
export const aiInterviewSourceSchema = z.enum(['INTRO', 'RESUME', 'JOB', 'SCENARIO', 'HR', 'FOLLOW_UP', 'CLOSING']);
export type AiInterviewSource = z.infer<typeof aiInterviewSourceSchema>;

/** How the interviewer read an answer when choosing the next question (shown to HR, never to the candidate). */
export const aiInterviewAnswerReadingSchema = z.enum([
  'STRONG',
  'DETAILED',
  'INCOMPLETE',
  'VAGUE',
  'INCORRECT',
  'OFF_TOPIC',
  'DONT_KNOW',
  'UNCLEAR_AUDIO',
  'READY',
]);
export type AiInterviewAnswerReading = z.infer<typeof aiInterviewAnswerReadingSchema>;

/** How sure the transcriber was. Anything but CLEAR is flagged to HR; the report then says it is uncertain. */
export const aiInterviewTranscriptQualitySchema = z.enum(['CLEAR', 'PARTLY_UNCLEAR', 'UNCLEAR']);
export type AiInterviewTranscriptQuality = z.infer<typeof aiInterviewTranscriptQualitySchema>;

/**
 * Session integrity events the page reports (devices and connection only). They are facts for HR to review, never
 * proof of misconduct and never used for scoring. No video or face analysis exists.
 */
export const aiInterviewEventTypeSchema = z.enum([
  'CAMERA_LOST',
  'CAMERA_RESTORED',
  'MIC_LOST',
  'MIC_RESTORED',
  'CONNECTION_LOST',
  'CONNECTION_RESTORED',
  'PAGE_HIDDEN',
  'PAGE_VISIBLE',
  'PAGE_CLOSED',
  'QUESTION_REPEATED',
]);
export type AiInterviewEventType = z.infer<typeof aiInterviewEventTypeSchema>;

// ---------------------------------------------------------------- interview protection (one warning counter)

/**
 * Interview protection: the page reports monitored activity, the SERVER decides whether it is a new incident and
 * counts it on ONE warning counter per interview (all types together). More warnings than `maxWarnings` (default 2:
 * warning 1, final warning 2, the 3rd qualifying incident) terminates the interview; HR then reviews it and decides -
 * a termination is never an automatic rejection. Browsers only tell a page that it was hidden or lost focus: what
 * the candidate did elsewhere is never known, and nothing is recorded or analysed from the camera.
 */
export const AI_INTERVIEW_PROTECTION_LIMITS = {
  maxWarnings: { min: 1, max: 5, default: 2 },
  /** A qualifying event this soon (server time) after the last counted one is the same incident (e.g. Alt+Tab out of fullscreen). */
  groupWindowSeconds: 3,
  /** Protection rows stored per interview (a flood of events is not stored; the counter keeps working). */
  maxEventsPerSession: 200,
} as const;

/**
 * TAB_SWITCH = the page was hidden (other tab, minimised, screen locked); WINDOW_BLUR = the window lost focus to
 * another window / app for a few seconds while still visible; FULLSCREEN_EXIT = left fullscreen when it is required;
 * CAMERA_LOST / MIC_LOST = a device stopped (technical by default: pause + recovery, no warning unless HR chose WARN);
 * MULTIPLE_FACES = more than one face was counted in the camera picture for a few seconds (counted ON the candidate's
 * device: no image leaves it, nobody is identified; a warning by default, like a tab switch).
 */
export const aiInterviewViolationTypeSchema = z.enum(['TAB_SWITCH', 'WINDOW_BLUR', 'FULLSCREEN_EXIT', 'CAMERA_LOST', 'MIC_LOST', 'MULTIPLE_FACES']);
export type AiInterviewViolationType = z.infer<typeof aiInterviewViolationTypeSchema>;

export const AI_INTERVIEW_VIOLATION_LABEL: Record<AiInterviewViolationType, string> = {
  TAB_SWITCH: 'Left the interview tab (other tab, minimised or locked)',
  WINDOW_BLUR: 'Switched to another window or app',
  FULLSCREEN_EXIT: 'Left fullscreen',
  CAMERA_LOST: 'Camera stopped',
  MIC_LOST: 'Microphone stopped',
  MULTIPLE_FACES: 'More than one face in the camera',
};

/** RECOVER = pause, wait for the device, continue (no warning). WARN = the same, plus one warning per incident. */
export const aiInterviewDevicePolicySchema = z.enum(['RECOVER', 'WARN']);
export type AiInterviewDevicePolicy = z.infer<typeof aiInterviewDevicePolicySchema>;

/**
 * Face counting in the camera picture (on the candidate's device only). WARN (default) = one warning per episode on
 * the shared counter; RECORD = noted for HR only; OFF = not counted at all.
 */
export const aiInterviewFacePolicySchema = z.enum(['OFF', 'RECORD', 'WARN']);
export type AiInterviewFacePolicy = z.infer<typeof aiInterviewFacePolicySchema>;

/** Per AI interview round, set by HR. Copied onto each interview at its first visit (what the candidate was shown). */
export const aiInterviewProtectionSettingsSchema = z.object({
  maxWarnings: z
    .number()
    .int('Use a whole number')
    .min(AI_INTERVIEW_PROTECTION_LIMITS.maxWarnings.min, `At least ${AI_INTERVIEW_PROTECTION_LIMITS.maxWarnings.min} warning`)
    .max(AI_INTERVIEW_PROTECTION_LIMITS.maxWarnings.max, `At most ${AI_INTERVIEW_PROTECTION_LIMITS.maxWarnings.max} warnings`)
    .default(AI_INTERVIEW_PROTECTION_LIMITS.maxWarnings.default),
  tabSwitchMonitoring: z.boolean().default(true),
  fullscreenRequired: z.boolean().default(true),
  cameraPolicy: aiInterviewDevicePolicySchema.default('RECOVER'),
  microphonePolicy: aiInterviewDevicePolicySchema.default('RECOVER'),
  multipleFacesPolicy: aiInterviewFacePolicySchema.default('WARN'),
});
export type AiInterviewProtectionSettings = z.infer<typeof aiInterviewProtectionSettingsSchema>;

export const DEFAULT_AI_INTERVIEW_PROTECTION: AiInterviewProtectionSettings = Object.freeze({
  maxWarnings: AI_INTERVIEW_PROTECTION_LIMITS.maxWarnings.default,
  tabSwitchMonitoring: true,
  fullscreenRequired: true,
  cameraPolicy: 'RECOVER',
  microphonePolicy: 'RECOVER',
  multipleFacesPolicy: 'WARN',
});

/**
 * What the server did with a reported event. WARNING = a new incident, counted (warningNumber); TERMINATED = it went
 * over the limit; RECORDED = kept for HR, not a warning (device under RECOVER, or that monitoring is off); GROUPED =
 * part of an incident already counted; IGNORED = the interview is not running (paused / ended): nothing stored.
 */
export const aiInterviewViolationOutcomeSchema = z.enum(['WARNING', 'TERMINATED', 'RECORDED', 'GROUPED', 'IGNORED']);
export type AiInterviewViolationOutcome = z.infer<typeof aiInterviewViolationOutcomeSchema>;

/** NONE = nothing to review; INTEGRITY_VIOLATION_REVIEW = terminated, HR must review; REVIEWED = HR decided. */
export const aiInterviewIntegrityStatusSchema = z.enum(['NONE', 'INTEGRITY_VIOLATION_REVIEW', 'REVIEWED']);
export type AiInterviewIntegrityStatus = z.infer<typeof aiInterviewIntegrityStatusSchema>;

/** The protection part of the candidate's session (never ids; the count is the server's). */
export const aiInterviewProtectionStateSchema = z.object({
  /** false = interviews opened before protection existed (or switched off): nothing is monitored. */
  enabled: z.boolean(),
  maxWarnings: z.number().int().min(0),
  warningCount: z.number().int().min(0),
  tabSwitchMonitoring: z.boolean(),
  fullscreenRequired: z.boolean(),
  cameraPolicy: aiInterviewDevicePolicySchema,
  microphonePolicy: aiInterviewDevicePolicySchema,
  multipleFacesPolicy: aiInterviewFacePolicySchema,
  /** The latest warning not acknowledged yet: shown again after a reload until the candidate confirms it. */
  pendingWarning: z.object({ warningNumber: z.number().int().positive(), type: aiInterviewViolationTypeSchema, final: z.boolean() }).nullable(),
});
export type AiInterviewProtectionState = z.infer<typeof aiInterviewProtectionStateSchema>;

/** POST /api/v1/public/interview/violation. incidentId is made by the page per incident: re-sending it is safe. */
export const aiInterviewViolationRequestSchema = z.object({
  incidentId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/, 'Invalid incident id'),
  type: aiInterviewViolationTypeSchema,
  /** Short, non-personal detail (e.g. "visibilitychange"). */
  detail: z.string().max(200).optional(),
});
export type AiInterviewViolationRequest = z.infer<typeof aiInterviewViolationRequestSchema>;

export const aiInterviewViolationResultSchema = z.object({
  outcome: aiInterviewViolationOutcomeSchema,
  /** The warning this incident is (1..maxWarnings), or the one it was grouped into; null when none. */
  warningNumber: z.number().int().positive().nullable(),
  warningCount: z.number().int().min(0),
  maxWarnings: z.number().int().min(0),
  status: aiInterviewStatusSchema,
});
export type AiInterviewViolationResult = z.infer<typeof aiInterviewViolationResultSchema>;

/** POST /api/v1/public/interview/violation/ack - the candidate read warning N. */
export const aiInterviewViolationAckRequestSchema = z.object({ warningNumber: z.number().int().positive() });

// ---------------------------------------------------------------- public (candidate) API

export const aiInterviewQuestionSchema = z.object({
  seq: z.number().int().positive(),
  kind: aiInterviewQuestionKindSchema,
  text: z.string(),
});
export type AiInterviewQuestion = z.infer<typeof aiInterviewQuestionSchema>;

export const aiInterviewTranscriptLineSchema = z.object({
  seq: z.number().int().positive(),
  question: z.string(),
  /** The saved transcript, exactly as heard (the raw transcript, never an AI-corrected answer). */
  answer: z.string(),
});
export type AiInterviewTranscriptLine = z.infer<typeof aiInterviewTranscriptLineSchema>;

/** GET /api/v1/public/interview/session (header x-interview-token). Never contains ids, emails, scores or the resume. */
export const aiInterviewPublicSessionSchema = z.object({
  status: aiInterviewStatusSchema,
  roundName: z.string(),
  jobTitle: z.string(),
  companyName: z.string(),
  candidateFirstName: z.string(),
  expiresAt: z.string(),
  consentVersion: z.string(),
  consentGiven: z.boolean(),
  cameraRequired: z.boolean(),
  durationMinutes: z.number().int().positive(),
  /** Server clock: interview time used and left (paused time does not count). */
  elapsedSeconds: z.number().int().min(0),
  remainingSeconds: z.number().int().min(0),
  /** Pause allowance left for device / connection problems. */
  pauseSecondsLeft: z.number().int().min(0),
  questionsAnswered: z.number().int().min(0),
  /** Times the current question may still be played again. */
  repeatsLeft: z.number().int().min(0),
  current: aiInterviewQuestionSchema.nullable(),
  transcript: z.array(aiInterviewTranscriptLineSchema),
  protection: aiInterviewProtectionStateSchema,
});
export type AiInterviewPublicSession = z.infer<typeof aiInterviewPublicSessionSchema>;

/** POST /api/v1/public/interview/start - consent + the page checked both devices. Starts or resumes. */
export const aiInterviewStartRequestSchema = z.object({
  consent: z.literal(true, { errorMap: () => ({ message: 'Please agree before starting.' }) }),
  camera: z.literal(true, { errorMap: () => ({ message: 'Turn on your camera to start.' }) }),
  microphone: z.literal(true, { errorMap: () => ({ message: 'Turn on your microphone to start.' }) }),
});
export type AiInterviewStartRequest = z.infer<typeof aiInterviewStartRequestSchema>;

/** POST /api/v1/public/interview/resume - after a pause: the devices are back. */
export const aiInterviewResumeRequestSchema = z.object({
  camera: z.literal(true, { errorMap: () => ({ message: 'Turn on your camera to continue.' }) }),
  microphone: z.literal(true, { errorMap: () => ({ message: 'Turn on your microphone to continue.' }) }),
});

/** POST /api/v1/public/interview/pause - the page lost a device or the connection (or is being closed). */
export const aiInterviewPauseRequestSchema = z.object({
  reason: z.enum(['CAMERA_LOST', 'MIC_LOST', 'CONNECTION_LOST', 'PAGE_CLOSED']),
});
export type AiInterviewPauseRequest = z.infer<typeof aiInterviewPauseRequestSchema>;

export const aiInterviewEventsRequestSchema = z.object({
  events: z
    .array(
      z.object({
        type: aiInterviewEventTypeSchema,
        occurredAt: z.string().datetime(),
        /** Short, non-personal detail (e.g. "track ended"). */
        detail: z.string().max(200).optional(),
      }),
    )
    .min(1)
    .max(50),
});
export type AiInterviewEventsRequest = z.infer<typeof aiInterviewEventsRequestSchema>;

/**
 * POST /api/v1/public/interview/answer - multipart: audio (file), seq, clientTurnId, durationMs.
 * RETRY = nothing usable was heard (nothing saved): answer again. ANSWERED = saved; `next` is the next question, or the
 * closing words with done = true.
 */
export const aiInterviewAnswerResultSchema = z.object({
  outcome: z.enum(['ANSWERED', 'RETRY']),
  message: z.string().nullable(),
  transcript: z.string().nullable(),
  done: z.boolean(),
  next: aiInterviewQuestionSchema.nullable(),
  elapsedSeconds: z.number().int().min(0),
  remainingSeconds: z.number().int().min(0),
  questionsAnswered: z.number().int().min(0),
});
export type AiInterviewAnswerResult = z.infer<typeof aiInterviewAnswerResultSchema>;

// ---------------------------------------------------------------- report (AI worker output, checked by the API)

export const aiInterviewDimensionKeySchema = z.enum([
  'TECHNICAL_KNOWLEDGE',
  'PROJECT_UNDERSTANDING',
  'PRACTICAL_IMPLEMENTATION',
  'PROBLEM_SOLVING',
  'SCENARIO_REASONING',
  'DEPTH_OF_UNDERSTANDING',
  'COMMUNICATION_CLARITY',
]);
export type AiInterviewDimensionKey = z.infer<typeof aiInterviewDimensionKeySchema>;

export const AI_INTERVIEW_DIMENSIONS: Record<AiInterviewDimensionKey, string> = {
  TECHNICAL_KNOWLEDGE: 'Technical knowledge',
  PROJECT_UNDERSTANDING: 'Understanding of own projects',
  PRACTICAL_IMPLEMENTATION: 'Practical implementation',
  PROBLEM_SOLVING: 'Problem solving',
  SCENARIO_REASONING: 'Scenario-based reasoning',
  DEPTH_OF_UNDERSTANDING: 'Depth of understanding',
  COMMUNICATION_CLARITY: 'Clarity and relevance of explanations',
};

export const aiInterviewRecommendationSchema = z.enum(['STRONGLY_RECOMMENDED', 'RECOMMENDED', 'NEEDS_HUMAN_REVIEW', 'NOT_RECOMMENDED']);
export type AiInterviewRecommendation = z.infer<typeof aiInterviewRecommendationSchema>;

export const AI_INTERVIEW_RECOMMENDATION_LABEL: Record<AiInterviewRecommendation, string> = {
  STRONGLY_RECOMMENDED: 'Strongly recommended',
  RECOMMENDED: 'Recommended',
  NEEDS_HUMAN_REVIEW: 'Needs human review',
  NOT_RECOMMENDED: 'Not recommended',
};

/** Turn numbers (seq) whose answers support a statement, so HR can check it against the transcript. */
const evidence = z.array(z.number().int().positive()).default([]);
/** 0-10, or null = not assessed in this interview (never guessed). */
const score10 = z.number().min(0).max(10).nullable();

export const aiInterviewDimensionSchema = z.object({
  key: aiInterviewDimensionKeySchema,
  score: score10,
  summary: z.string(),
  evidence,
});
export type AiInterviewDimension = z.infer<typeof aiInterviewDimensionSchema>;

export const aiInterviewAnswerEvaluationSchema = z.object({
  seq: z.number().int().positive(),
  technicalAccuracy: score10,
  depth: score10,
  /** What the answer got right / what was missing or incorrect. */
  strengths: z.array(z.string()).default([]),
  gaps: z.array(z.string()).default([]),
  /** A short quote that is literally in the candidate's answer (checked; dropped when it is not). */
  quote: z.string().nullable(),
  summary: z.string(),
});
export type AiInterviewAnswerEvaluation = z.infer<typeof aiInterviewAnswerEvaluationSchema>;

export const aiInterviewReportSchema = z.object({
  /** 0-100, computed in code (AI worker, checked_report) from the assessed dimensions - not chosen by the model. */
  overallScore: z.number().int().min(0).max(100).nullable(),
  dimensions: z.array(aiInterviewDimensionSchema),
  answers: z.array(aiInterviewAnswerEvaluationSchema),
  strengths: z.array(z.string()).default([]),
  improvementAreas: z.array(z.string()).default([]),
  skillsDemonstrated: z.array(z.string()).default([]),
  skillsNotVerified: z.array(z.string()).default([]),
  recommendation: aiInterviewRecommendationSchema,
  recommendationReason: z.string(),
  /** true = the transcript was often unclear or the interview too short to judge: a person must review it. */
  uncertain: z.boolean(),
  uncertaintyNotes: z.array(z.string()).default([]),
  summary: z.string(),
});
export type AiInterviewReport = z.infer<typeof aiInterviewReportSchema>;

// ---------------------------------------------------------------- HR API

export const aiInterviewInviteStatusSchema = z.enum(['QUEUED', 'SENDING', 'SENT', 'FAILED']);
export type AiInterviewInviteStatus = z.infer<typeof aiInterviewInviteStatusSchema>;

export const aiInterviewReportStatusSchema = z.enum(['PENDING', 'DONE', 'FAILED']);
export type AiInterviewReportStatus = z.infer<typeof aiInterviewReportStatusSchema>;

export const aiInterviewDecisionSchema = z.enum(['ADVANCE', 'REJECT']);
export type AiInterviewDecision = z.infer<typeof aiInterviewDecisionSchema>;

export const aiInterviewHrTurnSchema = z.object({
  seq: z.number().int().positive(),
  kind: aiInterviewQuestionKindSchema,
  source: aiInterviewSourceSchema,
  topic: z.string().nullable(),
  /** The resume item the question is about (e.g. a project title), when it came from the resume. */
  resumeRef: z.string().nullable(),
  question: z.string(),
  rawTranscript: z.string(),
  /** Technical terms written consistently (e.g. "post gres" -> "PostgreSQL"); the raw transcript stays the source of truth. */
  normalizedTranscript: z.string(),
  transcriptQuality: aiInterviewTranscriptQualitySchema,
  unclearTerms: z.array(z.string()),
  reading: aiInterviewAnswerReadingSchema.nullable(),
  askedAt: z.string(),
  answeredAt: z.string(),
  answerSeconds: z.number().nullable(),
});
export type AiInterviewHrTurn = z.infer<typeof aiInterviewHrTurnSchema>;

/** GET /api/v1/ai-interview/applications/:applicationId - one entry per AI interview round of the job. */
export const aiInterviewHrRoundSchema = z.object({
  roundId: z.string(),
  roundName: z.string(),
  durationMinutes: z.number().int().positive(),
  invite: z
    .object({
      status: aiInterviewInviteStatusSchema,
      sentAt: z.string().nullable(),
      expiresAt: z.string().nullable(),
      lastError: z.string().nullable(),
    })
    .nullable(),
  session: z
    .object({
      status: aiInterviewStatusSchema,
      startedAt: z.string().nullable(),
      completedAt: z.string().nullable(),
      endedReason: aiInterviewEndReasonSchema.nullable(),
      /** Interview time actually used (pauses excluded). */
      durationSeconds: z.number().int().min(0),
      pausedSeconds: z.number().int().min(0),
      questionsAnswered: z.number().int().min(0),
    })
    .nullable(),
  turns: z.array(aiInterviewHrTurnSchema),
  events: z.array(z.object({ type: z.string(), at: z.string(), detail: z.string().nullable() })),
  /** Interview protection: warnings, every monitored incident, and the termination (HR reviews; never automatic rejection). */
  integrity: z
    .object({
      status: aiInterviewIntegrityStatusSchema,
      /** The rules this interview ran with (null = opened before protection existed: nothing was monitored). */
      settings: aiInterviewProtectionSettingsSchema.nullable(),
      warningCount: z.number().int().min(0),
      terminatedAt: z.string().nullable(),
      terminationReason: z.string().nullable(),
      violations: z.array(
        z.object({
          type: aiInterviewViolationTypeSchema,
          outcome: aiInterviewViolationOutcomeSchema,
          warningNumber: z.number().int().positive().nullable(),
          at: z.string(),
          detail: z.string().nullable(),
          acknowledgedAt: z.string().nullable(),
          resolvedAt: z.string().nullable(),
        }),
      ),
    })
    .nullable(),
  report: z
    .object({
      status: aiInterviewReportStatusSchema,
      data: aiInterviewReportSchema.nullable(),
      lastError: z.string().nullable(),
      generatedAt: z.string().nullable(),
    })
    .nullable(),
  /** The AI score as it goes to the round's pass rule ("interviewer score N of M"). */
  proposedScore: z.object({ score: z.number().int().min(0), maxScore: z.number().int().positive(), passMark: z.number() }).nullable(),
  decision: z
    .object({ decision: aiInterviewDecisionSchema, reason: z.string().nullable(), by: z.string().nullable(), at: z.string() })
    .nullable(),
  /** HR may decide now: the interview ended (completed or incomplete) and no decision was made yet. */
  canDecide: z.boolean(),
});
export type AiInterviewHrRound = z.infer<typeof aiInterviewHrRoundSchema>;

export const aiInterviewHrViewSchema = z.object({ applicationId: z.string(), rounds: z.array(aiInterviewHrRoundSchema) });
export type AiInterviewHrView = z.infer<typeof aiInterviewHrViewSchema>;

/**
 * POST /api/v1/ai-interview/applications/:applicationId/rounds/:roundId/decision. ADVANCE moves the student on to the
 * next round (or the "cleared" email), REJECT sends the rejection email - through the round engine, once. A reason is
 * required when HR decides against the AI score's pass / fail (it is stored as an audited override).
 */
export const aiInterviewDecisionRequestSchema = z.object({
  decision: aiInterviewDecisionSchema,
  reason: z.string().trim().max(500, 'Use at most 500 characters').default(''),
});
export type AiInterviewDecisionRequest = z.input<typeof aiInterviewDecisionRequestSchema>;

/** GET / PUT /api/v1/ai-interview/jobs/:jobId/rounds/:roundId/protection - HR's protection rules for one AI interview round. */
export const aiInterviewProtectionConfigSchema = z.object({
  roundId: z.string(),
  settings: aiInterviewProtectionSettingsSchema,
  /** true = HR never changed them: the defaults apply. */
  isDefault: z.boolean(),
  updatedAt: z.string().nullable(),
  updatedBy: z.string().nullable(),
});
export type AiInterviewProtectionConfig = z.infer<typeof aiInterviewProtectionConfigSchema>;
