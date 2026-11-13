import type { Metadata } from 'next';
import { AuthFrame } from '@/components/auth-frame';
import { ForgotPasswordForm } from './forgot-password-form';

export const metadata: Metadata = { title: 'Forgot password · Anvexa' };

export default async function ForgotPasswordPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const email = (await searchParams).email;
  return (
    <AuthFrame>
      <ForgotPasswordForm initialEmail={typeof email === 'string' ? email : ''} />
    </AuthFrame>
  );
}
