import { HttpStatus, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  approveJobRequestSchema,
  companyProfileSchema,
  editJdRequestSchema,
  editedJdSchema,
  isCorrectable,
  jobFormSchema,
  reviewJd,
  reviewScore,
  screeningSettingsSchema,
  type CompanyProfile,
  type DeleteJobResult,
  type JdContent,
  type JobDetail,
  type JobForm,
  type JobSummary,
} from '@hireflow/contracts';
import { z } from 'zod';
import { apiError, parseBody } from '../../common/api-error';
import { JobApplicationsEraser } from '../applications/job-applications.eraser';
import { ScreeningSettingsService } from '../ats/settings';
import { AuditService } from '../audit';
import { PublisherService } from '../publisher/publisher.service';
import { CompanyProfileService, TenantContext } from '../tenants';
import { AiWorkerClient } from './ai-worker.client';
import { JobsRepository } from './jobs.repository';

/**
 * The JD's "Company Website" link always comes from the company details the version was written from (the profile's
 * website), never from the AI or the edit request. A profile without a website gives a JD without one.
 */
function withCompanyLink(content: JdContent, company: { website?: unknown } | null): JdContent {
  const { companyUrl: _ignored, careersUrl: _legacy, ...rest } = content;
  return typeof company?.website === 'string' && company.website ? { ...rest, companyUrl: company.website } : rest;
}

/** POST /jobs may carry HR's private screening rules next to the form fields (never stored in the form). */
const createScreeningSchema = z.object({ screening: screeningSettingsSchema.optional() });

/**
 * The whole "Generate" request (first draft + corrected draft) should finish within ~75s: the public Cloudflare
 * tunnel drops requests after 100s. A corrected draft is only asked for if at least 20s of that remain.
 */
const CORRECTION_DEADLINE_MS = Number(process.env.JD_CORRECTION_DEADLINE_MS) || 75_000;
const CORRECTION_MIN_MS = 20_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const stale = () =>
  apiError(
    HttpStatus.CONFLICT,
    'STALE_JD_VERSION',
    'This job description was changed in another tab or window. Reload to see the latest version.',
  );

/** Steps 2-4: create a job, generate its JD from job form + company profile, let HR edit, then approve. */
@Injectable()
export class JobsService {
  constructor(
    @Inject(TenantContext) private readonly tenant: TenantContext,
    @Inject(CompanyProfileService) private readonly companies: CompanyProfileService,
    @Inject(JobsRepository) private readonly repo: JobsRepository,
    @Inject(AiWorkerClient) private readonly worker: AiWorkerClient,
    @Inject(AuditService) private readonly audit: AuditService,
    // M11: HR's private minimum ATS score, sent next to the form ({ ...form, screening }). Kept out of form_data.
    @Optional() @Inject(ScreeningSettingsService) private readonly screening?: ScreeningSettingsService,
    // "Delete job": take its posts down and erase its applications first (optional only for unit tests).
    @Optional() @Inject(PublisherService) private readonly publisher?: PublisherService,
    @Optional() @Inject(JobApplicationsEraser) private readonly applications?: JobApplicationsEraser,
  ) {}

  private readonly logger = new Logger('JobsService');

  /** Step 2: save the job form as a DRAFT job. Requires the company profile from step 1. */
  async create(input: unknown): Promise<JobDetail> {
    const form = parseBody(jobFormSchema, input, 'INVALID_JOB_FORM', 'The job form is invalid.');
    const { screening } = parseBody(createScreeningSchema, input, 'INVALID_SCREENING_SETTINGS', 'The minimum ATS score is invalid.');
    await this.companies.require();
    const [tenantId, actor] = await Promise.all([this.tenant.currentTenantId(), this.tenant.currentActor()]);
    const job = await this.repo.create(tenantId, form, actor.id);
    await this.log(tenantId, actor.id, 'job.created', job.id);
    if (screening && this.screening) {
      // The job is saved either way (no duplicate on a retry); HR is asked again on the job page if this failed.
      await this.screening.save(tenantId, job.id, screening, actor).catch((err: unknown) => {
        this.logger.warn(`minimum ATS score not saved job=${job.id} (${err instanceof Error ? err.name : 'unknown'})`);
      });
    }
    return job;
  }

  async list(): Promise<JobSummary[]> {
    return this.repo.list(await this.tenant.currentTenantId());
  }

  async get(jobId: string): Promise<JobDetail> {
    return this.load(await this.tenant.currentTenantId(), jobId);
  }

