import { HttpStatus, Inject, Injectable, Logger, Optional, type OnApplicationBootstrap } from '@nestjs/common';
import {
  publishJobRequestSchema,
  type ChannelInfo,
  type ChannelPostResult,
  type ChannelPreview,
  type PublishableJob,
  type PublishJobRequest,
  type PublishPreview,
  type PublishResult,
  type RefreshLinksResult,
  type UnpublishResult,
} from '@hireflow/contracts';
import { isFeatureOn } from '../../common/feature-flags';
import { ScreeningSettingsService } from '../ats/settings';
import { AuditService } from '../audit';
import { RoundsConfigService } from '../rounds-config';
import type { Actor } from '../tenants';
import { ChannelCredentials } from './channel-credentials';
import { CHANNEL_ADAPTERS, COMING_SOON_CHANNELS, ChannelError, type ChannelAdapter, type ChannelContext } from './channels';
import { basicPublishProblems, JdValidatorClient, publisherError } from './jd-checks';
import type { PostSource } from './post-formatter';
import { PublisherEvents } from './publisher.events';
import {
  JobOwnedByOtherTenantError,
  PublisherStore,
  type ApprovedJd,
  type ChannelSetting,
  type CompanyProfile,
  type Listing,
} from './publisher.store';

export interface PublisherConfig {
  /** Public base URL of apps/careers-site, e.g. https://careers.hireflow.example (no trailing slash). */
  careersSiteUrl: string;
  /** Tries per channel for retryable failures (network, rate limit, 5xx). */
  attempts: number;
  baseDelayMs: number;
  sleep: (ms: number) => Promise<void>;
  /**
   * At API start, edit the posts that still carry an apply link from an older careersSiteUrl (temporary tunnel
   * restarted with a new URL). Off in tests; env PUBLISHER_AUTO_REFRESH_LINKS=false turns it off.
   */
  autoRefreshLinks?: boolean;
}

export const PUBLISHER_CONFIG = Symbol('PUBLISHER_CONFIG');

export const publisherConfigFromEnv = (): PublisherConfig => ({
  careersSiteUrl: (process.env.CAREERS_SITE_URL || 'http://localhost:3300').replace(/\/+$/, ''),
  attempts: 3,
  baseDelayMs: 1_000,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  autoRefreshLinks: process.env.PUBLISHER_AUTO_REFRESH_LINKS !== 'false' && process.env.NODE_ENV !== 'test',
});

/**
 * "Junior Backend Developer" + job id -> "junior-backend-developer-a1b2c3". Stable for the life of the job.
 * fullId: use the whole job id hex instead of its last 6 characters (only when the short slug is already taken).
 */
export function makeJobSlug(title: string, jobId: string, fullId = false): string {
  const base = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  const hex = jobId.replace(/-/g, '');
  return `${base || 'job'}-${fullId ? hex : hex.slice(-6)}`;
}

/**
 * M06 job publisher. Input is ONLY a job id: the JD is the version HR approved (job_approvals -> jd_versions,
 * written by Intern 1's step 4), and the company is the logged-in HR user's company. One student-friendly post
 * per channel, all channels published in parallel.
 */
@Injectable()
export class PublisherService implements OnApplicationBootstrap {
  private readonly logger = new Logger('PublisherService');

  constructor(
    @Inject(PublisherStore) private readonly store: PublisherStore,
    @Inject(CHANNEL_ADAPTERS) private readonly adapters: ChannelAdapter[],
    @Inject(JdValidatorClient) private readonly validator: JdValidatorClient,
    @Inject(PublisherEvents) private readonly events: PublisherEvents,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(PUBLISHER_CONFIG) private readonly config: PublisherConfig,
    @Inject(ChannelCredentials) private readonly credentials: ChannelCredentials,
    /** M11: a job is published only once HR set its private minimum ATS score (screening needs it). */
    @Optional() @Inject(ScreeningSettingsService) private readonly screening?: ScreeningSettingsService,
    /** M05: the selection process is the job's saved assessment round names; publishing waits until they are complete. */
    @Optional() @Inject(RoundsConfigService) private readonly rounds?: RoundsConfigService,
  ) {}

