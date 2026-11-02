import type { Metadata } from 'next';
import { Suspense } from 'react';
import { AssessmentsBoard } from './assessments-board';

export const metadata: Metadata = { title: 'Assessments · HireFlow AI' };

export default function AssessmentsPage() {
  return (
    <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
      {/* useSearchParams (?job=&tab=) needs a Suspense boundary */}
      <Suspense>
        <AssessmentsBoard />
      </Suspense>
    </main>
  );
}
