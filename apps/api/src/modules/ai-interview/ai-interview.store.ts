import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  AI_INTERVIEW_CONSENT_VERSION,
  jdContentSchema,
  parsedResumeSchema,
  type AiInterviewDecision,
  type AiInterviewEventType,
  type AiInterviewIntegrityStatus,
  type AiInterviewProtectionSettings,
  type AiInterviewViolationType,
  type AiInterviewQuestionKind,
  type AiInterviewReport,
  type AiInterviewReportStatus,
  type AiInterviewSource,
  type AiInterviewStatus,
  type AiInterviewTranscriptQuality,
  type EmailDeliveryStatus,
} from '@hireflow/contracts';
import { PrismaService } from '../../common/prisma.service';
import { uuidv7 } from '../../common/uuidv7';
import { EMPTY_RESUME, type InterviewJobFacts, type InterviewResumeFacts } from './ai-interview-worker.client';
import type { InterviewConfig, Pending, StoredPlan } from './flow';
import type { StoredOutcome, ViolationDecision } from './protection';

/** All database access of the ai-interview module. HR queries are scoped by tenant; candidate ones by the link token. */

export interface InviteRow {
  id: string;
  tenantId: string;
  applicationId: string;
  jobId: string;
  roundId: string;
  expiresAt: Date | null;
  emailStatus: EmailDeliveryStatus;
  attempts: number;
  sentAt: Date | null;
  lastError: string | null;
}

export interface InterviewContext {
  tenantId: string;
  applicationId: string;
  jobId: string;
  candidateId: string;
  candidateName: string;
  email: string;
  jobTitle: string;
  companyName: string;
  companyWebsite: string | null;
  job: InterviewJobFacts;
  /** null = the resume was never parsed (the plan then leans on the job). */
  resume: InterviewResumeFacts | null;
}

export interface SessionRow {
  id: string;
  tenantId: string;
  applicationId: string;
  jobId: string;
  roundId: string;
  inviteId: string;
  status: AiInterviewStatus;
  consentGivenAt: Date | null;
  config: unknown;
  plan: unknown;
  pendingSeq: number;
  pendingKind: AiInterviewQuestionKind;
  pendingSource: AiInterviewSource;
  pendingText: string;
  pendingTopicId: string | null;
  pendingTopic: string | null;
  pendingResumeRef: string | null;
  pendingAskedAt: Date | null;
  pendingRepeats: number;
  followUpsOnTopic: number;
  coveredTopics: string[];
  startedAt: Date | null;
  pausedSeconds: number;
  pausedAt: Date | null;
  pauseReason: string | null;
  lastActivityAt: Date | null;
  completedAt: Date | null;
  endedReason: string | null;
  decision: AiInterviewDecision | null;
  decisionReason: string | null;
  decidedById: string | null;
  decidedByName: string | null;
  decidedAt: Date | null;
  recordedAt: Date | null;
  /** Protection snapshot (AiInterviewProtectionSettings JSON); null = not monitored. */
  protection: unknown;
  warningCount: number;
  integrityStatus: AiInterviewIntegrityStatus;
  terminatedAt: Date | null;
  terminationReason: string | null;
}

/** One stored protection incident. */
export interface ViolationRow {
  type: AiInterviewViolationType;
  outcome: StoredOutcome;
  warningNumber: number | null;
  incidentId: string;
  occurredAt: Date;
  detail: string | null;
  acknowledgedAt: Date | null;
  resolvedAt: Date | null;
}

export interface ViolationInput {
  incidentId: string;
  type: AiInterviewViolationType;
  detail: string | null;
  now: Date;
  /** Rows kept per interview; counted incidents are always stored. */
  maxRows: number;
}

/** What `decide` returns: null = the interview does not accept it now (nothing stored). */
export type ViolationVerdict = (ViolationDecision & { terminationReason: string | null; terminatedText: string }) | null;

export type RecordViolationResult =
  | { kind: 'replay'; row: ViolationRow; session: SessionRow }
  | { kind: 'ignored'; session: SessionRow }
  | { kind: 'saved'; decision: ViolationDecision; stored: boolean; session: SessionRow };

export interface ProtectionSettingsRow {
  settings: AiInterviewProtectionSettings;
  updatedAt: Date;
  updatedByName: string | null;
}

export interface TurnRow {
  seq: number;
  kind: AiInterviewQuestionKind;
  source: AiInterviewSource;
  topicId: string | null;
  topic: string | null;
  resumeRef: string | null;
  question: string;
  rawTranscript: string;
  normalizedTranscript: string;
  transcriptQuality: AiInterviewTranscriptQuality;
  unclearTerms: string[];
  reading: string | null;
  askedAt: Date;
  answeredAt: Date;
  answerSeconds: number | null;
  clientTurnId: string;
}

