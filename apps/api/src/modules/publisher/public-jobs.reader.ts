import { Inject, Injectable } from '@nestjs/common';
import type { PublicJob } from '@hireflow/contracts';
import { deadlineInWords, locationInWords, salaryInWords, whoCanApply } from './post-formatter';
import { PUBLISHER_CONFIG, type PublisherConfig } from './publisher.service';
import { PublisherStore, type CompanyProfile, type Listing } from './publisher.store';

/**
 * Read-only view of published jobs for the careers site and the apply flow (M08/M09).
 * Exported through index.ts - the only way other modules may read publisher data.
 * Always returns the APPROVED JD version the listing points at, never a draft.
 */
@Injectable()
export class PublicJobsReader {
  constructor(
    @Inject(PublisherStore) private readonly store: PublisherStore,
    @Inject(PUBLISHER_CONFIG) private readonly config: PublisherConfig,
  ) {}

  /** Public careers-site links of a job (no tracking params) and of the company's "my data" page. */
  urls(companySlug: string, jobSlug: string) {
    const company = `${this.config.careersSiteUrl}/${encodeURIComponent(companySlug)}`;
    return { jobPage: `${company}/jobs/${encodeURIComponent(jobSlug)}`, myData: `${company}/my-data` };
  }

  async company(companySlug: string): Promise<CompanyProfile | null> {
    return this.store.getCompanyBySlug(companySlug);
  }

  async job(companySlug: string, jobSlug: string): Promise<{ company: CompanyProfile; listing: Listing; view: PublicJob } | null> {
    const company = await this.store.getCompanyBySlug(companySlug);
    if (!company) return null;
    const listing = await this.store.getListingBySlug(company.tenantId, jobSlug);
    if (!listing) return null;
    return { company, listing, view: toPublicJob(company, listing) };
  }

  /**
   * Job titles (approved version) of this tenant's jobs, for the student's "my data" page and HR's applications
   * list. A job HR deleted from the publish page has no listing any more but keeps its applications, so its
   * latest approved title is used then.
   */
  async jobTitles(tenantId: string, jobIds: string[]): Promise<Map<string, string>> {
    const titles = await Promise.all(
      [...new Set(jobIds)].map(async (id) => {
        const listing = await this.store.getListing(tenantId, id);
        const approved = listing?.approved ?? (await this.store.getApprovedJd(tenantId, id));
        return approved ? ([id, approved.jd.title || approved.form.title] as const) : null;
      }),
    );
    return new Map(titles.filter((t): t is readonly [string, string] => !!t));
  }

  async liveJobs(companySlug: string): Promise<PublicJob[] | null> {
    const company = await this.store.getCompanyBySlug(companySlug);
    if (!company) return null;
    const listings = await this.store.listListings(company.tenantId, 'LIVE');
    // A LIVE listing whose last date to apply has passed is closed for students: leave it out of the open jobs.
    return listings.map((l) => toPublicJob(company, l)).filter((j) => j.status === 'LIVE');
  }
}

function toPublicJob(company: CompanyProfile, l: Listing): PublicJob {
  const { form, jd, version, approvedAt } = l.approved;
  const deadlinePassed = !!form.deadline && new Date(form.deadline) <= new Date();
  return {
    jobId: l.jobId,
    slug: l.slug,
    version,
    company: { slug: company.slug, name: company.name, about: company.about, careersPageUrl: company.careersPageUrl },
    form,
    jd,
    selectionProcess: l.selectionProcess,
    approvedAt: approvedAt.toISOString(),
    status: l.status === 'LIVE' && !deadlinePassed ? 'LIVE' : 'CLOSED',
    display: {
      location: locationInWords(form),
      salary: salaryInWords(form) ?? null,
      whoCanApply: whoCanApply(form),
      deadline: deadlineInWords(form) ?? null,
    },
  };
}
