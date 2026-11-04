import { HttpException, HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import {
  AI_INTERVIEW_CONSENT_VERSION,
  AI_INTERVIEW_ENDED_STATUSES,
  AI_INTERVIEW_LIMITS,
  DEFAULT_AI_INTERVIEW_PROTECTION,
  aiInterviewEventsRequestSchema,
  aiInterviewPauseRequestSchema,
  aiInterviewResumeRequestSchema,
  aiInterviewStartRequestSchema,
  type AiInterviewAnswerResult,
  type AiInterviewPublicSession,
  type AiInterviewProtectionSettings,
  type AiInterviewQuestion,
} from '@hireflow/contracts';
import { isFeatureOn } from '../../common/feature-flags';
import { AuditService } from '../audit';
import { RoundsConfigService } from '../rounds-config';
import { InterviewWorkerClient, InterviewWorkerError, type InterviewResumeFacts } from './ai-interview-worker.client';
import { AiInterviewStore, type InterviewContext, type InviteRow, type SessionRow, type TurnRow, type ViolationRow } from './ai-interview.store';
import {
  FINAL_SECONDS,
  clockOf,
  closingWords,
  configFromRound,
  fallbackPlan,
  greeting,
  linkHrQuestions,
  nextQuestion,
  parseConfig,
  parsePlan,
  vocabulary,
  type Clock,
  type InterviewConfig,
  type ResumeFacts,
  type StoredPlan,
} from './flow';
import { SpeechCache } from '../screening';
import { TOKEN_SHAPE, hashInterviewToken } from './link';
import { parseProtection, protectionState } from './protection';

export const AI_INTERVIEW_CLOCK = Symbol('AI_INTERVIEW_CLOCK');

/** Accepted recordings (MediaRecorder output of current desktop + mobile browsers). Codec parameters are allowed. */
export const AUDIO_TYPES = ['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/x-m4a', 'audio/m4a', 'audio/aac', 'audio/mpeg', 'audio/wav', 'audio/x-wav'];
export const AUDIO_LIMITS = { maxBytes: 8 * 1024 * 1024, minBytes: 1_000 };

export interface AnswerInput {
  seq: number;
  clientTurnId: string;
  durationMs: number | null;
  audio: { bytes: Buffer; mimeType: string } | undefined;
}

const CLIENT_TURN_ID = /^[A-Za-z0-9_-]{8,64}$/;

/** Same error body shape as the other modules: { statusCode, code, message, ...extra }. Never a token. */
export const interviewError = (status: number, code: string, message: string, extra: Record<string, unknown> = {}) =>
  new HttpException({ statusCode: status, code, message, ...extra }, status);

export const terminatedError = () =>
  interviewError(HttpStatus.CONFLICT, 'INTERVIEW_TERMINATED', 'Your interview was ended because the maximum number of warnings was exceeded. Your activity has been recorded for the hiring team.');

export const isEnded = (status: string) => (AI_INTERVIEW_ENDED_STATUSES as readonly string[]).includes(status);

const invalidLink = () => interviewError(HttpStatus.NOT_FOUND, 'INTERVIEW_LINK_INVALID', 'This interview link is not valid. Please use the link from your latest email.');

export interface Opened {
  invite: InviteRow;
  ctx: InterviewContext;
  session: SessionRow;
  config: InterviewConfig;
}

/**
 * The candidate side of the AI technical interview. The link token from the email is the ONLY credential: it is looked
 * up by its SHA-256 and gives access to exactly one application's one interview round. The server owns the questions,
 * the clock and the transcript; nothing a request carries can point at another application, job or company.
 */
@Injectable()
export class AiInterviewService {
  private readonly logger = new Logger('AiInterview');
  /** Plans being made right now, per session (the start and the first answer share one AI call). */
  private readonly planning = new Map<string, Promise<StoredPlan>>();

  constructor(
    @Inject(AiInterviewStore) private readonly store: AiInterviewStore,
    @Inject(InterviewWorkerClient) private readonly worker: InterviewWorkerClient,
    @Inject(SpeechCache) private readonly speechCache: SpeechCache,
    @Inject(RoundsConfigService) private readonly rounds: RoundsConfigService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(AI_INTERVIEW_CLOCK) private readonly now: () => Date,
  ) {}

  /** GET /public/interview/session - what the page shows (creates the session on the first visit). */
  async view(token: string | undefined): Promise<AiInterviewPublicSession> {
    let o = await this.open(token, { allowEnded: true });
    o = await this.sweepTime(o);
    const [turns, violations] = await Promise.all([this.store.turns(o.session.id), this.store.violations(o.session.id)]);
    return this.publicView(o, turns, violations);
  }

  /** POST /public/interview/start - consent + both devices on. Starts the clock once; a second tab joins the same. */
  async start(token: string | undefined, body: unknown): Promise<AiInterviewPublicSession> {
    const o = await this.open(token);
    if (o.session.status === 'NOT_STARTED') {
      const parsed = aiInterviewStartRequestSchema.safeParse(body);
      if (!parsed.success) throw interviewError(HttpStatus.BAD_REQUEST, 'SETUP_REQUIRED', parsed.error.issues[0]?.message ?? 'Please complete the setup first.');
      const now = this.now();
      await this.rounds.lockForAttempts(o.ctx.tenantId, o.ctx.jobId, now);
      await this.store.start(o.session, o.ctx, now);
      await this.audit.record({ tenantId: o.ctx.tenantId, actorUserId: null, action: 'ai_interview.started', subjectType: 'application', subjectId: o.ctx.applicationId, metadata: { roundId: o.invite.roundId } });
      // the plan is made while the greeting plays and the candidate replies
      void this.ensurePlan(o.session.id, o.ctx, o.config).catch(() => undefined);
    } else if (o.session.status === 'PAUSED') {
      return this.resume(token, body);
    }
    return this.view(token);
  }

  /** POST /public/interview/resume - after a device / connection problem: both devices are back. */
  async resume(token: string | undefined, body: unknown): Promise<AiInterviewPublicSession> {
    const o = await this.open(token);
    const parsed = aiInterviewResumeRequestSchema.safeParse(body);
    if (!parsed.success) throw interviewError(HttpStatus.BAD_REQUEST, 'DEVICES_REQUIRED', parsed.error.issues[0]?.message ?? 'Turn on your camera and microphone to continue.');
    const now = this.now();
    if (o.session.status === 'PAUSED' && (await this.store.resume(o.session.id, now))) {
      await this.store.addEvents(o.ctx.tenantId, o.session.id, [{ type: 'RESUMED', occurredAt: now, detail: null }]);
      // both devices are back: a camera / microphone incident is over (a later loss is a new incident)
      await this.store.resolveDeviceIncidents(o.session.id, now);
    }
    return this.view(token);
  }

  /** POST /public/interview/pause - the page lost a device or the connection, or is being closed. */
  async pause(token: string | undefined, body: unknown): Promise<AiInterviewPublicSession> {
    const o = await this.open(token, { allowEnded: true });
    const parsed = aiInterviewPauseRequestSchema.safeParse(body);
    if (!parsed.success) throw interviewError(HttpStatus.BAD_REQUEST, 'INVALID_REQUEST', 'Invalid pause reason.');
    const now = this.now();
    if (o.session.status === 'IN_PROGRESS' && (await this.store.pause(o.session.id, parsed.data.reason, now))) {
      await this.store.addEvents(o.ctx.tenantId, o.session.id, [{ type: 'PAUSED', occurredAt: now, detail: parsed.data.reason }]);
    }
    return this.view(token);
  }

  /** POST /public/interview/events - device / connection facts for HR's review (never scored). */
  async events(token: string | undefined, body: unknown): Promise<{ saved: number }> {
    const o = await this.open(token, { allowEnded: true });
    const parsed = aiInterviewEventsRequestSchema.safeParse(body);
    if (!parsed.success) throw interviewError(HttpStatus.BAD_REQUEST, 'INVALID_EVENTS', 'Invalid events.');
    if (o.session.status === 'NOT_STARTED') return { saved: 0 };
    const now = this.now();
    const events = parsed.data.events.map((e) => {
      const at = new Date(e.occurredAt);
      // the page's clock is only trusted inside a small window around ours
      return { type: e.type, occurredAt: Math.abs(at.getTime() - now.getTime()) <= 5 * 60_000 ? at : now, detail: e.detail?.slice(0, 200) ?? null };
    });
    await this.store.addEvents(o.ctx.tenantId, o.session.id, events);
    await this.store.touch(o.session.id, now);
    return { saved: events.length };
  }

  /** POST /public/interview/repeat - the candidate wants to hear the current question again (limited per question). */
  async repeat(token: string | undefined): Promise<{ repeatsLeft: number }> {
    const o = await this.open(token);
    if (o.session.status !== 'IN_PROGRESS') throw interviewError(HttpStatus.CONFLICT, 'INTERVIEW_NOT_RUNNING', 'The interview is not running.');
    if (!(await this.store.countRepeat(o.session.id, o.session.pendingSeq, AI_INTERVIEW_LIMITS.repeatsPerQuestion))) {
      throw interviewError(HttpStatus.CONFLICT, 'NO_REPEATS_LEFT', 'This question cannot be repeated again. You can read it on the screen.');
    }
    await this.store.addEvents(o.ctx.tenantId, o.session.id, [{ type: 'QUESTION_REPEATED', occurredAt: this.now(), detail: `question ${o.session.pendingSeq}` }]);
    return { repeatsLeft: Math.max(0, AI_INTERVIEW_LIMITS.repeatsPerQuestion - o.session.pendingRepeats - 1) };
  }

  /** POST /public/interview/end - the candidate stops. Saved answers are kept and go to HR. Safe to send twice. */
  async end(token: string | undefined): Promise<AiInterviewPublicSession> {
    const o = await this.open(token, { allowEnded: true });
    if (o.session.status === 'IN_PROGRESS' || o.session.status === 'PAUSED') {
      const now = this.now();
      const clock = clockOf(o.session, o.config, now);
      // ended before the minimum time: incomplete (HR sees it as such); later it counts as a finished interview
      const status = clock.elapsedSeconds >= o.config.minMinutes * 60 ? 'COMPLETED' : 'INCOMPLETE';
      if (await this.store.finish(o.session.id, status, 'CANDIDATE_ENDED', this.closing(o), now)) {
        await this.audit.record({ tenantId: o.ctx.tenantId, actorUserId: null, action: 'ai_interview.ended_by_candidate', subjectType: 'application', subjectId: o.ctx.applicationId, metadata: { roundId: o.invite.roundId, status } });
        void this.generateReport(o.session.id).catch(() => undefined);
      }
    }
    return this.view(token);
  }

  /** POST /public/interview/answer - one spoken answer. Saved as soon as it is understood; never saved twice. */
  async answer(token: string | undefined, input: AnswerInput): Promise<AiInterviewAnswerResult> {
    const o = await this.open(token, { allowEnded: true });
    const { session, ctx, config } = o;
    if (!CLIENT_TURN_ID.test(input.clientTurnId)) throw interviewError(HttpStatus.BAD_REQUEST, 'INVALID_REQUEST', 'Invalid answer id.');
    const turns = await this.store.turns(session.id);

    // the same upload again (double click, network retry): answer with what was saved the first time
    const duplicate = turns.find((t) => t.clientTurnId === input.clientTurnId);
    if (duplicate) return this.answered(session, config, duplicate.rawTranscript, turns.length);
    // terminated by the warning limit: no answer is accepted any more (the saved ones are kept)
    if (session.status === 'TERMINATED') throw terminatedError();
    if (session.status === 'COMPLETED' || session.status === 'INCOMPLETE') {
      throw interviewError(HttpStatus.CONFLICT, 'INTERVIEW_ENDED', 'This interview has already ended.', { current: questionOf(session) });
    }
    if (session.status === 'PAUSED') throw interviewError(HttpStatus.CONFLICT, 'INTERVIEW_PAUSED', 'The interview is paused. Turn your camera and microphone back on to continue.');
    if (session.status !== 'IN_PROGRESS') throw interviewError(HttpStatus.CONFLICT, 'INTERVIEW_NOT_STARTED', 'Please start the interview first.');
    if (input.seq !== session.pendingSeq) {
      throw interviewError(HttpStatus.CONFLICT, 'OUT_OF_SYNC', 'This question was already answered. Continuing where you left off.', { current: questionOf(session) });
    }
    const audio = checkedAudio(input.audio);

    const started = this.now();
    const before = clockOf(session, config, started);
    if (before.pastGrace) {
      // the time ran out long ago (the page was asleep): nothing more is accepted
      const swept = await this.sweepTime(o);
      return this.answered(swept.session, config, null, turns.length);
    }

    const plan = await this.ensurePlan(session.id, ctx, config);
    const decide = session.pendingKind !== 'INTRO' && before.phase !== 'OVER';
    let heard;
    try {
      heard = await this.worker.turn({
        audio,
        vocabulary: vocabulary(resumeFacts(ctx.resume), ctx.job.skills),
        question: { text: session.pendingText, kind: session.pendingKind, topicId: session.pendingTopicId },
        decide,
        followUpAllowed: session.followUpsOnTopic < AI_INTERVIEW_LIMITS.followUpsPerTopic,
        timing: {
          elapsedSeconds: before.elapsedSeconds,
          remainingSeconds: before.remainingSeconds,
          durationMinutes: config.durationMinutes,
          phase: before.phase === 'OVER' ? 'FINAL' : before.phase,
        },
        plan: plan.topics,
        coveredTopicIds: session.coveredTopics,
        history: turns.map((t) => ({ seq: t.seq, question: t.question, answer: t.rawTranscript, topicId: t.topicId })),
        job: ctx.job,
        resume: ctx.resume ?? emptyResume(),
      });
    } catch (err) {
      throw workerFailure(err);
    }

    if (!heard.audible) {
      const clock = clockOf(session, config, this.now());
      return {
        outcome: 'RETRY',
        message: "Sorry, I couldn't hear an answer. Please check your microphone and answer again.",
        transcript: null,
        done: false,
        next: questionOf(session),
        elapsedSeconds: clock.elapsedSeconds,
        remainingSeconds: clock.remainingSeconds,
        questionsAnswered: answeredCount(turns),
      };
    }

    const now = this.now();
    const clock = clockOf(session, config, now);
    const askedAt = session.pendingAskedAt ?? session.startedAt ?? now;
    const next = nextQuestion({
      current: {
        kind: session.pendingKind,
        source: session.pendingSource,
        text: session.pendingText,
        topicId: session.pendingTopicId,
        topic: session.pendingTopic,
        resumeRef: session.pendingResumeRef,
      },
      seq: session.pendingSeq,
      followUpsOnTopic: session.followUpsOnTopic,
      coveredTopics: session.coveredTopics,
      plan: plan.topics,
      decision: heard.decision,
      clock,
      answeredInFinal: clockOf(session, config, askedAt).remainingSeconds <= FINAL_SECONDS,
      answeredTurns: turns.length + 1,
      askedQuestions: [...turns.map((t) => t.question), session.pendingText],
      closing: this.closing(o),
    });
    const saved = await this.store.saveTurn(
      session.id,
      session.pendingSeq,
      {
        seq: session.pendingSeq,
        kind: session.pendingKind,
        source: session.pendingSource,
        topicId: session.pendingTopicId,
        topic: session.pendingTopic,
        resumeRef: session.pendingResumeRef,
        question: session.pendingText,
        rawTranscript: heard.transcript,
        normalizedTranscript: heard.normalizedTranscript || heard.transcript,
        transcriptQuality: heard.quality,
        unclearTerms: heard.unclearTerms,
        reading: heard.decision?.reading ?? (session.pendingKind === 'INTRO' ? 'READY' : null),
        askedAt,
        answeredAt: now,
        answerSeconds: input.durationMs ? Math.round(input.durationMs / 100) / 10 : null,
        clientTurnId: input.clientTurnId,
        model: heard.model,
        promptVersion: heard.promptVersion,
      },
      { ...next, endedReason: next.endedReason },
      now,
    );
    const fresh = (await this.store.session(session.id))!;
    // terminated while this answer was being transcribed: it is not saved
    if (saved === 'stale' && fresh.status === 'TERMINATED') throw terminatedError();
    if (saved === 'stale') {
      // a parallel request saved this question first: report what is stored now
      const stored = (await this.store.turns(session.id)).find((t) => t.seq === session.pendingSeq || t.clientTurnId === input.clientTurnId);
      if (stored) return this.answered(fresh, config, stored.rawTranscript, turns.length + 1);
      throw interviewError(HttpStatus.CONFLICT, 'OUT_OF_SYNC', 'This question was already answered. Continuing where you left off.', { current: questionOf(fresh) });
    }

    if (next.done) {
      await this.audit.record({ tenantId: ctx.tenantId, actorUserId: null, action: 'ai_interview.completed', subjectType: 'application', subjectId: ctx.applicationId, metadata: { roundId: session.roundId, reason: next.endedReason } });
      void this.generateReport(session.id).catch(() => undefined); // in the background: the candidate does not wait for HR's report
    }
    // the next question is spoken as soon as the page asks for it: start making the audio now
    void this.speechCache.get(next.pending.text, () => this.worker.speak(next.pending.text)).catch(() => undefined);
    return this.answered(fresh, config, heard.transcript, turns.length + 1);
  }

  /** GET /public/interview/speech?seq= - the current question (or an earlier one) as WAV. */
  async speech(token: string | undefined, seq: number): Promise<Buffer> {
    const o = await this.open(token, { allowEnded: true });
    let text: string | undefined;
    if (seq === o.session.pendingSeq) text = o.session.pendingText;
    else text = (await this.store.turns(o.session.id)).find((t) => t.seq === seq)?.question;
    if (!text) throw interviewError(HttpStatus.NOT_FOUND, 'QUESTION_NOT_FOUND', 'This question does not exist.');
    try {
      return await this.speechCache.get(text, () => this.worker.speak(text));
    } catch (err) {
      throw workerFailure(err, 'The question could not be played. You can read it on the screen.');
    }
  }

  // ---------------------------------------------------------------- the plan and the report (also used by the worker loop)

  /** The session's plan; made once (AI, or by rule when the AI planner is not available). */
  async ensurePlan(sessionId: string, ctx: InterviewContext, config: InterviewConfig): Promise<StoredPlan> {
    const existing = parsePlan((await this.store.session(sessionId))?.plan);
    if (existing) return existing;
    const running = this.planning.get(sessionId);
    if (running) return running;
    const job = (async (): Promise<StoredPlan> => {
      let plan: StoredPlan;
      try {
        const out = await this.worker.plan({
          candidateFirstName: firstName(ctx.candidateName),
          durationMinutes: config.durationMinutes,
          job: ctx.job,
          resume: ctx.resume ?? emptyResume(),
          hrQuestions: config.hrQuestions.map((q) => ({ text: q.text, topics: q.topics, expectedAnswer: null })),
        });
        const topics = linkHrQuestions(out.topics.map((t) => ({ ...t, hrQuestionId: null })), config.hrQuestions);
        plan = topics.length ? { topics, ai: true, model: out.model, promptVersion: out.promptVersion } : this.rulePlan(ctx, config);
      } catch (err) {
        this.logger.warn(`interview plan by rule (${err instanceof InterviewWorkerError ? err.code : 'unknown'})`);
        plan = this.rulePlan(ctx, config);
      }
      await this.store.savePlan(sessionId, plan);
      return parsePlan((await this.store.session(sessionId))?.plan) ?? plan;
    })().finally(() => this.planning.delete(sessionId));
    this.planning.set(sessionId, job);
    return job;
  }

  /**
   * The evidence-based report for HR. Runs in the background after the interview (and from the worker loop for
   * retries). Failures are stored on the report (HR sees "report failed" + retry); the transcript is never touched.
   */
  async generateReport(sessionId: string): Promise<void> {
    const session = await this.store.session(sessionId);
    // a terminated interview gets a report too (from the answers saved before it ended): HR reviews everything
    if (!session || !isEnded(session.status)) return;
    try {
      if (!(await this.store.beginReport(session, this.now()))) return;
      const ctx = await this.store.context(session.tenantId, session.applicationId);
      const turns = (await this.store.turns(session.id)).filter((t) => t.kind !== 'CLOSING');
      if (!ctx || !turns.some((t) => t.kind !== 'INTRO')) {
        await this.store.failReport(session.id, 'No technical answers to evaluate.');
        return;
      }
      const config = parseConfig(session.config);
      const out = await this.worker.report({
        job: ctx.job,
        resume: ctx.resume ?? emptyResume(),
        hrQuestions: config.hrQuestions.map((q) => ({ text: q.text, topics: q.topics, expectedAnswer: q.expectedAnswer })),
        turns: turns.map((t) => ({ seq: t.seq, kind: t.kind, source: t.source, topic: t.topic, question: t.question, answer: t.rawTranscript, quality: t.transcriptQuality })),
        durationMinutes: config.durationMinutes,
        usedSeconds: Math.min(clockOf(session, config, session.completedAt ?? this.now()).elapsedSeconds, config.durationMinutes * 60),
        // the worker knows finished and unfinished interviews; a terminated one is unfinished
        status: session.status === 'COMPLETED' ? 'COMPLETED' : 'INCOMPLETE',
      });
      await this.store.finishReport(session.id, out, this.now());
      await this.audit.record({ tenantId: session.tenantId, actorUserId: null, action: 'ai_interview.report_ready', subjectType: 'application', subjectId: session.applicationId, metadata: { roundId: session.roundId, recommendation: out.report.recommendation } });
    } catch (err) {
      const message = err instanceof InterviewWorkerError ? err.message : 'The report could not be created.';
      this.logger.warn(`interview report failed (${err instanceof InterviewWorkerError ? err.code : 'unknown'})`);
      await this.store.failReport(session.id, message).catch(() => undefined);
    }
  }

  /** The interview time ran out with no answer coming (page closed / asleep): it ends with what was saved. */
  async sweepTime<T extends { session: SessionRow; config: InterviewConfig; ctx: InterviewContext }>(o: T, slackSeconds = 0): Promise<T> {
    const s = o.session;
    if (s.status !== 'IN_PROGRESS' && s.status !== 'PAUSED') return o;
    const now = this.now();
    if (!clockOf(s, o.config, new Date(now.getTime() - slackSeconds * 1000)).pastGrace) return o;
    const answered = answeredCount(await this.store.turns(s.id));
    // ran to the end with answers = a finished interview; nothing answered = incomplete
    const status = answered > 0 && s.status === 'IN_PROGRESS' ? 'COMPLETED' : 'INCOMPLETE';
    if (await this.store.finish(s.id, status, status === 'COMPLETED' ? 'TIME_UP' : 'ABANDONED', this.closing(o), now)) {
      await this.audit.record({ tenantId: s.tenantId, actorUserId: null, action: 'ai_interview.timed_out', subjectType: 'application', subjectId: s.applicationId, metadata: { roundId: s.roundId, status } });
      void this.generateReport(s.id).catch(() => undefined);
    }
    return { ...o, session: (await this.store.session(s.id))! };
  }

  /** Context of a stored session (the worker loop's time-out sweep). */
  async openSession(session: SessionRow) {
    const ctx = await this.store.context(session.tenantId, session.applicationId);
    if (!ctx) return null;
    return { session, ctx, config: parseConfig(session.config) };
  }

  // ---------------------------------------------------------------- helpers

  /** Token -> invite -> application -> session. Every public call goes through here (also the protection service). */
  async open(token: string | undefined, opts: { allowEnded?: boolean } = {}): Promise<Opened> {
    if (!token || !TOKEN_SHAPE.test(token)) throw invalidLink();
    const invite = await this.store.findInviteByHash(hashInterviewToken(token));
    if (!invite) throw invalidLink();
    const ctx = await this.store.context(invite.tenantId, invite.applicationId);
    if (!ctx) throw invalidLink();
    const existing = await this.store.sessionByInvite(invite.id);
    const ended = !!existing && isEnded(existing.status);
    const expired = !invite.expiresAt || invite.expiresAt.getTime() <= this.now().getTime();
    // a started interview may finish after the link date; a link never opened before it expired may not start
    if (expired && !existing?.startedAt && !(opts.allowEnded && ended)) {
      throw interviewError(HttpStatus.GONE, 'INTERVIEW_LINK_EXPIRED', 'This interview link has expired. Please contact the HR team if you still want to take part.');
    }
    if (ended && !opts.allowEnded) {
      if (existing!.status === 'TERMINATED') throw terminatedError();
      throw interviewError(HttpStatus.CONFLICT, 'INTERVIEW_ENDED', 'This interview has already ended.');
    }
    let session = existing;
    if (!session) {
      const rounds = await this.rounds.forRoundEngine(ctx.tenantId, ctx.jobId);
      const round = rounds?.rounds.find((r) => r.id === invite.roundId && r.type === 'AI_INTERVIEW');
      if (!round) throw invalidLink();
      const config = configFromRound(round, true);
      // the protection rules are copied with the config: the candidate is shown exactly the rules that are enforced
      const protection = await this.protectionFor(ctx.tenantId, invite.roundId);
      session = await this.store.ensureSession(invite, config, greeting(firstName(ctx.candidateName), ctx.jobTitle, ctx.companyName, config.durationMinutes), protection);
    }
    return { invite, ctx, session, config: parseConfig(session.config) };
  }

  /** HR's rules for the round (or the defaults); null when protection is switched off (FEATURE_AI_INTERVIEW_PROTECTION=off). */
  private async protectionFor(tenantId: string, roundId: string): Promise<AiInterviewProtectionSettings | null> {
    if (!isFeatureOn('ai_interview_protection')) return null;
    return (await this.store.protectionSettings(tenantId, roundId))?.settings ?? { ...DEFAULT_AI_INTERVIEW_PROTECTION };
  }

  private rulePlan(ctx: InterviewContext, config: InterviewConfig): StoredPlan {
    return { topics: fallbackPlan(config, resumeFacts(ctx.resume), ctx.job.skills), ai: false, model: null, promptVersion: null };
  }

  private closing(o: { ctx: InterviewContext }): string {
    return closingWords(firstName(o.ctx.candidateName), o.ctx.companyName);
  }

  private publicView(o: Opened, turns: TurnRow[], violations: ViolationRow[]): AiInterviewPublicSession {
    const { session, ctx, config, invite } = o;
    const clock: Clock = clockOf(session, config, session.completedAt ?? this.now());
    return {
      status: session.status,
      roundName: config.roundName,
      jobTitle: ctx.jobTitle,
      companyName: ctx.companyName,
      candidateFirstName: firstName(ctx.candidateName),
      expiresAt: (invite.expiresAt ?? this.now()).toISOString(),
      consentVersion: AI_INTERVIEW_CONSENT_VERSION,
      consentGiven: session.consentGivenAt !== null,
      cameraRequired: config.cameraRequired,
      durationMinutes: config.durationMinutes,
      elapsedSeconds: clock.elapsedSeconds,
      remainingSeconds: isEnded(session.status) ? 0 : clock.remainingSeconds,
      pauseSecondsLeft: clock.pauseSecondsLeft,
      questionsAnswered: answeredCount(turns),
      repeatsLeft: Math.max(0, AI_INTERVIEW_LIMITS.repeatsPerQuestion - session.pendingRepeats),
      current: session.status === 'NOT_STARTED' ? null : questionOf(session),
      transcript: turns.map((t) => ({ seq: t.seq, question: t.question, answer: t.rawTranscript })),
      protection: protectionState(parseProtection(session.protection), session.warningCount, violations),
    };
  }

  private answered(session: SessionRow, config: InterviewConfig, transcript: string | null, turnCount: number): AiInterviewAnswerResult {
    const clock = clockOf(session, config, session.completedAt ?? this.now());
    const done = isEnded(session.status);
    return {
      outcome: 'ANSWERED',
      message: null,
      transcript,
      done,
      next: questionOf(session),
      elapsedSeconds: clock.elapsedSeconds,
      remainingSeconds: done ? 0 : clock.remainingSeconds,
      questionsAnswered: Math.max(0, turnCount - 1),
    };
  }
}

function questionOf(session: SessionRow): AiInterviewQuestion {
  return { seq: session.pendingSeq, kind: session.pendingKind, text: session.pendingText };
}

/** Technical answers (the greeting reply does not count). */
const answeredCount = (turns: TurnRow[]) => turns.filter((t) => t.kind !== 'INTRO').length;

function checkedAudio(audio: AnswerInput['audio']): { bytes: Buffer; mimeType: string } {
  if (!audio || audio.bytes.length < AUDIO_LIMITS.minBytes) {
    throw interviewError(HttpStatus.BAD_REQUEST, 'AUDIO_EMPTY', 'The recording is empty. Please answer again.');
  }
  if (audio.bytes.length > AUDIO_LIMITS.maxBytes) {
    throw interviewError(HttpStatus.PAYLOAD_TOO_LARGE, 'AUDIO_TOO_LARGE', 'The answer is too long. Please keep each answer under about four minutes.');
  }
  const base = audio.mimeType.split(';', 1)[0]!.trim().toLowerCase();
  if (!AUDIO_TYPES.includes(base)) throw interviewError(HttpStatus.UNSUPPORTED_MEDIA_TYPE, 'AUDIO_FORMAT', 'This browser recorded audio in a format we cannot read.');
  return { bytes: audio.bytes, mimeType: audio.mimeType };
}

function workerFailure(err: unknown, message?: string) {
  if (err instanceof InterviewWorkerError) {
    const status = err.code === 'AUDIO_UNREADABLE' ? HttpStatus.UNPROCESSABLE_ENTITY : err.retryAfterSeconds ? HttpStatus.TOO_MANY_REQUESTS : HttpStatus.SERVICE_UNAVAILABLE;
    return interviewError(status, err.code === 'AUDIO_UNREADABLE' ? 'AUDIO_UNREADABLE' : 'AI_UNAVAILABLE', message ?? err.message, {
      retryable: err.retryable,
      ...(err.retryAfterSeconds ? { retryAfterSeconds: err.retryAfterSeconds } : {}),
    });
  }
  return err;
}

export function firstName(name: string): string {
  return (name.trim().split(/\s+/)[0] ?? '').slice(0, 40);
}

const emptyResume = (): InterviewResumeFacts => ({ summary: '', skills: [], projects: [], experience: [], education: [], certifications: [], achievements: [] });

function resumeFacts(r: InterviewResumeFacts | null): ResumeFacts | null {
  return r ? { skills: r.skills, projects: r.projects.map((p) => ({ title: p.title, technologies: p.technologies })), experience: r.experience.map((e) => ({ organization: e.organization, role: e.role })) } : null;
}
