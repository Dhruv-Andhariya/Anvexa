import type { Metadata } from 'next';
import { SessionProvider } from '@/components/session';
import './globals.css';

export const metadata: Metadata = {
  title: 'Anvexa — HR Dashboard',
  description: 'Set up your company, create jobs, and generate and approve job descriptions with AI.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        {/* login gate, role-aware navigation and the company switcher */}
        <SessionProvider>{children}</SessionProvider>
      </body>
    </html>
  );
}
