'use client';

import type { SavedRound } from '@hireflow/contracts';
import { useState } from 'react';
import { skipRound, unskipRound } from '@/lib/rounds-api';
import { Button } from '../ui';

type Skipped = SavedRound['skipped'];

/**
 * "Skip round" / "Undo skip" for one saved round of a job (e.g. skip only DSA, or only SQL). Works after students have
 * started (the rounds lock is about questions and pass marks). A student who passes the round before a skipped one is
 * emailed the next round that runs; students already waiting for the skipped round move on at once.
 */
export function RoundSkipButton({
  jobId,
  roundId,
  roundName,
  skipped,
  onChange,
}: {
  jobId: string;
  roundId: string;
  roundName: string;
  skipped: Skipped;
  onChange: (skipped: Skipped, message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const name = roundName || 'this round';

  const run = async () => {
    try {
      if (skipped) {
        if (!window.confirm(`Bring back "${name}"? Students who have not reached it yet will take it again.`)) return;
        setBusy(true);
        const res = await unskipRound(jobId, roundId);
        onChange(res.rounds.rounds.find((r) => r.id === roundId)?.skipped ?? null, `"${name}" runs again for students who have not passed it yet.`);
      } else {
        const reason = window.prompt(
          `Skip "${name}" for this job?\n\nStudents who pass the round before it get the link of the next round instead. Students already waiting for it move on now; anyone in the middle of it finishes it.\n\nWhy is it skipped?`,
        );
        if (reason === null) return;
        setBusy(true);
        const res = await skipRound(jobId, roundId, reason.trim());
        const moved = res.movedOn ? ` ${res.movedOn} waiting student${res.movedOn === 1 ? '' : 's'} moved on to the next round.` : '';
        const running = res.inProgress ? ` ${res.inProgress} student${res.inProgress === 1 ? ' is' : 's are'} in the middle of it and will finish it.` : '';
        onChange(res.rounds.rounds.find((r) => r.id === roundId)?.skipped ?? null, `"${name}" is skipped.${moved}${running}`);
      }
    } catch (err) {
      window.alert(err instanceof Error ? err.message : 'Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Button variant="ghost" className="px-2 py-1" disabled={busy} onClick={run} aria-label={skipped ? `Undo skip of ${name}` : `Skip ${name}`}>
      {busy ? '…' : skipped ? 'Undo skip' : 'Skip round'}
    </Button>
  );
}

/** The "Skipped by HR" line under a round's name. */
export function SkippedNote({ skipped }: { skipped: NonNullable<Skipped> }) {
  const when = new Date(skipped.at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  return (
    <p className="px-3 pb-2 text-xs text-muted">
      <span className="rounded bg-accent-soft px-1.5 py-0.5 font-semibold text-accent">Skipped by HR</span>{' '}
      {skipped.byName ? `${skipped.byName}, ` : ''}
      {when}: {skipped.reason}. Students go straight to the next round.
    </p>
  );
}
