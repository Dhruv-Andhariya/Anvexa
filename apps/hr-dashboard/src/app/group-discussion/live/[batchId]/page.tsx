import type { Metadata } from 'next';
import { LiveDashboard } from './live-dashboard';

export const metadata: Metadata = { title: 'Live group discussion · HireFlow AI' };

export default async function GdLivePage({ params }: { params: Promise<{ batchId: string }> }) {
  const { batchId } = await params;
  return (
    <main className="mx-auto max-w-[1400px] px-4 py-6 sm:px-6">
      <LiveDashboard batchId={batchId} />
    </main>
  );
}
