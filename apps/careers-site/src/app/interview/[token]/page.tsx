import type { Metadata } from 'next';
import { InterviewRoom } from './interview-room';

// A personal link: never indexed, never cached, never sent on as a referrer (headers in next.config.ts).
export const metadata: Metadata = {
  title: 'AI technical interview',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

export const dynamic = 'force-dynamic';

export default async function InterviewPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-5 px-4 py-6 sm:px-6 sm:py-8">
      <InterviewRoom token={token} />
    </main>
  );
}
