'use client';

import type { CompanyProfileRecord, JobSummary } from '@hireflow/contracts';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { confirmAndDeleteJob, dangerButton, PostsNotRemovedNotice, type DeletedJob } from '@/components/delete-job';
import { EmptyJobsArt } from '@/components/empty-art';
import { EmptyState } from '@/components/empty-state';
import { ArrowRightIcon, BriefcaseIcon, FileTextIcon, PlusIcon, SendIcon, UsersIcon } from '@/components/icons';
import { isCompanyAdmin, useSession } from '@/components/session';
import { StatTiles, type Stat } from '@/components/stat-tiles';
import { Button, Card, ErrorNotice, Spinner, StatusBadge } from '@/components/ui';
import { ApiError, getCompanyProfile, listJobs } from '@/lib/api';
import { listScreeningJobs } from '@/lib/ats-api';
import { listPublishableJobs } from '@/lib/publisher-api';

type State =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; jobs: JobSummary[]; profile: CompanyProfileRecord | null };

/** Live listings and the number of applications: extra numbers for the tiles, never a reason to fail the page. */
interface Extra {
  published: number | null;
  applications: number | null;
}

const linkButton =
  'inline-flex items-center justify-center gap-2 rounded-xl bg-accent px-4 py-2.5 text-sm font-semibold text-accent-foreground shadow-md shadow-accent/25 ' +
  'transition-all hover:-translate-y-px hover:bg-accent-hover hover:shadow-lg hover:shadow-accent/30 ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-offset-2';

