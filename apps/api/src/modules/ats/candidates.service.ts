import { HttpStatus, Inject, Injectable, Optional } from '@nestjs/common';
import {
  atsPartSchema,
  autoRejectionReasonSchema,
  candidateViewSchema,
  jobFormSchema,
  parsedResumeSchema,
  type CandidateView,
  type JobCandidates,
  type ScreenedCandidate,
  type ScreeningCounts,
  type ScreeningDecision,
  type ScreeningJob,
} from '@hireflow/contracts';
import type { Prisma } from '@prisma/client';
import { apiError } from '../../common/api-error';
import { PrismaService } from '../../common/prisma.service';
import { AUTO_REJECTION, AUTO_SHORTLIST, autoRejectionFromEnv, autoShortlistFromEnv } from './auto-rejection';
import { SCREENING_BASE_URL } from './decision.service';
import { atsNotReady, isMissingTable } from './screening-settings.service';

type Bucket = 'shortlisted' | 'not_shortlisted' | 'undecided' | 'needs_review' | 'pending';

interface EvalLike {
  status: string;
  systemDecision: ScreeningDecision | null;
  hrDecision: ScreeningDecision | null;
}

/** Where a candidate shows up. No evaluation row yet = still waiting for screening. */
function bucketOf(e: EvalLike | null | undefined): Bucket {
  if (!e || e.status === 'PENDING' || e.status === 'PROCESSING') return 'pending';
  if (e.status === 'NEEDS_REVIEW') return 'needs_review';
  const decision = e.hrDecision ?? e.systemDecision;
  return decision === 'SHORTLISTED' ? 'shortlisted' : decision === 'NOT_SHORTLISTED' ? 'not_shortlisted' : 'undecided';
}

function countsOf(buckets: Bucket[]): ScreeningCounts {
  const n = (b: Bucket) => buckets.filter((x) => x === b).length;
  return {
    total: buckets.length,
    shortlisted: n('shortlisted'),
    notShortlisted: n('not_shortlisted'),
    undecided: n('undecided'),
    needsReview: n('needs_review'),
    pending: n('pending'),
  };
}

/**
 * HR's "Shortlisted Students" views. Only the session's company; the default view shows ONLY shortlisted
 * candidates (ATS threshold met, or HR shortlisted them). Everyone stays on the Applications page as before.
 */
@Injectable()
export class CandidatesService {
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(SCREENING_BASE_URL) private readonly screeningBaseUrl: string | null,
    @Optional() @Inject(AUTO_REJECTION) private readonly autoReject: boolean = autoRejectionFromEnv(),
    @Optional() @Inject(AUTO_SHORTLIST) private readonly autoShortlist: boolean = autoShortlistFromEnv(),
  ) {}

  /** Every approved job with its screening counts, newest first (the job picker). */
  async jobs(tenantId: string): Promise<ScreeningJob[]> {
    return this.guard(async () => {
      const jobs = await this.db.job.findMany({
        where: { tenantId, status: 'APPROVED' },
        orderBy: { createdAt: 'desc' },
        select: { id: true, title: true, screeningSettings: { select: { minAtsScore: true } } },
      });
      const apps = await this.db.application.findMany({
        where: { tenantId, jobId: { in: jobs.map((j) => j.id) } },
        select: { jobId: true, atsEvaluation: { select: { status: true, systemDecision: true, hrDecision: true } } },
      });
      const bucketsByJob = new Map<string, Bucket[]>();
      for (const a of apps) {
        const list = bucketsByJob.get(a.jobId);
        if (list) list.push(bucketOf(a.atsEvaluation));
        else bucketsByJob.set(a.jobId, [bucketOf(a.atsEvaluation)]);
      }
      return jobs.map((j) => ({
        jobId: j.id,
        title: j.title,
        minAtsScore: j.screeningSettings?.minAtsScore ?? null,
        counts: countsOf(bucketsByJob.get(j.id) ?? []),
      }));
    });
  }

  async candidates(tenantId: string, jobId: string, viewInput: unknown): Promise<JobCandidates> {
    const parsed = candidateViewSchema.safeParse(viewInput ?? 'shortlisted');
    if (!parsed.success) throw apiError(HttpStatus.BAD_REQUEST, 'INVALID_VIEW', 'Unknown list view.');
    const view: CandidateView = parsed.data;
    return this.guard(async () => {
      const job = await this.db.job.findFirst({
        where: { id: jobId, tenantId },
        select: { title: true, formData: true, screeningSettings: { select: { minAtsScore: true } } },
      });
      if (!job) throw apiError(HttpStatus.NOT_FOUND, 'JOB_NOT_FOUND', 'Job not found.');
      const form = jobFormSchema.safeParse(job.formData);
      const requiredExperienceMin = form.success ? form.data.experienceMin : null;
      const rows = await this.db.application.findMany({
        where: { tenantId, jobId },
        orderBy: { createdAt: 'desc' },
        include: CANDIDATE_INCLUDE,
      });
      const buckets = rows.map((r) => bucketOf(r.atsEvaluation));
      const shown = rows
        .filter((_, i) => view === 'all' || buckets[i] === view)
        .map((r) => toCandidate(r, requiredExperienceMin))
        // best first where there is a score; newest application first otherwise (the order of the query)
        .sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
      return {
        jobId,
        jobTitle: job.title,
        view,
        minAtsScore: job.screeningSettings?.minAtsScore ?? null,
        shortlistEmailsReady: !!this.screeningBaseUrl,
        autoRejectionEmails: this.autoReject,
        autoShortlistEmails: this.autoShortlist,
        counts: countsOf(buckets),
        candidates: shown,
      };
    });
  }

  private async guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (isMissingTable(err)) throw atsNotReady();
      throw err;
    }
  }
}

