import type { JdContent, JobForm } from '@hireflow/contracts';
import {
  JobOwnedByOtherTenantError,
  STALE_CLAIM_MS,
  PublisherStore,
  type ApprovedJd,
  type ChannelSetting,
  type ClaimResult,
  type CompanyProfile,
  type Listing,
  type PostRow,
  type SaveListingInput,
} from '../../src/modules/publisher/publisher.store';
import type { AuditEntry, AuditService } from '../../src/modules/audit';
import { ChannelCredentials, isExpired, statusOf, type ChannelTokens } from '../../src/modules/publisher/channel-credentials';

export const TENANT = '0192f3a1-0000-7000-8000-000000000001';
export const OTHER_TENANT = '0192f3a1-0000-7000-8000-000000000002';
export const JOB_ID = '0192f3a1-7c2e-7a10-8b2c-123456789abc';
export const ACTOR = { id: '0192f3a1-0000-7000-8000-0000000000aa', name: 'Priya HR' };

export const FORM: JobForm = {
  title: 'Junior Backend Developer',
  experienceMin: 0,
  experienceMax: 2,
  mustHaveSkills: ['Node.js', 'PostgreSQL', 'REST APIs'],
  niceToHaveSkills: ['Docker'],
  salaryMin: 400000,
  salaryMax: 600000,
  currency: 'INR',
  salaryType: 'CTC',
  locations: ['Ahmedabad'],
  workMode: 'HYBRID',
  employmentType: 'FULL_TIME',
  openings: 3,
  deadline: '2099-10-31T18:29:59.000Z',
};

export const JD: JdContent = {
  title: 'Junior Backend Developer',
  summary: 'Build and maintain the REST APIs behind our hiring products.',
  aboutCompany: '',
  responsibilities: ['Build REST APIs in Node.js.', 'Write SQL queries and migrations.', 'Fix bugs reported by users.'],
  requirements: ['Node.js', 'PostgreSQL', 'REST API basics'],
  niceToHave: ['Docker'],
  benefits: ['Health insurance'],
};

export const COMPANY: CompanyProfile = {
  tenantId: TENANT,
  slug: 'acme',
  name: 'Acme Tech',
  about: 'Acme Tech builds hiring software in Ahmedabad.',
  careersPageUrl: 'https://acme.example/careers',
};

/** What Intern 1's step 4 writes when HR approves version `version` of the JD. */
export const approvedJd = (overrides: Partial<ApprovedJd> = {}): ApprovedJd => ({
  jobId: JOB_ID,
  tenantId: TENANT,
  jdVersionId: `jdv-${overrides.version ?? 1}`,
  approvalId: `appr-${overrides.version ?? 1}`,
  version: 1,
  form: FORM,
  jd: JD,
  approvedAt: new Date('2026-10-14T06:00:00Z'),
  approvedBy: ACTOR.name,
  ...overrides,
});

export const request = (overrides: Record<string, unknown> = {}) => ({
  selectionProcess: ['AI screening', 'Coding round', 'Interview'],
  ...overrides,
});

/** Records audit entries instead of writing audit_logs. */
export class MemoryAudit {
  entries: AuditEntry[] = [];
  async record(e: AuditEntry) {
    this.entries.push(e);
  }
  asService() {
    return this as unknown as AuditService;
  }
}

/** In-memory channel_credentials (no encryption needed in memory). */
export class MemoryChannelCredentials extends ChannelCredentials {
  rows = new Map<string, ChannelTokens>();
  async save(tenantId: string, channel: string, t: ChannelTokens) {
    this.rows.set(`${tenantId}:${channel}`, t);
  }
  async remove(tenantId: string, channel: string) {
    this.rows.delete(`${tenantId}:${channel}`);
  }
  async accessTokens(tenantId: string) {
    return new Map([...this.mine(tenantId)].map(([c, t]) => [c, isExpired(t.expiresAt) ? null : t.accessToken]));
  }
  async statuses(tenantId: string) {
    return new Map([...this.mine(tenantId)].map(([c, t]) => [c, statusOf(t.expiresAt, t.accountName ?? null)]));
  }
  private mine(tenantId: string): [string, ChannelTokens][] {
    return [...this.rows].filter(([k]) => k.startsWith(`${tenantId}:`)).map(([k, t]) => [k.slice(tenantId.length + 1), t]);
  }
}

