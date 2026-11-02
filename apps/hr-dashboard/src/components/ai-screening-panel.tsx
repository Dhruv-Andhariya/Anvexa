'use client';

import type { AiScreeningDetail, AiScreeningDisplayStatus, AiScreeningExtraction, AiScreeningReviewStatus } from '@hireflow/contracts';
import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '@/lib/api';
import { getScreening, retryScreeningSummary, setScreeningReview } from '@/lib/screening-api';
import { Button, Spinner, inputClass } from './ui';

const pill = 'inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium';
const STATUS: Record<AiScreeningDisplayStatus, { label: string; style: string }> = {
  NOT_STARTED: { label: 'Not started', style: 'border-border text-muted' },
  IN_PROGRESS: { label: 'In progress', style: 'border-accent/40 bg-accent-soft text-accent' },
  COMPLETED: { label: 'Completed', style: 'border-success/40 bg-success-soft text-success' },
  INTERRUPTED: { label: 'Interrupted', style: 'border-danger/40 bg-danger-soft text-danger' },
  EXPIRED: { label: 'Link expired', style: 'border-border text-muted' },
};
const REVIEW: Record<AiScreeningReviewStatus, string> = { PENDING: 'Not reviewed', REVIEWED: 'Reviewed', NEEDS_FOLLOW_UP: 'Needs follow-up' };
const STEP: Record<string, string> = {
  INTRO: 'Introduction',
  EDUCATION: 'Education',
  BACKGROUND: 'Background',
  LOCATION: 'Location',
  AVAILABILITY: 'Availability',
  CANDIDATE_QUESTIONS: 'Candidate questions',
};

const messageOf = (err: unknown) => (err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
const when = (iso: string | null) => (iso ? new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso)) : '-');

/**
 * M12 AI screening round of one shortlisted application: status, question-by-question transcript and the structured
 * notes. Information for HR only - there is no score and no automatic decision.
 */
export function AiScreeningPanel({ applicationId, canWrite = true }: { applicationId: string; canWrite?: boolean }) {
  const [data, setData] = useState<AiScreeningDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(
    (signal?: AbortSignal) =>
      getScreening(applicationId, { signal })
        .then((d) => {
          setData(d);
          setError(null);
        })
        .catch((err) => {
          if ((err as Error).name !== 'AbortError') setError(messageOf(err));
        }),
    [applicationId],
  );

  useEffect(() => {
    const ctrl = new AbortController();
    void load(ctrl.signal);
    return () => ctrl.abort();
  }, [load]);

  const act = async (key: string, fn: () => Promise<AiScreeningDetail>) => {
    setBusy(key);
    try {
      setData(await fn());
      setError(null);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(null);
    }
  };

  if (!data) {
    return (
      <div className="rounded-md border border-border px-3 py-2 text-sm text-muted">
        AI screening: {error ? <span className="text-danger">{error}</span> : <Spinner className="h-3 w-3" />}
      </div>
    );
  }

  const status = STATUS[data.status];
  return (
    <section className="flex flex-col gap-3 rounded-md border border-border px-3 py-3 text-sm" aria-label="AI screening round">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">AI screening</span>
        <span className={`${pill} ${status.style}`}>{status.label}</span>
        <span className="text-muted">
          {data.stepsDone} of {data.totalSteps} topics
          {data.completedAt ? ` · completed ${when(data.completedAt)}` : data.startedAt ? ` · started ${when(data.startedAt)}` : ''}
        </span>
        {data.status !== 'COMPLETED' && data.linkExpiresAt && <span className="text-muted">· link valid until {when(data.linkExpiresAt)}</span>}
        <span className="ml-auto" />
        {data.turns.length > 0 && (
          <Button variant="ghost" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
            {open ? 'Hide screening' : 'View screening'}
          </Button>
        )}
      </div>
      {error && <p className="text-danger">{error}</p>}

      {open && (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor={`review-${applicationId}`} className="text-muted">
              HR review
            </label>
            <select
              id={`review-${applicationId}`}
              className={`${inputClass} w-auto`}
              value={data.reviewStatus}
              disabled={!canWrite || busy !== null}
              onChange={(e) => void act('review', () => setScreeningReview(applicationId, e.target.value as AiScreeningReviewStatus))}
            >
              {Object.entries(REVIEW).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            {busy === 'review' && <Spinner className="h-3 w-3" />}
            {data.consentGivenAt && <span className="text-xs text-muted">Voice consent given {when(data.consentGivenAt)}</span>}
            {data.endedReason === 'CANDIDATE_ENDED' && <span className="text-xs text-muted">The candidate ended the screening early.</span>}
          </div>

          <Summary data={data} canWrite={canWrite} busy={busy} onRetry={() => void act('summary', () => retryScreeningSummary(applicationId))} />

          <div className="flex flex-col gap-2">
            <h4 className="font-semibold">Transcript</h4>
            <ol className="flex flex-col gap-2">
              {data.turns.map((t) => (
                <li key={t.seq} className="rounded-md border border-border p-3">
                  <p className="text-xs text-muted">
                    #{t.seq} · {STEP[t.step]}
                    {t.kind === 'FOLLOW_UP' ? ' · follow-up' : ''} · {when(t.answeredAt)}
                    {t.answerSeconds !== null ? ` · ${Math.round(t.answerSeconds)} s` : ''}
                  </p>
                  <p className="mt-1 text-muted">
                    <span className="font-medium text-foreground">AI:</span> {t.question}
                  </p>
                  <p className="mt-1">
                    <span className="font-medium">Candidate:</span> {t.answer}
                  </p>
                  {t.aiReply && (
                    <p className="mt-1 text-muted">
                      <span className="font-medium text-foreground">AI reply:</span> {t.aiReply}
                    </p>
                  )}
                </li>
              ))}
            </ol>
          </div>
        </div>
      )}
    </section>
  );
}

function Summary({ data, canWrite, busy, onRetry }: { data: AiScreeningDetail; canWrite: boolean; busy: string | null; onRetry: () => void }) {
  const r = data.result;
  if (!r || r.status === 'PENDING') {
    return (
      <p className="text-muted">
        {r ? 'The summary is being prepared…' : 'The summary is prepared when the candidate finishes.'}{' '}
        {canWrite && !r && data.turns.length > 0 && (
          <button type="button" className="underline" onClick={onRetry} disabled={busy !== null}>
            Prepare it now
          </button>
        )}
      </p>
    );
  }
  if (r.status === 'FAILED' || !r.extraction) {
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-md border border-danger/40 bg-danger-soft px-3 py-2 text-danger">
        The summary could not be prepared{r.error ? `: ${r.error}` : '.'} The transcript below is complete.
        {canWrite && (
          <Button onClick={onRetry} disabled={busy !== null}>
            {busy === 'summary' && <Spinner />} Try again
          </Button>
        )}
      </div>
    );
  }
  return <Extraction x={r.extraction} />;
}

