'use client';

import { DEFAULT_PIPELINE_SETTINGS, isTechnicalRound, type PipelineSettings, type PipelineSettingsView, type RoundType, type Stage2Rule } from '@hireflow/contracts';
import { useEffect, useState } from 'react';
import { ApiError } from '@/lib/api';
import { getPipelineSettings, savePipelineSettings } from '@/lib/pipeline-api';
import { Button, Spinner, inputClass } from '../ui';

/**
 * Pipeline rules of a job (rounds editor): the Stage 2 overall criterion over the technical rounds (DSA, SQL, GD)
 * and whether rejected students get an email. Saved on their own; frozen with the rounds once a student started.
 */
export function PipelineSettingsPanel({ jobId, roundTypes, saved, readOnly }: { jobId: string; roundTypes: RoundType[]; saved: boolean; readOnly: boolean }) {
  const [view, setView] = useState<PipelineSettingsView | null>(null);
  const [draft, setDraft] = useState<PipelineSettings>(DEFAULT_PIPELINE_SETTINGS);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (!saved) return;
    const ctrl = new AbortController();
    getPipelineSettings(jobId, { signal: ctrl.signal })
      .then((v) => {
        setView(v);
        setDraft({ stage2Rule: v.stage2Rule, stage2MinPercent: v.stage2MinPercent, rejectionEmails: v.rejectionEmails });
      })
      .catch((err) => {
        if ((err as Error).name !== 'AbortError') setMessage({ ok: false, text: err instanceof ApiError ? err.message : 'Could not load the pipeline rules.' });
      });
    return () => ctrl.abort();
  }, [jobId, saved]);

  const techCount = roundTypes.filter(isTechnicalRound).length;
  if (!saved) return <p className="text-xs text-muted">Pipeline rules (Stage 2 overall criterion, rejection emails): save the rounds first to set them up.</p>;

  const locked = readOnly || !!view?.locked;
  const usesPercent = draft.stage2Rule !== 'ALL_ROUNDS_PASSED';
  const changed = !view || JSON.stringify(draft) !== JSON.stringify({ stage2Rule: view.stage2Rule, stage2MinPercent: view.stage2MinPercent, rejectionEmails: view.rejectionEmails });
  const set = (patch: Partial<PipelineSettings>) => {
    setDraft({ ...draft, ...patch });
    setMessage(null);
  };
  const save = async () => {
    setBusy(true);
    try {
      const v = await savePipelineSettings(jobId, draft);
      setView(v);
      setMessage({ ok: true, text: 'Pipeline rules saved.' });
    } catch (err) {
      setMessage({ ok: false, text: err instanceof ApiError ? err.message : 'Could not save. Please try again.' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <fieldset className="flex flex-col gap-3 rounded-md border border-border p-3" disabled={locked || busy}>
      <legend className="px-1 text-sm font-semibold">Pipeline rules</legend>
      <p className="text-xs text-muted">
        Students move on only after passing each round, in the order above. After the last technical round (DSA, SQL, group discussion) this overall
        criterion decides who goes on to the technical interview.
        {techCount === 0 && ' This job has no technical round yet, so the criterion does not apply.'}
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm font-medium">
          Stage 2 overall criterion
          <select className={inputClass} value={draft.stage2Rule} onChange={(e) => set({ stage2Rule: e.target.value as Stage2Rule, stage2MinPercent: e.target.value === 'ALL_ROUNDS_PASSED' ? null : (draft.stage2MinPercent ?? 60) })}>
            <option value="ALL_ROUNDS_PASSED">Every technical round passed</option>
            <option value="TOTAL_PERCENT">Total score of the technical rounds at least…</option>
            <option value="BOTH">Every round passed AND total score at least…</option>
          </select>
        </label>
        {usesPercent && (
          <label className="flex flex-col gap-1 text-sm font-medium">
            Minimum total (% of the technical rounds&apos; marks)
            <input
              type="number"
              min={1}
              max={100}
              className={`${inputClass} w-28`}
              value={draft.stage2MinPercent ?? ''}
              onChange={(e) => set({ stage2MinPercent: e.target.value === '' ? null : Math.round(Number(e.target.value)) })}
            />
          </label>
        )}
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={draft.rejectionEmails} onChange={(e) => set({ rejectionEmails: e.target.checked })} /> Email students who are not selected
        <span className="text-xs text-muted">(off: no rejection email; you still see the reason on the dashboard)</span>
      </label>
      {view?.locked && <p className="text-xs text-muted">Students have started, so these rules are frozen.</p>}
      {message && (
        <p role="status" className={`text-xs ${message.ok ? 'text-success' : 'text-danger'}`}>
          {message.text}
        </p>
      )}
      {!locked && (
        <Button className="self-start" disabled={!changed || busy || (usesPercent && !draft.stage2MinPercent)} onClick={() => void save()}>
          {busy && <Spinner />} Save pipeline rules
        </Button>
      )}
    </fieldset>
  );
}
