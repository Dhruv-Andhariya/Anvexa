import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getJobs } from '@/lib/api';

export const dynamic = 'force-dynamic'; // always the current list of live jobs

type Params = { params: Promise<{ company: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { company } = await params;
  const jobs = await getJobs(company);
  const name = jobs?.[0]?.company.name ?? company;
  return { title: `Jobs at ${name}` };
}

/** M08: all live jobs of one company. */
export default async function CompanyJobsPage({ params }: Params) {
  const { company } = await params;
  const all = await getJobs(company);
  if (!all) notFound();
  // Safety net: the API already leaves out closed / past-deadline jobs.
  const jobs = all.filter((job) => job.status === 'LIVE');

  return (
    <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <h1 className="text-2xl font-semibold tracking-tight">Open jobs{jobs[0] ? ` at ${jobs[0].company.name}` : ''}</h1>
      {jobs.length === 0 ? (
        <p className="mt-4 text-muted">No open jobs right now. Please check again later.</p>
      ) : (
        <ul className="mt-6 grid gap-3">
          {jobs.map((job) => (
            <li key={job.jobId}>
              <Link
                href={`/${encodeURIComponent(company)}/jobs/${encodeURIComponent(job.slug)}`}
                className="block rounded-xl border border-border bg-surface p-4 transition hover:border-accent"
              >
                <p className="font-medium">{job.jd.title}</p>
                <p className="mt-1 text-sm text-muted">
                  {job.display.location}
                  {job.display.salary ? ` · ${job.display.salary}` : ''}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
