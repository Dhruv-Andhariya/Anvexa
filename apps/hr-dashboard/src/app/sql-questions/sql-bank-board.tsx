'use client';

import { SQL_LIMITS, type SqlBankListItem, type SqlBankQuestion, type SqlProblemSpec, type SqlQuestionInput } from '@hireflow/contracts';
import { useCallback, useEffect, useState } from 'react';
import { SqlResultTable } from '@/components/sql-result-table';
import { Button, Card, ErrorNotice, Field, Spinner, inputClass } from '@/components/ui';
import { ApiError } from '@/lib/api';
import {
  addStarterSqlQuestions,
  checkSqlQuestion,
  createSqlQuestion,
  deleteSqlQuestion,
  getSqlQuestion,
  listSqlQuestions,
  setSqlQuestionActive,
  updateSqlQuestion,
} from '@/lib/sql-bank-api';

const messageOf = (err: unknown) => (err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
const pill = 'inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium';
const DIFFICULTY: Record<'EASY' | 'MEDIUM' | 'HARD', { label: string; style: string }> = {
  EASY: { label: 'Easy', style: 'border-success/40 bg-success-soft text-success' },
  MEDIUM: { label: 'Medium', style: 'border-accent/40 bg-accent-soft text-accent' },
  HARD: { label: 'Hard', style: 'border-danger/40 bg-danger-soft text-danger' },
};
const mono = `${inputClass} font-mono text-xs`;

let seq = 0;
const key = () => `t${Date.now().toString(36)}${(seq++).toString(36)}`;

/** The form while HR types (numbers as text). */
interface Draft {
  id?: string;
  title: string;
  description: string;
  difficulty: 'EASY' | 'MEDIUM' | 'HARD';
  marks: string;
  topics: string;
  schemaSql: string;
  starterQuery: string;
  referenceQuery: string;
  orderMatters: boolean;
  timeLimitMs: string;
  active: boolean;
  tests: { key: string; name: string; dataSql: string; hidden: boolean }[];
}

const emptyDraft = (): Draft => ({
  title: '',
  description: '',
  difficulty: 'EASY',
  marks: '5',
  topics: '',
  schemaSql: 'CREATE TABLE employees (\n  id     INTEGER PRIMARY KEY,\n  name   TEXT NOT NULL,\n  salary INTEGER\n);',
  starterQuery: '',
  referenceQuery: '',
  orderMatters: false,
  timeLimitMs: '2000',
  active: true,
  tests: [
    { key: key(), name: 'Sample', dataSql: '', hidden: false },
    { key: key(), name: 'Hidden 1', dataSql: '', hidden: true },
  ],
});

const fromQuestion = (q: SqlBankQuestion): Draft => ({
  id: q.id,
  title: q.title,
  description: q.description,
  difficulty: q.difficulty,
  marks: String(q.marks),
  topics: q.topics.join(', '),
  schemaSql: q.problem.schemaSql,
  starterQuery: q.problem.starterQuery,
  referenceQuery: q.problem.referenceQuery,
  orderMatters: q.problem.orderMatters,
  timeLimitMs: String(q.problem.timeLimitMs),
  active: q.active,
  tests: q.problem.tests.map((t) => ({ key: key(), name: t.name, dataSql: t.dataSql, hidden: t.hidden })),
});

const toInput = (d: Draft): SqlQuestionInput => ({
  title: d.title,
  description: d.description,
  difficulty: d.difficulty,
  marks: Number(d.marks),
  topics: d.topics
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean),
  schemaSql: d.schemaSql,
  starterQuery: d.starterQuery,
  referenceQuery: d.referenceQuery,
  orderMatters: d.orderMatters,
  timeLimitMs: Number(d.timeLimitMs),
  active: d.active,
  tests: d.tests.map(({ name, dataSql, hidden }) => ({ name, dataSql, hidden })),
});

/**
 * HR "SQL questions": the company's SQL question bank, kept in the database. HR writes a question (schema, datasets,
 * reference query); the server runs it to show the tables and the expected result of every dataset before it is
 * saved. Questions are put into a job's SQL round from the job's rounds editor (a copy is taken there, so later edits
 * here do not change rounds already set up).
 */
