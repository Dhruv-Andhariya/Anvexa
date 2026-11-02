'use client';

import { ROUND_TYPES, type AssessmentJob, type AssessmentStage, type JobAssessments, type RoundCell } from '@hireflow/contracts';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { Button, Card, ErrorNotice, Spinner, inputClass } from '@/components/ui';
import { ApiError } from '@/lib/api';
import { getJobAssessments, listAssessmentJobs } from '@/lib/rounds-api';
import { OUTCOME_STYLE, OUTCOME_TEXT, STAGE_STYLE, STAGE_TEXT, pill, scoreText } from './assessment-styles';

const messageOf = (err: unknown) => (err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
type Tab = 'students' | 'rounds';
const STAGES: (AssessmentStage | 'ALL')[] = ['ALL', 'IN_PROGRESS', 'CLEARED', 'NOT_CLEARED', 'NOT_STARTED'];

/**
 * HR "Assessments": per job, every student who reached the assessment rounds with their status and score in each
 * round (sent by the round engine), pass / fail counts per round, and the job's own rounds. HR only, same company.
 */
export function AssessmentsBoard() {
  const router = useRouter();
  const params = useSearchParams();
  const [jobs, setJobs] = useState<AssessmentJob[] | null>(null);
  const [error, setError] = useState<{ message: string; notReady: boolean } | null>(null);

  const loadJobs = useCallback(async (signal?: AbortSignal) => {
    setError(null);
    try {
      setJobs(await listAssessmentJobs({ signal }));
    } catch (err) {
      if (!signal?.aborted) setError({ message: messageOf(err), notReady: err instanceof ApiError && (err.code === 'ROUNDS_NOT_READY' || err.code === 'FEATURE_DISABLED') });
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadJobs(controller.signal);
    return () => controller.abort();
  }, [loadJobs]);

  const tab: Tab = params.get('tab') === 'rounds' ? 'rounds' : 'students';
  const jobId = params.get('job') ?? jobs?.find((j) => j.roundCount > 0)?.jobId ?? jobs?.[0]?.jobId ?? null;
  const go = (next: { job?: string; tab?: Tab }) => {
    const q = new URLSearchParams({ job: next.job ?? jobId ?? '', tab: next.tab ?? tab });
    router.replace(`/assessments?${q.toString()}`);
  };

  if (error) {
    return error.notReady ? (
      <Card>
        <p className="font-medium">Assessment rounds are not set up on the server yet</p>
        <p className="mt-1 text-sm text-muted">Their database migration has not been applied. Everything else keeps working.</p>
      </Card>
    ) : (
      <ErrorNotice title="Could not load your jobs" message={error.message} action={<Button onClick={() => loadJobs()}>Try again</Button>} />
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
        <h1 className="text-2xl font-semibold tracking-tight">Assessments</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted">
          Results of the assessment rounds after resume and AI voice screening. Pick a job to see every shortlisted student,
          their result in each round, and open a student for the full review.
        </p>
      </div>

      {jobs.length === 0 ? (
        <Card className="flex flex-col items-start gap-2">
          <p className="font-medium">No approved jobs yet</p>
          <Link href="/jobs" className="text-sm font-medium text-accent hover:underline">
            Go to jobs →
          </Link>
        </Card>
      ) : (
        <>
          <label className="flex max-w-xl flex-col gap-1.5 text-sm font-medium">
            Job role
            <select className={inputClass} value={jobId ?? ''} onChange={(e) => go({ job: e.target.value })}>
              {jobs.map((j) => (
                <option key={j.jobId} value={j.jobId}>
                  {j.title} — {j.roundCount ? `${j.roundCount} round${j.roundCount === 1 ? '' : 's'}, ${j.students} student${j.students === 1 ? '' : 's'}` : 'no rounds yet'}
                </option>
              ))}
            </select>
          </label>
          {jobId && <JobResults key={jobId} jobId={jobId} tab={tab} onTab={(t) => go({ tab: t })} />}
        </>
      )}
    </div>
  );
}

function JobResults({ jobId, tab, onTab }: { jobId: string; tab: Tab; onTab: (t: Tab) => void }) {
  const [data, setData] = useState<JobAssessments | null>(null);
  const [error, setError] = useState('');
  const [stage, setStage] = useState<AssessmentStage | 'ALL'>('ALL');
  const [search, setSearch] = useState('');

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setError('');
      try {
        setData(await getJobAssessments(jobId, { signal }));
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

  if (error) return <ErrorNotice title="Could not load the results" message={error} action={<Button onClick={() => load()}>Try again</Button>} />;
  if (!data) {
    return (
      <Card className="flex min-h-32 items-center justify-center gap-3 text-muted">
        <Spinner className="text-accent" /> Loading results…
      </Card>
    );
  }

  const needle = search.trim().toLowerCase();
  const students = data.students.filter(
    (s) => (stage === 'ALL' || s.stage === stage) && (!needle || `${s.name} ${s.email} ${s.college}`.toLowerCase().includes(needle)),
  );

  return (
    <div className="flex flex-col gap-4">
      <div role="tablist" aria-label="View" className="flex gap-2 border-b border-border">
        {(
          [
            ['students', `Students (${data.students.length})`],
            ['rounds', `Assessment Rounds (${data.rounds.length})`],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            role="tab"
            type="button"
            aria-selected={tab === key}
            onClick={() => onTab(key)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm ${tab === key ? 'border-accent font-medium' : 'border-transparent text-muted hover:text-foreground'}`}
          >
            {label}
          </button>
        ))}
      </div>

      {data.roundsStatus !== 'COMPLETE' && (
        <Card className="flex flex-col items-start gap-2">
          <p className="font-medium">{data.roundsStatus === 'DRAFT' ? 'The rounds of this job are still a draft' : 'This job has no assessment rounds yet'}</p>
          <p className="text-sm text-muted">Set up its rounds, questions and passing criteria on the Publish page.</p>
          <Link href={`/publish?job=${encodeURIComponent(jobId)}`} className="text-sm font-medium text-accent hover:underline">
            Open the Publish page →
          </Link>
        </Card>
      )}

      {tab === 'rounds' ? (
        <RoundsTab data={data} jobId={jobId} />
      ) : data.rounds.length === 0 ? null : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {data.rounds.map((r) => (
              <div key={r.id} className="rounded-xl border border-border bg-surface p-4">
                <p className="truncate text-sm font-medium">
                  {r.position}. {r.name}
                </p>
                <p className="text-xs text-muted">Pass: {r.passRuleText ?? '—'}</p>
                <p className="mt-2 flex flex-wrap gap-2 text-xs">
                  <span className={`${pill} ${OUTCOME_STYLE.PASSED}`}>{r.counts.passed} passed</span>
                  <span className={`${pill} ${OUTCOME_STYLE.FAILED}`}>{r.counts.failed} failed</span>
                  <span className={`${pill} ${OUTCOME_STYLE.NOT_ATTEMPTED}`}>{r.counts.notAttempted} not attempted</span>
                </p>
              </div>
            ))}
          </div>

          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-sm font-medium">
              Status
              <select className={`${inputClass} w-auto`} value={stage} onChange={(e) => setStage(e.target.value as AssessmentStage | 'ALL')}>
                {STAGES.map((s) => (
                  <option key={s} value={s}>
                    {s === 'ALL' ? 'All students' : STAGE_TEXT[s]}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm font-medium">
              Search
              <input className={`${inputClass} w-64`} placeholder="Name, email or college" value={search} onChange={(e) => setSearch(e.target.value)} />
            </label>
            <Button className="ml-auto" onClick={() => load()}>
              Refresh
            </Button>
          </div>

          {students.length === 0 ? (
            <Card>
              <p className="text-sm text-muted">
                {data.students.length ? 'No student matches these filters.' : 'No student has reached the assessment rounds of this job yet.'}
              </p>
            </Card>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-border bg-surface">
              <table className="w-full min-w-[720px] text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted">
                    <th scope="col" className="px-3 py-2 font-medium">
                      Student
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      ATS
                    </th>
                    {data.rounds.map((r) => (
                      <th key={r.id} scope="col" className="px-3 py-2 font-medium">
                        {r.name}
                      </th>
                    ))}
                    <th scope="col" className="px-3 py-2 font-medium">
                      Status
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {students.map((s) => (
                    <tr key={s.applicationId} className="border-b border-border last:border-0 hover:bg-accent-soft/40">
                      <td className="px-3 py-2">
                        <Link href={`/assessments/${encodeURIComponent(s.applicationId)}`} className="font-medium text-accent hover:underline">
                          {s.name}
                        </Link>
                        <p className="text-xs text-muted">
                          {s.email} · {s.college}
                        </p>
                      </td>
                      <td className="px-3 py-2">{s.atsScore ?? '—'}</td>
                      {s.rounds.map((c) => (
                        <td key={c.roundId} className="px-3 py-2">
                          <Cell cell={c} />
                        </td>
                      ))}
                      <td className="px-3 py-2">
                        <span className={`${pill} ${STAGE_STYLE[s.stage]}`}>{STAGE_TEXT[s.stage]}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Cell({ cell }: { cell: RoundCell }) {
  return (
    <div className="flex flex-col items-start gap-0.5">
      <span className={`${pill} ${OUTCOME_STYLE[cell.outcome]}`}>
        {OUTCOME_TEXT[cell.outcome]}
        {cell.overridden && ' (HR)'}
      </span>
      {cell.score !== null && <span className="text-xs text-muted">{scoreText(cell.score, cell.maxScore)}</span>}
    </div>
  );
}

/** Only the rounds THIS job has (another company's jobs never show up here). */
function RoundsTab({ data, jobId }: { data: JobAssessments; jobId: string }) {
  if (!data.rounds.length) return null;
  return (
    <div className="flex flex-col gap-3">
      <ol className="flex flex-col gap-2">
        {data.rounds.map((r) => (
          <li key={r.id} className="rounded-lg border border-border bg-surface p-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-accent-soft text-xs font-semibold text-accent">{r.position}</span>
              <span className="font-medium">{r.name}</span>
              <span className={`${pill} border-border text-muted`}>{ROUND_TYPES[r.type].label}</span>
            </div>
            {r.description && <p className="mt-2 text-sm text-muted">{r.description}</p>}
            <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-4">
              <div>
                <dt className="text-xs text-muted">Passing criterion</dt>
                <dd>{r.passRuleText ?? 'Not set'}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted">Questions</dt>
                <dd>
                  {r.questionCount} ({r.totalMarks} marks)
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted">Time limit</dt>
                <dd>{r.timeLimitMinutes ? `${r.timeLimitMinutes} minutes` : 'No limit'}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted">Results</dt>
                <dd>
                  {r.counts.passed} passed · {r.counts.failed} failed
                </dd>
              </div>
            </dl>
          </li>
        ))}
      </ol>
      <p className="text-sm text-muted">
        {data.locked ? 'Students have started these rounds, so they are locked.' : 'To change the rounds or their questions, '}
        {!data.locked && (
          <Link href={`/publish?job=${encodeURIComponent(jobId)}`} className="font-medium text-accent hover:underline">
            open the Publish page
          </Link>
        )}
      </p>
    </div>
  );
}
