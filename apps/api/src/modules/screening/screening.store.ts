import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  AI_SCREENING_CONSENT_VERSION,
  jdContentSchema,
  type AiScreeningExtraction,
  type AiScreeningResultStatus,
  type AiScreeningReviewStatus,
  type AiScreeningStatus,
  type AiScreeningStep,
  type AiScreeningTurnKind,
  type JdContent,
} from '@hireflow/contracts';
import { PrismaService } from '../../common/prisma.service';
import { uuidv7 } from '../../common/uuidv7';

/** All database access of the screening module. Every HR query is scoped by tenant; public ones by the link token. */

export interface InviteRow {
  applicationId: string;
  tenantId: string;
  expiresAt: Date;
}

/** The job form fields the flow needs (read leniently: older forms may lack some). */
export interface FormFacts {
  locations: string[];
  workMode: 'ONSITE' | 'HYBRID' | 'REMOTE' | null;
  employmentType: 'FULL_TIME' | 'PART_TIME' | 'INTERNSHIP' | 'CONTRACT' | null;
  deadline: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
  currency: string;
  salaryType: 'CTC' | 'IN_HAND';
}

export interface ScreeningContext {
  tenantId: string;
  applicationId: string;
  jobId: string;
  candidateId: string;
  candidateName: string;
  jobTitle: string;
  companyName: string;
  form: FormFacts;
  jd: JdContent | null;
}

export interface SessionRow {
  id: string;
  tenantId: string;
  applicationId: string;
  jobId: string;
  status: AiScreeningStatus;
  consentGivenAt: Date | null;
  pendingSeq: number;
  pendingStep: AiScreeningStep;
  pendingKind: AiScreeningTurnKind;
  pendingText: string;
  followUpsInStep: number;
  candidateQuestions: number;
  stepsDone: number;
  startedAt: Date | null;
  lastActivityAt: Date | null;
  completedAt: Date | null;
  endedReason: string | null;
  reviewStatus: AiScreeningReviewStatus;
}

export interface TurnRow {
  seq: number;
  step: AiScreeningStep;
  kind: AiScreeningTurnKind;
  question: string;
  answer: string;
  aiReply: string | null;
  clientTurnId: string;
  answerSeconds: number | null;
  createdAt: Date;
}

export interface NewTurn extends Omit<TurnRow, 'createdAt'> {
  model: string | null;
  promptVersion: string | null;
}

export interface PendingUpdate {
  seq: number;
  step: AiScreeningStep;
  kind: AiScreeningTurnKind;
  text: string;
  followUpsInStep: number;
  candidateQuestions: number;
  stepsDone: number;
  done: boolean;
}

export interface ResultRow {
  status: AiScreeningResultStatus;
  extraction: unknown;
  lastError: string | null;
  model: string | null;
  updatedAt: Date;
}

export interface HrRow {
  applicationId: string;
  jobId: string;
  candidateName: string;
  linkExpiresAt: Date | null;
  session: SessionRow | null;
  resultStatus: AiScreeningResultStatus | null;
}

export abstract class ScreeningStore {
  abstract findInvite(tokenHash: string): Promise<InviteRow | null>;
  abstract context(applicationId: string): Promise<ScreeningContext | null>;
  abstract session(applicationId: string): Promise<SessionRow | null>;
  /** Creates the session (NOT_STARTED, first question pending) if it does not exist yet; safe to call twice. */
  abstract ensureSession(ctx: ScreeningContext, firstQuestion: string): Promise<SessionRow>;
  abstract turns(sessionId: string): Promise<TurnRow[]>;
  /** NOT_STARTED -> IN_PROGRESS with the consent recorded; ENDED_EARLY -> IN_PROGRESS (resume). */
  abstract start(session: SessionRow, ctx: ScreeningContext, now: Date): Promise<SessionRow>;
  /** Saves the answered turn and moves the pending question on, only if `expectedSeq` is still pending. */
  abstract saveTurn(sessionId: string, expectedSeq: number, turn: NewTurn, next: PendingUpdate, now: Date): Promise<'saved' | 'stale'>;
  abstract endEarly(sessionId: string, now: Date): Promise<void>;
  abstract markInviteUsed(applicationId: string, now: Date): Promise<void>;
  /** PENDING + attempts+1. Returns false when another extraction is already running (recently started). */
  abstract beginResult(session: SessionRow, now: Date): Promise<boolean>;
  abstract finishResult(sessionId: string, data: { extraction: AiScreeningExtraction; model: string; promptVersion: string }): Promise<void>;
  abstract failResult(sessionId: string, error: string): Promise<void>;
  abstract result(sessionId: string): Promise<ResultRow | null>;
  abstract listForJob(tenantId: string, jobId: string): Promise<HrRow[]>;
  abstract hrRow(tenantId: string, applicationId: string): Promise<(HrRow & { jobTitle: string; consentGivenAt: Date | null }) | null>;
  abstract setReview(tenantId: string, applicationId: string, status: AiScreeningReviewStatus, actorId: string, now: Date): Promise<boolean>;
}

