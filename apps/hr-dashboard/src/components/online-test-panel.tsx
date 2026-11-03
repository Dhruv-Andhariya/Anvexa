'use client';

import { PROCTOR_EVENT_LABELS, type ApplicationRoundEngine, type DsaProctoringReview, type RoundEngineRound } from '@hireflow/contracts';
import { useEffect, useState } from 'react';
import { pill } from '@/app/assessments/assessment-styles';
import { ApiError } from '@/lib/api';
import { getDsaProctoring, resendRoundInvite, revokeRoundInvite } from '@/lib/round-engine-api';
import { Button, Spinner } from './ui';

const date = (iso: string) => new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
const time = (iso: string) => new Intl.DateTimeFormat('en-IN', { timeStyle: 'medium' }).format(new Date(iso));

export function duration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m ? `${m} min ${s} s` : `${s} s`;
}

const EMAIL_TEXT = { QUEUED: 'queued', SENDING: 'sending', SENT: 'sent', FAILED: 'failed' } as const;
const OUTCOME_EMAIL_TEXT = { REJECTED: 'Rejection email', CLEARED_NEXT_BY_HR: '"Cleared - HR will contact you" email', CLEARED_ALL: '"Cleared all rounds" email' } as const;

/**
 * The online test of one round for one student (round engine, M13): invitation email, attempt (time taken, answered),
 * and the proctoring events. Events are evidence for HR's review: none of them changed the result.
 */
