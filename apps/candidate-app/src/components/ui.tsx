import type { ButtonHTMLAttributes, ReactNode } from 'react';

// Same primitives as apps/hr-dashboard/src/components/ui.tsx so both apps share one visual language.

export const inputClass =
  'w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-foreground placeholder:text-muted/70 ' +
  'focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent disabled:opacity-60';

type Variant = 'primary' | 'secondary' | 'ghost';

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-accent text-accent-foreground hover:opacity-90',
  secondary: 'border border-border bg-surface text-foreground hover:bg-accent-soft',
  ghost: 'text-muted hover:text-foreground hover:bg-accent-soft',
};

export function Button({
  variant = 'secondary',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      type="button"
      {...props}
      className={
        'inline-flex items-center justify-center gap-2 rounded-md px-3.5 py-2 text-sm font-medium transition ' +
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 focus-visible:ring-offset-1 ' +
        'disabled:cursor-not-allowed disabled:opacity-50 ' +
        `${VARIANTS[variant]} ${className}`
      }
    />
  );
}

export function Spinner({ className = '' }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-r-transparent ${className}`}
    />
  );
}

type Tone = 'neutral' | 'accent' | 'success' | 'danger';

const TONES: Record<Tone, string> = {
  neutral: 'border-border text-muted',
  accent: 'border-accent/30 bg-accent-soft text-accent',
  success: 'border-success/30 bg-success/10 text-success',
  danger: 'border-danger/30 bg-danger-soft text-danger',
};

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${TONES[tone]}`}>
      {children}
    </span>
  );
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-lg border border-border bg-surface ${className}`}>{children}</div>;
}
