'use client';

import type { GdRoundOverview } from '@hireflow/contracts';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { SessionRecording } from '@/components/gd/session-recording';
import { ApiError } from '@/lib/api';
import { getGdRound } from '@/lib/gd-api';

const when = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/** Under a GD round on Assessments: the whole-session recording of every group that has ended, with its results. */
export function GdRecordings({ roundId }: { roundId: string }) {
  const [data, setData] = useState<GdRoundOverview | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    getGdRound(roundId, { signal: controller.signal })
      .then(setData)
      .catch((err) => {
        if (!controller.signal.aborted) setError(err instanceof ApiError ? err.message : 'Could not load the group recordings.');
      });
    return () => controller.abort();
  }, [roundId]);

  if (error) return <p className="text-sm text-danger">{error}</p>;
  if (!data) return <p className="text-sm text-muted">Loading the group recordings…</p>;
  const groups = data.events.flatMap((e) => e.batches.map((b) => ({ ...b, eventName: e.name })));
  const ended = groups.filter((b) => b.status === 'COMPLETED');
  if (!ended.length) return <p className="text-sm text-muted">Each group&apos;s full session recording appears here after the group ends.</p>;
  return (
    <ul className="flex flex-col gap-4">
      {ended.map((b) => (
        <li key={b.id} className="flex flex-col gap-1.5">
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span className="font-medium">
              {b.eventName} · Group {b.number} · {when.format(new Date(b.startsAt))}
            </span>
            <Link href={`/group-discussion/results/${encodeURIComponent(b.id)}`} className="text-accent underline decoration-accent/30 underline-offset-2 hover:decoration-accent">
              Results →
            </Link>
          </div>
          {b.sessionAudio ? (
            <SessionRecording batchId={b.id} audio={b.sessionAudio} />
          ) : (
            <p className="text-xs text-muted">Recording not ready yet (built after the evaluation). Open the results to build it again if it failed.</p>
          )}
        </li>
      ))}
    </ul>
  );
}
