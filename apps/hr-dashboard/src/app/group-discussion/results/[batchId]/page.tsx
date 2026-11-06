import type { Metadata } from 'next';
import { ResultsBoard } from './results-board';

export const metadata: Metadata = { title: 'Group discussion results · Anvexa' };

export default async function GdResultsPage({ params }: { params: Promise<{ batchId: string }> }) {
  const { batchId } = await params;
  return (
    <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
      <ResultsBoard batchId={batchId} />
    </main>
  );
}
