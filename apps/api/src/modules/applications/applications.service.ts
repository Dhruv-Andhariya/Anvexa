import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  applicationReceivedEvent,
  applyFormSchema,
  CONSENT_POLICY_VERSION,
  RESUME_LIMITS,
  type ApplicationReceipt,
  type ApplyForm,
} from '@hireflow/contracts';
import { PrismaService } from '../../common/prisma.service';
import { uuidv7 } from '../../common/uuidv7';
import { PublicJobsReader } from '../publisher';
import { applicationsError } from './applications.errors';
import { buildConfirmationEmail } from './email/confirmation-email';
import { EmailQueue } from './email/email-queue';
import { OtpService } from './otp/otp.service';
import { checkResume, type ResumeProblem } from './resume/file-check';
import { RESUME_STORAGE, ResumeStorageError, resumeKey, type ResumeStorage } from './resume/resume-storage';
import { ScannerUnavailableError, VIRUS_SCANNER, type VirusScanner } from './resume/virus-scanner';

export interface IntakeInput {
  companySlug: string;
  jobSlug: string;
  /** JSON string of the ApplyForm (multipart field "application"). */
  application: unknown;
  resume?: { buffer: Buffer; originalname?: string };
}

const FILE_MESSAGES: Record<ResumeProblem, [number, string, string]> = {
  EMPTY: [HttpStatus.BAD_REQUEST, 'RESUME_EMPTY', 'The resume file is empty.'],
  TOO_LARGE: [HttpStatus.PAYLOAD_TOO_LARGE, 'RESUME_TOO_LARGE', 'The resume must be 5 MB or smaller.'],
  UNSUPPORTED_TYPE: [HttpStatus.UNSUPPORTED_MEDIA_TYPE, 'RESUME_TYPE', 'Upload your resume as a PDF or Word (.docx) file.'],
  EXTENSION_MISMATCH: [HttpStatus.UNSUPPORTED_MEDIA_TYPE, 'RESUME_TYPE', 'The file name does not match its content. Upload a real PDF or .docx file.'],
};

/**
 * When hundreds of students submit at once, transactions queue for a pooled DB connection. Prisma's default
 * maxWait (2 s) then fails the late ones with P2028 (seen at 200 parallel submits); each save itself takes
 * milliseconds, so waiting longer in the queue is safe and every application gets saved.
 */
const INTAKE_TX = { maxWait: 30_000, timeout: 30_000 };

/** 410 for a closed / past-deadline job - checked when the request arrives and again inside the save transaction. */
const jobClosed = () => applicationsError(HttpStatus.GONE, 'JOB_CLOSED', "We're sorry, this job is no longer open.");

/** EmailQueue key of a candidate's emails, so deleting their data (DPDP) can cancel what is still queued. */
export const candidateEmailKey = (tenantId: string, candidateId: string) => `candidate:${tenantId}:${candidateId}`;

/** Which unique constraint a Prisma P2002 hit. `meta.target` is the column list or the index name. */
export function uniqueViolation(err: unknown): 'application' | 'candidate' | undefined {
  const e = err as { code?: unknown; meta?: { target?: unknown; modelName?: unknown } };
  if (e?.code !== 'P2002') return undefined;
  const target = ([] as unknown[]).concat(e.meta?.target ?? []).map(String).join(',').toLowerCase();
  // candidates_tenant_id_phone_key: two first applications of the same new phone at the same moment.
  if (e.meta?.modelName === 'Candidate' || /phone/.test(target)) return 'candidate';
  // applications (tenant, job, candidate) or (tenant, job, email): this person already applied for this job.
  if (e.meta?.modelName === 'Application' || /candidate_?id|email|applications_/.test(target)) return 'application';
  return undefined;
}