  /** Runs in the background: the API is ready at once, and LinkedIn being slow or down never blocks the start. */
  onApplicationBootstrap() {
    if (this.config.autoRefreshLinks) void this.refreshOldLinks();
  }

  /** Live + coming-soon channels and whether each is switched on for this company. */
  async channels(tenantId: string): Promise<ChannelInfo[]> {
    const [settings, connections] = await Promise.all([this.store.getChannelSettings(tenantId), this.credentials.statuses(tenantId)]);
    return [
      ...this.adapters.map((a) => {
        const s = settingFor(settings, a.key);
        const connection = connections.get(a.key) ?? null;
        return { channel: a.key, label: a.label, availability: 'live' as const, enabled: s.enabled, config: s.config, connection };
      }),
      ...COMING_SOON_CHANNELS.map((c) => ({
        channel: c.key,
        label: c.label,
        availability: 'coming_soon' as const,
        enabled: false,
        config: {},
        connection: null,
      })),
    ];
  }

  /** Every APPROVED job of the company with its publish state - what the HR "Publish" page lists. */
  async listJobs(tenantId: string): Promise<PublishableJob[]> {
    const [approved, company] = await Promise.all([this.store.listApprovedJds(tenantId), this.store.getCompany(tenantId)]);
    const listings = await this.store.listListingsForJobs(tenantId, approved.map((a) => a.jobId));
    const byJob = new Map(listings.map((l) => [l.jobId, l]));
    const [counts, posts] = await Promise.all([
      this.store.countApplications(tenantId, approved.map((a) => a.jobId)),
      Promise.all(approved.map((a) => this.store.listPosts(tenantId, a.jobId))),
    ]);
    return approved.map((a, i) => {
      const listing = byJob.get(a.jobId);
      return {
        jobId: a.jobId,
        title: a.jd.title || a.form.title,
        version: a.version,
        approvedAt: a.approvedAt.toISOString(),
        approvedBy: a.approvedBy,
        deadline: a.form.deadline ?? null,
        listing:
          listing && company
            ? {
                slug: listing.slug,
                status: listing.status,
                applyUrl: this.jobPageUrl(company.slug, listing.slug),
                selectionProcess: listing.selectionProcess,
                outdated: listing.approved.jdVersionId !== a.jdVersionId,
                linksOutdated: posts[i]!.some(
                  (p) => p.channel === 'careers' && p.status === 'PUBLISHED' && !!p.url && p.url !== this.jobPageUrl(company.slug, listing.slug),
                ),
              }
            : null,
        posts: posts[i]!.map((p) => ({ channel: p.channel, status: p.status, url: p.url, error: p.lastError })),
        applications: counts.get(a.jobId) ?? 0,
      };
    });
  }

  /** What each channel WOULD post for the approved JD. Saves nothing. */
  async preview(tenantId: string, jobId: string, input: unknown): Promise<PublishPreview> {
    const req = parseRequest(input);
    const { approved, company, errors, warnings, slug, selectionProcess } = await this.check(tenantId, jobId, req);
    const [settings, tokens] = await Promise.all([this.store.getChannelSettings(tenantId), this.credentials.accessTokens(tenantId)]);

    const channels: ChannelPreview[] = this.adapters.map((a) => {
      const setting = settingFor(settings, a.key);
      if (!company || !companyLink(company)) {
        return { channel: a.key, label: a.label, availability: 'live', blockers: ['The company website link is missing.'] };
      }
      const ctx = this.context(tenantId, jobId, slug, company, a.key, setting, sourceOf(approved, selectionProcess, company), tokens);
      const blockers = setting.enabled ? a.blockers(ctx) : ['Turned off for this company.'];
      return { channel: a.key, label: a.label, availability: 'live', text: a.render(ctx), links: ctx.links, blockers };
    });
    for (const c of COMING_SOON_CHANNELS) {
      channels.push({ channel: c.key, label: c.label, availability: 'coming_soon', blockers: [] });
    }
    return { errors, warnings, channels };
  }

