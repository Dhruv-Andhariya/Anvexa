import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { jdContentSchema, jobFormSchema, type JdContent, type JobForm, type PostStatus } from '@hireflow/contracts';
import { PrismaService } from '../../common/prisma.service';
import { uuidv7 } from '../../common/uuidv7';

/** Company details every post uses. Read from Intern 1's tenants + company_profiles (never copied). */
export interface CompanyProfile {
  tenantId: string;
  slug: string;
  name: string;
  about: string | null;
  /** company_profiles.careers_url - the post's company link when the company has no website. */
  careersPageUrl: string | null;
  /** company_profiles.website - the company link in every post (one of the exactly two links). */
  websiteUrl?: string | null;
}

/** A JD version HR APPROVED (job_approvals -> jd_versions). The only thing the publisher ever publishes. */
export interface ApprovedJd {
  jobId: string;
  tenantId: string;
  jdVersionId: string;
  approvalId: string;
  version: number;
  form: JobForm;
  jd: JdContent;
  approvedAt: Date;
  approvedBy: string;
}

export interface Listing {
  jobId: string;
  tenantId: string;
  slug: string;
  status: 'LIVE' | 'CLOSED';
  selectionProcess: string[];
  /** The approved version this listing publishes. */
  approved: ApprovedJd;
}

export interface PostRow {
  id: string;
  channel: string;
  status: PostStatus;
  externalId: string | null;
  url: string | null;
  lastError: string | null;
}

export interface ChannelSetting {
  enabled: boolean;
  config: Record<string, unknown>;
}

export interface SaveListingInput {
  tenantId: string;
  jobId: string;
  slug: string;
  jdVersionId: string;
  approvalId: string;
  selectionProcess: string[];
  publishedBy: string | null;
}

/** jobClosed: the listing is not LIVE (closed meanwhile), so nothing may be posted. */
export type ClaimResult = { claimed: true; post: PostRow } | { claimed: false; post: PostRow; jobClosed?: boolean };

/** A PUBLISHING claim older than this is treated as a crashed attempt and may be taken over. */
export const STALE_CLAIM_MS = 5 * 60_000;

/**
 * All publisher database access. Every method takes tenantId (or a public company slug) and
 * scopes every query by it, so one company can never read or change another company's jobs.
 * Abstract so tests can swap in an in-memory store.
 */
export abstract class PublisherStore {
  abstract getCompany(tenantId: string): Promise<CompanyProfile | null>;
  /** Public lookup for the careers site. Only ACTIVE companies. */
  abstract getCompanyBySlug(slug: string): Promise<CompanyProfile | null>;
  /** The job's latest APPROVED version, or null when the job is not this tenant's or not approved. */
  abstract getApprovedJd(tenantId: string, jobId: string): Promise<ApprovedJd | null>;
  /** Every approved job of this tenant, newest approval first. */
  abstract listApprovedJds(tenantId: string): Promise<ApprovedJd[]>;
  abstract getListing(tenantId: string, jobId: string): Promise<Listing | null>;
  abstract getListingBySlug(tenantId: string, slug: string): Promise<Listing | null>;
  /** Every listing of this tenant with that status (no cap: the careers page must never drop a LIVE job). */
  abstract listListings(tenantId: string, status: 'LIVE' | 'CLOSED'): Promise<Listing[]>;
  /** Listings of exactly these jobs (HR board). */
  abstract listListingsForJobs(tenantId: string, jobIds: string[]): Promise<Listing[]>;
  /** Creates the listing, or points an existing one at the newly approved version (LIVE again). */
  abstract saveListing(input: SaveListingInput): Promise<Listing>;
  abstract getChannelSettings(tenantId: string): Promise<Map<string, ChannelSetting>>;
  abstract setChannelSetting(tenantId: string, channel: string, setting: ChannelSetting): Promise<void>;
  /**
   * Atomically takes the right to publish this job on this channel. Only one caller ever wins, and only while the
   * listing is LIVE (a concurrent close wins over a publish that has not claimed yet).
   */
  abstract claimPost(tenantId: string, jobId: string, channel: string, jdVersionId: string): Promise<ClaimResult>;
  abstract markNotConfigured(tenantId: string, jobId: string, channel: string, jdVersionId: string, reason: string): Promise<PostRow>;
  abstract finishPost(
    postId: string,
    result: { status: 'PUBLISHED'; externalId: string | null; url: string | null } | { status: 'FAILED'; error: string },
  ): Promise<PostRow>;
  abstract listPosts(tenantId: string, jobId: string): Promise<PostRow[]>;
  /** Stores a post's new public URL (the careers page after CAREERS_SITE_URL changed). */
  abstract setPostUrl(postId: string, url: string | null): Promise<void>;
  /**
   * Every job, of ALL companies, whose careers-page post is saved under another public base URL than this one -
   * i.e. CAREERS_SITE_URL changed and the job's posts may still carry the old apply link. Startup job only.
   */
  abstract listJobsWithOldLinks(careersSiteUrl: string): Promise<{ tenantId: string; jobId: string }[]>;
  /** LIVE <-> CLOSED. Returns null when the job is not this tenant's. */
  abstract setListingStatus(tenantId: string, jobId: string, status: 'LIVE' | 'CLOSED'): Promise<Listing | null>;
  /**
   * Deletes the listing and its post rows (job back to "Not published"; the slug is free again). Applications are
   * not touched. Returns false when the job has no listing of this tenant.
   */
  abstract deleteListing(tenantId: string, jobId: string): Promise<boolean>;
  /** Number of applications per job (HR overview). */
  abstract countApplications(tenantId: string, jobIds: string[]): Promise<Map<string, number>>;
}

