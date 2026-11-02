import type { Metadata } from 'next';
import { Suspense } from 'react';
import { PublishBoard } from './publish-board';

export const metadata: Metadata = { title: 'Publish jobs · HireFlow AI' };

export default function PublishPage() {
  return (
    <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
      {/* useSearchParams (?job=<id> from the job page) needs a Suspense boundary */}
      <Suspense>
        <PublishBoard />
      </Suspense>
    </main>
  );
}