  /** HR confirmed the preview: make the approved version the live listing, then publish it everywhere. */
  async publish(tenantId: string, jobId: string, input: unknown, actor: Actor): Promise<PublishResult> {
    const req = parseRequest(input);
    const { approved, company, errors, slug, selectionProcess } = await this.check(tenantId, jobId, req);
    if (!company || !companyLink(company) || errors.length) {
      throw publisherError(HttpStatus.UNPROCESSABLE_ENTITY, 'NOT_READY_TO_PUBLISH', 'Fix these problems before publishing.', { errors });
    }

    const save = (jobSlug: string) =>
      this.store.saveListing({
        tenantId,
        jobId,
        slug: jobSlug,
        jdVersionId: approved.jdVersionId,
        approvalId: approved.approvalId,
        selectionProcess,
        publishedBy: actor.id,
      });
    let listing: Listing;
    try {
      try {
        listing = await save(slug);
      } catch (err) {
        // Another job of this company already has the short slug (same title, same last 6 id characters): use the
        // full job id once. Only new listings get here - an existing listing keeps its slug.
        if (!isSlugTaken(err)) throw err;
        listing = await save(makeJobSlug(approved.jd.title || approved.form.title, jobId, true));
      }
    } catch (err) {
      if (err instanceof JobOwnedByOtherTenantError) throw jobNotFound();
      if (isSlugTaken(err)) {
        throw publisherError(HttpStatus.CONFLICT, 'SLUG_TAKEN', 'Could not make a unique link for this job. Please contact support.');
      }
      if ((err as { code?: string }).code === 'P2002') {
        throw publisherError(HttpStatus.CONFLICT, 'PUBLISH_IN_PROGRESS', 'This job is being published right now. Try again in a moment.');
      }
      throw err;
    }
    const result = await this.publishListing(listing, company);
    await this.auditPublish(tenantId, actor, 'job.published', result);
    return result;
  }

  /** Publishes the CURRENT listing again on channels that failed or were not configured. */
  async retry(tenantId: string, jobId: string, actor: Actor): Promise<PublishResult> {
    const [listing, company] = await Promise.all([this.store.getListing(tenantId, jobId), this.store.getCompany(tenantId)]);
    if (!listing || !company) throw jobNotFound();
    if (listing.status !== 'LIVE') throw publisherError(HttpStatus.CONFLICT, 'JOB_CLOSED', 'This job is closed.');
    // Same basic checks as publish() (deadline passed, empty JD...). The AI validator already ran at publish time.
    const errors = basicPublishProblems(listing.approved.form, listing.approved.jd);
    if (!companyLink(company)) errors.unshift(COMPANY_LINK_MISSING);
    if (errors.length) {
      throw publisherError(HttpStatus.UNPROCESSABLE_ENTITY, 'NOT_READY_TO_PUBLISH', 'Fix these problems before publishing.', { errors });
    }
    const result = await this.publishListing(listing, company);
    await this.auditPublish(tenantId, actor, 'job.publish_retried', result);
    return result;
  }

