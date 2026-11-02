import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import type { HrApplication, JobApplications } from '@hireflow/contracts';
import { PrismaService } from '../../common/prisma.service';
import { AuditService } from '../audit';
import { PublicJobsReader } from '../publisher';
import type { Actor } from '../tenants';
import { applicationsError } from './applications.errors';
import { RESUME_STORAGE, ResumeStorageError, type ResumeStorage } from './resume/resume-storage';

export interface ResumeDownload {
  fileName: string;
  mimeType: string;
  bytes: Buffer;
}

/**
 * HR side of M09: who applied to a job, and their resume. Every query is scoped by the tenant id from the session,
 * so a job or application id of another company is a 404, never a leak.
 */
@Injectable()
export class HrApplicationsService {
  private readonly logger = new Logger('HrApplicationsService');

  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(PublicJobsReader) private readonly jobs: PublicJobsReader,
    @Inject(AuditService) private readonly auditLog: AuditService,
    @Inject(RESUME_STORAGE) private readonly storage: ResumeStorage,
  ) {}

  async listForJob(tenantId: string, jobId: string): Promise<JobApplications> {
    const title = (await this.jobs.jobTitles(tenantId, [jobId])).get(jobId);
    if (!title) throw applicationsError(HttpStatus.NOT_FOUND, 'JOB_NOT_FOUND', 'This job was not found or was never published.');

    const rows = await this.db.application.findMany({
      where: { tenantId, jobId },
      orderBy: { createdAt: 'desc' },
      include: {
        candidate: { select: { name: true, email: true, phone: true, city: true } },
        resume: { select: { fileName: true, mimeType: true, sizeBytes: true } },
      },
    });
    const screening = await this.screeningOf(tenantId, rows.map((r) => r.id));
    return {
      jobId,
      jobTitle: title,
      applications: rows.map((a) => ({
        applicationId: a.id,
        appliedAt: a.createdAt.toISOString(),
        state: a.state,
        source: a.source,
        name: a.candidate.name,
        email: a.email ?? a.candidate.email,
        phone: a.candidate.phone,
        city: a.candidate.city,
        college: a.college,
        degree: a.degree,
        branch: a.branch,
        graduationYear: a.graduationYear,
        scoreType: a.scoreType,
        scoreValue: a.scoreValue.toNumber(),
        linkedinUrl: a.linkedinUrl,
        githubUrl: a.githubUrl,
        portfolioUrl: a.portfolioUrl,
        projectUrl: a.projectUrl,
        resume: a.resume,
        screening: screening.get(a.id) ?? null,
      })),
    };
  }

  /**
   * M10/M11 screening summary per application. Its own query: a database without the ATS migration (or any problem
   * there) only leaves the summary out - the list of applications always works.
   */
  private async screeningOf(tenantId: string, applicationIds: string[]) {
    const out = new Map<string, NonNullable<HrApplication['screening']>>();
    if (!applicationIds.length) return out;
    try {
      const rows = await this.db.atsEvaluation.findMany({
        where: { tenantId, applicationId: { in: applicationIds } },
        select: {
          applicationId: true,
          status: true,
          score: true,
          systemDecision: true,
          hrDecision: true,
          application: { select: { decisionEmail: { select: { kind: true, status: true } } } },
        },
      });
      for (const r of rows) {
        out.set(r.applicationId, {
          status: r.status,
          score: r.score,
          decision: r.status === 'SCORED' ? (r.hrDecision ?? r.systemDecision) : null,
          decisionEmail: r.application.decisionEmail,
        });
      }
    } catch (err) {
      this.logger.warn(`screening summary left out (${(err as { code?: string }).code ?? (err instanceof Error ? err.name : 'unknown')})`);
    }
    return out;
  }

  /** The resume file of one application: from S3 when it has a storage key, else from resume_files (local dev). */
  async resume(tenantId: string, applicationId: string, actor: Actor): Promise<ResumeDownload> {
    const resume = await this.db.resume.findFirst({
      where: { tenantId, applicationId },
      select: { id: true, fileName: true, mimeType: true, storageKey: true, file: { select: { content: true } } },
    });
    if (!resume) throw applicationsError(HttpStatus.NOT_FOUND, 'RESUME_NOT_FOUND', 'No resume was found for this application.');

    let bytes: Buffer;
    if (resume.storageKey) {
      try {
        bytes = await this.storage.get(resume.storageKey);
      } catch (err) {
        this.logger.error(`resume download failed tenant=${tenantId} resume=${resume.id} (${err instanceof ResumeStorageError ? err.message : 'unknown'})`);
        throw applicationsError(HttpStatus.BAD_GATEWAY, 'RESUME_STORAGE_FAILED', 'The resume file could not be loaded. Please try again.');
      }
    } else if (resume.file) {
      bytes = Buffer.from(resume.file.content);
    } else {
      throw applicationsError(HttpStatus.NOT_FOUND, 'RESUME_NOT_FOUND', 'No resume was found for this application.');
    }

    // Who opened which student's resume (DPDP: access to personal data is logged).
    await this.auditLog.record({
      tenantId,
      actorUserId: actor.id,
      action: 'application.resume_downloaded',
      subjectType: 'application',
      subjectId: applicationId,
    });
    return { fileName: resume.fileName, mimeType: resume.mimeType, bytes };
  }
}
