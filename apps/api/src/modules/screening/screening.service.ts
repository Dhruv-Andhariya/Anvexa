import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import {
  AI_SCREENING_CONSENT_VERSION,
  aiScreeningStartRequestSchema,
  type AiScreeningAnswerResult,
  type AiScreeningPublicSession,
  type AiScreeningQuestion,
} from '@hireflow/contracts';
import { AuditService } from '../audit';
import { hashScreeningToken } from './link';
import { screeningError } from './screening.errors';
import {
  ESTIMATED_MINUTES,
  TOTAL_STEPS,
  followUpAllowed,
  mainQuestion,
  nextQuestion,
  type FlowLimits,
  type QuestionContext,
} from './flow';
import { ScreeningStore, type ScreeningContext, type SessionRow, type TurnRow } from './screening.store';
import { ScreeningWorkerClient, ScreeningWorkerError, type ScreeningJobFacts } from './screening-worker.client';
import { SpeechCache } from './speech-cache';

export const SCREENING_FLOW_LIMITS = Symbol('SCREENING_FLOW_LIMITS');
export const SCREENING_CLOCK = Symbol('SCREENING_CLOCK');

/** Accepted recordings (MediaRecorder output of current desktop + mobile browsers). Codec parameters are allowed. */
export const AUDIO_TYPES = ['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/x-m4a', 'audio/m4a', 'audio/aac', 'audio/mpeg', 'audio/wav', 'audio/x-wav'];
export const AUDIO_LIMITS = { maxBytes: 6 * 1024 * 1024, minBytes: 1_000 };

export interface AnswerInput {
  seq: number;
  clientTurnId: string;
  durationMs: number | null;
  audio: { bytes: Buffer; mimeType: string } | undefined;
}

/** A shape check only (43 chars base64url = 32 random bytes); the real check is the hash lookup. */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{32,128}$/;
const CLIENT_TURN_ID = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * The candidate side of the AI screening round. The link token from the shortlist email is the ONLY credential: it
 * is looked up by its SHA-256 (screening_invites), must not be expired, and gives access to exactly one application's
 * screening. Nothing in a request can point at another application.
 */
@Injectable()
export class ScreeningService {
  private readonly logger = new Logger('Screening');

  constructor(
    @Inject(ScreeningStore) private readonly store: ScreeningStore,
    @Inject(ScreeningWorkerClient) private readonly worker: ScreeningWorkerClient,
    @Inject(SpeechCache) private readonly speechCache: SpeechCache,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(SCREENING_FLOW_LIMITS) private readonly limits: FlowLimits,
    @Inject(SCREENING_CLOCK) private readonly now: () => Date,
  ) {}

  /** GET /public/screening/session - what the screening page shows (creates the session on the first visit). */
  async view(token: string | undefined): Promise<AiScreeningPublicSession> {
    const { ctx, session, expiresAt } = await this.open(token, { allowCompletedAfterExpiry: true });
    return this.publicView(ctx, session, expiresAt, await this.store.turns(session.id));
  }

  /** POST /public/screening/start - consent given; starts, or resumes a screening the candidate ended early. */
  async start(token: string | undefined, body: unknown): Promise<AiScreeningPublicSession> {
    const parsed = aiScreeningStartRequestSchema.safeParse(body);
    const { ctx, session, expiresAt } = await this.open(token);
    if (session.status === 'NOT_STARTED' && !parsed.success) {
      throw screeningError(HttpStatus.BAD_REQUEST, 'CONSENT_REQUIRED', 'Please read and accept the consent before starting.');
    }
    let current = session;
    if (session.status === 'NOT_STARTED' || session.status === 'ENDED_EARLY') {
      current = await this.store.start(session, ctx, this.now());
      if (session.status === 'NOT_STARTED') {
        await this.audit.record({ tenantId: ctx.tenantId, actorUserId: null, action: 'screening.started', subjectType: 'application', subjectId: ctx.applicationId });
      }
    }
    return this.publicView(ctx, current, expiresAt, await this.store.turns(current.id));
  }