  /**
   * Stops applications: the careers page shows "closed" and the apply API refuses new applications.
   * Posts are taken down on channels whose adapter supports close(); others stay up but point to the closed page.
   */
  async close(tenantId: string, jobId: string, actor: Actor) {
    const [listing, company] = await Promise.all([this.store.getListing(tenantId, jobId), this.store.getCompany(tenantId)]);
    if (!listing || !company) throw jobNotFound();
    if (listing.status === 'LIVE') {
      await this.store.setListingStatus(tenantId, jobId, 'CLOSED');
      const takenDown: string[] = [];
      if (companyLink(company)) {
        const [settings, posts, tokens] = await Promise.all([
          this.store.getChannelSettings(tenantId),
          this.store.listPosts(tenantId, jobId),
          this.credentials.accessTokens(tenantId),
        ]);
        const source = sourceOf(listing.approved, listing.selectionProcess, company);
        await Promise.all(
          posts
            .filter((p) => p.status === 'PUBLISHED')
            .map(async (p) => {
              const adapter = this.adapters.find((a) => a.key === p.channel);
              if (!adapter?.close) return;
              const ctx = this.context(tenantId, jobId, listing.slug, company, p.channel, settingFor(settings, p.channel), source, tokens);
              try {
                await adapter.close(ctx, { externalId: p.externalId, url: p.url });
                takenDown.push(p.channel);
              } catch (err) {
                // The job is closed for applications either way; a post we could not remove is only logged.
                this.logger.warn(`close failed channel=${p.channel} job=${jobId} (${err instanceof Error ? err.name : 'unknown'})`);
              }
            }),
        );
      }
      await this.record(tenantId, actor, 'job.closed', jobId, { takenDown });
    }
    return { jobId, status: 'CLOSED' as const };
  }

  /** Takes applications again. Channels keep their existing posts; use retry() for ones that failed. */
  async reopen(tenantId: string, jobId: string, actor: Actor) {
    const listing = await this.store.getListing(tenantId, jobId);
    if (!listing) throw jobNotFound();
    if (deadlinePassed(listing.approved)) {
      throw publisherError(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'DEADLINE_PASSED',
        'The last date to apply has already passed. Set a later deadline, approve the job again and publish it.',
      );
    }
    if (listing.status === 'CLOSED') {
      await this.store.setListingStatus(tenantId, jobId, 'LIVE');
      await this.record(tenantId, actor, 'job.reopened', jobId, {});
    }
    return { jobId, status: 'LIVE' as const };
  }

  /**
   * HR "Delete": takes the job off the careers page and deletes its posts on every channel, then drops the listing
   * and post rows so the job is "Not published" again (still approved: publishing it later makes fresh posts).
   * Applications already received are kept. A post a channel cannot delete is reported (with its link) for HR to
   * remove by hand - it never blocks the delete.
   */
  async unpublish(tenantId: string, jobId: string, actor: Actor): Promise<UnpublishResult> {
    const [listing, company] = await Promise.all([this.store.getListing(tenantId, jobId), this.store.getCompany(tenantId)]);
    if (!listing || !company) throw jobNotFound();

    // Close first: the apply API stops at once, and a publish that has not claimed a channel yet can no longer post.
    await this.store.setListingStatus(tenantId, jobId, 'CLOSED');
    const posts = await this.store.listPosts(tenantId, jobId);
    if (posts.some((p) => p.status === 'PUBLISHING')) {
      // A channel is posting right now: deleting its row would lose the post id. Put the job back as it was.
      await this.store.setListingStatus(tenantId, jobId, listing.status);
      throw publisherError(HttpStatus.CONFLICT, 'PUBLISH_IN_PROGRESS', 'This job is being published right now. Try again in a moment.');
    }

    const [settings, tokens] = await Promise.all([this.store.getChannelSettings(tenantId), this.credentials.accessTokens(tenantId)]);
    const source = sourceOf(listing.approved, listing.selectionProcess, company);
    const removed: string[] = [];
    const notRemoved: UnpublishResult['notRemoved'] = [];
    await Promise.all(
      posts
        .filter((p) => p.status === 'PUBLISHED')
        .map(async (p) => {
          const adapter = this.adapters.find((a) => a.key === p.channel);
          if (!adapter?.remove) {
            notRemoved.push({ channel: p.channel, url: p.url, error: 'This channel cannot remove posts automatically. Delete it there by hand.' });
            return;
          }
          const ctx = this.context(tenantId, jobId, listing.slug, company, p.channel, settingFor(settings, p.channel), source, tokens);
          try {
            await this.withRetry(() => adapter.remove!(ctx, { externalId: p.externalId, url: p.url }));
            removed.push(p.channel);
          } catch (err) {
            if (!(err instanceof ChannelError)) {
              this.logger.warn(`remove failed channel=${p.channel} job=${jobId} (${err instanceof Error ? err.name : 'unknown'})`);
            }
            const error = err instanceof ChannelError ? err.message : 'Unexpected error while removing the post.';
            notRemoved.push({ channel: p.channel, url: p.url, error });
          }
        }),
    );

    await this.store.deleteListing(tenantId, jobId);
    await this.record(tenantId, actor, 'job.unpublished', jobId, { removed, notRemoved: notRemoved.map((n) => n.channel) });
    removed.sort((a, b) => a.localeCompare(b));
    return { jobId, removed, notRemoved };
  }

