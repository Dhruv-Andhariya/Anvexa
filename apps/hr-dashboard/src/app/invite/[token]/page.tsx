import type { Metadata } from 'next';
import { AcceptInvitation } from './accept-invitation';

export const metadata: Metadata = { title: 'Join your team · HireFlow AI' };

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-4 py-8">
      <p className="mb-6 text-center text-base font-semibold tracking-tight">HireFlow AI</p>
      <AcceptInvitation token={token} />
    </main>
  );
}
