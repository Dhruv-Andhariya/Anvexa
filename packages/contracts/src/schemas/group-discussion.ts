import { z } from 'zod';

/**
 * M18 AI group discussion. Owner: group-discussion module (apps/api/src/modules/group-discussion).
 * Students reach this round on their own: when they pass the round before it (or finish AI screening when the GD is
 * the first round) they wait in the round's pool. HR schedules a GD event; the pool is split into groups (batches)
 * of `minGroupSize`-`maxGroupSize`, one after another, each with its own LiveKit room, time slot and topic.
 * Topics are the round's questions on the Publish page (round type Group Discussion, question kind Interview).
 * Everything here is HR-only.
 */

export const GD_LIMITS = {
  nameMax: 80,
  groupSizeMin: 3,
  groupSizeMax: 15,
  graceMinutesMax: 15,
  introSecondsMin: 30,
  introSecondsMax: 300,
  thinkingSecondsMin: 30,
  thinkingSecondsMax: 600,
  discussionMinutesMin: 5,
  discussionMinutesMax: 60,
  summarySecondsMin: 30,
  summarySecondsMax: 180,
  hrQuestionsMinutesMax: 30,
  silencePromptSecondsMin: 10,
  silencePromptSecondsMax: 120,
  breakMinutesMax: 60,
  /** An event must start at least this far ahead (the reminder goes out 15 minutes before). */
  minLeadMinutes: 15,
  /** ...and at most this far ahead. */
  maxLeadDays: 60,
} as const;

/** The bot's closing words; not configurable, only part of the time estimate. */
export const GD_CLOSE_SECONDS = 60;

const minutes = (min: number, max: number) => z.number().int('Use whole minutes').min(min, `At least ${min}`).max(max, `At most ${max}`);
const seconds = (min: number, max: number) => z.number().int('Use whole seconds').min(min, `At least ${min} seconds`).max(max, `At most ${max} seconds`);

/** How one GD event runs. Every batch of the event uses the same settings. */
export const gdSettingsSchema = z
  .object({
    minGroupSize: z.number().int().min(GD_LIMITS.groupSizeMin).max(GD_LIMITS.groupSizeMax),
    maxGroupSize: z.number().int().min(GD_LIMITS.groupSizeMin).max(GD_LIMITS.groupSizeMax),
    /** The room stays open this long after the start time; then it locks and missing students are marked absent. */
    graceMinutes: minutes(1, GD_LIMITS.graceMinutesMax),
    introSeconds: seconds(GD_LIMITS.introSecondsMin, GD_LIMITS.introSecondsMax),
    thinkingSeconds: seconds(GD_LIMITS.thinkingSecondsMin, GD_LIMITS.thinkingSecondsMax),
    discussionMinutes: minutes(GD_LIMITS.discussionMinutesMin, GD_LIMITS.discussionMinutesMax),
    /** Summary round: each student gets this long. */
    summarySeconds: seconds(GD_LIMITS.summarySecondsMin, GD_LIMITS.summarySecondsMax),
    hrQuestionsEnabled: z.boolean(),
    hrQuestionsMinutes: minutes(1, GD_LIMITS.hrQuestionsMinutesMax),
    /** During the discussion the bot gives a gentle prompt after this much silence. */
    silencePromptSeconds: seconds(GD_LIMITS.silencePromptSecondsMin, GD_LIMITS.silencePromptSecondsMax),
    /** Gap between one group's end and the next group's start. */
    breakMinutes: z.number().int('Use whole minutes').min(0).max(GD_LIMITS.breakMinutesMax),
  })
  .refine((s) => s.minGroupSize <= s.maxGroupSize, { message: 'The smallest group size cannot be more than the largest.', path: ['minGroupSize'] });
export type GdSettings = z.infer<typeof gdSettingsSchema>;

export const GD_DEFAULT_SETTINGS: GdSettings = {
  minGroupSize: 6,
  maxGroupSize: 10,
  graceMinutes: 5,
  introSeconds: 60,
  thinkingSeconds: 120,
  discussionMinutes: 15,
  summarySeconds: 60,
  hrQuestionsEnabled: true,
  hrQuestionsMinutes: 5,
  silencePromptSeconds: 20,
  breakMinutes: 10,
};

/**
 * Splits `count` students into groups of minSize-maxSize, as even as possible, with as few groups as possible.
 * When that is impossible (e.g. 11 students, groups of 6-10) the groups are still as even as possible and
 * `undersized` says so (HR sees a warning). 0 students = no groups.
 */