const RETRYABLE: PostStatus[] = ['PENDING', 'FAILED', 'NOT_CONFIGURED'];

const APPROVAL_INCLUDE = {
  jdVersion: { select: { id: true, version: true, content: true } },
  job: { select: { formData: true, status: true } },
} as const;

export type ApprovalRow = Prisma.JobApprovalGetPayload<{ include: typeof APPROVAL_INCLUDE }>;
type ListingRow = Prisma.PublisherJobListingGetPayload<object>;

@Injectable()
export class PrismaPublisherStore extends PublisherStore {
  constructor(@Inject(PrismaService) private readonly db: PrismaService) {
    super();
  }

  async getCompany(tenantId: string) {
    const t = await this.db.tenant.findUnique({ where: { id: tenantId }, include: { companyProfile: true } });
    return t ? toCompany(t) : null;
  }

  async getCompanyBySlug(slug: string) {
    const t = await this.db.tenant.findUnique({ where: { slug }, include: { companyProfile: true } });
    return t && t.status === 'ACTIVE' ? toCompany(t) : null;
  }

  async getApprovedJd(tenantId: string, jobId: string) {
    const row = await this.db.jobApproval.findFirst({
      where: { tenantId, jobId, job: { status: 'APPROVED' } },
      orderBy: { approvedAt: 'desc' },
      include: APPROVAL_INCLUDE,
    });
    return row ? toApproved(row) : null;
  }

  async listApprovedJds(tenantId: string) {
    const rows = await this.db.jobApproval.findMany({
      where: { tenantId, job: { status: 'APPROVED' } },
      orderBy: { approvedAt: 'desc' },
      distinct: ['jobId'], // newest approval per job; no cap, so older approved jobs never vanish from the board
      include: APPROVAL_INCLUDE,
    });
    return rows.map(toApproved).filter((a): a is ApprovedJd => a !== null);
  }

  async getListing(tenantId: string, jobId: string) {
    const row = await this.db.publisherJobListing.findFirst({ where: { tenantId, jobId } });
    return row ? this.withApproved(row) : null;
  }

  async getListingBySlug(tenantId: string, slug: string) {
    const row = await this.db.publisherJobListing.findUnique({ where: { tenantId_slug: { tenantId, slug } } });
    return row ? this.withApproved(row) : null;
  }

  async listListings(tenantId: string, status: 'LIVE' | 'CLOSED') {
    const rows = await this.db.publisherJobListing.findMany({ where: { tenantId, status }, orderBy: { updatedAt: 'desc' } });
    return this.withApprovedMany(rows);
  }

  async listListingsForJobs(tenantId: string, jobIds: string[]) {
    if (!jobIds.length) return [];
    const rows = await this.db.publisherJobListing.findMany({ where: { tenantId, jobId: { in: jobIds } } });
    return this.withApprovedMany(rows);
  }

