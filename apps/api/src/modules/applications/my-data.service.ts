import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { myDataDeleteRequestSchema, myDataRequestSchema, type MyData } from '@hireflow/contracts';
import { PrismaService } from '../../common/prisma.service';
import { AuditService } from '../audit';
import { PublicJobsReader } from '../publisher';
import { applicationsError } from './applications.errors';
import { candidateEmailKey } from './applications.service';
import { EmailQueue } from './email/email-queue';
import { OtpService } from './otp/otp.service';
import { RESUME_STORAGE, type ResumeStorage } from './resume/resume-storage';

/**
 * DPDP rights for students (doc 14.2): see your data, and erase it.
 * There are no candidate accounts yet (M28), so a fresh phone OTP proves who you are.
 * Scope: one company (tenant) at a time - the company in the URL.
 */
@Injectable()
export class MyDataService {
  private readonly logger = new Logger('MyDataService');

  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(PublicJobsReader) private readonly jobs: PublicJobsReader,
    @Inject(OtpService) private readonly otp: OtpService,
    @Inject(AuditService) private readonly auditLog: AuditService,
    @Inject(EmailQueue) private readonly emails: EmailQueue,
    @Inject(RESUME_STORAGE) private readonly storage: ResumeStorage,
  ) {}

  async view(input: unknown): Promise<MyData> {
    const { tenantId, phone } = await this.authorise(myDataRequestSchema, input);
    const candidate = await this.db.candidate.findUnique({
      where: { tenantId_phone: { tenantId, phone } },
      include: {
        applications: { orderBy: { createdAt: 'desc' }, include: { resume: { select: { fileName: true } } } },
        consents: { orderBy: { grantedAt: 'desc' } },
      },
    });
    if (!candidate) return { candidate: null, applications: [], consents: [] };

    const titles = await this.jobs.jobTitles(tenantId, candidate.applications.map((a) => a.jobId));
    await this.audit(tenantId, 'candidate.data_viewed', candidate.id, { applications: candidate.applications.length });
    return {
      candidate: { name: candidate.name, email: candidate.email, phone: candidate.phone, city: candidate.city },
      applications: candidate.applications.map((a) => ({
        applicationId: a.id,
        jobTitle: titles.get(a.jobId) ?? 'Job no longer listed',
        appliedAt: a.createdAt.toISOString(),
        state: a.state,
        resumeFileName: a.resume?.fileName ?? null,
      })),
      consents: candidate.consents.map((c) => ({
        purpose: c.purpose,
        policyVersion: c.policyVersion,
        grantedAt: c.grantedAt.toISOString(),
        withdrawnAt: c.withdrawnAt?.toISOString() ?? null,
      })),
    };
  }

  /**
   * Erases everything this company holds about the student: resume files, resume details, consents,
   * applications, OTP challenges and the candidate row. One transaction - all or nothing.
   * The parser view stops showing the resumes immediately. Confirmation emails still queued are cancelled.
   * The candidate row is locked first (FOR UPDATE), so an application being saved for this phone at the same
   * moment either finishes before (and is deleted too) or waits until the delete is done.
   * TODO(M10/M11): when other modules store data per application (parsed profiles, scores), they must
   * delete it too - e.g. by listening for a candidate.data_deleted event once the M30 bus exists.
   */
  async erase(input: unknown): Promise<{ deletedApplications: number }> {
    const { tenantId, phone } = await this.authorise(myDataDeleteRequestSchema, input);
    let deleted: { candidateId: string | null; applications: number; storageKeys?: string[] };
    try {
      deleted = await this.db.$transaction(async (tx) => {
        await tx.phoneOtpChallenge.deleteMany({ where: { tenantId, phone } });
        const [candidate] = await tx.$queryRaw<{ id: string }[]>`
          SELECT "id" FROM "candidates" WHERE "tenant_id" = ${tenantId}::uuid AND "phone" = ${phone} FOR UPDATE`;
        if (!candidate) return { candidateId: null, applications: 0 };
        const apps = await tx.application.findMany({ where: { tenantId, candidateId: candidate.id }, select: { id: true } });
        const appIds = apps.map((a) => a.id);
        const resumes = await tx.resume.findMany({ where: { tenantId, applicationId: { in: appIds } }, select: { id: true, storageKey: true } });
        const resumeIds = resumes.map((r) => r.id);
        await tx.resumeFile.deleteMany({ where: { tenantId, resumeId: { in: resumeIds } } });
        await tx.resume.deleteMany({ where: { tenantId, id: { in: resumeIds } } });
        await tx.consent.deleteMany({ where: { tenantId, candidateId: candidate.id } });
        await tx.application.deleteMany({ where: { tenantId, id: { in: appIds } } });
        await tx.candidate.delete({ where: { id: candidate.id } });
        const storageKeys = resumes.map((r) => r.storageKey).filter((k): k is string => !!k);
        return { candidateId: candidate.id, applications: appIds.length, storageKeys };
      });
    } catch (err) {
      // A row that still points at this data was added meanwhile (e.g. by another module): nothing was deleted.
      if ((err as { code?: string }).code === 'P2003') {
        this.logger.warn(`candidate data delete hit a reference, rolled back tenant=${tenantId}`);
        throw applicationsError(HttpStatus.CONFLICT, 'DELETE_CONFLICT', 'Your data changed while we were deleting it. Nothing was deleted. Please try again.', { retryable: true });
      }
      throw err;
    }
    const { candidateId, applications: deletedApplications } = deleted;
    if (candidateId) this.emails.cancel(candidateEmailKey(tenantId, candidateId));
    // The files in cloud storage go after the records (a failed file delete must never keep the records alive).
    const keys = deleted.storageKeys ?? [];
    if (keys.length) {
      await this.storage.delete(keys).catch((e: unknown) =>
        // ids only; an operator removes these keys by hand
        this.logger.error(`DPDP: resume files NOT deleted from storage keys=${keys.join(',')} (${e instanceof Error ? e.message : 'unknown'})`),
      );
    }

    // Only the (now meaningless) candidate id and a count are kept as proof the request was honoured.
    await this.audit(tenantId, 'candidate.data_deleted', candidateId, { applications: deletedApplications });
    this.logger.log(`candidate data deleted tenant=${tenantId} applications=${deletedApplications}`);
    return { deletedApplications };
  }

  private async authorise<T extends typeof myDataRequestSchema | typeof myDataDeleteRequestSchema>(schema: T, input: unknown) {
    const parsed = schema.safeParse(input);
    if (!parsed.success) {
      throw applicationsError(HttpStatus.BAD_REQUEST, 'INVALID_REQUEST', parsed.error.issues[0]?.message ?? 'Invalid request.');
    }
    const company = await this.jobs.company(parsed.data.companySlug);
    if (!company) throw applicationsError(HttpStatus.NOT_FOUND, 'COMPANY_NOT_FOUND', 'Company not found.');
    const proof = this.otp.checkProof(parsed.data.otpToken, company.tenantId, parsed.data.phone);
    // A code sent by email must have gone to the email saved with this student's application.
    const saved = proof?.email
      ? await this.db.candidate.findUnique({
          where: { tenantId_phone: { tenantId: company.tenantId, phone: parsed.data.phone } },
          select: { email: true },
        })
      : null;
    if (!proof || (saved && saved.email.trim().toLowerCase() !== proof.email)) {
      throw applicationsError(HttpStatus.UNAUTHORIZED, 'PHONE_NOT_VERIFIED', 'Please verify your phone number again.');
    }
    return { tenantId: company.tenantId, phone: parsed.data.phone };
  }

  /** M32 audit log (Intern 1's audit_logs). No logged-in user: the student proved who they are with a phone OTP. */
  private async audit(tenantId: string, action: string, subjectId: string | null, metadata: Record<string, unknown>) {
    await this.auditLog.record({
      tenantId,
      actorUserId: null,
      action,
      subjectType: 'candidate',
      subjectId: subjectId ?? undefined,
      metadata: { actor: 'candidate', ...metadata },
    });
  }
}
