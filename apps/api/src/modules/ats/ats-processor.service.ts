import { Inject, Injectable, Logger, Optional, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { jdContentSchema, jobFormSchema, type ScreeningDecision } from '@hireflow/contracts';
import { Prisma } from '@prisma/client';
import { isFeatureOn } from '../../common/feature-flags';
import { PrismaService } from '../../common/prisma.service';
import { uuidv7 } from '../../common/uuidv7';
import { RESUME_STORAGE, type ResumeStorage } from '../applications';
import { AuditService } from '../audit';
import { AtsWorkerClient, AtsWorkerError } from './ats-worker.client';
import { AUTO_REJECTION, AUTO_SHORTLIST, autoRejectionFromEnv, autoShortlistFromEnv, queueAutoRejections, queueAutoShortlists } from './auto-rejection';
import { isMissingTable, ScreeningSettingsService } from './screening-settings.service';

export interface AtsProcessorConfig {
  /** Background loop on/off (env ATS_PROCESSING=off; always off in tests). */
  enabled: boolean;
  /** Decision email loop on/off - on its own, so pausing screening never holds back emails HR sent (FEATURE_ATS=off stops both). */
  emailsEnabled?: boolean;
  pollMs: number;
  /** Resumes screened at the same time by this API process. */
  concurrency: number;
  /** Tries per resume for technical errors before it goes to HR review. */
  maxAttempts: number;
  /** A claim older than this is taken over (the process that claimed it crashed). */
  staleMs: number;
  /** Tests only: work on this company's rows alone (tests share one database and run in parallel). */
  onlyTenantId?: string;
}

export const ATS_PROCESSOR_CONFIG = Symbol('ATS_PROCESSOR_CONFIG');

export const atsProcessorConfigFromEnv = (env: NodeJS.ProcessEnv = process.env): AtsProcessorConfig => ({
  enabled: isFeatureOn('ats', env) && !['off', 'false', '0'].includes((env.ATS_PROCESSING ?? '').trim().toLowerCase()) && env.NODE_ENV !== 'test',
  emailsEnabled: isFeatureOn('ats', env) && env.NODE_ENV !== 'test',
  pollMs: Number(env.ATS_POLL_MS) > 0 ? Number(env.ATS_POLL_MS) : 5_000,
  concurrency: Number(env.ATS_CONCURRENCY) > 0 ? Math.min(Number(env.ATS_CONCURRENCY), 10) : 2,
  maxAttempts: 5,
  staleMs: 15 * 60_000,
});

/** Wait after the 1st, 2nd, 3rd, 4th failed try (then HR review). */
const BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];
/** AI quota used up without a Retry-After: wait this long before screening anything again. */
const QUOTA_PAUSE_MS = 10 * 60_000;
/** After "the ATS tables do not exist" (migration not applied yet): look again this much later. */
const NOT_READY_PAUSE_MS = 5 * 60_000;

interface Claimed {
  id: string;
  tenant_id: string;
  application_id: string;
  job_id: string;
  jd_version_id: string;
  attempts: number;
}

/**
 * M10/M11 background screening. Every application gets one ats_evaluations row (queued right after it is saved,
 * so applying stays fast); this loop claims rows with FOR UPDATE SKIP LOCKED (never two workers on one row, also
 * across API processes), reads the resume, asks the AI worker for the parse + explainable score, and stores the
 * result with the job's minimum ATS score.
 *
 * A technical failure NEVER rejects anyone: it is retried with backoff, then marked NEEDS_REVIEW for HR.
 * Each application is screened against the JD version the student applied to (applications.jd_version_id).
 */
