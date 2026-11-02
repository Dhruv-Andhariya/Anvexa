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
        <header className="border-b border-border bg-surface">
          <div className="mx-auto flex max-w-5xl items-center gap-3 px-4 py-3 sm:px-6">
            <span className="text-base font-semibold tracking-tight">{CONTENT.siteName}</span>
          </div>
        </header>
        {children}
      </body>
    </html>
  );
}
