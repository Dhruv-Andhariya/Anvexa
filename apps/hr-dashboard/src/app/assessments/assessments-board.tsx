'use client';

import { PIPELINE_STATUS_LABEL, ROUND_MODULE_LABEL, ROUND_TYPES, isRejection, type JobPipelineStatuses, type AiScreeningProgress, type AssessmentRoundSummary, type AssessmentJob, type AssessmentStage, type JobAssessments, type RoundCell } from '@hireflow/contracts';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { Button, Card, ErrorNotice, Spinner, inputClass } from '@/components/ui';
import { ApiError } from '@/lib/api';
import { downloadCsv, getPipelineStatuses } from '@/lib/pipeline-api';
import { getJobAssessments, listAssessmentJobs } from '@/lib/rounds-api';
import { GdRecordings } from './gd-recordings';
import { OUTCOME_STYLE, OUTCOME_TEXT, STAGE_STYLE, STAGE_TEXT, pill, scoreText } from './assessment-styles';

const messageOf = (err: unknown) => (err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
type Tab = 'students' | 'rounds';
const STAGES: (AssessmentStage | 'ALL')[] = ['ALL', 'IN_PROGRESS', 'CLEARED', 'NOT_CLEARED', 'NOT_STARTED'];

/**
 * HR "Assessments": per job, every student who reached the assessment rounds with their resume (ATS) score, AI voice
 * screening, and status and score in each round (online tests, group discussion...), pass / fail counts per round, and
 * the job's own rounds. HR only, same company.
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
  const jobId = params.get('job') ?? jobs?.[0]?.jobId ?? null;
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
          Every round of the hiring process: resume (ATS) score, AI voice screening, and each assessment round. Pick a job to see every shortlisted student,
          their result in each round, and open a student for the full review.
        </p>
      </div>

      {jobs.length === 0 ? (
        <Card className="flex flex-col items-start gap-2">
          <p className="font-medium">No assessments yet</p>
          <p className="text-sm text-muted">A job shows up here once you create its assessment rounds on the Publish page.</p>
          <Link href="/publish" className="text-sm font-medium text-accent hover:underline">
            Open the Publish page →
          </Link>
        </Card>
      ) : (
        <>
          <label className="flex max-w-xl flex-col gap-1.5 text-sm font-medium">
            Job role
            <select className={inputClass} value={jobId ?? ''} onChange={(e) => go({ job: e.target.value })}>
              {jobs.map((j) => (
                <option key={j.jobId} value={j.jobId}>
                  {j.title} — {j.roundCount} round{j.roundCount === 1 ? '' : 's'}, {j.students} student{j.students === 1 ? '' : 's'}
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
  const [pipeline, setPipeline] = useState<JobPipelineStatuses | null>(null);
  const [error, setError] = useState('');
  const [stage, setStage] = useState<AssessmentStage | 'ALL'>('ALL');
  const [search, setSearch] = useState('');

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setError('');
      try {
        // pipeline statuses are extra detail: the board still works if they cannot be loaded
        const [assessments, statuses] = await Promise.all([getJobAssessments(jobId, { signal }), getPipelineStatuses(jobId, { signal }).catch(() => null)]);
        setData(assessments);
        setPipeline(statuses);
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

  const pipelineOf = new Map((pipeline?.students ?? []).map((p) => [p.applicationId, p]));
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
      ) : data.rounds.length === 0 && data.students.length === 0 ? null : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {data.rounds.map((r) => (
              <div key={r.id} className="rounded-xl border border-border bg-surface p-4">
                <p className="truncate text-sm font-medium">
                  {r.position}. {r.name}
                </p>
                <p className="text-xs text-muted">Pass: {r.passRuleText ?? '—'}</p>
                {r.type === 'GROUP_DISCUSSION' && (
                  <Link href={`/group-discussion?round=${encodeURIComponent(r.id)}`} className="text-xs font-medium text-accent hover:underline">
                    Manage groups →
                  </Link>
                )}
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
            <Button
              className="ml-auto"
              variant="secondary"
              disabled={!students.length}
              onClick={() =>
                downloadCsv(
                  `assessments-${data.jobTitle.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.csv`,
                  ['Name', 'Email', 'College', 'Resume (ATS)', ...data.rounds.map((r) => r.name), 'Stage', 'Pipeline status', 'Stage 2 overall %'],
                  students.map((st) => [
                    st.name,
                    st.email,
                    st.college,
                    st.atsScore,
                    ...st.rounds.map((c) => `${OUTCOME_TEXT[c.outcome]}${c.score !== null ? ` (${scoreText(c.score, c.maxScore)})` : ''}`),
                    STAGE_TEXT[st.stage],
                    pipelineOf.get(st.applicationId) ? PIPELINE_STATUS_LABEL[pipelineOf.get(st.applicationId)!.status] : '',
                    pipelineOf.get(st.applicationId)?.stage2?.percent ?? '',
                  ]),
                )
              }
            >
              Export CSV
            </Button>
            <Button onClick={() => load()}>Refresh</Button>
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
                      Resume (ATS)
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      AI screening
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
                      <td className="px-3 py-2">
                        <AiScreeningCell value={s.aiScreening} />
                      </td>
                      {s.rounds.map((c) => (
                        <td key={c.roundId} className="px-3 py-2">
                          <Cell cell={c} />
                        </td>
                      ))}
                      <td className="px-3 py-2">
                        <span className={`${pill} ${STAGE_STYLE[s.stage]}`}>{STAGE_TEXT[s.stage]}</span>
                        <PipelineCell row={pipelineOf.get(s.applicationId)} />
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

/** The student's pipeline stage, the specific rejection reason, and the Stage 2 overall percentage. */
function PipelineCell({ row }: { row: JobPipelineStatuses['students'][number] | undefined }) {
  if (!row) return null;
  return (
    <div className="mt-1 flex flex-col gap-0.5 text-xs">
      <span className={isRejection(row.status) ? 'font-medium text-danger' : row.status === 'SELECTED' ? 'font-medium text-success' : 'text-muted'}>
        {PIPELINE_STATUS_LABEL[row.status]}
      </span>
      {row.stage2?.decided && row.stage2.percent !== null && (
        <span className="text-muted">
          Stage 2: {row.stage2.percent}% ({row.stage2.scored} / {row.stage2.total})
        </span>
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
      {cell.progress && <span className="text-xs text-muted">{cell.progress}</span>}
    </div>
  );
}

const AI_SCREENING: Record<AiScreeningProgress['status'], { text: string; style: string }> = {
  INVITED: { text: 'Link sent', style: OUTCOME_STYLE.NOT_ATTEMPTED },
  NOT_STARTED: { text: 'Opened, not started', style: OUTCOME_STYLE.NOT_ATTEMPTED },
  IN_PROGRESS: { text: 'In progress', style: STAGE_STYLE.IN_PROGRESS },
  COMPLETED: { text: 'Completed', style: OUTCOME_STYLE.PASSED },
  ENDED_EARLY: { text: 'Ended early', style: OUTCOME_STYLE.FAILED },
};
const AI_REVIEW: Record<NonNullable<AiScreeningProgress['review']>, string> = {
  PENDING: 'HR review pending',
  REVIEWED: 'Reviewed by HR',
  NEEDS_FOLLOW_UP: 'Needs follow-up',
};

function AiScreeningCell({ value }: { value: AiScreeningProgress | null }) {
  if (!value) return <span className={`${pill} ${OUTCOME_STYLE.NOT_ATTEMPTED}`}>Not invited</span>;
  const s = AI_SCREENING[value.status];
  return (
    <div className="flex flex-col items-start gap-0.5">
      <span className={`${pill} ${s.style}`}>{s.text}</span>
      {value.review && (value.status === 'COMPLETED' || value.status === 'ENDED_EARLY') && <span className="text-xs text-muted">{AI_REVIEW[value.review]}</span>}
    </div>
  );
}

/** Who runs a round: the online test, a round module (GD, DSA, SQL, AI interview) once it is connected, or HR. */
function RunBy({ round: r }: { round: AssessmentRoundSummary }) {
  const text =
    r.runBy === 'ONLINE_TEST'
      ? 'Online test, graded automatically. Students get the link by email.'
      : r.runBy === 'HR'
        ? 'Run by HR (for example an interview). Students who pass the round before get an email that HR will contact them.'
        : r.moduleConnected
          ? `Run by the ${ROUND_MODULE_LABEL[r.module!]}. Students who pass the round before are sent to it, and its results and answers are saved here.`
          : `Will be run by the ${ROUND_MODULE_LABEL[r.module!]}, which is not connected yet. Until then HR runs this round; its results and answers appear here as soon as the module records them.`;
  return (
    <p className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted">
      {r.runBy === 'MODULE' && (
        <span className={`${pill} ${r.moduleConnected ? OUTCOME_STYLE.PASSED : OUTCOME_STYLE.NOT_ATTEMPTED}`}>{r.moduleConnected ? 'Connected' : 'Not connected yet'}</span>
      )}
      {text}
    </p>
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
              {r.type === 'GROUP_DISCUSSION' && (
                <Link href={`/group-discussion?round=${encodeURIComponent(r.id)}`} className="ml-auto text-sm font-medium text-accent hover:underline">
                  Manage groups, topic and live room →
                </Link>
              )}
            </div>
            <RunBy round={r} />
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
            {r.type === 'GROUP_DISCUSSION' && (
              <div className="mt-4 border-t border-border pt-3">
                <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">Session recordings</p>
                <GdRecordings roundId={r.id} />
              </div>
            )}
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
