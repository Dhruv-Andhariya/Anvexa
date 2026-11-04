'use client';

import { AI_INTERVIEW_PROTECTION_LIMITS, type AiInterviewDevicePolicy, type AiInterviewFacePolicy, type AiInterviewProtectionConfig, type AiInterviewProtectionSettings } from '@hireflow/contracts';
import { useEffect, useState } from 'react';
import { ApiError } from '@/lib/api';
import { getInterviewProtection, saveInterviewProtection } from '@/lib/ai-interview-api';
import { Button, Spinner, inputClass } from '../ui';

const { min, max } = AI_INTERVIEW_PROTECTION_LIMITS.maxWarnings;

/**
 * Interview protection rules of one AI technical interview round (rounds editor). Saved on their own, immediately:
 * they apply to interviews opened from then on - an interview keeps the rules its candidate was shown.
 */
export function InterviewProtectionSettings({ jobId, roundId, readOnly }: { jobId: string; roundId: string | undefined; readOnly: boolean }) {
  const [config, setConfig] = useState<AiInterviewProtectionConfig | null>(null);
  const [draft, setDraft] = useState<AiInterviewProtectionSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (!roundId) return;
    const ctrl = new AbortController();
    getInterviewProtection(jobId, roundId, { signal: ctrl.signal })
      .then((c) => {
        setConfig(c);
        setDraft(c.settings);
      })
      .catch((err) => {
        if ((err as Error).name !== 'AbortError') setMessage({ ok: false, text: err instanceof ApiError ? err.message : 'Could not load the protection rules.' });
      });
    return () => ctrl.abort();
  }, [jobId, roundId]);

  if (!roundId) {
    return <p className="text-xs text-muted">Interview protection (warnings, tab switching, fullscreen): save the rounds first to set it up.</p>;
  }
  if (!draft) {
    return (
      <p className="flex items-center gap-2 text-xs text-muted">
        {message ? <span className="text-danger">{message.text}</span> : <Spinner className="h-3 w-3" />} Interview protection
      </p>
    );
  }

  const set = (patch: Partial<AiInterviewProtectionSettings>) => {
    setDraft({ ...draft, ...patch });
    setMessage(null);
  };
  const changed = JSON.stringify(draft) !== JSON.stringify(config?.settings);
  const save = async () => {
    setBusy(true);
    try {
      const c = await saveInterviewProtection(jobId, roundId, draft);
      setConfig(c);
      setDraft(c.settings);
      setMessage({ ok: true, text: 'Saved. Applies to interviews opened from now on.' });
    } catch (err) {
      setMessage({ ok: false, text: err instanceof ApiError ? err.message : 'Could not save. Please try again.' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <fieldset className="flex flex-col gap-3 rounded-md border border-border p-3" disabled={readOnly || busy}>
      <legend className="px-1 text-sm font-semibold">Interview protection</legend>
      <p className="text-xs text-muted">
        One warning counter for every monitored incident. After {draft.maxWarnings} warning{draft.maxWarnings === 1 ? '' : 's'}, the next incident ends the
        interview and puts it in integrity review: you decide, the candidate is never rejected automatically. Candidates see these rules before they start.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm font-medium">
          Warnings before termination
          <input
            type="number"
            min={min}
            max={max}
            className={`${inputClass} w-24`}
            value={draft.maxWarnings}
            onChange={(e) => set({ maxWarnings: Math.min(max, Math.max(min, Math.round(Number(e.target.value) || min))) })}
          />
        </label>
        <div className="flex flex-col gap-2 text-sm">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={draft.tabSwitchMonitoring} onChange={(e) => set({ tabSwitchMonitoring: e.target.checked })} /> Monitor tab and window switching
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={draft.fullscreenRequired} onChange={(e) => set({ fullscreenRequired: e.target.checked })} /> Require fullscreen (where the
            browser supports it)
          </label>
        </div>
        <PolicySelect label="Camera stops" value={draft.cameraPolicy} onChange={(v) => set({ cameraPolicy: v })} />
        <PolicySelect label="Microphone stops" value={draft.microphonePolicy} onChange={(v) => set({ microphonePolicy: v })} />
        <label className="flex flex-col gap-1 text-sm font-medium">
          More than one face in the camera (5 s or longer)
          <select className={inputClass} value={draft.multipleFacesPolicy} onChange={(e) => set({ multipleFacesPolicy: e.target.value as AiInterviewFacePolicy })}>
            <option value="WARN">Count a warning (default)</option>
            <option value="RECORD">Record for review only (no warning)</option>
            <option value="OFF">Do not check</option>
          </select>
          <span className="text-xs font-normal text-muted">
            Counted on the candidate&apos;s device; no image is stored or sent and nobody is identified. Lighting, photos and people walking past can cause
            false alarms.
          </span>
        </label>
      </div>
      <p className="text-xs text-muted">
        Camera and microphone stay required; a lost device always pauses the interview until it is back. Reloads and lost connections are never warnings.
        {config && !config.isDefault && config.updatedBy && ` Last changed by ${config.updatedBy}.`}
      </p>
      {message && (
        <p role="status" className={`text-xs ${message.ok ? 'text-success' : 'text-danger'}`}>
          {message.text}
        </p>
      )}
      {!readOnly && (
        <Button className="self-start" disabled={!changed || busy} onClick={() => void save()}>
          {busy && <Spinner />} Save protection rules
        </Button>
      )}
    </fieldset>
  );
}

function PolicySelect({ label, value, onChange }: { label: string; value: AiInterviewDevicePolicy; onChange: (v: AiInterviewDevicePolicy) => void }) {
  return (
    <label className="flex flex-col gap-1 text-sm font-medium">
      {label}
      <select className={inputClass} value={value} onChange={(e) => onChange(e.target.value as AiInterviewDevicePolicy)}>
        <option value="RECOVER">Pause and recover (technical problem, no warning)</option>
        <option value="WARN">Pause and recover, and count a warning</option>
      </select>
    </label>
  );
}
