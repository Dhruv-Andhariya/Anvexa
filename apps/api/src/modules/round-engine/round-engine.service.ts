import { HttpException, HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import {
  ASSESSMENT_CONSENT_VERSION,
  ASSESSMENT_LIMITS,
  proctorEventsRequestSchema,
  saveAssessmentAnswersRequestSchema,
  startAssessmentRequestSchema,
  type ApplicationRoundEngine,
  type AssessmentPublicView,
  type SaveAssessmentAnswersResult,
  type SavedRound,
} from '@hireflow/contracts';
import { AssessmentsService } from '../assessments';
import { AuditService } from '../audit';
import { RoundsConfigService, type RoundsForEngine } from '../rounds-config';
import type { Actor } from '../tenants';
import { TOKEN_SHAPE, hashAssessmentToken } from './link';
import {
  DEADLINE_GRACE_MS,
  InvalidAnswersError,
  SEVERITY,
  answeredCount,
  cleanAnswers,
  isCodingRound,
  isInvitedRound,
  isOnlineRound,
  nextStep,
  publicQuestions,
  toRoundAnswers,
  type StoredAnswers,
} from './online-test';
import { RoundEngineStore, type AttemptRow, type CandidateContext, type InviteRow } from './round-engine.store';

export const ROUND_ENGINE_CONFIG = Symbol('ROUND_ENGINE_CONFIG');
export const ROUND_ENGINE_CLOCK = Symbol('ROUND_ENGINE_CLOCK');

export interface RoundEngineConfig {
  /** The webcam must be on during a test (ASSESSMENT_REQUIRE_CAMERA, default on). Shown to candidates; recorded as events. */
  cameraRequired: boolean;
}

export const roundEngineConfigFromEnv = (env: NodeJS.ProcessEnv = process.env): RoundEngineConfig => ({
  cameraRequired: !['off', 'false', '0'].includes((env.ASSESSMENT_REQUIRE_CAMERA ?? '').trim().toLowerCase()),
});

/** Same error body shape as the other modules: { statusCode, code, message, ...extra }. Never a token. */
export const engineError = (status: number, code: string, message: string, extra: Record<string, unknown> = {}) =>
  new HttpException({ statusCode: status, code, message, ...extra }, status);

const invalidLink = () => engineError(HttpStatus.NOT_FOUND, 'ASSESSMENT_LINK_INVALID', 'This assessment link is not valid. Please use the link from your latest email.');

/** Stored as the attempt's consent version: the DSA page records its own monitoring consent (dsa proctoring). */
export const DSA_CONSENT_VERSION = 'dsa-proctoring';

/** A coding round's link as the DSA page needs it. */
export interface CodingInvite {
  inviteId: string;
  tenantId: string;
  roundId: string;
  candidateName: string;
  timeLimitMinutes: number | null;
}

/** A finished DSA attempt in the DSA module's own marks (best submission per problem). */
export interface CodingScore {
  score: number;
  maxScore: number;
  solved: number;
  total: number;
  /** One line per problem, kept as the result's notes for HR. */
  summary: string;
}
export type CodingScorer = (inviteId: string) => Promise<CodingScore>;

interface Opened {
  invite: InviteRow;
  ctx: CandidateContext;
  config: RoundsForEngine;
  round: SavedRound;
  attempt: AttemptRow | null;
}

/**
 * The online test rounds (M13). Candidate side: the link token is the ONLY credential; it is looked up by its
 * SHA-256, must not be expired or revoked, and gives access to exactly one application's one round. The server owns
 * the questions, the clock and the answers; the browser never sends a score, a pass mark, a deadline or an id of
 * anything else. Pass / fail is decided by the assessments module; this module then queues the next step once.
 */
@Injectable()
export class RoundEngineService {
  private readonly logger = new Logger('RoundEngine');
  /** Set by the dsa module at start-up; coding attempts are graded through it. */
  private codingScorer: CodingScorer | null = null;

  constructor(
    @Inject(RoundEngineStore) private readonly store: RoundEngineStore,
    @Inject(RoundsConfigService) private readonly rounds: RoundsConfigService,
    @Inject(AssessmentsService) private readonly assessments: AssessmentsService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ROUND_ENGINE_CONFIG) private readonly config: RoundEngineConfig,
    @Inject(ROUND_ENGINE_CLOCK) private readonly now: () => Date,
  ) {}

  // ---------------------------------------------------------------- candidate (public, token)

  /** GET /public/assessment/session. A test whose time ran out is submitted here (with the saved answers). */
  async view(token: string | undefined): Promise<AssessmentPublicView> {
    let o = await this.open(token, { allowFinished: true });
    if (o.attempt?.status === 'IN_PROGRESS' && this.overdue(o.attempt)) {
      await this.finish(o.attempt, 'TIMED_OUT');
      o = { ...o, attempt: await this.store.getAttempt(o.attempt.id) };
    }
    return this.publicView(o);
  }

  /** POST /public/assessment/start - consent given; starts the clock (or continues the attempt that already runs). */
  async start(token: string | undefined, body: unknown): Promise<AssessmentPublicView> {
    const o = await this.open(token);
    if (o.attempt) return this.view(token); // second tab / refresh: the same attempt, the same clock
    if (!startAssessmentRequestSchema.safeParse(body).success) {
      throw engineError(HttpStatus.BAD_REQUEST, 'CONSENT_REQUIRED', 'Please read and accept the instructions and monitoring notice before starting.');
    }
    const now = this.now();
    const deadlineAt = o.round.timeLimitMinutes
      ? new Date(now.getTime() + o.round.timeLimitMinutes * 60_000)
      : o.invite.expiresAt; // no time limit: the link's validity is the limit
    const attempt = await this.begin(o, now, deadlineAt, ASSESSMENT_CONSENT_VERSION);
    return this.publicView({ ...o, attempt });
  }

  /** Creates the attempt once (the clock starts); a second call returns the same attempt. */
  private async begin(o: Opened, now: Date, deadlineAt: Date | null, consentVersion: string): Promise<AttemptRow> {
    // first candidate to start freezes the questions and pass rules (safe to call again)
    await this.rounds.lockForAttempts(o.ctx.tenantId, o.ctx.jobId, now);
    const attempt = await this.store.createAttempt({
      tenantId: o.ctx.tenantId,
      applicationId: o.ctx.applicationId,
      jobId: o.ctx.jobId,
      roundId: o.round.id,
      inviteId: o.invite.id,
      consentVersion,
      startedAt: now,
      deadlineAt,
    });
    if (attempt.startedAt.getTime() === now.getTime()) {
      await this.store.addEvents(o.ctx.tenantId, attempt.id, [{ type: 'ASSESSMENT_STARTED', severity: SEVERITY.ASSESSMENT_STARTED, occurredAt: now, detail: {} }]);
      await this.audit.record({
        tenantId: o.ctx.tenantId,
        actorUserId: null,
        action: 'assessment.started',
        subjectType: 'application',
        subjectId: o.ctx.applicationId,
        metadata: { roundId: o.round.id },
      });
    }
    return attempt;
  }

  // ---------------------------------------------------------------- coding rounds (DSA page, dsa module)

  setCodingScorer(scorer: CodingScorer): void {
    this.codingScorer = scorer;
  }

  /** The DSA page's token check: the link of a coding round, or null for any link that cannot be used. */
  async codingInvite(token: string): Promise<CodingInvite | null> {
    try {
      const o = await this.open(token, { allowFinished: true, coding: true });
      return { inviteId: o.invite.id, tenantId: o.ctx.tenantId, roundId: o.round.id, candidateName: o.ctx.candidateName, timeLimitMinutes: o.round.timeLimitMinutes };
    } catch (err) {
      if (err instanceof HttpException) return null;
      throw err;
    }
  }

  /** The DSA page started its clock: the round's attempt, with the DSA deadline (sweepOverdue grades it if abandoned). */
  async codingStarted(token: string, startedAt: Date, deadlineAt: Date): Promise<void> {
    const o = await this.open(token, { coding: true });
    if (!o.attempt) await this.begin(o, startedAt, deadlineAt, DSA_CONSENT_VERSION);
  }

  /** The DSA page ended the attempt (finish, time-out or integrity end): graded and moved on, once. */
  async codingFinished(token: string, reason: 'submitted' | 'time_expired' | 'disqualified'): Promise<void> {
    const o = await this.open(token, { allowFinished: true, coding: true });
    if (o.attempt) await this.finish(o.attempt, reason === 'time_expired' ? 'TIMED_OUT' : 'SUBMITTED');
  }

  /** The DSA score in the round's own pass-rule units: marks scaled to HR's total, solved problems to its question count. */
  private async codingResult(attempt: AttemptRow, round: SavedRound) {
    if (!this.codingScorer) throw new Error('coding score not available (dsa module not loaded)');
    const s = await this.codingScorer(attempt.inviteId);
    const fraction = s.maxScore > 0 ? Math.min(1, s.score / s.maxScore) : 0;
    return {
      // rounded down: scaling never lifts a student over the pass mark (1e-9 absorbs float noise on exact values)
      marks: Math.floor(fraction * round.totals.marks * 100 + 1e-9) / 100,
      correctCount: s.total > 0 ? Math.floor((s.solved / s.total) * round.questions.length) : 0,
      notes: s.summary,
    };
  }

  /** PUT /public/assessment/answers - autosave of ALL answers so far. A late (older) save never overwrites a newer one. */
  async save(token: string | undefined, body: unknown): Promise<SaveAssessmentAnswersResult> {
    const o = await this.open(token);
    const attempt = this.running(o);
    if (this.overdue(attempt)) {
      await this.finish(attempt, 'TIMED_OUT');
      throw engineError(HttpStatus.CONFLICT, 'TIME_UP', 'The time for this assessment is over. Your saved answers were submitted.');
    }
    const req = this.parse(saveAssessmentAnswersRequestSchema, body);
    const answers = this.clean(o.round, req.answers);
    const revision = await this.store.saveAnswers(attempt.id, req.revision, answers);
    if (revision === null) throw invalidLink();
    return { revision, serverNow: this.now().toISOString(), deadlineAt: attempt.deadlineAt?.toISOString() ?? null };
  }

  /** POST /public/assessment/submit - final answers; graded at once. Submitting again is harmless (same result). */
  async submit(token: string | undefined, body: unknown): Promise<AssessmentPublicView> {
    const o = await this.open(token, { allowFinished: true });
    const attempt = o.attempt;
    if (!attempt) throw engineError(HttpStatus.CONFLICT, 'ASSESSMENT_NOT_STARTED', 'Please start the assessment first.');
    if (attempt.status === 'IN_PROGRESS') {
      if (this.overdue(attempt)) {
        await this.finish(attempt, 'TIMED_OUT'); // too late: only what was saved in time counts
      } else {
        const req = this.parse(saveAssessmentAnswersRequestSchema, body);
        await this.finish(attempt, 'SUBMITTED', { revision: req.revision, answers: this.clean(o.round, req.answers) });
      }
    }
    return this.publicView({ ...o, attempt: await this.store.getAttempt(attempt.id) });
  }

  /** POST /public/assessment/events - what the browser noticed (camera, tab, full screen, connection). */
  async events(token: string | undefined, body: unknown): Promise<{ accepted: number }> {
    const o = await this.open(token, { allowFinished: true });
    const attempt = o.attempt;
    if (!attempt) throw engineError(HttpStatus.CONFLICT, 'ASSESSMENT_NOT_STARTED', 'Please start the assessment first.');
    const req = this.parse(proctorEventsRequestSchema, body);
    const now = this.now();
    // events may arrive a little after submitting (sent when the connection came back); later ones are ignored
    const until = (attempt.submittedAt ?? now).getTime() + 2 * 60_000;
    if (now.getTime() > until) return { accepted: 0 };
    const room = ASSESSMENT_LIMITS.eventsPerAttempt - (await this.store.countEvents(attempt.id));
    if (room <= 0) return { accepted: 0 };
    const earliest = attempt.startedAt.getTime() - 60_000;
    const events = req.events.slice(0, room).map((e) => {
      const at = Date.parse(e.occurredAt);
      // the browser's clock is only trusted inside the attempt's window
      const occurredAt = at >= earliest && at <= now.getTime() + 5_000 ? new Date(at) : now;
      return { type: e.type, severity: SEVERITY[e.type], occurredAt, detail: e.detail };
    });
    await this.store.addEvents(o.ctx.tenantId, attempt.id, events);
    return { accepted: events.length };
  }

  // ---------------------------------------------------------------- grading + next step

  /**
   * Ends an attempt (once), records its result through the assessments module and queues what follows. Safe to call
   * again for the same attempt: the attempt finishes once, the result is an upsert, the next step is claimed once.
   */
  async finish(attempt: AttemptRow, status: 'SUBMITTED' | 'TIMED_OUT', final?: { revision: number; answers: StoredAnswers }): Promise<void> {
    const at = this.now();
    // a timed-out attempt ends at its deadline, not when someone noticed
    const endedAt = status === 'TIMED_OUT' && attempt.deadlineAt && attempt.deadlineAt < at ? attempt.deadlineAt : at;
    if (await this.store.finishAttempt(attempt.id, status, endedAt, final)) {
      const type = status === 'SUBMITTED' ? 'ASSESSMENT_SUBMITTED' : 'ASSESSMENT_TIMED_OUT';
      await this.store.addEvents(attempt.tenantId, attempt.id, [{ type, severity: SEVERITY[type], occurredAt: endedAt, detail: {} }]);
      await this.audit.record({
        tenantId: attempt.tenantId,
        actorUserId: null,
        action: status === 'SUBMITTED' ? 'assessment.submitted' : 'assessment.timed_out',
        subjectType: 'application',
        subjectId: attempt.applicationId,
        metadata: { roundId: attempt.roundId },
      });
    }
    await this.progress(attempt.id);
  }

  /** Grades a finished attempt and queues the next step exactly once. Failures are logged; the worker retries later. */
  async progress(attemptId: string): Promise<void> {
    const attempt = await this.store.getAttempt(attemptId);
    if (!attempt || attempt.status === 'IN_PROGRESS' || attempt.progressedAt) return;
    try {
      const config = await this.rounds.forRoundEngine(attempt.tenantId, attempt.jobId);
      const round = config?.rounds.find((r) => r.id === attempt.roundId);
      if (!config || !round) throw new Error('round no longer exists');
      const graded = isCodingRound(round) ? await this.codingResult(attempt, round) : { answers: toRoundAnswers(round, attempt.answers) };
      const recorded = await this.assessments.record(attempt.tenantId, {
        applicationId: attempt.applicationId,
        roundId: round.id,
        ...graded,
        startedAt: attempt.startedAt.toISOString(),
        submittedAt: (attempt.submittedAt ?? this.now()).toISOString(),
      });
      await this.store.setSystemPassed(attempt.id, recorded.systemPassed);
      if (!(await this.store.claimProgress(attempt.id, this.now()))) return; // another process did it
      // the outcome HR sees (an HR override made before this point included)
      const step = nextStep(config.rounds, round, recorded.outcome === 'PASSED');
      try {
        if (step.kind === 'INVITE') await this.store.queueInvite(attempt.tenantId, attempt.applicationId, attempt.jobId, step.round.id);
        else await this.store.queueOutcomeEmail(attempt.tenantId, attempt.applicationId, round.id, step.email, step.nextRoundName);
      } catch (err) {
        await this.store.releaseProgress(attempt.id);
        throw err;
      }
      await this.audit.record({
        tenantId: attempt.tenantId,
        actorUserId: null,
        action: 'assessment.progressed',
        subjectType: 'application',
        subjectId: attempt.applicationId,
        metadata: { roundId: round.id, outcome: recorded.outcome, next: step.kind === 'INVITE' ? { invite: step.round.id } : { email: step.email } },
      });
    } catch (err) {
      const why = err instanceof HttpException ? ((err.getResponse() as { code?: string }).code ?? err.message) : err instanceof Error ? err.message : 'unknown';
      this.logger.warn(`assessment result not processed attempt=${attempt.id} (${why}) - retried later`);
    }
  }

  /** Invites a candidate whose AI screening is complete to the job's first round (when it is an online test). */
  async inviteToFirstRound(row: { tenantId: string; applicationId: string; jobId: string; roundId: string }): Promise<boolean> {
    const config = await this.rounds.forRoundEngine(row.tenantId, row.jobId);
    const first = config?.status === 'COMPLETE' ? [...config.rounds].sort((a, b) => a.position - b.position)[0] : undefined;
    if (!first || first.id !== row.roundId || !isOnlineRound(first)) return false;
    const queued = await this.store.queueInvite(row.tenantId, row.applicationId, row.jobId, first.id);
    if (queued) {
      await this.audit.record({
        tenantId: row.tenantId,
        actorUserId: null,
        action: 'assessment.invite_queued',
        subjectType: 'application',
        subjectId: row.applicationId,
        metadata: { roundId: first.id, after: 'ai_screening_completed' },
      });
    }
    return queued;
  }

  /** Invites a student who passed the round before a coding round (and got "HR will contact you") to that round. */
  async inviteToCodingRound(row: { tenantId: string; applicationId: string; jobId: string; roundId: string }): Promise<boolean> {
    const config = await this.rounds.forRoundEngine(row.tenantId, row.jobId);
    const round = config?.status === 'COMPLETE' ? config.rounds.find((r) => r.id === row.roundId) : undefined;
    if (!round || !isCodingRound(round)) return false;
    const queued = await this.store.queueInvite(row.tenantId, row.applicationId, row.jobId, round.id);
    if (queued) {
      await this.audit.record({
        tenantId: row.tenantId,
        actorUserId: null,
        action: 'assessment.invite_queued',
        subjectType: 'application',
        subjectId: row.applicationId,
        metadata: { roundId: round.id, after: 'previous_round_cleared' },
      });
    }
    return queued;
  }

  // ---------------------------------------------------------------- HR

  /** Every round of the student's job with what the round engine did: invite, attempt, proctoring, outcome email. */
  async forApplication(tenantId: string, applicationId: string): Promise<ApplicationRoundEngine> {
    const data = await this.store.forApplication(tenantId, applicationId);
    const ctx = data && (await this.store.context(tenantId, applicationId));
    if (!data || !ctx) throw engineError(HttpStatus.NOT_FOUND, 'APPLICATION_NOT_FOUND', 'Student not found.');
    const config = await this.rounds.forRoundEngine(tenantId, ctx.jobId);
    // coding rounds: "answered" = problems solved on the DSA page, out of its problems
    const solved = new Map<string, { answered: number; questionCount: number }>();
    for (const a of data.attempts) {
      const r = config?.rounds.find((x) => x.id === a.roundId);
      if (r && isCodingRound(r) && this.codingScorer) {
        const s = await this.codingScorer(a.inviteId);
        solved.set(a.id, { answered: s.solved, questionCount: s.total });
      }
    }
    return {
      applicationId,
      rounds: [...(config?.rounds ?? [])]
        .sort((a, b) => a.position - b.position)
        .map((r) => {
          const invite = data.invites.find((i) => i.roundId === r.id);
          const attempt = data.attempts.find((a) => a.roundId === r.id);
          const events = attempt ? data.events.filter((e) => e.attemptId === attempt.id) : [];
          const email = data.outcomeEmails.find((e) => e.roundId === r.id);
          return {
            roundId: r.id,
            online: isInvitedRound(r),
            invite: invite
              ? {
                  emailStatus: invite.emailStatus,
                  sentAt: invite.sentAt?.toISOString() ?? null,
                  expiresAt: invite.expiresAt?.toISOString() ?? null,
                  revoked: !!invite.revokedAt,
                  lastError: invite.emailStatus === 'SENT' ? null : invite.lastError,
                }
              : null,
            attempt: attempt
              ? {
                  status: attempt.status,
                  startedAt: attempt.startedAt.toISOString(),
                  deadlineAt: attempt.deadlineAt?.toISOString() ?? null,
                  submittedAt: attempt.submittedAt?.toISOString() ?? null,
                  timeTakenSeconds: attempt.submittedAt ? Math.round((attempt.submittedAt.getTime() - attempt.startedAt.getTime()) / 1000) : null,
                  answered: answeredCount(attempt.answers),
                  questionCount: r.questions.length,
                  ...solved.get(attempt.id),
                  warnings: events.filter((e) => e.severity === 'WARNING').length,
                }
              : null,
            events: events.map((e) => ({ type: e.type, severity: e.severity, occurredAt: e.occurredAt.toISOString(), detail: e.detail })),
            outcomeEmail: email ? { kind: email.kind, status: email.status, sentAt: email.sentAt?.toISOString() ?? null } : null,
          };
        }),
    };
  }

  /** HR withdraws a candidate's link (also stops an attempt in progress from saving). */
  async revoke(tenantId: string, applicationId: string, roundId: string, actor: Actor | null): Promise<ApplicationRoundEngine> {
    if (!(await this.store.revokeInvite(tenantId, applicationId, roundId, actor?.id ?? null, this.now()))) {
      throw engineError(HttpStatus.NOT_FOUND, 'INVITE_NOT_FOUND', 'This student has no active invitation to that round.');
    }
    await this.audit.record({ tenantId, actorUserId: actor?.id ?? null, action: 'assessment.invite_revoked', subjectType: 'application', subjectId: applicationId, metadata: { roundId } });
    return this.forApplication(tenantId, applicationId);
  }

  /** HR sends an invitation that failed again (a fresh link is made). */
  async resend(tenantId: string, applicationId: string, roundId: string, actor: Actor | null): Promise<ApplicationRoundEngine> {
    if (!(await this.store.requeueFailedInvite(tenantId, applicationId, roundId))) {
      throw engineError(HttpStatus.CONFLICT, 'INVITE_NOT_FAILED', 'Only an invitation whose email failed can be sent again.');
    }
    await this.audit.record({ tenantId, actorUserId: actor?.id ?? null, action: 'assessment.invite_resent', subjectType: 'application', subjectId: applicationId, metadata: { roundId } });
    return this.forApplication(tenantId, applicationId);
  }

  // ---------------------------------------------------------------- helpers

  /** Token -> invite -> application + round. Every public call goes through here. */
  private async open(token: string | undefined, opts: { allowFinished?: boolean; coding?: boolean } = {}): Promise<Opened> {
    if (!token || !TOKEN_SHAPE.test(token)) throw invalidLink();
    const invite = await this.store.findInviteByHash(hashAssessmentToken(token));
    if (!invite || invite.emailStatus === 'FAILED') throw invalidLink();
    if (invite.revokedAt) {
      throw engineError(HttpStatus.GONE, 'ASSESSMENT_LINK_REVOKED', 'This assessment link was withdrawn by the hiring team. Please contact them if you think this is a mistake.');
    }
    const ctx = await this.store.context(invite.tenantId, invite.applicationId);
    if (!ctx || ctx.jobId !== invite.jobId) throw invalidLink();
    const config = await this.rounds.forRoundEngine(invite.tenantId, invite.jobId);
    const round = config?.rounds.find((r) => r.id === invite.roundId);
    // a coding round's link works only on the DSA page, an MCQ round's only on the assessment page
    if (!config || !round || config.status !== 'COMPLETE' || !(opts.coding ? isCodingRound(round) : isOnlineRound(round))) {
      throw engineError(HttpStatus.CONFLICT, 'ASSESSMENT_UNAVAILABLE', 'This assessment is not available right now. Please contact the hiring team.');
    }
    const attempt = await this.store.attemptByInvite(invite.id);
    const finished = !!attempt && attempt.status !== 'IN_PROGRESS';
    if (finished && !opts.allowFinished) {
      throw engineError(HttpStatus.CONFLICT, 'ASSESSMENT_SUBMITTED', 'This assessment has already been submitted.');
    }
    // the link must be valid to start; a started attempt runs to its own deadline
    if (!attempt && (!invite.expiresAt || invite.expiresAt.getTime() <= this.now().getTime())) {
      throw engineError(HttpStatus.GONE, 'ASSESSMENT_LINK_EXPIRED', 'This assessment link has expired. Please contact the hiring team if you still want to take part.');
    }
    return { invite, ctx, config, round, attempt };
  }

  private running(o: Opened): AttemptRow {
    if (!o.attempt) throw engineError(HttpStatus.CONFLICT, 'ASSESSMENT_NOT_STARTED', 'Please start the assessment first.');
    return o.attempt;
  }

  private overdue(a: AttemptRow): boolean {
    return !!a.deadlineAt && this.now().getTime() > a.deadlineAt.getTime() + DEADLINE_GRACE_MS;
  }

  private parse<T>(schema: { safeParse: (v: unknown) => { success: true; data: T } | { success: false } }, body: unknown): T {
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw engineError(HttpStatus.BAD_REQUEST, 'INVALID_REQUEST', 'The request is invalid. Please reload the page.');
    return parsed.data;
  }

  private clean(round: SavedRound, answers: Parameters<typeof cleanAnswers>[1]): StoredAnswers {
    try {
      return cleanAnswers(round, answers);
    } catch (err) {
      if (err instanceof InvalidAnswersError) throw engineError(HttpStatus.UNPROCESSABLE_ENTITY, 'INVALID_ANSWERS', err.message);
      throw err;
    }
  }

  private publicView(o: Opened): AssessmentPublicView {
    const a = o.attempt;
    const running = a?.status === 'IN_PROGRESS';
    const questions = publicQuestions(o.round);
    return {
      status: a?.status ?? 'NOT_STARTED',
      candidateFirstName: o.ctx.candidateName.trim().split(/\s+/)[0]?.slice(0, 40) ?? '',
      companyName: o.ctx.companyName,
      jobTitle: o.ctx.jobTitle,
      roundName: o.round.name,
      instructions: o.round.description,
      timeLimitMinutes: o.round.timeLimitMinutes,
      questionCount: questions.length,
      totalMarks: o.round.totals.marks,
      linkExpiresAt: (o.invite.expiresAt ?? this.now()).toISOString(),
      consentVersion: ASSESSMENT_CONSENT_VERSION,
      cameraRequired: this.config.cameraRequired,
      serverNow: this.now().toISOString(),
      attempt: a
        ? {
            startedAt: a.startedAt.toISOString(),
            deadlineAt: a.deadlineAt?.toISOString() ?? null,
            submittedAt: a.submittedAt?.toISOString() ?? null,
            revision: a.revision,
            questions: running ? questions : [],
            answers: running ? Object.entries(a.answers).map(([questionId, v]) => ({ questionId, selected: v.selected, marked: v.marked })) : [],
          }
        : null,
    };
  }
}
