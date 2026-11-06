'use client';

import type { CompanyProfileRecord, JobSummary } from '@hireflow/contracts';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { confirmAndDeleteJob, dangerButton, PostsNotRemovedNotice, type DeletedJob } from '@/components/delete-job';
import { isCompanyAdmin, useSession } from '@/components/session';
import { Button, Card, ErrorNotice, Spinner, StatusBadge } from '@/components/ui';
import { ApiError, getCompanyProfile, listJobs } from '@/lib/api';

type State =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; jobs: JobSummary[]; profile: CompanyProfileRecord | null };

const linkButton =
  'inline-flex items-center justify-center rounded-md bg-accent px-3.5 py-2 text-sm font-medium text-accent-foreground hover:opacity-90';

export function JobsList() {
  const { session } = useSession();
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [deleting, setDeleting] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState('');
  /** Last delete whose posts could not all be removed automatically: HR must remove those by hand. */
  const [leftovers, setLeftovers] = useState<DeletedJob | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    setState({ kind: 'loading' });
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

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Jobs</h1>
          <p className="mt-1 text-sm text-muted">Every job, its AI-written job description, and its approval status.</p>
        </div>
        {state.kind === 'ready' && state.profile && (
          <Link href="/jobs/new" className={linkButton}>
            New job
          </Link>
        )}
      </div>

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

      {state.kind === 'ready' && !state.profile && (
        <Card className="flex flex-col items-start gap-3">
          <p className="text-sm font-medium text-accent">Step 1 of 4</p>
          <h2 className="text-lg font-semibold">Set up your company profile first</h2>
          <p className="max-w-xl text-sm text-muted">
            ANVEXA writes every job description from two inputs: your company profile and the job requirements. Save
            the company profile once and it is loaded automatically for every job.
          </p>
          {isCompanyAdmin(session) ? (
            <Link href="/company?next=/jobs/new" className={linkButton}>
              Create company profile
            </Link>
          ) : (
            <p className="text-sm text-muted">Ask your Company Admin to save the company profile.</p>
          )}
        </Card>
      )}

      {state.kind === 'ready' && state.profile && state.jobs.length === 0 && (
        <Card className="flex flex-col items-center gap-2 py-12 text-center">
          <p className="font-medium">No jobs yet</p>
          <p className="max-w-sm text-sm text-muted">Create a job and ANVEXA will draft its job description for you to review and approve.</p>
          <Link href="/jobs/new" className={`${linkButton} mt-2`}>
            Create your first job
          </Link>
        </Card>
      )}

      {state.kind === 'ready' && state.jobs.length > 0 && (
        <Card className="overflow-x-auto p-0 sm:p-0">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-border text-xs uppercase tracking-wide text-muted">
              <tr>
                <th scope="col" className="px-5 py-3 font-medium">Job title</th>
                <th scope="col" className="px-5 py-3 font-medium">Status</th>
                <th scope="col" className="px-5 py-3 font-medium">JD versions</th>
                <th scope="col" className="px-5 py-3 font-medium">Last updated</th>
                <th scope="col" className="px-5 py-3 font-medium">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {state.jobs.map((job) => (
                <tr key={job.id} className="border-b border-border last:border-0 hover:bg-accent-soft/50">
                  <td className="px-5 py-3">
                    <Link href={`/jobs/${job.id}`} className="font-medium hover:text-accent hover:underline">
                      {job.title}
                    </Link>
                  </td>
                  <td className="px-5 py-3">
                    <StatusBadge status={job.status} />
                  </td>
                  <td className="px-5 py-3 text-muted">{job.versionCount}</td>
                  <td className="px-5 py-3 text-muted">{new Date(job.updatedAt).toLocaleString()}</td>
                  <td className="px-5 py-3 text-right">
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
