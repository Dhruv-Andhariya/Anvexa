import type { Metadata, Viewport } from 'next';
import { CONTENT } from '@/content';
import './globals.css';

export const metadata: Metadata = {
  title: CONTENT.siteName,
  description: 'Open jobs and internships. Apply in minutes.',
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        <header className="sticky top-0 z-40 border-b border-border bg-surface/90 backdrop-blur">
          <div className="mx-auto flex max-w-5xl items-center gap-3 px-4 py-3 sm:px-6">
            <span className="flex items-center gap-2.5 text-[17px] font-bold tracking-tight">
              <span aria-hidden="true" className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent text-sm font-extrabold text-accent-foreground shadow-md shadow-accent/30">A</span>
              {CONTENT.siteName}
            </span>
          </div>
        </header>
        {children}
      </body>
    </html>
  );
}
