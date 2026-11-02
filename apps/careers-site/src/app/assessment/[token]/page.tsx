import type { Metadata } from 'next';
import { ExamRoom } from './exam-room';

// A personal link: never indexed, never cached, never sent on as a referrer (headers in next.config.ts).
export const metadata: Metadata = {
  title: 'Online assessment',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

export const dynamic = 'force-dynamic';

export default async function AssessmentPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-5 px-4 py-6 sm:px-6 sm:py-8">
      <ExamRoom token={token} />
    </main>
  );
}