const CANDIDATE_INCLUDE = {
  candidate: { select: { name: true, email: true, phone: true, city: true } },
  resume: { select: { fileName: true, mimeType: true, sizeBytes: true } },
  atsEvaluation: true,
  decisionEmail: { select: { kind: true, status: true, sentAt: true, lastError: true } },
  screeningInvite: { select: { expiresAt: true } },
} satisfies Prisma.ApplicationInclude;

type Row = Prisma.ApplicationGetPayload<{ include: typeof CANDIDATE_INCLUDE }>;

function toCandidate(r: Row, requiredExperienceMin: number | null): ScreenedCandidate {
  const e = r.atsEvaluation;
  const breakdown = atsPartSchema.array().safeParse(e?.breakdown);
  const profile = parsedResumeSchema.safeParse(e?.parsedProfile);
  return {
    applicationId: r.id,
    name: r.candidate.name,
    email: r.email ?? r.candidate.email,
    phone: r.candidate.phone,
    city: r.candidate.city,
    college: r.college,
    degree: r.degree,
    branch: r.branch,
    graduationYear: r.graduationYear,
    experienceYears: r.experienceYears?.toNumber() ?? null,
    appliedAt: r.createdAt.toISOString(),
    links: { linkedinUrl: r.linkedinUrl, githubUrl: r.githubUrl, portfolioUrl: r.portfolioUrl, projectUrl: r.projectUrl },
    resume: r.resume,
    status: e?.status ?? 'PENDING',
    lastError: e && e.status !== 'SCORED' ? e.lastError : null,
    score: e?.score ?? null,
    minAtsScore: e?.minAtsScore ?? null,
    breakdown: breakdown.success ? breakdown.data : null,
    matchedSkills: e?.matchedSkills ?? [],
    missingSkills: e?.missingSkills ?? [],
    profile: profile.success ? profile.data : null,
    systemDecision: e?.systemDecision ?? null,
    hrDecision: e?.hrDecision ?? null,
    decision: e?.status === 'SCORED' ? (e.hrDecision ?? e.systemDecision) : null,
    autoRejectionReason: autoRejectionReasonSchema.safeParse(e?.autoRejectionReason).data ?? null,
    requiredExperienceMin,
    hrDecidedAt: e?.hrDecidedAt?.toISOString() ?? null,
    scoredAt: e?.scoredAt?.toISOString() ?? null,
    decisionEmail: r.decisionEmail
      ? { kind: r.decisionEmail.kind, status: r.decisionEmail.status, sentAt: r.decisionEmail.sentAt?.toISOString() ?? null, error: r.decisionEmail.lastError }
      : null,
    screeningLinkExpiresAt: r.decisionEmail?.status === 'SENT' ? (r.screeningInvite?.expiresAt.toISOString() ?? null) : null,
  };
}
