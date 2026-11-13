import Link from 'next/link';
import type { ComponentType, ReactNode } from 'react';
import { ArrowRightIcon } from './icons';
import { Card } from './ui';

export const primaryLink =
  'group/cta inline-flex items-center justify-center gap-2 rounded-xl bg-accent px-5 py-3 text-sm font-semibold text-accent-foreground shadow-lg shadow-accent/25 ' +
  'transition-all hover:-translate-y-0.5 hover:bg-accent-hover hover:shadow-xl hover:shadow-accent/30 ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-offset-2';

interface EmptyStateProps {
  art: ComponentType<{ className?: string }>;
  title: string;
  description?: ReactNode;
  /** Small label above the title, e.g. "Applications". */
  eyebrow?: string;
  /** "How it works": the next steps, shown as a numbered list (full size only). */
  steps?: string[];
  /** A link button under the text (e.g. "Open the Publish page"). */
  action?: { href: string; label: string };
  /** Anything else under the text, e.g. a real <button>. */
  children?: ReactNode;
  /** Smaller and centred, for an empty list inside a page that already has content. */
  compact?: boolean;
  /** No card around it: for use inside an existing card or table cell. */
  bare?: boolean;
}

function Cta({ action }: { action: NonNullable<EmptyStateProps['action']> }) {
  return (
    <Link href={action.href} className={primaryLink}>
      {action.label}
      <ArrowRightIcon className="h-4 w-4 transition-transform group-hover/cta:translate-x-0.5" />
    </Link>
  );
}

/**
 * An illustrated empty state. Full size: the page's art on a tinted, dotted panel on the left, and on the right an
 * eyebrow, a bold heading, a hint, the next steps and a navy call to action (stacked on phones). Compact: small and
 * centred, for an empty list inside a page.
 */
export function EmptyState({ art: Art, title, description, eyebrow, steps, action, children, compact = false, bare = false }: EmptyStateProps) {
  if (compact) {
    const body = (
      <div className="flex flex-col items-center px-4 py-8 text-center">
        <Art className="h-24 w-auto sm:h-28" />
        <h2 className="mt-4 text-lg font-bold tracking-tight">{title}</h2>
        {description && <p className="mt-1.5 max-w-md text-sm leading-relaxed text-muted">{description}</p>}
        {action && (
          <div className="mt-4">
            <Cta action={action} />
          </div>
        )}
        {children && <div className="mt-4">{children}</div>}
      </div>
    );
    return bare ? body : <Card className="p-0 sm:p-0">{body}</Card>;
  }

  const body = (
    <div className="grid animate-fade-up items-center gap-8 p-5 sm:p-8 md:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] md:gap-12 lg:p-10">
      {/* art panel */}
      <div className="relative flex items-center justify-center overflow-hidden rounded-2xl bg-gradient-to-br from-accent-soft via-accent-soft/60 to-transparent px-4 py-8 sm:py-10">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 opacity-60"
          style={{ backgroundImage: 'radial-gradient(color-mix(in srgb, var(--accent) 22%, transparent) 1px, transparent 1px)', backgroundSize: '16px 16px' }}
        />
        <div aria-hidden="true" className="pointer-events-none absolute -left-10 -top-10 h-40 w-40 rounded-full bg-accent/10 blur-2xl" />
        <div aria-hidden="true" className="pointer-events-none absolute -bottom-12 -right-6 h-44 w-44 rounded-full bg-tone-sky/15 blur-2xl" />
        <Art className="relative h-40 w-auto drop-shadow-sm sm:h-52" />
      </div>

      {/* text */}
      <div className="flex flex-col items-start">
        {eyebrow && (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-accent/15 bg-accent-soft px-3 py-1 text-xs font-semibold text-accent">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
            {eyebrow}
          </span>
        )}
        <h2 className={`text-2xl font-bold tracking-tight sm:text-[28px] sm:leading-tight ${eyebrow ? 'mt-3' : ''}`}>{title}</h2>
        {description && <p className="mt-2 max-w-md text-[15px] leading-relaxed text-muted">{description}</p>}

        {steps && steps.length > 0 && (
          <ol className="mt-5 flex w-full max-w-md flex-col gap-2.5">
            {steps.map((s, i) => (
              <li key={s} className="flex items-center gap-3 rounded-xl border border-border bg-background/60 px-3 py-2.5 text-sm transition-colors hover:border-accent/30 hover:bg-accent-soft/50">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-accent text-xs font-bold text-accent-foreground shadow-sm shadow-accent/30">
                  {i + 1}
                </span>
                <span className="font-medium text-foreground/90">{s}</span>
              </li>
            ))}
          </ol>
        )}

        {(action || children) && (
          <div className="mt-6 flex flex-wrap items-center gap-3">
            {action && <Cta action={action} />}
            {children}
          </div>
        )}
      </div>
    </div>
  );

  if (bare) return body;
  return (
    <Card className="relative overflow-hidden p-0 sm:p-0">
      <div aria-hidden="true" className="pointer-events-none absolute -right-24 -top-24 h-64 w-64 rounded-full bg-accent-soft blur-3xl" />
      <div className="relative">{body}</div>
    </Card>
  );
}
