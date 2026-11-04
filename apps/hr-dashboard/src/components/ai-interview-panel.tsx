'use client';

import {
  AI_INTERVIEW_DIMENSIONS,
  AI_INTERVIEW_RECOMMENDATION_LABEL,
  AI_INTERVIEW_VIOLATION_LABEL,
  type AiInterviewDecision,
  type AiInterviewHrRound,
  type AiInterviewHrView,
  type AiInterviewRecommendation,
  type AiInterviewReport,
  type AiInterviewSource,
  type AiInterviewViolationOutcome,
} from '@hireflow/contracts';
import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '@/lib/api';
import { decideAiInterview, getAiInterviews, retryAiInterviewReport } from '@/lib/ai-interview-api';
import { Button, Spinner, inputClass } from './ui';

const pill = 'inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium';
const messageOf = (err: unknown) => (err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
const when = (iso: string | null) => (iso ? new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso)) : '-');
const minutes = (s: number) => `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`;

const STATUS: Record<string, { label: string; style: string }> = {
  INVITED: { label: 'Invited', style: 'border-border text-muted' },
  NOT_STARTED: { label: 'Not started', style: 'border-border text-muted' },
  IN_PROGRESS: { label: 'In progress', style: 'border-accent/40 bg-accent-soft text-accent' },
  PAUSED: { label: 'Paused', style: 'border-accent/40 bg-accent-soft text-accent' },
  COMPLETED: { label: 'Completed', style: 'border-success/40 bg-success-soft text-success' },
  INCOMPLETE: { label: 'Incomplete', style: 'border-danger/40 bg-danger-soft text-danger' },
  TERMINATED: { label: 'Terminated', style: 'border-danger/40 bg-danger-soft text-danger' },
};
const OUTCOME: Record<Exclude<AiInterviewViolationOutcome, 'IGNORED'>, string> = {
  WARNING: 'Warning',
  TERMINATED: 'Terminated the interview',
  RECORDED: 'Recorded (not a warning)',
  GROUPED: 'Same incident',
};
const RECOMMENDATION_STYLE: Record<AiInterviewRecommendation, string> = {
  STRONGLY_RECOMMENDED: 'border-success/40 bg-success-soft text-success',
  RECOMMENDED: 'border-success/40 bg-success-soft text-success',
  NEEDS_HUMAN_REVIEW: 'border-accent/40 bg-accent-soft text-accent',
  NOT_RECOMMENDED: 'border-danger/40 bg-danger-soft text-danger',
};
const SOURCE: Record<AiInterviewSource, string> = {
  INTRO: 'Greeting',
  RESUME: 'From the resume',
  JOB: 'Job skill',
  SCENARIO: 'Scenario',
  HR: 'Your question',
  FOLLOW_UP: 'Follow-up',
  CLOSING: 'Closing',
};
const ENDED: Record<string, string> = {
  AI_CONCLUDED: 'the interviewer concluded',
  TIME_UP: 'the time ran out',
  MAX_TURNS: 'the question limit was reached',
  CANDIDATE_ENDED: 'the candidate ended it',
  ABANDONED: 'the candidate left and did not come back',
  MAX_WARNINGS_EXCEEDED: 'terminated: the warning limit was exceeded',
};
const READING: Record<string, string> = {
  STRONG: 'strong',
  DETAILED: 'detailed',
  INCOMPLETE: 'incomplete',
  VAGUE: 'vague',
  INCORRECT: 'incorrect',
  OFF_TOPIC: 'off topic',
  DONT_KNOW: "didn't know",
  UNCLEAR_AUDIO: 'unclear audio',
  READY: 'ready',
};
const EVENT: Record<string, string> = {
  CAMERA_LOST: 'Camera turned off',
  CAMERA_RESTORED: 'Camera back on',
  MIC_LOST: 'Microphone stopped',
  MIC_RESTORED: 'Microphone back',
  CONNECTION_LOST: 'Connection lost',
  CONNECTION_RESTORED: 'Connection back',
  PAGE_HIDDEN: 'Switched away from the page',
  PAGE_VISIBLE: 'Back on the page',
  PAGE_CLOSED: 'Page closed or reloaded',
  QUESTION_REPEATED: 'Asked to repeat the question',
  PAUSED: 'Interview paused (clock stopped)',
  RESUMED: 'Interview resumed',
};

