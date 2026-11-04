import type { Difficulty, PublicQuestion, PublicSqlProblem } from '@/lib/dsa-api';
import { Badge } from '@/components/ui';
import { SqlTable } from './sql-table';

export const difficultyTone = (d: Difficulty | string) =>
  d === 'Easy' ? ('success' as const) : d === 'Hard' ? ('danger' as const) : ('accent' as const);

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">{title}</h3>
      {children}
    </section>
  );
}

const codeBlock = 'whitespace-pre-wrap break-words rounded-md border border-border bg-background px-3 py-2 font-mono text-xs';

export function ProblemPanel({ question }: { question: PublicQuestion }) {
  return (
    <article className="flex flex-col gap-5 p-4 sm:p-5">
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={difficultyTone(question.difficulty)}>{question.difficulty}</Badge>
          <Badge>{question.marks} marks</Badge>
        </div>
        <h2 className="text-lg font-semibold tracking-tight">{question.title}</h2>
      </header>

      <Section title="Problem">
        <div className="flex flex-col gap-2 text-sm leading-relaxed">
          {question.description.split('\n\n').map((p, i) => (
            <p key={i}>{p}</p>
          ))}
        </div>
      </Section>

      {/* HR's own problems may leave a section empty */}
      {question.inputFormat && (
        <Section title="Input format">
          <p className="whitespace-pre-line text-sm">{question.inputFormat}</p>
        </Section>
      )}

      {question.outputFormat && (
        <Section title="Output format">
          <p className="whitespace-pre-line text-sm">{question.outputFormat}</p>
        </Section>
      )}

      {question.constraints.length > 0 && (
        <Section title="Constraints">
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {question.constraints.map((c) => (
              <li key={c} className="font-mono text-xs leading-relaxed">
                {c}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {question.sql && <SqlProblem sql={question.sql} />}

      {question.samples.length > 0 && (
        <Section title="Sample">
          <div className="flex flex-col gap-3">
            {question.samples.map((s, i) => (
              <div key={i} className="flex flex-col gap-2">
                <div>
                  <p className="mb-1 text-xs font-medium text-muted">Input</p>
                  <pre className={codeBlock}>{s.input}</pre>
                </div>
                <div>
                  <p className="mb-1 text-xs font-medium text-muted">Output</p>
                  <pre className={codeBlock}>{s.output}</pre>
                </div>
                {s.explanation && (
                  <div>
                    <p className="mb-1 text-xs font-medium text-muted">Explanation</p>
                    <p className="text-sm">{s.explanation}</p>
                  </div>
                )}
              </div>
            ))}
          </div>
        </Section>
      )}

      <p className="rounded-md border border-border bg-accent-soft px-3 py-2 text-xs text-muted">
        {question.sql
          ? `Run checks your query against the ${question.sampleTests.length} sample datasets. Submit also judges ${question.hiddenTestCount} hidden datasets (same tables, other rows), which you cannot see.`
          : `Run checks your code against the ${question.sampleTests.length} sample tests. Submit also judges ${question.hiddenTestCount} hidden tests, which you cannot see.`}
      </p>
    </article>
  );
}

/** A SQL problem: the tables (columns and types), and for each sample dataset its rows and the expected result. */
function SqlProblem({ sql }: { sql: PublicSqlProblem }) {
  return (
    <>
      <Section title="Database schema">
        <div className="flex flex-col gap-3">
          {sql.tables.map((t) => (
            <div key={t.name}>
              <p className="mb-1 font-mono text-xs font-semibold">{t.name}</p>
              <SqlTable caption={`Columns of ${t.name}`} columns={['column', 'type']} rows={t.columns.map((c) => [c.name, c.type || '—'])} />
            </div>
          ))}
        </div>
      </Section>

      {sql.samples.map((s, i) => (
        <Section key={s.id} title={`Sample data ${i + 1}${s.name ? ` · ${s.name}` : ''}`}>
          <div className="flex flex-col gap-3">
            {s.data.map((t) => (
              <div key={t.name}>
                <p className="mb-1 font-mono text-xs font-semibold">{t.name}</p>
                <SqlTable caption={`Rows of ${t.name}`} columns={t.columns} rows={t.rows} />
              </div>
            ))}
            <div>
              <p className="mb-1 text-xs font-medium text-muted">Expected output</p>
              <SqlTable caption="Expected output" columns={s.expected.columns} rows={s.expected.rows} />
            </div>
          </div>
        </Section>
      ))}

      <p className="text-xs text-muted">
        Write one SELECT query (SQLite). The column names must match the expected output (use AS).{' '}
        {sql.orderMatters ? 'The order of the rows matters for this question.' : 'The rows may come in any order.'}
      </p>
    </>
  );
}
