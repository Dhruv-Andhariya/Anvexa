'use client';

import type { AssessmentJob, JobRounds, RoundType } from '@hireflow/contracts';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { getRounds, listAssessmentJobs } from '@/lib/rounds-api';
import { Spinner } from './ui';

const STORE_KEY = 'hf:menu-job';
const remembered = () => {
  try {
    return window.localStorage.getItem(STORE_KEY);
  } catch {
    return null;
  }
};
const remember = (jobId: string) => {
  try {
    window.localStorage.setItem(STORE_KEY, jobId);
  } catch {
    // storage blocked: the menu falls back to the first job
  }
};

interface Step {
  key: string;
  label: string;
  href: string;
}

/** Where each round of HR's process is followed in the dashboard. */
function hrefOf(jobId: string, round: { id: string; type: RoundType }): string {
  const job = encodeURIComponent(jobId);
  if (round.type === 'GROUP_DISCUSSION') return `/group-discussion?round=${encodeURIComponent(round.id)}`;
  if (round.type === 'HR_INTERVIEW') return `/personal-interview?job=${job}`;
  return `/assessments?job=${job}&round=${encodeURIComponent(round.id)}`;
}

/** The job's own steps: the fixed AI screening first, then exactly the rounds HR chose, in HR's order and names. */
function stepsOf(jobId: string, rounds: JobRounds): Step[] {
  return [
    { key: 'screening', label: rounds.fixedSteps.find((s) => /screen/i.test(s)) ?? 'AI screening', href: `/shortlisted?job=${encodeURIComponent(jobId)}` },
    ...[...rounds.rounds].sort((a, b) => a.position - b.position).map((r) => ({ key: r.id, label: r.name, href: hrefOf(jobId, r) })),
  ];
}

/** Is the browser on this step's page (same path and the same job / round in the address)? */
function isHere(href: string, pathname: string, search: string): boolean {
  const [path, q = ''] = href.split('?');
  if (pathname !== path) return false;
  const want = new URLSearchParams(q);
  const have = new URLSearchParams(search);
  for (const key of ['round', 'job'] as const) if (want.has(key) && want.get(key) !== have.get(key)) return false;
  if (!want.has('round') && have.has('round') && path === '/assessments') return false;
  return true;
}

/**
 * "Assessments" in the header: the label opens the board with every round; the menu lists the hiring process of ONE
 * job, step by step, with only the rounds HR selected for that job. The job comes from the page (?job=), else the
 * last one picked here, else the first job with rounds.
 */
export function AssessmentsMenu() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [jobs, setJobs] = useState<AssessmentJob[] | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [rounds, setRounds] = useState<{ jobId: string; data: JobRounds } | null>(null);
  const [error, setError] = useState(false);
  const box = useRef<HTMLDivElement | null>(null);

  // follow the job of the page being viewed
  useEffect(() => {
    setOpen(false);
    setSearch(window.location.search);
    const fromPage = new URLSearchParams(window.location.search).get('job');
    if (fromPage) {
      setJobId(fromPage);
      remember(fromPage);
    }
  }, [pathname]);

  // load the jobs the first time the menu opens
  useEffect(() => {
    if (!open || jobs) return;
    listAssessmentJobs()
      .then((list) => {
        setJobs(list);
        setJobId((cur) => (cur && list.some((j) => j.jobId === cur) ? cur : list.find((j) => j.jobId === remembered())?.jobId ?? list[0]?.jobId ?? null));
      })
      .catch(() => setError(true));
  }, [open, jobs]);

  // the chosen job's rounds
  useEffect(() => {
    if (!open || !jobId || rounds?.jobId === jobId) return;
    const ctrl = new AbortController();
    getRounds(jobId, { signal: ctrl.signal })
      .then((data) => setRounds({ jobId, data }))
      .catch((err) => {
        if ((err as Error).name !== 'AbortError') setError(true);
      });
    return () => ctrl.abort();
  }, [open, jobId, rounds?.jobId]);

  useEffect(() => {
    if (!open) return;
    setSearch(window.location.search);
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const active = ['/assessments', '/shortlisted', '/group-discussion', '/personal-interview'].some((p) => pathname === p || pathname.startsWith(`${p}/`));
  const steps = rounds && rounds.jobId === jobId ? stepsOf(jobId, rounds.data) : null;
  const tone = active ? 'text-foreground' : 'text-muted';

  return (
    <div ref={box} className="relative flex items-center" onMouseLeave={() => setOpen(false)}>
      <Link href="/assessments" onMouseEnter={() => setOpen(true)} className={`rounded-l-md py-1.5 pl-2.5 pr-1 hover:bg-accent-soft hover:text-foreground ${tone}`}>
        Assessments
      </Link>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Assessments: steps of a job"
        onClick={() => setOpen(!open)}
        onMouseEnter={() => setOpen(true)}
        className={`rounded-r-md py-1.5 pl-0.5 pr-2 hover:bg-accent-soft hover:text-foreground ${tone}`}
      >
        <svg aria-hidden="true" viewBox="0 0 12 12" className={`h-3 w-3 transition-transform ${open ? 'rotate-180' : ''}`}>
          <path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div role="menu" className="absolute left-0 top-full z-40 flex w-72 flex-col rounded-md border border-border bg-surface p-1 shadow-lg">
          {error ? (
            <p className="px-3 py-2 text-sm text-danger">Could not load the jobs. Try again in a moment.</p>
          ) : !jobs ? (
            <p className="flex items-center gap-2 px-3 py-2 text-sm text-muted">
              <Spinner /> Loading…
            </p>
          ) : jobs.length === 0 ? (
            <p className="px-3 py-2 text-sm text-muted">No job has assessment rounds yet. Set them up on the Publish page.</p>
          ) : (
            <>
              <label className="flex flex-col gap-1 px-3 pb-2 pt-1.5 text-xs text-muted">
                Job
                <select
                  className="rounded-md border border-border bg-surface px-2 py-1 text-sm text-foreground"
                  value={jobId ?? ''}
                  onChange={(e) => {
                    setJobId(e.target.value);
                    remember(e.target.value);
                  }}
                >
                  {jobs.map((j) => (
                    <option key={j.jobId} value={j.jobId}>
                      {j.title}
                    </option>
                  ))}
                </select>
              </label>
              {!steps ? (
                <p className="flex items-center gap-2 px-3 py-2 text-sm text-muted">
                  <Spinner /> Loading the rounds…
                </p>
              ) : (
                steps.map((s, i) => {
                  const here = isHere(s.href, pathname, search);
                  return (
                    <Link
                      key={s.key}
                      role="menuitem"
                      href={s.href}
                      aria-current={here ? 'page' : undefined}
                      onClick={() => setOpen(false)}
                      className={`flex items-center gap-2.5 rounded px-3 py-2 text-sm hover:bg-accent-soft ${here ? 'font-medium text-foreground' : 'text-muted hover:text-foreground'}`}
                    >
                      <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[11px] tabular-nums ${here ? 'border-accent bg-accent text-accent-foreground' : 'border-border'}`}>
                        {i + 1}
                      </span>
                      <span className="truncate">{s.label}</span>
                    </Link>
                  );
                })
              )}
              {steps && steps.length === 1 && <p className="px-3 py-2 text-xs text-muted">This job has no assessment rounds yet.</p>}
            </>
          )}
        </div>
      )}
    </div>
  );
}