@Injectable()
export class AtsProcessor implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('AtsProcessor');
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private pausedUntil = 0;

  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(AtsWorkerClient) private readonly worker: AtsWorkerClient,
    @Inject(RESUME_STORAGE) private readonly storage: ResumeStorage,
    @Inject(ScreeningSettingsService) private readonly settings: ScreeningSettingsService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ATS_PROCESSOR_CONFIG) private readonly config: AtsProcessorConfig,
    @Optional() @Inject(AUTO_REJECTION) private readonly autoReject: boolean = autoRejectionFromEnv(),
    @Optional() @Inject(AUTO_SHORTLIST) private readonly autoShortlist: boolean = autoShortlistFromEnv(),
  ) {}

  onApplicationBootstrap() {
    if (!this.config.enabled) return;
    this.timer = setInterval(() => void this.tick(), this.config.pollMs);
    this.timer.unref();
    void this.tick();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * One round: queue new applications, then screen what is due. Never throws. Returns how many were handled.
   * `at` (tests only) pretends the round runs at that time; normally "due" is checked at each claim.
   */
  async tick(at?: Date): Promise<number> {
    if (this.running || Date.now() < this.pausedUntil) return 0;
    this.running = true;
    try {
      await this.enqueueNew();
      let handled = 0;
      for (;;) {
        if (Date.now() < this.pausedUntil) return handled; // e.g. the AI quota ran out during this round
        const batch = await this.claim(this.config.concurrency, at ?? new Date());
        if (!batch.length) return handled;
        await Promise.all(batch.map((row) => this.process(row)));
        handled += batch.length;
      }
    } catch (err) {
      if (isMissingTable(err)) {
        if (!this.pausedUntil) this.logger.warn('ATS tables are missing (migration not applied) - resume screening paused');
        this.pausedUntil = Date.now() + NOT_READY_PAUSE_MS;
      } else {
        this.logger.error(`ats tick failed (${err instanceof Error ? err.name : 'unknown'})`);
      }
      return 0;
    } finally {
      this.running = false;
    }
  }

  /** Applications without an evaluation row get one (new applications, and every older one once). */
  async enqueueNew(limit = 200): Promise<number> {
    const apps = await this.db.application.findMany({
      where: { atsEvaluation: { is: null }, ...(this.config.onlyTenantId ? { tenantId: this.config.onlyTenantId } : {}) },
      select: { id: true, tenantId: true, jobId: true, jdVersionId: true },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
    if (!apps.length) return 0;
    const { count } = await this.db.atsEvaluation.createMany({
      data: apps.map((a) => ({ id: uuidv7(), tenantId: a.tenantId, applicationId: a.id, jobId: a.jobId, jdVersionId: a.jdVersionId })),
      skipDuplicates: true, // unique application_id: a parallel round may have queued it already
    });
    return count;
  }

  private async claim(limit: number, now: Date): Promise<Claimed[]> {
    const stale = new Date(now.getTime() - this.config.staleMs);
    const scope = this.config.onlyTenantId ? Prisma.sql`AND tenant_id = ${this.config.onlyTenantId}::uuid` : Prisma.empty;
    return this.db.$queryRaw<Claimed[]>(Prisma.sql`
      UPDATE ats_evaluations
         SET status = 'PROCESSING'::ats_status, locked_at = ${now}, attempts = attempts + 1, updated_at = ${now}
       WHERE id IN (
         SELECT id FROM ats_evaluations
          WHERE ((status = 'PENDING'::ats_status AND next_attempt_at <= ${now})
             OR (status = 'PROCESSING'::ats_status AND locked_at < ${stale})) ${scope}
          ORDER BY next_attempt_at
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED)
      RETURNING id, tenant_id, application_id, job_id, jd_version_id, attempts`);
  }

  private async process(row: Claimed): Promise<void> {
    try {
      const input = await this.load(row);
      const result = await this.worker.screen(input);
      const minAtsScore = await this.settings.minScore(row.tenant_id, row.job_id);
      const systemDecision: ScreeningDecision | null =
        minAtsScore === null ? null : result.score >= minAtsScore ? 'SHORTLISTED' : 'NOT_SHORTLISTED';
      // score + automatic decision email in one transaction: a scored candidate is never left without the email
      // (nothing else would queue it later)
      let autoShortlisted = false;
      const autoRejected = await this.db.$transaction(async (tx) => {
        const { count } = await tx.atsEvaluation.updateMany({
          where: { id: row.id, status: 'PROCESSING' },
          data: {
            status: 'SCORED',
            parsedProfile: result.profile as Prisma.InputJsonValue,
            score: result.score,
            breakdown: result.breakdown as Prisma.InputJsonValue,
            matchedSkills: result.matchedSkills,
            missingSkills: result.missingSkills,
            minAtsScore,
            systemDecision,
            model: result.model,
            promptVersion: result.promptVersion,
            scoredAt: new Date(),
            lockedAt: null,
            lastError: null,
          },
        });
        if (!count) return null; // erased (DPDP) or taken over while we worked
        // at or above the job's minimum: the shortlist email (with the AI screening link) goes out at once
        if (this.autoShortlist && systemDecision === 'SHORTLISTED') {
          autoShortlisted = (await queueAutoShortlists(tx, row.tenant_id, { applicationIds: [row.application_id] })).length > 0;
        }
        // below the job's minimum: the rejection email goes out at once (DecisionEmailSender sends it)
        return this.autoReject && systemDecision === 'NOT_SHORTLISTED'
          ? (await queueAutoRejections(tx, row.tenant_id, { applicationIds: [row.application_id] })).length > 0
          : false;
      });
      if (autoRejected === null) return;
      // ids, score and decision only - never resume content
      await this.audit.record({
        tenantId: row.tenant_id,
        actorUserId: null,
        action: 'ats.scored',
        subjectType: 'application',
        subjectId: row.application_id,
        metadata: { score: result.score, minAtsScore, systemDecision, autoRejected, autoShortlisted, promptVersion: result.promptVersion },
      });
    } catch (err) {
      await this.failed(row, err);
    }
  }

  /** The resume file + the approved JD version and job form the student applied to. */
  private async load(row: Claimed) {
    const app = await this.db.application.findFirst({
      where: { id: row.application_id, tenantId: row.tenant_id },
      select: { resume: { select: { fileName: true, mimeType: true, storageKey: true, file: { select: { content: true } } } } },
    });
    const resume = app?.resume;
    if (!resume) throw new AtsWorkerError('The application has no resume file.', false, 'RESUME_MISSING');
    let bytes: Buffer;
    if (resume.storageKey) {
      try {
        bytes = await this.storage.get(resume.storageKey);
      } catch {
        throw new AtsWorkerError('The resume file could not be loaded from storage.', true, 'RESUME_STORAGE_FAILED');
      }
    } else if (resume.file) {
      bytes = Buffer.from(resume.file.content);
    } else {
      throw new AtsWorkerError('The application has no resume file.', false, 'RESUME_MISSING');
    }

    const [version, job] = await Promise.all([
      this.db.jdVersion.findFirst({ where: { id: row.jd_version_id, tenantId: row.tenant_id }, select: { content: true } }),
      this.db.job.findFirst({ where: { id: row.job_id, tenantId: row.tenant_id }, select: { formData: true } }),
    ]);
    const jd = jdContentSchema.safeParse(version?.content);
    const form = jobFormSchema.safeParse(job?.formData);
    if (!jd.success || !form.success) throw new AtsWorkerError('The job description of this application could not be read.', false, 'JD_UNREADABLE');
    return { resume: { fileName: resume.fileName, mimeType: resume.mimeType, bytes }, form: form.data, jd: jd.data };
  }

  private async failed(row: Claimed, err: unknown) {
    const known = err instanceof AtsWorkerError;
    if (!known) this.logger.error(`ats screening crashed application=${row.application_id} (${err instanceof Error ? err.name : 'unknown'})`);
    if (known && err.quota) return this.quotaReached(row, err);
    const retryable = known ? err.retryable : true;
    const message = known ? err.message : 'Unexpected error while screening the resume.';
    const giveUp = !retryable || row.attempts >= this.config.maxAttempts;
    const waitMs = known && err.retryAfterSeconds ? err.retryAfterSeconds * 1000 : BACKOFF_MS[Math.min(row.attempts - 1, BACKOFF_MS.length - 1)]!;
    try {
      await this.db.atsEvaluation.updateMany({
        where: { id: row.id, status: 'PROCESSING' },
        data: giveUp
          ? { status: 'NEEDS_REVIEW', lockedAt: null, lastError: message.slice(0, 500) }
          : { status: 'PENDING', lockedAt: null, lastError: message.slice(0, 500), nextAttemptAt: new Date(Date.now() + waitMs) },
      });
      if (giveUp) {
        this.logger.warn(`resume needs HR review application=${row.application_id} code=${known ? err.code : 'UNEXPECTED'}`);
      }
    } catch (saveErr) {
      // the stale-claim takeover retries it later
      this.logger.error(`ats failure not saved application=${row.application_id} (${saveErr instanceof Error ? saveErr.name : 'unknown'})`);
    }
  }

  /**
   * The AI quota is used up: not this resume's fault, and every other resume would fail the same way. The try is
   * not counted (no resume goes to HR review because of quota) and the whole loop waits.
   */
  private async quotaReached(row: Claimed, err: AtsWorkerError) {
    const waitMs = err.retryAfterSeconds ? err.retryAfterSeconds * 1000 : QUOTA_PAUSE_MS;
    if (Date.now() >= this.pausedUntil) this.logger.warn(`AI quota reached - resume screening paused for ${Math.round(waitMs / 1000)}s`);
    this.pausedUntil = Math.max(this.pausedUntil, Date.now() + waitMs);
    try {
      await this.db.atsEvaluation.updateMany({
        where: { id: row.id, status: 'PROCESSING' },
        data: { status: 'PENDING', lockedAt: null, attempts: Math.max(0, row.attempts - 1), lastError: err.message.slice(0, 500), nextAttemptAt: new Date(Date.now() + waitMs) },
      });
    } catch (saveErr) {
      this.logger.error(`ats quota pause not saved application=${row.application_id} (${saveErr instanceof Error ? saveErr.name : 'unknown'})`);
    }
  }
}
