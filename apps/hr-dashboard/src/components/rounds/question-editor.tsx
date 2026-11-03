'use client';

import { QUESTION_KINDS, ROUNDS_LIMITS, type Difficulty } from '@hireflow/contracts';
import { messagesUnder, type QuestionDraft, type Validation } from '@/lib/rounds';
import { Button, inputClass } from '../ui';

const DIFFICULTIES: Difficulty[] = ['EASY', 'MEDIUM', 'HARD'];
const small = 'rounded-md border border-border bg-surface px-2 py-1 text-sm';

/** One question of a round: text, options / correct answer or expected answer, marks. */
export function QuestionEditor({
  q,
  index,
  count,
  path,
  validation,
  disabled,
  onChange,
  onMove,
  onRemove,
}: {
  q: QuestionDraft;
  index: number;
  count: number;
  /** "rounds.0.questions.3" - where this question's messages are. */
  path: string;
  validation: Validation | null;
  disabled: boolean;
  onChange: (q: QuestionDraft) => void;
  onMove: (to: number) => void;
  onRemove: () => void;
}) {
  const set = (patch: Partial<QuestionDraft>) => onChange({ ...q, ...patch });
  const errors = validation ? messagesUnder(validation, path) : [];
  const id = `q-${q.key}`;
  const choice = q.kind === 'MCQ' || q.kind === 'TRUE_FALSE';

  const toggleCorrect = (i: number) => {
    if (q.kind === 'TRUE_FALSE') return set({ correct: [i] });
    set({ correct: q.correct.includes(i) ? q.correct.filter((c) => c !== i) : [...q.correct, i].sort((a, b) => a - b) });
  };
  const removeOption = (i: number) =>
    set({ options: q.options.filter((_, j) => j !== i), correct: q.correct.filter((c) => c !== i).map((c) => (c > i ? c - 1 : c)) });

  return (
    <li className={`flex flex-col gap-3 rounded-md border p-3 ${errors.length ? 'border-danger/50' : 'border-border'}`}>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">Q{index + 1}</span>
        <span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted">{QUESTION_KINDS[q.kind].label}</span>
        {q.source === 'AI' && <span className="rounded-full border border-accent/40 bg-accent-soft px-2 py-0.5 text-xs text-accent">AI</span>}
        <span className="ml-auto flex items-center gap-1">
          <Button variant="ghost" className="px-2 py-1" aria-label={`Move question ${index + 1} up`} disabled={disabled || index === 0} onClick={() => onMove(index - 1)}>
            ↑
          </Button>
          <Button variant="ghost" className="px-2 py-1" aria-label={`Move question ${index + 1} down`} disabled={disabled || index === count - 1} onClick={() => onMove(index + 1)}>
            ↓
          </Button>
          <Button variant="ghost" className="px-2 py-1 text-danger" aria-label={`Delete question ${index + 1}`} disabled={disabled} onClick={onRemove}>
            Delete
          </Button>
        </span>
      </div>

      <label className="sr-only" htmlFor={`${id}-text`}>
        Question {index + 1}
      </label>
      <textarea
        id={`${id}-text`}
        rows={q.kind === 'CODING' || q.kind === 'DESCRIPTIVE' ? 4 : 2}
        className={inputClass}
        placeholder={q.kind === 'TRUE_FALSE' ? 'Write a statement that is true or false' : 'Write the question'}
        value={q.text}
        maxLength={ROUNDS_LIMITS.questionTextMax}
        disabled={disabled}
        onChange={(e) => set({ text: e.target.value })}
      />

      {choice && (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-xs text-muted">
            {q.kind === 'TRUE_FALSE' ? 'The correct answer' : 'Options — tick the correct one(s)'}
          </legend>
          {q.options.map((opt, i) => (
            <div key={i} className="flex items-center gap-2">
              <input
                type={q.kind === 'TRUE_FALSE' ? 'radio' : 'checkbox'}
                name={`${id}-correct`}
                aria-label={`Option ${i + 1} is correct`}
                checked={q.correct.includes(i)}
                disabled={disabled}
                onChange={() => toggleCorrect(i)}
               
              />
              {q.kind === 'TRUE_FALSE' ? (
                <span className="text-sm">{opt}</span>
              ) : (
                <>
                  <input
                    className={inputClass}
                    aria-label={`Option ${i + 1}`}
                    placeholder={`Option ${i + 1}`}
                    value={opt}
                    maxLength={ROUNDS_LIMITS.optionMax}
                    disabled={disabled}
                    onChange={(e) => set({ options: q.options.map((o, j) => (j === i ? e.target.value : o)) })}
                  />
                  <Button variant="ghost" className="px-2 py-1" aria-label={`Remove option ${i + 1}`} disabled={disabled || q.options.length <= ROUNDS_LIMITS.optionsMin} onClick={() => removeOption(i)}>
                    ×
                  </Button>
                </>
              )}
            </div>
          ))}
          {q.kind === 'MCQ' && q.options.length < ROUNDS_LIMITS.optionsMax && (
            <Button variant="ghost" className="self-start px-2 py-1" disabled={disabled} onClick={() => set({ options: [...q.options, ''] })}>
              + Add option
            </Button>
          )}
        </fieldset>
      )}

      {!choice && (
        <div className="flex flex-col gap-1">
          <label htmlFor={`${id}-answer`} className="text-xs text-muted">
            {q.kind === 'CODING' ? 'Reference solution' : q.kind === 'SHORT_ANSWER' ? 'Expected answer' : 'What a good answer covers'} (optional, never shown to students)
          </label>
          <textarea
            id={`${id}-answer`}
            rows={q.kind === 'CODING' ? 4 : 2}
            className={`${inputClass} ${q.kind === 'CODING' ? 'font-mono' : ''}`}
            value={q.modelAnswer}
            maxLength={ROUNDS_LIMITS.modelAnswerMax}
            disabled={disabled}
            onChange={(e) => set({ modelAnswer: e.target.value })}
          />
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3 text-sm">
        <label className="flex items-center gap-2">
          Marks
          <input
            type="number"
            min={1}
            max={ROUNDS_LIMITS.marksMax}
            className={`${small} w-20`}
            value={q.marks}
            disabled={disabled}
            onChange={(e) => set({ marks: e.target.value })}
          />
        </label>
        <label className="flex items-center gap-2">
          Difficulty
          <select className={small} value={q.difficulty ?? ''} disabled={disabled} onChange={(e) => set({ difficulty: (e.target.value || null) as Difficulty | null })}>
            <option value="">—</option>
            {DIFFICULTIES.map((d) => (
              <option key={d} value={d}>
                {d[0]}
                {d.slice(1).toLowerCase()}
              </option>
            ))}
          </select>
        </label>
        {q.kind === 'CODING' && (
          <label className="flex items-center gap-2">
            Language
            <input className={`${small} w-28`} value={q.language} maxLength={40} disabled={disabled} onChange={(e) => set({ language: e.target.value })} />
          </label>
        )}
        {q.topics.length > 0 && <span className="text-xs text-muted">Topics: {q.topics.join(', ')}</span>}
      </div>

      {errors.length > 0 && (
        <ul className="text-xs font-medium text-danger">
          {errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}
    </li>
  );
}
