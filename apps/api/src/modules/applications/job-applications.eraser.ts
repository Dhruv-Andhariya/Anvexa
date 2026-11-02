import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';
import { applicationsError } from './applications.errors';
import { candidateEmailKey } from './applications.service';
import { EmailQueue } from './email/email-queue';
import { RESUME_STORAGE, type ResumeStorage } from './resume/resume-storage';

/**
 * HR "Delete job": erases every application of one job - resume files, resume details, ATS results and candidate
 * emails (both cascade with the application) - in one transaction. A student left with no application at this
 * company is erased too (candidate row + consents), like the DPDP erase in MyDataService.
 * Call it after the job is unpublished, so no new application can arrive meanwhile.
 */
@Injectable()
export class JobApplicationsEraser {
  private readonly logger = new Logger('JobApplicationsEraser');

  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(EmailQueue) private readonly emails: EmailQueue,
    @Inject(RESUME_STORAGE) private readonly storage: ResumeStorage,
  ) {}

  /** Returns how many applications were deleted. */
  async eraseForJob(tenantId: string, jobId: string): Promise<number> {
    let deleted: { applications: number; candidateIds: string[]; storageKeys: string[] };
    try {
      deleted = await this.db.$transaction(async (tx) => {
        const apps = await tx.application.findMany({ where: { tenantId, jobId }, select: { id: true, candidateId: true } });
        if (!apps.length) return { applications: 0, candidateIds: [], storageKeys: [] };
        const appIds = apps.map((a) => a.id);
        const touched = [...new Set(apps.map((a) => a.candidateId))];
        // Lock the students first: an application to another job being saved for one of them right now either
        // finishes before (and keeps the student) or waits until this delete is done.
        await tx.$queryRaw`SELECT "id" FROM "candidates" WHERE "id" = ANY(${touched}::uuid[]) FOR UPDATE`;

        const resumes = await tx.resume.findMany({ where: { tenantId, applicationId: { in: appIds } }, select: { id: true, storageKey: true } });
        const resumeIds = resumes.map((r) => r.id);
        await tx.resumeFile.deleteMany({ where: { tenantId, resumeId: { in: resumeIds } } });
        await tx.resume.deleteMany({ where: { tenantId, id: { in: resumeIds } } });
        await tx.application.deleteMany({ where: { tenantId, id: { in: appIds } } });

        const stillApplied = await tx.application.findMany({
          where: { tenantId, candidateId: { in: touched } },
          select: { candidateId: true },
          distinct: ['candidateId'],
        });
        const keep = new Set(stillApplied.map((a) => a.candidateId));
        const candidateIds = touched.filter((id) => !keep.has(id));
        await tx.consent.deleteMany({ where: { tenantId, candidateId: { in: candidateIds } } });
        await tx.candidate.deleteMany({ where: { tenantId, id: { in: candidateIds } } });

        const storageKeys = resumes.map((r) => r.storageKey).filter((k): k is string => !!k);
        return { applications: appIds.length, candidateIds, storageKeys };
      });
    } catch (err) {
      // A row that still points at this data was added meanwhile (e.g. by another module): nothing was deleted.
      if ((err as { code?: string }).code === 'P2003') {
        this.logger.warn(`job applications delete hit a reference, rolled back tenant=${tenantId} job=${jobId}`);
        throw applicationsError(HttpStatus.CONFLICT, 'DELETE_CONFLICT', 'The applications of this job changed while we were deleting them. Nothing was deleted. Please try again.', { retryable: true });
      }
      throw err;
    }

    for (const candidateId of deleted.candidateIds) this.emails.cancel(candidateEmailKey(tenantId, candidateId));
    // The files in cloud storage go after the records (a failed file delete must never keep the records alive).
    const keys = deleted.storageKeys;
    if (keys.length) {
      await this.storage.delete(keys).catch((e: unknown) =>
        // ids only; an operator removes these keys by hand
        this.logger.error(`job delete: resume files NOT deleted from storage keys=${keys.join(',')} (${e instanceof Error ? e.message : 'unknown'})`),
      );
    }
    return deleted.applications;
  }
}