/**
 * The AI technical interview rounds of one student: status, the evidence-based report, the question-by-question
 * transcript (raw words + normalised technical terms), device / connection events, and HR's decision. The AI's score
 * and recommendation are advice: nothing happens to the student until HR decides here.
 */
export function AiInterviewPanel({ applicationId, roundId, onDecided }: { applicationId: string; roundId: string; onDecided: () => void }) {
  const [data, setData] = useState<AiInterviewHrView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    (signal?: AbortSignal) =>
      getAiInterviews(applicationId, { signal })
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

  // while an interview runs or its report is being written, refresh now and then
  const round = data?.rounds.find((r) => r.roundId === roundId);
  const live = round && (round.session?.status === 'IN_PROGRESS' || round.session?.status === 'PAUSED' || round.report?.status === 'PENDING');
  useEffect(() => {
    if (!live) return;
    const id = window.setInterval(() => void load(), 15_000);
    return () => window.clearInterval(id);
  }, [live, load]);

  if (!data) {
    return (
      <div className="rounded-md border border-border px-3 py-2 text-sm text-muted">
        AI technical interview: {error ? <span className="text-danger">{error}</span> : <Spinner className="h-3 w-3" />}
      </div>
    );
  }
  if (!round) return <p className="text-sm text-muted">This round is not an AI technical interview.</p>;

  return (
    <RoundPanel
      applicationId={applicationId}
      round={round}
      onChanged={(d) => {
        setData(d);
        onDecided();
      }}
      onRetried={setData}
    />
  );
}

