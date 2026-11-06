import type { Metadata } from 'next';
import { JobReview } from './job-review';

export const metadata: Metadata = { title: 'Review job · ANVEXA' };

export default async function JobPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  return (
    <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
      <JobReview id={id} autoGenerate={query.generate === '1'} />
    </main>
  );
}