  /** "Delete job" (jobs module): unpublish if the job is listed. null = it was never published (or already deleted). */
  async unpublishIfListed(tenantId: string, jobId: string, actor: Actor): Promise<UnpublishResult | null> {
    if (!(await this.store.getListing(tenantId, jobId))) return null;
    return this.unpublish(tenantId, jobId, actor);
  }

  /**
   * HR "Update apply links": edits the posts already made so they carry the CURRENT apply link (CAREERS_SITE_URL),
   * keeping the same post - for when the public careers-site URL changed (e.g. a temporary tunnel restarted).
   * Posts the same text as publishing would, so nothing but the links changes. A post that cannot be edited is
   * reported (with its link) for HR to fix by hand. actor null = the automatic update at API start.
   */
  async refreshLinks(tenantId: string, jobId: string, actor: Actor | null): Promise<RefreshLinksResult> {
    const [listing, company] = await Promise.all([this.store.getListing(tenantId, jobId), this.store.getCompany(tenantId)]);
    if (!listing || !company) throw jobNotFound();
    if (!companyLink(company)) {
      throw publisherError(HttpStatus.UNPROCESSABLE_ENTITY, 'NOT_READY_TO_PUBLISH', COMPANY_LINK_MISSING, { errors: [COMPANY_LINK_MISSING] });
    }

    const [settings, posts, tokens] = await Promise.all([
      this.store.getChannelSettings(tenantId),
      this.store.listPosts(tenantId, jobId),
      this.credentials.accessTokens(tenantId),
    ]);
    const source = sourceOf(listing.approved, listing.selectionProcess, company);
    const updated: string[] = [];
    const notUpdated: RefreshLinksResult['notUpdated'] = [];
    const careersRows: { id: string; url: string | null; jobPageUrl: string }[] = [];
    await Promise.all(
      posts
        .filter((p) => p.status === 'PUBLISHED')
        .map(async (p) => {
          const adapter = this.adapters.find((a) => a.key === p.channel);
          const ctx = this.context(tenantId, jobId, listing.slug, company, p.channel, settingFor(settings, p.channel), source, tokens);
          // Our own careers page is not a post: it is always served at the current URL, only its stored link moves.
          if (adapter?.showsLatestVersion) {
            careersRows.push({ id: p.id, url: p.url, jobPageUrl: ctx.jobPageUrl });
            return;
          }
          if (!adapter?.update) {
            notUpdated.push({ channel: p.channel, url: p.url, error: 'This channel cannot edit posts automatically. Edit the link there by hand.' });
            return;
          }
          try {
            await this.withRetry(() => adapter.update!(ctx, { externalId: p.externalId, url: p.url }));
            updated.push(p.channel);
          } catch (err) {
            if (!(err instanceof ChannelError)) {
              this.logger.warn(`update failed channel=${p.channel} job=${jobId} (${err instanceof Error ? err.name : 'unknown'})`);
            }
            const error = err instanceof ChannelError ? err.message : 'Unexpected error while editing the post.';
            notUpdated.push({ channel: p.channel, url: p.url, error });
          }
        }),
    );

    // The careers row's stored link marks "posts carry the current link": it moves only once every post was edited,
    // so a failed edit stays visible on the HR board and is tried again at the next API start.
    if (!notUpdated.length) {
      for (const c of careersRows) if (c.url !== c.jobPageUrl) await this.store.setPostUrl(c.id, c.jobPageUrl);
    }
    await this.record(tenantId, actor, 'job.links_refreshed', jobId, { updated, notUpdated: notUpdated.map((n) => n.channel) });
    updated.sort((a, b) => a.localeCompare(b));
    return { jobId, applyUrl: this.jobPageUrl(company.slug, listing.slug), updated, notUpdated };
  }