/** M09 applications intake: check -> scan -> dedupe -> save (one transaction) -> application.received. */
@Injectable()
export class ApplicationsService {
  private readonly logger = new Logger('ApplicationsService');

  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(PublicJobsReader) private readonly jobs: PublicJobsReader,
    @Inject(OtpService) private readonly otp: OtpService,
    @Inject(VIRUS_SCANNER) private readonly scanner: VirusScanner,
    @Inject(EmailQueue) private readonly emails: EmailQueue,
    @Inject(RESUME_STORAGE) private readonly storage: ResumeStorage,
  ) {}

  async submit(input: IntakeInput): Promise<ApplicationReceipt> {
    const form = parseForm(input.application);

    const found = await this.jobs.job(input.companySlug, input.jobSlug);
    if (!found) throw applicationsError(HttpStatus.NOT_FOUND, 'JOB_NOT_FOUND', 'This job does not exist.');
    if (found.view.status !== 'LIVE') throw jobClosed();
    const tenantId = found.company.tenantId;

    if (!this.otp.checkProof(form.otpToken, tenantId, form.phone)) {
      throw applicationsError(HttpStatus.UNAUTHORIZED, 'PHONE_NOT_VERIFIED', 'Please verify your phone number again.');
    }

    if (!input.resume) throw applicationsError(HttpStatus.BAD_REQUEST, 'RESUME_REQUIRED', 'Please attach your resume.');
    const checked = checkResume(input.resume.buffer, input.resume.originalname);
    if (!checked.ok) {
      const [status, code, message] = FILE_MESSAGES[checked.problem];
      throw applicationsError(status, code, message);
    }

    let verdict;
    try {
      verdict = await this.scanner.scan(input.resume.buffer);
    } catch (err) {
      // Fail closed: an unscanned file is never stored.
      this.logger.error(`virus scan unavailable (${err instanceof ScannerUnavailableError ? err.message : 'unknown'})`);
      throw applicationsError(HttpStatus.SERVICE_UNAVAILABLE, 'SCANNER_UNAVAILABLE', 'We could not check your file right now. Please try again in a few minutes.');
    }
    if (verdict !== 'clean') {
      this.logger.warn(`resume rejected by virus scan tenant=${tenantId} job=${found.listing.jobId}`);
      throw applicationsError(HttpStatus.UNPROCESSABLE_ENTITY, 'RESUME_REJECTED', 'This file could not be accepted. Please upload a fresh copy of your resume.');
    }

    const jobId = found.listing.jobId;
    const { applicationId, candidateId, appliedAt } = await this.save(
      tenantId,
      jobId,
      found.listing.approved.jdVersionId,
      form,
      checked.resume,
      input.resume.buffer,
    );

    const evt = applicationReceivedEvent.parse({
      id: `evt_${uuidv7()}`,
      type: 'application.received',
      version: 1,
      tenant_id: tenantId,
      occurred_at: new Date().toISOString(),
      correlation_id: applicationId,
      producer: 'applications',
      data: { application_id: applicationId, job_id: jobId, source: form.source || 'direct' },
    });
    // TODO(M30): write to the outbox instead of logging when the event bus lands. Ids only - no personal data.
    this.logger.log(`${evt.type} tenant=${tenantId} job=${evt.data.job_id} application=${applicationId}`);

    const urls = this.jobs.urls(found.company.slug, found.listing.slug);
    const confirmationEmailSent = this.queueConfirmation(tenantId, candidateId, form.email, {
      candidateName: form.name,
      companyName: found.company.name,
      jobTitle: found.view.jd.title,
      applicationId,
      jobId,
      appliedAt,
      jobPageUrl: urls.jobPage,
      companyCareersUrl: found.company.careersPageUrl,
      myDataUrl: urls.myData,
    });

    return {
      applicationId,
      jobId,
      jobTitle: found.view.jd.title,
      companyName: found.company.name,
      appliedAt: appliedAt.toISOString(),
      confirmationEmailSent,
    };
  }

  /**
   * "Thanks for applying" email, queued AFTER the application is saved, so the student gets the receipt at once
   * even when hundreds apply together. A mail problem never loses an application; it only leaves
   * confirmation_email_sent_at empty. Returns true when QUEUED (not yet sent), false when email is switched off.
   */
  private queueConfirmation(
    tenantId: string,
    candidateId: string,
    to: string,
    input: Parameters<typeof buildConfirmationEmail>[0],
  ): boolean {
    if (!this.emails.enabled) return false;
    this.emails.enqueue({
      to,
      message: buildConfirmationEmail(input),
      ref: `tenant=${tenantId} application=${input.applicationId}`, // ids only: never the address or the message
      key: candidateEmailKey(tenantId, candidateId),
      onSent: () =>
        this.db.application.updateMany({
          where: { tenantId, id: input.applicationId },
          data: { confirmationEmailSentAt: new Date() },
        }),
    });
    return true;
  }

  private async save(
    tenantId: string,
    jobId: string,
    jdVersionId: string,
    form: ApplyForm,
    resume: { fileName: string; mimeType: string; sizeBytes: number; sha256: string },
    bytes: Buffer,
  ): Promise<{ applicationId: string; candidateId: string; appliedAt: Date }> {
    const alreadyApplied = () =>
      applicationsError(HttpStatus.CONFLICT, 'ALREADY_APPLIED', 'You have already applied for this job with this phone number or email.');

    // Cheap early answer for a repeat submit, before uploading the file (the transaction checks again).
    if (await this.findDuplicate(this.db, tenantId, jobId, form)) throw alreadyApplied();

    // The file goes to cloud storage FIRST; the database only records where it is. If saving the record then
    // fails, the uploaded file is removed again, so no file is left without a record.
    const resumeId = uuidv7();
    const storageKey = this.storage.kind === 's3' ? resumeKey(tenantId, resumeId, resume.mimeType) : null;
    if (storageKey) {
      try {
        await this.storage.put(storageKey, bytes, resume.mimeType);
      } catch (err) {
        this.logger.error(`resume upload failed tenant=${tenantId} (${err instanceof ResumeStorageError ? err.message : 'unknown'})`);
        throw applicationsError(
          HttpStatus.SERVICE_UNAVAILABLE,
          'RESUME_STORAGE_UNAVAILABLE',
          'We could not save your resume right now. Please try again in a few minutes.',
        );
      }
    }

    try {
      for (let attempt = 0; ; attempt++) {
        try {
          return await this.saveOnce(tenantId, jobId, jdVersionId, form, { ...resume, id: resumeId, storageKey }, bytes, alreadyApplied);
        } catch (err) {
          const conflict = uniqueViolation(err);
          if (conflict === 'application') throw alreadyApplied(); // lost a race with a parallel submit for this job
          // Same new phone applying to two jobs at once: both tried to create the candidate. The other one exists
          // now, so one more try updates it instead.
          if (conflict === 'candidate' && attempt === 0) continue;
          throw err;
        }
      }
    } catch (err) {
      if (storageKey) {
        await this.storage
          .delete([storageKey])
          .catch((e: unknown) =>
            this.logger.error(`orphan resume file left in storage key=${storageKey} (${e instanceof Error ? e.message : 'unknown'})`),
          );
      }
      throw err;
    }
  }

  /** Dedupe (doc M09): same phone OR same email for the same job. The email is the one typed on THAT application. */
  private findDuplicate(db: Pick<PrismaService, 'application'>, tenantId: string, jobId: string, form: ApplyForm) {
    return db.application.findFirst({
      where: { tenantId, jobId, OR: [{ email: form.email }, { candidate: { phone: form.phone } }] },
      select: { id: true },
    });
  }

  private saveOnce(
    tenantId: string,
    jobId: string,
    jdVersionId: string,
    form: ApplyForm,
    resume: { id: string; storageKey: string | null; fileName: string; mimeType: string; sizeBytes: number; sha256: string },
    bytes: Buffer,
    alreadyApplied: () => Error,
  ): Promise<{ applicationId: string; candidateId: string; appliedAt: Date }> {
    return this.db.$transaction(async (tx) => {
      // The job may have closed while the resume was being checked: read its status again, and hold a share lock
      // on the listing until commit so HR's close (an UPDATE of this row) waits for this save, never overlaps it.
      const [listing] = await tx.$queryRaw<{ status: string }[]>`
        SELECT status::text AS status FROM publisher_job_listings
        WHERE job_id = ${jobId}::uuid AND tenant_id = ${tenantId}::uuid
        FOR SHARE`;
      if (listing?.status !== 'LIVE') throw jobClosed();

      // Dedupe again inside the transaction (applications.email is also unique per job). form.email is already
      // lower-case (applyFormSchema); the candidate's own email changes with every apply, so it is not used.
      if (await this.findDuplicate(tx, tenantId, jobId, form)) throw alreadyApplied();

      // Same person, different job = one candidate profile (keyed by verified phone).
      const now = new Date();
      const candidate = await tx.candidate.upsert({
        where: { tenantId_phone: { tenantId, phone: form.phone } },
        create: { id: uuidv7(), tenantId, phone: form.phone, phoneVerifiedAt: now, name: form.name, email: form.email, city: form.city },
        update: { phoneVerifiedAt: now, name: form.name, email: form.email, city: form.city },
        select: { id: true },
      });

      const applicationId = uuidv7();
      await tx.application.create({
        data: {
          id: applicationId,
          tenantId,
          jobId,
          jdVersionId,
          candidateId: candidate.id,
          email: form.email,
          createdAt: now,
          source: form.source || 'direct',
          college: form.college,
          degree: form.degree,
          branch: form.branch,
          graduationYear: form.graduationYear,
          scoreType: form.scoreType,
          scoreValue: new Prisma.Decimal(form.scoreValue),
          linkedinUrl: form.linkedinUrl ?? null,
          githubUrl: form.githubUrl ?? null,
          portfolioUrl: form.portfolioUrl ?? null,
          projectUrl: form.projectUrl ?? null,
        },
      });

      const resumeId = resume.id;
      await tx.resume.create({
        data: {
          id: resumeId,
          tenantId,
          applicationId,
          fileName: resume.fileName,
          mimeType: resume.mimeType,
          sizeBytes: resume.sizeBytes,
          sha256: resume.sha256,
          scanStatus: 'CLEAN',
          scannedBy: this.scanner.name,
          scannedAt: now,
          storageKey: resume.storageKey,
        },
      });
      // no cloud storage configured (local dev): the bytes stay in the database
      if (!resume.storageKey) await tx.resumeFile.create({ data: { resumeId, tenantId, content: new Uint8Array(bytes) } });

      const purposes = Object.entries(form.consents).filter(([, granted]) => granted).map(([purpose]) => purpose);
      await tx.consent.createMany({
        data: purposes.map((purpose) => ({
          id: uuidv7(),
          tenantId,
          candidateId: candidate.id,
          applicationId,
          purpose,
          policyVersion: CONSENT_POLICY_VERSION,
        })),
      });
      return { applicationId, candidateId: candidate.id, appliedAt: now };
    }, INTAKE_TX);
  }
}

function parseForm(raw: unknown): ApplyForm {
  let value = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      value = undefined;
    }
  }
  const parsed = applyFormSchema.safeParse(value);
  if (!parsed.success) {
    throw applicationsError(HttpStatus.BAD_REQUEST, 'INVALID_APPLICATION', 'Please check the highlighted fields.', {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return parsed.data;
}

export const MULTIPART_LIMITS = { fileSize: RESUME_LIMITS.maxBytes, files: 1, fields: 10, fieldSize: 64 * 1024 };