  async saveListing(input: SaveListingInput) {
    const data = {
      jdVersionId: input.jdVersionId,
      approvalId: input.approvalId,
      selectionProcess: input.selectionProcess,
      publishedBy: input.publishedBy,
    };
    // Job ids are unique, but never trust it: check the owner BEFORE writing, or the upsert would already have
    // changed another company's listing by the time we noticed.
    const existing = await this.db.publisherJobListing.findUnique({ where: { jobId: input.jobId }, select: { tenantId: true } });
    if (existing && existing.tenantId !== input.tenantId) throw new JobOwnedByOtherTenantError();
    const row = await this.db.publisherJobListing.upsert({
      where: { jobId: input.jobId },
      create: { jobId: input.jobId, tenantId: input.tenantId, slug: input.slug, ...data },
      update: data, // the slug never changes once students may have the link
    });
    if (row.tenantId !== input.tenantId) throw new JobOwnedByOtherTenantError(); // created by another company in between
    const listing = await this.withApproved(row);
    if (!listing) throw new Error('approved JD version disappeared while publishing');
    return listing;
  }

  async getChannelSettings(tenantId: string) {
    const rows = await this.db.publisherChannelSetting.findMany({ where: { tenantId } });
    return new Map(rows.map((r) => [r.channel, { enabled: r.enabled, config: asObject(r.config) }]));
  }

  async setChannelSetting(tenantId: string, channel: string, s: ChannelSetting) {
    const data = { enabled: s.enabled, config: s.config as Prisma.InputJsonValue };
    await this.db.publisherChannelSetting.upsert({
      where: { tenantId_channel: { tenantId, channel } },
      create: { tenantId, channel, ...data },
      update: data,
    });
  }

  async claimPost(tenantId: string, jobId: string, channel: string, jdVersionId: string): Promise<ClaimResult> {
    await this.ensurePostRow(tenantId, jobId, channel, jdVersionId);
    const { count, jobClosed } = await this.db.$transaction(async (tx) => {
      // No-op write on the LIVE listing: row-locks it until the claim commits, so close() either won before us
      // (count 0 -> nothing is posted) or waits until our claim is recorded.
      const live = await tx.publisherJobListing.updateMany({ where: { tenantId, jobId, status: 'LIVE' }, data: { status: 'LIVE' } });
      if (!live.count) return { count: 0, jobClosed: true };
      const claim = await tx.jobPost.updateMany({
        where: {
          tenantId,
          jobId,
          channel,
          OR: [{ status: { in: RETRYABLE } }, { status: 'PUBLISHING', updatedAt: { lt: new Date(Date.now() - STALE_CLAIM_MS) } }],
        },
        data: { status: 'PUBLISHING', jdVersionId, attempts: { increment: 1 }, lastError: null },
      });
      return { count: claim.count, jobClosed: false };
    });
    const post = await this.findPost(tenantId, jobId, channel);
    return (count === 1 ? { claimed: true, post } : { claimed: false, post, jobClosed }) as ClaimResult;
  }

  async markNotConfigured(tenantId: string, jobId: string, channel: string, jdVersionId: string, reason: string) {
    await this.ensurePostRow(tenantId, jobId, channel, jdVersionId);
    await this.db.jobPost.updateMany({
      where: { tenantId, jobId, channel, status: { in: RETRYABLE } },
      data: { status: 'NOT_CONFIGURED', lastError: reason.slice(0, 500) },
    });
    return this.findPost(tenantId, jobId, channel);
  }

  async finishPost(
    postId: string,
    result: { status: 'PUBLISHED'; externalId: string | null; url: string | null } | { status: 'FAILED'; error: string },
  ) {
    return this.db.jobPost.update({
      where: { id: postId },
      data:
        result.status === 'PUBLISHED'
          ? { status: 'PUBLISHED', externalId: result.externalId, url: result.url, publishedAt: new Date(), lastError: null }
          : { status: 'FAILED', lastError: result.error.slice(0, 500) },
      select: POST_SELECT,
    });
  }

  async listPosts(tenantId: string, jobId: string) {
    return this.db.jobPost.findMany({ where: { tenantId, jobId }, orderBy: { channel: 'asc' }, select: POST_SELECT });
  }

  async setPostUrl(postId: string, url: string | null) {
    await this.db.jobPost.update({ where: { id: postId }, data: { url } });
  }

  async listJobsWithOldLinks(careersSiteUrl: string) {
    return this.db.jobPost.findMany({
      where: { channel: 'careers', status: 'PUBLISHED', url: { not: null }, NOT: { url: { startsWith: `${careersSiteUrl}/` } } },
      select: { tenantId: true, jobId: true },
      orderBy: { createdAt: 'asc' },
    });
  }

  async setListingStatus(tenantId: string, jobId: string, status: 'LIVE' | 'CLOSED') {
    const { count } = await this.db.publisherJobListing.updateMany({ where: { tenantId, jobId }, data: { status } });
    return count ? this.getListing(tenantId, jobId) : null;
  }

