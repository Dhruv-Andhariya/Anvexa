'use client';

import { QUESTION_KINDS, ROUND_TYPES, ROUNDS_LIMITS, type Difficulty, type QuestionKind } from '@hireflow/contracts';
import { useState } from 'react';
import { ApiError } from '@/lib/api';
import { fromGenerated, type QuestionDraft, type RoundDraft } from '@/lib/rounds';
import { generateQuestions } from '@/lib/rounds-api';
import { Button, Spinner, inputClass } from '../ui';
import { QuestionEditor } from './question-editor';

const ALL_KINDS = Object.keys(QUESTION_KINDS) as QuestionKind[];

/**
 * "Generate with AI" for one round. The AI only suggests: HR edits any suggestion (text, options, correct answer,
 * marks...), ticks the ones to keep and they are added to the round as edited (saved when the rounds are saved).
 * Nothing reaches students without HR.
 */
export function AiGeneratePanel({ jobId, round, onAdd, onClose }: { jobId: string; round: RoundDraft; onAdd: (q: QuestionDraft[]) => void; onClose: () => void }) {
  const [count, setCount] = useState('5');
  const [difficulty, setDifficulty] = useState<Difficulty>('MEDIUM');
  const [topics, setTopics] = useState('');
  // SQL rounds are coding only (each question is one SQL query): no question types to tick
  const fixedKinds: QuestionKind[] | null = round.type === 'SQL' ? ['CODING'] : null;
  const [kinds, setKinds] = useState<QuestionKind[]>(fixedKinds ?? ROUND_TYPES[round.type].kinds);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // the suggestions as editable questions: what HR edits here is exactly what is added
  const [suggested, setSuggested] = useState<QuestionDraft[] | null>(null);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [editing, setEditing] = useState<number | null>(null);

  const n = Number(count);
  const countOk = Number.isInteger(n) && n >= 1 && n <= ROUNDS_LIMITS.generateMax;

  const run = async () => {
    setError('');
    setBusy(true);
    try {
      const res = await generateQuestions(jobId, {
        roundType: round.type,
        roundName: round.name.trim() || ROUND_TYPES[round.type].label,
        roundDescription: round.description,
        count: n,
        difficulty,
        topics: topics
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean)
          .slice(0, ROUNDS_LIMITS.topicsMax)
          .map((t) => t.slice(0, ROUNDS_LIMITS.topicMax)),
        kinds,
        avoid: round.questions.map((q) => q.text).filter(Boolean),
      });
      setSuggested(res.questions.map(fromGenerated));
      setPicked(new Set(res.questions.map((_, i) => i)));
      setEditing(null);
      if (!res.questions.length) setError('The AI did not write usable questions this time. Try again or change the topics.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not generate questions. Please try again.');
    }
    setBusy(false);
  };

  const add = () => {
    onAdd((suggested ?? []).filter((_, i) => picked.has(i)));
    setSuggested(null);
    onClose();
  };

  return (
    <div className="flex flex-col gap-3 rounded-md border border-accent/40 bg-accent-soft/40 p-3">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium">Generate questions with AI</p>
        <Button variant="ghost" className="px-2 py-1" onClick={onClose} disabled={busy}>
          Close
        </Button>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <label className="flex flex-col gap-1 text-sm">
          Number of questions
          <input
            type="number"
            min={1}
            max={ROUNDS_LIMITS.generateMax}
            className={inputClass}
            value={count}
            aria-invalid={!countOk}
            onChange={(e) => setCount(e.target.value)}
            disabled={busy}
          />
          {!countOk && <span className="text-xs text-danger">1 to {ROUNDS_LIMITS.generateMax}</span>}
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Difficulty
          <select className={inputClass} value={difficulty} onChange={(e) => setDifficulty(e.target.value as Difficulty)} disabled={busy}>
            <option value="EASY">Easy</option>
            <option value="MEDIUM">Medium</option>
            <option value="HARD">Hard</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Topics <span className="text-xs text-muted">(comma separated, optional)</span>
          <input className={inputClass} placeholder="e.g. Percentages, Time and work" value={topics} onChange={(e) => setTopics(e.target.value)} disabled={busy} />
        </label>
      </div>

      {!fixedKinds && (
        <fieldset className="flex flex-wrap gap-3 text-sm">
          <legend className="mb-1 text-xs text-muted">Question types</legend>
          {ALL_KINDS.map((k) => (
            <label key={k} className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={kinds.includes(k)}
                disabled={busy}
                onChange={() => setKinds(kinds.includes(k) ? kinds.filter((x) => x !== k) : [...kinds, k])}
              />
              {QUESTION_KINDS[k].label}
            </label>
          ))}
        </fieldset>
      )}

      <div>
        <Button variant="primary" onClick={run} disabled={busy || !countOk || !kinds.length}>
          {busy && <Spinner />}
          {busy ? 'Writing questions…' : suggested ? 'Generate again' : 'Generate'}
        </Button>
      </div>

      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}

      {suggested && suggested.length > 0 && (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-muted">Review the suggestions: edit any of them, and keep only the ones you want.</p>
          <ul className="flex flex-col gap-2">
            {suggested.map((q, i) => (
              <li key={i} className="flex gap-2 rounded-md border border-border bg-surface p-2 text-sm">
                <input
                  type="checkbox"
                  aria-label={`Keep suggestion ${i + 1}`}
                  checked={picked.has(i)}
                  onChange={() => {
                    const next = new Set(picked);
                    if (next.has(i)) next.delete(i);
                    else next.add(i);
                    setPicked(next);
                  }}
                />
                {editing === i ? (
                  <div className="flex min-w-0 flex-1 flex-col gap-2">
                    <ol>
                      <QuestionEditor
                        q={q}
                        index={i}
                        count={suggested.length}
                        path={`ai.${i}`}
                        validation={null}
                        disabled={false}
                        onChange={(next) => setSuggested(suggested.map((x, k) => (k === i ? next : x)))}
                        onMove={() => undefined}
                        onRemove={() => {
                          const next = new Set(picked);
                          next.delete(i);
                          setPicked(next);
                          setEditing(null);
                        }}
                      />
                    </ol>
                    <Button className="self-start" onClick={() => setEditing(null)}>
                      Done editing
                    </Button>
                  </div>
                ) : (
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <p className="whitespace-pre-wrap">{q.text}</p>
                    {q.options.length > 0 && (
                      <ol className="list-[lower-alpha] pl-5 text-muted">
                        {q.options.map((o, j) => (
                          <li key={j} className={q.correct.includes(j) ? 'font-medium text-success' : ''}>
                            {o}
                            {q.correct.includes(j) && ' ✓'}
                          </li>
                        ))}
                      </ol>
                    )}
                    {q.modelAnswer && <p className="whitespace-pre-wrap text-xs text-muted">Answer: {q.modelAnswer}</p>}
                    <p className="text-xs text-muted">
                      {QUESTION_KINDS[q.kind].label} · {q.marks} mark{q.marks === '1' ? '' : 's'}
                      {q.topics.length > 0 && ` · ${q.topics.join(', ')}`}
                    </p>
                  </div>
                )}
                {editing !== i && (
                  <Button variant="ghost" className="self-start px-2 py-1 text-xs" onClick={() => setEditing(i)}>
                    ✎ Edit
                  </Button>
                )}
              </li>
            ))}
          </ul>
          <div className="flex gap-2">
            <Button variant="primary" onClick={add} disabled={!picked.size}>
              Add {picked.size} selected
            </Button>
            <Button onClick={() => setPicked(picked.size === suggested.length ? new Set() : new Set(suggested.map((_, i) => i)))}>
              {picked.size === suggested.length ? 'Select none' : 'Select all'}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
