import { z } from 'zod';
import { aiInterviewFacePolicySchema } from './ai-interview';
import { emailDeliveryStatusSchema } from './ats';
import { isDsaRound } from './dsa-bank';
import { ROUND_MODULE_OF, type RoundModule, type SavedRound } from './rounds';

/**
 * M13 round engine: the candidate-facing online test rounds (Aptitude & English, Technical MCQ...) that follow the AI
 * voice screening. Owner: round-engine module (apps/api/src/modules/round-engine). The rounds, questions and pass rules
 * are the ones HR saved on the Publish page (rounds.ts); results go through the assessments module (assessments.ts).
 *
 * Public shapes (careers site /assessment/[token]) NEVER contain correct answers, marks needed to pass, model answers
 * or anything about other candidates. The server owns the clock, the answers and the result.
 */

/** Question kinds a round needs (only) to be run online and graded automatically. */
export const ONLINE_TEST_KINDS = ['MCQ', 'TRUE_FALSE'] as const;
export const onlineQuestionKindSchema = z.enum(ONLINE_TEST_KINDS);

const ONLINE = new Set<string>(ONLINE_TEST_KINDS);

/**
 * Run online and graded automatically by the round engine: a pass rule that is not an interviewer's score, at least
 * one question, and only multiple-choice / true-false questions. Anything else goes to a round module or HR.
 */
export function isOnlineRound(round: Pick<SavedRound, 'passRule' | 'questions'>): boolean {
  return !!round.passRule && round.passRule.mode !== 'INTERVIEWER_SCORE' && round.questions.length > 0 && round.questions.every((q) => ONLINE.has(q.kind));
}

/** Who runs a round: the round engine's online test, a round module (GD, DSA, SQL, AI interview), or HR by hand. */
export type RoundRunner = { by: 'ONLINE_TEST' } | { by: 'MODULE'; module: RoundModule } | { by: 'HR' };

export function roundRunnerOf(round: Pick<SavedRound, 'type' | 'passRule' | 'questions'>): RoundRunner {
  if (isOnlineRound(round)) return { by: 'ONLINE_TEST' };
  // a DSA round (every question a DSA problem) is run by the DSA coding page; any other coding round by HR
  if (isDsaRound(round)) return { by: 'MODULE', module: 'DSA' };
  const module = ROUND_MODULE_OF[round.type];
  return module && module !== 'DSA' ? { by: 'MODULE', module } : { by: 'HR' };
}

/** Bump when the consent text on the assessment page changes (stored with every attempt). */
export const ASSESSMENT_CONSENT_VERSION = 'assessment-2026-11-protection';

export const ASSESSMENT_LIMITS = {
  questionsMax: 100,
  selectedMax: 8,
  eventsPerRequest: 20,
  eventsPerAttempt: 500,
  detailKeys: 8,
} as const;

/** One question as the candidate sees it: no correct option, no rubric. `multiple` = "select all that apply". */
export const assessmentQuestionSchema = z.object({
  id: z.string(),
  position: z.number().int(),
  kind: onlineQuestionKindSchema,
  text: z.string(),
  options: z.array(z.string()),
  marks: z.number().int(),
  multiple: z.boolean(),
});
export type AssessmentQuestion = z.infer<typeof assessmentQuestionSchema>;

export const assessmentAnswerSchema = z.object({
  questionId: z.string().uuid(),
  selected: z.array(z.number().int().min(0)).max(ASSESSMENT_LIMITS.selectedMax).default([]),
  /** "Mark for review" - a reminder for the candidate only; never affects the score. */
  marked: z.boolean().default(false),
});
export type AssessmentAnswerInput = z.input<typeof assessmentAnswerSchema>;
export type AssessmentAnswer = z.output<typeof assessmentAnswerSchema>;

export const startAssessmentRequestSchema = z.object({ consent: z.literal(true) });

/**
 * PUT /public/assessment/answers (autosave) and POST /public/assessment/submit: ALL answers so far. `revision` grows
 * with every change in the browser; the server ignores a save older than the one it already has.
 */