  /** POST /public/screening/answer - one spoken answer. Saved as soon as it is understood; never saved twice. */
  async answer(token: string | undefined, input: AnswerInput): Promise<AiScreeningAnswerResult> {
    const { ctx, session } = await this.open(token);
    if (!CLIENT_TURN_ID.test(input.clientTurnId)) throw screeningError(HttpStatus.BAD_REQUEST, 'INVALID_REQUEST', 'Invalid answer id.');
    const turns = await this.store.turns(session.id);

    // The same upload again (double click, network retry): answer with what was saved the first time.
    const duplicate = turns.find((t) => t.clientTurnId === input.clientTurnId);
    if (duplicate) return this.answered(session, duplicate);
    if (session.status === 'COMPLETED') throw screeningError(HttpStatus.CONFLICT, 'SCREENING_COMPLETED', 'This screening is already complete.');
    if (session.status !== 'IN_PROGRESS') throw screeningError(HttpStatus.CONFLICT, 'SCREENING_NOT_STARTED', 'Please start the screening first.');
    if (input.seq !== session.pendingSeq) {
      throw screeningError(HttpStatus.CONFLICT, 'OUT_OF_SYNC', 'This question was already answered. Continuing where you left off.', {
        current: question(session),
      });
    }
    const audio = checkedAudio(input.audio);

    const now = this.now();
    const state = {
      step: session.pendingStep,
      followUpsInStep: session.followUpsInStep,
      candidateQuestions: session.candidateQuestions,
      stepsDone: session.stepsDone,
      answeredTurns: turns.length + 1,
      startedAt: session.startedAt ?? now,
      now,
    };
    let understood;
    try {
      understood = await this.worker.turn({
        step: session.pendingStep,
        kind: session.pendingKind,
        question: session.pendingText,
        audio,
        history: turns.map((t) => ({ step: t.step, question: t.question, answer: t.answer })),
        job: jobFacts(ctx),
        followUpAllowed: followUpAllowed(state, this.limits),
      });
    } catch (err) {
      throw workerFailure(err);
    }

    if (!understood.audible) {
      return {
        outcome: 'RETRY',
        message: "Sorry, I couldn't hear an answer. Please check your microphone and answer again.",
        transcript: null,
        aiReply: null,
        done: false,
        next: question(session),
        stepsDone: session.stepsDone,
        totalSteps: TOTAL_STEPS,
      };
    }

    const flow = nextQuestion(state, understood, questionContext(ctx), this.limits);
    const saved = await this.store.saveTurn(
      session.id,
      session.pendingSeq,
      {
        seq: session.pendingSeq,
        step: session.pendingStep,
        kind: session.pendingKind,
        question: session.pendingText,
        answer: understood.transcript,
        aiReply: session.pendingStep === 'CANDIDATE_QUESTIONS' && understood.candidateAskedQuestion ? understood.reply : null,
        clientTurnId: input.clientTurnId,
        answerSeconds: input.durationMs ? Math.round(input.durationMs / 100) / 10 : null,
        model: understood.model,
        promptVersion: understood.promptVersion,
      },
      { ...flow.next, seq: session.pendingSeq + 1, followUpsInStep: flow.followUpsInStep, candidateQuestions: flow.candidateQuestions, stepsDone: flow.stepsDone, done: flow.done },
      now,
    );
    const fresh = (await this.store.session(ctx.applicationId))!;
    if (saved === 'stale') {
      // a parallel request saved this question first: report what is stored now
      const stored = (await this.store.turns(session.id)).find((t) => t.seq === session.pendingSeq || t.clientTurnId === input.clientTurnId);
      if (stored) return this.answered(fresh, stored);
      throw screeningError(HttpStatus.CONFLICT, 'OUT_OF_SYNC', 'This question was already answered. Continuing where you left off.', { current: question(fresh) });
    }

    if (flow.done) {
      await this.store.markInviteUsed(ctx.applicationId, now);
      await this.audit.record({ tenantId: ctx.tenantId, actorUserId: null, action: 'screening.completed', subjectType: 'application', subjectId: ctx.applicationId });
      void this.extract(fresh, ctx); // in the background: the candidate does not wait for HR's summary
    }
    return {
      outcome: 'ANSWERED',
      message: null,
      transcript: understood.transcript,
      aiReply: session.pendingStep === 'CANDIDATE_QUESTIONS' ? understood.reply : null,
      done: flow.done,
      next: question(fresh),
      stepsDone: fresh.stepsDone,
      totalSteps: TOTAL_STEPS,
    };
  }

  /** GET /public/screening/speech?seq= - the current question (or an earlier one, to hear it again) as WAV. */
  async speech(token: string | undefined, seq: number): Promise<Buffer> {
    const { session } = await this.open(token, { allowCompletedAfterExpiry: true });
    let text: string | undefined;
    if (seq === session.pendingSeq) text = session.pendingText;
    else text = (await this.store.turns(session.id)).find((t) => t.seq === seq)?.question;
    if (!text) throw screeningError(HttpStatus.NOT_FOUND, 'QUESTION_NOT_FOUND', 'This question does not exist.');
    try {
      return await this.speechCache.get(text, () => this.worker.speak(text));
    } catch (err) {
      throw workerFailure(err, 'The question could not be played. You can read it on the screen.');
    }
  }