export interface NewTurn extends TurnRow {
  model: string | null;
  promptVersion: string | null;
}

export interface NextUpdate {
  pending: Pending;
  followUpsOnTopic: number;
  coveredTopics: string[];
  done: boolean;
  endedReason: string | null;
}

export interface ReportRow {
  status: AiInterviewReportStatus;
  report: unknown;
  overallScore: number | null;
  lastError: string | null;
  attempts: number;
  generatedAt: Date | null;
  updatedAt: Date;
}

export interface EventRow {
  type: string;
  occurredAt: Date;
  detail: string | null;
}

export type SendFailure = { retryAt: Date; error: string; countAttempt: boolean } | { giveUp: true; error: string };

export abstract class AiInterviewStore {
  // ---- candidate (token)
  abstract findInviteByHash(tokenHash: string): Promise<InviteRow | null>;
  abstract context(tenantId: string, applicationId: string): Promise<InterviewContext | null>;
  abstract sessionByInvite(inviteId: string): Promise<SessionRow | null>;
  abstract session(sessionId: string): Promise<SessionRow | null>;
  /** Creates the session (NOT_STARTED, greeting pending, config + protection copied) if it does not exist yet; safe to call twice. */
  abstract ensureSession(invite: InviteRow, config: InterviewConfig, greeting: string, protection: AiInterviewProtectionSettings | null): Promise<SessionRow>;
  abstract turns(sessionId: string): Promise<TurnRow[]>;
  /** NOT_STARTED -> IN_PROGRESS with the consent recorded and the clock started. */
  abstract start(session: SessionRow, ctx: InterviewContext, now: Date): Promise<void>;
  abstract savePlan(sessionId: string, plan: StoredPlan): Promise<void>;
  /** Saves the answered turn and moves the pending question on, only if `expectedSeq` is still pending. */
  abstract saveTurn(sessionId: string, expectedSeq: number, turn: NewTurn, next: NextUpdate, now: Date): Promise<'saved' | 'stale'>;
  /** Ends without a new answer (time up, the candidate ended, abandoned): the closing words become pending. */
  abstract finish(sessionId: string, status: 'COMPLETED' | 'INCOMPLETE', reason: string, closing: string, now: Date): Promise<boolean>;
  /** IN_PROGRESS -> PAUSED (the clock stops). */
  abstract pause(sessionId: string, reason: string, now: Date): Promise<boolean>;
  /** PAUSED -> IN_PROGRESS; the pause is added to pausedSeconds and the current question is asked again. */
  abstract resume(sessionId: string, now: Date): Promise<boolean>;
  abstract countRepeat(sessionId: string, seq: number, max: number): Promise<boolean>;
  abstract touch(sessionId: string, now: Date): Promise<void>;
  abstract addEvents(tenantId: string, sessionId: string, events: { type: AiInterviewEventType | 'PAUSED' | 'RESUMED'; occurredAt: Date; detail: string | null }[]): Promise<void>;

  // ---- protection (the ONE warning counter)
  /**
   * Under the interview's row lock: the same incidentId again -> the stored row (replay); otherwise `decide` sees the
   * locked session and every earlier incident, and its verdict is stored together with the new counter (and the
   * termination when it says so) in one transaction. Concurrent reports are therefore counted one after the other.
   */
  abstract recordViolation(
    sessionId: string,
    owner: { tenantId: string; applicationId: string; candidateId: string },
    input: ViolationInput,
    decide: (session: SessionRow, prior: ViolationRow[]) => ViolationVerdict,
  ): Promise<RecordViolationResult>;
  abstract violations(sessionId: string): Promise<ViolationRow[]>;
  /** The candidate confirmed warning N (only a counted WARNING, once). */
  abstract acknowledgeWarning(sessionId: string, warningNumber: number, now: Date): Promise<boolean>;
  /** The interview resumed with both devices back: open camera / microphone incidents are resolved. */
  abstract resolveDeviceIncidents(sessionId: string, now: Date): Promise<void>;
  abstract protectionSettings(tenantId: string, roundId: string): Promise<ProtectionSettingsRow | null>;
  abstract saveProtectionSettings(tenantId: string, roundId: string, settings: AiInterviewProtectionSettings, by: { id: string | null; name: string | null }): Promise<ProtectionSettingsRow>;

