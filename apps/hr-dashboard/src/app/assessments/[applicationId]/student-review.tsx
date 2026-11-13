'use client';

import { QUESTION_KINDS, type ApplicationRoundEngine, type RoundEngineRound, type StudentAssessment, type StudentRoundReview } from '@hireflow/contracts';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { AiInterviewPanel } from '@/components/ai-interview-panel';
import { AiScreeningPanel } from '@/components/ai-screening-panel';
import { OnlineTestPanel } from '@/components/online-test-panel';
import { Button, Card, ErrorNotice, Spinner, inputClass } from '@/components/ui';
import { ApiError } from '@/lib/api';
import { getRoundEngine } from '@/lib/round-engine-api';
import { getStudentAssessment, overrideRoundResult } from '@/lib/rounds-api';
import { OUTCOME_STYLE, OUTCOME_TEXT, STAGE_STYLE, STAGE_TEXT, pill, scoreText } from '../assessment-styles';

const messageOf = (err: unknown) => (err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
const date = (iso: string) => new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));

/** One student's full review in one place: resume score, AI voice screening notes, and every round with answers. */
export function StudentReview({ applicationId }: { applicationId: string }) {
  const [data, setData] = useState<StudentAssessment | null>(null);
  const [engine, setEngine] = useState<ApplicationRoundEngine | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setError('');
      // online test details (M13) are extra: the review still shows when they cannot be loaded
      void getRoundEngine(applicationId, { signal })
        .then(setEngine)
        .catch(() => undefined);
      try {
        setData(await getStudentAssessment(applicationId, { signal }));
      } catch (err) {
        if (!signal?.aborted) setError(messageOf(err));
      }
    },
    [applicationId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  if (error) return <ErrorNotice title="Could not load this student" message={error} action={<Button onClick={() => load()}>Try again</Button>} />;
  if (!data) {
    return (
      <Card className="flex min-h-48 items-center justify-center gap-3 text-muted">
        <Spinner className="text-muted" /> Loading…
      </Card>
    );
  }

  const c = data.candidate;
  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href={`/assessments?job=${encodeURIComponent(data.jobId)}`} className="text-sm font-medium text-accent underline decoration-accent/30 underline-offset-2 hover:decoration-accent">
          ← {data.jobTitle} assessments
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold tracking-tight">{c.name}</h1>
          <span className={`${pill} ${STAGE_STYLE[data.stage]}`}>{STAGE_TEXT[data.stage]}</span>
        </div>
        <p className="mt-1 text-sm text-muted">
          {c.email} · {c.phone} · {c.degree} {c.branch}, {c.college} ({c.graduationYear})
        </p>
      </div>

      <Card className="flex flex-col gap-3">
        <h2 className="text-base font-semibold">1. Resume screening</h2>
        {data.resume?.score !== null && data.resume?.score !== undefined ? (
          <>
            <p className="text-sm">
              ATS score <span className="text-lg font-semibold">{data.resume.score}</span>
              <span className="text-muted"> / 100</span>
              {data.resume.minAtsScore !== null && <span className="text-muted"> · minimum {data.resume.minAtsScore}</span>}
              {data.resume.decision && (
                <span className={`${pill} ml-2 ${data.resume.decision === 'SHORTLISTED' ? OUTCOME_STYLE.PASSED : OUTCOME_STYLE.FAILED}`}>
                  {data.resume.decision === 'SHORTLISTED' ? 'Shortlisted' : 'Not shortlisted'}
                </span>
              )}
            </p>
            {data.resume.breakdown && (
              <ul className="grid gap-2 text-sm sm:grid-cols-2">
                {data.resume.breakdown.map((p) => (
                  <li key={p.key} className="rounded-md border border-border px-3 py-2">
                    <span className="font-medium">{p.label}</span>{' '}
                    <span className="text-muted">
                      {p.points} / {p.max}
                    </span>
                    <p className="text-xs text-muted">{p.reason}</p>
                  </li>
                ))}
              </ul>
            )}
            {(data.resume.matchedSkills.length > 0 || data.resume.missingSkills.length > 0) && (
              <p className="text-sm text-muted">
                {data.resume.matchedSkills.length > 0 && <>Matched: {data.resume.matchedSkills.join(', ')}. </>}
                {data.resume.missingSkills.length > 0 && <>Missing: {data.resume.missingSkills.join(', ')}.</>}
              </p>
            )}
          </>
        ) : (
          <p className="text-sm text-muted">No ATS score for this student.</p>
        )}
      </Card>

      <Card className="flex flex-col gap-3">
        <h2 className="text-base font-semibold">2. AI voice screening</h2>
        {data.hasVoiceScreening ? <AiScreeningPanel applicationId={applicationId} /> : <p className="text-sm text-muted">This student has not done the AI voice screening.</p>}
      </Card>

      {data.rounds.length === 0 ? (
        <Card>
          <p className="text-sm text-muted">This job has no assessment rounds yet.</p>
        </Card>
      ) : (
        data.rounds.map((r, i) => (
          <RoundReview
            key={r.round.id}
            applicationId={applicationId}
            review={r}
            step={i + 3}
            onChanged={setData}
            onReload={() => void getStudentAssessment(applicationId).then(setData).catch(() => undefined)}
            online={engine?.rounds.find((e) => e.roundId === r.round.id)}
            onOnlineChanged={(d) => {
              setEngine(d);
              // an integrity decision may change the round's result (HR override): show it at once
              void getStudentAssessment(applicationId).then(setData).catch(() => undefined);
            }}
          />
        ))
      )}
    </div>
  );
}

