import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Anvexa — Coding Assessment',
  description: 'Candidate coding assessment powered by Anvexa.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        <header className="border-b border-border bg-surface">
          <div className="mx-auto flex max-w-[1600px] items-center gap-3 px-4 py-3 sm:px-6">
            <span className="text-base font-semibold tracking-tight">Anvexa</span>
            <span className="text-sm text-muted">Coding Assessment</span>
          </div>
        </header>
        {children}
      </body>
    </html>
  );
}
