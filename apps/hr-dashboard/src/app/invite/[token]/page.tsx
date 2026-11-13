import type { Metadata } from 'next';
import { AuthFrame } from '@/components/auth-frame';
import { AcceptInvitation } from './accept-invitation';

export const metadata: Metadata = { title: 'Join your team · Anvexa' };

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return (
    <AuthFrame>
      <AcceptInvitation token={token} />
    </AuthFrame>
  );
}
