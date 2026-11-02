import { HttpStatus, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { screeningSettingsSchema, type JobScreeningSettings, type ScreeningSettings } from '@hireflow/contracts';
import { apiError, parseBody } from '../../common/api-error';
import { PrismaService } from '../../common/prisma.service';
import { AuditService } from '../audit';
import type { Actor } from '../tenants';
import { AUTO_REJECTION, AUTO_SHORTLIST, autoRejectionFromEnv, autoShortlistFromEnv, queueAutoRejections, queueAutoShortlists } from './auto-rejection';

/**
 * "Table does not exist": the ATS migration has not been applied to this database yet. Prisma says P2021 for
 * normal queries, and P2010 with PostgreSQL's 42P01 for raw SQL (the background claim queries).
 */
export const isMissingTable = (err: unknown) => {
  const e = err as { code?: unknown; meta?: { code?: unknown } } | null;
  return e?.code === 'P2021' || (e?.code === 'P2010' && e.meta?.code === '42P01');
};

export const atsNotReady = () =>
  apiError(
    HttpStatus.SERVICE_UNAVAILABLE,
    'ATS_NOT_READY',
    'ATS screening is not set up on the server yet (its database migration has not been applied).',
  );

/**
 * HR's private screening rules per job (M11). Stored in job_screening_settings, never in the job form: the form is
 * part of the public careers API, the minimum ATS score must stay inside the company's HR team.
 * Every query is scoped by the tenant id from the session, so another company's job is a 404.
 */
@Injectable()
export class ScreeningSettingsService {
  private readonly logger = new Logger('ScreeningSettings');

  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Optional() @Inject(AUTO_REJECTION) private readonly autoReject: boolean = autoRejectionFromEnv(),
    @Optional() @Inject(AUTO_SHORTLIST) private readonly autoShortlist: boolean = autoShortlistFromEnv(),
  ) {}

  async get(tenantId: string, jobId: string): Promise<JobScreeningSettings> {
    await this.requireJob(tenantId, jobId);
    const row = await this.find(tenantId, jobId);
    return toView(jobId, row);
  }

  /**
   * Sets the minimum ATS score. Candidates already scored for this job are re-sorted against the new value, except
   * those HR already decided on or already emailed (that decision is final). With automatic emails on, the screened
   * candidates now below the score get their rejection email, and those at or above it their shortlist email, at once.
   */
  async save(tenantId: string, jobId: string, input: unknown, actor: Actor | null): Promise<JobScreeningSettings> {
    const settings = parseBody(screeningSettingsSchema, input, 'INVALID_SCREENING_SETTINGS', 'The screening settings are invalid.');
    await this.requireJob(tenantId, jobId);
    try {
      let autoRejected: string[] = [];
      let autoShortlisted: string[] = [];
      const row = await this.db.$transaction(async (tx) => {
        const saved = await tx.jobScreeningSettings.upsert({
          where: { jobId },
          create: { jobId, tenantId, minAtsScore: settings.minAtsScore, updatedById: actor?.id ?? null },
          update: { minAtsScore: settings.minAtsScore, updatedById: actor?.id ?? null },
        });
        const open = { tenantId, jobId, status: 'SCORED' as const, hrDecision: null, application: { decisionEmail: { is: null } } };
        await tx.atsEvaluation.updateMany({
          where: { ...open, score: { gte: settings.minAtsScore } },
          data: { minAtsScore: settings.minAtsScore, systemDecision: 'SHORTLISTED' },
        });
        await tx.atsEvaluation.updateMany({
          where: { ...open, score: { lt: settings.minAtsScore } },
          data: { minAtsScore: settings.minAtsScore, systemDecision: 'NOT_SHORTLISTED' },
        });
        if (this.autoReject) autoRejected = await queueAutoRejections(tx, tenantId, { jobId });
        if (this.autoShortlist) autoShortlisted = await queueAutoShortlists(tx, tenantId, { jobId });
        return saved;
      });
      // HR-only audit log; the value itself is internal company data, never public.
      await this.audit.record({
        tenantId,
        actorUserId: actor?.id ?? null,
        action: 'ats.settings_updated',
        subjectType: 'job',
        subjectId: jobId,
        metadata: { minAtsScore: settings.minAtsScore, autoRejected: autoRejected.length, autoShortlisted: autoShortlisted.length },
      });
      return toView(jobId, row);
    } catch (err) {
      if (isMissingTable(err)) throw atsNotReady();
      throw err;
    }
  }

  /** The job's minimum ATS score, or null when HR has not set one. */
  async minScore(tenantId: string, jobId: string): Promise<number | null> {
    return (await this.find(tenantId, jobId))?.minAtsScore ?? null;
  }

  /**
   * For the publish check. A database without the ATS migration answers true (unknown), so publishing keeps
   * working exactly as before until the migration is applied.
   */
  async isSet(tenantId: string, jobId: string): Promise<boolean> {
    try {
      return !!(await this.db.jobScreeningSettings.findFirst({ where: { tenantId, jobId }, select: { jobId: true } }));
    } catch (err) {
      if (!isMissingTable(err)) throw err;
      this.logger.warn('job_screening_settings is missing (ATS migration not applied) - publish check skipped');
      return true;
    }
  }

  private async find(tenantId: string, jobId: string) {
    try {
      return await this.db.jobScreeningSettings.findFirst({ where: { tenantId, jobId } });
    } catch (err) {
      if (isMissingTable(err)) throw atsNotReady();
      throw err;
    }
  }

  private async requireJob(tenantId: string, jobId: string) {
    const job = await this.db.job.findFirst({ where: { id: jobId, tenantId }, select: { id: true } });
    if (!job) throw apiError(HttpStatus.NOT_FOUND, 'JOB_NOT_FOUND', 'Job not found.');
  }
}

function toView(jobId: string, row: { minAtsScore: number; updatedAt: Date } | null): JobScreeningSettings {
  return {
    jobId,
    settings: row ? ({ minAtsScore: row.minAtsScore } satisfies ScreeningSettings) : null,
    updatedAt: row?.updatedAt.toISOString() ?? null,
  };
}
