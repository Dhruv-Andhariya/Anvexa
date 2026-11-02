'use client';

import { PROCTOR_EVENT_LABELS, type ApplicationRoundEngine, type RoundEngineRound } from '@hireflow/contracts';
import { useState } from 'react';
import { pill } from '@/app/assessments/assessment-styles';
import { ApiError } from '@/lib/api';
import { resendRoundInvite, revokeRoundInvite } from '@/lib/round-engine-api';
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
    return <p className="text-sm text-muted">This round is run by the HR team (it mixes question types, has open questions, or an interviewer score).</p>;
  }
  const { invite, attempt, events, outcomeEmail } = round;
  const warnings = events.filter((e) => e.severity === 'WARNING');

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
        <span className="font-medium">Online test</span>
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
            <dt className="text-xs text-muted">Answered</dt>
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

      {attempt && (
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
