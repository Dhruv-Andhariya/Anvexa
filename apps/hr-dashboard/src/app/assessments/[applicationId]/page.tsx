import type { Metadata } from 'next';
import { StudentReview } from './student-review';

export const metadata: Metadata = { title: 'Student review · ANVEXA' };

export default async function StudentReviewPage({ params }: { params: Promise<{ applicationId: string }> }) {
  const { applicationId } = await params;
  return (
    <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <StudentReview applicationId={applicationId} />
    </main>
  );
}