export function JobsList() {
  const { session } = useSession();
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [extra, setExtra] = useState<Extra | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState('');
  /** Last delete whose posts could not all be removed automatically: HR must remove those by hand. */
  const [leftovers, setLeftovers] = useState<DeletedJob | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    setState({ kind: 'loading' });
    void Promise.allSettled([listPublishableJobs({ signal }), listScreeningJobs({ signal })]).then(([pub, scr]) => {
      if (signal?.aborted) return;
      setExtra({
        published: pub.status === 'fulfilled' ? pub.value.filter((j) => j.listing?.status === 'LIVE').length : null,
        applications: scr.status === 'fulfilled' ? scr.value.reduce((sum, j) => sum + j.counts.total, 0) : null,
      });
    });
    try {
      const [jobs, profile] = await Promise.all([listJobs({ signal }), getCompanyProfile({ signal })]);
      setState({ kind: 'ready', jobs, profile });
    } catch (err) {
      if (signal?.aborted) return;
      setState({ kind: 'error', message: err instanceof ApiError ? err.message : 'Something went wrong.' });
    }
  }, []);

  const remove = async (job: JobSummary) => {
    setDeleteError('');
    setLeftovers(null);
    setDeleting(job.id);
    try {
      const deleted = await confirmAndDeleteJob(job);
      if (!deleted) return;
      if (deleted.result.notRemoved.length) setLeftovers(deleted);
      await load();
    } catch (err) {
      setDeleteError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
    } finally {
      setDeleting(null);
    }
  };

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const ready = state.kind === 'ready';
  const jobs = ready ? state.jobs : [];
  const stats: Stat[] = [
    { label: 'Total jobs', value: ready ? jobs.length : null, icon: BriefcaseIcon, tone: 'blue' },
    { label: 'Drafts', value: ready ? jobs.filter((j) => j.status !== 'APPROVED').length : null, icon: FileTextIcon, tone: 'amber' },
    { label: 'Published', value: extra?.published ?? null, icon: SendIcon, tone: 'green' },
    { label: 'Applications', value: extra?.applications ?? null, icon: UsersIcon, tone: 'sky' },
  ];

  return (
    <div className="flex animate-fade-up flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight sm:text-[28px]">Jobs</h1>
          <p className="mt-1 text-sm text-muted">Every job, its AI-written job description, and its approval status.</p>
        </div>
        {ready && state.profile && (
          <Link href="/jobs/new" className={linkButton}>
            <PlusIcon className="h-4 w-4" /> New job
          </Link>
        )}
      </div>

      {(state.kind === 'loading' || (ready && state.profile)) && <StatTiles stats={stats} loading={!ready || extra === null} />}

      {deleteError && <ErrorNotice title="Could not delete the job" message={deleteError} />}
      {leftovers && <PostsNotRemovedNotice {...leftovers} />}

      {state.kind === 'loading' && (
        <Card className="flex min-h-40 items-center justify-center gap-3 text-muted">
          <Spinner className="text-accent" /> Loading jobs…
        </Card>
      )}

      {state.kind === 'error' && (
        <ErrorNotice title="Could not load jobs" message={state.message} action={<Button onClick={() => load()}>Try again</Button>} />
      )}

      {ready && !state.profile && (
        <Card className="relative flex flex-col items-start gap-3 overflow-hidden p-8 sm:p-10">
          <div aria-hidden="true" className="pointer-events-none absolute -right-16 -top-16 h-56 w-56 rounded-full bg-accent-soft blur-2xl" />
          <span className="relative rounded-full bg-accent-soft px-3 py-1 text-xs font-semibold text-accent">Step 1 of 4</span>
          <h2 className="relative text-xl font-bold tracking-tight">Set up your company profile first</h2>
          <p className="relative max-w-xl text-sm leading-relaxed text-muted">
            Anvexa writes every job description from two inputs: your company profile and the job requirements. Save
            the company profile once and it is loaded automatically for every job.
          </p>
          {isCompanyAdmin(session) ? (
            <Link href="/company?next=/jobs/new" className={`${linkButton} relative mt-2`}>
              Create company profile <ArrowRightIcon className="h-4 w-4" />
            </Link>
          ) : (
            <p className="relative text-sm text-muted">Ask your Company Admin to save the company profile.</p>
          )}
        </Card>
      )}

      {ready && state.profile && jobs.length === 0 && (
        <EmptyState
          art={EmptyJobsArt}
          eyebrow="Get started"
          steps={['Add the role and its requirements', 'AI drafts the job description', 'Review, approve and publish']}
          title="Your next great hire starts here"
          description="Create a job and Anvexa will draft its job description for you to review and approve."
          action={{ href: '/jobs/new', label: 'Create your first job' }}
        />
      )}

      {ready && jobs.length > 0 && (
        <Card className="overflow-x-auto p-0 sm:p-0">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-border bg-hover/60 text-xs uppercase tracking-wider text-muted">
              <tr>
                <th scope="col" className="px-5 py-3.5 font-semibold">Job title</th>
                <th scope="col" className="px-5 py-3.5 font-semibold">Status</th>
                <th scope="col" className="px-5 py-3.5 font-semibold">JD versions</th>
                <th scope="col" className="px-5 py-3.5 font-semibold">Last updated</th>
                <th scope="col" className="px-5 py-3.5 font-semibold">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((job) => (
                <tr key={job.id} className="border-b border-border transition-colors last:border-0 hover:bg-accent-soft/40">
                  <td className="px-5 py-4">
                    <Link href={`/jobs/${job.id}`} className="flex items-center gap-3 font-semibold text-foreground hover:text-accent">
                      <span aria-hidden="true" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-tone-blue-soft text-tone-blue">
                        <BriefcaseIcon className="h-4 w-4" />
                      </span>
                      <span className="min-w-0">{job.title}</span>
                    </Link>
                  </td>
                  <td className="px-5 py-4">
                    <StatusBadge status={job.status} />
                  </td>
                  <td className="px-5 py-4 tabular-nums text-muted">{job.versionCount}</td>
                  <td className="px-5 py-4 text-muted">{new Date(job.updatedAt).toLocaleString()}</td>
                  <td className="px-5 py-4 text-right">
                    <Button
                      onClick={() => void remove(job)}
                      disabled={deleting !== null}
                      className={`${dangerButton} px-2.5! py-1!`}
                      aria-label={`Delete ${job.title}`}
                    >
                      {deleting === job.id && <Spinner />}
                      Delete
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
