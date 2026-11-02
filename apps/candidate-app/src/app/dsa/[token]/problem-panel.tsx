import type { Difficulty, PublicQuestion } from '@/lib/dsa-api';
import { Badge } from '@/components/ui';

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

      <Section title="Input format">
        <p className="text-sm">{question.inputFormat}</p>
      </Section>

      <Section title="Output format">
        <p className="text-sm">{question.outputFormat}</p>
      </Section>

      <Section title="Constraints">
        <ul className="list-disc space-y-1 pl-5 text-sm">
          {question.constraints.map((c) => (
            <li key={c} className="font-mono text-xs leading-relaxed">
              {c}
            </li>
          ))}
        </ul>
      </Section>

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
              <div>
                <p className="mb-1 text-xs font-medium text-muted">Explanation</p>
                <p className="text-sm">{s.explanation}</p>
              </div>
            </div>
          ))}
        </div>
      </Section>

      <p className="rounded-md border border-border bg-accent-soft px-3 py-2 text-xs text-muted">
        Run checks your code against the {question.sampleTests.length} sample tests. Submit also judges{' '}
        {question.hiddenTestCount} hidden tests, which you cannot see.
      </p>
    </article>
  );
}