function RoundReview({
  applicationId,
  review,
  step,
  onChanged,
  onReload,
  online,
  onOnlineChanged,
}: {
  applicationId: string;
  review: StudentRoundReview;
  step: number;
  onChanged: (d: StudentAssessment) => void;
  /** The round result changed elsewhere (AI interview decision): load the review again. */
  onReload: () => void;
  /** How the round engine ran this round online (invite, attempt, proctoring); undefined when not loaded. */
  online?: RoundEngineRound;
  onOnlineChanged: (d: ApplicationRoundEngine) => void;
}) {
  const [showAnswers, setShowAnswers] = useState(false);
  const r = review.round;
  const attempted = review.outcome !== 'NOT_ATTEMPTED';

  return (
    <Card className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-base font-semibold">
          {step}. {r.name}
        </h2>
        <span className={`${pill} ${OUTCOME_STYLE[review.outcome]}`}>
          {OUTCOME_TEXT[review.outcome]}
          {review.override && ' (changed by HR)'}
        </span>
      </div>

      <dl className="grid gap-3 text-sm sm:grid-cols-4">
        <div>
          <dt className="text-xs text-muted">Score</dt>
          <dd className="font-medium">{review.score !== null ? scoreText(review.score, review.maxScore) : '—'}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Pass mark</dt>
          <dd>{r.passRuleText ?? '—'}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted">System result</dt>
          <dd>{review.systemPassed === null ? '—' : review.systemPassed ? 'Passed' : 'Failed'}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Submitted</dt>
          <dd>{review.submittedAt ? date(review.submittedAt) : '—'}</dd>
        </div>
      </dl>

      {/* a round a module runs (GD, AI interview) has its own panel, not the "run by HR" note */}
      {online && (online.online || r.runBy !== 'MODULE') && <OnlineTestPanel applicationId={applicationId} round={online} onChanged={onOnlineChanged} />}
      {r.type === 'AI_INTERVIEW' && <AiInterviewPanel applicationId={applicationId} roundId={r.id} onDecided={onReload} />}

      {review.override && (
        <p className="rounded-md border border-border bg-accent-soft px-3 py-2 text-sm">
          HR marked this round <strong>{review.override.passed ? 'passed' : 'failed'}</strong>
          {review.override.by && <> ({review.override.by}, {date(review.override.at)})</>}: {review.override.reason}
        </p>
      )}
      {review.notes && <p className="whitespace-pre-wrap rounded-md border border-border px-3 py-2 text-sm">Notes: {review.notes}</p>}

      {attempted && (
        <>
          <OverrideForm applicationId={applicationId} review={review} onChanged={onChanged} />
          {review.answers.length > 0 && (
            <div>
              <Button variant="ghost" className="px-2 py-1" onClick={() => setShowAnswers(!showAnswers)} aria-expanded={showAnswers}>
                {showAnswers ? '▴ Hide answers' : `▾ Show answers (${review.answers.filter((a) => a.answered).length} of ${review.answers.length} answered)`}
              </Button>
              {showAnswers && <Answers review={review} />}
            </div>
          )}
        </>
      )}
    </Card>
  );
}

