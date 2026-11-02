import { HttpStatus, Inject, Injectable, Optional } from '@nestjs/common';
import {
  sendDecisionEmailsRequestSchema,
  setDecisionRequestSchema,
  type CandidateEmailKind,
  type ScreeningDecision,
  type SendDecisionEmailsResult,
} from '@hireflow/contracts';
import { apiError, parseBody } from '../../common/api-error';
import { PrismaService } from '../../common/prisma.service';
import { uuidv7 } from '../../common/uuidv7';
import { AuditService } from '../audit';
import type { Actor } from '../tenants';
import { AUTO_REJECTION, AUTO_SHORTLIST, autoRejectionFromEnv, autoShortlistFromEnv, queueAutoRejections, queueAutoShortlists } from './auto-rejection';
import { isMissingTable, atsNotReady } from './screening-settings.service';

export const SCREENING_BASE_URL = Symbol('SCREENING_BASE_URL');

const KIND_FOR: Record<ScreeningDecision, CandidateEmailKind> = { SHORTLISTED: 'SHORTLIST', NOT_SHORTLISTED: 'REJECTION' };

/** HR's final say: the ATS only suggests. Every query is scoped by the session's company. */
@Injectable()
export class DecisionService {
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(SCREENING_BASE_URL) private readonly screeningBaseUrl: string | null,
    @Optional() @Inject(AUTO_REJECTION) private readonly autoReject: boolean = autoRejectionFromEnv(),
    @Optional() @Inject(AUTO_SHORTLIST) private readonly autoShortlist: boolean = autoShortlistFromEnv(),
  ) {}

  /** Whether shortlist emails can be sent (the AI screening page's link is configured). */
  get shortlistEmailsReady(): boolean {
    return !!this.screeningBaseUrl;
  }

  /**
   * HR shortlists or rejects a screened candidate (null = back to the ATS suggestion). Not allowed once a decision
   * email went out or is on its way - what the candidate was told stays true. With automatic emails on, the candidate
   * is emailed at once for the decision they end up with (HR's choice, or back to the ATS suggestion).
   */
  async setDecision(tenantId: string, applicationId: string, input: unknown, actor: Actor) {
    const { decision } = parseBody(setDecisionRequestSchema, input, 'INVALID_DECISION', 'The decision is invalid.');
    const evaluation = await this.guard(() =>
      this.db.atsEvaluation.findFirst({
        where: { tenantId, applicationId },
        select: { id: true, status: true, application: { select: { decisionEmail: { select: { status: true } } } } },
      }),
    );
    if (!evaluation) throw notFound();
    if (evaluation.status !== 'SCORED') {
      throw apiError(HttpStatus.CONFLICT, 'NOT_SCREENED', 'This resume has not been screened successfully yet. Retry the screening or review the resume first.');
    }
    const email = evaluation.application.decisionEmail;
    if (email && email.status !== 'FAILED') {
      throw apiError(HttpStatus.CONFLICT, 'EMAIL_ALREADY_SENT', 'A decision email was already sent to this candidate, so the decision cannot change.');
    }
    await this.db.$transaction([
      this.db.atsEvaluation.update({
        where: { id: evaluation.id },
        data: { hrDecision: decision, hrDecidedById: decision ? actor.id : null, hrDecidedAt: decision ? new Date() : null },
      }),
      // an email that never arrived (FAILED) belongs to the old decision
      this.db.candidateEmail.deleteMany({ where: { tenantId, applicationId, status: 'FAILED' } }),
    ]);
    const rejectionEmailQueued = this.autoReject
      ? (await queueAutoRejections(this.db, tenantId, { applicationIds: [applicationId] })).length > 0
      : false;
    const shortlistEmailQueued = this.autoShortlist
      ? (await queueAutoShortlists(this.db, tenantId, { applicationIds: [applicationId] })).length > 0
      : false;
    await this.record(tenantId, actor, 'ats.decision_set', applicationId, { decision, rejectionEmailQueued, shortlistEmailQueued });
    return { applicationId, hrDecision: decision, rejectionEmailQueued, shortlistEmailQueued };
  }

  /**
   * HR sends the decision email to these candidates. Each one is checked on its own; the others still go.
   * The emails are queued here and sent by DecisionEmailSender in the background.
   */
  async sendEmails(tenantId: string, input: unknown, actor: Actor): Promise<SendDecisionEmailsResult> {
    const req = parseBody(sendDecisionEmailsRequestSchema, input, 'INVALID_EMAIL_REQUEST', 'The email request is invalid.');
    const ids = [...new Set(req.applicationIds)];
    if (req.kind === 'SHORTLIST' && !this.screeningBaseUrl) {
      throw apiError(
        HttpStatus.CONFLICT,
        'SCREENING_LINK_NOT_SET',
        'Shortlist emails need the AI screening link, which is not set up yet (AI_SCREENING_URL on the server).',
      );
    }
    const rows = await this.guard(() =>
      this.db.atsEvaluation.findMany({
        where: { tenantId, applicationId: { in: ids } },
        select: {
          applicationId: true,
          status: true,
          systemDecision: true,
          hrDecision: true,
          application: { select: { decisionEmail: { select: { status: true } } } },
        },
      }),
    );
    const byId = new Map(rows.map((r) => [r.applicationId, r]));
    const queued: string[] = [];
    const skipped: SendDecisionEmailsResult['skipped'] = [];
    for (const applicationId of ids) {
      const r = byId.get(applicationId);
      const reason = !r ? 'Not found.' : whyNot(req.kind, r);
      if (reason) {
        skipped.push({ applicationId, reason });
        continue;
      }
      // unique application_id: one decision email per candidate, even with two HR users clicking at once
      const created = await this.db.candidateEmail.createMany({
        data: { id: uuidv7(), tenantId, applicationId, kind: req.kind, requestedById: actor.id },
        skipDuplicates: true,
      });
      if (created.count) {
        queued.push(applicationId);
        continue;
      }
      // an earlier email of the same kind that never arrived: send it again
      const retried = await this.db.candidateEmail.updateMany({
        where: { tenantId, applicationId, kind: req.kind, status: 'FAILED' },
        data: { status: 'QUEUED', attempts: 0, nextAttemptAt: new Date(), lastError: null, lockedAt: null, requestedById: actor.id },
      });
      if (retried.count) queued.push(applicationId);
      else skipped.push({ applicationId, reason: 'A decision email was already sent to this candidate.' });
    }
    if (queued.length) await this.record(tenantId, actor, 'ats.emails_requested', null, { kind: req.kind, applicationIds: queued });
    return { queued, skipped };
  }

  /** HR: screen a resume again (after NEEDS_REVIEW, e.g. once the AI service is back or the file was replaced). */
  async retryScreening(tenantId: string, applicationId: string, actor: Actor) {
    const { count } = await this.guard(() =>
      this.db.atsEvaluation.updateMany({
        where: { tenantId, applicationId, status: 'NEEDS_REVIEW' },
        data: { status: 'PENDING', attempts: 0, nextAttemptAt: new Date(), lastError: null, lockedAt: null },
      }),
    );
    if (!count) {
      const exists = await this.db.atsEvaluation.findFirst({ where: { tenantId, applicationId }, select: { id: true } });
      if (!exists) throw notFound();
      throw apiError(HttpStatus.CONFLICT, 'NOT_IN_REVIEW', 'Only a resume waiting for HR review can be screened again.');
    }
    await this.record(tenantId, actor, 'ats.screening_retried', applicationId, {});
    return { applicationId, status: 'PENDING' as const };
  }

  private record(tenantId: string, actor: Actor, action: string, applicationId: string | null, metadata: Record<string, unknown>) {
    return this.audit.record({
      tenantId,
      actorUserId: actor.id,
      action,
      subjectType: 'application',
      subjectId: applicationId ?? undefined,
      metadata,
    });
  }

  private async guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (isMissingTable(err)) throw atsNotReady();
      throw err;
    }
  }
}

/** Why this candidate cannot get this email now (null = they can). */
function whyNot(
  kind: CandidateEmailKind,
  r: { status: string; systemDecision: ScreeningDecision | null; hrDecision: ScreeningDecision | null; application: { decisionEmail: { status: string } | null } },
): string | null {
  // a technical failure is never a rejection: no email until the resume was screened (or HR reviewed and decided)
  if (r.status !== 'SCORED') return 'The resume has not been screened successfully, so no decision email can be sent yet.';
  const decision = r.hrDecision ?? r.systemDecision;
  if (!decision) return 'Set the minimum ATS score for this job, or decide yourself, first.';
  if (KIND_FOR[decision] !== kind) {
    return kind === 'SHORTLIST' ? 'This candidate is not shortlisted.' : 'This candidate is shortlisted, not rejected.';
  }
  const email = r.application.decisionEmail;
  if (email && email.status !== 'FAILED') return 'A decision email was already sent to this candidate.';
  return null;
}

const notFound = () => apiError(HttpStatus.NOT_FOUND, 'APPLICATION_NOT_FOUND', 'Application not found.');
