'use client';

import { ROUNDS_LIMITS, type RoundType } from '@hireflow/contracts';
import { useState } from 'react';
import { HR_ROUND_TYPES, move, newRound, roundTypeLabel, type RoundDraft, type Validation } from '@/lib/rounds';
import { inputClass } from '../ui';
import { RoundCard } from './round-card';
import { PipelineSettingsPanel } from './pipeline-settings';


/**
 * M05: the assessment rounds of one job, in order, after the fixed resume screening and AI voice screening.
 * Only the round names are ever shown to students; questions, answers, pass marks and time limits stay private.
 */
export function RoundsEditor({
  jobId,
  fixedSteps,
  rounds,
  validation,
  disabled,
  locked = false,
  onChange,
  onSkipped,
}: {
  jobId: string;
  fixedSteps: string[];
  rounds: RoundDraft[];
  validation: Validation | null;
  disabled: boolean;
  /** Students started: everything is frozen except each round's passing criterion (saved on its own). */
  locked?: boolean;
  onChange: (rounds: RoundDraft[]) => void;
  /** HR skipped / brought back a saved round (already saved on the server). */
  onSkipped: (key: string, skipped: RoundDraft['skipped'], message: string) => void;
}) {
  const [open, setOpen] = useState<string | null>(rounds.length === 1 ? rounds[0]!.key : null);
  const full = rounds.length >= ROUNDS_LIMITS.roundsMax;

  // picking a type in the "+ Add round" box adds that round at once (nothing is chosen for HR beforehand)
  const add = (type: RoundType | '') => {
    if (!type) return;
    const r = newRound(type);
    onChange([...rounds, r]);
    setOpen(r.key);
  };

  return (
    <div className="flex flex-col gap-3">
      <ol className="flex flex-col gap-2" aria-label="Selection process">
        {fixedSteps.map((s, i) => (
          <li key={s} className="flex items-center gap-2 rounded-lg border border-dashed border-border px-3 py-2 text-sm text-muted">
            <span className="flex h-6 w-6 items-center justify-center rounded-full border border-border text-xs font-semibold">{i + 1}</span>
            <span className="font-medium text-foreground">{s}</span>
            <span className="ml-auto text-xs">Fixed first step</span>
          </li>
        ))}
      </ol>

      {rounds.length > 0 && (
        <ol className="flex flex-col gap-2">
          {rounds.map((r, i) => (
            <RoundCard
              key={r.key}
              jobId={jobId}
              round={r}
              index={i}
              count={rounds.length}
              validation={validation}
              disabled={disabled}
              locked={locked}
              expanded={open === r.key}
              onToggle={() => setOpen(open === r.key ? null : r.key)}
              onChange={(next) => onChange(rounds.map((x, j) => (j === i ? next : x)))}
              onMove={(to) => onChange(move(rounds, i, to))}
              onSkipped={(skipped, message) => onSkipped(r.key, skipped, message)}
              onRemove={() => {
                if (r.questions.length && !window.confirm(`Remove "${r.name || 'this round'}" and its ${r.questions.length} question(s)?`)) return;
                onChange(rounds.filter((_, j) => j !== i));
              }}
            />
          ))}
        </ol>
      )}

      {!disabled && (
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor="add-round-type" className="sr-only">
            Add a round
          </label>
          {/* always back on "+ Add round": choosing a type adds that round */}
          <select id="add-round-type" className={`${inputClass} w-auto font-medium`} value="" onChange={(e) => add(e.target.value as RoundType | '')} disabled={full}>
            <option value="" disabled>
              + Add round…
            </option>
            {HR_ROUND_TYPES.map((t) => (
              <option key={t} value={t}>
                {roundTypeLabel(t)}
              </option>
            ))}
          </select>
          {full && <span className="text-xs text-muted">A job can have at most {ROUNDS_LIMITS.roundsMax} rounds.</span>}
        </div>
      )}

      {rounds.length > 0 && (
        <PipelineSettingsPanel jobId={jobId} roundTypes={rounds.map((r) => r.type)} saved={rounds.some((r) => !!r.id)} readOnly={disabled} />
      )}

      {validation && validation.general.length > 0 && (
        <ul role="alert" className="rounded-md border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-danger">
          {validation.general.map((m) => (
            <li key={m}>{m}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