export const saveAssessmentAnswersRequestSchema = z.object({
  revision: z.number().int().min(1).max(1_000_000),
  answers: z.array(assessmentAnswerSchema).max(ASSESSMENT_LIMITS.questionsMax),
});
export type SaveAssessmentAnswersRequest = z.input<typeof saveAssessmentAnswersRequestSchema>;

/** TERMINATED = ended by the server after more warnings than allowed (saved answers kept; HR reviews before any result email). */
export const assessmentStatusSchema = z.enum(['NOT_STARTED', 'IN_PROGRESS', 'SUBMITTED', 'TIMED_OUT', 'TERMINATED']);
export type AssessmentStatus = z.infer<typeof assessmentStatusSchema>;

// ---------------------------------------------------------------- protection (one warning counter, like the AI interview)

/**
 * Incidents the assessment page reports. The SERVER decides whether each is a warning (countProtectionIncident in
 * protection.ts): warning 1 ... maxWarnings (the final one), the next one ends the test and holds the result for HR.
 */
export const assessmentIncidentTypeSchema = z.enum(['TAB_SWITCH', 'WINDOW_BLUR', 'FULLSCREEN_EXIT', 'MULTIPLE_FACES']);
export type AssessmentIncidentType = z.infer<typeof assessmentIncidentTypeSchema>;

export const ASSESSMENT_INCIDENT_LABEL: Record<AssessmentIncidentType, string> = {
  TAB_SWITCH: 'Left the test tab (other tab, minimised or locked)',
  WINDOW_BLUR: 'Switched to another window or app',
  FULLSCREEN_EXIT: 'Left full screen',
  MULTIPLE_FACES: 'More than one face in the camera',
};

/** Server-wide rules (env), copied onto each attempt when it starts: the rules shown are the rules enforced. */
export const assessmentProtectionSettingsSchema = z.object({
  maxWarnings: z.number().int().min(1).max(5),
  tabSwitchMonitoring: z.boolean(),
  fullscreenRequired: z.boolean(),
  multipleFacesPolicy: aiInterviewFacePolicySchema,
});
export type AssessmentProtectionSettings = z.infer<typeof assessmentProtectionSettingsSchema>;

export const assessmentIncidentOutcomeSchema = z.enum(['WARNING', 'TERMINATED', 'RECORDED', 'GROUPED', 'IGNORED']);
export type AssessmentIncidentOutcome = z.infer<typeof assessmentIncidentOutcomeSchema>;

export const assessmentIntegrityStatusSchema = z.enum(['NONE', 'INTEGRITY_VIOLATION_REVIEW', 'REVIEWED']);
export type AssessmentIntegrityStatus = z.infer<typeof assessmentIntegrityStatusSchema>;

/** The protection part of the candidate's page (the count is always the server's). */
export const assessmentProtectionStateSchema = z.object({
  /** false = attempt started before protection existed, or switched off: nothing is monitored. */
  enabled: z.boolean(),
  maxWarnings: z.number().int().min(0),
  warningCount: z.number().int().min(0),
  tabSwitchMonitoring: z.boolean(),
  fullscreenRequired: z.boolean(),
  multipleFacesPolicy: aiInterviewFacePolicySchema,
  /** The latest warning not acknowledged yet: shown again after a reload until confirmed. */
  pendingWarning: z.object({ warningNumber: z.number().int().positive(), type: assessmentIncidentTypeSchema, final: z.boolean() }).nullable(),
});
export type AssessmentProtectionState = z.infer<typeof assessmentProtectionStateSchema>;

/** POST /public/assessment/violation - one incident; the same incidentId again is counted once. */
export const assessmentViolationRequestSchema = z.object({
  incidentId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  type: assessmentIncidentTypeSchema,
  detail: z.string().max(200).optional(),
});

export const assessmentViolationResultSchema = z.object({
  outcome: assessmentIncidentOutcomeSchema,
  warningNumber: z.number().int().positive().nullable(),
  warningCount: z.number().int().min(0),
  maxWarnings: z.number().int().min(0),
  status: assessmentStatusSchema,
});
export type AssessmentViolationResult = z.infer<typeof assessmentViolationResultSchema>;

