import type { Metadata } from 'next';
import { Suspense } from 'react';
import { GdBoard } from './gd-board';

export const metadata: Metadata = { title: 'Group Discussion · ANVEXA' };

export default function GroupDiscussionPage() {
  return (
    <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
      {/* useSearchParams (?round=) needs a Suspense boundary */}
      <Suspense>
        <GdBoard />
      </Suspense>
    </main>
  );
}
