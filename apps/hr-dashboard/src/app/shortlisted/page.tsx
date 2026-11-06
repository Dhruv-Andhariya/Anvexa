import type { Metadata } from 'next';
import { Suspense } from 'react';
import { ShortlistedBoard } from './shortlisted-board';

export const metadata: Metadata = { title: 'Shortlisted Students · ANVEXA' };

export default function ShortlistedPage() {
  return (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      {/* useSearchParams (?job=&view=) needs a Suspense boundary */}
      <Suspense>
        <ShortlistedBoard />
      </Suspense>
    </main>
  );
}
