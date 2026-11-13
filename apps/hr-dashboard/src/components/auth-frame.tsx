import type { ReactNode } from 'react';
import { CheckIcon } from './icons';

const POINTS = [
  'AI-written job descriptions you review and approve',
  'Publish to your careers page and job boards in one click',
  'AI screening, assessments and interviews, end to end',
];

/**
 * The frame of the signed-out pages (log in, sign up, password reset, invitations): a navy brand panel on wide
 * screens and the form on a soft background. On phones only the logo and the form show.
 */
export function AuthFrame({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-h-screen lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      <aside className="relative hidden overflow-hidden bg-gradient-to-br from-[#0f3b78] via-[#0c3266] to-[#071d40] p-12 text-white lg:flex lg:flex-col">
        {/* glow and grid decoration */}
        <div aria-hidden="true" className="pointer-events-none absolute -left-24 -top-24 h-80 w-80 rounded-full bg-[#3d7be0]/30 blur-3xl" />
        <div aria-hidden="true" className="pointer-events-none absolute -bottom-32 -right-20 h-96 w-96 rounded-full bg-[#5fa8ff]/20 blur-3xl" />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 opacity-[0.07]"
          style={{
            backgroundImage: 'linear-gradient(white 1px, transparent 1px), linear-gradient(90deg, white 1px, transparent 1px)',
            backgroundSize: '40px 40px',
          }}
        />

        <div className="relative flex items-center gap-3 text-xl font-bold tracking-tight">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-white text-lg font-extrabold text-[#0f3b78] shadow-lg">A</span>
          Anvexa
        </div>

        <div className="relative my-auto max-w-md animate-fade-up">
          <h2 className="text-4xl font-bold leading-tight tracking-tight">
            Hire smarter,
            <br />
            <span className="bg-gradient-to-r from-[#9cc4ff] to-white bg-clip-text text-transparent">from job post to offer.</span>
          </h2>
          <p className="mt-4 text-[15px] leading-relaxed text-white/75">
            Anvexa runs your whole hiring process with AI, while you stay in control of every decision.
          </p>
          <ul className="mt-8 flex flex-col gap-3.5">
            {POINTS.map((p) => (
              <li key={p} className="flex items-start gap-3 text-sm text-white/90">
                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-white/15 ring-1 ring-white/25">
                  <CheckIcon className="h-3 w-3" />
                </span>
                {p}
              </li>
            ))}
          </ul>
        </div>

        <p className="relative text-xs text-white/50">© {new Date().getFullYear()} Anvexa</p>
      </aside>

      <main className="relative flex flex-col justify-center overflow-hidden px-4 py-10 sm:px-8">
        <div aria-hidden="true" className="pointer-events-none absolute -right-32 -top-32 h-80 w-80 rounded-full bg-accent-soft blur-3xl" />
        <div className="relative mx-auto w-full max-w-md animate-fade-up">
          <div className="mb-8 flex items-center justify-center gap-2.5 text-lg font-bold tracking-tight lg:hidden">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-accent text-base font-extrabold text-accent-foreground shadow-md shadow-accent/30">
              A
            </span>
            Anvexa
          </div>
          {children}
        </div>
      </main>
    </div>
  );
}
