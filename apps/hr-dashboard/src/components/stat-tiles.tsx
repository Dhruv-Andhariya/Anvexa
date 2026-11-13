import type { ComponentType, SVGProps } from 'react';

export type Tone = 'blue' | 'amber' | 'green' | 'sky';

const TONE: Record<Tone, string> = {
  blue: 'bg-tone-blue-soft text-tone-blue',
  amber: 'bg-tone-amber-soft text-tone-amber',
  green: 'bg-tone-green-soft text-tone-green',
  sky: 'bg-tone-sky-soft text-tone-sky',
};

export interface Stat {
  label: string;
  /** null while loading, or when the number could not be read */
  value: number | null;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  tone: Tone;
}

/** A row of KPI tiles in one card: coloured icon chip, small label, big number; hairline dividers between tiles. */
export function StatTiles({ stats, loading = false }: { stats: Stat[]; loading?: boolean }) {
  return (
    <div className="grid grid-cols-2 overflow-hidden rounded-2xl border border-border bg-surface shadow-card lg:grid-cols-4">
      {stats.map((s, i) => {
        const I = s.icon;
        return (
          <div
            key={s.label}
            className={`group flex items-center gap-4 px-5 py-4 transition-colors hover:bg-hover/60 ${i % 2 ? 'border-l border-border' : ''} ${i >= 2 ? 'border-t border-border lg:border-t-0' : ''} ${i === 2 ? 'lg:border-l' : ''}`}
          >
            <span className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl transition-transform group-hover:scale-105 ${TONE[s.tone]}`}>
              <I className="h-5 w-5" />
            </span>
            <div className="min-w-0">
              <p className="truncate text-xs font-medium text-muted">{s.label}</p>
              {loading ? (
                <span className="mt-1.5 block h-5 w-8 animate-pulse rounded bg-hover" aria-label="Loading" />
              ) : (
                <p className="mt-0.5 text-xl font-bold tabular-nums tracking-tight">{s.value ?? '—'}</p>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
