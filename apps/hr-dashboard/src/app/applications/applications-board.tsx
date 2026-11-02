'use client';

import type { HrApplication, JobApplications, PublishableJob } from '@hireflow/contracts';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Card, ErrorNotice, Spinner, inputClass } from '@/components/ui';
import { ApiError } from '@/lib/api';
import { listJobApplications, listPublishableJobs, resumeDownloadUrl } from '@/lib/publisher-api';

const messageOf = (err: unknown) =>
  err instanceof ApiError ? err.message : 'Something went wrong. Please try again.';
const dateTime = (iso: string) =>
  new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
const fileSize = (bytes: number) =>
  bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

/** M09 for HR: pick a published job, see everyone who applied, download their resumes. */
export function ApplicationsBoard() {
  const router = useRouter();
  const selected = useSearchParams().get('job');
  const [jobs, setJobs] = useState<PublishableJob[] | null>(null);
  const [jobsError, setJobsError] = useState('');

  const loadJobs = useCallback(async (signal?: AbortSignal) => {
    setJobsError('');
    try {
      const all = await listPublishableJobs({ signal });
      setJobs(all.filter((j) => j.listing)); // only published jobs can have applications
    } catch (err) {
      if (!signal?.aborted) setJobsError(messageOf(err));
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadJobs(controller.signal);
    return () => controller.abort();
  }, [loadJobs]);

  // No job in the URL: open the first one that has applications (else the first one).
  const jobId = selected ?? jobs?.find((j) => j.applications > 0)?.jobId ?? jobs?.[0]?.jobId ?? null;

  if (jobsError) {
    return (
      <ErrorNotice
        title="Could not load your jobs"
        message={jobsError}
        action={<Button onClick={() => loadJobs()}>Try again</Button>}
      />
    );
  }
  if (!jobs) {
    return (
      <Card className="flex min-h-48 items-center justify-center gap-3 text-muted">
        <Spinner className="text-accent" /> Loading jobs…
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Applications</h1>
        <p className="mt-1 text-sm text-muted">
          Everyone who applied through your careers page or job posts. Resumes download as files. See the ATS details on Shortlisted Students.
        </p>
      </div>

      {jobs.length === 0 ? (
        <Card className="flex flex-col items-start gap-2">
          <p className="font-medium">No published jobs yet</p>
          <p className="text-sm text-muted">Publish a job first — applications for it will show up here.</p>
          <Link href="/publish" className="text-sm font-medium text-accent hover:underline">
            Go to publish →
          </Link>
        </Card>
      ) : (
        <>
          <label className="flex max-w-xl flex-col gap-1.5 text-sm font-medium">
            Job
            <select
              className={inputClass}
              value={jobId ?? ''}
              onChange={(e) => router.replace(`/applications?job=${encodeURIComponent(e.target.value)}`)}
            >
              {jobs.map((j) => (
                <option key={j.jobId} value={j.jobId}>
                  {j.title} ({j.applications} {j.applications === 1 ? 'application' : 'applications'})
                  {j.listing?.status === 'CLOSED' ? ' · closed' : ''}
                </option>
              ))}
            </select>
          </label>
          {jobId && <JobApplicationsList key={jobId} jobId={jobId} />}
        </>
      )}
    </div>
  );
}

function JobApplicationsList({ jobId }: { jobId: string }) {
  const [data, setData] = useState<JobApplications | null>(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setError('');
      try {
        setData(await listJobApplications(jobId, { signal }));
      } catch (err) {
        if (!signal?.aborted) setError(messageOf(err));
      }
    },
    [jobId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!data || !q) return data?.applications ?? [];
    return data.applications.filter((a) =>
      [a.name, a.email, a.phone, a.college, a.degree, a.branch, a.city ?? ''].some((v) => v.toLowerCase().includes(q)),
    );
  }, [data, query]);

  if (error) {
    return (
      <ErrorNotice
        title="Could not load the applications"
        message={error}
        action={<Button onClick={() => load()}>Try again</Button>}
      />
    );
  }
  if (!data) {
    return (
      <Card className="flex min-h-32 items-center justify-center gap-3 text-muted">
        <Spinner className="text-accent" /> Loading applications…
      </Card>
    );
  }
  if (data.applications.length === 0) {
    return (
      <Card>
        <p className="font-medium">No applications yet</p>
        <p className="mt-1 text-sm text-muted">Share the apply link from the publish page to start getting applications.</p>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted">
          {shown.length === data.applications.length
            ? `${data.applications.length} ${data.applications.length === 1 ? 'application' : 'applications'}`
            : `${shown.length} of ${data.applications.length} applications`}
        </p>
        <input
          type="search"
          className={`${inputClass} max-w-xs`}
          placeholder="Search name, email, college…"
          aria-label="Search applications"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <ul className="flex flex-col gap-3">
        {shown.map((a) => (
          <li key={a.applicationId}>
            <ApplicationCard app={a} jobId={jobId} />
          </li>
        ))}
      </ul>
    </div>
  );
}

const PILL = 'inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium';

/** M11 resume screening at a glance; the details are on the Shortlisted Students page. */
function ScreeningBadge({ app, jobId }: { app: HrApplication; jobId: string }) {
  const s = app.screening;
  if (!s) return null;
  const [text, style, view] =
    s.status === 'NEEDS_REVIEW'
      ? ['Resume needs your review', 'border-danger/40 bg-danger-soft text-danger', 'needs_review']
      : s.status !== 'SCORED'
        ? ['Resume being screened…', 'border-border text-muted', 'pending']
        : s.decision === 'SHORTLISTED'
          ? [`ATS ${s.score} · Shortlisted`, 'border-success/40 bg-success-soft text-success', 'shortlisted']
          : s.decision === 'NOT_SHORTLISTED'
            ? [`ATS ${s.score} · Not shortlisted`, 'border-border text-muted', 'not_shortlisted']
            : [`ATS ${s.score}`, 'border-border text-muted', 'all'];
  const email = s.decisionEmail
    ? `${s.decisionEmail.kind === 'SHORTLIST' ? 'Shortlist' : 'Rejection'} email ${s.decisionEmail.status === 'SENT' ? 'sent' : s.decisionEmail.status === 'FAILED' ? 'failed' : 'on its way'}`
    : null;
  return (
    <p className="flex flex-wrap items-center gap-2">
      <Link href={`/shortlisted?job=${encodeURIComponent(jobId)}&view=${view}`} className={`${PILL} ${style} hover:underline`}>
        {text}
      </Link>
      {email && <span className="text-xs text-muted">{email}</span>}
    </p>
  );
}

function ApplicationCard({ app, jobId }: { app: HrApplication; jobId: string }) {
  const links = [
    { label: 'LinkedIn', href: app.linkedinUrl },
    { label: 'GitHub', href: app.githubUrl },
    { label: 'Portfolio', href: app.portfolioUrl },
    { label: 'Project', href: app.projectUrl },
  ].filter((l): l is { label: string; href: string } => !!l.href);

  return (
    <Card className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="flex min-w-0 flex-col gap-2 text-sm">
        <div>
          <p className="text-base font-semibold">{app.name}</p>
          <p className="break-all text-muted">
            <a href={`mailto:${app.email}`} className="hover:underline">
              {app.email}
            </a>{' '}
            · <a href={`tel:${app.phone}`} className="hover:underline">{app.phone}</a>
            {app.city && ` · ${app.city}`}
          </p>
        </div>
        <p>
          {app.degree} in {app.branch} · {app.college} · {app.graduationYear}
          <span className="text-muted">
            {' '}
            · {app.scoreType === 'CGPA' ? `CGPA ${app.scoreValue}` : `${app.scoreValue}%`}
          </span>
        </p>
        <p className="text-muted">
          Applied {dateTime(app.appliedAt)} · via {app.source}
        </p>
        <ScreeningBadge app={app} jobId={jobId} />
        {links.length > 0 && (
          <p className="flex flex-wrap gap-3">
            {links.map((l) => (
              <a key={l.label} href={l.href} target="_blank" rel="noopener noreferrer" className="font-medium text-accent hover:underline">
                {l.label} ↗
              </a>
            ))}
          </p>
        )}
      </div>
      <div className="shrink-0">
        {app.resume ? (
          <a
            href={resumeDownloadUrl(app.applicationId)}
            className="inline-flex items-center gap-2 rounded-md border border-border px-3.5 py-2 text-sm font-medium hover:bg-accent-soft"
            title={app.resume.fileName}
          >
            Download resume
            <span className="text-xs text-muted">{fileSize(app.resume.sizeBytes)}</span>
          </a>
        ) : (
          <span className="text-sm text-muted">No resume</span>
        )}
      </div>
    </Card>
  );
}