  async deleteListing(tenantId: string, jobId: string) {
    const [, listing] = await this.db.$transaction([
      this.db.jobPost.deleteMany({ where: { tenantId, jobId } }),
      this.db.publisherJobListing.deleteMany({ where: { tenantId, jobId } }),
    ]);
    return listing.count > 0;
  }

  async countApplications(tenantId: string, jobIds: string[]) {
    if (!jobIds.length) return new Map<string, number>();
    const rows = await this.db.application.groupBy({ by: ['jobId'], where: { tenantId, jobId: { in: jobIds } }, _count: { _all: true } });
    return new Map(rows.map((r) => [r.jobId, r._count._all]));
  }

  private async ensurePostRow(tenantId: string, jobId: string, channel: string, jdVersionId: string) {
    // ON CONFLICT DO NOTHING: the unique (tenant_id, job_id, channel) key means one post row per job per channel, forever.
    await this.db.jobPost.createMany({
      data: [{ id: uuidv7(), tenantId, jobId, channel, jdVersionId, status: 'PENDING' }],
      skipDuplicates: true,
    });
  }

  private findPost(tenantId: string, jobId: string, channel: string) {
    return this.db.jobPost.findUniqueOrThrow({
      where: { tenantId_jobId_channel: { tenantId, jobId, channel } },
      select: POST_SELECT,
    });
  }

  /** The listing with the approved version it points at. null if that approval no longer exists (job deleted). */
  private async withApproved(row: ListingRow): Promise<Listing | null> {
    const approval = await this.db.jobApproval.findFirst({
      where: { id: row.approvalId, tenantId: row.tenantId, jdVersionId: row.jdVersionId },
      include: APPROVAL_INCLUDE,
    });
    return approval ? toListing(row, approval) : null;
  }

  /** withApproved() for many rows in one query. Listings whose approval is gone or unreadable are left out. */
  private async withApprovedMany(rows: ListingRow[]): Promise<Listing[]> {
    if (!rows.length) return [];
    const approvals = await this.db.jobApproval.findMany({
      where: { id: { in: rows.map((r) => r.approvalId) }, tenantId: rows[0]!.tenantId },
      include: APPROVAL_INCLUDE,
    });
    const byId = new Map(approvals.map((a) => [a.id, a]));
    return rows.flatMap((r) => {
      const a = byId.get(r.approvalId);
      const listing = a && a.jdVersionId === r.jdVersionId ? toListing(r, a) : null;
      return listing ? [listing] : [];
    });
  }
}

export class JobOwnedByOtherTenantError extends Error {}

const logger = new Logger('PublisherStore');

const POST_SELECT = { id: true, channel: true, status: true, externalId: true, url: true, lastError: true } as const;

function toCompany(t: {
  id: string;
  slug: string;
  name: string;
  companyProfile: { name: string; description: string; website: string | null; careersUrl: string | null } | null;
}): CompanyProfile {
  return {
    tenantId: t.id,
    slug: t.slug,
    name: t.companyProfile?.name || t.name,
    about: t.companyProfile?.description || null,
    careersPageUrl: t.companyProfile?.careersUrl || null,
    websiteUrl: t.companyProfile?.website || null,
  };
}

function toListing(row: ListingRow, approval: ApprovalRow): Listing | null {
  const approved = toApproved(approval);
  if (!approved) return null;
  return { jobId: row.jobId, tenantId: row.tenantId, slug: row.slug, status: row.status, selectionProcess: row.selectionProcess, approved };
}

/**
 * Re-validate on read: what leaves the database is always a valid contract shape. A row that no longer parses is
 * skipped (and logged) instead of failing the whole list.
 */
export function toApproved(a: ApprovalRow): ApprovedJd | null {
  const form = jobFormSchema.safeParse(a.job.formData);
  const jd = jdContentSchema.safeParse(a.jdVersion.content);
  if (!form.success || !jd.success) {
    logger.warn(`skipped unreadable approved JD job=${a.jobId} approval=${a.id}`);
    return null;
  }
  return {
    jobId: a.jobId,
    tenantId: a.tenantId,
    jdVersionId: a.jdVersion.id,
    approvalId: a.id,
    version: a.jdVersion.version,
    form: form.data,
    jd: jd.data,
    approvedAt: a.approvedAt,
    approvedBy: a.approvedBy,
  };
}

function asObject(v: Prisma.JsonValue): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