/** In-memory PublisherStore with the same claim semantics as the Prisma one. */
export class MemoryPublisherStore extends PublisherStore {
  companies = new Map<string, CompanyProfile>();
  /** jobId -> approvals, oldest first (like job_approvals). */
  approvals = new Map<string, ApprovedJd[]>();
  listings = new Map<string, { jobId: string; tenantId: string; slug: string; status: 'LIVE' | 'CLOSED'; selectionProcess: string[]; approvalId: string }>();
  settings = new Map<string, Map<string, ChannelSetting>>();
  posts: (PostRow & { tenantId: string; jobId: string; updatedAt: number; attempts: number; jdVersionId: string })[] = [];
  applicationCounts = new Map<string, number>();
  private seq = 0;

  approve(a: ApprovedJd) {
    this.approvals.set(a.jobId, [...(this.approvals.get(a.jobId) ?? []), a]);
  }

  async getCompany(tenantId: string) {
    return this.companies.get(tenantId) ?? null;
  }
  async getCompanyBySlug(slug: string) {
    return [...this.companies.values()].find((c) => c.slug === slug) ?? null;
  }
  async getApprovedJd(tenantId: string, jobId: string) {
    const latest = this.approvals.get(jobId)?.at(-1);
    return latest && latest.tenantId === tenantId ? latest : null;
  }
  async listApprovedJds(tenantId: string) {
    return [...this.approvals.values()].map((list) => list.at(-1)!).filter((a) => a.tenantId === tenantId);
  }
  async getListing(tenantId: string, jobId: string) {
    const l = this.listings.get(jobId);
    return l && l.tenantId === tenantId ? this.toListing(l) : null;
  }
  async getListingBySlug(tenantId: string, slug: string) {
    const l = [...this.listings.values()].find((x) => x.tenantId === tenantId && x.slug === slug);
    return l ? this.toListing(l) : null;
  }
  async listListings(tenantId: string, status: 'LIVE' | 'CLOSED') {
    return [...this.listings.values()].filter((l) => l.tenantId === tenantId && l.status === status).map((l) => this.toListing(l)!);
  }
  async listListingsForJobs(tenantId: string, jobIds: string[]) {
    return [...this.listings.values()]
      .filter((l) => l.tenantId === tenantId && jobIds.includes(l.jobId))
      .map((l) => this.toListing(l)!);
  }
  async saveListing(input: SaveListingInput) {
    const existing = this.listings.get(input.jobId);
    if (existing && existing.tenantId !== input.tenantId) throw new JobOwnedByOtherTenantError();
    if (!existing && [...this.listings.values()].some((l) => l.tenantId === input.tenantId && l.slug === input.slug)) {
      // Like Prisma on the @@unique([tenantId, slug]) key.
      throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002', meta: { target: ['tenant_id', 'slug'] } });
    }
    const row = {
      jobId: input.jobId,
      tenantId: input.tenantId,
      slug: existing?.slug ?? input.slug,
      status: existing?.status ?? ('LIVE' as const),
      selectionProcess: input.selectionProcess,
      approvalId: input.approvalId,
    };
    this.listings.set(input.jobId, row);
    return this.toListing(row)!;
  }
  async getChannelSettings(tenantId: string) {
    return this.settings.get(tenantId) ?? new Map();
  }
  async setChannelSetting(tenantId: string, channel: string, s: ChannelSetting) {
    const m = this.settings.get(tenantId) ?? new Map();
    m.set(channel, s);
    this.settings.set(tenantId, m);
  }
  async claimPost(tenantId: string, jobId: string, channel: string, jdVersionId: string): Promise<ClaimResult> {
    const row = this.row(tenantId, jobId, channel, jdVersionId);
    if (this.listings.get(jobId)?.status !== 'LIVE') return { claimed: false, post: { ...row }, jobClosed: true };
    const stale = row.status === 'PUBLISHING' && row.updatedAt < Date.now() - STALE_CLAIM_MS;
    if (['PENDING', 'FAILED', 'NOT_CONFIGURED'].includes(row.status) || stale) {
      Object.assign(row, { status: 'PUBLISHING', jdVersionId, attempts: row.attempts + 1, lastError: null, updatedAt: Date.now() });
      return { claimed: true, post: { ...row } };
    }
    return { claimed: false, post: { ...row } };
  }
  async markNotConfigured(tenantId: string, jobId: string, channel: string, jdVersionId: string, reason: string) {
    const row = this.row(tenantId, jobId, channel, jdVersionId);
    if (['PENDING', 'FAILED', 'NOT_CONFIGURED'].includes(row.status)) Object.assign(row, { status: 'NOT_CONFIGURED', lastError: reason });
    return { ...row };
  }
  async finishPost(
    postId: string,
    r: { status: 'PUBLISHED'; externalId: string | null; url: string | null } | { status: 'FAILED'; error: string },
  ) {
    const row = this.posts.find((p) => p.id === postId)!;
    if (r.status === 'PUBLISHED') Object.assign(row, { status: 'PUBLISHED', externalId: r.externalId, url: r.url, lastError: null });
    else Object.assign(row, { status: 'FAILED', lastError: r.error });
    return { ...row };
  }
  async listPosts(tenantId: string, jobId: string) {
    return this.posts.filter((p) => p.tenantId === tenantId && p.jobId === jobId);
  }
  async setPostUrl(postId: string, url: string | null) {
    this.posts.find((p) => p.id === postId)!.url = url;
  }
  async listJobsWithOldLinks(careersSiteUrl: string) {
    return this.posts
      .filter((p) => p.channel === 'careers' && p.status === 'PUBLISHED' && p.url && !p.url.startsWith(`${careersSiteUrl}/`))
      .map((p) => ({ tenantId: p.tenantId, jobId: p.jobId }));
  }
  async setListingStatus(tenantId: string, jobId: string, status: 'LIVE' | 'CLOSED') {
    const l = this.listings.get(jobId);
    if (!l || l.tenantId !== tenantId) return null;
    l.status = status;
    return this.toListing(l);
  }
  async deleteListing(tenantId: string, jobId: string) {
    const l = this.listings.get(jobId);
    if (!l || l.tenantId !== tenantId) return false;
    this.listings.delete(jobId);
    this.posts = this.posts.filter((p) => !(p.tenantId === tenantId && p.jobId === jobId));
    return true;
  }
  async countApplications(tenantId: string, jobIds: string[]) {
    return new Map(jobIds.map((id) => [id, this.applicationCounts.get(id) ?? 0]));
  }
  private toListing(l: { jobId: string; tenantId: string; slug: string; status: 'LIVE' | 'CLOSED'; selectionProcess: string[]; approvalId: string }): Listing | null {
    const approved = this.approvals.get(l.jobId)?.find((a) => a.approvalId === l.approvalId);
    return approved ? { jobId: l.jobId, tenantId: l.tenantId, slug: l.slug, status: l.status, selectionProcess: l.selectionProcess, approved } : null;
  }
  private row(tenantId: string, jobId: string, channel: string, jdVersionId: string) {
    let row = this.posts.find((p) => p.tenantId === tenantId && p.jobId === jobId && p.channel === channel);
    if (!row) {
      row = { id: `post-${++this.seq}`, tenantId, jobId, channel, jdVersionId, status: 'PENDING', externalId: null, url: null, lastError: null, updatedAt: Date.now(), attempts: 0 };
      this.posts.push(row);
    }
    return row;
  }
}
