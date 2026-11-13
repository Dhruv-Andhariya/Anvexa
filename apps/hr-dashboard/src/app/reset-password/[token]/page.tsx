import type { Metadata } from 'next';
import { AuthFrame } from '@/components/auth-frame';
import { ResetPasswordForm } from './reset-password-form';

export const metadata: Metadata = { title: 'Choose a new password · Anvexa' };

export default async function ResetPasswordPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return (
    <AuthFrame>
      <ResetPasswordForm token={token} />
    </AuthFrame>
  );
}