export function planGroupSizes(count: number, minSize: number, maxSize: number): { sizes: number[]; undersized: boolean } {
  if (count <= 0) return { sizes: [], undersized: false };
  // the fewest groups that keep every group within maxSize; spreading evenly then gives the largest small groups
  const groups = Math.ceil(count / maxSize);
  const base = Math.floor(count / groups);
  const extra = count % groups;
  const sizes = Array.from({ length: groups }, (_, i) => base + (i < extra ? 1 : 0));
  return { sizes, undersized: sizes.some((s) => s < minSize) };
}

/** How long one group's GD takes from its start time (grace period included), in minutes, rounded up. */
export function gdSlotMinutes(settings: GdSettings, groupSize: number): number {
  const seconds =
    settings.graceMinutes * 60 +
    settings.introSeconds +
    settings.thinkingSeconds +
    settings.discussionMinutes * 60 +
    settings.summarySeconds * groupSize +
    (settings.hrQuestionsEnabled ? settings.hrQuestionsMinutes * 60 : 0) +
    GD_CLOSE_SECONDS;
  return Math.ceil(seconds / 60);
}

/** Start and (estimated) end of each group, back to back with `breakMinutes` in between. */
export function planGroupSlots(startsAt: Date, settings: GdSettings, sizes: number[]): { startsAt: Date; endsAt: Date }[] {
  let next = startsAt.getTime();
  return sizes.map((size) => {
    const start = next;
    const end = start + gdSlotMinutes(settings, size) * 60_000;
    next = end + settings.breakMinutes * 60_000;
    return { startsAt: new Date(start), endsAt: new Date(end) };
  });
}

export const gdEventStatusSchema = z.enum(['SCHEDULED', 'COMPLETED', 'CANCELLED']);
export type GdEventStatus = z.infer<typeof gdEventStatusSchema>;

