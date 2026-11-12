import type { Metadata } from 'next';
import { safeNext } from '@/lib/safe-next';
import { CompanyEditor } from './company-editor';

export const metadata: Metadata = { title: 'Company profile · Anvexa' };

export default async function CompanyPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const next = safeNext((await searchParams).next);
  return (
    <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
      <div className="mb-6">
        <p className="text-sm font-medium text-muted">Step 1</p>
        <h1 className="text-xl font-semibold tracking-tight">Company profile</h1>
        <p className="mt-1 text-sm text-muted">
          Save your company details once. Anvexa adds them to every job description automatically.
        </p>
      </div>
      <CompanyEditor next={next} />
    </main>
  );
}