function Extraction({ x }: { x: AiScreeningExtraction }) {
  const rows: [string, string | null][] = [
    ['Name (as stated)', x.introduction.statedName],
    ['Introduction', x.introduction.summary],
    ['Degree', [x.education.degree, x.education.fieldOfStudy].filter(Boolean).join(' - ') || null],
    ['College / university', x.education.institution],
    ['Current year / semester', x.education.currentYearOrSemester],
    ['Expected graduation', x.education.expectedGraduation],
    ['Background', x.background.summary],
    ['Projects', x.background.projects.join('; ') || null],
    ['Internships / work', x.background.internshipsOrWork.join('; ') || null],
    ['Interests', x.background.interests.join(', ') || null],
    ['Current location', x.location.currentLocation],
    ['OK with job location', choice(x.location.willingToWorkAtJobLocation)],
    ['Relocation', x.location.relocationNotes],
    ['Currently', x.availability.currentStatus],
    ['Availability', x.availability.availability],
    ['Joining timeline', x.availability.joiningTimeline],
    ['Constraints', x.availability.constraints],
    ['College permission / NOC', choice(x.availability.collegePermission)],
  ];
  return (
    <div className="flex flex-col gap-3">
      <h4 className="font-semibold">Notes from the conversation</h4>
      {x.summary && <p>{x.summary}</p>}
      <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-[minmax(0,14rem)_1fr]">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted">{label}</dt>
            <dd className={value ? '' : 'text-muted italic'}>{value ?? 'not mentioned'}</dd>
          </div>
        ))}
      </dl>
      {x.candidateQuestions.length > 0 && (
        <div>
          <h5 className="font-medium">Candidate’s questions</h5>
          <ul className="list-disc pl-5">
            {x.candidateQuestions.map((q, i) => (
              <li key={i}>
                {q.question}
                {q.answerGiven && <span className="text-muted"> - answered: {q.answerGiven}</span>}
                {!q.answeredFromVerifiedInfo && <span className="text-danger"> (no verified answer - please follow up)</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {x.unclear.length > 0 && (
        <div>
          <h5 className="font-medium">Unclear or not answered</h5>
          <ul className="list-disc pl-5 text-muted">
            {x.unclear.map((u, i) => (
              <li key={i}>{u}</li>
            ))}
          </ul>
        </div>
      )}
      <p className="text-xs text-muted">AI-generated notes from the candidate’s own words. Check them against the transcript; they are not a score or a decision.</p>
    </div>
  );
}

function choice(v: string): string | null {
  return v === 'UNKNOWN' ? null : v.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
}
