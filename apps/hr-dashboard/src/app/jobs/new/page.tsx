import type { Metadata } from 'next';
import { NewJob } from './new-job';

export const metadata: Metadata = { title: 'New job · ANVEXA' };

export default function NewJobPage() {
  return (
    <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
      <div className="mb-6">
        <p className="text-sm font-medium text-accent">Step 2</p>
        <h1 className="text-2xl font-semibold tracking-tight">Create a job</h1>
        <p className="mt-1 text-sm text-muted">
          Enter the job requirements. ANVEXA combines them with your company profile and drafts a job description for
          you to review and approve.
        </p>
      </div>
      <NewJob />
    </main>
  );
}