  /**
   * Change the requirements of a job that is not approved yet (regenerate afterwards to update the JD).
   * The current JD was written from the old requirements, so a real change makes the job DRAFT again
   * (nothing approvable until a new JD is generated); the old versions stay in the history.
   */
  async updateForm(jobId: string, input: unknown): Promise<JobDetail> {
    const form = parseBody(jobFormSchema, input, 'INVALID_JOB_FORM', 'The job form is invalid.');
    const tenantId = await this.tenant.currentTenantId();
    const job = await this.load(tenantId, jobId);
    assertEditable(job);
    if (sameForm(job.form, form)) return job; // nothing changed: keep the current JD approvable
    if (!(await this.repo.updateForm(tenantId, jobId, form))) throw locked();
    return this.load(tenantId, jobId);
  }

  /** Step 3: send BOTH inputs (job form + saved company profile) to the AI and store the result as a new version. */
  async generateJd(jobId: string): Promise<JobDetail> {
    const tenantId = await this.tenant.currentTenantId();
    const job = await this.load(tenantId, jobId);
    assertEditable(job);
    const profile = companyProfileSchema.safeParse(await this.companies.require()); // drops id/updatedAt
    if (!profile.success) {
      // e.g. a profile saved before a validation rule was tightened
      throw apiError(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'INVALID_COMPANY_PROFILE',
        'The saved company profile is incomplete or invalid. Fix it on the company profile page, then generate again.',
      );
    }
    const company: CompanyProfile = profile.data;

    const actor = await this.tenant.currentActor();
    const { generated, issues, corrected } = await this.generateChecked(job.form, company);
    const ok = await this.repo.appendVersion(tenantId, jobId, job.currentJdVersionId, {
      source: 'AI',
      content: withCompanyLink(generated.content, company),
      companySnapshot: company,
      promptVersion: generated.promptVersion,
      model: generated.model,
      createdBy: actor.id,
    });
    if (!ok) throw stale();
    await this.log(tenantId, actor.id, 'jd.generated', jobId, {
      model: generated.model,
      promptVersion: generated.promptVersion,
      corrected, // a second, corrected draft was requested
      reviewIssues: issues.map((i) => i.code), // what the fact check still flags (HR sees the details on the job page)
    });
    return this.load(tenantId, jobId);
  }

  /**
   * Generate, fact-check against HR's input (reviewJd), and if the draft invented facts or reads wrong for the
   * seniority, ask for ONE corrected draft and keep the better of the two. The corrected draft only runs if there is
   * time left, and its failure never loses the first draft. Nothing is silently edited: what remains is shown to HR.
   */
  private async generateChecked(form: JobForm, company: CompanyProfile) {
    const started = Date.now();
    const first = await this.worker.generateJd(form, company);
    const firstIssues = reviewJd(form, first.content, company);
    const corrections = firstIssues.filter(isCorrectable).map((i) => i.message);
    const remainingMs = CORRECTION_DEADLINE_MS - (Date.now() - started);
    if (!corrections.length || remainingMs < CORRECTION_MIN_MS) {
      return { generated: first, issues: firstIssues, corrected: false };
    }
    try {
      const second = await this.worker.generateJd(form, company, { corrections, timeoutMs: remainingMs });
      const secondIssues = reviewJd(form, second.content, company);
      return reviewScore(secondIssues) <= reviewScore(firstIssues)
        ? { generated: second, issues: secondIssues, corrected: true }
        : { generated: first, issues: firstIssues, corrected: true };
    } catch (err) {
      this.logger.warn(`corrected JD draft failed, keeping the first (${err instanceof Error ? err.name : 'unknown'})`);
      return { generated: first, issues: firstIssues, corrected: false };
    }
  }

  /** Step 4: HR edits the JD. The edit is saved as a new version; the AI version stays in the history.
   * Restoring an older version sends basedOnVersionId, so the new version keeps that version's company details. */
  async editJd(jobId: string, input: unknown): Promise<JobDetail> {
    const { baseVersionId, basedOnVersionId, content } = parseBody(
      editJdRequestSchema,
      input,
      'INVALID_JD',
      'The job description is incomplete.',
    );
    const tenantId = await this.tenant.currentTenantId();
    const job = await this.load(tenantId, jobId);
    assertEditable(job);
    const current = job.versions.find((v) => v.id === job.currentJdVersionId);
    if (!current) throw noJd();
    if (current.id !== baseVersionId) throw stale();
    const base = basedOnVersionId ? job.versions.find((v) => v.id === basedOnVersionId) : current;
    if (!base) {
      throw apiError(HttpStatus.NOT_FOUND, 'JD_VERSION_NOT_FOUND', 'That job description version does not belong to this job.');
    }

    const actor = await this.tenant.currentActor();
    const ok = await this.repo.appendVersion(tenantId, jobId, current.id, {
      source: 'HR_EDIT',
      content: withCompanyLink(content, base.companySnapshot),
      companySnapshot: (base.companySnapshot as CompanyProfile | null) ?? null, // the company facts the text came from
      promptVersion: null,
      model: null,
      createdBy: actor.id,
    });
    if (!ok) throw stale();
    await this.log(tenantId, actor.id, 'jd.edited', jobId);
    return this.load(tenantId, jobId);
  }

