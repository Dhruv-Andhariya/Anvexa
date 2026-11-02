import type { Metadata } from 'next';
import { JobsList } from './jobs-list';

export const metadata: Metadata = { title: 'Jobs · HireFlow AI' };

export default function JobsPage() {
  return (
    <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
      <JobsList />
    </main>
  );
}
