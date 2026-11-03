import { z } from 'zod';
import { atsPartSchema, screeningDecisionSchema } from './ats';
import { difficultySchema, passModeSchema, passRuleSchema, questionKindSchema, roundModuleSchema, roundTypeSchema, roundsStatusSchema } from './rounds';

/**
 * Assessment results (the rounds after AI voice screening). Owner: assessments module (apps/api/src/modules/assessments).
 * The round engine (teammate) sends one result per student per round through RoundResultsService.record(); HR reads
 * them on the "Assessments" page. HR-only: none of this is ever part of a public API.
 */

/** One answer of a student, as the round engine sends it. Everything except questionId is optional. */
export const roundAnswerInputSchema = z.object({
  questionId: z.string().uuid(),
  /** Free text / code the student wrote (null for choice questions or when skipped). */
  answer: z.string().max(50_000).nullable().default(null),
  /** Option indexes the student picked (MCQ / TRUE_FALSE). */
  selected: z.array(z.number().int().min(0)).max(8).default([]),
  /** Graded by the round engine / evaluator (null = not graded, e.g. an interview question). */
  isCorrect: z.boolean().nullable().default(null),
  marksAwarded: z.number().min(0).nullable().default(null),
  feedback: z.string().max(4000).nullable().default(null),
});
export type RoundAnswerInput = z.input<typeof roundAnswerInputSchema>;
export type RoundAnswer = z.output<typeof roundAnswerInputSchema>;

/**
 * One finished round of one student. Send the number(s) the round's pass rule needs:
 * CORRECT_COUNT -> correctCount, MARKS / PERCENTAGE -> marks, INTERVIEWER_SCORE -> interviewerScore.
 * Sending the same result again (same application + round) replaces it until HR overrides it.
 */
export const roundResultInputSchema = z.object({
  applicationId: z.string().uuid(),
  roundId: z.string().uuid(),
  correctCount: z.number().int().min(0).nullable().default(null),
  marks: z.number().min(0).nullable().default(null),
  interviewerScore: z.number().min(0).nullable().default(null),
  answers: z.array(roundAnswerInputSchema).max(200).default([]),
  /** Interviewer / evaluator notes for HR. */
  notes: z.string().max(8000).nullable().default(null),
  startedAt: z.string().datetime().nullable().default(null),
  submittedAt: z.string().datetime().nullable().default(null),
});
export type RoundResultInput = z.input<typeof roundResultInputSchema>;

/** Where a student stands in one round. */
export const roundOutcomeSchema = z.enum(['NOT_ATTEMPTED', 'PASSED', 'FAILED']);
export type RoundOutcome = z.infer<typeof roundOutcomeSchema>;

/** Where a student stands overall. */
export const assessmentStageSchema = z.enum(['NOT_STARTED', 'IN_PROGRESS', 'CLEARED', 'NOT_CLEARED']);
export type AssessmentStage = z.infer<typeof assessmentStageSchema>;

const overrideSchema = z.object({ passed: z.boolean(), reason: z.string(), by: z.string().nullable(), at: z.string() });

/** One cell of the results table: a student in a round. */
export const roundCellSchema = z.object({
  roundId: z.string(),
  outcome: roundOutcomeSchema,
  /** In the pass rule's unit (correct answers, marks, %, interviewer score). */
  score: z.number().nullable(),
  maxScore: z.number().nullable(),
  passMark: z.number().nullable(),
  /** HR changed the result (outcome already includes it). */
  overridden: z.boolean(),
  /** No result yet: where the student is in this round ("Invited", "Test in progress", "In a GD group"...), or null. */
  progress: z.string().nullable(),
});
export type RoundCell = z.infer<typeof roundCellSchema>;

/** The AI voice screening (between resume screening and the rounds) of one student. */
export const aiScreeningProgressSchema = z.object({
  /** INVITED = the link was emailed, not opened yet. */
  status: z.enum(['INVITED', 'NOT_STARTED', 'IN_PROGRESS', 'COMPLETED', 'ENDED_EARLY']),
  /** HR's review of a finished screening; null before it has started. */
  review: z.enum(['PENDING', 'REVIEWED', 'NEEDS_FOLLOW_UP']).nullable(),
});
export type AiScreeningProgress = z.infer<typeof aiScreeningProgressSchema>;

export const assessmentRoundSummarySchema = z.object({
  id: z.string(),
  position: z.number().int(),
  type: roundTypeSchema,
  name: z.string(),
  description: z.string(),
  timeLimitMinutes: z.number().int().nullable(),
  passRule: passRuleSchema.nullable(),
  /** "8 of 10 correct"... */
  passRuleText: z.string().nullable(),
  questionCount: z.number().int(),
  totalMarks: z.number().int(),
  counts: z.object({ passed: z.number().int(), failed: z.number().int(), notAttempted: z.number().int() }),
  /** ONLINE_TEST = the round engine runs it; MODULE = a round module (GD, DSA, SQL, AI interview); HR = by hand. */
  runBy: z.enum(['ONLINE_TEST', 'MODULE', 'HR']),
  module: roundModuleSchema.nullable(),
  /** The module is part of this server and takes students (false = HR runs the round until it is connected). */
  moduleConnected: z.boolean(),
});
export type AssessmentRoundSummary = z.infer<typeof assessmentRoundSummarySchema>;