/** An extraction older than this without an answer is considered dead and may be started again. */
const RESULT_STALE_MS = 5 * 60_000;

const SESSION_SELECT = {
  id: true,
  tenantId: true,
  applicationId: true,
  jobId: true,
  status: true,
  consentGivenAt: true,
  pendingSeq: true,
  pendingStep: true,
  pendingKind: true,
  pendingText: true,
  followUpsInStep: true,
  candidateQuestions: true,
  stepsDone: true,
  startedAt: true,
  lastActivityAt: true,
  completedAt: true,
  endedReason: true,
  reviewStatus: true,
} as const;

@Injectable()
export class PrismaScreeningStore extends ScreeningStore {
  constructor(@Inject(PrismaService) private readonly db: PrismaService) {
    super();
  }

  async findInvite(tokenHash: string): Promise<InviteRow | null> {
    const invite = await this.db.screeningInvite.findUnique({ where: { tokenHash } });
    return invite ? { applicationId: invite.applicationId, tenantId: invite.tenantId, expiresAt: invite.expiresAt } : null;
  }

  async context(applicationId: string): Promise<ScreeningContext | null> {
    const app = await this.db.application.findUnique({ where: { id: applicationId }, include: { candidate: true } });
    if (!app) return null;
    const [job, version, tenant] = await Promise.all([
      this.db.job.findFirst({ where: { id: app.jobId, tenantId: app.tenantId } }),
      this.db.jdVersion.findFirst({ where: { id: app.jdVersionId, tenantId: app.tenantId } }),
      this.db.tenant.findUnique({ where: { id: app.tenantId }, include: { companyProfile: true } }),
    ]);
    if (!job || !tenant) return null;
    const jd = jdContentSchema.safeParse(version?.content);
    return {
      tenantId: app.tenantId,
      applicationId: app.id,
      jobId: app.jobId,
      candidateId: app.candidateId,
      candidateName: app.candidate.name,
      jobTitle: (jd.success && jd.data.title) || job.title,
      companyName: tenant.companyProfile?.name || tenant.name,
      form: formFacts(job.formData),
      jd: jd.success ? jd.data : null,
    };
  }

  async session(applicationId: string): Promise<SessionRow | null> {
    return this.db.screeningSession.findUnique({ where: { applicationId }, select: SESSION_SELECT });
  }

  async ensureSession(ctx: ScreeningContext, firstQuestion: string): Promise<SessionRow> {
    const existing = await this.session(ctx.applicationId);
    if (existing) return existing;
    try {
      return await this.db.screeningSession.create({
        data: { tenantId: ctx.tenantId, applicationId: ctx.applicationId, jobId: ctx.jobId, pendingText: firstQuestion },
        select: SESSION_SELECT,
      });
    } catch (err) {
      // two tabs opened the link at once: the other one created it
      if (isUniqueViolation(err)) return (await this.session(ctx.applicationId))!;
      throw err;
    }
  }

  async turns(sessionId: string): Promise<TurnRow[]> {
    return this.db.screeningTurn.findMany({
      where: { sessionId },
      orderBy: { seq: 'asc' },
      select: { seq: true, step: true, kind: true, question: true, answer: true, aiReply: true, clientTurnId: true, answerSeconds: true, createdAt: true },
    });
  }

