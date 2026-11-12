import type { ReactNode } from 'react';

/** A tooltip to the right of a collapsed sidebar item (shown on hover and on keyboard focus). */
export function Tip({ label, show, children }: { label: string; show: boolean; children: ReactNode }) {
  if (!show) return <>{children}</>;
  return (
    <div className="group/tip relative flex">
      {children}
      <span
        role="tooltip"
        className="pointer-events-none absolute left-full top-1/2 z-50 ml-2 -translate-y-1/2 whitespace-nowrap rounded-md bg-foreground px-2 py-1 text-xs font-medium text-background opacity-0 transition-opacity group-focus-within/tip:opacity-100 group-hover/tip:opacity-100"
      >
        {label}
      </span>
    </div>
  );
}

/** One sidebar row: subtle grey hover, light-grey active background, icons only when collapsed. */
export const navRowClass = (active: boolean, collapsed: boolean) =>
  `flex h-9 items-center gap-2.5 rounded-lg text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/20 ${
    collapsed ? 'w-9 justify-center' : 'w-full px-2.5'
  } ${active ? 'bg-active font-medium text-foreground' : 'text-foreground/80 hover:bg-hover hover:text-foreground'}`;
