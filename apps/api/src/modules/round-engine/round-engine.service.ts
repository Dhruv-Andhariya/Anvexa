import { HttpException, HttpStatus, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  ASSESSMENT_CONSENT_VERSION,
  ASSESSMENT_LIMITS,
  AI_INTERVIEW_PROTECTION_LIMITS,
  assessmentIntegrityDecisionRequestSchema,
  assessmentViolationAckRequestSchema,
  assessmentViolationRequestSchema,
  countProtectionIncident,
  proctorEventsRequestSchema,
  saveAssessmentAnswersRequestSchema,
  ROUND_MODULE_OF,
  startAssessmentRequestSchema,
  type ApplicationRoundEngine,
  type AssessmentProtectionSettings,
  type AssessmentPublicView,
  type AssessmentViolationResult,
  type RoundModule,
  type RoundType,
  type SaveAssessmentAnswersResult,
  type SavedRound,
} from '@hireflow/contracts';
import { isFeatureOn } from '../../common/feature-flags';
import { AssessmentsService } from '../assessments';
import { AuditService } from '../audit';
import { RoundModules, RoundsConfigService, type RoundsForEngine } from '../rounds-config';
import type { Actor } from '../tenants';
import {
  CODING_CONSENT_VERSION,
  codingAnswered,
  codingMinutes,
  codingResultInput,
  emptyCodingState,
  type CodingFinishReason,
  type CodingState,
} from './coding-round';
import {
  acceptedInAssessment,
  assessmentProtectionFromEnv,
  assessmentProtectionState,
  assessmentTerminationReason,
  parseAssessmentProtection,
  qualifiesInAssessment,
} from './assessment-protection';
import { TOKEN_SHAPE, hashAssessmentToken } from './link';
import {
  DEADLINE_GRACE_MS,
  InvalidAnswersError,
  SEVERITY,
  answeredCount,
  cleanAnswers,
  nextStep,
  roundKind,
  type RoundKind,
  publicQuestions,
  type NextStep,
  toRoundAnswers,
  type StoredAnswers,
} from './online-test';
import { RoundEngineStore, type AttemptRow, type CandidateContext, type InviteRow } from './round-engine.store';

export const ROUND_ENGINE_CONFIG = Symbol('ROUND_ENGINE_CONFIG');
export const ROUND_ENGINE_CLOCK = Symbol('ROUND_ENGINE_CLOCK');

export interface RoundEngineConfig {
  /** The webcam must be on during a test (ASSESSMENT_REQUIRE_CAMERA, default on). Shown to candidates; recorded as events. */
  cameraRequired: boolean;
  /**
   * Protection of the online tests (warnings, termination after the limit, HR review). null / missing = off.
   * ASSESSMENT_PROTECTION, ASSESSMENT_MAX_WARNINGS, ASSESSMENT_TAB_MONITORING, ASSESSMENT_FULLSCREEN_REQUIRED, ASSESSMENT_FACE_POLICY.
   */
  protection?: AssessmentProtectionSettings | null;
  /** DSA / SQL coding rounds: the webcam must be on (DSA_PROCTORING and DSA_PROCTOR_CAMERA, both default on). Email wording only. */
  codingCameraRequired?: boolean;
}

const isOff = (v: string | undefined) => ['off', 'false', '0', 'no'].includes((v ?? '').trim().toLowerCase());

export const roundEngineConfigFromEnv = (env: NodeJS.ProcessEnv = process.env): RoundEngineConfig => {
  const cameraRequired = !['off', 'false', '0'].includes((env.ASSESSMENT_REQUIRE_CAMERA ?? '').trim().toLowerCase());
  return {
    cameraRequired,
    protection: assessmentProtectionFromEnv(env, cameraRequired),
    codingCameraRequired: !isOff(env.DSA_PROCTORING) && !isOff(env.DSA_PROCTOR_CAMERA),
  };
};

/** Same error body shape as the other modules: { statusCode, code, message, ...extra }. Never a token. */
export const engineError = (status: number, code: string, message: string, extra: Record<string, unknown> = {}) =>
  new HttpException({ statusCode: status, code, message, ...extra }, status);