  // ---- background
  /** Queues one invitation per (application, round); true when it was new. */
  abstract queueInvite(row: { tenantId: string; applicationId: string; jobId: string; roundId: string }): Promise<boolean>;
  abstract claimDueInvites(now: Date, staleBefore: Date, limit: number): Promise<InviteRow[]>;
  abstract setInviteToken(inviteId: string, tokenHash: string, expiresAt: Date, linkBase: string): Promise<void>;
  abstract inviteSent(inviteId: string, sentAt: Date, expiresAt: Date): Promise<void>;
  abstract inviteFailed(inviteId: string, failure: SendFailure): Promise<void>;
  /**
   * Sent invitations whose link was built on another address than `base`, still valid, and whose interview is not
   * finished (not opened, or started / paused): their link may have died with an old tunnel.
   */
  abstract invitesWithOtherLink(base: string, now: Date, limit: number): Promise<(InviteRow & { linkBase: string | null })[]>;
  /** A SENT invitation goes back to the queue (a fresh link is made when it is sent); false when it was not SENT. */
  abstract requeueInvite(inviteId: string, now: Date): Promise<boolean>;
  /** IN_PROGRESS / PAUSED sessions without activity since `before` (candidates for the time-out sweep). */
  abstract idleSessions(before: Date, limit: number): Promise<SessionRow[]>;
  /** Ended sessions whose report is missing, or failed and due for another try. */
  abstract sessionsNeedingReport(now: Date, limit: number): Promise<SessionRow[]>;
  /** Creates / restarts the report (PENDING, attempts + 1); false when another process is already on it. */
  abstract beginReport(session: SessionRow, now: Date): Promise<boolean>;
  abstract finishReport(sessionId: string, data: { report: AiInterviewReport; model: string; promptVersion: string }, now: Date): Promise<void>;
  abstract failReport(sessionId: string, error: string): Promise<void>;
  /** Decided by HR but not handed to the round engine yet (the process stopped in between). */
  abstract decidedNotRecorded(limit: number): Promise<SessionRow[]>;

  // ---- HR
  abstract invitesForApplication(tenantId: string, applicationId: string): Promise<InviteRow[]>;
  abstract sessionsForApplication(tenantId: string, applicationId: string): Promise<SessionRow[]>;
  abstract report(sessionId: string): Promise<ReportRow | null>;
  abstract events(sessionId: string): Promise<EventRow[]>;
  /** Stores HR's decision once (only when none was made yet); false when it was already decided. */
  abstract decide(tenantId: string, sessionId: string, d: { decision: AiInterviewDecision; reason: string | null; byId: string | null; byName: string | null }, now: Date): Promise<boolean>;
  abstract markRecorded(sessionId: string, now: Date): Promise<void>;
}

const REPORT_STALE_MS = 10 * 60_000;
const REPORT_MAX_ATTEMPTS = 3;
const REPORT_RETRY_MS = 5 * 60_000;

type InviteDb = Prisma.AiInterviewInviteGetPayload<object>;

@Injectable()
export class PrismaAiInterviewStore extends AiInterviewStore {
  constructor(@Inject(PrismaService) private readonly db: PrismaService) {
    super();
  }

  async findInviteByHash(tokenHash: string) {
    const row = await this.db.aiInterviewInvite.findUnique({ where: { tokenHash } });
    return row ? toInvite(row) : null;
  }