export const gdBatchStatusSchema = z.enum(['SCHEDULED', 'LOBBY_OPEN', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED']);
export type GdBatchStatus = z.infer<typeof gdBatchStatusSchema>;

/**
 * WAITING = in the round's pool, not in a group yet. SCHEDULED = in a group, invitation not sent yet.
 * INVITED / JOINED / ABSENT / ADMITTED_LATE = attendance (absent students are kept, never deleted).
 */
export const gdAttendanceSchema = z.enum(['WAITING', 'SCHEDULED', 'INVITED', 'JOINED', 'ABSENT', 'ADMITTED_LATE']);
export type GdAttendance = z.infer<typeof gdAttendanceSchema>;

/** POST /api/v1/group-discussion/rounds/:roundId/events - every WAITING student of the round is put in a group. */
export const createGdEventRequestSchema = z.object({
  name: z.string().trim().min(1, 'Give the event a name').max(GD_LIMITS.nameMax, `Use at most ${GD_LIMITS.nameMax} characters`),
  /** ISO date-time of the first group's start. */
  startsAt: z.string().datetime({ offset: true, message: 'Pick a date and time' }),
  settings: gdSettingsSchema,
});
export type CreateGdEventRequest = z.infer<typeof createGdEventRequestSchema>;

/** PUT /api/v1/group-discussion/batches/:batchId/topic - before the group starts. */
export const setGdBatchTopicRequestSchema = z.object({ topicId: z.string().uuid() });
export type SetGdBatchTopicRequest = z.infer<typeof setGdBatchTopicRequestSchema>;

export const gdTopicSchema = z.object({ id: z.string(), text: z.string() });
export type GdTopic = z.infer<typeof gdTopicSchema>;

export const gdParticipantSchema = z.object({
  id: z.string(),
  applicationId: z.string(),
  name: z.string(),
  email: z.string(),
  college: z.string().nullable(),
  attendance: gdAttendanceSchema,
  /** When the student entered the pool (passed the previous round). */
  addedAt: z.string(),
});
export type GdParticipant = z.infer<typeof gdParticipantSchema>;

/** The whole session as one audio file (everyone's recording mixed on one timeline), built after the group ends. */
export const gdSessionAudioSchema = z.object({
  durationMs: z.number().int(),
  bytes: z.number().int(),
  createdAt: z.string(),
});
export type GdSessionAudio = z.infer<typeof gdSessionAudioSchema>;

export const gdBatchSchema = z.object({
  id: z.string(),
  number: z.number().int(),
  startsAt: z.string(),
  /** Estimated from the settings and the group size. */
  endsAt: z.string(),
  status: gdBatchStatusSchema,
  topic: gdTopicSchema.nullable(),
  participants: z.array(gdParticipantSchema),
  /** null = not built yet (the group has not ended, or its audio is still being processed / was deleted). */
  sessionAudio: gdSessionAudioSchema.nullable(),
});
export type GdBatch = z.infer<typeof gdBatchSchema>;

export const gdEventSchema = z.object({
  id: z.string(),
  name: z.string(),
  startsAt: z.string(),
  status: gdEventStatusSchema,
  settings: gdSettingsSchema,
  createdAt: z.string(),
  /** The groups could not all be within the size limits (HR was warned when scheduling). */
  undersized: z.boolean(),
  batches: z.array(gdBatchSchema),
});
export type GdEvent = z.infer<typeof gdEventSchema>;

/** GET /api/v1/group-discussion/rounds/:roundId - everything HR needs to schedule and follow one GD round. */
export const gdRoundOverviewSchema = z.object({
  roundId: z.string(),
  roundName: z.string(),
  position: z.number().int(),
  jobId: z.string(),
  jobTitle: z.string(),
  /** The job's rounds are COMPLETE on the Publish page (only then do students reach the GD). */
  roundsComplete: z.boolean(),
  topics: z.array(gdTopicSchema),
  /** Students waiting for a group, oldest first. */
  pool: z.array(gdParticipantSchema),
  events: z.array(gdEventSchema),
  /** Prefill for the next event: the last event's settings, or the defaults. */
  suggestedSettings: gdSettingsSchema,
});
export type GdRoundOverview = z.infer<typeof gdRoundOverviewSchema>;

/** GET /api/v1/group-discussion/rounds - every GD round of the company's jobs. */
export const gdRoundSummarySchema = z.object({
  roundId: z.string(),
  roundName: z.string(),
  jobId: z.string(),
  jobTitle: z.string(),
  waiting: z.number().int(),
  scheduled: z.number().int(),
  nextStartsAt: z.string().nullable(),
});
export type GdRoundSummary = z.infer<typeof gdRoundSummarySchema>;
export const gdRoundListSchema = z.array(gdRoundSummarySchema);

// =====================================================================================================================
// Live session (phases 2-6). The SERVER owns the timeline; every client and the moderator bot follow it through the
// LiveKit room metadata (gdLiveStateSchema), pushed on every change, with GET .../state as a fallback.
// =====================================================================================================================

/** Bump when the consent text on the GD lobby changes (stored with every participant). */
export const GD_CONSENT_VERSION = 'gd-2026-11';

/** LiveKit identities: who is who in a room. */
export const GD_IDENTITY = {
  moderator: 'moderator',
  student: (participantId: string) => `s:${participantId}`,
  hr: (userId: string) => `hr:${userId}`,
} as const;
export const isStudentIdentity = (identity: string) => identity.startsWith('s:');
export const isHrIdentity = (identity: string) => identity.startsWith('hr:');
export const participantIdOf = (identity: string) => (isStudentIdentity(identity) ? identity.slice(2) : null);

export const gdPhaseSchema = z.enum(['NOT_STARTED', 'INTRO', 'THINKING', 'DISCUSSION', 'SUMMARY', 'HR_QUESTIONS', 'CLOSE', 'ENDED']);
export type GdPhase = z.infer<typeof gdPhaseSchema>;

export const GD_PHASE_LABEL: Record<GdPhase, string> = {
  NOT_STARTED: 'Waiting to start',
  INTRO: 'Introduction',
  THINKING: 'Thinking time',
  DISCUSSION: 'Discussion',
  SUMMARY: 'Summary round',
  HR_QUESTIONS: 'HR questions',
  CLOSE: 'Closing',
  ENDED: 'Ended',
};

/** What every screen in the room shows, and what the bot reacts to. Times are server ISO strings. */
export const gdLiveStateSchema = z.object({
  v: z.literal(1),
  batchStatus: gdBatchStatusSchema,
  phase: gdPhaseSchema,
  phaseStartedAt: z.string().nullable(),
  /** End of the current phase. While paused, the remaining time is phaseEndsAt - pausedAt. */
  phaseEndsAt: z.string().nullable(),
  pausedAt: z.string().nullable(),
  /** Server clock when this state was made (clients correct their own clock with it). */
  serverNow: z.string(),
  /** Shown from Thinking time on; null before. */
  topic: z.string().nullable(),
  /** Summary round: whose minute it is. */
  currentSpeaker: z.object({ identity: z.string(), name: z.string() }).nullable(),
  /** Summary round: speaking order (first names), so everyone knows who is next. */
  summaryOrder: z.array(z.object({ identity: z.string(), name: z.string() })),
  hrSpeaking: z.boolean(),
  /** Students (identities) in a private talk with HR right now. */
  withHr: z.array(z.string()),
  /** The phases of this group, in order, with their planned length (seconds). */
  plan: z.array(z.object({ phase: gdPhaseSchema, seconds: z.number().int() })),
  silencePromptSeconds: z.number().int(),
});
export type GdLiveState = z.infer<typeof gdLiveStateSchema>;

/** Remaining milliseconds of the current phase on the server's clock (`offsetMs` = server - client). */
export function gdRemainingMs(state: Pick<GdLiveState, 'phaseEndsAt' | 'pausedAt'>, clientNowMs: number, offsetMs: number): number | null {
  if (!state.phaseEndsAt) return null;
  const now = state.pausedAt ? Date.parse(state.pausedAt) : clientNowMs + offsetMs;
  return Math.max(0, Date.parse(state.phaseEndsAt) - now);
}

/** What the student page knows before joining (GET /public/gd/session, header x-gd-token). */
export const gdPublicStatusSchema = z.enum([
  'UPCOMING', // before the start time: device check allowed, Join not yet
  'OPEN', // joining window: Join
  'IN_PROGRESS', // locked; only students who joined (or HR admitted) may come back in
  'MISSED', // the joining window passed without this student (HR may still admit or move them)
  'ENDED',
  'CANCELLED',
]);
export type GdPublicStatus = z.infer<typeof gdPublicStatusSchema>;

export const gdPublicSessionSchema = z.object({
  status: gdPublicStatusSchema,
  candidateFirstName: z.string(),
  companyName: z.string(),
  jobTitle: z.string(),
  roundName: z.string(),
  startsAt: z.string(),
  joinClosesAt: z.string(),
  estimatedEndAt: z.string(),
  groupSize: z.number().int(),
  settings: z.object({
    graceMinutes: z.number().int(),
    introSeconds: z.number().int(),
    thinkingSeconds: z.number().int(),
    discussionMinutes: z.number().int(),
    summarySeconds: z.number().int(),
    hrQuestionsEnabled: z.boolean(),
    hrQuestionsMinutes: z.number().int(),
  }),
  consentVersion: z.string(),
  /** This student has been in the room (a reconnect needs no new consent). */
  joined: z.boolean(),
  serverNow: z.string(),
});
export type GdPublicSession = z.infer<typeof gdPublicSessionSchema>;

/** POST /public/gd/join - body { consent: true }. */
export const gdJoinRequestSchema = z.object({ consent: z.literal(true) });

/** A LiveKit connection: server URL, a short-lived token for ONE room, and who you are in it. */
export const gdConnectionSchema = z.object({ url: z.string(), token: z.string(), identity: z.string() });
export type GdConnection = z.infer<typeof gdConnectionSchema>;

export const gdJoinResultSchema = z.object({ connection: gdConnectionSchema, state: gdLiveStateSchema });
export type GdJoinResult = z.infer<typeof gdJoinResultSchema>;

/** GET /public/gd/private - the private room HR opened for this student, if any. */
export const gdPrivateTalkConnectionSchema = z.object({
  active: z.boolean(),
  talkId: z.string().nullable(),
  connection: gdConnectionSchema.nullable(),
});
export type GdPrivateTalkConnection = z.infer<typeof gdPrivateTalkConnectionSchema>;

export const GD_AUDIO_LIMITS = {
  /** MediaRecorder timeslice: one chunk every this many ms. */
  chunkMs: 5000,
  chunkMaxBytes: 2 * 1024 * 1024,
  chunksPerRecording: 2000,
  mimeTypes: ['audio/webm', 'audio/webm;codecs=opus', 'audio/ogg', 'audio/ogg;codecs=opus', 'audio/mp4', 'audio/mp4;codecs=mp4a.40.2'],
} as const;

/** POST .../recordings - a new continuous recording; the server stamps its start time. */
export const gdStartRecordingRequestSchema = z.object({ mimeType: z.string().max(60) });
export const gdRecordingStartedSchema = z.object({ recordingId: z.string(), startedAt: z.string() });
export type GdRecordingStarted = z.infer<typeof gdRecordingStartedSchema>;

export const gdClientEventTypeSchema = z.enum(['JOINED', 'LEFT', 'CAMERA_OFF', 'CAMERA_ON', 'MIC_OFF', 'MIC_ON', 'HAND_RAISED', 'HAND_LOWERED', 'TAB_HIDDEN']);
export type GdClientEventType = z.infer<typeof gdClientEventTypeSchema>;
export const gdClientEventsRequestSchema = z.object({
  events: z.array(z.object({ type: gdClientEventTypeSchema, occurredAt: z.string().datetime() })).min(1).max(20),
});

// ---------------------------------------------------------------- HR live dashboard (phase 6)

export const gdHrActivityKindSchema = z.enum([
  'JOINED',
  'SPEAK_START',
  'SPEAK_END',
  'TIMER_PAUSED',
  'TIMER_RESUMED',
  'PRIVATE_START',
  'PRIVATE_END',
  'PRIVATE_INCLUDED',
  'PRIVATE_EXCLUDED',
  'ADMITTED_LATE',
  'RESCHEDULED',
  'OVERRIDE',
  'CONFIRMED',
]);
export type GdHrActivityKind = z.infer<typeof gdHrActivityKindSchema>;

export const gdLiveParticipantSchema = z.object({
  id: z.string(),
  identity: z.string(),
  name: z.string(),
  email: z.string(),
  college: z.string().nullable(),
  attendance: gdAttendanceSchema,
  joinedAt: z.string().nullable(),
  /** Times the camera went off (reported by the student's browser). */
  cameraOffCount: z.number().int(),
  lastEvent: z.object({ type: gdClientEventTypeSchema, at: z.string() }).nullable(),
});
export type GdLiveParticipant = z.infer<typeof gdLiveParticipantSchema>;

export const gdPrivateTalkSchema = z.object({
  id: z.string(),
  participantId: z.string(),
  studentName: z.string(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  includeInEvaluation: z.boolean(),
});
export type GdPrivateTalk = z.infer<typeof gdPrivateTalkSchema>;

export const gdActivitySchema = z.object({
  kind: gdHrActivityKindSchema,
  hrName: z.string().nullable(),
  participantName: z.string().nullable(),
  at: z.string(),
});
export type GdActivity = z.infer<typeof gdActivitySchema>;

/** GET /group-discussion/batches/:batchId/live */
export const gdHrLiveSchema = z.object({
  batchId: z.string(),
  number: z.number().int(),
  eventName: z.string(),
  roundName: z.string(),
  jobTitle: z.string(),
  roundId: z.string(),
  startsAt: z.string(),
  joinClosesAt: z.string(),
  settings: gdSettingsSchema,
  /** null before the start time (HR joins from the start time on). */
  connection: gdConnectionSchema.nullable(),
  state: gdLiveStateSchema,
  participants: z.array(gdLiveParticipantSchema),
  privateTalks: z.array(gdPrivateTalkSchema),
  activity: z.array(gdActivitySchema),
  /** Groups an absent student can be moved to (not started yet, same round). */
  rescheduleTargets: z.array(z.object({ batchId: z.string(), eventName: z.string(), number: z.number().int(), startsAt: z.string() })),
});
export type GdHrLive = z.infer<typeof gdHrLiveSchema>;

export const gdSpeakRequestSchema = z.object({ on: z.boolean() });
export const gdStartPrivateTalkRequestSchema = z.object({ participantId: z.string().uuid() });
export const gdPrivateTalkStartedSchema = z.object({ talkId: z.string(), connection: gdConnectionSchema });
export type GdPrivateTalkStarted = z.infer<typeof gdPrivateTalkStartedSchema>;
export const gdRescheduleRequestSchema = z.object({ batchId: z.string().uuid() });

// ---------------------------------------------------------------- evaluation (phase 5) and results (phase 6)

export const GD_CRITERIA = ['content', 'communication', 'initiative', 'listening', 'balance', 'summary', 'hr_response'] as const;
export type GdCriterion = (typeof GD_CRITERIA)[number];
export const GD_CRITERION_LABEL: Record<GdCriterion, string> = {
  content: 'Content relevance & accuracy',
  communication: 'Clarity & fluency',
  initiative: 'Initiative',
  listening: 'Listening & building on others',
  balance: 'Balance (fair talk time)',
  summary: 'Summary quality',
  hr_response: 'Response to HR questions',
};

const score = z.number().int().min(1).max(10);

/** EXACTLY what the evaluator (LLM) must return for one student; validated on the worker and again in the API. */
export const gdEvaluationResultSchema = z.object({
  student_id: z.string(),
  scores: z.object({
    content: score,
    communication: score,
    initiative: score,
    listening: score,
    balance: score,
    summary: score,
    hr_response: score.nullable(),
  }),
  overall: z.number().min(1).max(10),
  recommendation: z.enum(['selected', 'not_selected']),
  evidence: z.array(z.object({ criterion: z.string(), quote: z.string(), reason: z.string() })).max(20),
  feedback: z.string().max(2000),
});
export type GdEvaluationResult = z.infer<typeof gdEvaluationResultSchema>;

/** Speaking metrics computed from the per-student transcripts (no AI involved). */
export const gdMetricsSchema = z.object({
  talkSeconds: z.number(),
  /** Share of all students' talk time, 0-1. */
  talkShare: z.number(),
  words: z.number().int(),
  wordsPerMinute: z.number(),
  fillerWords: z.number().int(),
  interruptions: z.number().int(),
  turns: z.number().int(),
  summarySeconds: z.number(),
  answeredHr: z.boolean(),
});
export type GdMetrics = z.infer<typeof gdMetricsSchema>;

export const gdRecommendationSchema = z.enum(['SELECTED', 'NOT_SELECTED']);
export type GdRecommendation = z.infer<typeof gdRecommendationSchema>;

export const gdResultStudentSchema = z.object({
  participantId: z.string(),
  applicationId: z.string(),
  name: z.string(),
  email: z.string(),
  attendance: gdAttendanceSchema,
  evaluation: z
    .object({
      status: z.enum(['OK', 'NO_AUDIO', 'FAILED']),
      scores: gdEvaluationResultSchema.shape.scores.nullable(),
      overall: z.number().nullable(),
      recommendation: gdRecommendationSchema.nullable(),
      evidence: gdEvaluationResultSchema.shape.evidence,
      feedback: z.string(),
      metrics: gdMetricsSchema.nullable(),
      error: z.string().nullable(),
    })
    .nullable(),
  /** HR's override (null = follow the AI). */
  hrDecision: z.object({ decision: gdRecommendationSchema, reason: z.string(), by: z.string().nullable(), at: z.string() }).nullable(),
  /** HR's rubric scores (only when the round has a rubric); null = not scored yet. */
  rubric: z
    .object({
      scores: z.array(z.object({ parameter: z.string(), marks: z.number() })),
      total: z.number(),
      maxTotal: z.number(),
      /** What the pass rule decided from these marks. */
      passed: z.boolean(),
      remarks: z.string(),
      at: z.string().nullable(),
    })
    .nullable()
    .optional(),
  /** What happens on "Confirm selection": HR's decision, else the rubric result, else the AI. Absent = never selected. */
  finalDecision: gdRecommendationSchema,
  resultEmail: z.object({ status: z.string(), sentAt: z.string().nullable() }).nullable(),
});
export type GdResultStudent = z.infer<typeof gdResultStudentSchema>;

export const gdProcessingStatusSchema = z.enum(['PENDING', 'RUNNING', 'DONE', 'FAILED']);

/** GET /group-discussion/batches/:batchId/results - ranked, best first. */
export const gdResultsSchema = z.object({
  batchId: z.string(),
  number: z.number().int(),
  eventName: z.string(),
  roundName: z.string(),
  jobTitle: z.string(),
  roundId: z.string(),
  topic: z.string().nullable(),
  startsAt: z.string(),
  batchStatus: gdBatchStatusSchema,
  processing: z.object({ status: gdProcessingStatusSchema.nullable(), error: z.string().nullable(), processedAt: z.string().nullable() }),
  confirmedAt: z.string().nullable(),
  sessionAudio: gdSessionAudioSchema.nullable(),
  /** Why the whole-session audio could not be built (HR can try again). */
  sessionAudioError: z.string().nullable(),
  /** HR's rubric of this GD round (null = none: the AI's overall score decides). */
  rubric: z.array(z.object({ name: z.string(), maxMarks: z.number().int() })).nullable().optional(),
  students: z.array(gdResultStudentSchema),
  privateTalks: z.array(gdPrivateTalkSchema),
  activity: z.array(gdActivitySchema),
});
export type GdResults = z.infer<typeof gdResultsSchema>;

/** PUT /group-discussion/batches/:batchId/students/:participantId/decision - null = back to the AI's recommendation. */
export const gdDecisionRequestSchema = z.object({
  decision: gdRecommendationSchema.nullable(),
  reason: z.string().trim().max(500).default(''),
});
export const gdIncludePrivateTalkRequestSchema = z.object({ include: z.boolean() });