function Answers({ review }: { review: StudentRoundReview }) {
  return (
    <ol className="mt-2 flex flex-col gap-2">
      {review.answers.map((a) => (
        <li key={a.questionId} className="rounded-md border border-border p-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">Q{a.position}</span>
            <span className="text-xs text-muted">
              {QUESTION_KINDS[a.kind].label} · {a.marks} mark{a.marks === 1 ? '' : 's'}
            </span>
            {a.isCorrect !== null && <span className={`${pill} ${a.isCorrect ? OUTCOME_STYLE.PASSED : OUTCOME_STYLE.FAILED}`}>{a.isCorrect ? 'Correct' : 'Wrong'}</span>}
            {a.marksAwarded !== null && <span className="text-xs text-muted">{a.marksAwarded} awarded</span>}
          </div>
          <p className="mt-1 whitespace-pre-wrap">{a.text}</p>
          {a.options.length > 0 ? (
            <ul className="mt-2 flex flex-col gap-1">
              {a.options.map((o, j) => (
                <li key={j} className={a.correct.includes(j) ? 'text-success' : a.selected.includes(j) ? 'text-danger' : 'text-muted'}>
                  {a.selected.includes(j) ? '●' : '○'} {o}
                  {a.correct.includes(j) && ' (correct)'}
                </li>
              ))}
            </ul>
          ) : (
            <div className="mt-2 flex flex-col gap-2">
              <pre className={`whitespace-pre-wrap rounded-md bg-background p-2 ${a.kind === 'CODING' ? 'font-mono text-xs' : 'font-sans'}`}>
                {a.answer ?? 'Not answered'}
              </pre>
              {a.modelAnswer && <p className="whitespace-pre-wrap text-xs text-muted">Expected: {a.modelAnswer}</p>}
            </div>
          )}
          {a.feedback && <p className="mt-2 text-xs text-muted">Feedback: {a.feedback}</p>}
        </li>
      ))}
    </ol>
  );
}

/** HR changes pass / fail with a reason (or goes back to the system result). */
function OverrideForm({ applicationId, review, onChanged }: { applicationId: string; review: StudentRoundReview; onChanged: (d: StudentAssessment) => void }) {
  const [open, setOpen] = useState(false);
  const [passed, setPassed] = useState(!(review.override?.passed ?? review.systemPassed));
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const send = async (value: boolean | null) => {
    setError('');
    setBusy(true);
    try {
      onChanged(await overrideRoundResult(applicationId, review.round.id, { passed: value, reason: value === null ? '' : reason }));
      setOpen(false);
      setReason('');
    } catch (err) {
      setError(messageOf(err));
    }
    setBusy(false);
  };

  if (!open) {
    return (
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => setOpen(true)}>Change result</Button>
        {review.override && (
          <Button variant="ghost" disabled={busy} onClick={() => void send(null)}>
            {busy && <Spinner />}
            Back to the system result
          </Button>
        )}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2 rounded-md border border-border p-3">
      <fieldset className="flex gap-4 text-sm">
        <legend className="mb-1 text-sm font-medium">Mark this round as</legend>
        <label className="flex items-center gap-1.5">
          <input type="radio" name={`pass-${review.round.id}`} checked={passed} onChange={() => setPassed(true)} /> Passed
        </label>
        <label className="flex items-center gap-1.5">
          <input type="radio" name={`pass-${review.round.id}`} checked={!passed} onChange={() => setPassed(false)} /> Failed
        </label>
      </fieldset>
      <label className="flex flex-col gap-1 text-sm font-medium">
        Reason <span className="text-xs font-normal text-muted">(required, kept in the audit log)</span>
        <textarea rows={2} className={inputClass} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button variant="primary" disabled={busy || reason.trim().length < 5} onClick={() => void send(passed)}>
          {busy && <Spinner />}
          Save
        </Button>
        <Button onClick={() => setOpen(false)} disabled={busy}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