export const assessmentStudentRowSchema = z.object({
  applicationId: z.string(),
  name: z.string(),
  email: z.string(),
  college: z.string(),
  atsScore: z.number().int().nullable(),
  /** null = no AI screening link sent. */
  aiScreening: aiScreeningProgressSchema.nullable(),
  stage: assessmentStageSchema,
  rounds: z.array(roundCellSchema),
});
export type AssessmentStudentRow = z.infer<typeof assessmentStudentRowSchema>;

/** GET /api/v1/assessments/jobs/:jobId - every shortlisted student of the job and their round results. */
export const jobAssessmentsSchema = z.object({
  jobId: z.string(),
  jobTitle: z.string(),
  roundsStatus: roundsStatusSchema,
  locked: z.boolean(),
  rounds: z.array(assessmentRoundSummarySchema),
  students: z.array(assessmentStudentRowSchema),
});
export type JobAssessments = z.infer<typeof jobAssessmentsSchema>;

/** GET /api/v1/assessments/jobs - job picker. */
export const assessmentJobSchema = z.object({
  jobId: z.string(),
  title: z.string(),
  roundsStatus: roundsStatusSchema,
  roundCount: z.number().int(),
  students: z.number().int(),
  resultsReceived: z.number().int(),
});
export type AssessmentJob = z.infer<typeof assessmentJobSchema>;

/** One round in a student's full review: the round, the pass mark, the result and every question with the answer. */
export const studentRoundReviewSchema = z.object({
  round: assessmentRoundSummarySchema.omit({ counts: true }),
  outcome: roundOutcomeSchema,
  /** The round engine's result before any HR override (null = not attempted). */
  systemPassed: z.boolean().nullable(),
  score: z.number().nullable(),
  maxScore: z.number().nullable(),
  passMark: z.number().nullable(),
  passMode: passModeSchema.nullable(),
  notes: z.string().nullable(),
  startedAt: z.string().nullable(),
  submittedAt: z.string().nullable(),
  override: overrideSchema.nullable(),
  answers: z.array(
    z.object({
      questionId: z.string(),
      position: z.number().int(),
      kind: questionKindSchema,
      text: z.string(),
      options: z.array(z.string()),
      correct: z.array(z.number().int()),
      modelAnswer: z.string().nullable(),
      marks: z.number().int(),
      difficulty: difficultySchema.nullable(),
      /** null when the student did not answer this question. */
      answer: z.string().nullable(),
      selected: z.array(z.number().int()),
      answered: z.boolean(),
      isCorrect: z.boolean().nullable(),
      marksAwarded: z.number().nullable(),
      feedback: z.string().nullable(),
    }),
  ),
});
export type StudentRoundReview = z.infer<typeof studentRoundReviewSchema>;

/** GET /api/v1/assessments/applications/:applicationId - the full review of one student. */
export const studentAssessmentSchema = z.object({
  applicationId: z.string(),
  jobId: z.string(),
  jobTitle: z.string(),
  candidate: z.object({ name: z.string(), email: z.string(), phone: z.string(), college: z.string(), degree: z.string(), branch: z.string(), graduationYear: z.number().int() }),
  stage: assessmentStageSchema,
  resume: z
    .object({
      score: z.number().int().nullable(),
      minAtsScore: z.number().int().nullable(),
      decision: screeningDecisionSchema.nullable(),
      breakdown: z.array(atsPartSchema).nullable(),
      matchedSkills: z.array(z.string()),
      missingSkills: z.array(z.string()),
    })
    .nullable(),
  /** The AI voice screening exists for this student (its notes come from GET /screening/applications/:id). */
  hasVoiceScreening: z.boolean(),
  rounds: z.array(studentRoundReviewSchema),
});
export type StudentAssessment = z.infer<typeof studentAssessmentSchema>;

/** PUT /api/v1/assessments/applications/:applicationId/rounds/:roundId/override. passed null = remove the override. */
export const overrideRoundResultRequestSchema = z
  .object({
    passed: z.boolean().nullable(),
    reason: z.string().trim().max(500, 'Use at most 500 characters').default(''),
  })
  .refine((o) => o.passed === null || o.reason.length >= 5, { path: ['reason'], message: 'Write why you are changing the result (at least 5 characters).' });
export type OverrideRoundResultRequest = z.input<typeof overrideRoundResultRequestSchema>;