  /**
   * The automatic "Update apply link in posts" for every job of every company whose posts were made under an older
   * careersSiteUrl. One job at a time (gentle on LinkedIn); a job that fails is logged and stays marked on the HR board.
   * Each company's posts are edited only with that company's own connection (same rules as publishing).
   */
  async refreshOldLinks(): Promise<{ jobs: number; failed: number }> {
    let jobs: { tenantId: string; jobId: string }[];
    try {
      jobs = await this.store.listJobsWithOldLinks(this.config.careersSiteUrl);
    } catch (err) {
      this.logger.error(`apply link update could not list jobs (${err instanceof Error ? err.name : 'unknown'})`);
      return { jobs: 0, failed: 0 };
    }
    if (!jobs.length) return { jobs: 0, failed: 0 };
    this.logger.log(`careers site URL changed: updating the apply link in the posts of ${jobs.length} job(s)`);
    let failed = 0;
    for (const { tenantId, jobId } of jobs) {
      try {
        const r = await this.refreshLinks(tenantId, jobId, null);
        if (r.notUpdated.length) {
          failed++;
          // ChannelError texts are safe to log (never tokens or raw payloads).
          this.logger.warn(`apply link not updated job=${jobId} ${r.notUpdated.map((n) => `${n.channel}: ${n.error}`).join(' | ')}`);
        }
      } catch (err) {
        failed++;
        this.logger.warn(`apply link update failed job=${jobId} (${err instanceof Error ? err.name : 'unknown'})`);
      }
    }
    this.logger.log(`apply link update done: ${jobs.length - failed} of ${jobs.length} job(s) updated`);
    return { jobs: jobs.length, failed };
  }

  async posts(tenantId: string, jobId: string) {
    const listing = await this.store.getListing(tenantId, jobId);
    if (!listing) throw jobNotFound();
    return { jobId, slug: listing.slug, version: listing.approved.version, posts: await this.store.listPosts(tenantId, jobId) };
  }

  async setChannelSetting(tenantId: string, channel: string, setting: ChannelSetting, actor: Actor) {
    await this.store.setChannelSetting(tenantId, channel, setting);
    // config keys only: values may be page ids, never secrets, but keep the audit log minimal anyway
    await this.record(tenantId, actor, 'publisher.channel_settings_updated', channel, {
      enabled: setting.enabled,
      configKeys: Object.keys(setting.config),
    });
  }

  private async auditPublish(tenantId: string, actor: Actor, action: string, r: PublishResult) {
    await this.record(tenantId, actor, action, r.jobId, {
      version: r.version,
      posts: r.posts.map((p) => ({ channel: p.channel, status: p.status })),
    });
  }

  /** M32 audit log (Intern 1's audit_logs). Ids, versions and statuses only - never JD text or personal data. */
  private record(tenantId: string, actor: Actor | null, action: string, subjectId: string, metadata: Record<string, unknown>) {
    return this.audit.record({ tenantId, actorUserId: actor?.id ?? null, action, subjectType: 'job', subjectId, metadata });
  }