  async start(session: SessionRow, ctx: ScreeningContext, now: Date): Promise<SessionRow> {
    if (session.status === 'NOT_STARTED') {
      await this.db.$transaction(async (tx) => {
        const { count } = await tx.screeningSession.updateMany({
          where: { id: session.id, status: 'NOT_STARTED' },
          data: { status: 'IN_PROGRESS', startedAt: now, lastActivityAt: now, consentGivenAt: now },
        });
        if (count !== 1) return; // started in another tab meanwhile
        const consent = await tx.consent.create({
          data: {
            id: uuidv7(),
            tenantId: ctx.tenantId,
            candidateId: ctx.candidateId,
            applicationId: ctx.applicationId,
            purpose: 'ai_voice_screening',
            policyVersion: AI_SCREENING_CONSENT_VERSION,
            grantedAt: now,
          },
        });
        await tx.screeningSession.update({ where: { id: session.id }, data: { consentId: consent.id } });
      });
    } else if (session.status === 'ENDED_EARLY') {
      await this.db.screeningSession.updateMany({
        where: { id: session.id, status: 'ENDED_EARLY' },
        data: { status: 'IN_PROGRESS', endedReason: null, lastActivityAt: now },
      });
    }
    return (await this.session(session.applicationId))!;
  }

  async saveTurn(sessionId: string, expectedSeq: number, turn: NewTurn, next: PendingUpdate, now: Date): Promise<'saved' | 'stale'> {
    try {
      return await this.db.$transaction(async (tx) => {
        const { count } = await tx.screeningSession.updateMany({
          where: { id: sessionId, pendingSeq: expectedSeq, status: 'IN_PROGRESS' },
          data: {
            pendingSeq: next.seq,
            pendingStep: next.step,
            pendingKind: next.kind,
            pendingText: next.text,
            followUpsInStep: next.followUpsInStep,
            candidateQuestions: next.candidateQuestions,
            stepsDone: next.stepsDone,
            lastActivityAt: now,
            ...(next.done ? { status: 'COMPLETED' as const, completedAt: now } : {}),
          },
        });
        if (count !== 1) return 'stale' as const;
        const session = await tx.screeningSession.findUniqueOrThrow({ where: { id: sessionId }, select: { tenantId: true } });
        await tx.screeningTurn.create({ data: { ...turn, sessionId, tenantId: session.tenantId } });
        return 'saved' as const;
      });
    } catch (err) {
      if (isUniqueViolation(err)) return 'stale'; // the same upload (clientTurnId) or seq was saved by a parallel request
      throw err;
    }
  }

  async endEarly(sessionId: string, now: Date): Promise<void> {
    await this.db.screeningSession.updateMany({
      where: { id: sessionId, status: 'IN_PROGRESS' },
      data: { status: 'ENDED_EARLY', endedReason: 'CANDIDATE_ENDED', lastActivityAt: now },
    });
  }

  async markInviteUsed(applicationId: string, now: Date): Promise<void> {
    await this.db.screeningInvite.updateMany({ where: { applicationId, usedAt: null }, data: { usedAt: now } });
  }

  async beginResult(session: SessionRow, now: Date): Promise<boolean> {
    const existing = await this.db.screeningResult.findUnique({ where: { sessionId: session.id } });
    if (!existing) {
      try {
        await this.db.screeningResult.create({ data: { tenantId: session.tenantId, sessionId: session.id, attempts: 1 } });
        return true;
      } catch (err) {
        if (isUniqueViolation(err)) return false;
        throw err;
      }
    }
    if (existing.status === 'PENDING' && now.getTime() - existing.updatedAt.getTime() < RESULT_STALE_MS) return false;
    const { count } = await this.db.screeningResult.updateMany({
      where: { sessionId: session.id, updatedAt: existing.updatedAt },
      data: { status: 'PENDING', lastError: null, attempts: { increment: 1 } },
    });
    return count === 1;
  }

