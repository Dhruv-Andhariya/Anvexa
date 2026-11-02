'use client';

import { QUESTION_KINDS, ROUND_TYPES, ROUNDS_LIMITS, type PassMode, type QuestionKind, type RoundType } from '@hireflow/contracts';
import { useState } from 'react';
import { PASS_MODES, messagesUnder, move, newQuestion, passMarkHint, type RoundDraft, type Validation } from '@/lib/rounds';
import { Button, inputClass } from '../ui';
import { AiGeneratePanel } from './ai-generate-panel';
import { QuestionEditor } from './question-editor';

const ROUND_TYPE_KEYS = Object.keys(ROUND_TYPES) as RoundType[];
const KIND_KEYS = Object.keys(QUESTION_KINDS) as QuestionKind[];

/** One assessment round: name, type, description, time limit, passing criterion and its questions. */
export function RoundCard({
  jobId,
  round,
  index,
  count,
  validation,
  disabled,
  expanded,
  onToggle,
  onChange,
  onMove,
  onRemove,
}: {
  jobId: string;
  round: RoundDraft;
  index: number;
  count: number;
  validation: Validation | null;
  disabled: boolean;
  expanded: boolean;
  onToggle: () => void;
  onChange: (r: RoundDraft) => void;
  onMove: (to: number) => void;
  onRemove: () => void;
}) {
  const [aiOpen, setAiOpen] = useState(false);
  const [addKind, setAddKind] = useState<QuestionKind>(ROUND_TYPES[round.type].kinds[0]!);
  const set = (patch: Partial<RoundDraft>) => onChange({ ...round, ...patch });
  const path = `rounds.${index}`;
  const errorsOf = (field: string) => (validation?.fields[`${path}.${field}`] ?? []).join(' ');
  const problemCount = validation ? messagesUnder(validation, path).length : 0;
  const id = `round-${round.key}`;
  const totalMarks = round.questions.reduce((sum, q) => sum + (Number(q.marks) || 0), 0);

  const setMode = (mode: PassMode | '') =>
    set({ passMode: mode, passMaxScore: mode === 'INTERVIEWER_SCORE' ? round.passMaxScore || '10' : '' });

  return (
    <li className={`rounded-lg border bg-surface ${problemCount ? 'border-danger/50' : 'border-border'}`}>
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-accent-soft text-xs font-semibold text-accent">{index + 3}</span>
        <button type="button" onClick={onToggle} aria-expanded={expanded} aria-controls={`${id}-body`} className="min-w-0 flex-1 truncate text-left text-sm font-medium">
          {round.name || <span className="text-muted">Unnamed round</span>}
          <span className="ml-2 font-normal text-muted">
            {ROUND_TYPES[round.type].label} · {round.questions.length} question{round.questions.length === 1 ? '' : 's'}
            {round.timeLimitMinutes && ` · ${round.timeLimitMinutes} min`}
          </span>
          {problemCount > 0 && <span className="ml-2 text-xs text-danger">⚠ {problemCount} to fix</span>}
        </button>
        <Button variant="ghost" className="px-2 py-1" aria-label={`Move ${round.name || 'round'} up`} disabled={disabled || index === 0} onClick={() => onMove(index - 1)}>
          ↑
        </Button>
        <Button variant="ghost" className="px-2 py-1" aria-label={`Move ${round.name || 'round'} down`} disabled={disabled || index === count - 1} onClick={() => onMove(index + 1)}>
          ↓
        </Button>
        <Button variant="ghost" className="px-2 py-1 text-danger" aria-label={`Remove ${round.name || 'round'}`} disabled={disabled} onClick={onRemove}>
          Remove
        </Button>
        <Button variant="ghost" className="px-2 py-1" onClick={onToggle} aria-label={expanded ? 'Collapse round' : 'Expand round'}>
          {expanded ? '▴' : '▾'}
        </Button>
      </div>

      {expanded && (
        <div id={`${id}-body`} className="flex flex-col gap-4 border-t border-border px-3 py-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-sm font-medium">
              Round name <span className="text-xs font-normal text-muted">(students see this name in the selection process)</span>
              <input
                className={inputClass}
                value={round.name}
                maxLength={ROUNDS_LIMITS.nameMax}
                aria-invalid={!!errorsOf('name')}
                disabled={disabled}
                onChange={(e) => set({ name: e.target.value })}
              />
              {errorsOf('name') && <span className="text-xs text-danger">{errorsOf('name')}</span>}
            </label>
            <label className="flex flex-col gap-1 text-sm font-medium">
              Round type
              <select className={inputClass} value={round.type} disabled={disabled} onChange={(e) => set({ type: e.target.value as RoundType })}>
                {ROUND_TYPE_KEYS.map((t) => (
                  <option key={t} value={t}>
                    {ROUND_TYPES[t].label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <label className="flex flex-col gap-1 text-sm font-medium">
            Description <span className="text-xs font-normal text-muted">(optional, private)</span>
            <textarea
              rows={2}
              className={inputClass}
              value={round.description}
              maxLength={ROUNDS_LIMITS.descriptionMax}
              disabled={disabled}
              onChange={(e) => set({ description: e.target.value })}
            />
          </label>

          <div className="grid gap-3 sm:grid-cols-3">
            <label className="flex flex-col gap-1 text-sm font-medium">
              Time limit (minutes)
              <input
                type="number"
                min={1}
                max={ROUNDS_LIMITS.timeLimitMaxMinutes}
                placeholder="No limit"
                className={inputClass}
                value={round.timeLimitMinutes}
                aria-invalid={!!errorsOf('timeLimitMinutes')}
                disabled={disabled}
                onChange={(e) => set({ timeLimitMinutes: e.target.value })}
              />
              {errorsOf('timeLimitMinutes') && <span className="text-xs text-danger">{errorsOf('timeLimitMinutes')}</span>}
            </label>
            <label className="flex flex-col gap-1 text-sm font-medium">
              Passing criterion
              <select className={inputClass} value={round.passMode} disabled={disabled} onChange={(e) => setMode(e.target.value as PassMode | '')}>
                <option value="">Choose…</option>
                {PASS_MODES.map((m) => (
                  <option key={m.mode} value={m.mode}>
                    {m.label}
                  </option>
                ))}
              </select>
            </label>
            {round.passMode && (
              <div className="flex flex-col gap-1 text-sm font-medium">
                <label htmlFor={`${id}-pass`}>Pass mark</label>
                <div className="flex items-center gap-2">
                  <input
                    id={`${id}-pass`}
                    type="number"
                    min={1}
                    className={`${inputClass} w-24`}
                    value={round.passValue}
                    aria-invalid={!!errorsOf('passRule.value')}
                    disabled={disabled}
                    onChange={(e) => set({ passValue: e.target.value })}
                  />
                  {round.passMode === 'INTERVIEWER_SCORE' ? (
                    <label className="flex items-center gap-2 font-normal text-muted">
                      out of
                      <input
                        type="number"
                        min={1}
                        max={ROUNDS_LIMITS.interviewerScoreMax}
                        aria-label="Maximum interviewer score"
                        className={`${inputClass} w-20`}
                        value={round.passMaxScore}
                        disabled={disabled}
                        onChange={(e) => set({ passMaxScore: e.target.value })}
                      />
                    </label>
                  ) : (
                    <span className="font-normal text-muted">{passMarkHint(round)}</span>
                  )}
                </div>
                {(errorsOf('passRule.value') || errorsOf('passRule.maxScore')) && (
                  <span className="text-xs text-danger">{[errorsOf('passRule.value'), errorsOf('passRule.maxScore')].filter(Boolean).join(' ')}</span>
                )}
              </div>
            )}
          </div>

          <section aria-label="Questions" className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <h4 className="text-sm font-semibold">
                Questions <span className="font-normal text-muted">({round.questions.length} · {totalMarks} marks)</span>
              </h4>
              {!disabled && (
                <span className="ml-auto flex flex-wrap items-center gap-2">
                  <select aria-label="Question type to add" className="rounded-md border border-border bg-surface px-2 py-1.5 text-sm" value={addKind} onChange={(e) => setAddKind(e.target.value as QuestionKind)}>
                    {KIND_KEYS.map((k) => (
                      <option key={k} value={k}>
                        {QUESTION_KINDS[k].label}
                      </option>
                    ))}
                  </select>
                  <Button onClick={() => set({ questions: [...round.questions, newQuestion(addKind)] })} disabled={round.questions.length >= ROUNDS_LIMITS.questionsMax}>
                    + Add question
                  </Button>
                  <Button onClick={() => setAiOpen(true)} disabled={aiOpen || round.questions.length >= ROUNDS_LIMITS.questionsMax}>
                    ✨ Generate with AI
                  </Button>
                </span>
              )}
            </div>

            {aiOpen && (
              <AiGeneratePanel
                jobId={jobId}
                round={round}
                onClose={() => setAiOpen(false)}
                onAdd={(qs) => set({ questions: [...round.questions, ...qs].slice(0, ROUNDS_LIMITS.questionsMax) })}
              />
            )}

            {round.questions.length === 0 ? (
              <p className="text-sm text-muted">
                {round.passMode === 'INTERVIEWER_SCORE'
                  ? 'Optional for interview rounds: add the questions the interviewer should ask.'
                  : 'No questions yet. Add your own or generate them with AI.'}
              </p>
            ) : (
              <ol className="flex flex-col gap-3">
                {round.questions.map((q, j) => (
                  <QuestionEditor
                    key={q.key}
                    q={q}
                    index={j}
                    count={round.questions.length}
                    path={`${path}.questions.${j}`}
                    validation={validation}
                    disabled={disabled}
                    onChange={(next) => set({ questions: round.questions.map((x, k) => (k === j ? next : x)) })}
                    onMove={(to) => set({ questions: move(round.questions, j, to) })}
                    onRemove={() => set({ questions: round.questions.filter((_, k) => k !== j) })}
                  />
                ))}
              </ol>
            )}
          </section>
        </div>
      )}
    </li>
  );
}