  /** POST /public/screening/end - the candidate stops early. Saved answers stay; they can resume while the link works. */
  async end(token: string | undefined): Promise<AiScreeningPublicSession> {
    const { ctx, session, expiresAt } = await this.open(token);
    if (session.status === 'IN_PROGRESS') {
      await this.store.endEarly(session.id, this.now());
      await this.audit.record({ tenantId: ctx.tenantId, actorUserId: null, action: 'screening.ended_early', subjectType: 'application', subjectId: ctx.applicationId });
    }
    const fresh = (await this.store.session(ctx.applicationId))!;
    const turns = await this.store.turns(fresh.id);
    if (session.status === 'IN_PROGRESS' && turns.length) void this.extract(fresh, ctx); // partial notes for HR
    return this.publicView(ctx, fresh, expiresAt, turns);
  }

  /**
   * The structured summary for HR. Runs in the background after completion (and on HR's retry). Failures are stored
   * on the result (HR sees "summary failed" + retry); the transcript itself is never touched.
   */
  async extract(session: SessionRow, ctx?: ScreeningContext): Promise<void> {
    try {
      if (!(await this.store.beginResult(session, this.now()))) return;
      const context = ctx ?? (await this.store.context(session.applicationId));
      const turns = await this.store.turns(session.id);
      if (!context || !turns.length) {
        await this.store.failResult(session.id, 'Nothing to summarise yet.');
        return;
      }
      const out = await this.worker.extract(
        jobFacts(context),
        turns.map((t) => ({ seq: t.seq, step: t.step, kind: t.kind, question: t.question, answer: t.answer, aiReply: t.aiReply })),
      );
      await this.store.finishResult(session.id, out);
    } catch (err) {
      const message = err instanceof ScreeningWorkerError ? err.message : 'The summary could not be created.';
      this.logger.warn(`screening summary failed (${err instanceof ScreeningWorkerError ? err.code : 'unknown'})`);
      await this.store.failResult(session.id, message).catch(() => undefined);
    }
  }

  // ---------------------------------------------------------------- helpers

  /** Token -> invite -> application -> session. Every public call goes through here. */
  private async open(token: string | undefined, opts: { allowCompletedAfterExpiry?: boolean } = {}) {
    if (!token || !TOKEN_SHAPE.test(token)) throw invalidLink();
    const invite = await this.store.findInvite(hashScreeningToken(token));
    if (!invite) throw invalidLink();
    const ctx = await this.store.context(invite.applicationId);
    if (!ctx || ctx.tenantId !== invite.tenantId) throw invalidLink();
    const expired = invite.expiresAt.getTime() <= this.now().getTime();
    const existing = await this.store.session(invite.applicationId);
    if (expired && !(opts.allowCompletedAfterExpiry && existing?.status === 'COMPLETED')) {
      throw screeningError(HttpStatus.GONE, 'SCREENING_LINK_EXPIRED', 'This screening link has expired. Please contact the HR team if you still want to take part.');
    }
    const session = existing ?? (await this.store.ensureSession(ctx, mainQuestion('INTRO', questionContext(ctx))));
    return { ctx, session, expiresAt: invite.expiresAt };
  }

  private publicView(ctx: ScreeningContext, session: SessionRow, expiresAt: Date, turns: TurnRow[]): AiScreeningPublicSession {
    return {
      status: session.status,
      jobTitle: ctx.jobTitle,
      companyName: ctx.companyName,
      candidateFirstName: firstName(ctx.candidateName),
      expiresAt: expiresAt.toISOString(),
      consentVersion: AI_SCREENING_CONSENT_VERSION,
      consentGiven: session.consentGivenAt !== null,
      estimatedMinutes: ESTIMATED_MINUTES,
      stepsDone: session.stepsDone,
      totalSteps: TOTAL_STEPS,
      current: session.status === 'NOT_STARTED' ? null : question(session),
      transcript: turns.map((t) => ({ seq: t.seq, step: t.step, question: t.question, answer: t.answer, aiReply: t.aiReply })),
    };
  }

  private answered(session: SessionRow, turn: TurnRow): AiScreeningAnswerResult {
    return {
      outcome: 'ANSWERED',
      message: null,
      transcript: turn.answer,
      aiReply: turn.aiReply,
      done: session.status === 'COMPLETED',
      next: question(session),
      stepsDone: session.stepsDone,
      totalSteps: TOTAL_STEPS,
    };
  }
}