function RoundPanel({ applicationId, round, onChanged, onRetried }: { applicationId: string; round: AiInterviewHrRound; onChanged: (d: AiInterviewHrView) => void; onRetried: (d: AiInterviewHrView) => void }) {
  const [showTranscript, setShowTranscript] = useState(false);
  const [showEvents, setShowEvents] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const s = round.session;
  const status = s ? STATUS[s.status]! : round.invite ? STATUS.INVITED! : null;
  const report = round.report?.data ?? null;

  const retry = async () => {
    setBusy(true);
    try {
      onRetried(await retryAiInterviewReport(applicationId, round.roundId));
      setError(null);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4 rounded-md border border-border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold">AI technical interview</h3>
        {status && <span className={`${pill} ${status.style}`}>{status.label}</span>}
        {report && <span className={`${pill} ${RECOMMENDATION_STYLE[report.recommendation]}`}>AI: {AI_INTERVIEW_RECOMMENDATION_LABEL[report.recommendation]}</span>}
        {round.integrity?.status === 'INTEGRITY_VIOLATION_REVIEW' && <span className={`${pill} border-danger/40 bg-danger-soft text-danger`}>Integrity review (INTEGRITY_VIOLATION_REVIEW)</span>}
        {round.integrity?.status === 'REVIEWED' && <span className={`${pill} border-border text-muted`}>Integrity reviewed</span>}
        {round.integrity?.settings && s && s.status !== 'NOT_STARTED' && (
          <span className={`${pill} ${round.integrity.warningCount > 0 ? 'border-accent/40 bg-accent-soft text-accent' : 'border-border text-muted'}`}>
            Warnings {Math.min(round.integrity.warningCount, round.integrity.settings.maxWarnings)}/{round.integrity.settings.maxWarnings}
          </span>
        )}
      </div>

      {!s && (
        <p className="text-sm text-muted">
          {round.invite
            ? round.invite.status === 'SENT'
              ? `Invitation sent ${when(round.invite.sentAt)}; the link works until ${when(round.invite.expiresAt)}. The student has not opened it yet.`
              : round.invite.status === 'FAILED'
                ? `The invitation email could not be sent: ${round.invite.lastError ?? 'unknown error'}.`
                : `Invitation queued${round.invite.lastError ? ` (${round.invite.lastError})` : ''}.`
            : 'The student will be invited automatically once they pass the round before this one.'}
        </p>
      )}

      {s && (
        <dl className="grid gap-3 text-sm sm:grid-cols-4">
          <Fact label="Started" value={when(s.startedAt)} />
          <Fact label="Interview time" value={`${minutes(s.durationSeconds)} of ${round.durationMinutes} min`} />
          <Fact label="Questions answered" value={String(s.questionsAnswered)} />
          <Fact label="Ended" value={s.completedAt ? `${when(s.completedAt)}${s.endedReason ? ` - ${ENDED[s.endedReason] ?? s.endedReason}` : ''}` : '-'} />
          {s.pausedSeconds > 0 && <Fact label="Paused (device / connection)" value={minutes(s.pausedSeconds)} />}
        </dl>
      )}

      {round.integrity && s && s.status !== 'NOT_STARTED' && <IntegrityView integrity={round.integrity} />}

      {round.report?.status === 'PENDING' && (
        <p className="flex items-center gap-2 text-sm text-muted">
          <Spinner className="h-3 w-3" /> The AI is writing the report…
        </p>
      )}
      {round.report?.status === 'FAILED' && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-danger/40 bg-danger-soft px-3 py-2 text-sm text-danger">
          <span>The report could not be created: {round.report.lastError}</span>
          <Button onClick={() => void retry()} disabled={busy}>
            {busy && <Spinner />} Try again
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}

      {report && <ReportView report={report} round={round} />}

      {s && round.turns.length > 0 && (
        <div>
          <Button variant="ghost" className="px-2 py-1" onClick={() => setShowTranscript(!showTranscript)} aria-expanded={showTranscript}>
            {showTranscript ? '▴ Hide transcript' : `▾ Show transcript (${round.turns.length} answers)`}
          </Button>
          {showTranscript && <Transcript round={round} report={report} />}
        </div>
      )}

      {round.events.length > 0 && (
        <div>
          <Button variant="ghost" className="px-2 py-1" onClick={() => setShowEvents(!showEvents)} aria-expanded={showEvents}>
            {showEvents ? '▴ Hide device and connection events' : `▾ Device and connection events (${round.events.length})`}
          </Button>
          {showEvents && (
            <div className="mt-2 flex flex-col gap-2">
              <p className="text-xs text-muted">
                Facts reported by the candidate&apos;s browser. They are not scored and are not evidence of misconduct on their own: a camera can drop because of a
                driver, a connection because of the network.
              </p>
              <ol className="flex flex-col gap-1 text-sm">
                {round.events.map((e, i) => (
                  <li key={i} className="flex flex-wrap gap-2">
                    <span className="tabular-nums text-muted">{when(e.at)}</span>
                    <span>{EVENT[e.type] ?? e.type}</span>
                    {e.detail && <span className="text-xs text-muted">({e.detail})</span>}
                  </li>
                ))}
              </ol>
            </div>
          )}
        </div>
      )}

      {round.decision ? (
        <p className="rounded-md border border-border bg-accent-soft px-3 py-2 text-sm">
          HR decision: <strong>{round.decision.decision === 'ADVANCE' ? 'advanced to the next step' : 'rejected'}</strong>
          {round.decision.by && <> ({round.decision.by}, {when(round.decision.at)})</>}
          {round.decision.reason && <>: {round.decision.reason}</>}
        </p>
      ) : (
        round.canDecide && <DecisionForm applicationId={applicationId} round={round} onChanged={onChanged} />
      )}
      {!round.decision && s && (s.status === 'COMPLETED' || s.status === 'INCOMPLETE' || s.status === 'TERMINATED') && !round.proposedScore && (
        <p className="text-sm text-danger">This round has no interviewer-score pass rule yet. Set it on the Publish page to record a decision.</p>
      )}
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted">{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

/** Interview protection: the warnings, every incident, and the termination. HR reviews; nothing here is automatic. */
function IntegrityView({ integrity }: { integrity: NonNullable<AiInterviewHrRound['integrity']> }) {
  const [open, setOpen] = useState(integrity.status === 'INTEGRITY_VIOLATION_REVIEW');
  const settings = integrity.settings;
  if (!settings) return <p className="text-xs text-muted">Interview protection: not monitored (this interview was opened before protection was switched on).</p>;
  const terminated = integrity.terminatedAt !== null;
  return (
    <div className={`flex flex-col gap-2 rounded-md border p-3 ${terminated ? 'border-danger/40 bg-danger-soft' : 'border-border'}`}>
      {terminated && (
        <div className="text-sm">
          <p className="font-medium text-danger">The interview was terminated automatically on {when(integrity.terminatedAt)}.</p>
          {integrity.terminationReason && <p>Reason: {integrity.terminationReason}.</p>}
          <p className="mt-1 text-xs text-muted">
            This is not a rejection. Review the incidents below and the transcript, then decide. The answers given before the termination are saved and
            evaluated.
          </p>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" className="px-2 py-1" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? '▴ Hide' : '▾ Show'} protection incidents ({integrity.violations.length})
        </Button>
        <span className="text-xs text-muted">
          Rules: up to {settings.maxWarnings} warning{settings.maxWarnings === 1 ? '' : 's'}; tab / window switching {settings.tabSwitchMonitoring ? 'monitored' : 'not monitored'};
          fullscreen {settings.fullscreenRequired ? 'required' : 'not required'}; camera {settings.cameraPolicy === 'WARN' ? 'warns' : 'pauses only'}; microphone{' '}
          {settings.microphonePolicy === 'WARN' ? 'warns' : 'pauses only'}; multiple faces{' '}
          {settings.multipleFacesPolicy === 'WARN' ? 'warn' : settings.multipleFacesPolicy === 'RECORD' ? 'recorded only' : 'not checked'}.
        </span>
      </div>
      {open &&
        (integrity.violations.length === 0 ? (
          <p className="text-sm text-muted">No monitored incident.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[34rem] text-left text-sm">
              <thead className="text-xs text-muted">
                <tr>
                  <th className="py-1 pr-3 font-medium">Time</th>
                  <th className="py-1 pr-3 font-medium">Incident</th>
                  <th className="py-1 pr-3 font-medium">Result</th>
                  <th className="py-1 pr-3 font-medium">Acknowledged</th>
                  <th className="py-1 font-medium">Resolved</th>
                </tr>
              </thead>
              <tbody>
                {integrity.violations.map((v, i) => (
                  <tr key={i} className="border-t border-border align-top">
                    <td className="py-1 pr-3 tabular-nums text-muted">{when(v.at)}</td>
                    <td className="py-1 pr-3">{AI_INTERVIEW_VIOLATION_LABEL[v.type]}</td>
                    <td className="py-1 pr-3">
                      {OUTCOME[v.outcome as keyof typeof OUTCOME] ?? v.outcome}
                      {v.warningNumber !== null && (v.outcome === 'WARNING' || v.outcome === 'GROUPED') && ` (#${v.warningNumber})`}
                    </td>
                    <td className="py-1 pr-3 text-muted">{v.acknowledgedAt ? when(v.acknowledgedAt) : v.outcome === 'WARNING' ? 'Not yet' : '-'}</td>
                    <td className="py-1 text-muted">{v.resolvedAt ? when(v.resolvedAt) : '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      <p className="text-xs text-muted">
        Browser signals only: the page knows it was hidden or lost focus, never what the candidate opened. A camera or microphone can stop for technical
        reasons. &quot;More than one face&quot; is a count made on the candidate&apos;s device (no image kept): a photo, a poster or someone walking past can cause
        it.
      </p>
    </div>
  );
}

function ReportView({ report, round }: { report: AiInterviewReport; round: AiInterviewHrRound }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-6">
        <div>
          <p className="text-xs text-muted">AI overall score</p>
          <p className="text-2xl font-semibold">
            {report.overallScore ?? '-'}
            <span className="text-sm font-normal text-muted"> / 100</span>
          </p>
        </div>
        {round.proposedScore && (
          <div>
            <p className="text-xs text-muted">As the round&apos;s interviewer score</p>
            <p className="text-sm">
              <strong>
                {round.proposedScore.score} / {round.proposedScore.maxScore}
              </strong>{' '}
              (pass mark {round.proposedScore.passMark})
            </p>
          </div>
        )}
      </div>
      <p className="text-sm">{report.summary}</p>
      {report.recommendationReason && <p className="text-sm text-muted">Why: {report.recommendationReason}</p>}
      {report.uncertain && (
        <div className="rounded-md border border-accent/40 bg-accent-soft px-3 py-2 text-sm">
          <p className="font-medium">This evaluation is uncertain - please review the transcript.</p>
          <ul className="mt-1 list-disc pl-5 text-xs">
            {report.uncertaintyNotes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </div>
      )}

      <ul className="grid gap-2 sm:grid-cols-2">
        {report.dimensions.map((d) => (
          <li key={d.key} className="rounded-md border border-border px-3 py-2 text-sm">
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium">{AI_INTERVIEW_DIMENSIONS[d.key]}</span>
              <span className="tabular-nums">{d.score === null ? <span className="text-muted">not assessed</span> : `${d.score} / 10`}</span>
            </div>
            {d.score !== null && (
              <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-accent-soft" aria-hidden="true">
                <div className="h-full rounded-full bg-accent" style={{ width: `${d.score * 10}%` }} />
              </div>
            )}
            {d.summary && <p className="mt-1 text-xs text-muted">{d.summary}</p>}
            {d.evidence.length > 0 && <p className="mt-1 text-xs text-muted">Evidence: answer{d.evidence.length === 1 ? '' : 's'} {d.evidence.map((e) => `#${e}`).join(', ')}</p>}
          </li>
        ))}
      </ul>

      <div className="grid gap-3 text-sm sm:grid-cols-2">
        <List title="Strengths" items={report.strengths} />
        <List title="Areas to improve" items={report.improvementAreas} />
        <List title="Skills demonstrated" items={report.skillsDemonstrated} />
        <List title="Skills not verified in this interview" items={report.skillsNotVerified} />
      </div>
    </div>
  );
}

function List({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <div>
      <p className="text-xs font-medium text-muted">{title}</p>
      <ul className="mt-1 list-disc pl-5">
        {items.map((i) => (
          <li key={i}>{i}</li>
        ))}
      </ul>
    </div>
  );
}

function Transcript({ round, report }: { round: AiInterviewHrRound; report: AiInterviewReport | null }) {
  return (
    <ol className="mt-2 flex flex-col gap-3">
      {round.turns.map((t) => {
        const evaluation = report?.answers.find((a) => a.seq === t.seq);
        return (
          <li key={t.seq} className="rounded-md border border-border p-3 text-sm">
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
              <span className="font-medium text-foreground">#{t.seq}</span>
              <span>{SOURCE[t.source]}</span>
              {t.topic && <span>· {t.topic}</span>}
              {t.resumeRef && <span>· resume: {t.resumeRef}</span>}
              {t.reading && <span>· read as {READING[t.reading] ?? t.reading}</span>}
              {t.answerSeconds !== null && <span>· {Math.round(t.answerSeconds)} s</span>}
              {t.transcriptQuality !== 'CLEAR' && (
                <span className={`${pill} border-accent/40 bg-accent-soft text-accent`}>{t.transcriptQuality === 'UNCLEAR' ? 'Unclear audio' : 'Partly unclear'}</span>
              )}
            </div>
            <p className="mt-1 text-muted">
              <span className="font-medium text-foreground">Interviewer:</span> {t.question}
            </p>
            <p className="mt-1 whitespace-pre-wrap">
              <span className="font-medium">Candidate:</span> {t.rawTranscript}
            </p>
            {t.normalizedTranscript && t.normalizedTranscript !== t.rawTranscript && (
              <p className="mt-1 text-xs text-muted">Technical terms normalised: {t.normalizedTranscript}</p>
            )}
            {t.unclearTerms.length > 0 && <p className="mt-1 text-xs text-muted">Unclear words: {t.unclearTerms.join(', ')}</p>}
            {evaluation && (
              <div className="mt-2 rounded-md bg-background p-2 text-xs">
                <p>
                  <span className="font-medium">AI evaluation:</span> {evaluation.summary}
                  {evaluation.technicalAccuracy !== null && <> · accuracy {evaluation.technicalAccuracy}/10</>}
                  {evaluation.depth !== null && <> · depth {evaluation.depth}/10</>}
                </p>
                {evaluation.quote && <p className="mt-1 italic text-muted">“{evaluation.quote}”</p>}
                {evaluation.strengths.length > 0 && <p className="mt-1">+ {evaluation.strengths.join('; ')}</p>}
                {evaluation.gaps.length > 0 && <p className="mt-1">− {evaluation.gaps.join('; ')}</p>}
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/** HR's decision: advance or reject. A reason is required when it goes against the AI score's pass mark. */
function DecisionForm({ applicationId, round, onChanged }: { applicationId: string; round: AiInterviewHrRound; onChanged: (d: AiInterviewHrView) => void }) {
  const [decision, setDecision] = useState<AiInterviewDecision | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const p = round.proposedScore!;
  const systemPasses = p.score >= p.passMark;
  const terminated = round.session?.status === 'TERMINATED';
  // a terminated interview always needs HR's written conclusion
  const against = decision !== null && (terminated || (decision === 'ADVANCE') !== systemPasses);

  const send = async () => {
    if (!decision) return;
    setBusy(true);
    setError('');
    try {
      onChanged(await decideAiInterview(applicationId, round.roundId, { decision, reason }));
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border p-3">
      <p className="text-sm font-medium">Your decision</p>
      <p className="text-xs text-muted">
        The AI score ({p.score} / {p.maxScore}) is {systemPasses ? 'at or above' : 'below'} the pass mark ({p.passMark}). The AI only advises: the student moves
        on to the next step (or gets the result email) only after you decide.
      </p>
      <fieldset className="flex flex-wrap gap-4 text-sm">
        <legend className="sr-only">Decision</legend>
        <label className="flex items-center gap-1.5">
          <input type="radio" name={`decision-${round.roundId}`} checked={decision === 'ADVANCE'} onChange={() => setDecision('ADVANCE')} /> Advance to the next step
        </label>
        <label className="flex items-center gap-1.5">
          <input type="radio" name={`decision-${round.roundId}`} checked={decision === 'REJECT'} onChange={() => setDecision('REJECT')} /> Reject
        </label>
      </fieldset>
      <label className="flex flex-col gap-1 text-sm font-medium">
        Reason{' '}
        <span className="text-xs font-normal text-muted">
          {terminated
            ? '(required: what you concluded from the recorded incidents; kept in the audit log)'
            : against
              ? '(required: your decision differs from the AI score; kept in the audit log)'
              : '(optional, kept in the audit log)'}
        </span>
        <textarea rows={2} className={inputClass} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <Button variant="primary" className="self-start" disabled={busy || !decision || (against && reason.trim().length < 5)} onClick={() => void send()}>
        {busy && <Spinner />} Save decision
      </Button>
    </div>
  );
}
