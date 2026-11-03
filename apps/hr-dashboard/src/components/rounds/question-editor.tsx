'use client';

import {
  DSA_BANK,
  DSA_SPEC_LIMITS,
  DSA_TOPIC_PREFIX,
  QUESTION_KINDS,
  ROUNDS_LIMITS,
  dsaBankEntry,
  dsaBankIdOf,
  dsaTopicFor,
  type Difficulty,
  type SqlBankListItem,
} from '@hireflow/contracts';
import { useEffect, useState } from 'react';
import { ApiError } from '@/lib/api';
import { messagesUnder, newCodingDraft, newTestDraft, type CodingDraft, type QuestionDraft, type Validation } from '@/lib/rounds';
import { activeSqlQuestions, getSqlQuestion } from '@/lib/sql-bank-api';
import { Button, inputClass } from '../ui';

const DIFFICULTIES: Difficulty[] = ['EASY', 'MEDIUM', 'HARD'];
const small = 'rounded-md border border-border bg-surface px-2 py-1 text-sm';
/** The "DSA problem" choice for HR's own problem (bank problems use their id). */
const OWN = '__own__';
/** The "DSA problem" choices for SQL bank questions: `sql:<id>`; the round's copy keeps working without the bank one. */
const SQL_PREFIX = 'sql:';
const SQL_CURRENT = 'sql:current';

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
  // A coding question tied to a bank problem is run online (invitation email, timed coding page, automatic result).
  const bankId = q.kind === 'CODING' ? dsaBankIdOf(q.topics) : null;
  // SQL problems come from the company's SQL question bank (SQL questions page); only active ones can be picked
  const [sqlBank, setSqlBank] = useState<SqlBankListItem[] | null>(null);
  const [sqlError, setSqlError] = useState('');
  const [sqlLoading, setSqlLoading] = useState(false);
  useEffect(() => {
    if (q.kind !== 'CODING') return;
    let live = true;
    activeSqlQuestions().then(
      (list) => live && setSqlBank(list),
      () => live && setSqlBank([]), // the picker still offers DSA problems; the SQL bank is optional
    );
    return () => {
      live = false;
    };
  }, [q.kind]);
  const pickSql = async (bankQuestionId: string) => {
    setSqlLoading(true);
    setSqlError('');
    try {
      const b = await getSqlQuestion(bankQuestionId);
      // a copy of the bank question: its description is what candidates read, its marks and difficulty are suggestions
      set({
        coding: null,
        sql: b.problem,
        topics: b.topics.filter((t) => !t.startsWith(DSA_TOPIC_PREFIX)).slice(0, ROUNDS_LIMITS.topicsMax),
        text: b.description,
        marks: String(b.marks),
        difficulty: b.difficulty,
        language: 'SQL',
      });
    } catch (err) {
      setSqlError(err instanceof ApiError ? err.message : 'Could not load that SQL question. Please try again.');
    } finally {
      setSqlLoading(false);
    }
  };
  const pickProblem = (id: string) => {
    const others = q.topics.filter((t) => !t.startsWith(DSA_TOPIC_PREFIX));
    if (id === SQL_CURRENT) return;
    if (id.startsWith(SQL_PREFIX)) return void pickSql(id.slice(SQL_PREFIX.length));
    // HR's own problem: kept while HR switches away and back, so nothing typed is lost by a wrong click
    if (id === OWN) return set({ topics: others, sql: null, coding: q.coding ?? newCodingDraft() });
    const entry = dsaBankEntry(id);
    if (!entry) return set({ topics: others, coding: null, sql: null });
    const previous = bankId ? dsaBankEntry(bankId) : undefined;
    set({
      coding: null,
      sql: null,
      topics: [dsaTopicFor(entry.id), ...others],
      difficulty: entry.difficulty,
      // HR's own wording and marks are kept; only an empty text, the default marks or the previous problem's are replaced
      text: q.text.trim() && q.text !== (previous ? `${previous.title}

${previous.summary}` : '') ? q.text : `${entry.title}

${entry.summary}`,
      marks: q.marks === '5' || (previous && q.marks === String(previous.marks)) ? String(entry.marks) : q.marks,
    });
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
        placeholder={
          q.kind === 'TRUE_FALSE' ? 'Write a statement that is true or false' : q.coding ? 'Problem statement (shown to candidates)' : 'Write the question'
        }
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

      {q.kind === 'CODING' && (
        <div className="flex flex-col gap-1">
          <label htmlFor={`${id}-bank`} className="text-xs text-muted">
            DSA or SQL problem (optional): candidates solve it online (Python, Java or C++ / one SQL query) and it is graded automatically
          </label>
          <select
            id={`${id}-bank`}
            className={`${small} max-w-md`}
            value={q.sql ? (q.sql.bankId && sqlBank?.some((b) => b.id === q.sql!.bankId) ? `${SQL_PREFIX}${q.sql.bankId}` : SQL_CURRENT) : q.coding ? OWN : (bankId ?? '')}
            disabled={disabled || sqlLoading}
            onChange={(e) => pickProblem(e.target.value)}
          >
            <option value="">None — HR runs this question</option>
            <option value={OWN}>Write my own problem (statement + test cases)</option>
            <optgroup label="Problem bank">
              {DSA_BANK.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title} ({p.difficulty[0]}
                  {p.difficulty.slice(1).toLowerCase()}, {p.marks} marks suggested)
                </option>
              ))}
            </optgroup>
            <optgroup label="SQL question bank">
              {q.sql && !(q.sql.bankId && sqlBank?.some((b) => b.id === q.sql!.bankId)) && <option value={SQL_CURRENT}>{q.sql.title} (this round&apos;s copy)</option>}
              {sqlBank?.map((b) => (
                <option key={b.id} value={`${SQL_PREFIX}${b.id}`}>
                  {b.title} ({b.difficulty[0]}
                  {b.difficulty.slice(1).toLowerCase()}, {b.marks} marks)
                </option>
              ))}
              {sqlBank && !sqlBank.length && !q.sql && (
                <option value="" disabled>
                  No active SQL questions yet (SQL questions page)
                </option>
              )}
            </optgroup>
          </select>
          {bankId && <p className="text-xs text-muted">Candidates see the problem statement from the bank; the text above is only for you. A round is run online when every question has a DSA problem.</p>}
          {sqlError && <p className="text-xs font-medium text-danger">{sqlError}</p>}
          {q.sql && (
            <p className="text-xs text-muted">
              SQL problem &ldquo;{q.sql.title}&rdquo;: {q.sql.tables.map((t) => t.name).join(', ')} · {q.sql.tests.filter((t) => !t.hidden).length} sample /{' '}
              {q.sql.tests.filter((t) => t.hidden).length} hidden datasets. Candidates answer with one SQL query; the text above is the problem they read. This
              round keeps its own copy: after editing the question on the SQL questions page, pick it here again to use the new version.
            </p>
          )}
        </div>
      )}

      {q.kind === 'CODING' && q.coding && (
        <ProblemEditor id={id} coding={q.coding} disabled={disabled} onChange={(coding) => set({ coding })} />
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

/**
 * HR's own DSA problem: title, input / output format, constraints and the test cases. Candidates write a full program
 * (Python, Java or C++) that reads the input and prints the answer; it is judged on every test, the sample ones are also
 * shown on the problem page and used by Run. Hidden tests are never shown to candidates.
 */
function ProblemEditor({ id, coding, disabled, onChange }: { id: string; coding: CodingDraft; disabled: boolean; onChange: (c: CodingDraft) => void }) {
  const set = (patch: Partial<CodingDraft>) => onChange({ ...coding, ...patch });
  const setTest = (key: string, patch: Partial<CodingDraft['tests'][number]>) =>
    set({ tests: coding.tests.map((t) => (t.key === key ? { ...t, ...patch } : t)) });
  const text = (field: 'inputFormat' | 'outputFormat' | 'constraints', label: string, placeholder: string) => (
    <div className="flex flex-col gap-1">
      <label htmlFor={`${id}-${field}`} className="text-xs text-muted">
        {label}
      </label>
      <textarea
        id={`${id}-${field}`}
        rows={2}
        className={inputClass}
        placeholder={placeholder}
        value={coding[field]}
        maxLength={DSA_SPEC_LIMITS.formatMax}
        disabled={disabled}
        onChange={(e) => set({ [field]: e.target.value })}
      />
    </div>
  );

  return (
    <fieldset className="flex flex-col gap-3 rounded-md border border-border bg-surface p-3">
      <legend className="px-1 text-xs font-medium">DSA problem — candidates write a program that reads the input and prints the answer</legend>
      <div className="flex flex-col gap-1">
        <label htmlFor={`${id}-title`} className="text-xs text-muted">
          Problem title (shown to candidates)
        </label>
        <input
          id={`${id}-title`}
          className={inputClass}
          placeholder="e.g. Sum of two numbers"
          value={coding.title}
          maxLength={DSA_SPEC_LIMITS.titleMax}
          disabled={disabled}
          onChange={(e) => set({ title: e.target.value })}
        />
      </div>
      {text('inputFormat', 'Input format', 'e.g. The first line holds n. The second line holds n integers.')}
      {text('outputFormat', 'Output format', 'e.g. Print the sum on one line.')}
      {text('constraints', 'Constraints (one per line)', '1 ≤ n ≤ 10^5')}

      <div className="flex flex-col gap-2">
        <p className="text-xs text-muted">
          Test cases — the output is compared line by line (spaces at line ends ignored). Sample tests are shown to candidates; hidden tests only grade
          the submission.
        </p>
        {coding.tests.map((t, i) => (
          <div key={t.key} className="flex flex-col gap-2 rounded-md border border-border p-2">
            <div className="flex items-center gap-3 text-xs">
              <span className="font-medium">Test {i + 1}</span>
              <label className="flex items-center gap-1">
                <input type="checkbox" checked={t.hidden} disabled={disabled} onChange={(e) => setTest(t.key, { hidden: e.target.checked })} />
                Hidden
              </label>
              <Button
                variant="ghost"
                className="ml-auto px-2 py-1 text-danger"
                aria-label={`Remove test ${i + 1}`}
                disabled={disabled}
                onClick={() => set({ tests: coding.tests.filter((x) => x.key !== t.key) })}
              >
                Remove
              </Button>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <textarea
                aria-label={`Test ${i + 1} input`}
                rows={3}
                className={`${inputClass} font-mono`}
                placeholder="Input (stdin)"
                value={t.input}
                maxLength={DSA_SPEC_LIMITS.testInputMax}
                disabled={disabled}
                onChange={(e) => setTest(t.key, { input: e.target.value })}
              />
              <textarea
                aria-label={`Test ${i + 1} expected output`}
                rows={3}
                className={`${inputClass} font-mono`}
                placeholder="Expected output"
                value={t.output}
                maxLength={DSA_SPEC_LIMITS.testOutputMax}
                disabled={disabled}
                onChange={(e) => setTest(t.key, { output: e.target.value })}
              />
            </div>
          </div>
        ))}
        {coding.tests.length < DSA_SPEC_LIMITS.testsMax && (
          <span className="flex gap-2">
            <Button variant="ghost" className="px-2 py-1" disabled={disabled} onClick={() => set({ tests: [...coding.tests, newTestDraft(false)] })}>
              + Sample test
            </Button>
            <Button variant="ghost" className="px-2 py-1" disabled={disabled} onClick={() => set({ tests: [...coding.tests, newTestDraft(true)] })}>
              + Hidden test
            </Button>
          </span>
        )}
      </div>
    </fieldset>
  );
}
