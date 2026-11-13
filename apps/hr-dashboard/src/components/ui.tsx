import type { ButtonHTMLAttributes, ReactNode } from 'react';

export const inputClass =
  'w-full rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm text-foreground placeholder:text-muted/70 ' +
  'focus:outline-none focus:ring-4 focus:ring-accent/10 focus:border-accent/60 transition-shadow ' +
  'aria-[invalid=true]:border-danger aria-[invalid=true]:focus:ring-danger/30 disabled:opacity-60';

export const errorId = (id: string) => `${id}-error`;
export const hintId = (id: string) => `${id}-hint`;

/** aria-describedby value for a field with optional hint and error. */
export function describedBy(id: string, hint?: ReactNode, error?: string): string | undefined {
  const ids = [hint ? hintId(id) : null, error ? errorId(id) : null].filter(Boolean);
  return ids.length ? ids.join(' ') : undefined;
}

interface FieldProps {
  id: string;
  label: string;
  required?: boolean;
  hint?: ReactNode;
  error?: string;
  children: ReactNode;
  className?: string;
}

export function Field({ id, label, required, hint, error, children, className = '' }: FieldProps) {
  return (
    <div className={`flex flex-col gap-1.5 ${className}`}>
      <label htmlFor={id} className="text-sm font-medium">
        {label}
        {required ? (
          <span className="text-danger" aria-hidden="true">
            {' '}*
          </span>
        ) : (
          <span className="font-normal text-muted"> (optional)</span>
        )}
      </label>
      {children}
      {hint && !error && (
        <p id={hintId(id)} className="text-xs text-muted">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId(id)} className="text-xs font-medium text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

type Variant = 'primary' | 'secondary' | 'ghost';

/** Navy primary with a soft lift, white outlined secondary, borderless ghost. */
const VARIANTS: Record<Variant, string> = {
  primary: 'bg-accent text-accent-foreground shadow-sm shadow-accent/25 hover:bg-accent-hover hover:shadow-md hover:shadow-accent/25',
  secondary: 'border border-border-strong bg-surface text-foreground hover:bg-hover hover:border-accent/30',
  ghost: 'text-muted hover:text-foreground hover:bg-hover',
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
        'inline-flex items-center justify-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium transition-colors ' +
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-offset-1 active:translate-y-px ' +
        'disabled:cursor-not-allowed disabled:opacity-50 ' +
        `${VARIANTS[variant]} ${className}`
      }
    />
  );
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-2xl border border-border bg-surface p-5 shadow-card ${className}`}>{children}</div>;
}

const STATUS: Record<string, { label: string; className: string }> = {
  DRAFT: { label: 'Draft', className: 'border-warning/30 bg-warning-soft text-warning' },
  JD_GENERATED: { label: 'Awaiting approval', className: 'border-accent/25 bg-accent-soft text-accent' },
  APPROVED: { label: 'Approved', className: 'border-success/40 bg-success-soft text-success' },
};

export function StatusBadge({ status }: { status: string }) {
  const s = STATUS[status] ?? { label: status, className: 'border-border text-muted' };
  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${s.className}`}>
      {s.label}
    </span>
  );
}

/** Red error box with an optional action (e.g. "Try again"). */
export function ErrorNotice({ title, message, action }: { title: string; message: string; action?: ReactNode }) {
  return (
    <div role="alert" className="rounded-xl border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-danger">
      <p className="font-medium">{title}</p>
      <p className="mt-1">{message}</p>
      {action && <div className="mt-3">{action}</div>}
    </div>
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
