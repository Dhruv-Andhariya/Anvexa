import type { CaseResult, CaseStatus, RunResponse, SubmitResponse } from '@/lib/dsa-api';
import { Badge, Spinner } from '@/components/ui';
import { SqlTable } from './sql-table';

export interface PanelResult {
  kind: 'run' | 'submit';
  data: RunResponse | SubmitResponse;
}

const STATUS_LABEL: Record<CaseStatus, string> = {
  passed: 'Passed',
  wrong_answer: 'Wrong answer',
  runtime_error: 'Runtime error',
  time_limit: 'Time limit exceeded',
  compile_error: 'Compile error',
  internal_error: 'Runner error',
};

const pre = 'max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-background px-3 py-2 font-mono text-xs';

function Detail({ title, text, tone }: { title: string; text: string; tone?: 'danger' }) {
  return (
    <div>
      <p className="mb-1 text-xs font-medium text-muted">{title}</p>
      <pre className={`${pre} ${tone === 'danger' ? 'text-danger' : ''}`}>{text === '' ? '(empty)' : text}</pre>
    </div>
  );
}

function CaseRow({ c }: { c: CaseResult }) {
  const passed = c.status === 'passed';
  const header = (
    <div className="flex flex-wrap items-center gap-2">
      <span aria-hidden="true" className={`h-2 w-2 rounded-full ${passed ? 'bg-success' : 'bg-danger'}`} />
      <span className="text-sm font-medium">{c.label}</span>
      {c.hidden && <Badge>Hidden</Badge>}
      <Badge tone={passed ? 'success' : 'danger'}>{STATUS_LABEL[c.status]}</Badge>
      {c.timeMs !== null && <span className="ml-auto text-xs text-muted">{c.timeMs} ms</span>}
    </div>
  );

  if (c.hidden || c.input === undefined) {
    return <li className="rounded-md border border-border bg-surface px-3 py-2">{header}</li>;
  }
  // a SQL problem: the result tables side by side with what differs
  if (c.expectedTable) {
    return (
      <li className="rounded-md border border-border bg-surface">
        <details open>
          <summary className="cursor-pointer list-none px-3 py-2 [&::-webkit-details-marker]:hidden">{header}</summary>
          <div className="flex flex-col gap-2 border-t border-border px-3 py-3">
            {c.stderr ? <Detail title={passed ? 'Note' : 'What is wrong'} text={c.stderr} tone="danger" /> : null}
            <div className="grid gap-2 xl:grid-cols-2">
              <div>
                <p className="mb-1 text-xs font-medium text-muted">Your result</p>
                {c.table ? <SqlTable caption="Your result" columns={c.table.columns} rows={c.table.rows} /> : <pre className={pre}>(no result)</pre>}
              </div>
              <div>
                <p className="mb-1 text-xs font-medium text-muted">Expected output</p>
                <SqlTable caption="Expected output" columns={c.expectedTable.columns} rows={c.expectedTable.rows} />
              </div>
            </div>
          </div>
        </details>
      </li>
    );
  }
  return (
    <li className="rounded-md border border-border bg-surface">
      <details open>
        <summary className="cursor-pointer list-none px-3 py-2 [&::-webkit-details-marker]:hidden">{header}</summary>
        <div className="flex flex-col gap-2 border-t border-border px-3 py-3">
          <Detail title="Input" text={c.input} />
          <Detail title="Expected output" text={c.expected ?? ''} />
          <Detail title="Your output" text={c.actual ?? ''} tone={passed ? undefined : 'danger'} />
          {c.stdout ? <Detail title="Your printed output (stdout)" text={c.stdout} /> : null}
          {c.stderr ? <Detail title="Error output" text={c.stderr} tone="danger" /> : null}
        </div>
      </details>
    </li>
  );
}

export function ResultsPanel({
  result,
  busy,
  error,
  sql = false,
}: {
  result: PanelResult | undefined;
  busy: 'run' | 'submit' | null;
  error: string;
  /** A SQL problem: "query" and "datasets" instead of "code" and "tests". */
  sql?: boolean;
}) {
  const what = sql ? 'query' : 'code';
  const tests = sql ? 'datasets' : 'tests';
  return (
    <section aria-live="polite" aria-label="Test results" className="flex flex-col gap-3 p-4 sm:p-5">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Test results</h3>

      {busy && (
        <p className="flex items-center gap-2 text-sm text-muted">
          <Spinner /> {busy === 'run' ? `Running your ${what} against the sample ${tests}…` : `Judging your submission against all ${tests}…`}
        </p>
      )}

      {error && (
        <p role="alert" className="rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}

      {!busy && !error && !result && (
        <p className="text-sm text-muted">Run your {what} to see results here. Nothing is saved until you submit.</p>
      )}

      {!busy && result && <ResultBody result={result} sql={sql} />}
    </section>
  );
}

function ResultBody({ result, sql }: { result: PanelResult; sql: boolean }) {
  const { data, kind } = result;
  const submit = kind === 'submit' ? (data as SubmitResponse) : null;
  const tone = data.verdict === 'passed' ? 'success' : 'danger';
  const tests = sql ? 'datasets' : 'tests';
  const headline =
    data.verdict === 'compile_error'
      ? sql
        ? 'The query cannot run'
        : 'Compilation failed'
      : data.verdict === 'internal_error'
        ? sql
          ? 'The SQL runner failed'
          : 'The code runner failed'
        : data.verdict === 'passed'
          ? kind === 'submit'
            ? `All ${tests} passed`
            : `Sample ${tests} passed`
          : `${data.passed} of ${data.total} ${tests} passed`;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={tone}>{headline}</Badge>
        <span className="text-xs text-muted">
          {kind === 'submit' ? 'Submission' : 'Run'} · {data.passed}/{data.total} passed
        </span>
        {submit && (
          <span className="ml-auto text-sm font-medium">
            Score {submit.score} / {submit.maxScore}
          </span>
        )}
      </div>
      {submit && (
        <p className="text-xs text-muted">
          Best score for this question: {submit.progress.bestScore} / {submit.maxScore} · {submit.progress.attempts}{' '}
          {submit.progress.attempts === 1 ? 'submission' : 'submissions'}
        </p>
      )}
      {data.compileOutput && <Detail title={sql ? 'SQL error' : 'Compiler output'} text={data.compileOutput} tone="danger" />}
      {data.verdict !== 'compile_error' && (
        <ul className="flex flex-col gap-2">
          {data.cases.map((c) => (
            <CaseRow key={c.id + c.label} c={c} />
          ))}
        </ul>
      )}
    </div>
  );
}