/** POST /public/assessment/violation/ack - the candidate read warning N. */
export const assessmentViolationAckRequestSchema = z.object({ warningNumber: z.number().int().positive() });

/**
 * POST /round-engine/applications/:applicationId/rounds/:roundId/integrity-decision. A terminated test waits for HR:
 * ADVANCE / REJECT with a written reason; then the usual next step follows (next invite or outcome email), once.
 */
export const assessmentIntegrityDecisionRequestSchema = z.object({
  decision: z.enum(['ADVANCE', 'REJECT']),
  reason: z.string().trim().min(5, 'Write what you concluded from the recorded incidents (at least 5 characters).').max(500),
});
export type AssessmentIntegrityDecisionRequest = z.input<typeof assessmentIntegrityDecisionRequestSchema>;

/** GET /public/assessment/session (and the answer of start / submit). */
export const assessmentPublicViewSchema = z.object({
  status: assessmentStatusSchema,
  candidateFirstName: z.string(),
  companyName: z.string(),
  jobTitle: z.string(),
  roundName: z.string(),
  /** The round description HR wrote (shown as instructions). */
  instructions: z.string(),
  /** null = no time limit. */
  timeLimitMinutes: z.number().int().nullable(),
  questionCount: z.number().int(),
  totalMarks: z.number().int(),
  linkExpiresAt: z.string(),
  consentVersion: z.string(),
  /** The webcam must be on during the test (server setting ASSESSMENT_REQUIRE_CAMERA). */
  cameraRequired: z.boolean(),
  /** The server's clock, so the page can show the right remaining time on a wrong device clock. */
  serverNow: z.string(),
  attempt: z
    .object({
      startedAt: z.string(),
      deadlineAt: z.string().nullable(),
      submittedAt: z.string().nullable(),
      revision: z.number().int(),
      /** Only while IN_PROGRESS (empty afterwards). */
      questions: z.array(assessmentQuestionSchema),
      answers: z.array(assessmentAnswerSchema),
    })
    .nullable(),
  /** Protection rules + the server's warning count (before the start: the rules that will apply). */
  protection: assessmentProtectionStateSchema,
});
export type AssessmentPublicView = z.infer<typeof assessmentPublicViewSchema>;

export const saveAssessmentAnswersResultSchema = z.object({
  /** The revision now stored (higher than the one sent = a newer save from another tab won). */
  revision: z.number().int(),
  serverNow: z.string(),
  deadlineAt: z.string().nullable(),
});
export type SaveAssessmentAnswersResult = z.infer<typeof saveAssessmentAnswersResultSchema>;

/** Event types the browser may report. Started / submitted / timed out are recorded by the server itself. */
export const clientProctorEventTypeSchema = z.enum([
  'CAMERA_STARTED',
  'CAMERA_STOPPED',
  'CAMERA_PERMISSION_REVOKED',
  'TAB_SWITCH',
  'FULLSCREEN_EXIT',
  'CONNECTION_LOST',
]);
export type ClientProctorEventType = z.infer<typeof clientProctorEventTypeSchema>;

export const proctorEventTypeSchema = z.enum([
  'ASSESSMENT_STARTED',
  'ASSESSMENT_SUBMITTED',
  'ASSESSMENT_TIMED_OUT',
  ...clientProctorEventTypeSchema.options,
]);
export type ProctorEventType = z.infer<typeof proctorEventTypeSchema>;

export const proctorSeveritySchema = z.enum(['INFO', 'WARNING']);
export type ProctorSeverity = z.infer<typeof proctorSeveritySchema>;

/** Labels for HR. Worded as observations: an event is never proof of cheating. */
export const PROCTOR_EVENT_LABELS: Record<ProctorEventType, string> = {
  ASSESSMENT_STARTED: 'Started the test',
  ASSESSMENT_SUBMITTED: 'Submitted the test',
  ASSESSMENT_TIMED_OUT: 'Time ran out (answers submitted automatically)',
  CAMERA_STARTED: 'Camera on',
  CAMERA_STOPPED: 'Camera stopped',
  CAMERA_PERMISSION_REVOKED: 'Camera permission withdrawn',
  TAB_SWITCH: 'Left the test tab',
  FULLSCREEN_EXIT: 'Left full screen',
  CONNECTION_LOST: 'Internet connection lost',
};

