import type { Metadata } from 'next';
import { Suspense } from 'react';
import { PersonalInterviewBoard } from './pi-board';

export const metadata: Metadata = { title: 'Personal interview · Anvexa' };

export default function PersonalInterviewPage() {
  return (
    <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
      {/* useSearchParams (?job=) needs a Suspense boundary */}
      <Suspense>
        <PersonalInterviewBoard />
      </Suspense>
    </main>
  );
}