export function OnlineTestPanel({
  applicationId,
  round,
  onChanged,
}: {
  applicationId: string;
  round: RoundEngineRound;
  onChanged: (d: ApplicationRoundEngine) => void;
}) {
  const [showEvents, setShowEvents] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmRevoke, setConfirmRevoke] = useState(false);

  if (!round.online) {
    return <p className="text-sm text-muted">This round is run by the HR team (it has questions that are neither multiple choice nor DSA problems, or an interviewer score).</p>;
  }
  const { invite, attempt, events, outcomeEmail } = round;
  const warnings = events.filter((e) => e.severity === 'WARNING');
  const coding = round.kind === 'CODING';

  const act = async (fn: () => Promise<ApplicationRoundEngine>) => {
    setError('');
    setBusy(true);
    try {
      onChanged(await fn());
      setConfirmRevoke(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
    }
    setBusy(false);
  };

  return (
    <div className="flex flex-col gap-3 rounded-md border border-border p-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">{coding ? 'DSA coding test' : 'Online test'}</span>
        {!invite ? (
          <span className="text-muted">· not invited yet (invitations go out automatically after the previous step)</span>
        ) : invite.revoked ? (
          <span className={`${pill} border-danger/40 text-danger`}>Link withdrawn</span>
        ) : (
          <span className="text-muted">
            · invitation {EMAIL_TEXT[invite.emailStatus]}
            {invite.sentAt && <> {date(invite.sentAt)}</>}
            {invite.expiresAt && !attempt && <> · link valid until {date(invite.expiresAt)}</>}
          </span>
        )}
      </div>
      {invite?.lastError && <p className="text-xs text-danger">Email: {invite.lastError}</p>}

      {attempt && (
        <dl className="grid gap-3 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-xs text-muted">Status</dt>
            <dd className="font-medium">{attempt.status === 'IN_PROGRESS' ? 'In progress' : attempt.status === 'TIMED_OUT' ? 'Time ran out' : 'Submitted'}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted">Started</dt>
            <dd>{date(attempt.startedAt)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted">Time taken</dt>
            <dd>{attempt.timeTakenSeconds !== null ? duration(attempt.timeTakenSeconds) : '—'}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted">{coding ? 'Problems submitted' : 'Answered'}</dt>
            <dd>
              {attempt.answered} of {attempt.questionCount}
            </dd>
          </div>
        </dl>
      )}

      {outcomeEmail && (
        <p className="text-xs text-muted">
          {OUTCOME_EMAIL_TEXT[outcomeEmail.kind]} {EMAIL_TEXT[outcomeEmail.status]}
          {outcomeEmail.sentAt && <> {date(outcomeEmail.sentAt)}</>}
        </p>
      )}

      {attempt && coding && <DsaIntegrityLog applicationId={applicationId} roundId={round.roundId} />}

      {attempt && !coding && (
        <div>
          <Button variant="ghost" className="px-2 py-1" onClick={() => setShowEvents(!showEvents)} aria-expanded={showEvents}>
            {showEvents ? '▴ Hide proctoring log' : `▾ Proctoring log (${warnings.length} warning${warnings.length === 1 ? '' : 's'}, ${events.length} events)`}
          </Button>
          {showEvents && (
            <div className="mt-2 flex flex-col gap-2">
              <p className="text-xs text-muted">
                What the candidate&apos;s browser reported. These are observations for your review - a tab switch or camera stop is not proof of cheating and did
                not change the result. No video was recorded.
              </p>
              <ol className="flex flex-col divide-y divide-border rounded-md border border-border text-sm">
                {events.map((e, i) => (
                  <li key={i} className="flex flex-wrap items-center gap-2 px-3 py-1.5">
                    <span className="w-24 shrink-0 tabular-nums text-muted">{time(e.occurredAt)}</span>
                    <span className={e.severity === 'WARNING' ? 'font-medium text-danger' : ''}>{PROCTOR_EVENT_LABELS[e.type]}</span>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </div>
      )}

      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      {invite && !invite.revoked && (attempt?.status ?? 'IN_PROGRESS') === 'IN_PROGRESS' && (
        <div className="flex flex-wrap items-center gap-2">
          {invite.emailStatus === 'FAILED' && (
            <Button disabled={busy} onClick={() => void act(() => resendRoundInvite(applicationId, round.roundId))}>
              {busy && <Spinner />} Send the invitation again
            </Button>
          )}
          {confirmRevoke ? (
            <>
              <span className="text-sm">Withdraw the link? The candidate can no longer {attempt ? 'continue' : 'take'} this test.</span>
              <Button disabled={busy} onClick={() => void act(() => revokeRoundInvite(applicationId, round.roundId))}>
                {busy && <Spinner />} Yes, withdraw
              </Button>
              <Button variant="ghost" onClick={() => setConfirmRevoke(false)}>
                Cancel
              </Button>
            </>
          ) : (
            <Button variant="ghost" onClick={() => setConfirmRevoke(true)}>
              Withdraw link
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

const SECONDS = (ms: number) => (ms >= 1000 ? duration(Math.round(ms / 1000)) : '0 s');
const STATUS_TEXT = { clean: 'Nothing unusual', warning: 'Warnings used', review: 'Needs a look', disqualified: 'Ended by the warning limit' } as const;

/**
 * What the browser noticed during the DSA coding round (full screen, tabs, clipboard, shortcuts): loaded when opened.
 * Observations for HR's review. The attempt only ever ends by itself when the allowed warnings are used up.
 */
function DsaIntegrityLog({ applicationId, roundId }: { applicationId: string; roundId: string }) {
  const [open, setOpen] = useState(false);
  const [review, setReview] = useState<DsaProctoringReview | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open || review) return;
    let alive = true;
    getDsaProctoring(applicationId)
      .then((r) => alive && setReview(r))
      .catch((err) => alive && setError(err instanceof ApiError ? err.message : 'Could not load the monitoring record.'));
    return () => {
      alive = false;
    };
  }, [open, review, applicationId]);

  const mine = review?.rounds.find((r) => r.roundId === roundId);
  return (
    <div>
      <Button variant="ghost" className="px-2 py-1" onClick={() => setOpen(!open)} aria-expanded={open}>
        {open ? '▴ Hide monitoring record' : '▾ Monitoring record'}
      </Button>
      {open && (
        <div className="mt-2 flex flex-col gap-2 text-sm">
          {error && <p className="text-danger">{error}</p>}
          {!error && !review && <p className="text-muted">Loading…</p>}
          {review && !mine && <p className="text-muted">No monitoring record: the candidate has not started the test.</p>}
          {mine && (
            <>
              <p className="text-xs text-muted">
                What the candidate&apos;s browser reported. These are observations for your review, not proof of cheating, and they did not change the score. No
                camera, microphone or screen recording is used.
              </p>
              <p>
                <span className={`${pill} ${mine.flagged ? 'border-danger/40 text-danger' : ''}`}>{STATUS_TEXT[mine.status]}</span>{' '}
                <span className="text-muted">
                  {mine.strikesAllowed > 0 ? `Warnings used: ${mine.strikesUsed} of ${mine.strikesAllowed} allowed · ` : ''}
                  Left full screen {mine.fullscreenExitCount}× · tab switches {mine.tabSwitchCount} · copy/paste attempts {mine.copyPasteAttempts} · developer tools {mine.devToolsAttempts} · time away {SECONDS(mine.totalTimeOutsideMs)}
                </span>
              </p>
              {mine.reasons.length > 0 && (
                <ul className="list-disc pl-5 text-xs text-muted">
                  {mine.reasons.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
              )}
              {mine.events.length > 0 && (
                <ol className="flex flex-col divide-y divide-border rounded-md border border-border">
                  {mine.events.map((e, i) => (
                    <li key={i} className="flex flex-wrap items-center gap-2 px-3 py-1.5">
                      <span className="w-24 shrink-0 tabular-nums text-muted">{time(e.at)}</span>
                      <span className={e.severity === 'high' || e.severity === 'medium' ? 'font-medium text-danger' : ''}>{e.type.replaceAll('_', ' ').toLowerCase()}</span>
                      {e.durationMs ? <span className="text-xs text-muted">{SECONDS(e.durationMs)}</span> : null}
                    </li>
                  ))}
                </ol>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
