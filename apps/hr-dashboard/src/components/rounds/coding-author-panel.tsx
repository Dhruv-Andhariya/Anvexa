'use client';

import { codingCsvTemplate, type AuthoredCodingProblem, type CodingProblemsResult } from '@hireflow/contracts';
import { useRef, useState } from 'react';
import { ApiError } from '@/lib/api';
import { fromAuthored, type QuestionDraft, type RoundDraft } from '@/lib/rounds';
import { generateCodingProblems, importCodingProblems } from '@/lib/rounds-api';
import { Button, Spinner, inputClass } from '../ui';
import { QuestionEditor } from './question-editor';

const ORIGIN: Record<AuthoredCodingProblem['origin'], string> = { ai: 'Written by AI', document: 'From your file', csv: 'From your CSV' };

/**
 * DSA coding round: problems written by the AI, or read from HR's PDF / Word / CSV file. Every test output of an AI
 * problem was produced by running its reference solution on the code runner. HR picks the problems; marks and tests
 * stay editable in the round afterwards. Nothing is saved until HR saves the round.
 */
export function CodingAuthorPanel({
  jobId,
  round,
  mode,
  room,
  marksEach,
  onAdd,
  onClose,
}: {
  jobId: string;
  round: RoundDraft;
  mode: 'ai' | 'upload';
  /** How many questions the round can still take (HR's planned number of problems, when set). */
  room: number;
  /** HR's marks per problem for this round (null = keep each problem's own marks). */
  marksEach: number | null;
  onAdd: (q: QuestionDraft[]) => void;
  onClose: () => void;
}) {
  const [count, setCount] = useState(Math.min(5, Math.max(1, room || 1)));
  const [difficulty, setDifficulty] = useState<'EASY' | 'MEDIUM' | 'HARD'>('MEDIUM');
  const [topics, setTopics] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<CodingProblemsResult | null>(null);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  // the problems as editable questions: what HR edits here (statement, tests, marks...) is exactly what is added
  const [drafts, setDrafts] = useState<QuestionDraft[]>([]);
  const [editing, setEditing] = useState<number | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);

  const show = (r: CodingProblemsResult) => {
    setResult(r);
    setDrafts(r.problems.map(fromAuthored));
    setEditing(null);
    setPicked(new Set(r.problems.map((_, i) => i).slice(0, room)));
  };
  const run = async (action: () => Promise<CodingProblemsResult>) => {
    setBusy(true);
    setError('');
    setResult(null);
    try {
      show(await action());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  };
  const generate = () =>
    run(() =>
      generateCodingProblems(jobId, {
        count,
        difficulty,
        topics: topics
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean)
          .slice(0, 10),
        avoid: round.questions.map((q) => q.coding?.title || q.text).filter(Boolean).slice(0, 100),
      }),
    );
  const upload = (file: File | undefined) => {
    if (file) void run(() => importCodingProblems(jobId, file));
  };
  const downloadTemplate = () => {
    const url = URL.createObjectURL(new Blob(['﻿' + codingCsvTemplate()], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'coding-problems-template.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <div className="flex flex-col gap-3 rounded-md border border-accent/40 bg-accent-soft/40 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <h5 className="text-sm font-semibold">{mode === 'ai' ? '✨ Generate coding problems with AI' : '⬆ Add coding problems from a file'}</h5>
        <Button variant="ghost" className="ml-auto px-2 py-1 text-xs" onClick={onClose} disabled={busy}>
          Close
        </Button>
      </div>

      {mode === 'ai' ? (
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-sm font-medium">
            Problems
            <select className={`${inputClass} w-24`} value={count} onChange={(e) => setCount(Number(e.target.value))} disabled={busy}>
              {[1, 2, 3, 4, 5].filter((n) => n <= Math.max(1, room)).map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm font-medium">
            Difficulty
            <select className={`${inputClass} w-32`} value={difficulty} onChange={(e) => setDifficulty(e.target.value as typeof difficulty)} disabled={busy}>
              <option value="EASY">Easy</option>
              <option value="MEDIUM">Medium</option>
              <option value="HARD">Hard</option>
            </select>
          </label>
          <label className="flex min-w-56 flex-1 flex-col gap-1 text-sm font-medium">
            Topics (optional, comma separated)
            <input className={inputClass} placeholder="e.g. arrays, strings, hashing" value={topics} onChange={(e) => setTopics(e.target.value)} disabled={busy} maxLength={600} />
          </label>
          <Button variant="primary" onClick={() => void generate()} disabled={busy}>
            {busy && <Spinner />} Generate
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-muted">
            Upload a <span className="font-medium text-foreground">PDF</span> or <span className="font-medium text-foreground">Word (.docx)</span> file with your
            problems (the AI reads them out and adds hidden tests), or a <span className="font-medium text-foreground">CSV</span> file in the template format (taken
            exactly as you wrote it). At most 5 MB.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={fileInput}
              type="file"
              accept=".pdf,.docx,.csv,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/csv"
              className="hidden"
              onChange={(e) => {
                upload(e.target.files?.[0]);
                e.target.value = '';
              }}
            />
            <Button variant="primary" onClick={() => fileInput.current?.click()} disabled={busy}>
              {busy && <Spinner />} Choose file…
            </Button>
            <Button variant="ghost" onClick={downloadTemplate} disabled={busy}>
              Download CSV template
            </Button>
          </div>
        </div>
      )}

      {busy && <p className="text-xs text-muted">{mode === 'ai' ? 'Writing the problems and checking every test output on the code runner… (up to a minute)' : 'Reading the file…'}</p>}
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}

      {result && (
        <div className="flex flex-col gap-2">
          {result.problems.length === 0 ? (
            <p className="text-sm text-muted">No usable problem this time.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {result.problems.map((p, i) => {
                const d = drafts[i]!;
                const tests = d.coding?.tests ?? [];
                const samples = tests.filter((t) => !t.hidden).length;
                if (editing === i) {
                  return (
                    <li key={i} className="flex flex-col gap-2 rounded-md border border-accent/50 bg-surface p-3">
                      <ol>
                        <QuestionEditor
                          q={d}
                          index={i}
                          count={drafts.length}
                          path={`coding.${i}`}
                          validation={null}
                          disabled={false}
                          onChange={(next) => setDrafts(drafts.map((x, k) => (k === i ? next : x)))}
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
                    </li>
                  );
                }
                return (
                  <li key={i} className="rounded-md border border-border bg-surface p-3">
                    <label className="flex items-start gap-2">
                      <input
                        type="checkbox"
                        className="mt-1"
                        checked={picked.has(i)}
                        onChange={(e) => {
                          const next = new Set(picked);
                          if (e.target.checked) next.add(i);
                          else next.delete(i);
                          setPicked(next);
                        }}
                      />
                      <span className="flex min-w-0 flex-1 flex-col gap-1">
                        <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
                          {d.coding?.title || 'Untitled problem'}
                          <span className="rounded-full border border-border px-2 py-px text-xs font-normal text-muted">{(d.difficulty ?? p.question.difficulty).toLowerCase()}</span>
                          <span className="text-xs font-normal text-muted">
                            {d.marks} marks · {samples} sample + {tests.length - samples} hidden test{tests.length - samples === 1 ? '' : 's'} · {ORIGIN[p.origin]}
                          </span>
                        </span>
                        <span className="line-clamp-2 text-xs text-muted">{d.text}</span>
                        {p.notes.map((n) => (
                          <span key={n} className="text-xs text-danger">
                            ⚠ {n}
                          </span>
                        ))}
                      </span>
                    </label>
                    <Button variant="ghost" className="mt-1 px-2 py-1 text-xs" onClick={() => setEditing(i)}>
                      ✎ Edit statement, tests and marks
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
          {result.dropped.length > 0 && (
            <details className="text-xs text-muted">
              <summary>{result.dropped.length} problem(s) could not be used</summary>
              <ul className="mt-1 list-disc pl-5">
                {result.dropped.map((d, i) => (
                  <li key={i}>
                    {d.title}: {d.reason}
                  </li>
                ))}
              </ul>
            </details>
          )}
          {result.problems.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="primary"
                disabled={!picked.size || picked.size > room}
                onClick={() => {
                  onAdd(drafts.filter((_, i) => picked.has(i)).map((d) => (marksEach ? { ...d, marks: String(marksEach) } : d)));
                  onClose();
                }}
              >
                Add {picked.size} to the round
              </Button>
              {picked.size > room && <span className="text-xs text-danger">The round can take {room} more question(s).</span>}
              <span className="text-xs text-muted">You can still change the marks, statement and tests of each problem in the round.</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
