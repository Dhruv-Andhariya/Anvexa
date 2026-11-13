import type { ButtonHTMLAttributes, ReactNode } from 'react';

// Same look as apps/hr-dashboard/src/components/ui.tsx so both apps feel like one product.

export const inputClass =
  'w-full rounded-md border border-border bg-surface px-3 py-2.5 text-base text-foreground placeholder:text-muted/70 sm:text-sm ' +
  'focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent ' +
  'aria-[invalid=true]:border-danger aria-[invalid=true]:focus:ring-danger/30 disabled:opacity-60';

export const errorId = (id: string) => `${id}-error`;
export const hintId = (id: string) => `${id}-hint`;

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

type Variant = 'primary' | 'secondary';

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-accent text-accent-foreground shadow-sm shadow-accent/25 hover:bg-accent-hover hover:shadow-md hover:shadow-accent/25',
  secondary: 'border border-border bg-surface text-foreground hover:bg-accent-soft hover:border-accent/30',
};

export function Button({ variant = 'secondary', className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      type="button"
      {...props}
      className={
        'inline-flex items-center justify-center gap-2 rounded-md px-4 py-2.5 text-sm font-medium transition ' +
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 focus-visible:ring-offset-1 ' +
        'disabled:cursor-not-allowed disabled:opacity-50 ' +
        `${VARIANTS[variant]} ${className}`
      }
    />
  );
}

export function Spinner({ className = '' }: { className?: string }) {
  return <span aria-hidden="true" className={`inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-r-transparent ${className}`} />;
}