  private async publishListing(listing: Listing, company: CompanyProfile): Promise<PublishResult> {
    const [settings, tokens] = await Promise.all([
      this.store.getChannelSettings(listing.tenantId),
      this.credentials.accessTokens(listing.tenantId),
    ]);
    const source = sourceOf(listing.approved, listing.selectionProcess, company);

    // Every channel runs independently: one failing (or throwing) never stops the others.
    const posts = await Promise.all(
      this.adapters
        .filter((a) => settingFor(settings, a.key).enabled)
        .map((a) => {
          const ctx = this.context(listing.tenantId, listing.jobId, listing.slug, company, a.key, settingFor(settings, a.key), source, tokens);
          return this.publishOne(a, ctx, listing.approved.jdVersionId).catch((err: unknown): ChannelPostResult => {
            this.logger.error(`publish crashed channel=${a.key} job=${listing.jobId} (${err instanceof Error ? err.name : 'unknown'})`);
            return { channel: a.key, status: 'FAILED', url: null, error: 'Unexpected error while publishing.' };
          });
        }),
    );

    return {
      jobId: listing.jobId,
      slug: listing.slug,
      version: listing.approved.version,
      applyUrl: this.jobPageUrl(company.slug, listing.slug),
      posts,
    };
  }

  private async publishOne(adapter: ChannelAdapter, ctx: ChannelContext, jdVersionId: string): Promise<ChannelPostResult> {
    const blockers = adapter.blockers(ctx);
    if (blockers.length) {
      const row = await this.store.markNotConfigured(ctx.tenantId, ctx.jobId, adapter.key, jdVersionId, blockers.join(' '));
      return { channel: adapter.key, status: row.status, url: row.url, error: row.lastError };
    }

    const claim = await this.store.claimPost(ctx.tenantId, ctx.jobId, adapter.key, jdVersionId);
    if (!claim.claimed) {
      if (claim.jobClosed) {
        return { channel: adapter.key, status: claim.post.status, url: claim.post.url, error: 'The job was closed, so nothing was posted.' };
      }
      // Already published (or being published by another request): never post the same job twice.
      // A post made earlier is NOT edited - only channels that always show the latest version (careers page) change.
      const unchanged = claim.post.status === 'PUBLISHED' && !adapter.showsLatestVersion;
      return { channel: adapter.key, status: claim.post.status, url: claim.post.url, error: claim.post.lastError, ...(unchanged ? { unchanged } : {}) };
    }

    try {
      const ref = await this.withRetry(() => adapter.publish(ctx));
      const row = await this.store.finishPost(claim.post.id, { status: 'PUBLISHED', externalId: ref.externalId, url: ref.url });
      this.events.published(ctx.tenantId, { job_id: ctx.jobId, channel: adapter.key, external_id: ref.externalId, url: ref.url });
      return { channel: adapter.key, status: row.status, url: row.url, error: null };
    } catch (err) {
      const message = err instanceof ChannelError ? err.message : 'Unexpected error while publishing.';
      if (!(err instanceof ChannelError)) {
        this.logger.error(`adapter error channel=${adapter.key} job=${ctx.jobId} (${err instanceof Error ? err.name : 'unknown'})`);
      }
      const row = await this.store.finishPost(claim.post.id, { status: 'FAILED', error: message });
      this.events.failed(ctx.tenantId, { job_id: ctx.jobId, channel: adapter.key, error: message });
      return { channel: adapter.key, status: row.status, url: row.url, error: message };
    }
  }

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await fn();
      } catch (err) {
        const retryable = err instanceof ChannelError && err.retryable;
        if (!retryable || attempt >= this.config.attempts) throw err;
        await this.config.sleep(this.config.baseDelayMs * 2 ** (attempt - 1));
      }
    }
  }

  /**
   * Loads the APPROVED version from the database and runs every publish check on it. The selection process is the
   * job's assessment round names (never what the browser sent), unless the rounds feature is off or not migrated.
   */
  private async check(tenantId: string, jobId: string, req: PublishJobRequest) {
    const approved = await this.store.getApprovedJd(tenantId, jobId);
    if (!approved) {
      throw publisherError(HttpStatus.NOT_FOUND, 'JOB_NOT_APPROVED', 'This job does not exist or its job description is not approved yet.');
    }
    const [company, listing, ai, screeningSet, rounds] = await Promise.all([
      this.store.getCompany(tenantId),
      this.store.getListing(tenantId, jobId),
      this.validator.validate(approved.jd),
      // FEATURE_ATS=off hides the settings routes, so the score cannot be set: do not demand it then
      this.screening && isFeatureOn('ats') ? this.screening.isSet(tenantId, jobId) : true,
      this.rounds && isFeatureOn('rounds') ? this.rounds.publicSteps(tenantId, jobId) : null,
    ]);
    const errors = [...basicPublishProblems(approved.form, approved.jd), ...ai.errors];
    if (!screeningSet) errors.push(MIN_ATS_SCORE_MISSING);
    if (rounds && !rounds.complete) errors.push(ROUNDS_INCOMPLETE);
    if (!companyLink(company)) errors.unshift(COMPANY_LINK_MISSING);
    if (listing?.status === 'CLOSED') errors.push('This job is closed. Reopen it first.');
    const slug = listing?.slug ?? makeJobSlug(approved.jd.title || approved.form.title, jobId);
    const selectionProcess = rounds ? rounds.steps : req.selectionProcess;
    return { approved, company, errors: [...new Set(errors)], warnings: ai.warnings, slug, selectionProcess };
  }

  private context(
    tenantId: string,
    jobId: string,
    slug: string,
    company: CompanyProfile,
    channel: string,
    setting: ChannelSetting,
    source: PostSource,
    tokens: Map<string, string | null>,
  ): ChannelContext {
    const jobPageUrl = this.jobPageUrl(company.slug, slug);
    return {
      tenantId,
      jobId,
      slug,
      jobPageUrl,
      links: { apply: `${jobPageUrl}?src=${encodeURIComponent(channel)}`, careers: companyLink(company)! },
      source,
      settings: setting.config,
      accessToken: tokens.get(channel) ?? undefined,
      reconnectNeeded: tokens.get(channel) === null,
    };
  }

  private jobPageUrl(companySlug: string, jobSlug: string) {
    return `${this.config.careersSiteUrl}/${encodeURIComponent(companySlug)}/jobs/${encodeURIComponent(jobSlug)}`;
  }
}