const terminatedError = () =>
  engineError(HttpStatus.CONFLICT, 'ASSESSMENT_TERMINATED', 'Your assessment was ended because the maximum number of warnings was exceeded. Your answers so far are saved for the hiring team.');

const invalidLink = () => engineError(HttpStatus.NOT_FOUND, 'ASSESSMENT_LINK_INVALID', 'This assessment link is not valid. Please use the link from your latest email.');

/** What the dsa module needs to run one candidate's coding round (it never sees another candidate's data). */
export interface CodingRoundContext {
  tenantId: string;
  applicationId: string;
  jobId: string;
  /** The round with its questions (HR's marks and the DSA problem each question points to). */
  round: SavedRound;
  candidateName: string;
  minutes: number;
  linkExpiresAt: Date;
  attempt: AttemptRow | null;
}

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

  constructor(
    @Inject(RoundEngineStore) private readonly store: RoundEngineStore,
    @Inject(RoundsConfigService) private readonly rounds: RoundsConfigService,
    @Inject(AssessmentsService) private readonly assessments: AssessmentsService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ROUND_ENGINE_CONFIG) private readonly config: RoundEngineConfig,
    @Inject(ROUND_ENGINE_CLOCK) private readonly now: () => Date,
    /** Round modules (DSA, SQL, AI interview) that take students; none connected = HR runs those rounds. */
    @Optional() @Inject(RoundModules) private readonly modules: RoundModules = new RoundModules(),
  ) {}

  // ---------------------------------------------------------------- candidate (public, token)

  /** GET /public/assessment/session. A test whose time ran out is submitted here (with the saved answers). */
  async view(token: string | undefined): Promise<AssessmentPublicView> {
    let o = await this.open(token, { allowFinished: true });
    if (o.attempt?.status === 'IN_PROGRESS' && this.overdue(o.attempt)) {
      await this.finish(o.attempt, 'TIMED_OUT');
      o = { ...o, attempt: await this.store.getAttempt(o.attempt.id) };
    }
    return await this.publicView(o);
  }

  /** POST /public/assessment/start - consent given; starts the clock (or continues the attempt that already runs). */
  async start(token: string | undefined, body: unknown): Promise<AssessmentPublicView> {
    const o = await this.open(token);
    if (o.attempt) return this.view(token); // second tab / refresh: the same attempt, the same clock
    if (!startAssessmentRequestSchema.safeParse(body).success) {
      throw engineError(HttpStatus.BAD_REQUEST, 'CONSENT_REQUIRED', 'Please read and accept the instructions and monitoring notice before starting.');
    }
    const now = this.now();
    // first candidate to start freezes the questions and pass rules (safe to call again)
    await this.rounds.lockForAttempts(o.ctx.tenantId, o.ctx.jobId, now);
    const deadlineAt = o.round.timeLimitMinutes
      ? new Date(now.getTime() + o.round.timeLimitMinutes * 60_000)
      : o.invite.expiresAt; // no time limit: the link's validity is the limit
    const attempt = await this.store.createAttempt({
      tenantId: o.ctx.tenantId,
      applicationId: o.ctx.applicationId,
      jobId: o.ctx.jobId,
      roundId: o.round.id,
      inviteId: o.invite.id,
      consentVersion: ASSESSMENT_CONSENT_VERSION,
      startedAt: now,
      deadlineAt,
      // the rules shown on the landing page are copied onto the attempt: later env changes never change a running test
      protection: this.config.protection ?? null,
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
    return await this.publicView({ ...o, attempt });
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
    return await this.publicView({ ...o, attempt: await this.store.getAttempt(attempt.id) });
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

  // ---------------------------------------------------------------- protection (one warning counter per attempt)

  /**
   * POST /public/assessment/violation - one incident the page saw (tab hidden, focus lost, full screen left, more than
   * one face). Decided under the attempt's row lock with the rules shared with the AI interview; the page never sends a
   * count. Going over the limit ends the test with the saved answers and holds the result for HR's review.
   */
  async violation(token: string | undefined, body: unknown): Promise<AssessmentViolationResult> {
    const req = this.parse(assessmentViolationRequestSchema, body);
    const o = await this.open(token, { allowFinished: true });
    const attempt = o.attempt;
    const settings = parseAssessmentProtection(attempt?.protection ?? null);
    if (!attempt || !settings) {
      return { outcome: 'IGNORED', warningNumber: null, warningCount: attempt?.warningCount ?? 0, maxWarnings: settings?.maxWarnings ?? 0, status: attempt?.status ?? 'NOT_STARTED' };
    }
    const now = this.now();
    const result = await this.store.recordIncident(
      attempt.id,
      { incidentId: req.incidentId, type: req.type, detail: req.detail?.slice(0, 200) ?? null, now, maxRows: AI_INTERVIEW_PROTECTION_LIMITS.maxEventsPerSession },
      (locked, prior) => {
        const s = parseAssessmentProtection(locked.protection);
        if (!s || !acceptedInAssessment(locked.status, req.type, s) || this.overdue(locked)) return null;
        const d = countProtectionIncident({ qualifies: qualifiesInAssessment(req.type, s), warningCount: locked.warningCount, maxWarnings: s.maxWarnings, prior, now });
        return { ...d, terminationReason: d.terminate ? assessmentTerminationReason(req.type, s.maxWarnings) : null };
      },
    );
    const a = result.attempt;
    const base = { warningCount: a.warningCount, maxWarnings: settings.maxWarnings, status: a.status };
    if (result.kind === 'replay') return { ...base, outcome: result.row.outcome, warningNumber: result.row.warningNumber };
    if (result.kind === 'ignored') return { ...base, outcome: 'IGNORED', warningNumber: null };
    const d = result.decision;
    const audit = { tenantId: a.tenantId, actorUserId: null, subjectType: 'application', subjectId: a.applicationId } as const;
    if (d.outcome === 'WARNING') {
      await this.audit.record({ ...audit, action: 'assessment.protection_warning', metadata: { roundId: a.roundId, type: req.type, warningNumber: d.warningNumber, maxWarnings: settings.maxWarnings } });
    }
    if (d.terminate) {
      await this.audit.record({ ...audit, action: 'assessment.terminated', metadata: { roundId: a.roundId, type: req.type, warnings: settings.maxWarnings, integrityStatus: 'INTEGRITY_VIOLATION_REVIEW' } });
      // graded now so HR sees the score; progress() holds the next step until HR decided
      void this.progress(a.id).catch(() => undefined);
    }
    return { ...base, outcome: d.outcome, warningNumber: d.warningNumber };
  }

  /** POST /public/assessment/violation/ack - the candidate read warning N (not shown again after a reload). */
  async acknowledge(token: string | undefined, body: unknown): Promise<{ acknowledged: boolean }> {
    const req = this.parse(assessmentViolationAckRequestSchema, body);
    const o = await this.open(token, { allowFinished: true });
    if (!o.attempt) return { acknowledged: false };
    return { acknowledged: await this.store.acknowledgeIncident(o.attempt.id, req.warningNumber, this.now()) };
  }

  /**
   * POST /round-engine/applications/:applicationId/rounds/:roundId/integrity-decision - HR reviewed a test that the
   * warning limit ended. ADVANCE / REJECT with a reason (stored as HR's override when it differs from the score), then
   * the usual next step follows once (next invite or outcome email). Never automatic.
   */
  async integrityDecision(tenantId: string, applicationId: string, roundId: string, body: unknown, actor: Actor | null): Promise<ApplicationRoundEngine> {
    const parsed = assessmentIntegrityDecisionRequestSchema.safeParse(body);
    if (!parsed.success) throw engineError(HttpStatus.BAD_REQUEST, 'REASON_REQUIRED', parsed.error.issues[0]?.message ?? 'Invalid decision.');
    const data = await this.store.forApplication(tenantId, applicationId);
    let attempt = data?.attempts.find((a) => a.roundId === roundId);
    if (!attempt) throw engineError(HttpStatus.NOT_FOUND, 'ATTEMPT_NOT_FOUND', 'This student has no attempt in that round.');
    if (attempt.status !== 'TERMINATED' || attempt.integrityStatus !== 'INTEGRITY_VIOLATION_REVIEW') {
      throw engineError(HttpStatus.CONFLICT, 'NOT_IN_REVIEW', 'This test is not waiting for an integrity review.');
    }
    if (attempt.systemPassed === null) {
      // grading after the termination did not run yet: do it now (it holds, it does not progress)
      await this.progress(attempt.id);
      attempt = (await this.store.getAttempt(attempt.id))!;
      if (attempt.systemPassed === null) throw engineError(HttpStatus.SERVICE_UNAVAILABLE, 'RESULT_NOT_READY', 'The result is still being calculated. Please try again in a minute.');
    }
    const { decision, reason } = parsed.data;
    if (!(await this.store.decideIntegrity(tenantId, attempt.id, { decision, reason, by: actor?.name ?? null }, this.now()))) {
      throw engineError(HttpStatus.CONFLICT, 'ALREADY_DECIDED', 'A decision was already made for this test.');
    }
    const passed = decision === 'ADVANCE';
    // HR's decision goes on the result as an override when it differs from the score (reason + audit, like the Assessments page)
    if (passed !== attempt.systemPassed) await this.assessments.override(tenantId, applicationId, roundId, { passed, reason }, actor);
    await this.audit.record({
      tenantId,
      actorUserId: actor?.id ?? null,
      action: 'assessment.integrity_decided',
      subjectType: 'application',
      subjectId: applicationId,
      metadata: { roundId, decision, systemPassed: attempt.systemPassed },
    });
    await this.progress(attempt.id);
    return this.forApplication(tenantId, applicationId);
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
      // a coding attempt is told apart by its state, not by the DSA_ROUNDS switch: it is graded as one even if coding rounds were switched off meanwhile
      const result = attempt.codingState ? codingResultInput(round, attempt.codingState) : { answers: toRoundAnswers(round, attempt.answers) };
      const recorded = await this.assessments.record(attempt.tenantId, {
        applicationId: attempt.applicationId,
        roundId: round.id,
        ...result,
        startedAt: attempt.startedAt.toISOString(),
        submittedAt: (attempt.submittedAt ?? this.now()).toISOString(),
      });
      await this.store.setSystemPassed(attempt.id, recorded.systemPassed);
      // ended by the warning limit: graded (HR sees the score), but nothing moves on until HR decided
      if (attempt.integrityStatus === 'INTEGRITY_VIOLATION_REVIEW') return;
      if (!(await this.store.claimProgress(attempt.id, this.now()))) return; // another process did it
      // the outcome HR sees (an HR override made before this point included)
      // a GD round next: no email here - the group-discussion module adds the student to its pool and invites them
      const step = this.next(config.rounds, round, recorded.outcome === 'PASSED');
      try {
        if (step.kind === 'INVITE') await this.store.queueInvite(attempt.tenantId, attempt.applicationId, attempt.jobId, step.round.id);
        else if (step.kind === 'EMAIL') await this.store.queueOutcomeEmail(attempt.tenantId, attempt.applicationId, round.id, step.email, step.nextRoundName);
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
        metadata: {
          roundId: round.id,
          outcome: recorded.outcome,
          next: describeStep(step),
        },
      });
    } catch (err) {
      const why = err instanceof HttpException ? ((err.getResponse() as { code?: string }).code ?? err.message) : err instanceof Error ? err.message : 'unknown';
      this.logger.warn(`assessment result not processed attempt=${attempt.id} (${why}) - retried later`);
    }
  }

  /** What follows a round: the next online test, the GD pool, a connected round module, or an email. */
  private next(rounds: SavedRound[], round: SavedRound, passed: boolean): NextStep {
    return nextStep(rounds, round, passed, { groupDiscussion: isFeatureOn('group_discussion'), modules: this.modules.connected() });
  }

  // ---------------------------------------------------------------- round modules (DSA, SQL, AI interview)

  /**
   * Students a round module should run its round for: every earlier round passed (HR override first), or AI screening
   * completed when it is the first round, and no result in this round yet. Rounds that are plain online tests are the
   * round engine's own. The module keeps track of whom it already invited.
   */
  waitingForModule(module: RoundModule, opts: { tenantId?: string; limit?: number } = {}) {
    // DSA rounds are invited and run by this engine itself (roundKind CODING), never handed to a module
    if (module === 'DSA') return Promise.resolve([]);
    const types = (Object.entries(ROUND_MODULE_OF) as [RoundType, RoundModule][]).filter(([, m]) => m === module).map(([t]) => t);
    return this.store.moduleCandidates(types, Math.min(Math.max(opts.limit ?? 100, 1), 500), opts.tenantId);
  }

  /**
   * A round module records a student's result and answers (same shape as assessments.record()). It shows on the HR
   * Assessments page, and the student moves on exactly as after an online test (next invitation or email). Sending the
   * same result again is safe: the result is replaced and the next step is queued once.
   * `hrDecision` (AI interview): HR decided pass / fail after reading the result. When it differs from the score-based
   * result it is saved as HR's override (reason + audit, like on the Assessments page), and the next step follows it.
   */
  async recordModuleResult(tenantId: string, module: RoundModule, input: unknown, hrDecision?: { passed: boolean; reason: string; actor: Actor | null }) {
    const ids = input as { applicationId?: unknown; roundId?: unknown } | null;
    const applicationId = typeof ids?.applicationId === 'string' ? ids.applicationId : '';
    const roundId = typeof ids?.roundId === 'string' ? ids.roundId : '';
    const ctx = applicationId ? await this.store.context(tenantId, applicationId) : null;
    const config = ctx ? await this.rounds.forRoundEngine(tenantId, ctx.jobId) : null;
    const round = config?.rounds.find((r) => r.id === roundId);
    if (!ctx || !config || !round) throw engineError(HttpStatus.NOT_FOUND, 'ROUND_NOT_FOUND', 'This round was not found for this student.');
    if (ROUND_MODULE_OF[round.type] !== module || module === 'DSA' || roundKind(round)) {
      throw engineError(HttpStatus.CONFLICT, 'ROUND_NOT_FOR_MODULE', `This round is not run by the ${module} module.`);
    }
    let recorded = await this.assessments.record(tenantId, input);
    if (hrDecision && hrDecision.passed !== (recorded.outcome === 'PASSED')) {
      await this.assessments.override(tenantId, applicationId, round.id, { passed: hrDecision.passed, reason: hrDecision.reason }, hrDecision.actor);
      recorded = { ...recorded, outcome: hrDecision.passed ? 'PASSED' : 'FAILED' };
    }
    const step = this.next(config.rounds, round, recorded.outcome === 'PASSED');
    if (step.kind === 'INVITE') await this.store.queueInvite(tenantId, applicationId, ctx.jobId, step.round.id);
    else if (step.kind === 'EMAIL') await this.store.queueOutcomeEmail(tenantId, applicationId, round.id, step.email, step.nextRoundName);
    await this.audit.record({
      tenantId,
      actorUserId: null,
      action: 'assessment.progressed',
      subjectType: 'application',
      subjectId: applicationId,
      metadata: { roundId: round.id, module, outcome: recorded.outcome, next: describeStep(step) },
    });
    return recorded;
  }

  /** Invites a candidate whose AI screening is complete to the job's first round (when it is an online test). */
  async inviteToFirstRound(row: { tenantId: string; applicationId: string; jobId: string; roundId: string }): Promise<boolean> {
    const config = await this.rounds.forRoundEngine(row.tenantId, row.jobId);
    const first = config?.status === 'COMPLETE' ? [...config.rounds].sort((a, b) => a.position - b.position)[0] : undefined;
    if (!first || first.id !== row.roundId || !roundKind(first)) return false;
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

  // ---------------------------------------------------------------- DSA coding rounds (used by the dsa module, in-process)

  /**
   * Link token -> the candidate's coding round. The same checks as the MCQ tests (link known, not withdrawn, not
   * expired before the start); throws the same error bodies. Finished attempts are returned too (the page shows the end).
   */
  async openCodingRound(token: string | undefined): Promise<CodingRoundContext> {
    const o = await this.open(token, { allowFinished: true, kind: 'CODING' });
    return {
      tenantId: o.ctx.tenantId,
      applicationId: o.ctx.applicationId,
      jobId: o.ctx.jobId,
      round: o.round,
      candidateName: o.ctx.candidateName,
      minutes: codingMinutes(o.round),
      linkExpiresAt: o.invite.expiresAt ?? this.now(),
      attempt: o.attempt,
    };
  }

  /** The candidate pressed Start (consent was recorded on the coding page): the attempt and its clock begin, once. */
  async startCodingAttempt(token: string | undefined, startedAt: Date): Promise<AttemptRow> {
    const o = await this.open(token, { kind: 'CODING', allowFinished: true });
    if (o.attempt) return o.attempt; // second tab / refresh: the same attempt, the same clock
    const now = this.now();
    // the clock of the coding page is only trusted inside a small window around ours
    const at = Math.abs(startedAt.getTime() - now.getTime()) <= 60_000 ? startedAt : now;
    await this.rounds.lockForAttempts(o.ctx.tenantId, o.ctx.jobId, now);
    const attempt = await this.store.createAttempt({
      tenantId: o.ctx.tenantId,
      applicationId: o.ctx.applicationId,
      jobId: o.ctx.jobId,
      roundId: o.round.id,
      inviteId: o.invite.id,
      consentVersion: CODING_CONSENT_VERSION,
      startedAt: at,
      deadlineAt: new Date(at.getTime() + codingMinutes(o.round) * 60_000),
      codingState: emptyCodingState(),
    });
    if (attempt.startedAt.getTime() === at.getTime()) {
      await this.store.addEvents(o.ctx.tenantId, attempt.id, [{ type: 'ASSESSMENT_STARTED', severity: SEVERITY.ASSESSMENT_STARTED, occurredAt: at, detail: {} }]);
      await this.audit.record({ tenantId: o.ctx.tenantId, actorUserId: null, action: 'assessment.started', subjectType: 'application', subjectId: o.ctx.applicationId, metadata: { roundId: o.round.id, kind: 'CODING' } });
    }
    return attempt;
  }

  /** Stores the candidate's progress (best score per problem) while the attempt runs. false = it is not running. */
  async saveCodingProgress(token: string | undefined, state: CodingState): Promise<boolean> {
    const o = await this.open(token, { kind: 'CODING', allowFinished: true });
    if (!o.attempt || o.attempt.status !== 'IN_PROGRESS') return false;
    return this.store.saveCodingState(o.attempt.id, state);
  }

  /**
   * Ends the coding attempt (once) and, through finish() and progress(), records the result and queues the next step:
   * the next round's invitation, or the cleared / rejection email. Safe to repeat: nothing happens twice.
   */
  async finishCodingAttempt(token: string | undefined, reason: CodingFinishReason, state: CodingState): Promise<void> {
    const o = await this.open(token, { kind: 'CODING', allowFinished: true });
    const attempt = o.attempt;
    if (!attempt) throw engineError(HttpStatus.CONFLICT, 'ASSESSMENT_NOT_STARTED', 'Please start the assessment first.');
    if (attempt.status === 'IN_PROGRESS') {
      await this.store.saveCodingState(attempt.id, { ...state, finishReason: reason });
      await this.finish(attempt, reason === 'time_expired' ? 'TIMED_OUT' : 'SUBMITTED');
    } else if (!attempt.progressedAt) {
      await this.progress(attempt.id); // finished earlier but the next step did not run yet
    }
  }

  // ---------------------------------------------------------------- HR

  /** Every round of the student's job with what the round engine did: invite, attempt, proctoring, outcome email. */
  async forApplication(tenantId: string, applicationId: string): Promise<ApplicationRoundEngine> {
    const data = await this.store.forApplication(tenantId, applicationId);
    const ctx = data && (await this.store.context(tenantId, applicationId));
    if (!data || !ctx) throw engineError(HttpStatus.NOT_FOUND, 'APPLICATION_NOT_FOUND', 'Student not found.');
    const config = await this.rounds.forRoundEngine(tenantId, ctx.jobId);
    return {
      applicationId,
      rounds: [...(config?.rounds ?? [])]
        .sort((a, b) => a.position - b.position)
        .map((r) => {
          const invite = data.invites.find((i) => i.roundId === r.id);
          const attempt = data.attempts.find((a) => a.roundId === r.id);
          const events = attempt ? data.events.filter((e) => e.attemptId === attempt.id) : [];
          const incidents = attempt ? data.incidents.filter((i) => i.attemptId === attempt.id) : [];
          const settings = attempt ? parseAssessmentProtection(attempt.protection) : null;
          const email = data.outcomeEmails.find((e) => e.roundId === r.id);
          return {
            roundId: r.id,
            online: roundKind(r) !== null,
            kind: roundKind(r),
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
                  answered: attempt.codingState ? codingAnswered(r, attempt.codingState) : answeredCount(attempt.answers),
                  questionCount: r.questions.length,
                  warnings: events.filter((e) => e.severity === 'WARNING').length,
                }
              : null,
            events: events.map((e) => ({ type: e.type, severity: e.severity, occurredAt: e.occurredAt.toISOString(), detail: e.detail })),
            integrity:
              attempt && settings
                ? {
                    status: attempt.integrityStatus,
                    settings,
                    warningCount: attempt.warningCount,
                    terminatedAt: attempt.terminatedAt?.toISOString() ?? null,
                    terminationReason: attempt.terminationReason,
                    decision:
                      attempt.integrityDecision && attempt.integrityDecidedAt
                        ? { decision: attempt.integrityDecision, reason: attempt.integrityReason ?? '', by: attempt.integrityDecidedBy, at: attempt.integrityDecidedAt.toISOString() }
                        : null,
                    incidents: incidents.map((i) => ({
                      type: i.type,
                      outcome: i.outcome,
                      warningNumber: i.warningNumber,
                      at: i.occurredAt.toISOString(),
                      detail: i.detail,
                      acknowledgedAt: i.acknowledgedAt?.toISOString() ?? null,
                    })),
                  }
                : null,
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
  private async open(token: string | undefined, opts: { allowFinished?: boolean; kind?: RoundKind } = {}): Promise<Opened> {
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
    if (!config || !round || config.status !== 'COMPLETE' || roundKind(round) !== (opts.kind ?? 'TEST')) {
      throw engineError(HttpStatus.CONFLICT, 'ASSESSMENT_UNAVAILABLE', 'This assessment is not available right now. Please contact the hiring team.');
    }
    const attempt = await this.store.attemptByInvite(invite.id);
    const finished = !!attempt && attempt.status !== 'IN_PROGRESS';
    if (finished && !opts.allowFinished) {
      if (attempt.status === 'TERMINATED') throw terminatedError();
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

  private async publicView(o: Opened): Promise<AssessmentPublicView> {
    const a = o.attempt;
    // before the start: the rules that will apply (shown in the notice); afterwards: the attempt's own copy and count
    const protection = a
      ? assessmentProtectionState(parseAssessmentProtection(a.protection), a.warningCount, await this.store.incidents(a.id))
      : assessmentProtectionState(this.config.protection ?? null, 0, []);
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
      protection,
    };
  }
}

const describeStep = (step: NextStep) =>
  step.kind === 'INVITE'
    ? { invite: step.round.id }
    : step.kind === 'GROUP_DISCUSSION'
      ? { groupDiscussion: step.round.id }
      : step.kind === 'MODULE'
        ? { module: step.module, round: step.round.id }
        : { email: step.email };
