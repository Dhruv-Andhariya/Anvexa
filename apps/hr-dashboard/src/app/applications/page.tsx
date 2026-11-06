import type { Metadata } from 'next';
import { Suspense } from 'react';
import { ApplicationsBoard } from './applications-board';

export const metadata: Metadata = { title: 'Applications · ANVEXA' };

export default function ApplicationsPage() {
  return (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      {/* useSearchParams (?job=<id> from the publish page) needs a Suspense boundary */}
      <Suspense>
        <ApplicationsBoard />
      </Suspense>
    </main>
  );
}