  /** Step 4: HR verifies the company details and approves the current version. The job is then locked.
   * The approver is the logged-in user, never a name from the request body. */
  async approve(jobId: string, input: unknown): Promise<JobDetail> {
    const req = parseBody(approveJobRequestSchema, input, 'INVALID_APPROVAL', 'The approval request is invalid.');
    const tenantId = await this.tenant.currentTenantId();
    const job = await this.load(tenantId, jobId);
    assertEditable(job);
    if (!job.currentJdVersionId) throw noJd();
    if (job.currentJdVersionId !== req.jdVersionId) throw stale();
    const current = job.versions.find((v) => v.id === job.currentJdVersionId);
    // AI output is only loosely checked when generated; what gets approved must be complete (e.g. non-blank summary)
    if (!current || !editedJdSchema.safeParse(current.content).success) {
      throw apiError(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'JD_INCOMPLETE',
        'This job description is incomplete (for example, the summary is blank). Edit or regenerate it before approving.',
      );
    }

    const actor = await this.tenant.currentActor();
    const ok = await this.repo.approve(tenantId, jobId, {
      jdVersionId: req.jdVersionId,
      approvedBy: actor.name,
      approvedById: actor.id,
      companyDetailsVerified: req.companyDetailsVerified,
      note: req.note || null,
    });
    if (!ok) throw stale();
    await this.log(tenantId, actor.id, 'job.approved', jobId, { jdVersionId: req.jdVersionId });
    // TODO(M29): emit jd.approved so the publisher (M06) can pick the job up.
    return this.load(tenantId, jobId);
  }

  /**
   * HR "Delete job" (any status): deletes the job for good. Order matters - unpublish first (LinkedIn post deleted,
   * careers page and apply link gone, so no new application can arrive), then every application with its resume and
   * ATS result, then the job with its JD versions and approvals. A post a channel could not delete is reported for
   * HR to remove by hand; it never blocks the delete.
   */
  async remove(jobId: string): Promise<DeleteJobResult> {
    const tenantId = await this.tenant.currentTenantId();
    await this.load(tenantId, jobId);
    const actor = await this.tenant.currentActor();
    const unpublished = await this.publisher?.unpublishIfListed(tenantId, jobId, actor);
    const deletedApplications = (await this.applications?.eraseForJob(tenantId, jobId)) ?? 0;
    if (!(await this.repo.delete(tenantId, jobId))) {
      throw apiError(HttpStatus.NOT_FOUND, 'JOB_NOT_FOUND', 'Job not found.');
    }
    await this.log(tenantId, actor.id, 'job.deleted', jobId, { deletedApplications });
    return { jobId, deletedApplications, notRemoved: unpublished?.notRemoved ?? [] };
  }

  private log(tenantId: string, actorUserId: string, action: string, jobId: string, metadata?: Record<string, unknown>) {
    return this.audit.record({ tenantId, actorUserId, action, subjectType: 'job', subjectId: jobId, metadata });
  }

  private async load(tenantId: string, jobId: string): Promise<JobDetail> {
    const job = UUID.test(jobId) ? await this.repo.get(tenantId, jobId) : null;
    if (!job) throw apiError(HttpStatus.NOT_FOUND, 'JOB_NOT_FOUND', 'Job not found.');
    return job;
  }
}

const locked = () =>
  apiError(HttpStatus.CONFLICT, 'JOB_APPROVED', 'This job is approved and locked. It can no longer be changed.');

const noJd = () =>
  apiError(HttpStatus.CONFLICT, 'JD_NOT_GENERATED', 'Generate a job description for this job first.');

function assertEditable(job: JobDetail) {
  if (job.status === 'APPROVED') throw locked();
}

/** Same form content, ignoring key order (the stored form comes back from JSONB with its keys reordered). */
function sameForm(a: JobForm, b: JobForm): boolean {
  const canonical = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canonical)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.entries(v)
              .filter(([, x]) => x !== undefined)
              .sort(([k1], [k2]) => k1.localeCompare(k2))
              .map(([k, x]) => [k, canonical(x)]),
          )
        : v;
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}