  async context(tenantId: string, applicationId: string): Promise<InterviewContext | null> {
    const app = await this.db.application.findFirst({
      where: { id: applicationId, tenantId },
      select: { jobId: true, jdVersionId: true, email: true, candidateId: true, candidate: { select: { name: true, email: true } }, atsEvaluation: { select: { parsedProfile: true } } },
    });
    if (!app) return null;
    const [job, version, profile, tenant] = await Promise.all([
      this.db.job.findFirst({ where: { id: app.jobId, tenantId }, select: { title: true, formData: true } }),
      this.db.jdVersion.findFirst({ where: { id: app.jdVersionId, tenantId }, select: { content: true } }),
      this.db.companyProfile.findUnique({ where: { tenantId }, select: { name: true, website: true, careersUrl: true } }),
      this.db.tenant.findUnique({ where: { id: tenantId }, select: { name: true } }),
    ]);
    if (!job) return null;
    const jd = jdContentSchema.safeParse(version?.content);
    const form = (job.formData && typeof job.formData === 'object' ? job.formData : {}) as Record<string, unknown>;
    const strings = (v: unknown) => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && !!s.trim()) : []);
    const min = typeof form.experienceMin === 'number' ? form.experienceMin : null;
    const max = typeof form.experienceMax === 'number' ? form.experienceMax : null;
    const title = (jd.success && jd.data.title) || job.title;
    return {
      tenantId,
      applicationId,
      jobId: app.jobId,
      candidateId: app.candidateId,
      candidateName: app.candidate.name,
      email: app.email ?? app.candidate.email,
      jobTitle: title,
      companyName: profile?.name || tenant?.name || 'our company',
      companyWebsite: profile?.website || profile?.careersUrl || null,
      job: {
        title,
        summary: jd.success ? jd.data.summary : '',
        responsibilities: jd.success ? jd.data.responsibilities : [],
        requirements: jd.success ? jd.data.requirements : [],
        niceToHave: jd.success ? jd.data.niceToHave : [],
        skills: [...strings(form.mustHaveSkills), ...strings(form.niceToHaveSkills)].slice(0, 60),
        experienceLevel: min === null || max === null ? null : min === max ? `${min} years` : `${min}-${max} years`,
      },
      resume: toResumeFacts(app.atsEvaluation?.parsedProfile),
    };
  }

  async sessionByInvite(inviteId: string) {
    return this.db.aiInterviewSession.findUnique({ where: { inviteId } });
  }

  async session(sessionId: string) {
    return this.db.aiInterviewSession.findUnique({ where: { id: sessionId } });
  }

  async ensureSession(invite: InviteRow, config: InterviewConfig, greeting: string, protection: AiInterviewProtectionSettings | null): Promise<SessionRow> {
    const existing = await this.sessionByInvite(invite.id);
    if (existing) return existing;
    try {
      return await this.db.aiInterviewSession.create({
        data: {
          id: uuidv7(),
          tenantId: invite.tenantId,
          applicationId: invite.applicationId,
          jobId: invite.jobId,
          roundId: invite.roundId,
          inviteId: invite.id,
          config: config as unknown as Prisma.InputJsonObject,
          protection: protection ? (protection as unknown as Prisma.InputJsonObject) : Prisma.DbNull,
          pendingText: greeting,
        },
      });
    } catch (err) {
      // two tabs opened the link at once: the other one created it
      if (isUniqueViolation(err)) return (await this.sessionByInvite(invite.id))!;
      throw err;
    }
  }

  async turns(sessionId: string): Promise<TurnRow[]> {
    return this.db.aiInterviewTurn.findMany({
      where: { sessionId },
      orderBy: { seq: 'asc' },
      select: {
        seq: true,
        kind: true,
        source: true,
        topicId: true,
        topic: true,
        resumeRef: true,
        question: true,
        rawTranscript: true,
        normalizedTranscript: true,
        transcriptQuality: true,
        unclearTerms: true,
        reading: true,
        askedAt: true,
        answeredAt: true,
        answerSeconds: true,
        clientTurnId: true,
      },
    });
  }

  async start(session: SessionRow, ctx: InterviewContext, now: Date): Promise<void> {
    await this.db.$transaction(async (tx) => {
      const { count } = await tx.aiInterviewSession.updateMany({
        where: { id: session.id, status: 'NOT_STARTED' },
        data: { status: 'IN_PROGRESS', startedAt: now, lastActivityAt: now, consentGivenAt: now, pendingAskedAt: now },
      });
      if (count !== 1) return; // started in another tab meanwhile
      const consent = await tx.consent.create({
        data: {
          id: uuidv7(),
          tenantId: ctx.tenantId,
          candidateId: ctx.candidateId,
          applicationId: ctx.applicationId,
          purpose: 'ai_technical_interview',
          policyVersion: AI_INTERVIEW_CONSENT_VERSION,
          grantedAt: now,
        },
      });
      await tx.aiInterviewSession.update({ where: { id: session.id }, data: { consentId: consent.id } });
    });
  }

  async savePlan(sessionId: string, plan: StoredPlan): Promise<void> {
    // never replaces a plan that is already there (two parallel planners: the first one wins)
    await this.db.aiInterviewSession.updateMany({ where: { id: sessionId, plan: { equals: Prisma.DbNull } }, data: { plan: plan as unknown as Prisma.InputJsonObject } });
  }

  async saveTurn(sessionId: string, expectedSeq: number, turn: NewTurn, next: NextUpdate, now: Date): Promise<'saved' | 'stale'> {
    try {
      return await this.db.$transaction(async (tx) => {
        const { count } = await tx.aiInterviewSession.updateMany({
          where: { id: sessionId, pendingSeq: expectedSeq, status: 'IN_PROGRESS' },
          data: {
            pendingSeq: expectedSeq + 1,
            pendingKind: next.pending.kind,
            pendingSource: next.pending.source,
            pendingText: next.pending.text,
            pendingTopicId: next.pending.topicId,
            pendingTopic: next.pending.topic,
            pendingResumeRef: next.pending.resumeRef,
            pendingAskedAt: now,
            pendingRepeats: 0,
            followUpsOnTopic: next.followUpsOnTopic,
            coveredTopics: next.coveredTopics,
            lastActivityAt: now,
            ...(next.done ? { status: 'COMPLETED' as const, completedAt: now, endedReason: next.endedReason } : {}),
          },
        });
        if (count !== 1) return 'stale' as const;
        const session = await tx.aiInterviewSession.findUniqueOrThrow({ where: { id: sessionId }, select: { tenantId: true } });
        await tx.aiInterviewTurn.create({ data: { ...turn, id: uuidv7(), sessionId, tenantId: session.tenantId } });
        return 'saved' as const;
      });
    } catch (err) {
      if (isUniqueViolation(err)) return 'stale'; // the same upload (clientTurnId) or seq was saved by a parallel request
      throw err;
    }
  }

  async finish(sessionId: string, status: 'COMPLETED' | 'INCOMPLETE', reason: string, closing: string, now: Date): Promise<boolean> {
    const s = await this.session(sessionId);
    if (!s || (s.status !== 'IN_PROGRESS' && s.status !== 'PAUSED')) return false;
    const pause = s.pausedAt ? Math.max(0, Math.round((now.getTime() - s.pausedAt.getTime()) / 1000)) : 0;
    const { count } = await this.db.aiInterviewSession.updateMany({
      where: { id: sessionId, status: { in: ['IN_PROGRESS', 'PAUSED'] }, pendingSeq: s.pendingSeq },
      data: {
        status,
        completedAt: now,
        endedReason: reason,
        pausedSeconds: s.pausedSeconds + pause,
        pausedAt: null,
        pendingSeq: s.pendingSeq + 1,
        pendingKind: 'CLOSING',
        pendingSource: 'CLOSING',
        pendingText: closing,
        pendingTopicId: null,
        pendingTopic: null,
        pendingResumeRef: null,
        pendingAskedAt: now,
        lastActivityAt: now,
      },
    });
    return count === 1;
  }

  async pause(sessionId: string, reason: string, now: Date): Promise<boolean> {
    const { count } = await this.db.aiInterviewSession.updateMany({
      where: { id: sessionId, status: 'IN_PROGRESS' },
      data: { status: 'PAUSED', pausedAt: now, pauseReason: reason, lastActivityAt: now },
    });
    return count === 1;
  }

  async resume(sessionId: string, now: Date): Promise<boolean> {
    const s = await this.session(sessionId);
    if (!s || s.status !== 'PAUSED') return false;
    const pause = s.pausedAt ? Math.max(0, Math.round((now.getTime() - s.pausedAt.getTime()) / 1000)) : 0;
    const { count } = await this.db.aiInterviewSession.updateMany({
      where: { id: sessionId, status: 'PAUSED', pausedAt: s.pausedAt },
      data: { status: 'IN_PROGRESS', pausedAt: null, pauseReason: null, pausedSeconds: s.pausedSeconds + pause, pendingAskedAt: now, pendingRepeats: 0, lastActivityAt: now },
    });
    return count === 1;
  }

  async countRepeat(sessionId: string, seq: number, max: number): Promise<boolean> {
    const { count } = await this.db.aiInterviewSession.updateMany({
      where: { id: sessionId, pendingSeq: seq, pendingRepeats: { lt: max } },
      data: { pendingRepeats: { increment: 1 } },
    });
    return count === 1;
  }

  async touch(sessionId: string, now: Date): Promise<void> {
    await this.db.aiInterviewSession.updateMany({ where: { id: sessionId, status: { in: ['IN_PROGRESS', 'PAUSED'] } }, data: { lastActivityAt: now } });
  }

  async addEvents(tenantId: string, sessionId: string, events: { type: string; occurredAt: Date; detail: string | null }[]): Promise<void> {
    if (!events.length) return;
    await this.db.aiInterviewEvent.createMany({ data: events.map((e) => ({ id: uuidv7(), tenantId, sessionId, type: e.type, occurredAt: e.occurredAt, detail: e.detail })) });
  }

  // ---------------------------------------------------------------- protection

  async recordViolation(
    sessionId: string,
    owner: { tenantId: string; applicationId: string; candidateId: string },
    input: ViolationInput,
    decide: (session: SessionRow, prior: ViolationRow[]) => ViolationVerdict,
  ): Promise<RecordViolationResult> {
    return this.db.$transaction(async (tx) => {
      // the row lock: every report of this interview waits here for the one before it (the counter has one writer)
      await tx.$queryRaw`SELECT 1 AS locked FROM ai_interview_sessions WHERE id = ${sessionId}::uuid FOR UPDATE`;
      const session = await tx.aiInterviewSession.findUniqueOrThrow({ where: { id: sessionId } });
      const existing = await tx.aiInterviewViolation.findUnique({ where: { sessionId_incidentId: { sessionId, incidentId: input.incidentId } }, select: VIOLATION_SELECT });
      if (existing) return { kind: 'replay' as const, row: existing, session };
      const prior = await tx.aiInterviewViolation.findMany({ where: { sessionId }, select: VIOLATION_SELECT, orderBy: { occurredAt: 'asc' } });
      const verdict = decide(session, prior);
      if (!verdict) return { kind: 'ignored' as const, session };
      const { terminationReason, terminatedText, ...decision } = verdict;
      const counted = decision.outcome === 'WARNING' || decision.outcome === 'TERMINATED';
      // a flood of uncounted reports is not stored; a counted one always is
      const stored = counted || prior.length < input.maxRows;
      const now = input.now;
      if (stored) {
        await tx.aiInterviewViolation.create({
          data: {
            id: uuidv7(),
            tenantId: owner.tenantId,
            sessionId,
            applicationId: owner.applicationId,
            candidateId: owner.candidateId,
            type: input.type,
            outcome: decision.outcome,
            warningNumber: decision.warningNumber,
            incidentId: input.incidentId,
            occurredAt: now,
            detail: input.detail,
          },
        });
      }
      if (counted) {
        const pause = session.pausedAt ? Math.max(0, Math.round((now.getTime() - session.pausedAt.getTime()) / 1000)) : 0;
        await tx.aiInterviewSession.update({
          where: { id: sessionId },
          data: {
            warningCount: decision.warningCount,
            lastActivityAt: now,
            ...(decision.terminate
              ? {
                  status: 'TERMINATED' as const,
                  completedAt: now,
                  endedReason: 'MAX_WARNINGS_EXCEEDED',
                  terminatedAt: now,
                  terminationReason: terminationReason?.slice(0, 300) ?? null,
                  integrityStatus: 'INTEGRITY_VIOLATION_REVIEW' as const,
                  pausedSeconds: session.pausedSeconds + pause,
                  pausedAt: null,
                  // an answer still on its way for the old question is refused (the seq moved on)
                  pendingSeq: session.pendingSeq + 1,
                  pendingKind: 'CLOSING' as const,
                  pendingSource: 'CLOSING' as const,
                  pendingText: terminatedText,
                  pendingTopicId: null,
                  pendingTopic: null,
                  pendingResumeRef: null,
                  pendingAskedAt: now,
                }
              : {}),
          },
        });
      }
      const fresh = await tx.aiInterviewSession.findUniqueOrThrow({ where: { id: sessionId } });
      return { kind: 'saved' as const, decision, stored, session: fresh };
    });
  }

  async violations(sessionId: string): Promise<ViolationRow[]> {
    return this.db.aiInterviewViolation.findMany({ where: { sessionId }, select: VIOLATION_SELECT, orderBy: { occurredAt: 'asc' }, take: 500 });
  }

  async acknowledgeWarning(sessionId: string, warningNumber: number, now: Date): Promise<boolean> {
    const { count } = await this.db.aiInterviewViolation.updateMany({ where: { sessionId, warningNumber, outcome: 'WARNING', acknowledgedAt: null }, data: { acknowledgedAt: now } });
    return count > 0;
  }

  async resolveDeviceIncidents(sessionId: string, now: Date): Promise<void> {
    await this.db.aiInterviewViolation.updateMany({ where: { sessionId, type: { in: ['CAMERA_LOST', 'MIC_LOST'] }, resolvedAt: null }, data: { resolvedAt: now } });
  }

  async protectionSettings(tenantId: string, roundId: string): Promise<ProtectionSettingsRow | null> {
    const r = await this.db.aiInterviewProtectionSetting.findUnique({ where: { roundId_tenantId: { roundId, tenantId } } });
    return r ? toSettingsRow(r) : null;
  }

  async saveProtectionSettings(tenantId: string, roundId: string, settings: AiInterviewProtectionSettings, by: { id: string | null; name: string | null }): Promise<ProtectionSettingsRow> {
    const data = { ...settings, updatedById: by.id, updatedByName: by.name };
    const r = await this.db.aiInterviewProtectionSetting.upsert({
      where: { roundId_tenantId: { roundId, tenantId } },
      create: { id: uuidv7(), tenantId, roundId, ...data },
      update: data,
    });
    return toSettingsRow(r);
  }

  // ---------------------------------------------------------------- background

  async queueInvite(row: { tenantId: string; applicationId: string; jobId: string; roundId: string }): Promise<boolean> {
    const { count } = await this.db.aiInterviewInvite.createMany({ data: [{ id: uuidv7(), ...row }], skipDuplicates: true });
    return count === 1;
  }

  async claimDueInvites(now: Date, staleBefore: Date, limit: number): Promise<InviteRow[]> {
    const rows = await this.db.$queryRaw<{ id: string }[]>(Prisma.sql`
      UPDATE ai_interview_invites SET email_status = 'SENDING'::email_delivery_status, locked_at = ${now}, attempts = attempts + 1, updated_at = ${now}
       WHERE id IN (
         SELECT id FROM ai_interview_invites
          WHERE (email_status = 'QUEUED' AND next_attempt_at <= ${now})
             OR (email_status = 'SENDING' AND locked_at < ${staleBefore})
          ORDER BY next_attempt_at
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED)
      RETURNING id::text AS id`);
    if (!rows.length) return [];
    const invites = await this.db.aiInterviewInvite.findMany({ where: { id: { in: rows.map((r) => r.id) } } });
    return invites.map(toInvite);
  }

  async setInviteToken(inviteId: string, tokenHash: string, expiresAt: Date, linkBase: string): Promise<void> {
    await this.db.aiInterviewInvite.update({ where: { id: inviteId }, data: { tokenHash, expiresAt, linkBase } });
  }

  async inviteSent(inviteId: string, sentAt: Date, expiresAt: Date): Promise<void> {
    await this.db.aiInterviewInvite.update({ where: { id: inviteId }, data: { emailStatus: 'SENT', sentAt, expiresAt, lockedAt: null, lastError: null } });
  }

  async inviteFailed(inviteId: string, failure: SendFailure): Promise<void> {
    if ('giveUp' in failure) {
      await this.db.aiInterviewInvite.update({ where: { id: inviteId }, data: { emailStatus: 'FAILED', lockedAt: null, lastError: failure.error.slice(0, 300) } });
      return;
    }
    await this.db.aiInterviewInvite.update({
      where: { id: inviteId },
      data: {
        emailStatus: 'QUEUED',
        lockedAt: null,
        nextAttemptAt: failure.retryAt,
        lastError: failure.error.slice(0, 300),
        // a wait for the public link is not a delivery attempt
        ...(failure.countAttempt ? {} : { attempts: { decrement: 1 } }),
      },
    });
  }

  async invitesWithOtherLink(base: string, now: Date, limit: number) {
    const rows = await this.db.aiInterviewInvite.findMany({
      where: {
        emailStatus: 'SENT',
        expiresAt: { gt: now },
        OR: [{ linkBase: null }, { linkBase: { not: base } }],
        AND: [{ OR: [{ session: { is: null } }, { session: { is: { status: { in: ['NOT_STARTED', 'IN_PROGRESS', 'PAUSED'] } } } }] }],
      },
      take: limit,
    });
    return rows.map((r) => ({ ...toInvite(r), linkBase: r.linkBase }));
  }

  async requeueInvite(inviteId: string, now: Date): Promise<boolean> {
    const { count } = await this.db.aiInterviewInvite.updateMany({
      where: { id: inviteId, emailStatus: 'SENT' },
      data: { emailStatus: 'QUEUED', nextAttemptAt: now, lockedAt: null, lastError: null, attempts: 0 },
    });
    return count === 1;
  }

  async idleSessions(before: Date, limit: number) {
    return this.db.aiInterviewSession.findMany({
      where: { status: { in: ['IN_PROGRESS', 'PAUSED'] }, lastActivityAt: { lt: before } },
      orderBy: { lastActivityAt: 'asc' },
      take: limit,
    });
  }

  async sessionsNeedingReport(now: Date, limit: number) {
    return this.db.aiInterviewSession.findMany({
      where: {
        status: { in: ['COMPLETED', 'INCOMPLETE', 'TERMINATED'] },
        turns: { some: { kind: { notIn: ['INTRO', 'CLOSING'] } } },
        OR: [
          { report: { is: null } },
          { report: { status: 'FAILED', attempts: { lt: REPORT_MAX_ATTEMPTS }, updatedAt: { lt: new Date(now.getTime() - REPORT_RETRY_MS) } } },
          { report: { status: 'PENDING', updatedAt: { lt: new Date(now.getTime() - REPORT_STALE_MS) } } },
        ],
      },
      orderBy: { completedAt: 'asc' },
      take: limit,
    });
  }

  async beginReport(session: SessionRow, now: Date): Promise<boolean> {
    const existing = await this.db.aiInterviewReport.findUnique({ where: { sessionId: session.id } });
    if (!existing) {
      try {
        await this.db.aiInterviewReport.create({ data: { id: uuidv7(), tenantId: session.tenantId, sessionId: session.id, attempts: 1 } });
        return true;
      } catch (err) {
        if (isUniqueViolation(err)) return false;
        throw err;
      }
    }
    if (existing.status === 'PENDING' && now.getTime() - existing.updatedAt.getTime() < REPORT_STALE_MS) return false;
    const { count } = await this.db.aiInterviewReport.updateMany({
      where: { sessionId: session.id, updatedAt: existing.updatedAt },
      data: { status: 'PENDING', lastError: null, attempts: { increment: 1 } },
    });
    return count === 1;
  }

  async finishReport(sessionId: string, data: { report: AiInterviewReport; model: string; promptVersion: string }, now: Date): Promise<void> {
    await this.db.aiInterviewReport.update({
      where: { sessionId },
      data: {
        status: 'DONE',
        report: data.report as unknown as Prisma.InputJsonObject,
        overallScore: data.report.overallScore,
        recommendation: data.report.recommendation,
        model: data.model,
        promptVersion: data.promptVersion,
        generatedAt: now,
        lastError: null,
      },
    });
  }

  async failReport(sessionId: string, error: string): Promise<void> {
    await this.db.aiInterviewReport.update({ where: { sessionId }, data: { status: 'FAILED', lastError: error.slice(0, 300) } });
  }

  async decidedNotRecorded(limit: number) {
    return this.db.aiInterviewSession.findMany({ where: { decision: { not: null }, recordedAt: null }, orderBy: { decidedAt: 'asc' }, take: limit });
  }

  // ---------------------------------------------------------------- HR

  async invitesForApplication(tenantId: string, applicationId: string) {
    const rows = await this.db.aiInterviewInvite.findMany({ where: { tenantId, applicationId }, orderBy: { createdAt: 'asc' } });
    return rows.map(toInvite);
  }

  async sessionsForApplication(tenantId: string, applicationId: string) {
    return this.db.aiInterviewSession.findMany({ where: { tenantId, applicationId }, orderBy: { createdAt: 'asc' } });
  }

  async report(sessionId: string): Promise<ReportRow | null> {
    const r = await this.db.aiInterviewReport.findUnique({ where: { sessionId } });
    return r ? { status: r.status, report: r.report, overallScore: r.overallScore, lastError: r.lastError, attempts: r.attempts, generatedAt: r.generatedAt, updatedAt: r.updatedAt } : null;
  }

  async events(sessionId: string): Promise<EventRow[]> {
    return this.db.aiInterviewEvent.findMany({ where: { sessionId }, orderBy: { occurredAt: 'asc' }, take: 500, select: { type: true, occurredAt: true, detail: true } });
  }

  async decide(tenantId: string, sessionId: string, d: { decision: AiInterviewDecision; reason: string | null; byId: string | null; byName: string | null }, now: Date): Promise<boolean> {
    const { count } = await this.db.aiInterviewSession.updateMany({
      where: { id: sessionId, tenantId, decision: null, status: { in: ['COMPLETED', 'INCOMPLETE', 'TERMINATED'] } },
      data: { decision: d.decision, decisionReason: d.reason, decidedById: d.byId, decidedByName: d.byName, decidedAt: now },
    });
    // a terminated interview's integrity review is done once HR decided
    if (count === 1) await this.db.aiInterviewSession.updateMany({ where: { id: sessionId, integrityStatus: 'INTEGRITY_VIOLATION_REVIEW' }, data: { integrityStatus: 'REVIEWED' } });
    return count === 1;
  }

  async markRecorded(sessionId: string, now: Date): Promise<void> {
    await this.db.aiInterviewSession.updateMany({ where: { id: sessionId, recordedAt: null }, data: { recordedAt: now } });
  }
}