function question(session: SessionRow): AiScreeningQuestion {
  return { seq: session.pendingSeq, step: session.pendingStep, kind: session.pendingKind, text: session.pendingText };
}

function checkedAudio(audio: AnswerInput['audio']): { bytes: Buffer; mimeType: string } {
  if (!audio || audio.bytes.length < AUDIO_LIMITS.minBytes) {
    throw screeningError(HttpStatus.BAD_REQUEST, 'AUDIO_EMPTY', 'The recording is empty. Please answer again.');
  }
  if (audio.bytes.length > AUDIO_LIMITS.maxBytes) {
    throw screeningError(HttpStatus.PAYLOAD_TOO_LARGE, 'AUDIO_TOO_LARGE', 'The answer is too long. Please keep each answer under about three minutes.');
  }
  const base = audio.mimeType.split(';', 1)[0]!.trim().toLowerCase();
  if (!AUDIO_TYPES.includes(base)) throw screeningError(HttpStatus.UNSUPPORTED_MEDIA_TYPE, 'AUDIO_FORMAT', 'This browser recorded audio in a format we cannot read.');
  return { bytes: audio.bytes, mimeType: audio.mimeType };
}

function workerFailure(err: unknown, message?: string) {
  if (err instanceof ScreeningWorkerError) {
    const status = err.code === 'AUDIO_UNREADABLE' ? HttpStatus.UNPROCESSABLE_ENTITY : err.retryAfterSeconds ? HttpStatus.TOO_MANY_REQUESTS : HttpStatus.SERVICE_UNAVAILABLE;
    return screeningError(status, err.code === 'AUDIO_UNREADABLE' ? 'AUDIO_UNREADABLE' : 'AI_UNAVAILABLE', message ?? err.message, {
      retryable: err.retryable,
      ...(err.retryAfterSeconds ? { retryAfterSeconds: err.retryAfterSeconds } : {}),
    });
  }
  return err;
}

const invalidLink = () =>
  screeningError(HttpStatus.NOT_FOUND, 'SCREENING_LINK_INVALID', 'This screening link is not valid. Please use the link from your latest email.');

export function firstName(name: string): string {
  const first = name.trim().split(/\s+/)[0] ?? '';
  return first.slice(0, 40);
}

export function questionContext(ctx: ScreeningContext): QuestionContext {
  return {
    candidateFirstName: firstName(ctx.candidateName),
    jobTitle: ctx.jobTitle,
    companyName: ctx.companyName,
    locations: ctx.form.locations,
    workMode: ctx.form.workMode,
    employmentType: ctx.form.employmentType,
  };
}

const WORK_MODE = { ONSITE: 'On-site', HYBRID: 'Hybrid', REMOTE: 'Remote' } as const;
const EMPLOYMENT = { FULL_TIME: 'Full-time', PART_TIME: 'Part-time', INTERNSHIP: 'Internship', CONTRACT: 'Contract' } as const;

/** Only published facts (the approved JD the candidate applied to + the public job form fields). */
export function jobFacts(ctx: ScreeningContext): ScreeningJobFacts {
  const f = ctx.form;
  return {
    title: ctx.jobTitle,
    companyName: ctx.companyName,
    locations: f.locations,
    workMode: f.workMode ? WORK_MODE[f.workMode] : null,
    employmentType: f.employmentType ? EMPLOYMENT[f.employmentType] : null,
    applicationDeadline: f.deadline ? f.deadline.slice(0, 10) : null,
    summary: ctx.jd?.summary ?? '',
    responsibilities: ctx.jd?.responsibilities ?? [],
    requirements: ctx.jd?.requirements ?? [],
    niceToHave: ctx.jd?.niceToHave ?? [],
    benefits: ctx.jd?.benefits ?? [],
    aboutCompany: ctx.jd?.aboutCompany ?? '',
    salary: salaryText(f),
  };
}

function salaryText(f: ScreeningContext['form']): string | null {
  if (f.salaryMin === null && f.salaryMax === null) return null;
  const fmt = (n: number) => new Intl.NumberFormat('en-IN').format(n);
  const range =
    f.salaryMin !== null && f.salaryMax !== null
      ? f.salaryMin === f.salaryMax
        ? fmt(f.salaryMin)
        : `${fmt(f.salaryMin)} to ${fmt(f.salaryMax)}`
      : f.salaryMin !== null
        ? `from ${fmt(f.salaryMin)}`
        : `up to ${fmt(f.salaryMax!)}`;
  return `${f.currency} ${range} (${f.salaryType === 'IN_HAND' ? 'in-hand' : 'CTC'}, as published in the job post)`;
}