const detailValue = z.union([z.string().max(200), z.number().finite(), z.boolean()]);

/** POST /public/assessment/events - a batch of what the browser noticed. */
export const proctorEventsRequestSchema = z.object({
  events: z
    .array(
      z.object({
        type: clientProctorEventTypeSchema,
        occurredAt: z.string().datetime(),
        detail: z
          .record(z.string().max(40), detailValue)
          .refine((d) => Object.keys(d).length <= ASSESSMENT_LIMITS.detailKeys, 'Too many details')
          .default({}),
      }),
    )
    .min(1)
    .max(ASSESSMENT_LIMITS.eventsPerRequest),
});
export type ProctorEventsRequest = z.input<typeof proctorEventsRequestSchema>;

// ---------------------------------------------------------------- HR side

export const proctorEventViewSchema = z.object({
  type: proctorEventTypeSchema,
  severity: proctorSeveritySchema,
  occurredAt: z.string(),
  detail: z.record(z.union([z.string(), z.number(), z.boolean()])),
});
export type ProctorEventView = z.infer<typeof proctorEventViewSchema>;

export const roundOutcomeEmailKindSchema = z.enum(['REJECTED', 'CLEARED_NEXT_BY_HR', 'CLEARED_ALL']);
export type RoundOutcomeEmailKind = z.infer<typeof roundOutcomeEmailKindSchema>;

/** One round of one student, as the round engine ran it (invite, attempt, proctoring, outcome email). */
export const roundEngineRoundSchema = z.object({
  roundId: z.string(),
  /** Run online by the round engine (only MCQ / true-false questions). Other rounds are run by HR. */
  online: z.boolean(),
  /** How the engine runs it: TEST = multiple-choice page on the careers site, CODING = DSA coding page. null = HR runs it. */
  kind: z.enum(['TEST', 'CODING']).nullable().default(null),
  invite: z
    .object({
      emailStatus: emailDeliveryStatusSchema,
      sentAt: z.string().nullable(),
      expiresAt: z.string().nullable(),
      revoked: z.boolean(),
      lastError: z.string().nullable(),
    })
    .nullable(),
  attempt: z
    .object({
      status: assessmentStatusSchema.exclude(['NOT_STARTED']),
      startedAt: z.string(),
      deadlineAt: z.string().nullable(),
      submittedAt: z.string().nullable(),
      timeTakenSeconds: z.number().int().nullable(),
      answered: z.number().int(),
      questionCount: z.number().int(),
      warnings: z.number().int(),
    })
    .nullable(),
  events: z.array(proctorEventViewSchema),
  /** Protection: warnings, incidents, termination and HR's integrity decision (null = no attempt / not monitored). */
  integrity: z
    .object({
      status: assessmentIntegrityStatusSchema,
      settings: assessmentProtectionSettingsSchema,
      warningCount: z.number().int().min(0),
      terminatedAt: z.string().nullable(),
      terminationReason: z.string().nullable(),
      decision: z.object({ decision: z.enum(['ADVANCE', 'REJECT']), reason: z.string(), by: z.string().nullable(), at: z.string() }).nullable(),
      incidents: z.array(
        z.object({
          type: assessmentIncidentTypeSchema,
          outcome: assessmentIncidentOutcomeSchema,
          warningNumber: z.number().int().positive().nullable(),
          at: z.string(),
          detail: z.string().nullable(),
          acknowledgedAt: z.string().nullable(),
        }),
      ),
    })
    .nullable()
    .default(null),
  outcomeEmail: z.object({ kind: roundOutcomeEmailKindSchema, status: emailDeliveryStatusSchema, sentAt: z.string().nullable() }).nullable(),
});
export type RoundEngineRound = z.infer<typeof roundEngineRoundSchema>;

/** GET /api/v1/round-engine/applications/:applicationId */
export const applicationRoundEngineSchema = z.object({
  applicationId: z.string(),
  rounds: z.array(roundEngineRoundSchema),
});
export type ApplicationRoundEngine = z.infer<typeof applicationRoundEngineSchema>;
