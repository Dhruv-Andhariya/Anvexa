'use client';

import { ROUND_TYPES, ROUNDS_LIMITS, type RoundType } from '@hireflow/contracts';
import { useState } from 'react';
import { move, newRound, type RoundDraft, type Validation } from '@/lib/rounds';
import { Button, inputClass } from '../ui';
import { RoundCard } from './round-card';
import { PipelineSettingsPanel } from './pipeline-settings';

const ROUND_TYPE_KEYS = Object.keys(ROUND_TYPES) as RoundType[];

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
  onChange,
}: {
  jobId: string;
  fixedSteps: string[];
  rounds: RoundDraft[];
  validation: Validation | null;
  disabled: boolean;
  onChange: (rounds: RoundDraft[]) => void;
}) {
  const [open, setOpen] = useState<string | null>(rounds.length === 1 ? rounds[0]!.key : null);
  const [addType, setAddType] = useState<RoundType>('APTITUDE');
  const full = rounds.length >= ROUNDS_LIMITS.roundsMax;

  const add = () => {
    const r = newRound(addType);
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
              expanded={open === r.key}
              onToggle={() => setOpen(open === r.key ? null : r.key)}
              onChange={(next) => onChange(rounds.map((x, j) => (j === i ? next : x)))}
              onMove={(to) => onChange(move(rounds, i, to))}
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
            Round to add
          </label>
          <select id="add-round-type" className={`${inputClass} w-auto`} value={addType} onChange={(e) => setAddType(e.target.value as RoundType)} disabled={full}>
            {ROUND_TYPE_KEYS.map((t) => (
              <option key={t} value={t}>
                {ROUND_TYPES[t].label}
              </option>
            ))}
          </select>
          <Button onClick={add} disabled={full}>
            + Add round
          </Button>
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
