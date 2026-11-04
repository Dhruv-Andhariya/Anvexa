'use client';

import { PI_CALL_STATUS_LABEL, PIPELINE_STATUS_LABEL, piCallStatusSchema, type AssessmentJob, type PiBoard, type PiCallStatus, type PiCandidateRow } from '@hireflow/contracts';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { Button, Card, ErrorNotice, Spinner, inputClass } from '@/components/ui';
import { ApiError } from '@/lib/api';
import { downloadCsv, getPiBoard, updatePiCall } from '@/lib/pipeline-api';
import { listAssessmentJobs } from '@/lib/rounds-api';

const messageOf = (err: unknown) => (err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
const pct = (n: number | null) => (n === null ? '—' : `${n}%`);
const score = (s: number | null, max: number | null) => (s === null ? '—' : `${Math.round(s * 100) / 100}${max ? ` / ${max}` : ''}`);
const pill = 'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium';
const CALL_STYLE: Record<PiCallStatus, string> = {
  NOT_CALLED: 'border-border text-muted',
  CALLED: 'border-accent/40 text-accent',
  SCHEDULED: 'border-accent/40 bg-accent-soft text-accent',
  SELECTED: 'border-success/40 bg-success-soft text-success',
  REJECTED: 'border-danger/40 bg-danger-soft text-danger',
};

/**
 * HR "Personal interview": per job, only the students who cleared the technical interview, best overall score first,
 * with every round's score, the Stage 2 total and the interview remarks, plus HR's call status and notes. HR only.
 */
export function PersonalInterviewBoard() {
  const router = useRouter();
  const params = useSearchParams();
  const [jobs, setJobs] = useState<AssessmentJob[] | null>(null);
  const [error, setError] = useState('');

  const loadJobs = useCallback(async (signal?: AbortSignal) => {
    setError('');
    try {
      setJobs(await listAssessmentJobs({ signal }));
    } catch (err) {
      if (!signal?.aborted) setError(messageOf(err));
    }
  }, []);
  useEffect(() => {
    const c = new AbortController();
    void loadJobs(c.signal);
    return () => c.abort();
  }, [loadJobs]);

  const jobId = params.get('job') ?? jobs?.[0]?.jobId ?? null;
  if (error) return <ErrorNotice title="Could not load your jobs" message={error} action={<Button onClick={() => loadJobs()}>Try again</Button>} />;
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
        <h1 className="text-2xl font-semibold tracking-tight">Personal interview</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted">
          Students who cleared the technical interview, best overall score first. Call them, then record the outcome: a selected or rejected student&apos;s
          status updates everywhere.
        </p>
      </div>
      {jobs.length === 0 ? (
        <Card className="flex flex-col items-start gap-2">
          <p className="font-medium">No jobs with assessment rounds yet</p>
          <Link href="/publish" className="text-sm font-medium text-accent hover:underline">
            Open the Publish page →
          </Link>
        </Card>
      ) : (
        <>
          <label className="flex max-w-xl flex-col gap-1.5 text-sm font-medium">
            Job role
            <select className={inputClass} value={jobId ?? ''} onChange={(e) => router.replace(`/personal-interview?job=${encodeURIComponent(e.target.value)}`)}>
              {jobs.map((j) => (
                <option key={j.jobId} value={j.jobId}>
                  {j.title}
                </option>
              ))}
            </select>
          </label>
          {jobId && <JobBoard key={jobId} jobId={jobId} />}
        </>
      )}
    </div>
  );
}

function JobBoard({ jobId }: { jobId: string }) {
  const [data, setData] = useState<PiBoard | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(
    async (signal?: AbortSignal) => {
      setError('');
      try {
        setData(await getPiBoard(jobId, { signal }));
      } catch (err) {
        if (!signal?.aborted) setError(messageOf(err));
      }
    },
    [jobId],
  );
  useEffect(() => {
    const c = new AbortController();
    void load(c.signal);
    return () => c.abort();
  }, [load]);

  if (error) return <ErrorNotice title="Could not load the personal interview list" message={error} action={<Button onClick={() => load()}>Try again</Button>} />;
  if (!data) {
    return (
      <Card className="flex min-h-32 items-center justify-center gap-3 text-muted">
        <Spinner className="text-accent" /> Loading…
      </Card>
    );
  }

  const exportCsv = () => {
    const roundNames = data.candidates[0]?.rounds.map((r) => r.name) ?? [];
    downloadCsv(
      `personal-interview-${data.jobTitle.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.csv`,
      ['Name', 'Phone', 'Email', 'College', 'Aptitude %', ...roundNames, 'Stage 2 overall %', 'Tech interview remarks', 'Overall %', 'Call status', 'Notes', 'Pipeline status'],
      data.candidates.map((c) => [
        c.name,
        c.phone,
        c.email,
        c.college,
        c.aptitudePercent,
        ...c.rounds.map((r) => score(r.score, r.maxScore)),
        c.stage2Percent,
        c.techInterview?.remarks ?? '',
        c.overallPercent,
        PI_CALL_STATUS_LABEL[c.call.status],
        c.call.notes,
        PIPELINE_STATUS_LABEL[c.status],
      ]),
    );
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted">
          {data.candidates.length} student{data.candidates.length === 1 ? '' : 's'}
          {!data.hasPersonalInterviewRound && ' (this job has no HR interview round: students who cleared every round are listed)'}
        </p>
        <Button variant="secondary" onClick={exportCsv} disabled={!data.candidates.length}>
          Export CSV
        </Button>
      </div>
      {data.candidates.length === 0 ? (
        <Card>
          <p className="font-medium">Nobody has cleared the technical interview yet</p>
          <p className="mt-1 text-sm text-muted">Students appear here as soon as HR advances them after their technical interview.</p>
        </Card>
      ) : (
        <ul className="flex flex-col gap-3">
          {data.candidates.map((c, i) => (
            <CandidateCard key={c.applicationId} rank={i + 1} c={c} onSaved={setData} jobId={jobId} />
          ))}
        </ul>
      )}
    </div>
  );
}