const VIOLATION_SELECT = {
  type: true,
  outcome: true,
  warningNumber: true,
  incidentId: true,
  occurredAt: true,
  detail: true,
  acknowledgedAt: true,
  resolvedAt: true,
} satisfies Prisma.AiInterviewViolationSelect;

function toSettingsRow(r: Prisma.AiInterviewProtectionSettingGetPayload<object>): ProtectionSettingsRow {
  return {
    settings: { maxWarnings: r.maxWarnings, tabSwitchMonitoring: r.tabSwitchMonitoring, fullscreenRequired: r.fullscreenRequired, cameraPolicy: r.cameraPolicy, microphonePolicy: r.microphonePolicy, multipleFacesPolicy: r.multipleFacesPolicy },
    updatedAt: r.updatedAt,
    updatedByName: r.updatedByName,
  };
}

function toInvite(r: InviteDb): InviteRow {
  return {
    id: r.id,
    tenantId: r.tenantId,
    applicationId: r.applicationId,
    jobId: r.jobId,
    roundId: r.roundId,
    expiresAt: r.expiresAt,
    emailStatus: r.emailStatus,
    attempts: r.attempts,
    sentAt: r.sentAt,
    lastError: r.lastError,
  };
}

/** The ATS step's parsed resume, in the worker's shape (null when there is none or it does not read). */
export function toResumeFacts(raw: unknown): InterviewResumeFacts | null {
  const parsed = parsedResumeSchema.safeParse(raw);
  if (!parsed.success) return null;
  const p = parsed.data;
  return {
    ...EMPTY_RESUME,
    summary: p.summary.slice(0, 4000),
    skills: p.skills.slice(0, 100),
    projects: p.projects.slice(0, 30).map((x) => ({ title: x.title.slice(0, 300), technologies: x.technologies.slice(0, 40), summary: x.summary.slice(0, 2000) })),
    experience: p.experience
      .slice(0, 30)
      .map((x) => ({ organization: x.organization.slice(0, 300), role: x.role.slice(0, 300), kind: x.kind, months: x.months, summary: x.summary.slice(0, 2000) })),
    education: p.education.slice(0, 10).map((e) => [e.degree, e.field, e.institution, e.year].filter(Boolean).join(', ')),
    certifications: p.certifications.slice(0, 30),
    achievements: p.achievements.slice(0, 30),
  };
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}