const MIN_ATS_SCORE_MISSING =
  'Set the minimum ATS score for this job first (open the job and fill "Minimum ATS score"). It stays private to your HR team.';

const ROUNDS_INCOMPLETE =
  'Finish the assessment rounds of this job first (every round needs its questions and passing criterion), then save them as complete.';

const COMPANY_LINK_MISSING =
  "The company's website link is missing. Ask your Company Admin to add it in the company profile (every post links to it).";

/** The company link every post carries: the website, else the careers page link (profiles made before websites). */
const companyLink = (company: CompanyProfile | null | undefined) => company?.websiteUrl || company?.careersPageUrl || null;

function sourceOf(approved: ApprovedJd, selectionProcess: string[], company: CompanyProfile): PostSource {
  return { company: { name: company.name, about: company.about }, form: approved.form, jd: approved.jd, selectionProcess };
}

function parseRequest(input: unknown): PublishJobRequest {
  const parsed = publishJobRequestSchema.safeParse(input ?? {});
  if (!parsed.success) {
    throw publisherError(HttpStatus.BAD_REQUEST, 'INVALID_PUBLISH_REQUEST', 'The selection process is invalid.', {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return parsed.data;
}

const deadlinePassed = (approved: ApprovedJd, now = new Date()) =>
  !!approved.form.deadline && new Date(approved.form.deadline) <= now;

/** P2002 on the (tenant_id, slug) unique key - not the job_id key a parallel publish of the same job hits. */
const isSlugTaken = (err: unknown) => {
  const e = err as { code?: string; meta?: { target?: unknown } };
  return e.code === 'P2002' && String(e.meta?.target ?? '').includes('slug');
};

const settingFor = (settings: Map<string, ChannelSetting>, key: string): ChannelSetting =>
  settings.get(key) ?? { enabled: true, config: {} };

const jobNotFound = () => publisherError(HttpStatus.NOT_FOUND, 'JOB_NOT_FOUND', 'Job not found.');