function CandidateCard({ rank, c, jobId, onSaved }: { rank: number; c: PiCandidateRow; jobId: string; onSaved: (b: PiBoard) => void }) {
  const [status, setStatus] = useState<PiCallStatus>(c.call.status);
  const [notes, setNotes] = useState(c.call.notes);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const changed = status !== c.call.status || notes.trim() !== c.call.notes;
  const save = async () => {
    setBusy(true);
    setMessage(null);
    try {
      onSaved(await updatePiCall(jobId, c.applicationId, status, notes.trim()));
      setMessage({ ok: true, text: 'Saved.' });
    } catch (err) {
      setMessage({ ok: false, text: messageOf(err) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <li>
      <Card className="flex flex-col gap-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="font-semibold">
              <span className="mr-2 text-muted tabular-nums">#{rank}</span>
              <Link href={`/assessments/${encodeURIComponent(c.applicationId)}`} className="hover:underline">
                {c.name}
              </Link>
            </p>
            <p className="text-sm text-muted">
              {c.phone ? (
                <a href={`tel:${c.phone.replace(/[^\d+]/g, '')}`} className="font-medium text-accent hover:underline">
                  {c.phone}
                </a>
              ) : (
                'No phone'
              )}{' '}
              · <a href={`mailto:${c.email}`} className="hover:underline">{c.email}</a>
              {c.college ? ` · ${c.college}` : ''}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span className={`${pill} ${CALL_STYLE[c.call.status]}`}>{PI_CALL_STATUS_LABEL[c.call.status]}</span>
            <span className="text-lg font-semibold tabular-nums" title="Share of all marks across every round">
              {pct(c.overallPercent)}
            </span>
          </div>
        </div>
        <dl className="grid gap-2 text-sm sm:grid-cols-3 lg:grid-cols-6">
          <div>
            <dt className="text-xs text-muted">Aptitude</dt>
            <dd className="font-medium">{pct(c.aptitudePercent)}</dd>
          </div>
          {c.rounds
            .filter((r) => r.type === 'CODING' || r.type === 'SQL' || r.type === 'GROUP_DISCUSSION')
            .map((r) => (
              <div key={r.roundId}>
                <dt className="text-xs text-muted">{r.name}</dt>
                <dd className="font-medium tabular-nums">{score(r.score, r.maxScore)}</dd>
              </div>
            ))}
          <div>
            <dt className="text-xs text-muted">Stage 2 overall</dt>
            <dd className="font-medium">{pct(c.stage2Percent)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted">Technical interview</dt>
            <dd className="font-medium tabular-nums">{c.techInterview ? score(c.techInterview.score, c.techInterview.maxScore) : '—'}</dd>
          </div>
        </dl>
        {c.techInterview?.remarks && <p className="rounded-md bg-background px-3 py-2 text-sm text-muted">Interview remarks: {c.techInterview.remarks}</p>}
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-sm font-medium">
            Call status
            <select className={`${inputClass} w-auto`} value={status} onChange={(e) => setStatus(e.target.value as PiCallStatus)} disabled={busy}>
              {piCallStatusSchema.options.map((s) => (
                <option key={s} value={s}>
                  {PI_CALL_STATUS_LABEL[s]}
                </option>
              ))}
            </select>
          </label>
          <label className="flex min-w-60 flex-1 flex-col gap-1 text-sm font-medium">
            Notes
            <input className={inputClass} value={notes} maxLength={2000} onChange={(e) => setNotes(e.target.value)} disabled={busy} placeholder="e.g. Call back Thursday 4 pm" />
          </label>
          <Button disabled={!changed || busy} onClick={() => void save()}>
            {busy && <Spinner />} Save
          </Button>
        </div>
        {message && <p className={`text-xs ${message.ok ? 'text-success' : 'text-danger'}`}>{message.text}</p>}
        {c.call.updatedByName && c.call.updatedAt && (
          <p className="text-xs text-muted">
            Last updated by {c.call.updatedByName}, {new Date(c.call.updatedAt).toLocaleString()}
          </p>
        )}
      </Card>
    </li>
  );
}