export function SqlBankBoard() {
  const [items, setItems] = useState<SqlBankListItem[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);

  const load = useCallback(async () => {
    setError('');
    try {
      setItems(await listSqlQuestions());
    } catch (err) {
      setError(messageOf(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    setError('');
    setNotice('');
    try {
      await fn();
      await load();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(null);
    }
  };

  const open = (id: string) =>
    act(`open:${id}`, async () => {
      setDraft(fromQuestion(await getSqlQuestion(id)));
    });

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-semibold tracking-tight">SQL questions</h1>
          <p className="mt-1 max-w-3xl text-sm text-muted">
            Your company&apos;s SQL question bank. Candidates answer each question with one SQL query on the same proctored coding page as the DSA round.
            Put questions into a job&apos;s SQL round in the job&apos;s rounds editor (Coding question → SQL problem).
          </p>
        </div>
        <Button
          onClick={() =>
            void act('starter', async () => {
              const r = await addStarterSqlQuestions();
              setNotice(r.added ? `Added ${r.added} starter question${r.added === 1 ? '' : 's'}.` : 'You already have all the starter questions.');
            })
          }
          disabled={busy !== null}
        >
          {busy === 'starter' && <Spinner />} Add the 15 starter questions
        </Button>
        <Button variant="primary" onClick={() => setDraft(emptyDraft())} disabled={busy !== null || draft !== null}>
          New question
        </Button>
      </header>

      {error && <ErrorNotice title="That did not work" message={error} />}
      {notice && (
        <p role="status" className="rounded-md border border-success/40 bg-success-soft px-4 py-3 text-sm text-success">
          {notice}
        </p>
      )}

      {draft && (
        <QuestionEditor
          draft={draft}
          onChange={setDraft}
          onCancel={() => setDraft(null)}
          onSaved={async (saved) => {
            setDraft(null);
            setNotice(`Saved "${saved.title}".`);
            await load();
          }}
        />
      )}

      <Card className="p-0 sm:p-0">
        {!items && !error && (
          <p className="flex items-center gap-2 p-5 text-sm text-muted">
            <Spinner /> Loading…
          </p>
        )}
        {items && !items.length && (
          <p className="p-5 text-sm text-muted">No SQL questions yet. Add the starter questions or write your own.</p>
        )}
        {items && items.length > 0 && (
          <ul className="divide-y divide-border">
            {items.map((q) => (
              <li key={q.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
                <div className="min-w-0 flex-1">
                  <p className={`font-medium ${q.active ? '' : 'text-muted line-through'}`}>{q.title}</p>
                  <p className="mt-0.5 text-xs text-muted">
                    {q.marks} marks · {q.tests.sample} sample / {q.tests.hidden} hidden dataset{q.tests.hidden === 1 ? '' : 's'}
                    {q.topics.length ? ` · ${q.topics.join(', ')}` : ''}
                  </p>
                </div>
                <span className={`${pill} ${DIFFICULTY[q.difficulty].style}`}>{DIFFICULTY[q.difficulty].label}</span>
                <span className={`${pill} ${q.active ? 'border-success/40 bg-success-soft text-success' : 'border-border text-muted'}`}>{q.active ? 'Active' : 'Inactive'}</span>
                <Button variant="ghost" className="px-2 py-1" disabled={busy !== null} onClick={() => void open(q.id)}>
                  {busy === `open:${q.id}` && <Spinner />} Edit
                </Button>
                <Button variant="ghost" className="px-2 py-1" disabled={busy !== null} onClick={() => void act(`active:${q.id}`, () => setSqlQuestionActive(q.id, !q.active))}>
                  {q.active ? 'Deactivate' : 'Activate'}
                </Button>
                <Button
                  variant="ghost"
                  className="px-2 py-1 text-danger"
                  disabled={busy !== null}
                  onClick={() => {
                    if (window.confirm(`Delete "${q.title}"? Rounds that already use it keep their copy.`)) void act(`delete:${q.id}`, () => deleteSqlQuestion(q.id));
                  }}
                >
                  Delete
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function QuestionEditor({
  draft,
  onChange,
  onCancel,
  onSaved,
}: {
  draft: Draft;
  onChange: (d: Draft) => void;
  onCancel: () => void;
  onSaved: (q: SqlBankQuestion) => Promise<void>;
}) {
  const [busy, setBusy] = useState<'check' | 'save' | null>(null);
  const [error, setError] = useState('');
  const [checked, setChecked] = useState<{ problems: string[]; problem: SqlProblemSpec | null } | null>(null);
  const set = (patch: Partial<Draft>) => {
    onChange({ ...draft, ...patch });
    setChecked(null); // the preview no longer matches what is typed
  };
  const setTest = (k: string, patch: Partial<Draft['tests'][number]>) => set({ tests: draft.tests.map((t) => (t.key === k ? { ...t, ...patch } : t)) });

  const run = async (kind: 'check' | 'save') => {
    setBusy(kind);
    setError('');
    try {
      if (kind === 'check') {
        const r = await checkSqlQuestion(toInput(draft));
        setChecked({ problems: r.problems, problem: r.problem });
      } else {
        await onSaved(draft.id ? await updateSqlQuestion(draft.id, toInput(draft)) : await createSqlQuestion(toInput(draft)));
      }
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card className="flex flex-col gap-4">
      <h2 className="text-lg font-semibold tracking-tight">{draft.id ? 'Edit SQL question' : 'New SQL question'}</h2>

      <div className="grid gap-4 md:grid-cols-[2fr_1fr_1fr_1fr]">
        <Field id="sq-title" label="Title" required>
          <input id="sq-title" className={inputClass} value={draft.title} maxLength={SQL_LIMITS.titleMax} onChange={(e) => set({ title: e.target.value })} />
        </Field>
        <Field id="sq-difficulty" label="Difficulty" required>
          <select id="sq-difficulty" className={inputClass} value={draft.difficulty} onChange={(e) => set({ difficulty: e.target.value as Draft['difficulty'] })}>
            <option value="EASY">Easy</option>
            <option value="MEDIUM">Medium</option>
            <option value="HARD">Hard</option>
          </select>
        </Field>
        <Field id="sq-marks" label="Marks" required>
          <input id="sq-marks" type="number" min={1} max={SQL_LIMITS.marksMax} className={inputClass} value={draft.marks} onChange={(e) => set({ marks: e.target.value })} />
        </Field>
        <Field id="sq-time" label="Time limit per query (ms)" required hint="500 to 10000">
          <input
            id="sq-time"
            type="number"
            min={SQL_LIMITS.timeLimitMinMs}
            max={SQL_LIMITS.timeLimitMaxMs}
            step={500}
            className={inputClass}
            value={draft.timeLimitMs}
            onChange={(e) => set({ timeLimitMs: e.target.value })}
          />
        </Field>
      </div>

      <Field id="sq-description" label="Problem description (shown to candidates)" required hint="Say which columns the result must have, and whether the row order matters.">
        <textarea id="sq-description" rows={3} className={inputClass} value={draft.description} maxLength={SQL_LIMITS.descriptionMax} onChange={(e) => set({ description: e.target.value })} />
      </Field>

      <Field id="sq-topics" label="Topics" hint="Comma separated, e.g. GROUP BY, HAVING">
        <input id="sq-topics" className={inputClass} value={draft.topics} onChange={(e) => set({ topics: e.target.value })} />
      </Field>

      <Field id="sq-schema" label="Database schema (CREATE TABLE statements)" required hint="SQLite. Candidates see the tables and their columns.">
        <textarea id="sq-schema" rows={6} className={mono} value={draft.schemaSql} maxLength={SQL_LIMITS.schemaSqlMax} onChange={(e) => set({ schemaSql: e.target.value })} spellCheck={false} />
      </Field>

      <div className="grid gap-4 md:grid-cols-2">
        <Field id="sq-reference" label="Reference query (the correct answer, never shown)" required hint="Its result on each dataset is the expected output.">
          <textarea id="sq-reference" rows={5} className={mono} value={draft.referenceQuery} maxLength={SQL_LIMITS.queryMax} onChange={(e) => set({ referenceQuery: e.target.value })} spellCheck={false} />
        </Field>
        <Field id="sq-starter" label="Starter query" hint="Empty = SELECT * FROM the first table.">
          <textarea id="sq-starter" rows={5} className={mono} value={draft.starterQuery} maxLength={SQL_LIMITS.queryMax} onChange={(e) => set({ starterQuery: e.target.value })} spellCheck={false} />
        </Field>
      </div>

      <div className="flex flex-wrap gap-5 text-sm">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={draft.orderMatters} onChange={(e) => set({ orderMatters: e.target.checked })} />
          Row order matters (the question asks for an ORDER BY)
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={draft.active} onChange={(e) => set({ active: e.target.checked })} />
          Active (can be put into rounds)
        </label>
      </div>

      <fieldset className="flex flex-col gap-3">
        <legend className="mb-1 text-sm font-medium">Datasets (INSERT statements, each on a fresh copy of the schema)</legend>
        <p className="text-xs text-muted">
          Sample datasets are shown to candidates with their expected output and used by Run. Hidden datasets only grade the submission: use them for NULLs, ties,
          empty tables and other edge cases.
        </p>
        {draft.tests.map((t, i) => (
          <div key={t.key} className="flex flex-col gap-2 rounded-md border border-border p-3">
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <span className="font-medium">Dataset {i + 1}</span>
              <input
                aria-label={`Dataset ${i + 1} name`}
                className={`${inputClass} !w-48 py-1`}
                placeholder="Name (optional)"
                value={t.name}
                maxLength={SQL_LIMITS.testNameMax}
                onChange={(e) => setTest(t.key, { name: e.target.value })}
              />
              <label className="flex items-center gap-1 text-xs">
                <input type="checkbox" checked={t.hidden} onChange={(e) => setTest(t.key, { hidden: e.target.checked })} />
                Hidden
              </label>
              <Button variant="ghost" className="ml-auto px-2 py-1 text-danger" disabled={draft.tests.length <= 1} onClick={() => set({ tests: draft.tests.filter((x) => x.key !== t.key) })}>
                Remove
              </Button>
            </div>
            <textarea
              aria-label={`Dataset ${i + 1} INSERT statements`}
              rows={4}
              className={mono}
              placeholder={"INSERT INTO employees VALUES\n  (1, 'Rahul', 50000),\n  (2, 'Priya', 60000);"}
              value={t.dataSql}
              maxLength={SQL_LIMITS.dataSqlMax}
              onChange={(e) => setTest(t.key, { dataSql: e.target.value })}
              spellCheck={false}
            />
          </div>
        ))}
        {draft.tests.length < SQL_LIMITS.testsMax && (
          <span className="flex gap-2">
            <Button variant="ghost" className="px-2 py-1" onClick={() => set({ tests: [...draft.tests, { key: key(), name: '', dataSql: '', hidden: false }] })}>
              + Sample dataset
            </Button>
            <Button variant="ghost" className="px-2 py-1" onClick={() => set({ tests: [...draft.tests, { key: key(), name: '', dataSql: '', hidden: true }] })}>
              + Hidden dataset
            </Button>
          </span>
        )}
      </fieldset>

      {error && <ErrorNotice title="Not saved" message={error} />}
      {checked && <CheckPreview problems={checked.problems} problem={checked.problem} />}

      <div className="flex flex-wrap gap-2">
        <Button onClick={() => void run('check')} disabled={busy !== null}>
          {busy === 'check' && <Spinner />} Check question
        </Button>
        <Button variant="primary" onClick={() => void run('save')} disabled={busy !== null}>
          {busy === 'save' && <Spinner />} Save
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={busy !== null}>
          Cancel
        </Button>
      </div>
    </Card>
  );
}

/** What the server got by running the question: the problems, or each dataset's tables and expected output. */
function CheckPreview({ problems, problem }: { problems: string[]; problem: SqlProblemSpec | null }) {
  if (problems.length || !problem) {
    return (
      <div role="alert" className="rounded-md border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-danger">
        <p className="font-medium">This question does not run yet</p>
        <ul className="mt-1 list-disc pl-5">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3 rounded-md border border-success/40 bg-success-soft/40 p-4">
      <p className="text-sm font-medium text-success">The question runs. This is what candidates will be judged against:</p>
      <p className="text-xs text-muted">Tables: {problem.tables.map((t) => `${t.name} (${t.columns.map((c) => c.name).join(', ')})`).join('; ')}</p>
      <div className="grid gap-3 lg:grid-cols-2">
        {problem.tests.map((t, i) => (
          <div key={i} className="flex flex-col gap-1">
            <p className="text-xs font-medium">
              Dataset {i + 1}
              {t.name ? ` · ${t.name}` : ''} · {t.hidden ? 'hidden' : 'sample'} · expected output
            </p>
            <SqlResultTable caption={`Expected output of dataset ${i + 1}`} columns={t.expected.columns} rows={t.expected.rows} />
          </div>
        ))}
      </div>
    </div>
  );
}
