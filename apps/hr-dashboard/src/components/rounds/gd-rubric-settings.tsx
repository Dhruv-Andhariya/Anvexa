'use client';

import { RUBRIC_LIMITS, rubricTotal, type RoundRubricView, type RubricParameter } from '@hireflow/contracts';
import { useEffect, useState } from 'react';
import { ApiError } from '@/lib/api';
import { getRubric, saveRubric } from '@/lib/pipeline-api';
import { Button, Spinner, inputClass } from '../ui';

const EXAMPLE: RubricParameter[] = [
  { name: 'Communication', maxMarks: 10 },
  { name: 'Content', maxMarks: 10 },
  { name: 'Leadership', maxMarks: 5 },
  { name: 'Listening', maxMarks: 5 },
];

/**
 * HR's scoring rubric of one group discussion round (rounds editor). With a rubric, HR scores every student on the
 * GD results page and those marks decide the round; without one, the AI's overall score does (as before).
 */
export function GdRubricSettings({ jobId, roundId, maxScore, readOnly }: { jobId: string; roundId: string | undefined; maxScore: number | null; readOnly: boolean }) {
  const [view, setView] = useState<RoundRubricView | null>(null);
  const [draft, setDraft] = useState<RubricParameter[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (!roundId) return;
    const ctrl = new AbortController();
    getRubric(jobId, roundId, { signal: ctrl.signal })
      .then((v) => {
        setView(v);
        setDraft(v.parameters);
      })
      .catch((err) => {
        if ((err as Error).name !== 'AbortError') setMessage({ ok: false, text: err instanceof ApiError ? err.message : 'Could not load the rubric.' });
      });
    return () => ctrl.abort();
  }, [jobId, roundId]);

  if (!roundId) return <p className="text-xs text-muted">Evaluation rubric: save the rounds first to set it up.</p>;
  if (!view) {
    return (
      <p className="flex items-center gap-2 text-xs text-muted">
        {message ? <span className="text-danger">{message.text}</span> : <Spinner className="h-3 w-3" />} Evaluation rubric
      </p>
    );
  }

  const locked = readOnly || view.locked;
  const total = rubricTotal(draft);
  const changed = JSON.stringify(draft) !== JSON.stringify(view.parameters);
  const names = draft.map((p) => p.name.trim().toLowerCase());
  const invalid = draft.some((p) => !p.name.trim() || p.maxMarks < 1) || new Set(names).size !== names.length;
  const set = (i: number, patch: Partial<RubricParameter>) => {
    setDraft(draft.map((p, j) => (j === i ? { ...p, ...patch } : p)));
    setMessage(null);
  };
  const save = async () => {
    setBusy(true);
    try {
      const v = await saveRubric(jobId, roundId, draft.map((p) => ({ name: p.name.trim(), maxMarks: p.maxMarks })));
      setView(v);
      setDraft(v.parameters);
      setMessage({ ok: true, text: v.parameters.length ? 'Rubric saved.' : 'Rubric removed: the AI score decides this round.' });
    } catch (err) {
      setMessage({ ok: false, text: err instanceof ApiError ? err.message : 'Could not save. Please try again.' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <fieldset className="flex flex-col gap-3 rounded-md border border-border p-3" disabled={locked || busy}>
      <legend className="px-1 text-sm font-semibold">Evaluation rubric</legend>
      <p className="text-xs text-muted">
        With a rubric you score every student on the group discussion results page (never more than a parameter&apos;s marks); the total decides the round
        {maxScore ? `, scaled to the interviewer score out of ${maxScore}` : ''}. The AI&apos;s scores stay visible as a guide. Without a rubric the AI&apos;s
        overall score decides.
      </p>
      {draft.length === 0 ? (
        <p className="text-sm text-muted">No rubric.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {draft.map((p, i) => (
            <li key={i} className="flex flex-wrap items-center gap-2">
              <input className={`${inputClass} min-w-0 flex-1`} aria-label={`Parameter ${i + 1} name`} maxLength={RUBRIC_LIMITS.nameMax} value={p.name} onChange={(e) => set(i, { name: e.target.value })} />
              <input
                type="number"
                min={1}
                max={RUBRIC_LIMITS.maxMarksMax}
                className={`${inputClass} w-24`}
                aria-label={`${p.name || `Parameter ${i + 1}`} marks`}
                value={p.maxMarks}
                onChange={(e) => set(i, { maxMarks: Math.min(RUBRIC_LIMITS.maxMarksMax, Math.max(0, Math.round(Number(e.target.value) || 0))) })}
              />
              <span className="text-xs text-muted">marks</span>
              {!locked && (
                <Button variant="ghost" onClick={() => setDraft(draft.filter((_, j) => j !== i))}>
                  Remove
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="text-sm font-medium">Total: {total} marks</p>
      {view.locked && <p className="text-xs text-muted">Students have started, so the rubric is frozen.</p>}
      {message && (
        <p role="status" className={`text-xs ${message.ok ? 'text-success' : 'text-danger'}`}>
          {message.text}
        </p>
      )}
      {!locked && (
        <div className="flex flex-wrap gap-2">
          {draft.length < RUBRIC_LIMITS.parametersMax && (
            <Button variant="secondary" onClick={() => setDraft([...draft, { name: '', maxMarks: 5 }])}>
              Add parameter
            </Button>
          )}
          {draft.length === 0 && (
            <Button variant="ghost" onClick={() => setDraft(EXAMPLE)}>
              Use the example (Communication, Content, Leadership, Listening)
            </Button>
          )}
          <Button disabled={!changed || busy || invalid} onClick={() => void save()}>
            {busy && <Spinner />} Save rubric
          </Button>
        </div>
      )}
    </fieldset>
  );
}
