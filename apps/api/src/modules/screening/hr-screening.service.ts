import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  aiScreeningExtractionSchema,
  aiScreeningReviewRequestSchema,
  type AiScreeningDetail,
  type AiScreeningDisplayStatus,
  type AiScreeningJobList,
  type AiScreeningSummary,
} from '@hireflow/contracts';
import type { Actor } from '../tenants';
import { AuditService } from '../audit';
import { TOTAL_STEPS } from './flow';
import { screeningError } from './screening.errors';
import { SCREENING_CLOCK, ScreeningService } from './screening.service';
import { ScreeningStore, type HrRow } from './screening.store';

/** A screening in progress with no activity for this long is shown to HR as INTERRUPTED (left midway). */
export const IDLE_MINUTES = 30;

/**
 * The HR side of the AI screening round: per job, per application. The company always comes from HR's session
 * (callers pass the verified tenant id); another company's application id is a 404.
 */
@Injectable()
export class HrScreeningService {
  constructor(
    @Inject(ScreeningStore) private readonly store: ScreeningStore,
    @Inject(ScreeningService) private readonly screening: ScreeningService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(SCREENING_CLOCK) private readonly now: () => Date,
  ) {}

  async listForJob(tenantId: string, jobId: string): Promise<AiScreeningJobList> {
    const rows = await this.store.listForJob(tenantId, jobId);
    return { jobId, items: rows.map((r) => this.summary(r)) };
  }

  async detail(tenantId: string, applicationId: string): Promise<AiScreeningDetail> {
    const row = await this.store.hrRow(tenantId, applicationId);
    if (!row) throw notFound();
    const turns = row.session ? await this.store.turns(row.session.id) : [];
    const result = row.session ? await this.store.result(row.session.id) : null;
    const extraction = result?.extraction ? aiScreeningExtractionSchema.safeParse(result.extraction) : null;
    return {
      ...this.summary(row),
      jobId: row.jobId,
      jobTitle: row.jobTitle,
      consentGivenAt: iso(row.consentGivenAt),
      endedReason: row.session?.endedReason ?? null,
      turns: turns.map((t) => ({
        seq: t.seq,
        step: t.step,
        kind: t.kind,
        question: t.question,
        answer: t.answer,
        aiReply: t.aiReply,
        answeredAt: t.createdAt.toISOString(),
        answerSeconds: t.answerSeconds,
      })),
      result: result
        ? {
            status: result.status,
            extraction: extraction?.success ? extraction.data : null,
            error: result.lastError,
            model: result.model,
            updatedAt: result.updatedAt.toISOString(),
          }
        : null,
    };
  }

  async setReview(tenantId: string, applicationId: string, body: unknown, actor: Actor): Promise<AiScreeningDetail> {
    const parsed = aiScreeningReviewRequestSchema.safeParse(body);
    if (!parsed.success) throw screeningError(HttpStatus.BAD_REQUEST, 'INVALID_REVIEW', 'Choose a review status.');
    if (!(await this.store.setReview(tenantId, applicationId, parsed.data.reviewStatus, actor.id, this.now()))) throw notFound();
    await this.audit.record({
      tenantId,
      actorUserId: actor.id,
      action: 'screening.reviewed',
      subjectType: 'application',
      subjectId: applicationId,
      metadata: { reviewStatus: parsed.data.reviewStatus },
    });
    return this.detail(tenantId, applicationId);
  }

  /** Create the structured summary again (e.g. after "summary failed"). The transcript is never changed. */
  async retrySummary(tenantId: string, applicationId: string): Promise<AiScreeningDetail> {
    const row = await this.store.hrRow(tenantId, applicationId);
    if (!row?.session) throw notFound();
    if (!(await this.store.turns(row.session.id)).length) {
      throw screeningError(HttpStatus.CONFLICT, 'NOTHING_TO_SUMMARISE', 'The candidate has not answered any question yet.');
    }
    await this.screening.extract(row.session);
    return this.detail(tenantId, applicationId);
  }

  private summary(r: HrRow): AiScreeningSummary {
    const s = r.session;
    return {
      applicationId: r.applicationId,
      candidateName: r.candidateName,
      status: displayStatus(r, this.now()),
      linkExpiresAt: iso(r.linkExpiresAt),
      startedAt: iso(s?.startedAt ?? null),
      completedAt: iso(s?.completedAt ?? null),
      lastActivityAt: iso(s?.lastActivityAt ?? null),
      stepsDone: s?.stepsDone ?? 0,
      totalSteps: TOTAL_STEPS,
      resultStatus: r.resultStatus,
      reviewStatus: s?.reviewStatus ?? 'PENDING',
    };
  }
}

export function displayStatus(r: Pick<HrRow, 'session' | 'linkExpiresAt'>, now: Date): AiScreeningDisplayStatus {
  const s = r.session;
  if (s?.status === 'COMPLETED') return 'COMPLETED';
  if (r.linkExpiresAt && r.linkExpiresAt.getTime() <= now.getTime()) return 'EXPIRED';
  if (!s || s.status === 'NOT_STARTED') return 'NOT_STARTED';
  if (s.status === 'ENDED_EARLY') return 'INTERRUPTED';
  const idleSince = s.lastActivityAt ?? s.startedAt;
  if (idleSince && now.getTime() - idleSince.getTime() > IDLE_MINUTES * 60_000) return 'INTERRUPTED';
  return 'IN_PROGRESS';
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);
const notFound = () => screeningError(HttpStatus.NOT_FOUND, 'SCREENING_NOT_FOUND', 'No AI screening found for this application.');