  async finishResult(sessionId: string, data: { extraction: AiScreeningExtraction; model: string; promptVersion: string }): Promise<void> {
    await this.db.screeningResult.update({
      where: { sessionId },
      data: { status: 'DONE', extraction: data.extraction as Prisma.InputJsonObject, model: data.model, promptVersion: data.promptVersion, lastError: null },
    });
  }

  async failResult(sessionId: string, error: string): Promise<void> {
    await this.db.screeningResult.update({ where: { sessionId }, data: { status: 'FAILED', lastError: error.slice(0, 300) } });
  }

  async result(sessionId: string): Promise<ResultRow | null> {
    const r = await this.db.screeningResult.findUnique({ where: { sessionId } });
    return r ? { status: r.status, extraction: r.extraction, lastError: r.lastError, model: r.model, updatedAt: r.updatedAt } : null;
  }

  async listForJob(tenantId: string, jobId: string): Promise<HrRow[]> {
    const apps = await this.db.application.findMany({
      where: { tenantId, jobId, OR: [{ screeningInvite: { isNot: null } }, { screeningSession: { isNot: null } }] },
      orderBy: { createdAt: 'asc' },
      include: {
        candidate: { select: { name: true } },
        screeningInvite: { select: { expiresAt: true } },
        screeningSession: { select: { ...SESSION_SELECT, result: { select: { status: true } } } },
      },
    });
    return apps.map((a) => toHrRow(a));
  }

  async hrRow(tenantId: string, applicationId: string) {
    const a = await this.db.application.findFirst({
      where: { id: applicationId, tenantId },
      include: {
        candidate: { select: { name: true } },
        screeningInvite: { select: { expiresAt: true } },
        screeningSession: { select: { ...SESSION_SELECT, result: { select: { status: true } } } },
      },
    });
    if (!a || (!a.screeningInvite && !a.screeningSession)) return null;
    const job = await this.db.job.findFirst({ where: { id: a.jobId, tenantId }, select: { title: true } });
    return { ...toHrRow(a), jobTitle: job?.title ?? '', consentGivenAt: a.screeningSession?.consentGivenAt ?? null };
  }

  async setReview(tenantId: string, applicationId: string, status: AiScreeningReviewStatus, actorId: string, now: Date): Promise<boolean> {
    const { count } = await this.db.screeningSession.updateMany({
      where: { tenantId, applicationId },
      data: { reviewStatus: status, reviewedById: actorId, reviewedAt: now },
    });
    return count === 1;
  }
}

type AppWithScreening = {
  id: string;
  jobId: string;
  candidate: { name: string };
  screeningInvite: { expiresAt: Date } | null;
  screeningSession: (SessionRow & { result: { status: AiScreeningResultStatus } | null }) | null;
};

function toHrRow(a: AppWithScreening): HrRow {
  const { result, ...session } = a.screeningSession ?? { result: null };
  return {
    applicationId: a.id,
    jobId: a.jobId,
    candidateName: a.candidate.name,
    linkExpiresAt: a.screeningInvite?.expiresAt ?? null,
    session: a.screeningSession ? (session as SessionRow) : null,
    resultStatus: result?.status ?? null,
  };
}

/** The job form, read leniently (a stored form from an older version must never break a screening). */
export function formFacts(raw: unknown): FormFacts {
  const f = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const oneOf = <T extends string>(v: unknown, values: readonly T[]): T | null => (values.includes(v as T) ? (v as T) : null);
  return {
    locations: Array.isArray(f.locations) ? f.locations.filter((l): l is string => typeof l === 'string' && !!l.trim()).slice(0, 20) : [],
    workMode: oneOf(f.workMode, ['ONSITE', 'HYBRID', 'REMOTE'] as const),
    employmentType: oneOf(f.employmentType, ['FULL_TIME', 'PART_TIME', 'INTERNSHIP', 'CONTRACT'] as const),
    deadline: str(f.deadline),
    salaryMin: num(f.salaryMin),
    salaryMax: num(f.salaryMax),
    currency: str(f.currency) ?? 'INR',
    salaryType: f.salaryType === 'IN_HAND' ? 'IN_HAND' : 'CTC',
  };
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}
